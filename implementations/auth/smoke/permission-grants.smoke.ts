/**
 * Who may write, read and answer harness permission prompts, enforced by the broker.
 *
 * The suite runs the shipped callout and permission builder on a real nats-server. Its ACL resolver
 * reports each actor's ledger row kind the way the ledger does: alice's agents `coder` and `helper`
 * and bob's agent `builder` are managed-agent rows, alice's and bob's browser actors `web` are
 * interactive rows, and bob also connects through an admin view.
 *
 *  - An agent writes records only under its own `<owner>.<actor>` prefix.
 *  - Only an interactive row reads records, only its own owner's, and only by binding its own
 *    lifecycle's reader, which the provisioner opens. A teammate, a space admin and every agent are
 *    refused, and so is any point read.
 *  - No principal creates a consumer on the bucket, whatever its body: a durable or push consumer
 *    aimed at an agent's inbox would export every later prompt. A pull asks for at most 4 records and
 *    30 s, one at a time, so a pull parked for an accomplice moves at most 4 records, and the owner's
 *    next open ends it.
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
import { jetstream, jetstreamManager } from "@nats-io/jetstream";
import { encodeUser, fmtCreds } from "@nats-io/jwt";
import { fromPublic, fromSeed } from "@nats-io/nkeys";
import { SignJWT, generateKeyPair, type CryptoKey } from "jose";
import {
  CotalEndpoint, PERMISSION_READER_BATCH, createSpaceAuth, isReachable, mintCreds, mintLifecycleUid, newIdentity, parsePermissionRecord,
  permissionAnswerSubject, permissionBucket, permissionOwnerFilter, permissionReaderDurable, permissionServeFilter, serverConfig,
  setupSpaceStreams, spacePrefix,
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
const endpoints: CotalEndpoint[] = [];
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

const readerOf = (w: Who) => permissionReaderDurable(w.owner, w.actor, w.uid);
/** Read every record through `reader`'s consumer, as the dashboard's watch does: bind it, then pull
 *  until nothing is pending. Every pull runs to its end, so none is left waiting on the broker. */
