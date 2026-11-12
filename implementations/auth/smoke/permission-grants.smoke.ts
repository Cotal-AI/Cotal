/**
 * Who may write, read and answer harness permission prompts, enforced by the broker.
 *
 * The suite runs the shipped callout and permission builder on a real nats-server. Its ACL resolver
 * reports each actor's ledger row kind the way the ledger does: alice's agents `coder` and `helper`
 * and bob's agent `builder` are managed-agent rows, alice's and bob's browser actors `web` are
 * interactive rows, and bob also connects through an admin view.
 *
 *  - An agent writes records only under its own `<owner>.<actor>` prefix.
 *  - Only an interactive row reads records, only its own owner's, and only through an ordered
 *    consumer whose filter rides the create subject. A teammate, a space admin and every agent are
 *    refused, and so is any point read.
 *  - Only an interactive row asks an agent to apply an answer, and the agent replies on the request's
 *    own `.reply.` leaf. No agent can ask on its own prompt or a sibling's, and no other owner or
 *    admin can ask or listen.
 *
 * Each refusal is matched to the broker's permission violation for that exact subject, and the
 * stream's message and consumer counts, read by a test-only allow-all user, show nothing got through.
 *
 * Run: pnpm smoke:permission-grants:auth   (needs nats-server on PATH; operator-mode callout, local-only)
 */
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect, credsAuthenticator, PermissionViolationError, tokenAuthenticator, type NatsConnection } from "@nats-io/transport-node";
import { DeliverPolicy, jetstream, jetstreamManager } from "@nats-io/jetstream";
import { encodeUser, fmtCreds } from "@nats-io/jwt";
import { fromPublic, fromSeed } from "@nats-io/nkeys";
import { SignJWT, generateKeyPair, type CryptoKey } from "jose";
import {
  createSpaceAuth, isReachable, mintCreds, mintLifecycleUid, newIdentity, parsePermissionRecord, permissionAnswerSubject,
  permissionBucket, permissionOwnerFilter, permissionServeFilter, serverConfig, setupSpaceStreams, spacePrefix,
} from "@cotal-ai/core";
import { createCalloutAuth, calloutPermissions, deriveOwnerToken, startAuthCallout, USER_TOKEN_VER, type AclResolver } from "../src/index.js";
import { pickFreePort } from "./_free-port.js";
import { SMOKE_BROKER_TOKEN, createSuite, killAndAwaitExit, teardownOnSignal } from "@cotal-ai/smoke-kit";

const { check, finish } = createSuite();
const enc = (s: string) => new TextEncoder().encode(s);
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const messageOf = (e: unknown) => (e instanceof Error ? e.message : String(e));
async function until(done: () => boolean, ms = 3000): Promise<boolean> {
  for (const end = Date.now() + ms; !done(); await wait(25)) if (Date.now() > end) return false;
  return true;
}

const PORT = await pickFreePort();
const SERVERS = `nats://127.0.0.1:${PORT}`;
const space = `perm-grants-${randomUUID().slice(0, 8)}`;
const auth = await createSpaceAuth(space);
const callout = await createCalloutAuth({ space, operatorSeed: auth.operator.seed, accountPub: auth.account.pub });
const dir = mkdtempSync(join(tmpdir(), SMOKE_BROKER_TOKEN));
writeFileSync(join(dir, "server.conf"), serverConfig(auth, [auth], { transport: { kind: "plaintext" }, port: PORT, storeDir: join(dir, "js"), extraAccounts: [{ pub: callout.account.pub, jwt: callout.account.jwt }] }));
const srv = spawn("nats-server", ["-c", join(dir, "server.conf")], { stdio: "ignore" });
const releaseBroker = teardownOnSignal(srv, dir);

const { publicKey, privateKey } = await generateKeyPair("EdDSA");
const ISS = "https://auth.cotal.test";
const ALICE = deriveOwnerToken("s".repeat(32), "better-auth|alice");
const BOB = deriveOwnerToken("s".repeat(32), "better-auth|bob");
const BUCKET = permissionBucket(space);
const STREAM = `KV_${BUCKET}`;

