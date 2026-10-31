import assertBase from "node:assert/strict";
import fs from "node:fs";
import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mock } from "node:test";
import { countedAssert, emitSentinel, skipSuite } from "@cotal-ai/smoke-kit";

const counted = countedAssert(assertBase);
const assert: typeof assertBase = counted.assert as typeof assertBase;
const cells = counted.cells;

if (process.platform !== "linux") {
  skipSuite("advisory-lock-stat requires Linux /proc");
} else {
  // Exercise the shipped build, with real reads confined to this process's own stat and private locks.
  const { acquireLock, inspectLock, processStartToken } = await import("../dist/advisory-lock.js");
  const root = fs.mkdtempSync(join(tmpdir(), "cotal-lock-stat-"));
  const path = join(root, "owner.lock");
  const statPath = `/proc/${process.pid}/stat`;
  const realRead = fs.readFileSync;
  let statReads = 0;
  let psCalls = 0;
  let snapshot: (() => string) | undefined;
  const reader = mock.method(fs, "readFileSync", (file: fs.PathOrFileDescriptor, options?: unknown) => {
    if (String(file) === statPath) {
      statReads++;
      if (snapshot) return snapshot();
    }
    return Reflect.apply(realRead, fs, [file, options]);
  });
  const ps = mock.method(childProcess, "execFileSync", () => {
    psCalls++;
    throw new Error("Linux lock inspection must not invoke ps");
  });
  syncBuiltinESMExports();

  try {
    const held = acquireLock(path, { waitMs: 0 });
    const owner = JSON.parse(fs.readFileSync(path, "utf8"));
    assert.equal(owner.pid, process.pid);
    assert.match(owner.start, /^\d+$/);
    const inspectOnce = (state: "active" | "stale", reads: number) => {
      statReads = 0;
      assert.equal(inspectLock(path).state, state);
      assert.equal(statReads, reads, "each inspection reads one process snapshot at most");
    };
    try {
      inspectOnce("active", 1);
      inspectOnce("active", 1);
      statReads = 0;
      assert.equal(processStartToken(process.pid), owner.start);
      assert.equal(statReads, 1, "the public token reader uses one stat read");
    } finally {
      held.release();
    }
    assert.equal(inspectLock(path).state, "absent");
    console.log("PASS live acquired owner: repeated inspections and token reader each read stat once; release removes lock");

    const record = (start: string | undefined) => fs.writeFileSync(path, JSON.stringify({ ...owner, start }));
    record(undefined);
    inspectOnce("active", 0);
    record(`${owner.start}0`);
    inspectOnce("stale", 1);
    record(owner.start);
    assert.throws(() => acquireLock(path, { waitMs: 0 }), /held by a live process/);
    assert.equal(JSON.parse(fs.readFileSync(path, "utf8")).nonce, owner.nonce);
    console.log("PASS live controls: start-less owner needs no stat, mismatched token is stale, contention preserves the owner");

    // Synthetic records isolate parsing and race semantics. A second read would observe a reused PID.
    const stat = (state: string, start: string, pid = process.pid) =>
      `${pid} (a ) b (c)) ${[state, ...Array<string>(18).fill("0"), start].join(" \t ")}\n`;
    snapshot = () => stat("S", owner.start);
    statReads = 0;
    assert.equal(processStartToken(process.pid), owner.start, "comm spaces/parens and whitespace share one parser");
    assert.equal(statReads, 1);
    snapshot = () => stat("Z", owner.start);
    inspectOnce("stale", 1);
    snapshot = () => stat("Z", "reused");
    inspectOnce("stale", 1);
    snapshot = () => stat("S", statReads === 1 ? owner.start : "reused");
    inspectOnce("active", 1);
    console.log("PASS synthetic snapshots: tricky comm, zombie and reused identity use the same single record");

    for (const unavailable of [
      () => "no comm terminator",
      () => stat("Z", owner.start, process.pid + 1),
      () => `${process.pid} (short) Z 0\n`,
      () => { throw Object.assign(new Error("unreadable"), { code: "EACCES" }); },
      () => { throw Object.assign(new Error("gone"), { code: "ENOENT" }); },
    ]) {
      snapshot = unavailable;
      inspectOnce("active", 1);
      statReads = 0;
      assert.equal(processStartToken(process.pid), undefined);
      assert.equal(statReads, 1);
    }
    assert.equal(psCalls, 0, "unavailable Linux identity never falls back to ps");
    console.log("PASS synthetic failures: malformed, mismatched-PID, truncated, denied and absent stat remain active/unknown without ps");
    emitSentinel({ passed: cells(), failed: 0 });
  } finally {
    reader.mock.restore();
    ps.mock.restore();
    syncBuiltinESMExports();
    fs.rmSync(root, { recursive: true, force: true });
  }
}
