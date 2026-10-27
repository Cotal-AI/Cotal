/** Process record paths name evidence, never the computed location of an absent record. */
import { strict as nodeAssert } from "node:assert";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  canonicalLocalProcessPath, commandIsCotalDelivery, DELIVERY_PIDFILE, localProcessPath,
  MANAGER_PIDFILE, readProcessRecord,
} from "@cotal-ai/workspace";
import { countedAssert, emitSentinel } from "@cotal-ai/smoke-kit";
import { assertManagerRecordReplaceable, managerRecordState } from "../src/lib/manager-proc.js";
import { stopOldHostingManagerIfPresent } from "../src/lib/delivery-proc.js";

const counted = countedAssert(nodeAssert);
const assert: typeof nodeAssert = counted.assert;

const root = mkdtempSync(join(tmpdir(), "cotal-absent-record-"));
mkdirSync(join(root, ".cotal"));
const context = { root, space: "record-evidence" };
const legacy = join(root, ".cotal", "manager.pid");
const unexpectedProbe = (): never => { throw new Error("a record without a pid must not probe a process"); };
const unexpectedCommand = (): never => { throw new Error("a record without a live pid must not read process argv"); };
const manager = () => managerRecordState(context.space, root, { probe: unexpectedProbe, readCommand: unexpectedCommand });

// Positive control first: a real record retains the spelling read and its content.
writeFileSync(legacy, "not-a-pid\n");
assert.deepEqual(manager(), { state: "unattributable", path: legacy, content: "not-a-pid" });
console.log("PASS: non-absent manager record pins the legacy file read");

writeFileSync(legacy, " \n");
const husk = manager();
assert.equal(existsSync(legacy), true);
console.log("empty manager record:", JSON.stringify(husk));

const missing = join(root, "missing.pid");
const absent = readProcessRecord(missing, () => true, unexpectedProbe, unexpectedCommand);
assert.equal(existsSync(missing), false);
console.log("missing process record:", JSON.stringify(absent));

const emptyRoot = join(root, "empty");
mkdirSync(join(emptyRoot, ".cotal"), { recursive: true });
const emptyContext = { root: emptyRoot, space: context.space };
const canonical = canonicalLocalProcessPath(MANAGER_PIDFILE, emptyContext);
assert.equal(localProcessPath(MANAGER_PIDFILE, emptyContext), canonical);
assert.equal(existsSync(canonical), false);
const absentManager = managerRecordState(context.space, emptyRoot, { probe: unexpectedProbe, readCommand: unexpectedCommand });
console.log("missing manager record:", JSON.stringify(absentManager));
assert.deepEqual(absent, { state: "absent" }, "missing process record must not advertise a read path");
assert.deepEqual(absentManager, { state: "absent" }, "missing manager record must not advertise a canonical path");
assert.deepEqual(husk, { state: "absent" }, "empty legacy record must not advertise a read path");
assert.deepEqual(JSON.parse(JSON.stringify({ manager: absentManager })), { manager: { state: "absent" } });

// Delivery shares the reader, with only its attribution predicate and path template differing.
const deliveryPath = localProcessPath(DELIVERY_PIDFILE, emptyContext);
assert.deepEqual(readProcessRecord(deliveryPath, commandIsCotalDelivery, unexpectedProbe, unexpectedCommand), { state: "absent" });
writeFileSync(deliveryPath, "\n");
assert.deepEqual(readProcessRecord(deliveryPath, commandIsCotalDelivery, unexpectedProbe, unexpectedCommand), { state: "absent" });
writeFileSync(deliveryPath, "invalid\n");
assert.deepEqual(readProcessRecord(deliveryPath, commandIsCotalDelivery, unexpectedProbe, unexpectedCommand), {
  state: "unattributable", path: deliveryPath, content: "invalid",
});

// Non-absent states still pin the actual record. Command data is injected, never read from argv.
writeFileSync(deliveryPath, `${process.pid}\n`);
for (const state of ["dead", "unknown"] as const)
  assert.deepEqual(readProcessRecord(deliveryPath, commandIsCotalDelivery, () => state, unexpectedCommand), {
    state, path: deliveryPath, pid: process.pid,
  });
for (const command of ["node cotal deliver", "node unrelated.js"])
  assert.deepEqual(readProcessRecord(deliveryPath, commandIsCotalDelivery, () => "alive", () => ({ kind: "command", command })), {
    state: commandIsCotalDelivery(command) ? "alive" : "foreign", path: deliveryPath, pid: process.pid, command,
  });
assert.deepEqual(readProcessRecord(deliveryPath, commandIsCotalDelivery, () => "alive", () => ({ kind: "unreadable", why: "fixture" })), {
  state: "alive", path: deliveryPath, pid: process.pid,
});

// The narrowed action callers still accept absence and refuse unresolved records without changes.
const previousCwd = process.cwd();
try {
  process.chdir(emptyRoot);
  assertManagerRecordReplaceable(context.space, emptyRoot, { probe: unexpectedProbe, readCommand: unexpectedCommand });
  await stopOldHostingManagerIfPresent(unexpectedProbe, context.space);
  assert.deepEqual(existsSync(canonical), false);
  writeFileSync(canonical, "not-a-pid\n");
  assert.throws(() => assertManagerRecordReplaceable(context.space, emptyRoot, { probe: unexpectedProbe, readCommand: unexpectedCommand }), (error: Error) => error.message.includes(canonical));
  await assert.rejects(stopOldHostingManagerIfPresent(unexpectedProbe, context.space), (error: Error) => error.message.includes(canonical));
  writeFileSync(canonical, `${process.pid}\n`);
  assert.throws(() => assertManagerRecordReplaceable(context.space, emptyRoot, { probe: () => "unknown", readCommand: unexpectedCommand }), (error: Error) => error.message.includes(canonical));
  await assert.rejects(stopOldHostingManagerIfPresent(() => "unknown", context.space), (error: Error) => error.message.includes(canonical));
  assert.deepEqual(managerRecordState(context.space, emptyRoot, { probe: () => "unknown", readCommand: unexpectedCommand }), { state: "unknown", path: canonical, pid: process.pid });
} finally {
  process.chdir(previousCwd);
}

// Read errors remain errors with the path, not absence. No real process argv is inspected.
const directory = join(root, "directory.pid");
mkdirSync(directory);
assert.throws(() => readProcessRecord(directory, () => true, unexpectedProbe, unexpectedCommand), (error: Error) => error.message.includes(directory));
console.log("PASS: absent records omit paths, non-absent records retain evidence, read errors throw");
console.log(`Retained fixtures: ${root}`);
emitSentinel({ passed: counted.cells(), failed: 0 });
