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
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
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
  remoteManagerServePrincipal,
  type RemoteManagedAgentEnrollmentRequest, type SecretStore,
} from "@cotal-ai/core";
import { PLUGIN_CHANNEL_ROOT, pluginChannelStream, pluginChannelFilter, pluginChannelSubject } from "../../../packages/core/src/plugin-channel-route.js";
import { pluginChannelSpaceStateSubject } from "../../../packages/core/src/plugin-channel-space-state.js";
import { recordMesh, userAuthStateDir } from "@cotal-ai/workspace";
import { createCalloutAuth, calloutPermissions, cotalAuthProvider, deriveOwnerToken, ensureCalloutAuth, saveServiceKeys, startAuthCallout, USER_TOKEN_VER } from "../src/index.js";
import { findManagedActor, grantActor, ledgerAclResolver, ledgerAuthorizeConnect, newActorToken } from "../src/ledger.js";
import { pluginChannelStateResolver } from "../src/callout-authority.js";
import { managedAgentAuthority, type ManagedAgentDeps } from "../src/service-managed-agents.js";
import { handleExchange, LOOPBACK_POLICY } from "../src/service-exchange-routes.js";
import { remoteManagerCurrentRegistrationProof } from "../src/retained-manager-validation.js";
import type { HandlerCtx } from "../src/service.js";
import { pickFreePort } from "./_free-port.js";
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
const dir = mkdtempSync(join(tmpdir(), SMOKE_BROKER_TOKEN));
writeFileSync(join(dir, "server.conf"), serverConfig(auth, [auth], { transport: { kind: "plaintext" }, port: PORT, storeDir: join(dir, "js"), extraAccounts: [{ pub: callout.account.pub, jwt: callout.account.jwt }] }));
const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("COTAL_")));
const srv = spawn("nats-server", ["-c", join(dir, "server.conf")], { env, stdio: ["ignore", "ignore", "pipe"] });
let brokerLog = "";
srv.stderr.on("data", (chunk: Buffer) => { brokerLog += chunk.toString(); });
const releaseBroker = teardownOnSignal(srv, dir);

const { publicKey, privateKey } = await generateKeyPair("EdDSA");
const ISS = "https://auth.cotal.test";
const OWNER = deriveOwnerToken("s".repeat(32), "better-auth|history-reader");
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
  const off = await readPluginChannelState(requestedSpace);
  // The shipped reader refuses activation. Only this broker fixture can exercise enabled grants.
  return routed ? { enabled: true } : off;
};
const calloutDenials: string[] = [];
let feed: Awaited<ReturnType<typeof startMembershipFeed>> | undefined;

async function checkRoutedCallout(control: NatsConnection): Promise<void> {
  const stream = pluginChannelStream(space);
  const channel = `${PLUGIN_CHANNEL_ROOT}.linear.inbox`;
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
  routed = true;
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
  const dataAccount = { pub: auth.account.pub, signingSeed: auth.account.signingSeed };
  const manager = { space, actor: "routed_parent", instanceId, managerLifecycleUid, identities: Object.fromEntries(Object.entries(identities).map(([k, { id }]) => [k, { id }])) as RemoteManagedAgentEnrollmentRequest["identities"] };
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
    const local = await checkLocalSpawn(parent([">"]), channel, dataAccount, control);
    const localBearer = await exchange(local);
    assert.equal(localBearer.status, 200);
    assert.ok(localBearer.token);
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
    routed = true;
    const deniedLocal = await exchange(local);
    check("on: exchange refuses a no-record local grant under a chat-only parent",
      deniedLocal.status === 401 && /exceeds its spawner's CURRENT grant/.test(deniedLocal.error ?? "") && !deniedLocal.token);
    const cachedLocal = await dial(findManagedActor(dir, OWNER, local.actor)!, localBearer.token).then(() => false, () => true);
    const localDenial = () => calloutDenials.some(line => line.includes(local.actor) && line.includes("exceeds its spawner's CURRENT grant") && line.includes(channel));
    for (let i = 0; i < 20 && !localDenial(); i++) await wait(20);
    check("on: callout refuses the no-record local grant's previously issued bearer", cachedLocal && localDenial());
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

async function checkLocalSpawn(parent: ReturnType<typeof grantActor>, channel: string, dataAccount: ManagedAgentDeps["dataAccount"], control: NatsConnection) {
  const values = new Map<string, string>();
  const store: SecretStore = {
    get: async key => values.get(key), put: async (key, value) => { values.set(key, value); },
    create: async (key, value) => { if (values.has(key)) return false; values.set(key, value); return true; },
    delete: async key => { values.delete(key); },
  };
  await ensureCalloutAuth(store, { space, operatorSeed: auth.operator.seed, accountPub: auth.account.pub });
  await saveServiceKeys(store, space, { dataAccount });
  const args = { store, dir, space, owner: OWNER, actor: "local_child", parent: `${parent.owner}.${parent.actor}`, scope: [],
    allowSubscribe: [channel], allowPublish: [channel], lifecycleUid: mintLifecycleUid(), custody: { kind: "foreground" as const } };
  const { actorToken } = await cotalAuthProvider.grantAgent(args);
  check("local spawn: no broker registration preserves the legacy grant", findManagedActor(dir, OWNER, args.actor)?.allowPublish[0] === channel);

  const registered = userAuthStateDir(dir, space);
  grantActor(registered, { owner: OWNER, actor: parent.actor, scope: ["spawn"], allowSubscribe: [">"], allowPublish: [">"] });
  const local = { ...args, dir: registered, actor: "registered_child", lifecycleUid: mintLifecycleUid() };
  const home = process.env.COTAL_HOME;
  process.env.COTAL_HOME = join(dir, "registry-home");
  try {
    const record = { space, server: SERVERS, root: dir, mode: "user" as const,
      ts: new Date().toISOString(), userAuth: { provider: "cotal", idp: { url: ISS, issuer: ISS, audience: space } } };
    recordMesh(record);
    await cotalAuthProvider.grantAgent(local);
    const row = findManagedActor(registered, OWNER, local.actor);
    check("local spawn: registered off space grants without a broker argument", row?.parent === args.parent &&
      row.allowSubscribe[0] === channel && row.allowPublish[0] === channel);

    const stateSubject = pluginChannelSpaceStateSubject(space);
    const js = jetstream(control);
    await js.publish(stateSubject, enc(JSON.stringify({ version: 1, epoch: 1, enabled: true })));
    try {
      const on = { ...local, actor: "registered_on_child", lifecycleUid: mintLifecycleUid() };
      await assert.rejects(cotalAuthProvider.grantAgent(on), /this release does not support enabled plugin channels/);
      check("local spawn: registered enabled state reaches the stock refusal before writing", findManagedActor(registered, OWNER, on.actor) === undefined);
    } finally {
      await js.publish(stateSubject, enc(JSON.stringify({ version: 1, epoch: 1, enabled: false })));
    }

    recordMesh({ ...record, server: `nats://127.0.0.1:${await pickFreePort()}` });
    const explicit = { ...local, actor: "explicit_broker_child", lifecycleUid: mintLifecycleUid(), broker: { server: SERVERS } };
    await cotalAuthProvider.grantAgent(explicit);
    check("local spawn: explicit broker takes precedence over the registered target", findManagedActor(registered, OWNER, explicit.actor)?.parent === args.parent);
  } finally {
    if (home === undefined) delete process.env.COTAL_HOME;
    else process.env.COTAL_HOME = home;
  }
  return { actor: args.actor, actorToken };
}

try {
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
  srv.kill("SIGKILL");
  await wait(200);
  rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  releaseBroker();
}
finish();
