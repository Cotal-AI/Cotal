import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beginGlobalUpdateChild, inspectGlobalUpdateChild, updateCustodyPrivateGroup, type UpdateCustodyAccounts } from "../src/extension-mutation.js";
import { acquireLock } from "../src/advisory-lock.js";

const uid = process.getuid!(), gid = process.getgid!();
const accounts: UpdateCustodyAccounts = {
  passwd: `fixture:x:${uid}:${gid}:fixture:/home/fixture:/bin/sh\n`,
  group: `fixture:x:${gid}:\n`,
  nsswitch: "passwd: files systemd\ngroup: files systemd\n",
};
assert.equal(updateCustodyPrivateGroup(accounts, uid, gid), true);
for (const bad of [
  { ...accounts, passwd: accounts.passwd + `other:x:${uid + 1}:${gid}:other:/home/other:/bin/sh\n` },
  { ...accounts, group: `fixture:x:${gid}:other\n` },
  { ...accounts, nsswitch: "passwd: files sss\ngroup: files\n" },
  { ...accounts, nsswitch: "passwd: files\n" },
  { ...accounts, passwd: "malformed" },
  { ...accounts, group: "malformed" },
  { ...accounts, group: accounts.group + accounts.group },
  { ...accounts, passwd: "x".repeat(1024 * 1024 + 1) },
]) assert.equal(updateCustodyPrivateGroup(bad, uid, gid), false);
assert.equal(updateCustodyPrivateGroup(accounts, uid, gid + 1), false);

const scratch = mkdtempSync(join(tmpdir(), "cotal-custody-"));
try {
  const ancestor = join(scratch, "share");
  const root = join(ancestor, "prefix", "lib", "node_modules");
  mkdirSync(root, { recursive: true, mode: 0o755 });
  chmodSync(ancestor, 0o775);
  const lock = acquireLock(join(root, ".cotal-update.lock"), { label: "fixture update" });
  try {
    const mutation = beginGlobalUpdateChild(root, "reconcile");
    const markerPath = join(root, ".cotal-update-child");
    const pending = inspectGlobalUpdateChild(root, accounts);
    assert.equal(pending.owner.state, "active");
    assert.equal(pending.child?.phase, "pending");
    mutation.markLive(process.pid);
    const original = readFileSync(markerPath, "utf8");
    assert.equal(inspectGlobalUpdateChild(root, accounts).child?.phase, "live");
    assert.equal(readFileSync(markerPath, "utf8"), original, "inspection never clears or rewrites the marker");
    assert.throws(() => inspectGlobalUpdateChild(root, { ...accounts, group: `fixture:x:${gid}:other\n` }), /not protected/);
    chmodSync(ancestor, 0o777);
    assert.throws(() => inspectGlobalUpdateChild(root, accounts), /not protected/);
    chmodSync(ancestor, 0o775);
    writeFileSync(markerPath, "{}");
    assert.throws(() => inspectGlobalUpdateChild(root, accounts), /marker is invalid/);
    writeFileSync(markerPath, original);
    rmSync(markerPath);
    symlinkSync(join(root, "absent"), markerPath);
    assert.throws(() => inspectGlobalUpdateChild(root, accounts), /not protected/);
    rmSync(markerPath);
  } finally { lock.release(); }
} finally { rmSync(scratch, { recursive: true, force: true }); }
console.log("update-custody.smoke: local primary-group proof and real-path marker inspection passed");
