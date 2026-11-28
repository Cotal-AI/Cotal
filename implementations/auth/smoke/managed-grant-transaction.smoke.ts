import assert from "node:assert/strict";
import fs, { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mintLifecycleUid } from "@cotal-ai/core";
import * as auth from "@cotal-ai/auth";
import {
  findActorUnified, grantActor, grantManagedActor, managedActorLedgerDir, revokeManagedActorIf,
  withManagedGrantTransaction, type ManagedGrantTransaction,
} from "../src/ledger.js";

const dir = mkdtempSync(join(tmpdir(), "cotal-managed-grant-tx-"));
const owner = `u_${"a".repeat(26)}`;
const uid = mintLifecycleUid(), manager = mintLifecycleUid();
const custody = { kind: "local-manager" as const, instanceId: manager };
const input = { owner, actor: "worker", scope: [], allowSubscribe: [], allowPublish: [],
  tokenHash: "a".repeat(64), lifecycleUid: uid, custody };
let passed = 0, failed = 0;
function check(name: string, run: () => void): void {
  try { run(); passed++; console.log(`  ✓ ${name}`); }
  catch (error) { failed++; console.error(`  ✗ ${name}`, error); }
}

function subtreeCells(): void {
  const { commitManagedGrantSubtreeRevoke, snapshotManagedGrantSubtree } = auth;
  const make = (actor: string, parent?: string) => ({
    ...input, ...auth.newActorToken(), actor, lifecycleUid: mintLifecycleUid(), scope: ["spawn"],
    ...(parent === undefined ? {} : { parent }),
  });
  const key = (row: { owner: string; actor: string }) => `${row.owner}.${row.actor}`;
  const put = ({ actorToken: _actorToken, ...row }: ReturnType<typeof make>) => auth.grantManagedActor(dir, row);
  const read = (row: { owner: string; actor: string }) => auth.findManagedActor(dir, row.owner, row.actor);
  const coord = ({ owner, actor, lifecycleUid }: ReturnType<typeof make>) => ({ owner, actor, lifecycleUid });
  const snapshot = (row: ReturnType<typeof make>) => {
    const result = snapshotManagedGrantSubtree(dir, row.owner, row.actor, row.lifecycleUid);
    if (typeof result === "string") assert.fail(`Expected a subtree snapshot, got ${result}`);
    return result;
  };
  check("the grant writers' transaction is not exported from the package root", () => {
    assert.equal("withManagedGrantTransaction" in auth, false);
  });
  check("a child moved to another valid parent makes commit change nothing", () => {
    const root = make("move_root"), other = make("other");
    put(root);
    put(other);
    const child = make("moved", key(root));
    put(child);
    const before = snapshot(root);
    const moved = { ...child, parent: key(other) };
    put(moved);
    assert.equal(auth.ledgerAuthorizeAgentExchange(dir, owner, moved.actor, moved.actorToken).parent, key(other));
    assert.deepEqual(commitManagedGrantSubtreeRevoke(dir, before), { status: "changed" });
    assert.equal(read(root)?.lifecycleUid, root.lifecycleUid);
    assert.equal(read(moved)?.parent, key(other));
    assert.equal(read(moved)?.lifecycleUid, moved.lifecycleUid);
  });
  check("a child granted after the snapshot makes commit change nothing", () => {
    const root = make("late_root");
    put(root);
    const before = snapshot(root);
    assert.deepEqual(before.descendants, []);
    const late = make("late_child", key(root));
    put(late);
    assert.deepEqual(commitManagedGrantSubtreeRevoke(dir, before), { status: "changed" });
    assert.equal(read(root)?.lifecycleUid, root.lifecycleUid);
    assert.equal(auth.ledgerAuthorizeAgentExchange(dir, owner, late.actor, late.actorToken).lifecycleUid, late.lifecycleUid);
    assert.deepEqual(commitManagedGrantSubtreeRevoke(dir, snapshot(root)), { status: "removed", removed: [coord(late), coord(root)] });
    assert.equal(read(late), undefined);
    assert.equal(read(root), undefined);
  });
  check("a native-only subtree includes cross-owner admin launches and revokes leaf first", () => {
    const root = { ...make("admin_root"), scope: ["admin"] };
    put(root);
    const child = { ...make("foreign_child", key(root)), owner: `u_${"b".repeat(26)}` };
    put(child);
    const leaf = { ...make("foreign_leaf", key(child)), owner: child.owner };
    put(leaf);
    const before = snapshot(root);
    assert.deepEqual(before, { root: coord(root), descendants: [
      { ...coord(leaf), parent: key(child) }, { ...coord(child), parent: key(root) },
    ] });
    assert.equal(read(leaf)?.lifecycleUid, leaf.lifecycleUid);
    assert.deepEqual(commitManagedGrantSubtreeRevoke(dir, before), { status: "removed", removed: [coord(leaf), coord(child), coord(root)] });
    for (const row of [leaf, child, root]) assert.equal(read(row), undefined);
    assert.deepEqual(commitManagedGrantSubtreeRevoke(dir, before), { status: "changed" });
    assert.equal(snapshotManagedGrantSubtree(dir, root.owner, root.actor), "absent");
  });
  check("parent changes inside the same subtree preserve all rows", () => {
    const root = make("same_root"), parent = make("same_parent", key(root)), leaf = make("same_leaf", key(root));
    for (const row of [root, parent, leaf]) put(row);
    const before = snapshot(root);
    put({ ...leaf, parent: key(parent) });
    assert.deepEqual(commitManagedGrantSubtreeRevoke(dir, before), { status: "changed" });
    for (const row of [root, parent, leaf]) assert.equal(read(row)?.lifecycleUid, row.lifecycleUid);
  });
  check("root and descendant lifecycle changes preserve all rows", () => {
    const root = make("replace_root"), child = make("replace_child", key(root));
    put(root);
    put(child);
    const before = snapshot(root);
    const newChild = make(child.actor, key(root));
    put(newChild);
    assert.deepEqual(commitManagedGrantSubtreeRevoke(dir, before), { status: "changed" });
    const newRoot = make(root.actor);
    put(newRoot);
    assert.equal(snapshotManagedGrantSubtree(dir, root.owner, root.actor, root.lifecycleUid), "superseded");
    assert.deepEqual(commitManagedGrantSubtreeRevoke(dir, before), { status: "changed" });
    assert.equal(read(newRoot)?.lifecycleUid, newRoot.lifecycleUid);
    assert.equal(read(newChild)?.lifecycleUid, newChild.lifecycleUid);
  });
  check("a delegation cycle errors on snapshot and invalidates an earlier commit", () => {
    const root = { ...make("cycle_root"), scope: ["admin"] };
    put(root);
    const child = { ...make("cycle_child", key(root)), scope: ["admin"] };
    put(child);
    const before = snapshot(root);
    put({ ...root, parent: key(child) });
    assert.throws(() => snapshot(root), /delegation cycle/);
    assert.deepEqual(commitManagedGrantSubtreeRevoke(dir, before), { status: "changed" });
    assert.equal(read(root)?.parent, key(child));
    assert.equal(read(child)?.parent, key(root));
  });
  check("an interactive descendant invalidates commit and is never deleted", () => {
    const root = make("mixed_root");
    put(root);
    const before = snapshot(root);
    const child = auth.grantActor(dir, { owner, actor: "interactive_link", parent: key(root),
      scope: [], allowSubscribe: [], allowPublish: [] });
    assert.deepEqual(commitManagedGrantSubtreeRevoke(dir, before), { status: "changed" });
    assert.throws(() => snapshot(root), /contains an interactive grant/);
    assert.equal(read(root)?.lifecycleUid, root.lifecycleUid);
    assert.equal(auth.findInteractiveActor(dir, owner, child.actor)?.lifecycleUid, child.lifecycleUid);
  });
  check("a failed delete reports only rows already removed and preserves its ancestors", () => {
    const root = make("failure_root");
    const child = make("failure_child", key(root));
    const leaf = make("failure_leaf", key(child));
    for (const row of [root, child, leaf]) put(row);
    const before = snapshot(root);
    const failAt = join(managedActorLedgerDir(dir), auth.ledgerRowFilename(owner, child.actor));
    const failure = new Error("simulated filesystem delete failure");
    const remove = fs.rmSync;
    fs.rmSync = (path, options) => {
      if (path === failAt) throw failure;
      return remove(path, options);
    };
    syncBuiltinESMExports();
    try {
      assert.throws(() => commitManagedGrantSubtreeRevoke(dir, before), (error: unknown) => {
        assert.ok(error instanceof auth.ManagedGrantSubtreeRevokeError);
        assert.deepEqual(error.removed, [coord(leaf)]);
        assert.equal(error.cause, failure);
        return true;
      });
    } finally {
      fs.rmSync = remove;
      syncBuiltinESMExports();
    }
    assert.equal(read(leaf), undefined);
    assert.equal(read(child)?.lifecycleUid, child.lifecycleUid);
    assert.equal(read(root)?.lifecycleUid, root.lifecycleUid);
  });
}

