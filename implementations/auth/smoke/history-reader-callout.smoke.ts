/**
 * An auth-callout connection's history-reader deletes are keyed on the server-assigned connection.
 *
 * The observer and admin profiles may delete their own history readers, `hist_<readerId>_<n>`. Under
 * the auth callout the client chooses the connection name, but the callout keys reader grants on
 * the server's id and the client id assigned by the server in INFO.
 *
 * The suite runs the shipped callout and permission builder with two admin-view principals. It reads
 * history through a user-mode endpoint and checks reader-deletion isolation both for a second
 * connection sharing the same principal and inbox name, and for a different principal on its own
 * legacy inbox. A bound name that does not match the bearer is refused at connect. After
 * reconnecting, the endpoint reads again using the new connection's reader names. A scoped `cli`
 * reader receives a live post without adding a census row, while a separate user-auth join counts.
 *
 * Run: pnpm smoke:history-reader-callout:auth   (needs nats-server on PATH; operator-mode callout, local-only)
 */
import { randomUUID } from "node:crypto";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { createServer as createTcpServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect, credsAuthenticator, tokenAuthenticator, type NatsConnection } from "@nats-io/transport-node";
import { AckPolicy, StorageType, jetstream, jetstreamManager } from "@nats-io/jetstream";
import { encodeUser, fmtCreds } from "@nats-io/jwt";
import { fromPublic, fromSeed } from "@nats-io/nkeys";
import { SignJWT, generateKeyPair, type CryptoKey } from "jose";
import {
  CotalEndpoint, createSpaceAuth, isReachable, mintCreds, newIdentity, serverConfig, setupSpaceStreams,
  seedChannelRegistry, provisionAgent, mintLifecycleUid, chatStream, eventPayloadStream, userInboxConnId, type CotalMessage,
  chatSubject, chatHistDurable, idFromCreds, mintMembershipObserverCreds, provisionAgentDurables, startMembershipFeed,
  recordsBucket, remoteManagerServePrincipal,
  type RemoteManagedAgentEnrollmentRequest, type SecretStore,
} from "@cotal-ai/core";
import { PLUGIN_CHANNEL_ROOT, pluginChannelStream, pluginChannelFilter, pluginChannelSubject } from "../../../packages/core/src/plugin-channel-route.js";
import { pluginChannelSpaceStateSubject } from "../../../packages/core/src/plugin-channel-space-state.js";
import { authDir, meshFile, recordMesh, userAuthStateDir } from "@cotal-ai/workspace";
import { authServiceKeysKey, createCalloutAuth, calloutPermissions, cotalAuthProvider, deriveOwnerToken, ensureCalloutAuth, saveServiceKeys, startAuthCallout, USER_TOKEN_VER } from "../dist/index.js";
import { findManagedActor, grantActor, ledgerAclResolver, ledgerAuthorizeConnect, newActorToken } from "../dist/ledger.js";
import { pluginChannelStateResolver } from "../dist/callout-authority.js";
import { managedAgentAuthority } from "../dist/service-managed-agents.js";
import { handleExchange, LOOPBACK_POLICY } from "../dist/service-exchange-routes.js";
import { remoteManagerCurrentRegistrationProof } from "../dist/retained-manager-validation.js";
import type { HandlerCtx } from "../dist/service.js";
import { pickFreePort } from "./_free-port.js";
import { runSpawnDnsFixture } from "./_stalled-spawn-dns.js";
import { SMOKE_BROKER_TOKEN, createSuite, teardownOnSignal } from "@cotal-ai/smoke-kit";
import { matchesMainPermissions } from "../../../packages/core/smoke/_off-channel-main.js";

const { check, finish } = createSuite();
const enc = (s: string) => new TextEncoder().encode(s);
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const textOf = (m: CotalMessage) => m.parts.map((p) => (p.kind === "text" ? p.text : "")).join("");
const READS = 12;

const PORT = await pickFreePort();
const SERVERS = `nats://127.0.0.1:${PORT}`;
const space = `hist-callout-${randomUUID().slice(0, 8)}`;
const smokeUid = mintLifecycleUid();
const auth = await createSpaceAuth(space);
const callout = await createCalloutAuth({ space, operatorSeed: auth.operator.seed, accountPub: auth.account.pub });
const root = mkdtempSync(join(tmpdir(), SMOKE_BROKER_TOKEN));
const dir = userAuthStateDir(root, space);
const dataAccount = { pub: auth.account.pub, signingSeed: auth.account.signingSeed };
writeFileSync(join(root, "server.conf"), serverConfig(auth, [auth], { transport: { kind: "plaintext" }, port: PORT, storeDir: join(root, "js"), extraAccounts: [{ pub: callout.account.pub, jwt: callout.account.jwt }] }));
const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("COTAL_")));
let srv: ReturnType<typeof spawn> | undefined;
let brokerLog = "";
let releaseBroker: (() => void) | undefined;

const { publicKey, privateKey } = await generateKeyPair("EdDSA");
const ISS = "https://auth.cotal.test";
const OWNER = deriveOwnerToken("s".repeat(32), "better-auth|history-reader");
const SPAWNER = "routed_parent";
const localChannel = `${PLUGIN_CHANNEL_ROOT}.linear.inbox`;
const parityUid = "p".repeat(26), parityScope = ["spawn"], paritySpace = "off-parity";
const offRows = await calloutPermissions(() => ({
  lifecycleUid: parityUid, scope: parityScope, kind: "managed-agent",
  allowSubscribe: ["general", `${PLUGIN_CHANNEL_ROOT}.linear.inbox`], allowPublish: [`${PLUGIN_CHANNEL_ROOT}.linear.inbox`],
}), undefined, undefined, undefined, undefined, undefined, async () => ({ enabled: false }))({
  owner: OWNER, space: paritySpace, scope: [], ver: USER_TOKEN_VER, exp: 2_000_000_000,
  act: { owner: OWNER, actor: "worker", scope: parityScope, lifecycleUid: parityUid },
}, "conn0123456789abcdef", "reader0123456789abcdef");
check("off-state user callout matches main's complete permission rows", matchesMainPermissions("userCallout", offRows));
/** An admin-view bearer for `actor`: the elevated read view a hosted dashboard connects with. */
async function adminBearer(actor: string): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({ sub: OWNER, ver: USER_TOKEN_VER, act: { owner: OWNER, actor, scope: ["admin"], lifecycleUid: smokeUid, view: "admin" } })
    .setProtectedHeader({ alg: "EdDSA" }).setIssuer(ISS).setAudience(space).setSubject(OWNER)
    .setIssuedAt(now - 60).setNotBefore(now - 60).setExpirationTime(now + 600)
    .sign(privateKey as CryptoKey);
}

