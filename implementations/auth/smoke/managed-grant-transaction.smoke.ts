import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mintAgentUid, mintLifecycleUid } from "@cotal-ai/core";
import { SignJWT } from "jose";
import {
  findActorUnified, grantActor, grantLinkedActor, grantManagedActor, hashActorToken, ledgerAuthorizeAgentExchange,
  ledgerAuthorizeConnect, managedActorLedgerDir, revokeLinkedActor, revokeManagedActor, revokeManagedActorIf,
  withManagedGrantTransaction, type ManagedGrantTransaction,
} from "../src/ledger.js";
import { createUserTokenIssuer, generateSigningKey } from "../src/issuer.js";
import { validateUserToken } from "../src/token.js";

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
  check("linked grants are versioned, immutable and retired only by the exact coordinates", () => {
    const actorToken = "test-bootstrap";
    const row = { ...input, actor: "linked", agentUid: mintAgentUid(), linkOperationId: "a".repeat(32), tokenHash: hashActorToken(actorToken), eventPayloads: false as const };
    const ordinary = { ...input, actor: row.actor };
    const file = join(managedActorLedgerDir(dir), `${owner}.${row.actor}.json`);
    grantManagedActor(dir, ordinary);
    assert.equal(JSON.parse(readFileSync(file, "utf8")).ver, 1);
    assert.throws(() => grantLinkedActor(dir, row), /different managed grant/);
    assert.throws(() => revokeLinkedActor(dir, row), /exact linked grant/);
    assert.equal(revokeManagedActor(dir, owner, row.actor), true);

    const created = grantLinkedActor(dir, row);
    assert.equal(findActorUnified(dir, owner, row.actor)?.eventPayloads, false);
    assert.equal(JSON.parse(readFileSync(file, "utf8")).ver, 2);
    assert.deepEqual(grantLinkedActor(dir, { ...row, label: undefined }), created);
    assert.throws(() => grantManagedActor(dir, ordinary), /exact linked mutation/);
    assert.throws(() => grantManagedActor(dir, row), /exact linked mutation/);
    assert.throws(() => revokeManagedActor(dir, owner, row.actor), /exact linked mutation/);
    assert.throws(() => revokeManagedActorIf(dir, owner, row.actor, { lifecycleUid: uid, custody }), /exact linked mutation/);
    assert.throws(() => withManagedGrantTransaction(dir, (tx) => tx.revokeManagedAt(owner, row.actor, uid)), /exact linked mutation/);
    assert.throws(() => grantLinkedActor(dir, { ...row, custody: { kind: "foreground" } }), /different managed grant/);
    assert.throws(() => revokeLinkedActor(dir, { ...row, tokenHash: input.tokenHash }), /exact linked grant/);
    assert.throws(() => revokeLinkedActor(dir, { ...row, lifecycleUid: mintLifecycleUid() }), /exact linked grant/);
    assert.throws(() => revokeLinkedActor(dir, { ...row, agentUid: mintAgentUid() }), /exact linked grant/);
    assert.throws(() => revokeLinkedActor(dir, { ...row, linkOperationId: "c".repeat(32) }), /exact linked grant/);
    const exchange = ledgerAuthorizeAgentExchange(dir, owner, row.actor, actorToken);
    assert.equal(exchange.agentUid, row.agentUid);
    assert.equal(exchange.linkOperationId, row.linkOperationId);
    const persisted = readFileSync(file, "utf8");
    writeFileSync(file, JSON.stringify({ ...JSON.parse(persisted), ver: 1 }));
    assert.throws(() => findActorUnified(dir, owner, row.actor), /exact linked mutation/);
    writeFileSync(file, JSON.stringify({ ...JSON.parse(persisted), linkOperationId: undefined }));
    assert.throws(() => findActorUnified(dir, owner, row.actor), /requires agentUid/);
    writeFileSync(file, persisted);
    assert.equal(revokeLinkedActor(dir, row), true);
    assert.equal(revokeLinkedActor(dir, row), false);
  });
  {
    const row = { ...input, actor: "bearer", agentUid: mintAgentUid(), linkOperationId: "b".repeat(32) };
    grantLinkedActor(dir, row);
    const issuerName = "test-issuer";
    const space = "test-space";
    const key = await generateSigningKey();
    const issuer = createUserTokenIssuer({ issuer: issuerName, key });
    const opts = { key: issuer.localKeySet(), issuer: issuerName, audience: space };
    const claims = { owner, actor: row.actor, lifecycleUid: uid, space };
    const ordinary = await validateUserToken(await issuer.issue(claims), opts);
    const linked = await validateUserToken(await issuer.issue({ ...claims, agentUid: row.agentUid }), opts);
    const wrong = await validateUserToken(await issuer.issue({ ...claims, agentUid: mintAgentUid() }), opts);
    check("only a linked bearer with the exact agent UID matches a linked row", () => {
      assert.equal(ordinary.ver, 1);
      assert.equal(linked.ver, 2);
      assert.equal(linked.act.agentUid, row.agentUid);
      const authorize = ledgerAuthorizeConnect(dir);
      assert.doesNotThrow(() => authorize(linked));
      assert.throws(() => authorize(ordinary), /identity binding/);
      assert.throws(() => authorize(wrong), /identity binding/);
      revokeLinkedActor(dir, row);
      grantManagedActor(dir, { ...input, actor: row.actor });
      assert.doesNotThrow(() => authorize(ordinary));
      assert.throws(() => authorize(linked), /identity binding/);
    });
    await assert.rejects(issuer.issue({ ...claims, agentUid: row.agentUid, view: "admin" }), /cannot carry a view/);
    const sign = (ver: number, agentUid?: string) => new SignJWT({ ver, act: { owner, actor: row.actor, lifecycleUid: uid, agentUid } })
      .setProtectedHeader({ alg: "EdDSA", kid: key.kid }).setSubject(owner).setIssuer(issuerName).setAudience(space)
      .setIssuedAt().setNotBefore("0s").setExpirationTime("60s").sign(key.privateKey);
    await assert.rejects(validateUserToken(await sign(1, row.agentUid), opts), /requires the linked run bearer version/);
    await assert.rejects(validateUserToken(await sign(2), opts), /requires act.agentUid/);
  }
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
