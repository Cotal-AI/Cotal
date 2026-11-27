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
  chatSubject, chatHistDurable, mintMembershipObserverCreds, provisionAgentDurables, startMembershipFeed,
} from "@cotal-ai/core";
import { PLUGIN_CHANNEL_ROOT, pluginChannelStream, pluginChannelFilter, pluginChannelSubject } from "../../../packages/core/src/plugin-channel-route.js";
import { createCalloutAuth, calloutPermissions, deriveOwnerToken, startAuthCallout, USER_TOKEN_VER } from "../src/index.js";
import { grantActor, grantManagedActor, ledgerAclResolver, ledgerAuthorizeConnect, newActorToken } from "../src/ledger.js";
import { pickFreePort } from "./_free-port.js";
import { SMOKE_BROKER_TOKEN, createSuite, teardownOnSignal } from "@cotal-ai/smoke-kit";

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
const calloutDenials: string[] = [];
let feed: Awaited<ReturnType<typeof startMembershipFeed>> | undefined;

async function checkRoutedCallout(control: NatsConnection): Promise<void> {
  const stream = pluginChannelStream(space);
  const channel = `${PLUGIN_CHANNEL_ROOT}.linear.inbox`;
  const filter = pluginChannelSubject(space, "*", "*", channel);
  const manager = await jetstreamManager(control);
  await manager.streams.add({ name: stream, subjects: [pluginChannelFilter(space)], storage: StorageType.Memory });
  routed = true;
  const dial = async (row: ReturnType<typeof grantActor>) => {
    const actor = row.actor;
    const nonce = userInboxConnId(row.owner, row.actor);
    const nc = await connect({ servers: SERVERS,
      authenticator: [credsAuthenticator(enc(callout.sentinelCreds)), tokenAuthenticator(await participantBearer(row))],
      name: nonce, inboxPrefix: `_INBOX_${nonce}`, reconnect: false,
    });
    raws.push(nc);
    return { nc, actor, history: chatHistDurable(row.owner, actor, row.lifecycleUid!) };
  };
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
  check("callout: an explicit plugin grant can open its own retained history", allowed.error === undefined && allowed.num_pending === 1, allowed);
  const denied = await create(broad).then(() => false, (error: unknown) => /permission/i.test(String(error)));
  check("callout: the broker refuses plugin history for a broad chat-only grant", denied);
  const parent = grantActor(dir, { owner: OWNER, actor: "routed_parent", scope: ["spawn"], allowSubscribe: [">"], allowPublish: [">"] });
  const child = grantManagedActor(dir, { owner: OWNER, actor: "routed_child", scope: [], allowSubscribe: [channel], allowPublish: [channel],
    lifecycleUid: mintLifecycleUid(), tokenHash: newActorToken().tokenHash, parent: `${parent.owner}.${parent.actor}`, custody: { kind: "foreground" },
  });
  const deniedChild = await dial(child).then(() => false, () => true);
  check("callout: a routed child cannot inherit plugin read or publish authority from a chat-only parent", deniedChild);
  for (let i = 0; i < 20 && !calloutDenials.some(line => line.includes(channel)); i++) await wait(20);
  check("callout: the rejected child was refused by the ledger bound",
    calloutDenials.some(line => line.includes("exceeds its spawner's CURRENT grant") && line.includes(channel)));
  grantActor(dir, { ...parent, allowSubscribe: [channel], allowPublish: [channel] });
  const allowedChild = await dial(child);
  const held = (await create(allowedChild)).json<{ error?: unknown; num_pending?: number }>();
  check("callout: a routed child can read plugin history its parent explicitly holds", held.error === undefined && held.num_pending === 1, held);
}

try {
  let up = false;
  for (let i = 0; i < 50; i++) { if (await isReachable(SERVERS)) { up = true; break; } await wait(200); }
  if (!up) throw new Error(`nats-server did not come up on ${PORT}`);

  const mgrCreds = await mintCreds(auth, newIdentity(), "provisioner");
  await setupSpaceStreams({ servers: SERVERS, space, creds: mgrCreds });
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
      : ledgerAclResolver(dir)(t, enabled), undefined, undefined, undefined, undefined, undefined, async () => ({ enabled: routed })),
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
