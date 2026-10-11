import assert from "node:assert/strict";
import { connect, jwtAuthenticator } from "@nats-io/transport-node";
import { jetstreamManager } from "@nats-io/jetstream";
import { Kvm } from "@nats-io/kv";
import {
  credsClaims, credsFromJwt, ensureAuthorityStores, endpointRegistrationBarrier, environmentBootstrapActor,
  epAuthBucket, epgateKey, mintLifecycleUid, newIdentity, parseEndpointGate, serveIssuanceGateKv,
} from "@cotal-ai/core";
import { emitSentinel } from "@cotal-ai/smoke-kit";
import { environmentManagerAdmissionWriterGrants, openAuthorityClient } from "../src/authority-client.js";
import { stageEnvironmentManagerAdmission, type EnvironmentManagerAdmissionCoordinates } from "../src/environment-manager-admission.js";
import { mintEnvironmentManagerBootstrap } from "../src/environment-manager-bootstrap-mint.js";
import { freezeGate, observeGate, openLifecycleRegistry, registryStores } from "../src/lifecycle-registry.js";
import { startHostedAuthFixture } from "./_hosted-auth-fixture.js";

const fx = await startHostedAuthFixture("environment-bootstrap-mint", 2);
const account = fx.accounts[0]!;
const signer = { pub: account.accountPublicKey, signingSeed: account.auth.account.signingSeed! };
const writer = await openAuthorityClient({ server: fx.servers, space: account.space,
  dataAccount: signer, label: "environment-bootstrap-mint", grants: id => environmentManagerAdmissionWriterGrants(account.space, id), log: () => {} });
