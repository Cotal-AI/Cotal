/**
 * An auth-callout connection's history-reader deletes are keyed on what the server assigned it (#4123).
 *
 * The observer and admin profiles may delete their own history readers, `hist_<readerId>_<n>`. Under
 * the auth callout a connection's connId is the inbox nonce the client chose and passed as its
 * connection name, so deletes keyed on it let one connection claim another's readers by naming the
 * same nonce. The callout now keys them on the server's id and the client id the server assigned the
 * connection, which the client reads from the server's INFO and does not choose.
 *
 * The suite runs the shipped callout and permission builder with two admin-view principals. It reads
 * history through a user-mode endpoint, learning that endpoint's nonce and reader name from its
 * requests on the wire, as any responder sees a reply subject. It then connects as the other principal
 * under the same nonce and tries to delete a reader under the endpoint's name. Last, it reconnects the
 * endpoint, whose reader names move with the new connection, and reads again.
 *
 * Run: pnpm smoke:history-reader-callout:auth   (needs nats-server on PATH; operator-mode callout, local-only)
 */
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect, credsAuthenticator, tokenAuthenticator, type NatsConnection } from "@nats-io/transport-node";
import { AckPolicy, jetstreamManager } from "@nats-io/jetstream";
import { encodeUser, fmtCreds } from "@nats-io/jwt";
import { fromPublic, fromSeed } from "@nats-io/nkeys";
import { SignJWT, generateKeyPair, type CryptoKey } from "jose";
import {
  CotalEndpoint, createSpaceAuth, isReachable, mintCreds, newIdentity, serverConfig, setupSpaceStreams,
  seedChannelRegistry, provisionAgent, mintLifecycleUid, chatStream, type CotalMessage,
} from "@cotal-ai/core";
import { createCalloutAuth, calloutPermissions, deriveOwnerToken, startAuthCallout, USER_TOKEN_VER } from "../src/index.js";
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
const srv = spawn("nats-server", ["-c", join(dir, "server.conf")], { stdio: "ignore" });
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

const endpoints: CotalEndpoint[] = [];
const raws: NatsConnection[] = [];
try {
  let up = false;
  for (let i = 0; i < 50; i++) { if (await isReachable(SERVERS)) { up = true; break; } await wait(200); }
  if (!up) throw new Error(`nats-server did not come up on ${PORT}`);

  const mgrCreds = await mintCreds(auth, newIdentity(), "provisioner");
  await setupSpaceStreams({ servers: SERVERS, space, creds: mgrCreds });
  await seedChannelRegistry({ servers: SERVERS, space, creds: mgrCreds, file: { defaults: { replay: true }, channels: { general: { replay: true } } } });
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
    authorizeActor: () => {},
    permissionsFor: calloutPermissions(() => ({ allowSubscribe: ["general"], allowPublish: [], lifecycleUid: smokeUid, scope: ["admin"] })),
    log: (l) => { if (/denied|drop|fail/i.test(l)) console.log("  [callout]", l); },
  });

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
      if (name.startsWith("hist_")) seen.push({ name, nonce: m.reply.slice("_INBOX_".length, m.reply.indexOf(".")) });
    } });
  await control.flush();

  const dash = new CotalEndpoint({
    space, servers: SERVERS, bearer: await adminBearer("dashboard"), sentinelCreds: callout.sentinelCreds,
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

  // 2. Another principal names the endpoint's nonce and tries to delete a reader under its name.
  const victim = seen[0];
  check("positive control: the endpoint's reader name and nonce were seen on the wire", victim !== undefined && /^ibx[0-9a-f]{32}$/.test(victim.nonce), seen.slice(0, 1));
  await jsm.consumers.add(CHAT, { name: victim.name, ack_policy: AckPolicy.None, mem_storage: true, inactive_threshold: 60_000_000_000 });
  const intruder = await connect({
    servers: SERVERS, name: victim.nonce, inboxPrefix: `_INBOX_${victim.nonce}`, maxReconnectAttempts: 0,
    authenticator: [credsAuthenticator(enc(callout.sentinelCreds)), tokenAuthenticator(await adminBearer("intruder"))],
  });
  raws.push(intruder);
  const intruderJsm = await jetstreamManager(intruder);
  const admitted = await intruderJsm.streams.info(CHAT).then(() => true, () => false);
  check("positive control: the other principal is admitted as an admin view under the same nonce", admitted);
  const outcome = await intruderJsm.consumers.delete(CHAT, victim.name).then(() => "deleted", (e: Error) => e.message);
  const survives = await exists(victim.name);
  check("user mode: a connection naming another's nonce may not delete a reader under the other's name",
    /permission/i.test(outcome) && survives, { outcome, survives });
  await jsm.consumers.delete(CHAT, victim.name).catch(() => {});

  // 3. A reconnect is a new connection, so its reader names are new, and reads go on.
  const dashNc = (dash as unknown as { nc: NatsConnection }).nc;
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

  console.log(`  counts ${JSON.stringify({ reads: READS, answered, base, afterReads, outcome, survives, again, afterReconnect })}`);
} finally {
  for (const nc of raws) await nc.close().catch(() => {});
  for (const ep of endpoints.reverse()) await ep.stop().catch(() => {});
  srv.kill("SIGKILL");
  await wait(200);
  rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  releaseBroker();
}
finish();