const PAYLOAD_ACTOR = "payload_writer";
const FOREIGN = deriveOwnerToken("s".repeat(32), "better-auth|payload-foreign");
const participantRows = [
  grantActor(dir, { owner: OWNER, actor: "payload_reader", scope: [], allowSubscribe: [], allowPublish: [] }),
  grantActor(dir, { owner: FOREIGN, actor: "payload_explicit", scope: [], allowSubscribe: [`events.${OWNER}.${PAYLOAD_ACTOR}`], allowPublish: [] }),
  grantActor(dir, { owner: FOREIGN, actor: "payload_broad", scope: [], allowSubscribe: [">", "events.>"], allowPublish: [] }),
];
async function participantBearer(row: typeof participantRows[number]): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({ ver: USER_TOKEN_VER, act: { owner: row.owner, actor: row.actor, scope: [], lifecycleUid: row.lifecycleUid } })
    .setProtectedHeader({ alg: "EdDSA" }).setIssuer(ISS).setAudience(space).setSubject(row.owner)
    .setIssuedAt(now - 60).setNotBefore(now - 60).setExpirationTime(now + 600)
    .sign(privateKey as CryptoKey);
}

const endpoints: CotalEndpoint[] = [];
const raws: NatsConnection[] = [];
let routed = false;
let readPluginChannelState: ReturnType<typeof pluginChannelStateResolver>;
const resolveRouting: ReturnType<typeof pluginChannelStateResolver> = async (requestedSpace) => {
  try { return await readPluginChannelState(requestedSpace); }
  catch (error) {
    // Only this fixture lets the exchange and callout use the enabled record on the broker.
    if (routed && error instanceof Error && error.message === "this release does not support enabled plugin channels") return { enabled: true };
    throw error;
  }
};
const calloutDenials: string[] = [];
let feed: Awaited<ReturnType<typeof startMembershipFeed>> | undefined;

async function checkRoutedCallout(control: NatsConnection): Promise<void> {
  const stream = pluginChannelStream(space);
  const channel = localChannel;
  const filter = pluginChannelSubject(space, "*", "*", channel);
  const manager = await jetstreamManager(control);
  await manager.streams.add({ name: stream, subjects: [pluginChannelFilter(space)], storage: StorageType.Memory });
  const dial = async (row: ReturnType<typeof grantActor>, bearer?: string) => {
    const actor = row.actor;
    const nonce = userInboxConnId(row.owner, row.actor);
    const nc = await connect({ servers: SERVERS,
      authenticator: [credsAuthenticator(enc(callout.sentinelCreds)), tokenAuthenticator(bearer ?? await participantBearer(row))],
      name: nonce, inboxPrefix: `_INBOX_${nonce}`, reconnect: false,
    });
    raws.push(nc);
    return { nc, actor, history: chatHistDurable(row.owner, actor, row.lifecycleUid!) };
  };
  await checkDelegationDoors(channel, dial, control);
  const open = (actor: string, read: string[]) => dial(grantActor(dir, { owner: OWNER, actor, scope: [], allowSubscribe: read, allowPublish: read }));
  const broad = await open("routed_broad", [">"]);
  const scoped = await open("routed_plugin", [`${PLUGIN_CHANNEL_ROOT}.linear.>`]);
  const posted = await jetstream(scoped.nc).publish(pluginChannelSubject(space, OWNER, scoped.actor, channel), enc("callout history probe"));
  check("callout: an explicitly granted sender publishes to the plugin history stream", posted.stream === stream);
  const create = (reader: typeof scoped) => reader.nc.request(`$JS.API.CONSUMER.CREATE.${stream}.${reader.history}.${filter}`, enc(JSON.stringify({
    stream_name: stream, action: "create",
    config: { name: reader.history, filter_subject: filter, ack_policy: "none", deliver_policy: "all", inactive_threshold: 5_000_000_000 },
  })), { timeout: 1000 });
  const allowed = (await create(scoped)).json<{ error?: unknown; num_pending?: number }>();
  check("callout: an explicit plugin grant can open its own retained history", allowed.error === undefined && allowed.num_pending === 2, allowed);
  const denied = await create(broad).then(() => false, (error: unknown) => /permission/i.test(String(error)));
  check("callout: the broker refuses plugin history for a broad chat-only grant", denied);
}