let passed = 0, failed = 0;
const cell = async (name: string, run: () => Promise<void>) => {
  try { await run(); passed++; console.log(`  ✓ ${name}`); }
  catch (error) { failed++; console.error(`  ✗ ${name}: ${error instanceof Error ? error.message : String(error)}`); }
};
try {
  await ensureAuthorityStores(await jetstreamManager(writer.nc), new Kvm(writer.nc), account.space);
  const reg = await openLifecycleRegistry(writer.nc, account.space);
  const { authKv } = registryStores(reg);
  const coordinates = (): EnvironmentManagerAdmissionCoordinates => ({
    owner: `u_${"a".repeat(26)}`, instanceId: mintLifecycleUid(), lifecycleUid: mintLifecycleUid(),
    authorityEndpoint: "ai.cotal.environment-authority", authorityInstanceId: mintLifecycleUid(),
    expiresAt: Math.floor(Date.now() / 1000) + 240, environmentId: "a".repeat(64),
    accountPublicKey: account.accountPublicKey, admissionRevision: 1, operationId: mintLifecycleUid(),
  });
  const mintInput = () => ({ publicId: newIdentity().id, credentialId: mintLifecycleUid(),
    expiresAt: Math.floor(Date.now() / 1000) + 120, account: signer });
  const pin = coordinates(), peer = newIdentity(), args = { ...mintInput(), publicId: peer.id };
  await stageEnvironmentManagerAdmission(reg, pin);
  let material: Awaited<ReturnType<typeof mintEnvironmentManagerBootstrap>> | undefined;
  await cell("native staged admission releases a bounded public-nkey bootstrap JWT", async () => {
    material = await mintEnvironmentManagerBootstrap(reg, pin, args);
    assert.equal(material.exp, args.expiresAt);
    const claims = credsClaims(credsFromJwt(material.jwt, peer));
    assert.equal(claims.sub, peer.id);
    assert.equal(claims.exp, material.exp);
    const nc = await connect({ servers: fx.servers, authenticator: jwtAuthenticator(material.jwt, new TextEncoder().encode(peer.seed)),
      inboxPrefix: `_INBOX_${peer.id}`, reconnect: false });
    try {
      await assert.rejects(() => nc.request(`$KV.${epAuthBucket(account.space)}.gate.${pin.lifecycleUid}`, new Uint8Array(), { timeout: 1000 }), /Permissions Violation/);
    } finally { await nc.close(); }
  });
  await cell("foreign data-account signing refuses before any bootstrap reservation", async () => {
    const fresh = coordinates(), other = fx.accounts[1]!, otherPeer = newIdentity();
    const input = { ...mintInput(), publicId: otherPeer.id,
      account: { pub: other.accountPublicKey, signingSeed: other.auth.account.signingSeed! } };
    await stageEnvironmentManagerAdmission(reg, fresh);
    await assert.rejects(async () => {
      const released = await mintEnvironmentManagerBootstrap(reg, fresh, input);
      const nc = await connect({ servers: fx.servers, authenticator: jwtAuthenticator(released.jwt, new TextEncoder().encode(otherPeer.seed)),
        inboxPrefix: `_INBOX_${otherPeer.id}`, reconnect: false });
      try {
        await nc.flush();
        const claims = credsClaims(credsFromJwt(released.jwt, otherPeer));
        assert.equal((claims.nats as { issuer_account?: string }).issuer_account, other.accountPublicKey);
        const ledger = (await authKv.get(`cred.${fresh.lifecycleUid}.${input.credentialId}`))!.json<{ state: string }>();
        assert.equal(ledger.state, "active");
        console.error("FOREIGN_ACCOUNT_ACCEPTED: JWT connects in account B while account A ledger is active");
      } finally { await nc.close(); }
    }, /signing account does not match/);
    assert.equal(await authKv.get(`stage.${fresh.operationId}.environment-bootstrap-mint`), null);
    assert.equal(await authKv.get(`cred.${fresh.lifecycleUid}.${input.credentialId}`), null);
  });
  await cell("a changed account pin and matching foreign signer cannot rebind native admission", async () => {
    const fresh = coordinates(), other = fx.accounts[1]!;
    const input = { ...mintInput(), account: { pub: other.accountPublicKey, signingSeed: other.auth.account.signingSeed! } };
    await stageEnvironmentManagerAdmission(reg, fresh);
    await assert.rejects(() => mintEnvironmentManagerBootstrap(reg, { ...fresh, accountPublicKey: other.accountPublicKey }, input), /staged admission/);
    assert.equal(await authKv.get(`stage.${fresh.operationId}.environment-bootstrap-mint`), null);
    assert.equal(await authKv.get(`cred.${fresh.lifecycleUid}.${input.credentialId}`), null);
  });
  await cell("reconstructed issuer preserves account refusal and the original unreserved attempt", async () => {
    const fresh = coordinates(), other = fx.accounts[1]!;
    await stageEnvironmentManagerAdmission(reg, fresh);
    const input = { ...mintInput(), account: { pub: other.accountPublicKey, signingSeed: other.auth.account.signingSeed! } };
    const again = await openLifecycleRegistry(writer.nc, account.space);
    await assert.rejects(() => mintEnvironmentManagerBootstrap(again, fresh, input), /signing account does not match/);
    assert.equal(await authKv.get(`stage.${fresh.operationId}.environment-bootstrap-mint`), null);
    const positive = await mintEnvironmentManagerBootstrap(again, fresh, { ...input, account: signer });
    assert.equal(positive.credentialId, input.credentialId);
  });
  await cell("an old staged admission without its account pin cannot mint or be rewritten", async () => {
    const fresh = coordinates();
    await stageEnvironmentManagerAdmission(reg, fresh);
    const key = `stage.${fresh.operationId}.environment-manager`, before = (await authKv.get(key))!;
    const legacy = before.json<Record<string, unknown>>(); delete legacy.accountPublicKey;
    await authKv.update(key, JSON.stringify(legacy), before.revision);
    const revision = (await authKv.get(key))!.revision;
    await assert.rejects(() => mintEnvironmentManagerBootstrap(reg, fresh, mintInput()), /staged admission/);
    await assert.rejects(() => stageEnvironmentManagerAdmission(reg, fresh), /foreign content/);
    assert.equal((await authKv.get(key))!.revision, revision);
    assert.equal(await authKv.get(`stage.${fresh.operationId}.environment-bootstrap-mint`), null);
  });
  await cell("bootstrap ledger binds the reserved principal root lineage and actual JWT expiry", async () => {
    const row = (await authKv.get(`cred.${pin.lifecycleUid}.${args.credentialId}`))!.json<Record<string, unknown>>();
    assert.equal(row.holderPrincipal, `${pin.owner}.${environmentBootstrapActor(pin.instanceId)}`);
    assert.equal(row.lifecycleUid, pin.lifecycleUid);
    assert.equal(row.credentialId, args.credentialId);
    assert.equal(row.exp, material?.exp);
    assert.equal(row.state, "active");
    assert.deepEqual(row.sourceChain, ["root"]);
  });
  await cell("bootstrap finalization retains the original frozen registration and family", async () => {
    const gate = await serveIssuanceGateKv(authKv, account.space, { endpoint: "manager", instanceId: pin.instanceId }).observe();
    assert.equal(gate?.state, "frozen");
    assert.equal(gate?.authorityFamily, "environment-manager");
    assert.equal(gate?.revision, material?.gateRevision);
    if (gate?.state !== "frozen") throw new Error("registration is not frozen");
    assert.equal(gate.op.opId, pin.operationId);
  });
  await cell("the one-shot signing reservation retains public evidence but no private seed", async () => {
    const entry = (await authKv.get(`stage.${pin.operationId}.environment-bootstrap-mint`))!;
    assert.ok(entry.string().includes(peer.id));
    assert.ok(entry.string().includes(args.credentialId));
    assert.ok(!entry.string().includes(peer.seed));
    assert.ok(!entry.string().includes(signer.signingSeed));
    assert.deepEqual(Object.keys(entry.json<Record<string, unknown>>()).sort(), ["admissionDigest", "credentialId", "expiresAt", "publicId", "v"]);
  });
  await cell("same-input signing replay stays held without advancing its reservation", async () => {
    const key = `stage.${pin.operationId}.environment-bootstrap-mint`, before = (await authKv.get(key))!;
    await assert.rejects(() => mintEnvironmentManagerBootstrap(reg, pin, args), /already reserved/);
    assert.equal((await authKv.get(key))?.revision, before.revision);
  });
  await cell("changed public keys cannot allocate another bootstrap credential", async () => {
    const changed = mintInput();
    await assert.rejects(() => mintEnvironmentManagerBootstrap(reg, pin, changed), /already reserved/);
    assert.equal(await authKv.get(`cred.${pin.lifecycleUid}.${changed.credentialId}`), null);
  });
  await cell("reconstructed signing cannot release a replacement bootstrap", async () => {
    const reconstructed = await openLifecycleRegistry(writer.nc, account.space);
    await assert.rejects(() => mintEnvironmentManagerBootstrap(reconstructed, pin, args), /already reserved/);
  });
  for (const [name, change] of [
    ["environment", { environmentId: "b".repeat(64) }], ["revision", { admissionRevision: 2 }],
    ["owner", { owner: `u_${"b".repeat(26)}` }], ["lifecycle", { lifecycleUid: mintLifecycleUid() }],
  ] as const) await cell(`changed admission ${name} refuses before signing`, async () => {
    const fresh = coordinates();
    await stageEnvironmentManagerAdmission(reg, fresh);
    await assert.rejects(() => mintEnvironmentManagerBootstrap(reg, { ...fresh, ...change }, mintInput()), /staged admission/);
    assert.equal(await authKv.get(`stage.${fresh.operationId}.environment-bootstrap-mint`), null);
  });
  await cell("an unstaged admission cannot release bootstrap material", async () => {
    const missing = coordinates();
    await assert.rejects(() => mintEnvironmentManagerBootstrap(reg, missing, mintInput()), /no native admission/);
    assert.equal(await authKv.get(`stage.${missing.operationId}.environment-bootstrap-mint`), null);
  });
  for (const name of ["expired", "over five minutes", "over admission"] as const)
    await cell(`${name} bootstrap expiry refuses before reservation`, async () => {
      const fresh = coordinates();
      if (name === "over five minutes") fresh.expiresAt = Math.floor(Date.now() / 1000) + 900;
      await stageEnvironmentManagerAdmission(reg, fresh);
      const now = Math.floor(Date.now() / 1000);
      const expiresAt = name === "expired" ? now : name === "over five minutes" ? now + 600 : fresh.expiresAt + 1;
      await assert.rejects(() => mintEnvironmentManagerBootstrap(reg, fresh, { ...mintInput(), expiresAt }), /expiry are invalid/);
      assert.equal(await authKv.get(`stage.${fresh.operationId}.environment-bootstrap-mint`), null);
    });
  await cell("a credential at its own admission ceiling remains a valid positive control", async () => {
    const fresh = coordinates();
    await stageEnvironmentManagerAdmission(reg, fresh);
    const material = await mintEnvironmentManagerBootstrap(reg, fresh, { ...mintInput(), expiresAt: fresh.expiresAt });
    assert.equal(material.exp, fresh.expiresAt);
  });
  await cell("the issuer's five-minute ceiling remains a same-account positive control", async () => {
    const fresh = { ...coordinates(), expiresAt: Math.floor(Date.now() / 1000) + 900 };
    await stageEnvironmentManagerAdmission(reg, fresh);
    const expiresAt = Math.floor(Date.now() / 1000) + 300;
    const issued = await mintEnvironmentManagerBootstrap(reg, fresh, { ...mintInput(), expiresAt });
    assert.equal(issued.exp, expiresAt);
  });
  await cell("an abort-reopened registration refuses bootstrap before signing", async () => {
    const aborted = coordinates();
    await stageEnvironmentManagerAdmission(reg, aborted);
    const gate = serveIssuanceGateKv(authKv, account.space, { endpoint: "manager", instanceId: aborted.instanceId });
    const frozen = await gate.observe();
    if (frozen?.state !== "frozen") throw new Error("abort has no freeze");
    const barrier = endpointRegistrationBarrier(authKv, account.space, { endpoint: "manager", instanceId: aborted.instanceId, opId: aborted.operationId });
    assert.equal(await barrier.reopen(frozen.revision, { generation: frozen.generation, processEpoch: frozen.processEpoch,
      registrationRevision: frozen.registrationRevision, nameAuthorityRevision: frozen.nameAuthorityRevision }), true);
    await assert.rejects(() => mintEnvironmentManagerBootstrap(reg, aborted, mintInput()), /original frozen/);
    assert.equal(await authKv.get(`stage.${aborted.operationId}.environment-bootstrap-mint`), null);
  });
  await cell("a deleted initial-gate stamp refuses before bootstrap reservation", async () => {
    const damaged = coordinates();
    await stageEnvironmentManagerAdmission(reg, damaged);
    await authKv.delete(`stage.${damaged.operationId}.environment-manager-gate`);
    await assert.rejects(() => mintEnvironmentManagerBootstrap(reg, damaged, mintInput()), /initial-gate stamp/);
    assert.equal(await authKv.get(`stage.${damaged.operationId}.environment-bootstrap-mint`), null);
  });
  await cell("a deleted signing reservation cannot be resurrected", async () => {
    const damaged = coordinates();
    await stageEnvironmentManagerAdmission(reg, damaged);
    const key = `stage.${damaged.operationId}.environment-bootstrap-mint`;
    await authKv.put(key, "{}");
    await authKv.delete(key);
    await assert.rejects(() => mintEnvironmentManagerBootstrap(reg, damaged, mintInput()), /already reserved/);
    assert.equal((await authKv.get(key))?.operation, "DEL");
  });
  await cell("caller-selected profiles refuse before signing or reservation", async () => {
    const fresh = coordinates(), input = { ...mintInput(), profile: "remote-manager" };
    await stageEnvironmentManagerAdmission(reg, fresh);
    await assert.rejects(() => mintEnvironmentManagerBootstrap(reg, fresh, input), /inputs or expiry/);
    assert.equal(await authKv.get(`stage.${fresh.operationId}.environment-bootstrap-mint`), null);
  });
  await cell("concurrent signing attempts release only one recorded bootstrap", async () => {
    const fresh = coordinates();
    await stageEnvironmentManagerAdmission(reg, fresh);
    const requests = [mintInput(), mintInput()];
    const results = await Promise.allSettled(requests.map(input => mintEnvironmentManagerBootstrap(reg, fresh, input)));
    assert.equal(results.filter(result => result.status === "fulfilled").length, 1);
    assert.equal(results.filter(result => result.status === "rejected").length, 1);
    const recorded = (await authKv.get(`stage.${fresh.operationId}.environment-bootstrap-mint`))!.json<{ credentialId: string }>();
    for (const [i, result] of results.entries()) {
      if (result.status === "fulfilled") assert.equal(result.value.credentialId, recorded.credentialId);
      else assert.equal(await authKv.get(`cred.${fresh.lifecycleUid}.${requests[i]!.credentialId}`), null);
    }
  });
  await cell("a lost reservation acknowledgement stays held after reconstruction", async () => {
    const fresh = coordinates(), input = mintInput();
    await stageEnvironmentManagerAdmission(reg, fresh);
    const paused = await openLifecycleRegistry(writer.nc, account.space), stores = registryStores(paused), original = stores.authKv;
    const key = `stage.${fresh.operationId}.environment-bootstrap-mint`;
    stores.authKv = new Proxy(original, { get(target, field) {
      if (field === "put") return async (rowKey: string, value: string | Uint8Array, options?: { previousSeq?: number }) => {
        const revision = await target.put(rowKey, value, options);
        if (rowKey === key) throw new Error("fixture-lost-reservation-acknowledgement");
        return revision;
      };
      const value = Reflect.get(target, field, target);
      return typeof value === "function" ? value.bind(target) : value;
    } });
    try { await assert.rejects(() => mintEnvironmentManagerBootstrap(paused, fresh, input), /outcome is unknown/); }
    finally { stores.authKv = original; }
    assert.equal((await authKv.get(key))?.operation, "PUT");
    const reconstructed = await openLifecycleRegistry(writer.nc, account.space);
    await assert.rejects(() => mintEnvironmentManagerBootstrap(reconstructed, fresh, input), /already reserved/);
    assert.equal(await authKv.get(`cred.${fresh.lifecycleUid}.${input.credentialId}`), null);
  });
  await cell("a second owner and environment get a distinct bootstrap ledger family", async () => {
    const other = { ...coordinates(), owner: `u_${"b".repeat(26)}`, environmentId: "b".repeat(64) }, input = mintInput();
    await stageEnvironmentManagerAdmission(reg, other);
    await mintEnvironmentManagerBootstrap(reg, other, input);
    const row = (await authKv.get(`cred.${other.lifecycleUid}.${input.credentialId}`))!.json<{ holderPrincipal: string }>();
    assert.equal(row.holderPrincipal, `${other.owner}.${environmentBootstrapActor(other.instanceId)}`);
    assert.notEqual(other.lifecycleUid, pin.lifecycleUid);
    assert.notEqual(other.instanceId, pin.instanceId);
  });
  for (const loss of ["registration", "lifecycle"] as const) await cell(`a racing ${loss} fence revokes the staged row and releases nothing`, async () => {
    const racing = coordinates(), inputs = mintInput();
    await stageEnvironmentManagerAdmission(reg, racing);
    const paused = await openLifecycleRegistry(writer.nc, account.space), stores = registryStores(paused), original = stores.authKv;
    const key = epgateKey("manager", racing.instanceId);
    let injected = false;
    stores.authKv = new Proxy(original, { get(target, field) {
      if (field === "update") return async (rowKey: string, value: Uint8Array, revision: number) => {
        if (rowKey === key && !injected) {
          injected = true;
          if (loss === "registration") {
            const row = parseEndpointGate((await authKv.get(key))!.value, key);
            if (row.state !== "frozen") throw new Error("race has no freeze");
            const barrier = endpointRegistrationBarrier(authKv, account.space, { endpoint: "manager", instanceId: racing.instanceId, opId: racing.operationId });
            assert.equal(await barrier.reopen(revision, { generation: row.generation, processEpoch: row.processEpoch,
              registrationRevision: row.registrationRevision, nameAuthorityRevision: row.nameAuthorityRevision }), true);
          } else {
            const lifecycle = (await observeGate(reg, racing.lifecycleUid))!;
            await freezeGate(reg, { lifecycleUid: racing.lifecycleUid, revision: lifecycle.revision,
              op: { kind: "retirement", opId: mintLifecycleUid() } });
          }
        }
        return target.update(rowKey, value, revision);
      };
      const value = Reflect.get(target, field, target);
      return typeof value === "function" ? value.bind(target) : value;
    } });
    try {
      await assert.rejects(() => mintEnvironmentManagerBootstrap(paused, racing, inputs), /fence/);
      assert.equal(injected, true);
      assert.equal((await authKv.get(`cred.${racing.lifecycleUid}.${inputs.credentialId}`))!.json<{ state: string }>().state, "revoked");
    } finally { stores.authKv = original; }
  });
} finally {
  await writer.close();
  await fx.close();
  emitSentinel({ passed, failed });
  process.exitCode = failed === 0 ? 0 : 1;
}
