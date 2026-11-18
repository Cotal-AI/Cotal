import { createHmac } from "node:crypto";
import assert from "node:assert/strict";
import { setTimeout as wait } from "node:timers/promises";
import { Kvm } from "@nats-io/kv";
import { jetstreamManager } from "@nats-io/jetstream";
import { connect } from "@nats-io/transport-node";
import { emitSentinel } from "@cotal-ai/smoke-kit";
import { EP_AUTH_MARKER_TTL_MS, epAuthBucket, sessionsBucket, sessionLedgerKey, mintSessionId, mintLifecycleUid, mintCreds, newIdentity, setupSpaceStreams, standaloneConnectOpts } from "@cotal-ai/core";
import { recordSessionConnection, reconcileSessionConnections } from "../src/session-connections.js";
import { openAuthorityClient } from "../src/authority-client.js";
import { makeDeliveryAdminEvictor } from "../src/barrier-evict.js";
import { startAuthService } from "../src/service.js";
import { startHostedAuthFixture } from "./_hosted-auth-fixture.js";
import { startDeliveryService } from "../../delivery/src/index.js";
import { connectionEvictorCredsKey, deliveryCredsKey, membershipObserverCredsKey, membershipRwCredsKey } from "@cotal-ai/workspace";
import * as core from "@cotal-ai/core";
import type { NativeIssuance } from "../src/native-issuance.js";

let passed = 0, failed = 0;
const check = (name: string, ok: boolean) => { if (ok) { passed++; console.log(`PASS ${name}`); } else { failed++; console.error(`FAIL ${name}`); } };
const fx = await startHostedAuthFixture("sessionguards", 1), a = fx.accounts[0]!;
const dataAccount = { pub: a.auth.account.pub, signingSeed: a.auth.account.signingSeed! };
const admin = await openAuthorityClient({ server: fx.servers, space: a.space, dataAccount, label: `guards:${a.space}`,
  grants: (id) => ({ publish: [">"], subscribe: [`_INBOX_${id}.>`] }), log: () => {} });
