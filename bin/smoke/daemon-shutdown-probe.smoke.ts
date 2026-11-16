/** Shutdown decisions retain ownership refusals and distinguish zero bytes from invalid records. */
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EmptyLifetimeRefusal, isStoppingLifetime } from "../daemon/client.js";
import { EndpointRefusal } from "../daemon/endpoint.js";
import { observeLifetimeRecord, readLifetimeRecord } from "../daemon/lifetime.js";

const root = mkdtempSync(join(tmpdir(), "shutdown-decision-"));
const file = join(root, "daemon.lock");
const owner = { pid: 42, start: "134391235885292813" };
let checks = 0;
const check = (condition: boolean) => { assert.ok(condition); checks++; };
try {
  const empty = new EmptyLifetimeRefusal("nothing was sent", owner.pid, owner.start);
  check(empty instanceof EndpointRefusal && empty.code === "PEER_NOT_LOCK_OWNER");
  check(isStoppingLifetime(empty, owner));
  for (const pinned of [undefined, { pid: 43, start: owner.start }, { pid: owner.pid, start: "another" }, { pid: owner.pid }, { pid: owner.pid, start: "" }]) check(!isStoppingLifetime(empty, pinned));
  for (const error of [new EndpointRefusal("PEER_NOT_LOCK_OWNER", "different holder"), new EndpointRefusal("PEER_UID_MISMATCH", "another user"), new EndpointRefusal("NOT_RUNNING", "absent"), new Error("ECONNRESET"), { pid: owner.pid, birth: owner.start, code: "PEER_NOT_LOCK_OWNER" }]) check(!isStoppingLifetime(error, owner));
  for (const raw of ["", " ", "\n", "{}", "not-json", JSON.stringify({ v: 1, pid: 99, start: "other", startedAt: "now" }), JSON.stringify({ v: 1, pid: owner.pid, start: owner.start, startedAt: "now" })]) {
    writeFileSync(file, raw);
    const observed = observeLifetimeRecord(file);
    check(observed.empty === (raw.length === 0));
    assert.deepEqual(readLifetimeRecord(file), observed.record); checks++;
    if (observed.record) check(observed.record.pid === (raw.includes('"pid":99') ? 99 : owner.pid));
  }
  check(!observeLifetimeRecord(root).empty); // Unreadable as a regular file, never empty evidence.
  check(!observeLifetimeRecord(join(root, "missing")).empty);
  console.log(`PASS shutdown probe decisions: ${checks} checks`);
} finally { rmSync(root, { recursive: true, force: true }); }