async function checkDelegationDoors(channel: string, dial: (row: ReturnType<typeof grantActor>, token?: string) => Promise<{ nc: NatsConnection }>, control: NatsConnection) {
  const instanceId = mintLifecycleUid(), managerLifecycleUid = mintLifecycleUid(), serveEpoch = 4, registrationRevision = 9;
  const identities = { supervisor: newIdentity(), executor: newIdentity(), serve: newIdentity(), goalWriter: newIdentity(), sessionLedger: newIdentity() };
  const manager = { space, actor: SPAWNER, instanceId, managerLifecycleUid, identities: Object.fromEntries(Object.entries(identities).map(([k, { id }]) => [k, { id }])) as RemoteManagedAgentEnrollmentRequest["identities"] };
  const registrationProof = remoteManagerCurrentRegistrationProof(dataAccount.signingSeed, OWNER, manager, { registrationRevision, processEpoch: serveEpoch });
  const unexpectedRetirement = async () => { throw new Error("no retirement in the fixture"); };
  const authority = managedAgentAuthority({
    server: SERVERS, space, dataAccount, issuerAuth: () => auth, refuseIfFenced: () => {},
    observeLegacyManagerGate: async () => ({ state: "open", space, endpoint: "manager", lifecycleUid: instanceId,
      principal: remoteManagerServePrincipal(OWNER, instanceId), registrationRevision, processEpoch: serveEpoch,
      generation: 1, nameAuthorityRevision: 1, revision: 1 }),
    resolvePluginChannelState: resolveRouting,
    opts: { server: SERVERS, space, dataAccount, dir, identityRoot: dir, log: () => {} },
    takeObservedSpawnRequest: async () => false, readRunStarterAdmission: async () => { throw new Error("no run in the fixture"); },
    deprovisionManagedFootprint: async () => {}, onConnection: undefined,
    managedRetirement: { retireManagedLifecycle: unexpectedRetirement, prepareManagedAgentRetirement: unexpectedRetirement },
    serializedForAlias: async (_dir, _owner, _actor, fn) => fn(),
  });
  const ask = (actor: string, grant: string) => {
    const secret = newActorToken();
    const args = { owner: OWNER, scope: ["supervise"], sentinelCreds: callout.sentinelCreds, agentBearerExchangeUrl: "http://127.0.0.1:9/unused",
      request: { ...manager, v: 1 as const, kind: "manager-managed-agent-enrollment" as const, requestId: `enroll${mintLifecycleUid()}`,
        registrationProof, serveEpoch, target: { actor, tokenHash: secret.tokenHash, subscribe: [], allowSubscribe: [grant], allowPublish: [grant] } } };
    return { ...secret, actor, args };
  };
  let exchangeRoutingReads = 0;
  const ctx = { cap: "review-fixture", failures: [], badCaps: [], space, dir,
    resolvePluginChannelState: (requestedSpace: string) => { exchangeRoutingReads++; return resolveRouting(requestedSpace); },
    connectLimiter: { check: () => {} }, mintConnectCredential: async () => "fixture",
    issuer: { issue: async ({ actor }: { actor: string }) => participantBearer(findManagedActor(dir, OWNER, actor)!) }, log: () => {} } as unknown as HandlerCtx;
  const http = createServer((req, res) => { void handleExchange(req, res, ctx, LOOPBACK_POLICY).catch(e => { res.statusCode = 500; res.end(String(e)); }); });
  await new Promise<void>(resolve => { http.listen(0, "127.0.0.1", resolve); });
  const port = (http.address() as { port: number }).port;
  const exchange = async ({ actor, actorToken }: { actor: string; actorToken: string }) => {
    const response = await fetch(`http://127.0.0.1:${port}/exchange`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${ctx.cap}` }, body: JSON.stringify({ owner: OWNER, actor, actorToken }) });
    return { status: response.status, ...await response.json() as { token?: string; error?: string } };
  };
  const parent = (channels: string[]) => grantActor(dir, { owner: OWNER, actor: manager.actor, scope: ["spawn"], allowSubscribe: channels, allowPublish: channels });
  try {
    await checkRegisteredLocalSpawns(control);
    const cached = [];
    for (const local of offlineGrants) {
      const bearer = await exchange(local);
      assert.equal(bearer.status, 200);
      assert.ok(bearer.token);
      const row = findManagedActor(dir, OWNER, local.actor)!;
      const old = await dial(row, bearer.token);
      await old.nc.close();
      cached.push({ local, row, token: bearer.token });
    }
    const legacy = ask("legacy_child", channel);
    await authority.enrollManagedAgent(legacy.args);
    const legacyRow = findManagedActor(dir, OWNER, legacy.actor)!;
    check("off: managed spawn writes the reserved-looking ordinary chat grant", legacyRow.allowSubscribe.includes(channel));
    const readsBeforeInvalid = exchangeRoutingReads;
    const invalid = await exchange({ ...legacy, actorToken: newActorToken().actorToken });
    check("off: the exchange refuses an invalid secret without reading protected routing state", invalid.status === 401 && exchangeRoutingReads === readsBeforeInvalid);
    const legacyBearer = await exchange(legacy);
    check("off: the legacy child exchanges its secret for a bearer", legacyBearer.status === 200 && !!legacyBearer.token);
    const old = await dial(legacyRow, legacyBearer.token);
    check("off: callout grants ordinary chat for the legacy child", (await jetstream(old.nc).publish(chatSubject(space, OWNER, legacy.actor, channel), enc("legacy"))).stream === chatStream(space));
    await setRoutingRecord(control, { version: 1, epoch: 1, enabled: true });
    routed = true;
    for (const { local, row, token } of cached) {
      const denied = await exchange(local);
      check(`on: exchange refuses the ${local.condition} grant under a chat-only spawner`,
        denied.status === 401 && /exceeds its spawner's CURRENT grant/.test(denied.error ?? "") && !denied.token);
      const nativeDenied = await dial(row, token).then(() => false, () => true);
      const denial = () => calloutDenials.some(line => line.includes(` actor=${local.actor} `) && line.includes("exceeds its spawner's CURRENT grant") && line.includes(channel));
      for (let i = 0; i < 20 && !denial(); i++) await wait(20);
      check(`on: callout refuses the ${local.condition} grant's previously accepted bearer`, nativeDenied && denial());
    }
    const denied = ask("routed_denied", channel);
    const refusal = /exceed.*spawner.*grant/;
    await assert.rejects(authority.verifyManagedAgentEnrollment(denied.args), refusal);
    await assert.rejects(authority.enrollManagedAgent(denied.args), refusal);
    check("on: chat-only spawn and verification refuse before the child row is written", findManagedActor(dir, OWNER, denied.actor) === undefined);
    const badExchange = await exchange(legacy);
    check("on: exchange refuses the existing child under a chat-only spawner", badExchange.status === 401 && refusal.test(badExchange.error ?? "") && !badExchange.token);
    check("on: a still-valid cached bearer is refused by the same callout bound", await dial(legacyRow, legacyBearer.token).then(() => false, () => true));
    for (let i = 0; i < 20 && !calloutDenials.some(line => line.includes(channel)); i++) await wait(20);
    check("on: the broker denial names the current spawner grant", calloutDenials.some(line => line.includes("exceeds its spawner's CURRENT grant") && line.includes(channel)));
    parent([channel]);
    const wide = ask("routed_wide", `${PLUGIN_CHANNEL_ROOT}.linear.>`);
    await assert.rejects(authority.enrollManagedAgent(wide.args), refusal);
    check("on: an exact parent cannot delegate the wider plugin subtree", findManagedActor(dir, OWNER, wide.actor) === undefined);
    const scoped = ask("routed_scoped", channel);
    await authority.verifyManagedAgentEnrollment(scoped.args);
    await authority.enrollManagedAgent(scoped.args);
    const granted = await exchange(scoped);
    check("on: scoped spawn and HTTP exchange admit the exact plugin grant", granted.status === 200 && !!granted.token);
    const routedChild = await dial(findManagedActor(dir, OWNER, scoped.actor)!, granted.token);
    const stream = pluginChannelStream(space);
    check("on: callout permits the child to publish on that exact plugin rail", (await jetstream(routedChild.nc).publish(pluginChannelSubject(space, OWNER, scoped.actor, channel), enc("routed"))).stream === stream);
    const filter = pluginChannelSubject(space, "*", "*", channel);
    const history = chatHistDurable(OWNER, scoped.actor, findManagedActor(dir, OWNER, scoped.actor)!.lifecycleUid!);
    const retained = await routedChild.nc.request(`$JS.API.CONSUMER.CREATE.${stream}.${history}.${filter}`, enc(JSON.stringify({
      stream_name: stream, action: "create",
      config: { name: history, filter_subject: filter, ack_policy: "none", deliver_policy: "all", inactive_threshold: 5_000_000_000 },
    })), { timeout: 1000 });
    check("on: the delegated child has its explicit retained history", retained.json<{ num_pending?: number }>().num_pending === 1);
    parent([]);
    const narrowed = await exchange(scoped);
    check("on: narrowing the parent also stops the next exchange", narrowed.status === 401 && refusal.test(narrowed.error ?? ""));
  } finally {
    http.closeAllConnections();
    await new Promise<void>((resolve, reject) => http.close(err => err ? reject(err) : resolve()));
  }
}

