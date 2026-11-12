/** Component checks only, not transaction integration or native installer acceptance. */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { chmodSync, existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { skipSuite } from "@cotal-ai/smoke-kit";
import { ensureStateDir, type DaemonPaths } from "../daemon/endpoint.js";
import { holdLifetime } from "../daemon/lifetime.js";
import { UpdateTransactionJournal, type UpdateTransactionIdentity } from "../daemon/update-transaction.js";

if (process.platform === "win32") skipSuite("update transaction component: Windows native secure persistence is unavailable, reads and writes are refused");
if (process.platform !== "linux" && process.platform !== "darwin") skipSuite("update transaction component: native lifetime lock requires Linux or macOS");
const root = realpathSync(mkdtempSync(join(realpathSync(tmpdir()), "dut-")));
chmodSync(root, 0o700);
const paths: DaemonPaths = { state: root, lock: join(root, "daemon.lock"), socket: join(root, "d.sock"), dir: root };
ensureStateDir(paths);
const held = holdLifetime(paths.lock);
const tuple = (): UpdateTransactionIdentity => ({ attemptId: randomUUID(), owner: "component-owner", installedCoordinate: "a".repeat(64), targetVersion: "0.200.0", packageSha256: "b".repeat(64), scope: "current-user" });
const journal = new UpdateTransactionJournal(paths);
try {
  assert.throws(() => holdLifetime(paths.lock), { code: "LOCK_HELD" });
  assert.equal(journal.read(), undefined);
  const original = tuple();
  const begun = journal.begin(original);
  assert.equal(begun.phase, "preparing");
  assert.equal(begun.revision, 1);
  const reopened = new UpdateTransactionJournal(paths);
  assert.deepEqual(reopened.read(), begun);
  assert.deepEqual(reopened.begin(original), begun);
  for (const changed of [
    { ...original, attemptId: randomUUID() }, { ...original, owner: "another-owner" },
    { ...original, installedCoordinate: "c".repeat(64) }, { ...original, targetVersion: "0.201.0" },
    { ...original, packageSha256: "c".repeat(64) },
  ]) assert.throws(() => reopened.begin(changed), /conflicts/);
  assert.throws(() => journal.advance(original.attemptId, original.owner, 0, "fenced"), /revision conflict/);
  assert.throws(() => journal.advance(original.attemptId, "another-owner", 1, "fenced"), /does not match/);
  assert.throws(() => journal.advance(randomUUID(), original.owner, 1, "fenced"), /does not match/);
  const fenced = journal.advance(original.attemptId, original.owner, 1, "fenced");
  assert.equal(fenced.revision, 2);
  assert.equal(fenced.phase, "fenced");
  assert.throws(() => journal.advance(original.attemptId, original.owner, 1, "aborted"), /revision conflict/);
  const aborted = journal.advance(original.attemptId, original.owner, 2, "aborted");
  assert.equal(aborted.revision, 3);
  assert.equal(aborted.phase, "aborted");
  assert.deepEqual(reopened.read(), aborted);
  assert.deepEqual(journal.begin(original), aborted);
  for (const phase of ["preparing", "fenced", "blocked", "aborted"] as const)
    assert.throws(() => journal.advance(original.attemptId, original.owner, 3, phase), /transition is refused/);
  assert.equal(existsSync(journal.file), true, "terminal record remains retained");
  const saved = readFileSync(journal.file, "utf8");
  writeFileSync(journal.file, "not-json");
  assert.throws(() => journal.read());
  writeFileSync(journal.file, JSON.stringify({ ...aborted, unknown: true }));
  assert.throws(() => journal.read(), /unsupported or missing/);
  writeFileSync(journal.file, saved);
  chmodSync(journal.file, 0o644);
  assert.throws(() => journal.read(), /private owned regular file/);
  chmodSync(journal.file, 0o600);
  const target = join(root, "symlink-target.json");
  writeFileSync(target, saved, { mode: 0o600 });
  // Corrupt only this disposable fixture, never through a product removal API.
  unlinkSync(journal.file);
  symlinkSync(target, journal.file);
  assert.throws(() => journal.read());
  unlinkSync(journal.file);
  writeFileSync(journal.file, saved, { mode: 0o600 });
  assert.deepEqual(journal.read(), aborted);
  console.log("PASS journal begin, reopen, identity, CAS, fenced abort, terminal retention and corrupt-file refusal");
} finally {
  // This private fixture has no spawned workers. Keep its native ownership through deletion.
  try { rmSync(root, { recursive: true, force: true }); }
  finally { held.release(); }
}

for (const transition of ["abort", "block-preparing", "block-fenced"] as const) {
  const directory = realpathSync(mkdtempSync(join(realpathSync(tmpdir()), "dut-")));
  chmodSync(directory, 0o700);
  const fixture: DaemonPaths = { state: directory, lock: join(directory, "daemon.lock"), socket: join(directory, "d.sock"), dir: directory };
  ensureStateDir(fixture);
  const lock = holdLifetime(fixture.lock);
  try {
    const component = new UpdateTransactionJournal(fixture);
    const identity = tuple();
    let current = component.begin(identity);
    if (transition === "block-fenced") current = component.advance(identity.attemptId, identity.owner, current.revision, "fenced");
    current = component.advance(identity.attemptId, identity.owner, current.revision, transition === "abort" ? "aborted" : "blocked");
    for (const phase of ["preparing", "fenced", "blocked", "aborted"] as const)
      assert.throws(() => component.advance(identity.attemptId, identity.owner, current.revision, phase), /transition is refused/);
    assert.deepEqual(new UpdateTransactionJournal(fixture).read(), current);
    assert.equal(existsSync(component.file), true);
    console.log(`PASS journal ${transition} remains immutable and retained`);
  } finally {
    try { rmSync(directory, { recursive: true, force: true }); }
    finally { lock.release(); }
  }
}
console.log("DAEMON UPDATE TRANSACTION COMPONENT SMOKE OK (not integration acceptance)");
