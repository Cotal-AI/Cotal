import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mintLifecycleUid } from "@cotal-ai/core";
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
} finally {
  rmSync(dir, { recursive: true, force: true });
}
console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exitCode = 1;