const localRecord = { space, server: SERVERS, root, mode: "user" as const,
  ts: new Date().toISOString(), userAuth: { provider: "cotal", idp: { url: ISS, issuer: ISS, audience: space } } };
const offlineGrants: { condition: string; actor: string; actorToken: string }[] = [];

async function checkSilentRegisteredBroker(grant: (actor: string) => Promise<unknown>): Promise<void> {
  const sockets = new Set<Socket>();
  let accepted = 0;
  const silent = createTcpServer(socket => {
    accepted++;
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
    socket.resume();
  });
  await new Promise<void>((resolve, reject) => {
    silent.once("error", reject);
    silent.listen(0, "127.0.0.1", resolve);
  });
  try {
    const { port } = silent.address() as { port: number };
    recordMesh({ ...localRecord, server: `nats://127.0.0.1:${port}` });
    const started = performance.now();
    await grant("silent_broker_child");
    const elapsed = Math.round(performance.now() - started);
    for (let i = 0; i < 50 && sockets.size; i++) await wait(20);
    check("local spawn: a silent broker writes within 5 seconds and closes its probe socket",
      accepted > 0 && elapsed >= 2_500 && elapsed < 5_000 && sockets.size === 0, { accepted, elapsed, sockets: sockets.size });
    console.log(`  silent registered broker grant: ${elapsed} ms`);
  } finally {
    for (const socket of sockets) socket.destroy();
    await new Promise<void>(resolve => silent.close(() => resolve()));
  }
}

async function localSpawnFixture() {
  const values = new Map<string, string>();
  let serviceKeyReads = 0;
  const store: SecretStore = {
    get: async key => { if (key === authServiceKeysKey(space)) serviceKeyReads++; return values.get(key); },
    put: async (key, value) => { values.set(key, value); },
    create: async (key, value) => { if (values.has(key)) return false; values.set(key, value); return true; },
    delete: async key => { values.delete(key); },
  };
  await ensureCalloutAuth(store, { space, operatorSeed: auth.operator.seed, accountPub: auth.account.pub });
  await saveServiceKeys(store, space, { dataAccount });
  const args = (actor: string) => ({ store, dir, space, owner: OWNER, actor, parent: `${OWNER}.${SPAWNER}`, scope: [],
    allowSubscribe: [localChannel], allowPublish: [localChannel], lifecycleUid: mintLifecycleUid(), custody: { kind: "foreground" as const } });
  const grant = async (actor: string) => {
    const input = args(actor);
    const { actorToken } = await cotalAuthProvider.grantAgent(input);
    assertRow(input);
    return { actor, actorToken };
  };
  const assertRow = (input: ReturnType<typeof args>) => {
    const row = findManagedActor(dir, OWNER, input.actor);
    assert.ok(row);
    assert.equal(row.parent, input.parent);
    assert.equal(row.lifecycleUid, input.lifecycleUid);
    assert.deepEqual(row.allowSubscribe, input.allowSubscribe);
    assert.deepEqual(row.allowPublish, input.allowPublish);
  };
  return { args, assertRow, grant, keys: () => Object.fromEntries(values), reads: () => serviceKeyReads };
}

async function withLocalRegistry<T>(fn: () => Promise<T>): Promise<T> {
  const home = process.env.COTAL_HOME;
  process.env.COTAL_HOME = join(root, "registry-home");
  try { return await fn(); }
  finally {
    if (home === undefined) delete process.env.COTAL_HOME;
    else process.env.COTAL_HOME = home;
  }
}

