/** Native pending-bootstrap retirement only, not external admission or hosted execution. */
import assert from "node:assert/strict";
import { connect, credsAuthenticator } from "@nats-io/transport-node";
import {
  credsFromJwt, environmentBootstrapActor, epcredRowKey, epgateKey,
  evictDeniedPrincipalWithCreds, mintConnectionEvictorCreds, mintCreds, mintLifecycleUid,
  mintMembershipObserverCreds, newIdentity, parseEndpointGate, parseLedgerRow, remoteManagerActors,
  setupSpaceStreams,
} from "@cotal-ai/core";
import { emitSentinel } from "@cotal-ai/smoke-kit";
import { authorityBarrierGrants, environmentManagerAdmissionWriterGrants, openAuthorityClient, registrationExecutorGrants } from "../src/authority-client.js";
import { stageEnvironmentManagerAdmission, type EnvironmentManagerAdmissionCoordinates } from "../src/environment-manager-admission.js";
import { mintEnvironmentManagerBootstrap } from "../src/environment-manager-bootstrap-mint.js";
import { retirePendingEnvironmentManager as retire } from "../src/environment-manager-pending-retirement.js";
import { openLifecycleRegistry, observeGate, readLifecycleHeadForOperation, registryStores } from "../src/lifecycle-registry.js";
import { credRowKey, stageAgentMint } from "../src/credential-ledger.js";
import type { RetirementDeps } from "../src/retirement-barrier.js";
import { authorityScannerGrants, makeLedgerScannerOverConnection } from "../src/ledger-scanner.js";
import { recordsScannerGrants, makeRecordsScannerOverConnection } from "../src/records-scanner.js";
import { startHostedAuthFixture } from "./_hosted-auth-fixture.js";