let delivery: Awaited<ReturnType<typeof startDeliveryService>> | undefined;
const sockets: Awaited<ReturnType<typeof connect>>[] = [];
try {
  await setupSpaceStreams({ space: a.space, servers: fx.servers, creds: await mintCreds(a.auth, newIdentity(), "provisioner") });
  const composition = { injected: true as const };
  await a.store.put(deliveryCredsKey(a.space, composition), await mintCreds(a.auth, newIdentity(), "delivery"));
  await a.store.put(membershipRwCredsKey(a.space, composition), await mintCreds(a.auth, newIdentity(), "membership-rw"));
  await a.store.put(membershipObserverCredsKey(a.space, composition), await core.mintMembershipObserverCreds(a.auth, newIdentity()));
  await a.store.put(connectionEvictorCredsKey(a.space, composition), await core.mintConnectionEvictorCreds(a.auth, newIdentity()));
  delivery = await startDeliveryService({ context: { accountPublicKey: a.accountPublicKey, lifecycleUid: mintLifecycleUid() }, space: a.space, servers: fx.servers, stateDir: a.stateDir, store: a.store, storeIdentity: a.store.identity });
  const kv = await new Kvm(admin.nc).open(epAuthBucket(a.space));
  const sessions = await new Kvm(admin.nc).open(sessionsBucket(a.space));
  const jsm = await jetstreamManager(admin.nc);
  const authority = { jsm, space: a.space, secret: dataAccount.signingSeed };
  const evict = makeDeliveryAdminEvictor({ server: fx.servers, space: a.space, dataAccount, log: () => {} });
  const logs: string[] = [];
  const sweep = (overrides: Partial<Parameters<typeof reconcileSessionConnections>[0]> = {}) => reconcileSessionConnections({ ...authority, kv, seq: 1, maxRows: 256, releaseWindowMs: -1, signal: new AbortController().signal, evict, log: (s) => logs.push(s), ...overrides });
  const session = async () => {
    const identity = newIdentity(), sessionId = mintSessionId(), uid = mintLifecycleUid();
    const owner = core.DEV_OWNER, actor = `fixture_${passed}_${sockets.length}`;
    const principal = `${owner}.${actor}`;
    const nc = await connect({ servers: fx.servers, ...standaloneConnectOpts({ creds: await mintCreds(a.auth, identity, "agent", { principal: { owner, actor }, lifecycleUid: uid }), tls: false }), reconnect: false });
    sockets.push(nc);
    const row = { sessionId, holder: { principal, lifecycleUid: uid }, state: "active", exp: Date.now() + 60_000 };
    await sessions.create(sessionLedgerKey(sessionId), JSON.stringify(row));
    const issuance = { userNkey: identity.id, token: { owner, act: { actor, lifecycleUid: uid, view: "session-caller", session: { sessionId } } }, connection: { serverId: nc.info!.server_id!, cid: nc.info!.client_id! } } as NativeIssuance;
    return { nc, row, issuance, key: `sessionconn.${identity.id}`, end: async () => { await sessions.put(sessionLedgerKey(sessionId), JSON.stringify({ ...row, state: "closed" })); } };
  };
  const victim = await session();
  await victim.nc.flush();
  check("G1 live victim answers broker PING before forged evidence", !victim.nc.isClosed());
  const forgedVictimKey = `sessionconn.${newIdentity().id}`;
  await kv.create(forgedVictimKey, JSON.stringify({ sessionId: mintSessionId(), principal: victim.row.holder.principal, lifecycleUid: victim.row.holder.lifecycleUid, connection: victim.issuance.connection, releaseAfter: Date.now() }));
  await sweep();
  try { await victim.nc.flush(); } catch { /* The named cell reports an evicted victim. */ }
  check("G2 a row naming another principal's connection evicts nothing", !victim.nc.isClosed());
  await kv.purge(forgedVictimKey);
  const absent = await session();
  await sessions.purge(sessionLedgerKey(absent.row.sessionId));
  absent.issuance.token.act.session!.sessionId = mintSessionId();
  let missingRefused = false;
  try { await recordSessionConnection(kv, absent.issuance, authority); } catch { missingRefused = true; }
  check("G3 a never-observed missing session cannot obtain eviction evidence", missingRefused && (await kv.get(absent.key)) === null && !absent.nc.isClosed());
  await kv.purge(absent.key);
  const real = await session();
  await recordSessionConnection(kv, real.issuance, authority);
  const signed = (await kv.get(real.key))!.json<any>();
  check("G4 honest receipt authenticates a real session revision", signed.v === 1 && typeof signed.mac === "string" && signed.row?.sessionRevision > 0);
  const forgedKey = `sessionconn.${newIdentity().id}`;
  await kv.create(forgedKey, JSON.stringify({ ...signed, row: { ...signed.row, principal: victim.row.holder.principal, connection: victim.issuance.connection } }));
  const malformedKey = `sessionconn.${newIdentity().id}`, invalidIdKey = `sessionconn.${newIdentity().id}`;
  await kv.create(malformedKey, "not-json");
  await kv.create(invalidIdKey, JSON.stringify({ ...signed, row: { ...signed.row, sessionId: "invalid.id" } }));
  await real.end();
  let poisoned = false;
  try { await sweep(); } catch { poisoned = true; }
  await wait(100);
  check("G5 malformed and tampered rows do not block the honest ended connection", !poisoned && real.nc.isClosed() && !victim.nc.isClosed());
  for (const key of [forgedKey, malformedKey, invalidIdKey]) if ((await kv.get(key))?.operation === "PUT") await kv.purge(key);
  const count = logs.length;
  await sweep();
  check("G6 quarantined records log once and do not repeat", count >= 3 && logs.length === count);
  const marker = await kv.get(real.key);
  check("G7 verified eviction leaves a bounded purge marker", marker?.operation === "PURGE");
  const purgeMessage = await jsm.streams.getMessage(`KV_${epAuthBucket(a.space)}`, { last_by_subj: `$KV.${epAuthBucket(a.space)}.${real.key}` });
  check("G8 marker TTL is the established auth marker retention", purgeMessage?.header?.get("Nats-TTL") === `${EP_AUTH_MARKER_TTL_MS / 1000}s`);
  const retry = await session();
  await recordSessionConnection(kv, retry.issuance, authority); await retry.end();
  let transient = 0;
  try { await sweep({ evict: async (principal) => ({ principal, kicked: 0, remaining: 1, verifiedGone: false, scanComplete: false, note: "fixture transient" }), transient: () => transient++ }); } catch { transient++; }
  check("G9 failed eviction retains evidence and live socket", (await kv.get(retry.key))?.operation === "PUT" && !retry.nc.isClosed() && transient > 0);
  await sweep(); await wait(100);
  check("G10 retry after failed eviction closes the honest socket", retry.nc.isClosed());
  const missing = await session();
  await recordSessionConnection(kv, missing.issuance, authority);
  await jsm.streams.purge(`KV_${sessionsBucket(a.space)}`, { filter: `$KV.${sessionsBucket(a.space)}.${sessionLedgerKey(missing.row.sessionId)}` });
  await sweep(); await wait(100);
  check("G11 a missing session with authenticated prior issuance evicts", missing.nc.isClosed());
  const denied = await session();
  const create = kv.create.bind(kv);
  kv.create = async () => { throw new Error("fixture refused record write"); };
  try { await assert.rejects(recordSessionConnection(kv, denied.issuance, authority), /refused record write/); }
  finally { kv.create = create; }
  check("G12 a failed session record write refuses issuance and writes no receipt", (await kv.get(denied.key)) === null);
  const legacy = await session();
  await recordSessionConnection(kv, legacy.issuance, authority); await legacy.end();
  await delivery.close(); delivery = undefined;
  const legacyResponder = new core.CotalEndpoint({ space: a.space, servers: fx.servers, creds: await mintCreds(a.auth, newIdentity(), "delivery"), card: { name: "legacy-fixture", kind: "endpoint" }, channels: [], consume: false, registerPresence: false, watchPresence: false, watchChannels: false });
  await legacyResponder.start();
  const legacyReplies = legacyResponder.serveControl(core.CONTROL_DELIVERY_ADMIN, () => ({ ok: false, error: "unsupported operation" }));
  try { await sweep(); } catch { /* The legacy refusal must retain the receipt. */ }
  finally { legacyReplies.unsubscribe(); await legacyResponder.stop(); }
  check("G13 older delivery refusal retains record and evicts nothing", (await kv.get(legacy.key))?.operation === "PUT" && !legacy.nc.isClosed());
  delivery = await startDeliveryService({ context: { accountPublicKey: a.accountPublicKey, lifecycleUid: mintLifecycleUid() }, space: a.space, servers: fx.servers, stateDir: a.stateDir, store: a.store, storeIdentity: a.store.identity });
  await sweep(); await wait(100);
  check("G14 supported delivery retry evicts the ended legacy-held connection", legacy.nc.isClosed());
  const mismatch = await session();
  await recordSessionConnection(kv, mismatch.issuance, authority);
  await sessions.put(sessionLedgerKey(mismatch.row.sessionId), JSON.stringify({ ...mismatch.row, holder: victim.row.holder }));
  const following = await session();
  await recordSessionConnection(kv, following.issuance, authority); await following.end();
  let mismatchThrew = false;
  try { await sweep(); } catch { mismatchThrew = true; }
  await wait(100);
  check("G17 holder mismatch is quarantined and the following honest session still evicts", !mismatchThrew && following.nc.isClosed() && !mismatch.nc.isClosed());
  await kv.purge(mismatch.key);
  const invalidKey = `sessionconn.${newIdentity().id}`;
  const invalidRow = { ...signed.row, sessionId: "invalid.id" };
  const invalidMac = createHmac("sha256", authority.secret).update(JSON.stringify(["cotal-session-connection-v1", a.space, invalidKey, invalidRow])).digest("base64url");
  await kv.create(invalidKey, JSON.stringify({ v: 1, row: invalidRow, mac: invalidMac }));
  let invalidThrew = false;
  try { await sweep(); } catch { invalidThrew = true; }
  check("G18 invalid session identifiers are quarantined without stopping the pass", !invalidThrew && (await kv.get(invalidKey))?.operation === "PURGE");
  await kv.purge(invalidKey);
  const streamsPrototype = Object.getPrototypeOf(jsm.streams) as { getMessage: typeof jsm.streams.getMessage };
  const getMessage = streamsPrototype.getMessage;
  let entered = false, release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  streamsPrototype.getMessage = async function (stream, query) {
    const result = await getMessage.call(this, stream, query);
    if ((query as { next_by_subj?: string }).next_by_subj?.includes(".sessionconn.")) { entered = true; await gate; }
    return result;
  };
  let host: Awaited<ReturnType<typeof startAuthService>> | undefined;
  try {
    host = await startAuthService({ context: { accountPublicKey: a.accountPublicKey, lifecycleUid: mintLifecycleUid() }, space: a.space, servers: fx.servers, stateDir: a.stateDir, store: a.store, storeIdentity: a.store.identity });
    for (let i = 0; i < 150 && !entered; i++) await wait(20);
    check("G15 session sweep enters a real broker pass before shutdown", entered);
    let closed = false;
    const closing = host.close().then(() => { closed = true; });
    await wait(1500);
    const awaited = !closed;
    release();
    await closing;
    check("G16 auth close aborts and awaits its in-flight session pass", awaited && closed);
  } finally { release?.(); streamsPrototype.getMessage = getMessage; await host?.close(); }
} finally {
  for (const nc of sockets) await nc.close();
  await delivery?.close(); await admin.close(); await fx.stopBroker();
}
console.log(`SESSION CONNECTION GUARDS: ${passed} passed, ${failed} failed`);
emitSentinel({ passed, failed });
process.exitCode = failed ? 1 : 0;