async function checkMalformedRegisteredBrokers(grant: (actor: string) => Promise<unknown>): Promise<void> {
  const cases = [
    ["bad hostname", "nats://bad host:4222", "bad_hostname_child"],
    ["out-of-range port", "nats://127.0.0.1:99999", "bad_port_child"],
    ["free text", "not a url at all", "free_text_child"],
  ] as const;
  for (const [label, server, actor] of cases) {
    recordMesh({ ...localRecord, server });
    const out = process.stdout.write, err = process.stderr.write;
    let writes = 0;
    const capture = () => { writes++; return true; };
    process.stdout.write = capture;
    process.stderr.write = capture;
    try { await grant(actor); }
    finally {
      process.stdout.write = out;
      process.stderr.write = err;
    }
    check(`local spawn: registered ${label} preserves the row without output`, writes === 0, { writes });
  }
}

async function checkOfflineLocalSpawns(): Promise<void> {
  grantActor(dir, { owner: OWNER, actor: SPAWNER, scope: ["spawn"], allowSubscribe: [">"], allowPublish: [">"] });
  await withLocalRegistry(async () => {
    const { args, assertRow, grant, keys, reads } = await localSpawnFixture();
    offlineGrants.push({ condition: "no-record", ...await grant("local_child") });
    check("local spawn: no broker registration preserves the legacy grant", reads() === 0);
    recordMesh({ ...localRecord, stoppedByDown: true });
    offlineGrants.push({ condition: "stopped-registration", ...await grant("stopped_child") });
    check("local spawn: stopped registration preserves the ledger write without opening authority", reads() === 0);
    recordMesh(localRecord);
    offlineGrants.push({ condition: "unreachable-broker", ...await grant("unreachable_child") });
    check("local spawn: connection refused preserves the ledger write after trying the recorded broker", reads() === 1);
    writeFileSync(meshFile(space), "not JSON");
    await grant("damaged_registry_child");
    check("local spawn: a damaged registry record preserves the ledger write without opening authority", reads() === 1);
    recordMesh(localRecord);
    const legacy = join(authDir(root), encodeURIComponent(space));
    const pin = join(legacy, "idp.json");
    mkdirSync(legacy, { recursive: true });
    writeFileSync(pin, "{}");
    try {
      await grant("legacy_layout_child");
      check("local spawn: legacy user-auth state preserves the ledger write without migrating or opening authority", reads() === 1 && existsSync(pin));
    } finally { rmSync(legacy, { recursive: true, force: true }); }

    const explicit = { ...args("explicit_unreachable_child"), broker: { server: SERVERS } };
    await assert.rejects(cotalAuthProvider.grantAgent(explicit), /connection refused/);
    check("local spawn: an explicit broker still reports dial failure", findManagedActor(dir, OWNER, explicit.actor) === undefined);

    recordMesh({ ...localRecord, server: "nats://plugin-routing-test.invalid:4222" });
    const beforeDns = reads();
    offlineGrants.push({ condition: "unresolved-broker", ...await grant("unresolved_child") });
    check("local spawn: a registered .invalid hostname preserves the grant without a transport error", reads() === beforeDns + 1);
    const stalled = args("stalled_dns_child");
    const { actorToken, ...timing } = await runSpawnDnsFixture(server => {
      recordMesh({ ...localRecord, server });
      const { store: _store, ...wireArgs } = stalled;
      return { args: wireArgs, keys: keys() };
    });
    assertRow(stalled);
    offlineGrants.push({ condition: "stalled-dns", actor: stalled.actor, actorToken });
    check("local spawn: unanswered DNS writes the grant within 5 seconds", timing.requests > 0 && timing.reads > 0
      && timing.elapsed >= 2_500 && timing.elapsed < 5_000, timing);
    check("local spawn: the built provider process exits within 5 seconds of its last line", timing.exitMs < 5_000, timing);
    console.log(`  stalled DNS grant: ${timing.elapsed} ms, exit after output: ${timing.exitMs} ms`);
    await checkSilentRegisteredBroker(grant);
    await checkMalformedRegisteredBrokers(grant);
    recordMesh(localRecord);
  });
}

async function setRoutingRecord(control: NatsConnection, state: object): Promise<void> {
  await jetstream(control).publish(pluginChannelSpaceStateSubject(space), enc(JSON.stringify(state)));
}