const fx = await startHostedAuthFixture("pending-environment-retirement", 1);
const account = fx.accounts[0]!;
const clients: Array<{ close(): Promise<void> }> = [];
let passed = 0, failed = 0;
const cell = async (name: string, run: () => Promise<void>) => {
  try { await run(); passed++; console.log(`  ✓ ${name}`); }
  catch (error) { failed++; console.error(`  ✗ ${name}: ${error instanceof Error ? error.message : String(error)}`); }
};
const pinOf = (): EnvironmentManagerAdmissionCoordinates => ({
  owner: `u_${"a".repeat(26)}`, instanceId: mintLifecycleUid(), lifecycleUid: mintLifecycleUid(),
  authorityEndpoint: "test.example.environment", authorityInstanceId: mintLifecycleUid(),
  expiresAt: Math.floor(Date.now() / 1000) + 300, environmentId: "a".repeat(64), accountPublicKey: account.accountPublicKey,
  admissionRevision: 1, operationId: mintLifecycleUid(),
});
try {
  await setupSpaceStreams({ servers: fx.servers, space: account.space, creds: await mintCreds(account.auth, newIdentity(), "provisioner") });
  // Fixture-only branded factories run over separately scoped native scanner connections.
  // This does not assert a production plane claim or activate a hosted authority service.
  const scannerClient = async (label: string, grants: typeof authorityScannerGrants) => {
    const client = await openAuthorityClient({ server: fx.servers, space: account.space,
      dataAccount: { pub: account.accountPublicKey, signingSeed: account.auth.account.signingSeed! }, label,
      grants: id => grants(account.space, id), log: () => {} });
    clients.push(client); return client;
  };
  const ledgerScanner = makeLedgerScannerOverConnection((await scannerClient("pending-fixture-ledger", authorityScannerGrants)).nc, account.space);
  const recordsScanner = makeRecordsScannerOverConnection((await scannerClient("pending-fixture-records", recordsScannerGrants)).nc, account.space);
  const observerCreds = await mintMembershipObserverCreds(account.auth, newIdentity());
  const evictorCreds = await mintConnectionEvictorCreds(account.auth, newIdentity());
  const fresh = async (pin = pinOf()) => {
    // Test host only: compose the existing issuance, native retirement and this exact endpoint's
    // registration authority. No production grant or guest profile changes in this increment.
    const writer = await openAuthorityClient({ server: fx.servers, space: account.space,
      dataAccount: { pub: account.accountPublicKey, signingSeed: account.auth.account.signingSeed! },
      label: "pending-environment-native-host", grants: id => {
        const rows = [environmentManagerAdmissionWriterGrants(account.space, id), authorityBarrierGrants(account.space, id),
          registrationExecutorGrants(account.space, id, "manager", pin.instanceId)];
        return { publish: [...new Set(rows.flatMap(row => row.publish))], subscribe: [...new Set(rows.flatMap(row => row.subscribe))] };
      }, log: () => {} });
    clients.push(writer);
    const reg = await openLifecycleRegistry(writer.nc, account.space, ledgerScanner, recordsScanner);
    await stageEnvironmentManagerAdmission(reg, pin);
    const stores = registryStores(reg);
    const bootstrap = `${pin.owner}.${environmentBootstrapActor(pin.instanceId)}`;
    const serve = `${pin.owner}.${remoteManagerActors(pin.instanceId).serve}`;
    const deps: RetirementDeps = {
      evictPrincipal: principal => evictDeniedPrincipalWithCreds({ servers: fx.servers, observerCreds, evictorCreds,
        accountId: account.accountPublicKey, principal, options: { maxWaitMs: 1500, settleMs: 20, maxVerifyRounds: 3 } }),
      drainTargetObligations: async () => { throw new Error("unexpected pending-bootstrap work obligation"); },
      openCleaner: async () => { throw new Error("unexpected pending-bootstrap cleaner"); },
      retireCleanerCredential: async () => { throw new Error("unexpected pending-bootstrap cleaner credential"); },
      openExecutor: async () => { throw new Error("unexpected pending-bootstrap settlement executor"); },
      retireExecutorCredential: async () => { throw new Error("unexpected pending-bootstrap settlement credential"); },
      now: Date.now,
    };
    return { pin, writer, reg, stores, bootstrap, serve, deps };
  };
  const frozen = async (s: Awaited<ReturnType<typeof fresh>>) => parseEndpointGate((await s.stores.authKv.get(epgateKey("manager", s.pin.instanceId)))!.value, epgateKey("manager", s.pin.instanceId));
  const seedEndpointRow = async (s: Awaited<ReturnType<typeof fresh>>) => {
    const id = mintLifecycleUid(), key = epcredRowKey("manager", s.pin.instanceId, id);
    const row = { credentialId: id, holderPrincipal: s.serve, lifecycleUid: s.pin.instanceId, endpoint: "manager", sourceChain: ["root"], state: "active", exp: s.pin.expiresAt };
    const bytes = new TextEncoder().encode(JSON.stringify(row));
    parseLedgerRow(bytes, key);
    await s.stores.authKv.put(key, bytes, { previousSeq: 0 });
    return key;
  };
  const s = await fresh();
  const peer = newIdentity(), credentialId = mintLifecycleUid();
  const minted = await mintEnvironmentManagerBootstrap(s.reg, s.pin, { publicId: peer.id, credentialId,
    expiresAt: Math.floor(Date.now() / 1000) + 240, account: { pub: account.accountPublicKey, signingSeed: account.auth.account.signingSeed! } });
  const live = await connect({ servers: fx.servers, authenticator: credsAuthenticator(new TextEncoder().encode(
    credsFromJwt(minted.jwt, peer))), inboxPrefix: `_INBOX_${peer.id}`, reconnect: false });
  clients.push(live);
  await live.flush();
  await cell("native issued bootstrap connection is live before retirement", async () => { assert.equal(live.isClosed(), false); });
  const endpointKey = await seedEndpointRow(s);
  const heldEndpoint = async (owner: string) => {
    const client = await openAuthorityClient({ server: fx.servers, space: account.space,
      dataAccount: { pub: account.accountPublicKey, signingSeed: account.auth.account.signingSeed! },
      principal: { owner, actor: remoteManagerActors(s.pin.instanceId).serve }, label: "pending-endpoint-fixture-holder", noReconnect: true,
      grants: id => ({ publish: [], subscribe: [`_INBOX_${id}.>`] }), log: () => {} });
    clients.push(client); await client.nc.flush(); return client.nc;
  };
  const serveHolder = await heldEndpoint(s.pin.owner), foreignHolder = await heldEndpoint(`u_${"b".repeat(26)}`);
  assert.equal(serveHolder.isClosed(), false); assert.equal(foreignHolder.isClosed(), false);
  let result: Awaited<ReturnType<typeof retire>> | undefined;
  await cell("native lifecycle retirement precedes endpoint abort", async () => {
    const original = s.deps.evictPrincipal;
    result = await retire(s.reg, s.pin, { ...s.deps, evictPrincipal: async principal => {
      if (principal === s.bootstrap) assert.equal((await observeGate(s.reg, s.pin.lifecycleUid))?.row.state, "frozen");
      if (principal === s.serve) {
        assert.equal((await observeGate(s.reg, s.pin.lifecycleUid))?.row.state, "retired");
        assert.equal((await frozen(s)).state, "frozen");
      }
      return original(principal);
    } });
    assert.deepEqual(result, { lifecycleUid: s.pin.lifecycleUid, operationId: s.pin.operationId });
  });
  await cell("native bootstrap holder is evicted rather than only ledger-revoked", async () => {
    await Promise.race([live.closed(), new Promise((_, reject) => setTimeout(() => reject(new Error("native bootstrap connection survived")), 2000))]);
    assert.equal(live.isClosed(), true);
  });
  await cell("native pending endpoint holder is evicted while another owner remains live", async () => {
    await Promise.race([serveHolder.closed(), new Promise((_, reject) => setTimeout(() => reject(new Error("pending endpoint holder survived")), 2000))]);
    assert.equal(serveHolder.isClosed(), true); await foreignHolder.flush(); assert.equal(foreignHolder.isClosed(), false);
  });
  await cell("native original lifecycle and alias are terminal", async () => {
    assert.equal((await observeGate(s.reg, s.pin.lifecycleUid))?.row.state, "retired");
    assert.equal((await readLifecycleHeadForOperation(s.reg, s.pin.owner, environmentBootstrapActor(s.pin.instanceId)))?.mapping.state, "retired");
    assert.equal(parseLedgerRow((await s.stores.authKv.get(credRowKey(s.pin.lifecycleUid, credentialId)))!.value, credRowKey(s.pin.lifecycleUid, credentialId)).state, "revoked");
  });
  await cell("pending endpoint family is revoked and original registration is aborted", async () => {
    assert.equal(parseLedgerRow((await s.stores.authKv.get(endpointKey))!.value, endpointKey).state, "revoked");
    const gate = await frozen(s); assert.equal(gate.state, "open"); assert.equal(gate.registrationRevision, 0); assert.equal(gate.authorityFamily, "environment-manager");
  });
  await cell("reconstructed same-operation cleanup preserves original identity", async () => {
    assert.deepEqual(await retire(await openLifecycleRegistry(s.writer.nc, account.space, ledgerScanner, recordsScanner), s.pin, s.deps), result);
    await assert.rejects(() => stageEnvironmentManagerAdmission(s.reg, s.pin));
    await assert.rejects(() => stageAgentMint(s.reg, { lifecycleUid: s.pin.lifecycleUid, credentialId: mintLifecycleUid(), holderPrincipal: s.bootstrap, sourceChain: ["root"], exp: s.pin.expiresAt }));
  });
  for (const field of ["environmentId", "admissionRevision", "expiresAt"] as const) await cell(`changed ${field} refuses before native movement`, async () => {
    const a = await fresh(); const before = await frozen(a);
    await assert.rejects(() => retire(a.reg, { ...a.pin, [field]: field === "environmentId" ? "b".repeat(64) : a.pin[field] as number + 1 }, a.deps));
    assert.deepEqual(await frozen(a), before); assert.equal((await observeGate(a.reg, a.pin.lifecycleUid))?.row.state, "open");
  });
  await cell("unknown selectors and replacement operation refuse without retirement", async () => {
    const a = await fresh();
    await assert.rejects(() => retire(a.reg, { ...a.pin, profile: "remote-manager" } as EnvironmentManagerAdmissionCoordinates, a.deps));
    await assert.rejects(() => retire(a.reg, { ...a.pin, operationId: mintLifecycleUid() }, a.deps));
    assert.equal((await observeGate(a.reg, a.pin.lifecycleUid))?.row.state, "open");
  });
  await cell("missing native policy refuses before any fence", async () => {
    const a = await fresh(); await assert.rejects(() => retire(a.reg, a.pin, { ...a.deps, evictPrincipal: undefined } as unknown as RetirementDeps));
    assert.equal((await observeGate(a.reg, a.pin.lifecycleUid))?.row.state, "open"); assert.equal((await frozen(a)).state, "frozen");
  });
  for (const kind of ["ordinary", "completed", "foreign-op"] as const) await cell(`${kind} registration is not cleanup authority`, async () => {
    const a = await fresh(), key = epgateKey("manager", a.pin.instanceId), entry = (await a.stores.authKv.get(key))!;
    const row = parseEndpointGate(entry.value, key);
    const changed = kind === "ordinary" ? { ...row, authorityFamily: undefined } : kind === "completed" ? { ...row, registrationRevision: 1 } : { ...row, op: { kind: "registration", opId: mintLifecycleUid() } };
    await a.stores.authKv.update(key, new TextEncoder().encode(JSON.stringify(changed)), entry.revision);
    await assert.rejects(() => retire(a.reg, a.pin, a.deps));
    assert.equal((await observeGate(a.reg, a.pin.lifecycleUid))?.row.state, "open");
  });
  await cell("deleted admission staging remains corruption not a new operation", async () => {
    const a = await fresh(); await a.stores.authKv.delete(`stage.${a.pin.operationId}.environment-manager`);
    await assert.rejects(() => retire(a.reg, a.pin, a.deps)); assert.equal((await observeGate(a.reg, a.pin.lifecycleUid))?.row.state, "open");
  });
  await cell("invalid initial gate stamp refuses before native retirement", async () => {
    const a = await fresh(), key = `stage.${a.pin.operationId}.environment-manager-gate`;
    const entry = (await a.stores.authKv.get(key))!;
    await a.stores.authKv.update(key, new TextEncoder().encode(JSON.stringify({ ...entry.json<object>(), openRevision: 0 })), entry.revision);
    await assert.rejects(() => retire(a.reg, a.pin, a.deps)); assert.equal((await observeGate(a.reg, a.pin.lifecycleUid))?.row.state, "open");
  });
  await cell("lifecycle eviction failure leaves registration frozen for reconstruction", async () => {
    const a = await fresh();
    await assert.rejects(() => retire(a.reg, a.pin, { ...a.deps, evictPrincipal: async principal => ({ ...await a.deps.evictPrincipal(principal), verifiedGone: false }) }));
    assert.equal((await observeGate(a.reg, a.pin.lifecycleUid))?.row.state, "frozen"); assert.equal((await frozen(a)).state, "frozen");
    await retire(await openLifecycleRegistry(a.writer.nc, account.space, ledgerScanner, recordsScanner), a.pin, a.deps); assert.equal((await frozen(a)).state, "open");
  });
  await cell("unverified endpoint eviction prevents abort and completed result", async () => {
    const a = await fresh();
    await assert.rejects(() => retire(a.reg, a.pin, { ...a.deps, evictPrincipal: async principal => {
      const observed = await a.deps.evictPrincipal(principal); return principal === a.serve ? { ...observed, verifiedGone: false } : observed;
    } }));
    assert.equal((await observeGate(a.reg, a.pin.lifecycleUid))?.row.state, "retired"); assert.equal((await frozen(a)).state, "frozen");
    await retire(a.reg, a.pin, a.deps); assert.equal((await frozen(a)).state, "open");
  });
  await cell("lost endpoint abort CAS cannot return completed cleanup", async () => {
    const a = await fresh(), original = a.stores.authKv, key = epgateKey("manager", a.pin.instanceId);
    let raced = false;
    a.stores.authKv = new Proxy(original, { get(target, field) {
      if (field === "update") return async (at: string, value: Uint8Array, revision: number) => {
        if (at === key && JSON.parse(new TextDecoder().decode(value)).state === "open" && !raced) {
          raced = true; const current = (await target.get(at))!; await target.update(at, current.value, current.revision);
        }
        return target.update(at, value, revision);
      };
      const value = Reflect.get(target, field, target); return typeof value === "function" ? value.bind(target) : value;
    } });
    try { await assert.rejects(() => retire(a.reg, a.pin, a.deps), /abort fence/); assert.equal(raced, true); assert.equal((await frozen(a)).state, "frozen"); }
    finally { a.stores.authKv = original; }
    await retire(a.reg, a.pin, a.deps); assert.equal((await frozen(a)).state, "open");
  });
  await cell("a paused native bootstrap mint loses after cleanup retires its lifecycle", async () => {
    const a = await fresh(), original = a.stores.authKv, key = epgateKey("manager", a.pin.instanceId);
    const concurrent = await openLifecycleRegistry(a.writer.nc, account.space, ledgerScanner, recordsScanner);
    const candidate = newIdentity(), id = mintLifecycleUid(); let raced = false;
    a.stores.authKv = new Proxy(original, { get(target, field) {
      if (field === "update") return async (at: string, value: Uint8Array, revision: number) => {
        if (at === key && !raced) { raced = true; await retire(concurrent, a.pin, a.deps); }
        return target.update(at, value, revision);
      };
      const value = Reflect.get(target, field, target); return typeof value === "function" ? value.bind(target) : value;
    } });
    try {
      await assert.rejects(() => mintEnvironmentManagerBootstrap(a.reg, a.pin, { publicId: candidate.id, credentialId: id,
        expiresAt: Math.floor(Date.now() / 1000) + 120, account: { pub: account.accountPublicKey, signingSeed: account.auth.account.signingSeed! } }), /registration fence/);
      assert.equal(raced, true); assert.equal((await observeGate(a.reg, a.pin.lifecycleUid))?.row.state, "retired");
      assert.equal(parseLedgerRow((await original.get(credRowKey(a.pin.lifecycleUid, id)))!.value, credRowKey(a.pin.lifecycleUid, id)).state, "revoked");
    } finally { a.stores.authKv = original; }
  });
  await cell("late bootstrap issuance cannot release material before registration abort", async () => {
    const a = await fresh(); let attempted = false;
    await retire(a.reg, a.pin, { ...a.deps, evictPrincipal: async principal => {
      if (principal === a.serve) {
        attempted = true;
        assert.equal((await frozen(a)).state, "frozen");
        await assert.rejects(() => mintEnvironmentManagerBootstrap(a.reg, a.pin, { publicId: newIdentity().id, credentialId: mintLifecycleUid(),
          expiresAt: Math.floor(Date.now() / 1000) + 120, account: { pub: account.accountPublicKey, signingSeed: account.auth.account.signingSeed! } }));
      }
      return a.deps.evictPrincipal(principal);
    } });
    assert.equal(attempted, true); assert.equal((await frozen(a)).state, "open");
  });
  await cell("expired original admission still permits terminal cleanup", async () => {
    const pin = { ...pinOf(), expiresAt: Math.floor(Date.now() / 1000) + 2 }, a = await fresh(pin);
    await new Promise(resolve => setTimeout(resolve, 2100));
    assert.ok(pin.expiresAt <= Math.floor(Date.now() / 1000));
    await retire(a.reg, pin, a.deps); assert.equal((await observeGate(a.reg, pin.lifecycleUid))?.row.state, "retired");
  });
} finally {
  for (const client of clients.reverse()) await client.close();
  await fx.close();
}
console.log(`pending environment retirement: ${passed} passed, ${failed} failed`);
emitSentinel({ passed, failed });
if (failed) process.exitCode = 1;
