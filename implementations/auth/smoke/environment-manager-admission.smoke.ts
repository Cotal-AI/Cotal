/** Native pre-issuance reservation, not a hosted admission, credential or agent acceptance. */
import assert from "node:assert/strict";
import { jetstreamManager } from "@nats-io/jetstream";
import { Kvm } from "@nats-io/kv";
import {
  ensureAuthorityStores, endpointRegistrationBarrier, environmentBootstrapActor, epAuthBucket, epgateKey, mintLifecycleUid,
  parseEndpointGate, provisionEndpointGateOpen, remoteManagerActors, serveIssuanceGateKv,
} from "@cotal-ai/core";
import { emitSentinel } from "@cotal-ai/smoke-kit";
import { environmentManagerAdmissionWriterGrants, openAuthorityClient } from "../src/authority-client.js";
import { stageEnvironmentManagerAdmission, type EnvironmentManagerAdmissionCoordinates } from "../src/environment-manager-admission.js";
import { openLifecycleRegistry, registryStores, observeGate, readLifecycleHeadForOperation } from "../src/lifecycle-registry.js";
import { startHostedAuthFixture } from "./_hosted-auth-fixture.js";

const fx = await startHostedAuthFixture("environment-admission", 1);
const account = fx.accounts[0]!;
const writer = await openAuthorityClient({ server: fx.servers, space: account.space,
  dataAccount: { pub: account.accountPublicKey, signingSeed: account.auth.account.signingSeed! },
  label: "environment-admission-reservation", grants: id => environmentManagerAdmissionWriterGrants(account.space, id), log: () => {} });