interface Who { owner: string; actor: string; kind: "interactive" | "managed-agent"; scope: string[]; view?: "admin"; uid: string }
const who = (owner: string, actor: string, kind: Who["kind"], extra: Partial<Who> = {}): Who =>
  ({ owner, actor, kind, scope: [], uid: mintLifecycleUid(), ...extra });
const W = {
  coder: who(ALICE, "coder", "managed-agent"),
  helper: who(ALICE, "helper", "managed-agent"),
  web: who(ALICE, "web", "interactive"),
  teammate: who(BOB, "web", "interactive"),
  builder: who(BOB, "builder", "managed-agent"),
  admin: who(BOB, "console", "interactive", { scope: ["admin"], view: "admin" }),
};
const rows = new Map(Object.values(W).map((w) => [`${w.owner}.${w.actor}`, w]));
const resolveAcl: AclResolver = (t) => {
  const w = rows.get(`${t.owner}.${t.act.actor}`);
  if (!w) throw new Error(`no ledger row for ${t.owner}.${t.act.actor}`);
  return { allowSubscribe: [], allowPublish: [], lifecycleUid: w.uid, scope: w.scope, kind: w.kind };
};

async function bearer(w: Who): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({ sub: w.owner, ver: USER_TOKEN_VER, act: { owner: w.owner, actor: w.actor, scope: w.scope, lifecycleUid: w.uid, ...(w.view ? { view: w.view } : {}) } })
    .setProtectedHeader({ alg: "EdDSA" }).setIssuer(ISS).setAudience(space).setSubject(w.owner)
    .setIssuedAt(now - 60).setNotBefore(now - 60).setExpirationTime(now + 600)
    .sign(privateKey as CryptoKey);
}

interface Seat { nc: NatsConnection; nonce: string; refused: { operation: string; subject: string }[] }
const raws: NatsConnection[] = [];
async function seat(w: Who): Promise<Seat> {
  const nonce = `ibx${randomUUID().replace(/-/g, "")}`;
  const nc = await connect({
    servers: SERVERS, name: nonce, inboxPrefix: `_INBOX_${nonce}`, maxReconnectAttempts: 0,
    authenticator: [credsAuthenticator(enc(callout.sentinelCreds)), tokenAuthenticator(await bearer(w))],
  });
  raws.push(nc);
  const s: Seat = { nc, nonce, refused: [] };
  void (async () => {
    for await (const status of nc.status())
      if (status.type === "error" && status.error instanceof PermissionViolationError)
        s.refused.push({ operation: status.error.operation, subject: status.error.subject });
  })().catch(() => {});
  return s;
}
const refusedFor = (s: Seat, operation: string, subject: string) => () => s.refused.some((r) => r.operation === operation && r.subject === subject);
async function publishRefused(s: Seat, subject: string): Promise<boolean> {
  s.nc.publish(subject, enc("{}"));
  await s.nc.flush();
  return until(refusedFor(s, "publish", subject));
}
async function subscribeRefused(s: Seat, subject: string): Promise<boolean> {
  s.nc.subscribe(subject, { callback: () => {} });
  await s.nc.flush().catch(() => {});
  return until(refusedFor(s, "subscription", subject));
}

const record = (owner: string, actor: string, id: string) => JSON.stringify({
  v: 1, id, agent: `${owner}.${actor}`, holder: { lifecycleUid: mintLifecycleUid(), runtimeId: randomUUID() }, tool: "Bash",
  input: { kind: "shown", value: { command: "npm test" } }, askedAt: Date.now(), state: { kind: "pending" },
});
const write = (s: Seat, owner: string, actor: string, id: string) =>
  jetstream(s.nc).publish(`$KV.${BUCKET}.${owner}.${actor}.${id}`, enc(record(owner, actor, id))).then(() => "landed", messageOf);

