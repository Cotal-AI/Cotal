import "./_session-build-freshness.js";
import { createHmac } from "node:crypto";
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
  const retryLogged = new Set<string>();
  const sweep = (overrides: Partial<Parameters<typeof reconcileSessionConnections>[0]> = {}) => reconcileSessionConnections({ ...authority, kv, seq: 1, maxRows: 256, releaseWindowMs: -1, signal: new AbortController().signal, evict, retryLogged, log: (s) => logs.push(s), ...overrides });
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
  const macControl = await session();
  await recordSessionConnection(kv, macControl.issuance, authority);
  const macReceipt = (await kv.get(macControl.key))!.json<any>();
  const receiptRow = macReceipt.row ?? { sessionId: macControl.row.sessionId, principal: macControl.row.holder.principal, lifecycleUid: macControl.row.holder.lifecycleUid, connection: macControl.issuance.connection, releaseAfter: Date.now(), sessionRevision: 1 };
  const signedControl = { v: 1, row: receiptRow, mac: createHmac("sha256", authority.secret).update(JSON.stringify(["cotal-session-connection-v1", a.space, macControl.key, receiptRow])).digest("base64url") };
  const macRow = { ...receiptRow, sessionId: mintSessionId() };
  const macFor = (space: string, key: string, row: unknown, secret = authority.secret) => createHmac("sha256", secret).update(JSON.stringify(["cotal-session-connection-v1", space, key, row])).digest("base64url");
  const macCases = [
    { name: "M1 well-formed garbage MAC cannot evict live control for nonexistent session", key: `sessionconn.${newIdentity().id}`, value: { v: 1, row: macRow, mac: Buffer.alloc(32, 7).toString("base64url") } },
    { name: "M2 signed receipt copied to another key is refused", key: `sessionconn.${newIdentity().id}`, value: signedControl },
    { name: "M3 receipt signed for another space is refused", key: `sessionconn.${newIdentity().id}`, value: undefined as any },
    { name: "M4 receipt signed under another secret is refused", key: `sessionconn.${newIdentity().id}`, value: undefined as any },
  ];
  macCases[2]!.value = { v: 1, row: macRow, mac: macFor(`${a.space}-other`, macCases[2]!.key, macRow) };
  macCases[3]!.value = { v: 1, row: macRow, mac: macFor(a.space, macCases[3]!.key, macRow, "different-auth-host-secret") };
  for (const entry of macCases) {
    await kv.create(entry.key, JSON.stringify(entry.value));
    let rejected = false;
    try { await sweep(); } catch { rejected = true; }
    try { await macControl.nc.flush(); } catch { /* The named cell records loss of the control. */ }
    check(entry.name, !rejected && !macControl.nc.isClosed() && (await kv.get(entry.key))?.operation === "PURGE");
    if ((await kv.get(entry.key))?.operation === "PUT") await kv.purge(entry.key);
  }
  const authenticatedControlKey = `sessionconn.${newIdentity().id}`;
  await kv.create(authenticatedControlKey, JSON.stringify({ v: 1, row: macRow, mac: macFor(a.space, authenticatedControlKey, macRow) }));
  let authenticatedControlFailed = false;
  try { await sweep(); } catch { authenticatedControlFailed = true; }
  await wait(100);
  check("M0 identical missing-session row with correct MAC selects the control connection", !authenticatedControlFailed && macControl.nc.isClosed() && (await kv.get(authenticatedControlKey))?.operation === "PURGE");
  if ((await kv.get(authenticatedControlKey))?.operation === "PUT") await kv.purge(authenticatedControlKey);
  const revision = await session();
  await recordSessionConnection(kv, revision.issuance, authority);
  const revisionReceipt = (await kv.get(revision.key))!.json<any>();
  const revisionRow = { ...(revisionReceipt.row ?? { sessionId: revision.row.sessionId, principal: revision.row.holder.principal, lifecycleUid: revision.row.holder.lifecycleUid, connection: revision.issuance.connection, releaseAfter: Date.now() }), sessionRevision: 1_000_000 };
  await kv.put(revision.key, JSON.stringify({ v: 1, row: revisionRow, mac: macFor(a.space, revision.key, revisionRow) }));
  await revision.end();
  const revisionRetryLogged = new Set<string>();
  const revisionRetries = new Map<string, { nextAt: number; delayMs: number }>();
  for (let i = 0; i < 1024; i++) { revisionRetryLogged.add(`old-${i}`); revisionRetries.set(`old-${i}`, { nextAt: 0, delayMs: 1000 }); }
  let revisionTransient = 0;
  try { await sweep({ transient: () => revisionTransient++, retryLogged: revisionRetryLogged, retries: revisionRetries }); } catch { revisionTransient++; }
  const revisionWarnings = logs.filter((line) => line.includes("precedes authenticated receipt revision"));
  await sweep({ retryLogged: revisionRetryLogged, retries: revisionRetries });
  check("L1 revision lag logs both sequence numbers once and bounds retained key state", revisionWarnings.length === 1 && /revision \d+ precedes authenticated receipt revision 1000000/.test(revisionWarnings[0]!) && logs.filter((line) => line.includes("precedes authenticated receipt revision")).length === 1 && revisionRetryLogged.size <= 1024 && revisionRetries.size <= 1024);
  check("M8 session authority older than authenticated observed revision cannot evict", !revision.nc.isClosed() && (await kv.get(revision.key))?.operation === "PUT" && revisionTransient > 0);
  await kv.purge(revision.key);
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
  const count = logs.length;
  const quarantined = await Promise.all([forgedKey, malformedKey, invalidIdKey].map(async (key) => (await kv.get(key))?.operation === "PURGE"));
  let repeatedBad = false;
  try { await sweep(); } catch { repeatedBad = true; }
  check("G6 reconciler quarantines every bad receipt and logs each only once", !repeatedBad && quarantined.every(Boolean) && count >= 3 && logs.length === count);
  for (const key of [forgedKey, malformedKey, invalidIdKey]) if ((await kv.get(key))?.operation === "PUT") await kv.purge(key);
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
  const legacy = await session();
  await recordSessionConnection(kv, legacy.issuance, authority); await legacy.end();
  await delivery.close(); delivery = undefined;
  const legacyResponder = new core.CotalEndpoint({ space: a.space, servers: fx.servers, creds: await mintCreds(a.auth, newIdentity(), "delivery"), card: { name: "legacy-fixture", kind: "endpoint" }, channels: [], consume: false, registerPresence: false, watchPresence: false, watchChannels: false });
  await legacyResponder.start();
  let useHook = false;
  const adminHandler = legacyResponder as unknown as {
    plane3: { evictPrincipal: (principal: string, connections?: core.KickTarget[]) => Promise<unknown> };
    handleDeliveryAdmin: (request: core.ControlRequest) => Promise<core.ControlReply>;
  };
  let ignoredHookCalled = false;
  adminHandler.plane3 = { evictPrincipal: async (principal) => { ignoredHookCalled = true; return { principal, kicked: 0, remaining: 0, verifiedGone: true, scanComplete: true }; } };
  const legacyReplies = legacyResponder.serveControl(core.CONTROL_DELIVERY_ADMIN, (request) => useHook ? adminHandler.handleDeliveryAdmin(request) : { ok: false, error: "unsupported operation" });
  let adminCaller: core.CotalEndpoint | undefined;
  try {
    try { await sweep(); } catch { /* The legacy refusal must retain the receipt. */ }
    check("G13 older delivery refusal retains record and evicts nothing", (await kv.get(legacy.key))?.operation === "PUT" && !legacy.nc.isClosed());
    useHook = true;
    adminCaller = new core.CotalEndpoint({ space: a.space, servers: fx.servers, creds: await mintCreds(a.auth, newIdentity(), "supervisor"), card: { name: "exact-hook-fixture", kind: "endpoint" }, channels: [], consume: false, registerPresence: false, watchPresence: false, watchChannels: false });
    await adminCaller.start();
    const coordinates = [legacy.issuance.connection!];
    const ignored = await adminCaller.requestDeliveryAdmin("evictSessionConnections", { principal: legacy.row.holder.principal, connections: coordinates });
    check("H1 a hook ignoring the exact filter is refused before execution", !ignored.ok && !ignoredHookCalled);
    adminHandler.plane3.evictPrincipal = async (principal, _connections) => ({ principal, kicked: 0, remaining: 0, verifiedGone: true, scanComplete: true });
    const noEcho = await adminCaller.requestDeliveryAdmin("evictSessionConnections", { principal: legacy.row.holder.principal, connections: coordinates });
    check("H3 core refuses an executor result without its own filter echo", !noEcho.ok);
    adminHandler.plane3.evictPrincipal = async (principal, connections) => ({ principal, kicked: 0, remaining: 0, verifiedGone: true, scanComplete: true, connections: connections?.map((row) => ({ ...row })) });
    const acknowledged = await adminCaller.requestDeliveryAdmin("evictSessionConnections", { principal: legacy.row.holder.principal, connections: coordinates });
    check("H2 executor acknowledgement of received exact filter is accepted", acknowledged.ok);
  } finally { await adminCaller?.stop(); legacyReplies.unsubscribe(); await legacyResponder.stop(); }
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
  const unreadable = await session();
  await recordSessionConnection(kv, unreadable.issuance, authority);
  const unreadableReceipt = (await kv.get(unreadable.key))!.json<any>();
  const unreadableRow = unreadableReceipt.row ?? { sessionId: unreadable.row.sessionId, principal: unreadable.row.holder.principal, lifecycleUid: unreadable.row.holder.lifecycleUid, connection: unreadable.issuance.connection, releaseAfter: Date.now(), sessionRevision: 1 };
  await kv.put(unreadable.key, JSON.stringify({ v: 1, row: unreadableRow, mac: macFor(a.space, unreadable.key, unreadableRow) }));
  await sessions.put(sessionLedgerKey(unreadable.row.sessionId), "not-json");
  let retryCount = 0;
  try { await sweep({ transient: () => retryCount++ }); } catch { retryCount++; }
  const warnings = logs.filter((line) => line.includes("unreadable")).length;
  try { await sweep({ transient: () => retryCount++ }); } catch { retryCount++; }
  check("M5 unreadable session authority retains authenticated evidence without eviction", (await kv.get(unreadable.key))?.operation === "PUT" && !unreadable.nc.isClosed() && retryCount >= 2);
  check("M6 repeated unreadable session authority logs once", warnings === 1 && logs.filter((line) => line.includes("unreadable")).length === 1);
  await unreadable.end();
  let recoveryFailed = false;
  try { await sweep(); } catch { recoveryFailed = true; }
  await wait(100);
  check("M7 restored terminal authority retries retained receipt and evicts", !recoveryFailed && unreadable.nc.isClosed());
  if ((await kv.get(unreadable.key))?.operation === "PUT") await kv.purge(unreadable.key);
  const permanentlyUnreadable = await session();
  await recordSessionConnection(kv, permanentlyUnreadable.issuance, authority);
  await sessions.put(sessionLedgerKey(permanentlyUnreadable.row.sessionId), "not-json");
  let timingHost: Awaited<ReturnType<typeof startAuthService>> | undefined;
  try {
    timingHost = await startAuthService({ context: { accountPublicKey: a.accountPublicKey, lifecycleUid: mintLifecycleUid() }, space: a.space, servers: fx.servers, stateDir: a.stateDir, store: a.store, storeIdentity: a.store.identity });
    await wait(10_000);
    const healthyNeighbor = await session();
    await recordSessionConnection(kv, healthyNeighbor.issuance, authority);
    const neighborEndedAt = performance.now();
    await healthyNeighbor.end();
    while (!healthyNeighbor.nc.isClosed() && performance.now() - neighborEndedAt < 4500) await wait(25);
    check("T1 permanently unreadable receipt does not slow a healthy ended neighbor", healthyNeighbor.nc.isClosed() && performance.now() - neighborEndedAt < 4500 && !permanentlyUnreadable.nc.isClosed() && (await kv.get(permanentlyUnreadable.key))?.operation === "PUT");
  } finally { await timingHost?.close(); }
  await kv.purge(permanentlyUnreadable.key);
  const streamsPrototype = Object.getPrototypeOf(jsm.streams) as { getMessage: typeof jsm.streams.getMessage };
  const getMessage = streamsPrototype.getMessage;
  let entered = false, release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  streamsPrototype.getMessage = async function (stream, query) {
    const result = await getMessage.call(this, stream, query);
    if ((query as { next_by_subj?: string }).next_by_subj?.includes(".sessionconn.")) { entered = true; await gate; }
    return result;
  };
  const abort = AbortController.prototype.abort;
  let sessionAborted = false, aborted!: () => void;
  const abortObserved = new Promise<void>((resolve) => { aborted = resolve; });
  AbortController.prototype.abort = function (reason?: unknown) {
    if (reason instanceof Error && reason.message === "auth session sweep stopped") { sessionAborted = true; aborted(); }
    return abort.call(this, reason);
  };
  let host: Awaited<ReturnType<typeof startAuthService>> | undefined;
  try {
    host = await startAuthService({ context: { accountPublicKey: a.accountPublicKey, lifecycleUid: mintLifecycleUid() }, space: a.space, servers: fx.servers, stateDir: a.stateDir, store: a.store, storeIdentity: a.store.identity });
    for (let i = 0; i < 150 && !entered; i++) await wait(20);
    check("G15 session sweep enters a real broker pass before shutdown", entered);
    let closed = false;
    const closing = host.close().then(() => { closed = true; });
    const boundary = await Promise.race([abortObserved.then(() => "aborted"), closing.then(() => "closed"), wait(5000).then(() => "timeout")]);
    if (boundary === "aborted") await wait(3000);
    const awaited = boundary === "aborted" && sessionAborted && !closed;
    release();
    await closing;
    check("G16 auth close reaches session abort and awaits that held pass", awaited && closed);
  } finally { release?.(); streamsPrototype.getMessage = getMessage; AbortController.prototype.abort = abort; await host?.close(); }
} finally {
  for (const nc of sockets) await nc.close();
  await delivery?.close(); await admin.close(); await fx.stopBroker();
}
console.log(`SESSION CONNECTION GUARDS: ${passed} passed, ${failed} failed`);
emitSentinel({ passed, failed });
process.exitCode = failed ? 1 : 0;