let passed = 0, failed = 0;
const cell = async (name: string, run: () => Promise<void>) => {
  try { await run(); passed++; console.log(`  ✓ ${name}`); }
  catch (error) { failed++; console.error(`  ✗ ${name}: ${error instanceof Error ? error.message : String(error)}`); }
};
try {
  await ensureAuthorityStores(await jetstreamManager(writer.nc), new Kvm(writer.nc), account.space);
  const reg = await openLifecycleRegistry(writer.nc, account.space);
  const { authKv, recordsKv } = registryStores(reg);
  const coordinates = (): EnvironmentManagerAdmissionCoordinates => ({
    owner: `u_${"a".repeat(26)}`, instanceId: mintLifecycleUid(), lifecycleUid: mintLifecycleUid(),
    authorityEndpoint: "ai.cotal.environment-authority", authorityInstanceId: mintLifecycleUid(),
    expiresAt: Math.floor(Date.now() / 1000) + 300, environmentId: "a".repeat(64),
    admissionRevision: 1, operationId: mintLifecycleUid(),
  });
  const pin = coordinates();
  let result: { gateRevision: number } | undefined;
  await cell("native reservation staging completes", async () => { result = await stageEnvironmentManagerAdmission(reg, pin); });
  const stageKey = `stage.${pin.operationId}.environment-manager`;
  const stage = (await authKv.get(stageKey))!;
  await cell("native activation creates the reserved bootstrap head and open lifecycle gate", async () => {
    const head = await readLifecycleHeadForOperation(reg, pin.owner, environmentBootstrapActor(pin.instanceId));
    assert.equal(head?.mapping.state, "active");
    assert.equal(head?.mapping.lifecycleUid, pin.lifecycleUid);
    assert.equal(head?.mapping.processEpoch, 1);
    assert.equal((await observeGate(reg, pin.lifecycleUid))?.row.state, "open");
  });
  await cell("native manager gate is family-marked and frozen under the host registration operation", async () => {
    const current = await serveIssuanceGateKv(authKv, account.space, { endpoint: "manager", instanceId: pin.instanceId }).observe();
    assert.equal(current?.authorityFamily, "environment-manager");
    assert.equal(current?.state, "frozen");
    if (current?.state !== "frozen") throw new Error("registration gate is not frozen");
    assert.deepEqual(current.op, { kind: "registration", opId: pin.operationId });
    assert.equal(current.revision, result?.gateRevision);
    assert.equal(current.registrationRevision, 0);
    assert.equal(current.principal, `${pin.owner}.${remoteManagerActors(pin.instanceId).serve}`);
  });
  await cell("same-input replay and reconstructed registry preserve both native reservations", async () => {
    const again = await openLifecycleRegistry(writer.nc, account.space);
    assert.deepEqual(await stageEnvironmentManagerAdmission(again, { ...pin }), result);
    assert.equal((await authKv.get(stageKey))?.revision, stage.revision);
    assert.deepEqual((await authKv.get(stageKey))?.value, stage.value);
  });
  for (const [name, change] of [
    ["environment", { environmentId: "b".repeat(64) }], ["admission revision", { admissionRevision: 2 }],
    ["lifecycle", { lifecycleUid: mintLifecycleUid() }], ["owner", { owner: `u_${"b".repeat(26)}` }],
  ] as const) await cell(`changed ${name} cannot rebind a staged operation`, async () => {
    await assert.rejects(() => stageEnvironmentManagerAdmission(reg, { ...pin, ...change }));
    assert.equal((await authKv.get(stageKey))?.revision, stage.revision);
    assert.deepEqual((await authKv.get(stageKey))?.value, stage.value);
  });
  await cell("an ordinary same-owner endpoint reservation refuses before activation or staging", async () => {
    const ordinary = coordinates();
    const key = epgateKey("manager", ordinary.instanceId);
    await provisionEndpointGateOpen(authKv, { endpoint: "manager", instanceId: ordinary.instanceId,
      principal: `${ordinary.owner}.${remoteManagerActors(ordinary.instanceId).serve}` });
    const before = (await authKv.get(key))!;
    await assert.rejects(() => stageEnvironmentManagerAdmission(reg, ordinary), /ordinary or foreign/);
    assert.equal((await authKv.get(key))?.revision, before.revision);
    assert.equal(await observeGate(reg, ordinary.lifecycleUid), undefined);
    assert.equal(await authKv.get(`stage.${ordinary.operationId}.environment-manager`), null);
  });
  await cell("a foreign registration operation refuses without advancing the manager gate", async () => {
    const before = (await authKv.get(epgateKey("manager", pin.instanceId)))!;
    await assert.rejects(() => stageEnvironmentManagerAdmission(reg, { ...pin, operationId: mintLifecycleUid() }), /foreign registration/);
    assert.equal((await authKv.get(epgateKey("manager", pin.instanceId)))?.revision, before.revision);
  });
  for (const generationAdvance of [0, 1]) await cell(`registration abort with generation advance ${generationAdvance} cannot be re-frozen by replay`, async () => {
    const aborted = coordinates();
    await stageEnvironmentManagerAdmission(reg, aborted);
    const gate = serveIssuanceGateKv(authKv, account.space, { endpoint: "manager", instanceId: aborted.instanceId });
    const current = await gate.observe();
    if (current?.state !== "frozen") throw new Error("abort fixture has no registration freeze");
    const barrier = endpointRegistrationBarrier(authKv, account.space, { endpoint: "manager", instanceId: aborted.instanceId, opId: aborted.operationId });
    assert.equal(await barrier.reopen(current.revision, { generation: current.generation + generationAdvance,
      processEpoch: current.processEpoch, registrationRevision: current.registrationRevision,
      nameAuthorityRevision: current.nameAuthorityRevision }), true);
    const opened = await gate.observe();
    assert.equal(opened?.state, "open");
    await assert.rejects(() => stageEnvironmentManagerAdmission(reg, aborted));
    assert.deepEqual(await gate.observe(), opened);
  });
  await cell("an absent-stamp race cannot replace the original fence after abort", async () => {
    const racing = coordinates(), birthKey = `stage.${racing.operationId}.environment-manager-gate`;
    const paused = await openLifecycleRegistry(writer.nc, account.space);
    const concurrent = await openLifecycleRegistry(writer.nc, account.space);
    const stores = registryStores(paused), original = stores.authKv;
    const gate = serveIssuanceGateKv(authKv, account.space, { endpoint: "manager", instanceId: racing.instanceId });
    let injected = false, birthRevision: number | undefined, opened: Awaited<ReturnType<typeof gate.observe>> | undefined;
    stores.authKv = new Proxy(original, { get(target, field) {
      if (field === "get") return async (key: string) => {
        const before = await target.get(key);
        if (key === birthKey && !before && !injected) {
          injected = true;
          await stageEnvironmentManagerAdmission(concurrent, racing);
          birthRevision = (await authKv.get(birthKey))!.revision;
          const frozen = await gate.observe();
          if (frozen?.state !== "frozen") throw new Error("race fixture has no registration freeze");
          const barrier = endpointRegistrationBarrier(authKv, account.space, { endpoint: "manager", instanceId: racing.instanceId, opId: racing.operationId });
          assert.equal(await barrier.reopen(frozen.revision, { generation: frozen.generation, processEpoch: frozen.processEpoch,
            registrationRevision: frozen.registrationRevision, nameAuthorityRevision: frozen.nameAuthorityRevision }), true);
          opened = await gate.observe();
        }
        return before;
      };
      const value = Reflect.get(target, field, target);
      return typeof value === "function" ? value.bind(target) : value;
    } });
    try {
      await assert.rejects(() => stageEnvironmentManagerAdmission(paused, racing), /registration was aborted/);
      assert.equal(injected, true);
      assert.equal(opened?.state, "open");
      assert.deepEqual(await gate.observe(), opened);
      assert.equal((await authKv.get(birthKey))?.revision, birthRevision);
    } finally { stores.authKv = original; }
  });
  await cell("a deleted initial-gate stamp cannot authorize reservation replay", async () => {
    const damaged = coordinates();
    await stageEnvironmentManagerAdmission(reg, damaged);
    const key = `stage.${damaged.operationId}.environment-manager-gate`;
    await authKv.delete(key);
    await assert.rejects(() => stageEnvironmentManagerAdmission(reg, damaged), /absent or deleted/);
    assert.equal((await authKv.get(key))?.operation, "DEL");
  });
  await cell("a foreign initial-gate stamp cannot authorize reservation replay", async () => {
    const damaged = coordinates();
    await stageEnvironmentManagerAdmission(reg, damaged);
    const key = `stage.${damaged.operationId}.environment-manager-gate`;
    const entry = (await authKv.get(key))!;
    await authKv.put(key, JSON.stringify({ ...entry.json<Record<string, unknown>>(), principal: `${damaged.owner}.foreign` }));
    await assert.rejects(() => stageEnvironmentManagerAdmission(reg, damaged), /foreign coordinates/);
  });
  await cell("expired admission refuses before any lifecycle or endpoint effect", async () => {
    const expired = { ...coordinates(), expiresAt: Math.floor(Date.now() / 1000) };
    await assert.rejects(() => stageEnvironmentManagerAdmission(reg, expired), /invalid or expired/);
    assert.equal(await observeGate(reg, expired.lifecycleUid), undefined);
    assert.equal(await authKv.get(epgateKey("manager", expired.instanceId)), null);
  });
  await cell("a stage deletion marker is corruption, not a reusable operation", async () => {
    const broken = coordinates();
    const key = `stage.${broken.operationId}.environment-manager`;
    await authKv.put(key, new TextEncoder().encode("{}"));
    await authKv.delete(key);
    await assert.rejects(() => stageEnvironmentManagerAdmission(reg, broken), /deletion marker/);
    assert.equal((await authKv.get(key))?.operation, "DEL");
    assert.equal(await observeGate(reg, broken.lifecycleUid), undefined);
  });
  await cell("concurrent same-input reservations converge on one native registration freeze", async () => {
    const concurrent = coordinates();
    const [first, second] = await Promise.all([
      stageEnvironmentManagerAdmission(reg, concurrent), stageEnvironmentManagerAdmission(reg, concurrent),
    ]);
    assert.deepEqual(first, second);
    assert.equal((await readLifecycleHeadForOperation(reg, concurrent.owner, environmentBootstrapActor(concurrent.instanceId)))?.mapping.lifecycleUid, concurrent.lifecycleUid);
  });
  await cell("a second owner and environment receive distinct native reservations", async () => {
    const other = { ...coordinates(), owner: `u_${"b".repeat(26)}`, environmentId: "b".repeat(64) };
    await stageEnvironmentManagerAdmission(reg, other);
    const head = await readLifecycleHeadForOperation(reg, other.owner, environmentBootstrapActor(other.instanceId));
    assert.equal(head?.mapping.lifecycleUid, other.lifecycleUid);
    assert.notEqual(head?.mapping.lifecycleUid, pin.lifecycleUid);
    assert.equal((await observeGate(reg, pin.lifecycleUid))?.row.state, "open");
  });
  await cell("a completed registration fixture is not reopened by reservation replay", async () => {
    const key = epgateKey("manager", pin.instanceId);
    const before = (await authKv.get(key))!;
    const row = parseEndpointGate(before.value, key);
    if (row.state !== "frozen") throw new Error("fixture gate is not frozen");
    const { op: _op, ...rest } = row;
    const completed = { ...rest, state: "open", registrationRevision: 1 };
    await authKv.update(key, new TextEncoder().encode(JSON.stringify(completed)), before.revision);
    await assert.rejects(() => stageEnvironmentManagerAdmission(reg, pin), /completed or foreign/);
    assert.equal(parseEndpointGate((await authKv.get(key))!.value, key).registrationRevision, 1);
  });
  await cell("the scoped writer has no session staging or single-segment operation intent grant", async () => {
    const grants = environmentManagerAdmissionWriterGrants(account.space, "native-reservation-control");
    assert.ok(grants.publish.includes(`$KV.${epAuthBucket(account.space)}.stage.*.environment-manager`));
    assert.ok(!grants.publish.some(row => row.includes("stage.session") || row.endsWith(".stage.*") || row.endsWith(".stage.*.>")));
    assert.equal(await recordsKv.get(`uid.${pin.lifecycleUid}`) !== null, true);
  });
} finally {
  await writer.close();
  await fx.close();
  emitSentinel({ passed, failed });
  process.exitCode = failed === 0 ? 0 : 1;
}