try {
  check("a synchronous transaction returns its result", () => assert.equal(withManagedGrantTransaction(dir, () => 42), 42));
  check("a returned facade is closed", () => {
    const tx = withManagedGrantTransaction(dir, (tx) => tx);
    assert.throws(() => tx.read(owner, "worker"), /transaction has ended/);
  });
  check("a facade closes after a throwing body", () => {
    let saved: ManagedGrantTransaction | undefined;
    assert.throws(() => withManagedGrantTransaction(dir, (tx) => { saved = tx; throw new Error("body failed"); }), /body failed/);
    assert.throws(() => saved!.read(owner, "worker"), /transaction has ended/);
  });
  check("a promise-returning body is refused and its facade closes", () => {
    let saved: ManagedGrantTransaction | undefined;
    assert.throws(() => withManagedGrantTransaction(dir, (tx) => { saved = tx; return Promise.resolve(); }), /body returned a promise/);
    assert.throws(() => saved!.read(owner, "worker"), /transaction has ended/);
  });
  check("same-process nesting refuses without acquiring again", () => {
    withManagedGrantTransaction(dir, () => assert.throws(() => withManagedGrantTransaction(dir, () => {}), /already holds the grant lock/));
  });
  check("the next transaction works after every refusal", () => assert.equal(withManagedGrantTransaction(dir, () => "released"), "released"));
  check("the transaction facade is frozen", () => withManagedGrantTransaction(dir, (tx) => assert.equal(Object.isFrozen(tx), true)));
  check("a managed grant records its writer's custody", () => {
    grantManagedActor(dir, input);
    assert.deepEqual(findActorUnified(dir, owner, "worker")?.custody, custody);
  });
  check("a successor uid is not revoked", () => assert.equal(revokeManagedActorIf(dir, owner, "worker", { lifecycleUid: mintLifecycleUid(), custody }), "superseded"));
  check("another local manager is not this custodian", () => assert.equal(revokeManagedActorIf(dir, owner, "worker", { lifecycleUid: uid, custody: { kind: "local-manager", instanceId: mintLifecycleUid() } }), "custody-mismatch"));
  check("a remote manager is not a local custodian", () => assert.equal(revokeManagedActorIf(dir, owner, "worker", { lifecycleUid: uid, custody: { kind: "remote-manager", instanceId: manager } }), "custody-mismatch"));
  check("a foreground launch is not a manager custodian", () => assert.equal(revokeManagedActorIf(dir, owner, "worker", { lifecycleUid: uid, custody: { kind: "foreground" } }), "custody-mismatch"));
  check("refused revokes preserve the original row", () => assert.deepEqual(findActorUnified(dir, owner, "worker")?.custody, custody));
  check("the matching uid and custody revoke once", () => assert.equal(revokeManagedActorIf(dir, owner, "worker", { lifecycleUid: uid, custody }), "revoked"));
  check("a repeat reports absence", () => assert.equal(revokeManagedActorIf(dir, owner, "worker", { lifecycleUid: uid, custody }), "absent"));
  check("a legacy row remains readable but is not adopted", () => {
    grantManagedActor(dir, input);
    const file = join(managedActorLedgerDir(dir), `${owner}.worker.json`);
    const value = JSON.parse(readFileSync(file, "utf8"));
    delete value.custody;
    writeFileSync(file, `${JSON.stringify(value)}\n`, { mode: 0o600 });
    assert.equal(findActorUnified(dir, owner, "worker")?.custody, undefined);
    assert.equal(revokeManagedActorIf(dir, owner, "worker", { lifecycleUid: uid, custody }), "custody-mismatch");
    assert.ok(findActorUnified(dir, owner, "worker"));
  });
  check("a managed grant cannot shadow an interactive row", () => {
    grantActor(dir, { owner, actor: "interactive", scope: [], allowSubscribe: [], allowPublish: [] });
    assert.throws(() => grantManagedActor(dir, { ...input, actor: "interactive" }), /interactive grant/);
  });
  check("a managed row cannot be re-granted interactively", () => assert.throws(() => grantActor(dir, { owner, actor: "worker", scope: [], allowSubscribe: [], allowPublish: [] }), /managed agent/));
  check("foreground custody is a closed shape", () => assert.throws(() => grantManagedActor(dir, { ...input, actor: "bad", custody: { kind: "foreground", instanceId: manager } } as never), /foreground custody carries no other field/));
  check("a rejected custody writes no row", () => assert.equal(findActorUnified(dir, owner, "bad"), undefined));
  subtreeCells();
} finally {
  rmSync(dir, { recursive: true, force: true });
}
console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exitCode = 1;