async function checkRegisteredLocalSpawns(control: NatsConnection): Promise<void> {
  await withLocalRegistry(async () => {
    const { args, assertRow, grant, keys } = await localSpawnFixture();
    const stateSubject = pluginChannelSpaceStateSubject(space);
    let observed = 0;
    const requests = control.subscribe(`$JS.API.STREAM.MSG.GET.KV_${recordsBucket(space)}`, { callback: (error, msg) => {
      if (!error && msg.json<{ last_by_subj?: string }>().last_by_subj === stateSubject) observed++;
    } });
    try {
      await control.flush();
      await setRoutingRecord(control, { version: 1, epoch: 1, enabled: false });
      await grant("registered_child");
      await control.flush();
      check("local spawn: registered off space reads the exact protected key and writes without a broker argument", observed === 1);
      const named = args("registered_named_child");
      const result = await runSpawnDnsFixture(server => {
        recordMesh({ ...localRecord, server });
        const { store: _store, ...wireArgs } = named;
        return { args: wireArgs, keys: keys() };
      }, PORT);
      assertRow(named);
      await control.flush();
      check("local spawn: a DNS-resolved registered hostname reads the exact protected key", result.requests > 0 && observed === 2);
      // A malformed first entry must not choose WebSocket transport for the valid TCP entry.
      recordMesh({ ...localRecord, server: `ws://bad host:4222, ${SERVERS}` });
      await grant("registered_mixed_child");
      await control.flush();
      check("local spawn: a mixed list skips the malformed address and reads once from the valid broker", observed === 3);
      recordMesh(localRecord);
    } finally { requests.unsubscribe(); }

    await setRoutingRecord(control, { version: 1, epoch: 1, enabled: true });
    const on = args("registered_on_child");
    await assert.rejects(cotalAuthProvider.grantAgent(on), /would exceed its spawner's grant - delegation only narrows:/);
    check("local spawn: a read of enabled state refuses only the overreaching child", findManagedActor(dir, OWNER, on.actor) === undefined);
    const chat = args("registered_on_chat");
    await cotalAuthProvider.grantAgent({ ...chat, allowSubscribe: ["general"], allowPublish: ["general"] });
    check("local spawn: a granted ordinary chat child still writes while routing is enabled", findManagedActor(dir, OWNER, chat.actor)?.allowPublish[0] === "general");

    recordMesh({ ...localRecord, server: `nats://127.0.0.1:${await pickFreePort()}` });
    const explicit = { ...args("explicit_broker_child"), broker: { server: SERVERS } };
    await assert.rejects(cotalAuthProvider.grantAgent(explicit), /would exceed its spawner's grant - delegation only narrows:/);
    check("local spawn: the explicit broker's enabled state takes precedence over the unreachable registration", findManagedActor(dir, OWNER, explicit.actor) === undefined);
    recordMesh(localRecord);

    await setRoutingRecord(control, { version: 1, epoch: 1, enabled: "invalid" });
    const invalid = args("invalid_state_child");
    await assert.rejects(cotalAuthProvider.grantAgent(invalid), /invalid or unsupported plugin channel space state/);
    check("local spawn: an invalid protected broker record still refuses the write", findManagedActor(dir, OWNER, invalid.actor) === undefined);
    await setRoutingRecord(control, { version: 1, epoch: 1, enabled: false });
  });
}

try {
  await checkOfflineLocalSpawns();
  srv = spawn("nats-server", ["-c", join(root, "server.conf")], { env, stdio: ["ignore", "ignore", "pipe"] });
  srv.stderr?.on("data", (chunk: Buffer) => { brokerLog += chunk.toString(); });
  releaseBroker = teardownOnSignal(srv, root);
  let up = false;
  for (let i = 0; i < 50; i++) { if (await isReachable(SERVERS)) { up = true; break; } await wait(200); }
  if (!up) throw new Error(`nats-server did not come up on ${PORT}`);

  const mgrCreds = await mintCreds(auth, newIdentity(), "provisioner");
  await setupSpaceStreams({ servers: SERVERS, space, creds: mgrCreds });
  const routingNc = await connect({ servers: SERVERS, authenticator: credsAuthenticator(enc(mgrCreds)), inboxPrefix: `_INBOX_${idFromCreds(mgrCreds)}`, reconnect: false });
  raws.push(routingNc);
  readPluginChannelState = pluginChannelStateResolver(await jetstreamManager(routingNc, { checkAPI: false }), space);
  await seedChannelRegistry({ servers: SERVERS, space, creds: mgrCreds, file: { defaults: { replay: true }, channels: { general: { replay: true, deliveryClass: "live" } } } });
  const mgr = new CotalEndpoint({ space, servers: SERVERS, creds: mgrCreds, channels: [], consume: false, watchPresence: false, registerPresence: false, card: { name: "prov", role: "manager", kind: "endpoint" } });
  mgr.on("error", () => {}); await mgr.start(); endpoints.push(mgr);
  const pId = newIdentity(), uidP = mintLifecycleUid();
  const pCreds = await provisionAgent(mgr, auth, pId, { allowSubscribe: ["general"], allowPublish: ["general"], subscribe: [], lifecycleUid: uidP });
  const poster = new CotalEndpoint({ space, servers: SERVERS, creds: pCreds, lifecycleUid: uidP, channels: [], consume: false, watchPresence: false, registerPresence: false, watchChannels: false, card: { id: pId.id, name: "poster", kind: "agent" } });
  poster.on("error", () => {}); await poster.start(); endpoints.push(poster);
  for (let i = 1; i <= 10; i++) await poster.multicast(`general ${i}`, { channel: "general" });

  // The shipped callout and permission builder. The ledger row grants the admin scope the view needs.
  const calloutNc = await connect({ servers: SERVERS, authenticator: credsAuthenticator(enc(callout.calloutCreds)) });
  raws.push(calloutNc);
  startAuthCallout(calloutNc as never, {
    xkeySeed: callout.xkey.seed,
    authAccount: { pub: callout.account.pub, signingSeed: callout.account.signingSeed },
    dataAccount: { pub: auth.account.pub, signingSeed: auth.account.signingSeed },
    space,
    token: { key: publicKey as never, issuer: ISS },
    recordIssuance: async () => {},
    authorizeActor: (t) => { if (!t.act.view) ledgerAuthorizeConnect(dir)(t); },
    permissionsFor: calloutPermissions((t, enabled) => t.act.view
      ? { allowSubscribe: ["general"], allowPublish: [], lifecycleUid: smokeUid, scope: ["admin"] }
      : ledgerAclResolver(dir)(t, enabled), undefined, undefined, undefined, undefined, undefined, resolveRouting),
    log: (l) => {
      if (routed && l.includes("outcome=denied")) calloutDenials.push(l);
      if (/denied|drop|fail/i.test(l)) console.log("  [callout]", l);
    },
  });
  await calloutNc.flush();

  // A test-only allow-all inspector in the data account: it counts consumers and sees the endpoint's
  // JetStream requests, reply subjects included, as any subscriber to those subjects would.
  const inspId = newIdentity();
  const inspJwt = await encodeUser("history-inspector", fromPublic(inspId.id), fromPublic(auth.account.pub),
    { pub: { allow: [">"] }, sub: { allow: [">"] } }, { signer: fromSeed(enc(auth.account.signingSeed)) });
  const control = await connect({ servers: SERVERS, authenticator: credsAuthenticator(fmtCreds(inspJwt, fromSeed(enc(inspId.seed)))), maxReconnectAttempts: 0 });
  raws.push(control);
  const jsm = await jetstreamManager(control);
  const CHAT = chatStream(space);
  const count = async () => (await jsm.streams.info(CHAT)).state.consumer_count;
  const exists = async (name: string) => jsm.consumers.info(CHAT, name).then(() => true, () => false);
  /** Each history-reader create on CHAT: the consumer name and the inbox nonce its reply names. */
  const seen: { name: string; nonce: string }[] = [];
  for (const subject of [`$JS.API.CONSUMER.CREATE.${CHAT}`, `$JS.API.CONSUMER.CREATE.${CHAT}.>`])
    control.subscribe(subject, { callback: (err, m) => {
      if (err || !m.reply) return;
      const name = (m.json<{ config?: { name?: string } }>().config?.name) ?? "";
      if (name.startsWith("hist_") || name.startsWith("chathist_"))
        seen.push({ name, nonce: m.reply.slice("_INBOX_".length, m.reply.indexOf(".")) });
    } });
  await control.flush();

  const dashBearer = await adminBearer("dashboard");
  const dash = new CotalEndpoint({
    space, servers: SERVERS, bearer: dashBearer, sentinelCreds: callout.sentinelCreds,
    card: { name: "dashboard", kind: "endpoint" },
    channels: [], consume: false, watchPresence: false, registerPresence: false, watchChannels: false,
  });
  dash.on("error", () => {}); await dash.start(); endpoints.push(dash);
  const base = await count();

  // 1. The callout's grant and the endpoint's reader names agree: every read deletes its readers.
  const page = await dash.channelHistory("general", { limit: 5 }).then((r) => r.map(textOf).join("|"), (e: Error) => e.message);
  check("positive control: the user-mode admin endpoint reads the newest page through the callout",
    page === "general 6|general 7|general 8|general 9|general 10", page);
  let answered = 0;
  let first: string | undefined;
  for (let i = 0; i < READS; i++)
    await dash.channelHistory("general", { limit: 5 }).then((r) => { if (r.length === 5) answered++; }, (e: Error) => { first ??= e.message; });
  const afterReads = await count();
  check(`user mode: ${READS} sequential reads all answer and leave no consumer`, answered === READS && afterReads === base, { answered, first, base, afterReads });

  // 2. Two connections of the same principal can share an inbox name but never a reader grant.
  const victim = seen[0];
  check("positive control: the endpoint's reader name and bound inbox name were seen on the wire",
    victim !== undefined && new RegExp(`^${OWNER}-dashboard-[a-z0-9]{25}$`).test(victim.nonce), seen.slice(0, 1));
  await jsm.consumers.add(CHAT, { name: victim.name, ack_policy: AckPolicy.None, mem_storage: true, inactive_threshold: 60_000_000_000 });
  const dialAdmin = async (bearer: string, name: string) => {
    const nc = await connect({
      servers: SERVERS, name, inboxPrefix: `_INBOX_${name}`, reconnect: false, maxReconnectAttempts: 0,
      authenticator: [credsAuthenticator(enc(callout.sentinelCreds)), tokenAuthenticator(bearer)],
    });
    raws.push(nc);
    return nc;
  };
  const checkReaderIsolation = async (bearer: string, name: string, label: string) => {
    const nc = await dialAdmin(bearer, name);
    const otherJsm = await jetstreamManager(nc);
    const admitted = await otherJsm.streams.info(CHAT).then(() => true, () => false);
    check(`positive control: ${label} can read stream info`, admitted);
    const outcome = await otherJsm.consumers.delete(CHAT, victim.name).then(() => "deleted", (e: Error) => e.message);
    const survives = await exists(victim.name);
    check(`user mode: ${label} cannot delete another connection's reader`,
      /permission/i.test(outcome) && survives, { outcome, survives });
    return { outcome, survives };
  };
  const { outcome, survives } = await checkReaderIsolation(dashBearer, victim.nonce, "same principal on a shared bound inbox");
  const otherBearer = await adminBearer("intruder");
  const mismatched = await dialAdmin(otherBearer, userInboxConnId(OWNER, "dashboard")).then(
    () => "admitted", (e: Error) => e.message,
  );
  check("user mode: a different principal is refused a bound name outside its principal",
    /authorization violation/i.test(mismatched), mismatched);
  await checkReaderIsolation(otherBearer, `ibx${randomUUID().replaceAll("-", "")}`, "different principal on its own legacy inbox");
  await jsm.consumers.delete(CHAT, victim.name).catch(() => {});

  // 3. A reconnect is a new connection, so its reader names are new, and reads go on.
  const dashNc = (dash as unknown as { conn: { nc: NatsConnection } }).conn.nc;
  const cidBefore = dashNc.info?.client_id;
  await dashNc.reconnect();
  // The client clears its INFO when it starts to dial and sets it again when the new server's INFO arrives.
  for (let i = 0; i < 50 && (!dashNc.info || dashNc.info.client_id === cidBefore); i++) await wait(100);
  const seenBefore = seen.length;
  const again = await dash.channelHistory("general", { limit: 5 }).then((r) => r.length, (e: Error) => e.message);
  const afterReconnect = await count();
  const moved = seen.slice(seenBefore).map((s) => s.name.slice(0, s.name.lastIndexOf("_")));
  check("user mode: after a reconnect the read answers and leaves no consumer", again === 5 && afterReconnect === base, { again, afterReconnect, base, cidBefore, cidAfter: dashNc.info?.client_id });
  check("user mode: ...under reader names of the new connection, not the old one",
    moved.length > 0 && moved.every((p) => p !== victim.name.slice(0, victim.name.lastIndexOf("_"))), { moved, before: victim.name });

  const chat = chatSubject(space, "*", "*", "general");
  const readerUid = mintLifecycleUid();
  const readerRow = grantActor(dir, { owner: OWNER, actor: "cli", scope: [], lifecycleUid: readerUid, allowSubscribe: ["general"], allowPublish: [] });
  const memberUid = mintLifecycleUid();
  const joinRow = grantActor(dir, { owner: FOREIGN, actor: "general_member", scope: [], lifecycleUid: memberUid, allowSubscribe: ["general"], allowPublish: [] });
  await provisionAgentDurables(mgr, { owner: joinRow.owner, actor: joinRow.actor, lifecycleUid: memberUid }, { subscribe: ["general"] });
  const member = new CotalEndpoint({
    space, servers: SERVERS, bearer: await participantBearer(joinRow), sentinelCreds: callout.sentinelCreds,
    lifecycleUid: memberUid, channels: ["general"], watchPresence: false, registerPresence: false,
    card: { name: joinRow.actor, kind: "agent" },
  });
  endpoints.push(member);
  await member.start();

  let observerNc: NatsConnection | undefined;
  const observer = new CotalEndpoint({
    space, servers: SERVERS, bearer: await participantBearer(readerRow), sentinelCreds: callout.sentinelCreds,
    lifecycleUid: readerUid, channels: [], consume: false, watchPresence: false, registerPresence: false, watchChannels: false,
    omitFromLiveMembership: true, card: { name: "history", kind: "endpoint" },
    onConnection: (nc) => { observerNc = nc; },
  });
  endpoints.push(observer);
  observer.on("error", () => {});
  await observer.start();
  let sawPost = false;
  observer.tap((_subject, message) => { if (message && textOf(message) === "observer follow probe") sawPost = true; }, { subject: chat });
  await observerNc!.flush();
  const followingAt = Date.now();
  const { items } = await observer.channelHistoryPage("general", { limit: 1 });
  check("user mode: the scoped observer reads history using a bound, marked reply inbox", items.length === 1
    && textOf(items[0]!) === "general 10"
    && seen.some(({ nonce }) => new RegExp(`^${OWNER}-cli-_[a-z0-9]{25}$`).test(nonce)));
  await poster.multicast("observer follow probe", { channel: "general" });
  for (let i = 0; i < 100 && !sawPost; i++) await wait(20);
  check("user mode: the bound history observer receives the live post", sawPost);

  feed = await startMembershipFeed({ servers: SERVERS, space, accountId: auth.account.pub,
    observerCreds: await mintMembershipObserverCreds(auth, newIdentity()),
    rwCreds: await mintCreds(auth, newIdentity(), "membership-rw") });
  await feed.poll();
  const census = await dash.readMembership();
  check("user mode: a fresh census includes the joined participant but has no row for the scoped observer",
    (census.asOf ?? 0) >= followingAt && census.members.some((m) => m.id === member.card.id && m.live.includes("general"))
    && !census.members.some((m) => m.id === observer.card.id), census);

  const payloadUid = mintLifecycleUid();
  const payloadWriter = new CotalEndpoint({
    space, servers: SERVERS, lifecycleUid: payloadUid,
    creds: await mintCreds(auth, newIdentity(), "agent", { principal: { owner: OWNER, actor: PAYLOAD_ACTOR }, lifecycleUid: payloadUid }),
    channels: [], consume: false, watchPresence: false, registerPresence: false, watchChannels: false,
    card: { name: "payload_writer", kind: "endpoint", owner: OWNER, actor: PAYLOAD_ACTOR },
  });
  endpoints.push(payloadWriter);
  await payloadWriter.start();
  await payloadWriter.publishEventPayload({ id: "participant-payload-probe", expectedLastSubjectSeq: 0, parts: [{ kind: "text", text: "retained payload" }] });
  const PAYLOAD = eventPayloadStream(space);
  const payloadBase = (await jsm.streams.info(PAYLOAD)).state.consumer_count;
  for (const row of participantRows) {
    const participant = new CotalEndpoint({
      space, servers: SERVERS, bearer: await participantBearer(row), sentinelCreds: callout.sentinelCreds,
      channels: [], consume: false, watchPresence: false, registerPresence: false, watchChannels: false,
      card: { name: row.actor, kind: "endpoint" },
    });
    endpoints.push(participant);
    await participant.start();
    const read = () => participant.eventPayloadHistory(OWNER, PAYLOAD_ACTOR, { limit: 10, signal: AbortSignal.timeout(5000) });
    if (row.actor === "payload_broad") {
      const logStart = brokerLog.length;
      await assert.rejects(read(), /permission/i);
      // The permission reply and the broker's stderr pipe arrive independently.
      let refused: string | undefined;
      const logDeadline = Date.now() + 5000;
      do {
        refused = brokerLog.slice(logStart).split("\n").find(line => line.includes("Publish Violation")
          && line.includes(`$JS.API.CONSUMER.CREATE.${PAYLOAD}.hist_`) && line.includes(`.evp.${OWNER}.${PAYLOAD_ACTOR}`));
        if (refused || Date.now() >= logDeadline) break;
        await wait(20);
      } while (true);
      assert.ok(refused, `the broker logs the foreign payload history permission violation; broker log tail:\n${brokerLog.slice(-8000)}`);
      console.log(refused);
      console.log("PASS participant foreign payload history denied despite chat and event wildcards, with broker permission violation");
    } else {
      for (const rows of await Promise.all([read(), read()]))
        assert.ok(rows.some(message => message.id === "participant-payload-probe"), `${row.actor} reads retained payload history`);
      console.log(`PASS ${row.actor}: concurrent participant payload history reads`);
    }
    assert.equal((await jsm.streams.info(PAYLOAD)).state.consumer_count, payloadBase, "payload history leaves no consumer behind");
    await participant.stop();
  }

  await checkRoutedCallout(control);
  console.log(`  counts ${JSON.stringify({ reads: READS, answered, base, afterReads, outcome, survives, again, afterReconnect })}`);
} finally {
  await feed?.stop();
  for (const nc of raws) await nc.close().catch(() => {});
  for (const ep of endpoints.reverse()) await ep.stop().catch(() => {});
  srv?.kill("SIGKILL");
  await wait(200);
  rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  releaseBroker?.();
}
finish();