async function read(s: Seat, reader: Who): Promise<{ keys: string[]; parsed: number } | string> {
  try {
    const consumer = await jetstream(s.nc).consumers.get(STREAM, readerOf(reader));
    let pending = (await consumer.info(true)).num_pending;
    const keys: string[] = [];
    let parsed = 0;
    for (let pulls = 0; pending > 0 && pulls < 20; pulls++)
      for await (const m of await consumer.fetch({ max_messages: PERMISSION_READER_BATCH, expires: 2000 })) {
        const key = m.subject.slice(`$KV.${BUCKET}.`.length);
        keys.push(key);
        if (parsePermissionRecord(m.json(), key)) parsed++;
        pending = m.info.pending;
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
  const provisionerCreds = await mintCreds(auth, newIdentity(), "provisioner");
  await setupSpaceStreams({ servers: SERVERS, space, creds: provisionerCreds });
  // The trusted side: a provisioner endpoint opens each reader, as Cloud's backend does.
  const provisioner = new CotalEndpoint({ space, servers: SERVERS, creds: provisionerCreds, card: { name: "provisioner", kind: "endpoint" }, consume: false, registerPresence: false, watchPresence: false });
  provisioner.on("error", () => {});
  await provisioner.start();
  endpoints.push(provisioner);
  const opened = new Set<string>();
  const open = async (w: Who) => { await provisioner.openPermissionReader({ owner: w.owner, actor: w.actor, lifecycleUid: w.uid }); opened.add(readerOf(w)); };

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

  // ── Reads: only an interactive row, only its own owner's, only through its own reader ─────────
  await open(W.web);
  await open(W.teammate);
  const aliceReads = await read(web, W.web);
  check("the owner's interactive row reads its owner's three records by binding the reader the provisioner opened, each a record",
    typeof aliceReads === "object" && aliceReads.parsed === 3 &&
      aliceReads.keys.join() === [`${ALICE}.coder.${A}`, `${ALICE}.coder.${B}`, `${ALICE}.helper.${C}`].join(), aliceReads);
  const bobReads = await read(teammate, W.teammate);
  check("a teammate's interactive row reads only its own owner's one record",
    typeof bobReads === "object" && bobReads.keys.join() === `${BOB}.builder.${D}`, bobReads);

  await open(W.coder);
  const readers: [string, Seat, Who][] = [
    ["a teammate, through alice's reader", teammate, W.web],
    ["a space admin, through alice's reader", admin, W.web],
    ["the agent, through its owner's reader", coder, W.web],
    ["a sibling agent, through its owner's reader", helper, W.web],
    ["alice's row, through the teammate's reader", web, W.teammate],
    ["the agent, through a reader opened under its own name", coder, W.coder],
  ];
  const leaked = [];
  for (const [name, s, reader] of readers) {
    const outcome = await read(s, reader);
    if (typeof outcome !== "string" || !/permission/i.test(outcome)) leaked.push({ name, outcome });
  }
  check(`no principal binds a reader that is not its own interactive lifecycle's (${readers.length - leaked.length} of ${readers.length} refused)`, leaked.length === 0, leaked);

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

  // ── The reviewer's exporter: a durable or push consumer aimed at the agent's inbox ───────────
  const exporterSeat = await seat(W.web);
  const coderInbox = `_INBOX_${coder.nonce}.exporter`;
  const exported: string[] = [];
  // A JetStream delivery keeps its stored subject, so count everything this subscription receives.
  coder.nc.subscribe(coderInbox, { callback: (err, m) => { if (!err) exported.push(m.subject); } });
  await coder.nc.flush();
  const aliceFilter = permissionOwnerFilter(space, ALICE);
  const exporterCreates: [string, string, Record<string, unknown>][] = [
    ["a durable push consumer delivering to the agent's inbox", `$JS.API.CONSUMER.CREATE.${STREAM}.exporter_a.${aliceFilter}`,
      { durable_name: "exporter_a", deliver_subject: coderInbox, ack_policy: "none", filter_subject: aliceFilter }],
    ["an ephemeral push consumer delivering to the agent's inbox", `$JS.API.CONSUMER.CREATE.${STREAM}.exporter_b.${aliceFilter}`,
      { name: "exporter_b", deliver_subject: coderInbox, ack_policy: "none", filter_subject: aliceFilter, mem_storage: true }],
    ["a durable pull consumer", `$JS.API.CONSUMER.CREATE.${STREAM}.exporter_c.${aliceFilter}`,
      { durable_name: "exporter_c", ack_policy: "none", filter_subject: aliceFilter }],
    ["a consumer under alice's own reader name", `$JS.API.CONSUMER.CREATE.${STREAM}.${readerOf(W.web)}.${aliceFilter}`,
      { durable_name: readerOf(W.web), deliver_subject: coderInbox, ack_policy: "none", filter_subject: aliceFilter }],
    ["a legacy durable create", `$JS.API.CONSUMER.DURABLE.CREATE.${STREAM}.exporter_d`,
      { durable_name: "exporter_d", deliver_subject: coderInbox, ack_policy: "none", filter_subject: aliceFilter }],
    ["an unnamed create", `$JS.API.CONSUMER.CREATE.${STREAM}`,
      { deliver_subject: coderInbox, ack_policy: "none", filter_subject: aliceFilter, mem_storage: true }],
  ];
  const landed = [];
  for (const [name, subject] of exporterCreates)
    if (!(await publishRefused(exporterSeat, subject))) landed.push(name);
  // The probes above publish an empty body; the same subjects with a full create body must be refused too.
  for (const [name, subject, config] of exporterCreates) {
    const reply = await exporterSeat.nc.request(subject, enc(JSON.stringify({ stream_name: STREAM, config })), { timeout: 3000 })
      .then((m) => m.json<{ error?: unknown }>(), (e) => ({ error: messageOf(e) }));
    if (reply.error === undefined) landed.push(`${name} (with a body)`);
  }
  await exporterSeat.nc.close();
  const lateWrite = await write(coder, ALICE, "coder", "e".repeat(26));
  await wait(500);
  check(`an interactive row creates no consumer on the records bucket, durable, push or pull (${exporterCreates.length * 2 - landed.length} of ${exporterCreates.length * 2} refused)`,
    landed.length === 0, landed);
  check("...so after it disconnects, a new record reaches no subject it chose, and the bucket holds only the readers the provisioner opened",
    lateWrite === "landed" && exported.length === 0 && (await state()).consumer_count === opened.size,
    { lateWrite, exported: exported.length, consumers: (await state()).consumer_count, opened: opened.size });

  const creators: [string, Seat][] = [["the agent", coder], ["a sibling agent", helper], ["a teammate's interactive row", teammate], ["a space admin", admin]];
  const created = [];
  for (const [who, s] of creators)
    for (const [name, subject] of exporterCreates)
      if (!(await publishRefused(s, subject))) created.push(`${who}: ${name}`);
  check(`no agent, teammate or admin creates a consumer on the records bucket either (${creators.length * exporterCreates.length - created.length} of ${creators.length * exporterCreates.length} refused)`,
    created.length === 0, created);

  // ── What a pull may ask for, as the broker holds it ──────────────────────────────────────────
  const next = (w: Who) => `$JS.API.CONSUMER.MSG.NEXT.${STREAM}.${readerOf(w)}`;
  /** The broker's status reply to one pull, `<code> <description>`, or "none". */
  async function pullStatus(s: Seat, body: Record<string, unknown>, reply: string): Promise<string> {
    let status = "none";
    const sub = s.nc.subscribe(reply, { callback: (err, m) => { if (!err && m.headers?.code) status = `${m.headers.code} ${m.headers.description}`; } });
    await s.nc.flush();
    s.nc.publish(next(W.web), enc(JSON.stringify(body)), { reply });
    await until(() => status !== "none", 1500);
    sub.unsubscribe();
    return status;
  }
  const limits: [string, Record<string, unknown>, RegExp][] = [
    ["a batch above 4", { batch: PERMISSION_READER_BATCH + 1, expires: 1e9 }, /409.*MaxRequestBatch/],
    ["a wait above 30 s", { batch: 1, expires: 31e9 }, /409.*MaxRequestExpires/],
    ["more bytes than four records", { batch: 1, expires: 1e9, max_bytes: PERMISSION_READER_BATCH * 262_144 + 1 }, /409.*MaxRequestMaxBytes/],
  ];
  const unbounded = [], limitSaid: string[] = [];
  for (const [name, body, expected] of limits) {
    const said = await pullStatus(web, body, `_INBOX_${web.nonce}.limit.${limitSaid.length}`);
    limitSaid.push(said);
    if (!expected.test(said)) unbounded.push({ name, said });
  }
  console.log(`  pull refusals ${JSON.stringify(limitSaid)}`);
  check(`the broker refuses a pull that asks for more than 4 records, 30 s or four records' bytes (${limits.length - unbounded.length} of ${limits.length})`,
    unbounded.length === 0, unbounded);

  // A pull with no wait outlives its connection while someone else listens on its reply subject. Here
  // the accomplice is the agent: its inbox is where alice's revoked session aims the pull.
  const parkedInbox = `_INBOX_${coder.nonce}.parked`;
  const parked: string[] = [], parkedStatus: string[] = [];
  coder.nc.subscribe(`${parkedInbox}.>`, { callback: (err, m) => {
    if (err) return;
    if (m.headers?.code) parkedStatus.push(`${m.headers.code} ${m.headers.description}`);
    else parked.push(m.subject);
  } });
  await coder.nc.flush();
  const letters = "abcdefghijklmnopqrstuvwxyz";
  const writeMany = async (n: number, tag: string) => {
    for (let i = 0; i < n; i++) await write(coder, ALICE, "coder", `${tag}${"z".repeat(26)}`.slice(0, 25) + letters[i]);
  };
  /** A fresh reader, read to its end by `thief`, then one pull of `batch` with no wait aimed at the agent. */
  async function park(round: string): Promise<{ second: string }> {
    await open(W.web);
    const thief = await seat(W.web);
    await read(thief, W.web);
    thief.nc.publish(next(W.web), enc(JSON.stringify({ batch: PERMISSION_READER_BATCH })), { reply: `${parkedInbox}.${round}` });
    await thief.nc.flush();
    const second = await pullStatus(thief, { batch: PERMISSION_READER_BATCH }, `_INBOX_${thief.nonce}.second`);
    await thief.nc.close();
    return { second };
  }
  const first = await park("one");
  check("the reader holds one waiting pull: a second, while the first is parked, is refused", /409.*MaxWaiting/.test(first.second), first);
  await writeMany(2, "ra");
  await until(() => parked.length === 2, 3000);
  const beforeOpen = parked.length;
  await open(W.web);
  await writeMany(3, "rb");
  await wait(700);
  check("a pull parked by a session that has left delivers to its accomplice until the owner's next open, which ends it",
    beforeOpen === 2 && parked.length === 2, { beforeOpen, after: parked.length, status: parkedStatus });
  await park("two");
  const capBefore = parked.length;
  await writeMany(PERMISSION_READER_BATCH + 2, "rc");
  await wait(1000);
  check(`...and it moves at most ${PERMISSION_READER_BATCH} records, however many are written (${parked.length - capBefore} of ${PERMISSION_READER_BATCH + 2})`,
    parked.length - capBefore === PERMISSION_READER_BATCH, { moved: parked.length - capBefore });

  // ── Answers: only the owner's interactive row asks, and the agent replies on the request's leaf ──
  // The holder binds the subject of its own runtime; its grant covers every runtime of its own agent.
  const RUNTIME = randomUUID();
  const served: string[] = [];
  coder.nc.subscribe(permissionServeFilter(space, ALICE, "coder", RUNTIME), {
    callback: (err, m) => { if (!err) { served.push(m.subject); m.respond(enc(`reply ${served.length}`)); } },
  });
  await coder.nc.flush();
  const ask = permissionAnswerSubject(space, ALICE, "coder", RUNTIME, ALICE, "web");
  const replyTo = `${ask}.reply.${randomUUID().replace(/-/g, "")}`;
  const replies: string[] = [];
  web.nc.subscribe(replyTo, { max: 1, callback: (err, m) => { if (!err) replies.push(m.string()); } });
  await web.nc.flush();
  web.nc.publish(ask, enc("{}"), { reply: replyTo });
  await until(() => replies.length === 1);
  check("the owner's interactive row asks the agent, which replies on the request's .reply. leaf",
    served.join() === ask && replies.join() === "reply 1", { served, replies });

  const forged: [string, Seat, string][] = [
    ["the agent asking on its own prompt as itself", coder, permissionAnswerSubject(space, ALICE, "coder", RUNTIME, ALICE, "coder")],
    ["the agent asking on its own prompt as its owner's browser", coder, ask],
    ["a sibling asking on the agent's prompt as itself", helper, permissionAnswerSubject(space, ALICE, "coder", RUNTIME, ALICE, "helper")],
    ["a sibling asking on the agent's prompt as its owner's browser", helper, ask],
    ["the agent asking on its sibling's prompt", coder, permissionAnswerSubject(space, ALICE, "helper", RUNTIME, ALICE, "coder")],
    ["a teammate asking on the agent's prompt", teammate, permissionAnswerSubject(space, ALICE, "coder", RUNTIME, BOB, "web")],
    ["a space admin asking on the agent's prompt", admin, permissionAnswerSubject(space, ALICE, "coder", RUNTIME, BOB, "console")],
    ["a sibling replying on the agent's reply leaf", helper, `${replyTo}.forged`],
  ];
  const sent = [];
  for (const [name, s, subject] of forged) if (!(await publishRefused(s, subject))) sent.push(name);
  await wait(200);
  check(`no agent, sibling, teammate or admin asks or replies (${forged.length - sent.length} of ${forged.length} refused)`, sent.length === 0, sent);
  check("...so the agent served one request and the browser got one reply", served.length === 1 && replies.length === 1, { served, replies });

  const snoops: [string, Seat, string][] = [
    ["a sibling, over every runtime of the agent", helper, permissionServeFilter(space, ALICE, "coder", "*")],
    ["a teammate, over every runtime of the agent", teammate, permissionServeFilter(space, ALICE, "coder", "*")],
    ["a space admin, over the whole rail", admin, `${spacePrefix(space)}.perm.>`],
    ["the agent, over its owner's browser's replies", coder, `${permissionAnswerSubject(space, ALICE, "*", "*", ALICE, "web")}.reply.*`],
  ];
  const heard = [];
  for (const [name, s, subject] of snoops) if (!(await subscribeRefused(s, subject))) heard.push(name);
  check(`no one else listens on the rail (${snoops.length - heard.length} of ${snoops.length} refused)`, heard.length === 0, heard);

  console.log(`  counts ${JSON.stringify({ records: (await state()).messages, served: served.length, replies: replies.length, refusedWrites: crossing.length, refusedReads: readers.length + pointReads.length, refusedCreates: exporterCreates.length * 2 + creators.length * exporterCreates.length, parked: parked.length, refusedAsks: forged.length, refusedListens: snoops.length })}`);
} finally {
  for (const ep of endpoints) await ep.stop().catch(() => {});
  for (const nc of raws) await nc.close().catch(() => {});
  await killAndAwaitExit(srv);
  rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  releaseBroker();
}
finish();
