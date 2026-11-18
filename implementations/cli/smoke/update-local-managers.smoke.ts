import { once } from "node:events";
import strictAssert from "node:assert/strict";
import { countedAssert, emitSentinel } from "@cotal-ai/smoke-kit";
import { ConnectRefusal, identityRecord } from "@cotal-ai/workspace";
import { readUpdateManagerContinuity, reportRunningManagers } from "../src/commands/update.js";

const counted = countedAssert(strictAssert);
const assert: typeof strictAssert = counted.assert as typeof strictAssert;
const seen: Record<string, unknown>[] = [];
const ownProcess = identityRecord(process.pid);
assert.ok("token" in ownProcess);
if (!("token" in ownProcess)) throw new Error("smoke process must have a native identity");
const retained = { retainGraph: true };
const manager = { process: ownProcess, space: 'other "space"', server: "nats://127.0.0.1:4222", root: '/other "home"', instanceId: "localtwo", pid: process.pid };
const missing = new ConnectRefusal("missing", undefined, { code: "AUTH_REQUIRED", native: { code: "CREDENTIALS_MISSING" } });
const signedOut = new ConnectRefusal("signed out", undefined, { code: "AUTH_REQUIRED", cause: { code: "signed-out" } });
const notices: string[] = [];
const log = console.log;
console.log = text => { notices.push(String(text)); };
try {
  for (const error of [missing, signedOut]) {
    const before = notices.length;
    assert.equal(await readUpdateManagerContinuity(manager, {}, async flags => {
      assert.deepEqual(flags, { space: manager.space, server: manager.server, on: manager.instanceId });
      throw error;
    }, retained), "none");
    assert.equal(notices.length, before + 1, "one missing-credentials notice per read");
    assert.ok(notices.at(-1)!.includes(JSON.stringify(manager.space)));
    assert.ok(notices.at(-1)!.includes(JSON.stringify(manager.root)));
    assert.ok(notices.at(-1)!.includes(manager.instanceId));
    assert.ok(notices.at(-1)!.includes("keeps running the version it loaded until it is restarted from its own home"));
  }
  for (const error of [
    new ConnectRefusal("expired", undefined, { code: "AUTH_REQUIRED" }),
    new ConnectRefusal("rejected", undefined, { code: "PERMISSION_DENIED" }),
    new ConnectRefusal("refused", undefined, { code: "PERMISSION_DENIED", cause: { code: "refused" } }),
    Object.assign(new Error("unreadable credentials"), { code: "EACCES" }),
    Object.assign(new Error("untyped missing"), { native: { code: "CREDENTIALS_MISSING" } }),
  ]) await assert.rejects(readUpdateManagerContinuity(manager, {}, async () => { throw error; }, retained), actual => actual === error);
  await assert.rejects(readUpdateManagerContinuity(manager, { creds: "/explicit.creds" }, async () => { throw missing; }, retained), actual => actual === missing);
  await assert.rejects(readUpdateManagerContinuity(manager, {}, async () => { throw missing; }), actual => actual === missing, "nonretained reads still refuse");
  await assert.rejects(readUpdateManagerContinuity({ ...manager, process: undefined }, {}, async () => { throw missing; }, retained), actual => actual === missing, "missing native pin still refuses");
  await assert.rejects(reportRunningManagers({}, async () => { throw missing; }, () => [manager]), actual => actual === missing, "generic report cannot absorb missing credentials");
  assert.equal(await reportRunningManagers({}, async () => { throw missing; }, () => [manager], retained), "none", "retained report uses known local Manager boundary");
  const foreign = { ownership: "foreign" as const, pid: process.pid, root: "/foreign", space: "foreign", process: ownProcess };
  assert.equal(await readUpdateManagerContinuity(foreign, {}, async () => { throw new Error("foreign must not resolve auth"); }), "none");
  // Another home's Manager never changes the outcome of this home's own selection: every case
  // below must read what an empty census reads, after one notice.
  for (const flags of [{}, { server: "nats://127.0.0.1:4222" }, { space: "foreign", on: "0123456789abcdefghijklmnopqrstuv" }]) {
    const reads: Record<string, unknown>[] = [];
    const before = notices.length;
    assert.equal(await reportRunningManagers(flags, async selected => { reads.push(selected); return "legacy"; }, () => [foreign], retained), "legacy", "the selected mesh is still read beside a foreign Manager");
    assert.deepEqual(reads, [flags], "the read is the one an empty census makes");
    assert.equal(notices.length, before + 1, "one notice names the foreign Manager");
  }
  await assert.rejects(reportRunningManagers({ on: "0123456789abcdefghijklmnopqrstuv" }, async () => "none", () => [foreign, manager]), /does not name a local Manager/, "an own local Manager still makes an unknown --on a refusal");
  await assert.rejects(readUpdateManagerContinuity(foreign, { creds: "/explicit.creds" }, async flags => {
    assert.deepEqual(flags, { creds: "/explicit.creds" });
    throw missing;
  }), actual => actual === missing);
  assert.equal(await readUpdateManagerContinuity(manager, {}, async () => "legacy"), "legacy", "answered legacy is unchanged");
  assert.equal(await readUpdateManagerContinuity(manager, {}, async () => "none"), "none");
  const processRecord = identityRecord(process.pid);
  assert.ok("token" in processRecord);
  if ("token" in processRecord) {
    const pinned = { ...manager, process: { ...processRecord } };
    await assert.rejects(readUpdateManagerContinuity(pinned, {}, async () => {
      pinned.process.token = "changed";
      throw missing;
    }, retained), /changed during its continuity read/);
    await assert.rejects(readUpdateManagerContinuity(pinned, {}, async () => "none"), /changed during its continuity read/);
    pinned.process.token = processRecord.token;
    await assert.rejects(readUpdateManagerContinuity(pinned, {}, async () => {
      pinned.process.token = "changed";
      return "legacy";
    }, retained), /changed during its continuity read/);
  }
} finally { console.log = log; }
// The selected mesh must not decide which local Managers share the installation.
const report = reportRunningManagers as unknown as (
  flags: Record<string, unknown>,
  read: (flags: Record<string, unknown>) => Promise<"none" | "legacy">,
  census: () => { space: string; server: string; root: string; instanceId: string; pid: number }[],
) => Promise<"none" | "legacy">;
await report({}, async flags => { seen.push(flags); return "none"; }, () => [
  { space: "A", server: "nats://127.0.0.1:4222", root: "/a", instanceId: "0123456789abcdefghijklmnopqrstuv", pid: 1 },
  { space: "A", server: "nats://127.0.0.1:4222", root: "/b", instanceId: "localtwo", pid: 2 },
]);
assert.deepEqual(seen.map(flags => [flags.space, flags.on]), [["A", "0123456789abcdefghijklmnopqrstuv"], ["A", "localtwo"]]);
seen.length = 0;
await report({ space: "B" }, async flags => { seen.push(flags); return "none"; }, () => [
  { space: "A", server: "nats://127.0.0.1:4222", root: "/a", instanceId: "0123456789abcdefghijklmnopqrstuv", pid: 1 },
]);
assert.deepEqual([...seen], [{ space: "B" }], "an explicit space still narrows the report");
seen.length = 0;
await report({ creds: "/explicit.creds" }, async flags => { seen.push(flags); return "none"; }, () => { throw Error("raw credentials must not enumerate unrelated Managers"); });
assert.deepEqual(seen, [{ creds: "/explicit.creds" }]);
const { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } = await import("node:fs");
const { tmpdir } = await import("node:os");
const { join } = await import("node:path");
const { spaceKey, recordMesh } = await import("@cotal-ai/workspace");
const { readUpdateManagerIdentity } = await import("../src/lib/update-managers.js");
const { isCliEntry, supervisorInstallScope } = await import("../src/lib/manager-proc.js");
const { fileURLToPath } = await import("node:url");
assert.equal(isCliEntry(fileURLToPath(new URL("../../../bin/cotal.ts", import.meta.url))), true, "checkout entry remains attributable across bin/package.json");
const ownEntry = (await import("node:fs")).realpathSync(process.argv[1]!);
const uid = process.getuid!();
assert.equal(supervisorInstallScope(process.pid, uid + 1, "node /unresolvable/foreign/cotal.js supervise", ownEntry), "foreign", "foreign user with no same-install entry is excluded");
assert.equal(supervisorInstallScope(process.pid, uid + 1, `node ${ownEntry} supervise`, ownEntry), "local", "sudo supervisor of this installation still counts");
assert.equal(supervisorInstallScope(process.pid, uid, `node ${ownEntry} supervise`, ownEntry), "local", "same-user supervisor of this installation still counts");
assert.equal(supervisorInstallScope(process.pid, uid, "node cotal.js supervise", ownEntry), "unknown", "relative missing entry does not prove another installation");
assert.equal(supervisorInstallScope(2147483647, uid, "node cotal.js supervise", ownEntry), "unknown", "unreadable namespace does not establish safety");
const root = mkdtempSync(join(tmpdir(), "cotal-update-identity-"));
try {
  mkdirSync(join(root, ".cotal", "auth"), { recursive: true });
  const file = join(root, ".cotal", "auth", `manager-instance.${spaceKey("A")}.json`);
  const bytes = JSON.stringify({ instanceId: "0123456789abcdefghijklmnopqrstuv", serveIdentity: { id: "unused", seed: "unused" } });
  writeFileSync(file, bytes);
  assert.equal(readUpdateManagerIdentity(root, "A"), "0123456789abcdefghijklmnopqrstuv");
  assert.equal(readFileSync(file, "utf8"), bytes, "legacy identity is retained without migration");
  assert.throws(() => readUpdateManagerIdentity(root, "missing"), /missing identity/);
  writeFileSync(file, "{}");
  assert.throws(() => readUpdateManagerIdentity(root, "A"), /invalid identity/);
} finally { rmSync(root, { recursive: true, force: true }); }
// A real argv-bearing process with a missing identity must not poison another explicit space.
if (process.platform === "linux") {
  const { spawn } = await import("node:child_process");
  const fixture = mkdtempSync(join(tmpdir(), "cotal-update-census-process-"));
  const entry = join(fixture, "cotal.ts");
  writeFileSync(entry, "setInterval(() => {}, 1000);\n");
  const foreignHome = process.env.COTAL_HOME;
  const sandboxHome = mkdtempSync(join(tmpdir(), "cotal-update-foreign-home-"));
  process.env.COTAL_HOME = sandboxHome;
  const child = spawn(process.execPath, [entry, "supervise", "--space", "unrelated", "--server", "nats://127.0.0.1:4222"], { cwd: fixture, stdio: "ignore" });
  const priorEntry = process.argv[1];
  try {
    await once(child, "spawn");
    process.argv[1] = entry;
    const { localUpdateManagers } = await import("../src/lib/update-managers.js");
    const scoped = localUpdateManagers as unknown as (flags: { space: string }) => unknown[];
    const foreign = localUpdateManagers({ space: "unrelated" }, entry);
    assert.equal(foreign.length, 1, "native foreign Manager is observed without identity file");
    assert.equal(foreign[0]!.ownership, "foreign");
    assert.equal(foreign[0]!.instanceId, undefined, "foreign instance is explicitly unavailable");
    assert.equal(foreign[0]!.server, undefined, "foreign broker is never inferred");
    const alias = join(sandboxHome, "root-alias");
    (await import("node:fs")).symlinkSync(fixture, alias);
    recordMesh({ space: "alias-owner", root: alias, server: "nats://127.0.0.1:4222", mode: "open", origin: "manual", ts: new Date().toISOString() });
    assert.throws(() => localUpdateManagers({ space: "unrelated" }, entry), /missing identity/, "all registry roots include symlink aliases even under another space name");
    (await import("node:fs")).unlinkSync(alias);
    (await import("node:fs")).mkdirSync(alias);
    recordMesh({ space: "ancestor-owner", root: join(fixture, ".."), server: "nats://127.0.0.1:4222", mode: "open", origin: "manual", ts: new Date().toISOString() });
    assert.throws(() => localUpdateManagers({ space: "unrelated" }, entry), /missing identity/, "nested own-root cwd cannot become foreign");
    assert.deepEqual(scoped({ space: "selected" }), [], "unrelated missing identity is excluded before validation");
  } finally {
    process.argv[1] = priorEntry!;
    child.kill();
    await once(child, "exit");
    if (foreignHome === undefined) delete process.env.COTAL_HOME;
    else process.env.COTAL_HOME = foreignHome;
    rmSync(sandboxHome, { recursive: true, force: true });
    rmSync(fixture, { recursive: true, force: true });
  }
  const relativeRoot = mkdtempSync(join(tmpdir(), "cotal-update-relative-"));
  const priorHome = process.env.COTAL_HOME;
  process.env.COTAL_HOME = join(relativeRoot, "home");
  recordMesh({ space: "relative-proof", root: relativeRoot, server: "nats://127.0.0.1:9", mode: "open", origin: "manual", ts: new Date().toISOString() });
  recordMesh({ space: "permission-proof", root: relativeRoot, server: "nats://127.0.0.1:9", mode: "open", origin: "manual", ts: new Date().toISOString() });
  const relativeEntry = join(relativeRoot, "entry.mjs");
  writeFileSync(relativeEntry, "setInterval(() => {}, 1000);\n");
  const otherRoot = join(relativeRoot, "other");
  mkdirSync(otherRoot);
  writeFileSync(join(otherRoot, "package.json"), JSON.stringify({ name: "cotal-ai", bin: { cotal: "cotal.js" } }));
  const otherEntry = join(otherRoot, "cotal.js");
  writeFileSync(otherEntry, "");
  const relativeChild = spawn(process.execPath, ["entry.mjs", "supervise", "--space", "relative-proof", "--server", "nats://127.0.0.1:9", otherEntry], { cwd: relativeRoot, stdio: "ignore" });
  try {
    await once(relativeChild, "spawn");
    const { localUpdateManagers } = await import("../src/lib/update-managers.js");
    assert.throws(() => localUpdateManagers({ space: "relative-proof" }, relativeEntry), /missing identity/, "relative same-install entry is resolved before another absolute CLI argument can exclude it");
  } finally {
    relativeChild.kill();
    await once(relativeChild, "exit");
  }
  try {
    const { spawnSync } = await import("node:child_process");
    const binary = join(relativeRoot, "changing-entry");
    const compiled = spawnSync("cc", [fileURLToPath(new URL("./fixtures/supervisor-dumpability.c", import.meta.url)), "-o", binary], { encoding: "utf8" });
    assert.equal(compiled.status, 0, `native dumpability fixture compiles: ${compiled.stderr}`);
    const changing = spawn("./changing-entry", ["supervise", "--space", "permission-proof", "--server", "nats://127.0.0.1:9", otherEntry], { cwd: relativeRoot, stdio: "ignore" });
    try {
      await once(changing, "spawn");
      const { localUpdateManagers } = await import("../src/lib/update-managers.js");
      for (let attempt = 0; attempt < 50; attempt++) {
        assert.throws(() => localUpdateManagers({ space: "permission-proof" }, binary), /local Manager continuity cannot be established/, "changing dumpability must refuse local custody, never silently exclude it");
      }
    } finally {
      changing.kill();
      await once(changing, "exit");
    }
  } finally {
    if (priorHome === undefined) delete process.env.COTAL_HOME;
    else process.env.COTAL_HOME = priorHome;
    rmSync(relativeRoot, { recursive: true, force: true });
  }
}
emitSentinel({ passed: counted.cells(), failed: 0 });