/** Read every record under `filter` through an ordered consumer, as the dashboard's reader will. */
async function read(s: Seat, filter: string): Promise<{ keys: string[]; parsed: number } | string> {
  try {
    const consumer = await jetstream(s.nc).consumers.getPushConsumer(STREAM, { filter_subjects: filter, deliver_policy: DeliverPolicy.LastPerSubject });
    const keys: string[] = [];
    let parsed = 0;
    if ((await consumer.info(true)).num_pending > 0)
      for await (const m of await consumer.consume()) {
        const key = m.subject.slice(`$KV.${BUCKET}.`.length);
        keys.push(key);
        if (parsePermissionRecord(m.json(), key)) parsed++;
        if (m.info.pending === 0) break;
      }
    return { keys: keys.sort(), parsed };
  } catch (e) {
    return messageOf(e);
  }
}

try {
  let up = false;
  for (let i = 0; i < 50 && !up; i++) { up = await isReachable(SERVERS); if (!up) await wait(200); }
  if (!up) throw new Error(`nats-server did not come up on ${PORT}`);
  await setupSpaceStreams({ servers: SERVERS, space, creds: await mintCreds(auth, newIdentity(), "provisioner") });

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
    permissionsFor: calloutPermissions(resolveAcl),
    log: (l) => { if (/denied|drop|fail/i.test(l)) console.log("  [callout]", l); },
  });

  const inspectorId = newIdentity();
  const inspectorJwt = await encodeUser("permission-grants-inspector", fromPublic(inspectorId.id), fromPublic(auth.account.pub),
    { pub: { allow: [">"] }, sub: { allow: [">"] } }, { signer: fromSeed(enc(auth.account.signingSeed)) });
  const inspector = await connect({ servers: SERVERS, authenticator: credsAuthenticator(fmtCreds(inspectorJwt, fromSeed(enc(inspectorId.seed)))), maxReconnectAttempts: 0 });
  raws.push(inspector);
  const jsm = await jetstreamManager(inspector);
  const state = async () => (await jsm.streams.info(STREAM)).state;

  const coder = await seat(W.coder), helper = await seat(W.helper), web = await seat(W.web);
  const teammate = await seat(W.teammate), builder = await seat(W.builder), admin = await seat(W.admin);
  const seats = [coder, helper, web, teammate, builder, admin];
  check(`every principal connects through the shipped callout (${seats.filter((s) => !s.nc.isClosed()).length} of ${seats.length})`,
    seats.length === 6 && seats.every((s) => !s.nc.isClosed()));

  // ── Records: an agent writes only under its own prefix ──────────────────────────────────────
  const [A, B, C, D, X] = ["a", "b", "c", "d", "x"].map((ch) => ch.repeat(26));
  const own = [
    await write(coder, ALICE, "coder", A), await write(coder, ALICE, "coder", B),
    await write(helper, ALICE, "helper", C), await write(builder, BOB, "builder", D),
  ];
  check(`every agent writes records under its own prefix (${own.filter((r) => r === "landed").length} of 4)`, own.every((r) => r === "landed"), own);
  const crossing: [string, Seat, string, string][] = [
    ["an agent under its sibling's prefix", coder, ALICE, "helper"],
    ["an agent under another owner's agent", coder, BOB, "builder"],
    ["a sibling under the agent's prefix", helper, ALICE, "coder"],
    ["another owner's agent under the agent's prefix", builder, ALICE, "coder"],
    ["the owner's interactive row under the agent's prefix", web, ALICE, "coder"],
  ];
  const crossed = [];
  for (const [name, s, owner, actor] of crossing) {
    const outcome = await write(s, owner, actor, X);
    if (!/permission/i.test(outcome)) crossed.push({ name, outcome });
  }
  check(`no principal writes under another agent's prefix (${crossing.length - crossed.length} of ${crossing.length} refused)`, crossed.length === 0, crossed);
  check("...so the store holds exactly the four own-prefix records", (await state()).messages === 4, await state());

  // ── Reads: only an interactive row, only its own owner's, only through an ordered consumer ──
  const aliceReads = await read(web, permissionOwnerFilter(space, ALICE));
  check("the owner's interactive row reads its owner's three records through an ordered consumer, each a record",
    typeof aliceReads === "object" && aliceReads.parsed === 3 &&
      aliceReads.keys.join() === [`${ALICE}.coder.${A}`, `${ALICE}.coder.${B}`, `${ALICE}.helper.${C}`].join(), aliceReads);
  const bobReads = await read(teammate, permissionOwnerFilter(space, BOB));
  check("a teammate's interactive row reads only its own owner's one record",
    typeof bobReads === "object" && bobReads.keys.join() === `${BOB}.builder.${D}`, bobReads);

  const consumersBefore = (await state()).consumer_count;
  const readers: [string, Seat, string][] = [
    ["a teammate", teammate, permissionOwnerFilter(space, ALICE)],
    ["a space admin", admin, permissionOwnerFilter(space, ALICE)],
    ["the agent itself, over its owner's records", coder, permissionOwnerFilter(space, ALICE)],
    ["the agent itself, over its own records", coder, `$KV.${BUCKET}.${ALICE}.coder.>`],
    ["a sibling agent", helper, permissionOwnerFilter(space, ALICE)],
  ];
  const leaked = [];
  for (const [name, s, filter] of readers) {
    const outcome = await read(s, filter);
    if (typeof outcome !== "string" || !/permission/i.test(outcome)) leaked.push({ name, outcome });
  }
  check(`no agent, teammate or admin reads alice's records (${readers.length - leaked.length} of ${readers.length} refused)`, leaked.length === 0, leaked);

  const lastOfCoder = { last_by_subj: `$KV.${BUCKET}.${ALICE}.coder.${A}` };
  const pointReads: [string, () => Promise<unknown>][] = [
    ["the interactive row's stream info", async () => (await jetstreamManager(web.nc)).streams.info(STREAM)],
    ["the interactive row's direct get", async () => (await jetstreamManager(web.nc)).direct.getMessage(STREAM, lastOfCoder)],
    ["the interactive row's message get", async () => (await jetstreamManager(web.nc)).streams.getMessage(STREAM, lastOfCoder)],
    ["the admin's stream info", async () => (await jetstreamManager(admin.nc)).streams.info(STREAM)],
    ["the admin's message get", async () => (await jetstreamManager(admin.nc)).streams.getMessage(STREAM, lastOfCoder)],
  ];
  const pointLeaks = [];
  for (const [name, attempt] of pointReads) {
    const outcome = await attempt().then(() => "answered", messageOf);
    if (!/permission/i.test(outcome)) pointLeaks.push({ name, outcome });
  }
  check(`no point read reaches the store (${pointReads.length - pointLeaks.length} of ${pointReads.length} refused)`, pointLeaks.length === 0, pointLeaks);

  // The read grant names the filter in the create subject; the broker must hold the body to it.
  const bodies: [string, Record<string, unknown>][] = [
    ["another owner's filter in the body", { filter_subject: permissionOwnerFilter(space, ALICE) }],
    ["another owner's filter as a filter list", { filter_subjects: [permissionOwnerFilter(space, ALICE)] }],
    ["no filter in the body", {}],
  ];
  type ApiReply = { error?: { code?: number; description?: string } };
  const mismatched = [], brokerSaid: string[] = [];
  for (const [name, body] of bodies) {
    const consumer = `probe_${randomUUID().slice(0, 8)}`;
    const reply = await teammate.nc.request(`$JS.API.CONSUMER.CREATE.${STREAM}.${consumer}.${permissionOwnerFilter(space, BOB)}`,
      enc(JSON.stringify({ stream_name: STREAM, config: { name: consumer, deliver_subject: `_INBOX_${teammate.nonce}.${consumer}`, ack_policy: "none", mem_storage: true, ...body } })),
      { timeout: 3000 }).then((m) => m.json<ApiReply>(), (e): ApiReply => ({ error: { description: messageOf(e) } }));
    if (typeof reply.error?.code !== "number") mismatched.push({ name, reply });
    brokerSaid.push(`${reply.error?.code} ${reply.error?.description}`);
  }
  console.log(`  broker refusals ${JSON.stringify(brokerSaid)}`);
  check(`a create under the teammate's own filter but naming another body is refused by the broker (${bodies.length - mismatched.length} of ${bodies.length})`,
    mismatched.length === 0, mismatched);
  check(`...and none of those ${readers.length + bodies.length} refused creates left a consumer behind`,
    (await state()).consumer_count === consumersBefore, { before: consumersBefore, after: (await state()).consumer_count });

  // ── Answers: only the owner's interactive row asks, and the agent replies on the request's leaf ──
  const served: string[] = [];
  coder.nc.subscribe(permissionServeFilter(space, ALICE, "coder"), {
    callback: (err, m) => { if (!err) { served.push(m.subject); m.respond(enc(`reply ${served.length}`)); } },
  });
  await coder.nc.flush();
  const ask = permissionAnswerSubject(space, ALICE, "coder", ALICE, "web");
  const replyTo = `${ask}.reply.${randomUUID().replace(/-/g, "")}`;
  const replies: string[] = [];
  web.nc.subscribe(replyTo, { max: 1, callback: (err, m) => { if (!err) replies.push(m.string()); } });
  await web.nc.flush();
  web.nc.publish(ask, enc("{}"), { reply: replyTo });
  await until(() => replies.length === 1);
  check("the owner's interactive row asks the agent, which replies on the request's .reply. leaf",
    served.join() === ask && replies.join() === "reply 1", { served, replies });

  const forged: [string, Seat, string][] = [
    ["the agent asking on its own prompt as itself", coder, permissionAnswerSubject(space, ALICE, "coder", ALICE, "coder")],
    ["the agent asking on its own prompt as its owner's browser", coder, ask],
    ["a sibling asking on the agent's prompt as itself", helper, permissionAnswerSubject(space, ALICE, "coder", ALICE, "helper")],
    ["a sibling asking on the agent's prompt as its owner's browser", helper, ask],
    ["the agent asking on its sibling's prompt", coder, permissionAnswerSubject(space, ALICE, "helper", ALICE, "coder")],
    ["a teammate asking on the agent's prompt", teammate, permissionAnswerSubject(space, ALICE, "coder", BOB, "web")],
    ["a space admin asking on the agent's prompt", admin, permissionAnswerSubject(space, ALICE, "coder", BOB, "console")],
    ["a sibling replying on the agent's reply leaf", helper, `${replyTo}.forged`],
  ];
  const sent = [];
  for (const [name, s, subject] of forged) if (!(await publishRefused(s, subject))) sent.push(name);
  await wait(200);
  check(`no agent, sibling, teammate or admin asks or replies (${forged.length - sent.length} of ${forged.length} refused)`, sent.length === 0, sent);
  check("...so the agent served one request and the browser got one reply", served.length === 1 && replies.length === 1, { served, replies });

  const snoops: [string, Seat, string][] = [
    ["a sibling", helper, permissionServeFilter(space, ALICE, "coder")],
    ["a teammate", teammate, permissionServeFilter(space, ALICE, "coder")],
    ["a space admin, over the whole rail", admin, `${spacePrefix(space)}.perm.>`],
    ["the agent, over its owner's browser's replies", coder, `${permissionAnswerSubject(space, ALICE, "*", ALICE, "web")}.reply.*`],
  ];
  const heard = [];
  for (const [name, s, subject] of snoops) if (!(await subscribeRefused(s, subject))) heard.push(name);
  check(`no one else listens on the rail (${snoops.length - heard.length} of ${snoops.length} refused)`, heard.length === 0, heard);

  console.log(`  counts ${JSON.stringify({ records: (await state()).messages, served: served.length, replies: replies.length, refusedWrites: crossing.length, refusedReads: readers.length + pointReads.length + bodies.length, refusedAsks: forged.length, refusedListens: snoops.length })}`);
} finally {
  for (const nc of raws) await nc.close().catch(() => {});
  await killAndAwaitExit(srv);
  rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  releaseBroker();
}
finish();
