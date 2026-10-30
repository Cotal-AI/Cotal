/**
 * Anycast request status, live (SPEC §8.1): a real delivery daemon on a JWT-auth broker records each
 * role request's take, answers its sender's status and cancel, and sends the sender a notice naming
 * the holder that took it. Covers:
 *  - a take, its notice from the delivery lease holder, the status it leaves, a refused cancel;
 *  - a cancel before any take, the delete it makes, and the take it then refuses;
 *  - take and cancel raced on one request: exactly one wins, every time;
 *  - a redelivery after the first taker lost its copy: the record moves, the sender is told, and the
 *    first taker's stale retry is refused;
 *  - role pinning: a take on another role's request is refused, and a role the credential does not
 *    hold is denied by the broker;
 *  - a foreign sender learns nothing and cancels nothing;
 *  - no daemon, and a daemon that predates takes, hold the request instead of showing it;
 *  - a current daemon on a credential minted before the records still arms Plane-3, and every
 *    anycast op names that credential;
 *  - the notice outbox survives a failed send, and the maintenance pass ages rows out only after
 *    their request left the queue;
 *  - an open-mesh endpoint refuses status and cancel;
 *  - a cancel whose delete reply was lost is finished by its retry, and a removal left pending
 *    across a stream recreation never deletes the new stream's request at that seq.
 *
 * Run: pnpm smoke:anycast-request-status:auth   (needs `nats-server` on PATH; local-only)
 */
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect, credsAuthenticator, type NatsConnection } from "@nats-io/transport-node";
import { jetstream, jetstreamManager, type JetStreamManager } from "@nats-io/jetstream";
import { Kvm } from "@nats-io/kv";
import { decode, encodeUser, fmtCreds, fromPublic, fromSeed, type User } from "@nats-io/jwt";
import {
  ANYCAST_NOTICE_KEY,
  ANYCAST_RECORD_RETENTION_MS,
  ANYCAST_RECORDS_CREDENTIAL_OUTDATED,
  AnycastRequestAuthority,
  anycastSubject,
  CONTROL_DELIVERY,
  CotalEndpoint,
  DEV_OWNER,
  anycastBucket,
  anycastRecordKey,
  createSpaceAuth,
  decideTake,
  isReachable,
  mintCreds,
  mintLifecycleUid,
  newIdentity,
  provisionAgent,
  serverConfig,
  setupSpaceStreams,
  takeSubject,
  taskDurableConfig,
  taskStream,
  type AnycastNotice,
  type AnycastRecord,
  type AnycastTakeOutcome,
  type AnycastTakeReply,
  type AnycastTakeRequest,
  type CotalMessage,
  type Delivery,
  type MessageMeta,
} from "../src/index.js";
import { nativeNkeySigner } from "../src/nkey-signer.js";
import { pickFreePort } from "./_free-port.js";
import { SMOKE_BROKER_TOKEN, awaitBrokerReady, createSuite, teardownOnSignal } from "@cotal-ai/smoke-kit";

const PORT = await pickFreePort();
const SERVERS = `nats://127.0.0.1:${PORT}`;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const { check, finish } = createSuite();
const awaitExit = (proc: ReturnType<typeof spawn>, timeoutMs = 3000): Promise<void> =>
  new Promise((resolve) => {
    if (proc.exitCode !== null || proc.signalCode !== null) return resolve();
    proc.once("exit", () => resolve());
    setTimeout(resolve, timeoutMs);
  });
async function until<T>(read: () => T | undefined, ms = 8000): Promise<T | undefined> {
  const deadline = Date.now() + ms;
  for (;;) {
    const v = read();
    if (v !== undefined || Date.now() > deadline) return v;
    await sleep(50);
  }
}

const space = `anycast-status-${randomUUID().slice(0, 8)}`;
const auth = await createSpaceAuth(space);
const dir = mkdtempSync(join(tmpdir(), SMOKE_BROKER_TOKEN));
writeFileSync(join(dir, "server.conf"), serverConfig(auth, [auth], { transport: { kind: "plaintext" }, port: PORT, storeDir: join(dir, "js") }));
const srv = spawn("nats-server", ["-c", join(dir, "server.conf")], { stdio: "ignore" });
const releaseBroker = teardownOnSignal(srv, dir);

const QUICK_ACK_MS = 2_000;
const endpoints: CotalEndpoint[] = [];
const conns: NatsConnection[] = [];

type Got = { msg: CotalMessage; delivery: Delivery; kind: MessageMeta["kind"] };

try {
  await awaitBrokerReady(() => isReachable(SERVERS), { servers: SERVERS, attempts: 50, delayMs: 200 });
  const provIdent = newIdentity();
  const provCreds = await mintCreds(auth, provIdent, "provisioner");
  await setupSpaceStreams({ servers: SERVERS, space, creds: provCreds });
  const mgr = new CotalEndpoint({ space, servers: SERVERS, creds: provCreds, card: { name: "mgr", kind: "endpoint" }, consume: false, registerPresence: false, watchPresence: false });
  mgr.on("error", () => {});
  await mgr.start();
  endpoints.push(mgr);
  const provNc = await connect({ servers: SERVERS, authenticator: credsAuthenticator(new TextEncoder().encode(provCreds)), inboxPrefix: `_INBOX_${provIdent.id}`, maxReconnectAttempts: 0 });
  conns.push(provNc);
  const provJsm = await jetstreamManager(provNc);
  // The queue is read the way the daemon reads it: only the delivery credential may.
  const dIdent = newIdentity();
  const dCreds = await mintCreds(auth, dIdent, "delivery");
  const dNc = await connect({ servers: SERVERS, authenticator: credsAuthenticator(new TextEncoder().encode(dCreds)), inboxPrefix: `_INBOX_${dIdent.id}`, maxReconnectAttempts: 0 });
  conns.push(dNc);
  const dJsm: JetStreamManager = await jetstreamManager(dNc);
  // The "quick" role's queue gets a short ack wait, so a redelivery lands inside the suite.
  const provisioner = {
    commitAcl: mgr.commitAcl.bind(mgr),
    reissueAcl: mgr.reissueAcl.bind(mgr),
    provisionDmInbox: mgr.provisionDmInbox.bind(mgr),
    provisionDlvInbox: mgr.provisionDlvInbox.bind(mgr),
    provisionTaskQueue: async (role: string) => {
      await provJsm.consumers.add(taskStream(space), taskDurableConfig(space, role, role === "quick" ? { ackWaitMs: QUICK_ACK_MS } : {}));
    },
  };

  let daemonLease: number | undefined;
  const startDaemon = async (): Promise<CotalEndpoint> => {
    const d = new CotalEndpoint({
      space, servers: SERVERS, creds: await mintCreds(auth, newIdentity(), "delivery"), channels: [],
      consume: false, watchPresence: false, registerPresence: false,
      card: { name: "delivery", role: "delivery", kind: "endpoint" },
    });
    d.on("error", () => {});
    d.on("warning", () => {});
    await d.start();
    await d.startPlane3((owner, uid) => d.aclForOwner(owner, uid));
    // The lease the agents check a notice's sender against.
    daemonLease = await d.acquireDeliveryLease(0);
    endpoints.push(d);
    return d;
  };
  let daemon = await startDaemon();

  const mkAgent = async (name: string, role?: string) => {
    const ident = newIdentity();
    const uid = mintLifecycleUid();
    const creds = await provisionAgent(provisioner, auth, ident, { subscribe: [], allowSubscribe: [], role, lifecycleUid: uid });
    const got: Got[] = [];
    const errors: string[] = [];
    const make = (consume = true) => {
      const ep = new CotalEndpoint({ space, servers: SERVERS, creds, card: { name, role, kind: "agent", id: ident.id }, channels: [], lifecycleUid: uid, consume });
      ep.on("error", (e: Error) => errors.push(e.message));
      ep.on("warning", () => {});
      ep.on("message", (msg: CotalMessage, delivery: Delivery, meta?: MessageMeta) => got.push({ msg, delivery, kind: meta?.kind ?? "dm" }));
      return ep;
    };
    const ep = make();
    await ep.start();
    endpoints.push(ep);
    return { name, id: `${DEV_OWNER}.${ident.id}`, creds, ep, got, errors, make };
  };

  const sender = await mkAgent("sender");
  const foreign = await mkAgent("foreign");
  const x = await mkAgent("reviewer_x", "reviewer");

  const nextRequest = (a: { got: Got[] }, seen: Set<string>, id?: string) =>
    until(() => a.got.find((g) => g.kind === "anycast" && !seen.has(`${g.msg.id}:${g.delivery.redelivery?.deliveryCount}`) && (id === undefined || g.msg.id === id)));
  const noticesFor = (a: { got: Got[] }) => a.got
    .filter((g) => g.kind === "dm")
    .map((g) => ({ g, part: g.msg.parts.find((p) => p.kind === "data") as { kind: "data"; data: Record<string, AnycastNotice> } | undefined }))
    .filter((n) => n.part?.data?.[ANYCAST_NOTICE_KEY] !== undefined)
    .map((n) => ({ from: n.g.msg.from.id, id: n.g.msg.id, notice: n.part!.data[ANYCAST_NOTICE_KEY]! }));
  const queued = async (seq: number) => (await dJsm.streams.getMessage(taskStream(space), { seq })) !== null;
  const taskEpoch = async () => (await dJsm.streams.info(taskStream(space))).created;
  // A take written by the test for a copy of the current stream, through the endpoint's own take path.
  const takeAs = async (ep: CotalEndpoint, role: string, seq: number, id: string, count = 1) =>
    (ep as unknown as { takeAnycast(r: string, s: number, id: string, c: number, e: string): Promise<AnycastTakeOutcome> })
      .takeAnycast(role, seq, id, count, await taskEpoch());
  const seen = new Set<string>();
  const mark = (g: Got) => seen.add(`${g.msg.id}:${g.delivery.redelivery?.deliveryCount}`);

  // ── 1. take → notice → status → refused cancel ──────────────────────────────────────────────
  console.log("[1] a take is recorded, announced and kept");
  const s1 = await sender.ep.anycastAttributed("reviewer", "please review the plan");
  const g1 = await nextRequest(x, seen, s1.msg.id);
  check("1a the holder's copy carries a take", typeof g1?.delivery.take === "function");
  check("1b before the take the sender reads waiting", (await sender.ep.anycastStatus(s1.ack.seq)).state === "waiting");
  const t1 = await g1!.delivery.take!();
  check("1c the take is recorded", t1.taken === true, t1);
  check("1d a retry of the same take is the same answer", (await g1!.delivery.take!()).taken === true);
  mark(g1!);
  const leaseHolder = await sender.ep.deliveryLeaseHolder(0);
  const n1 = await until(() => noticesFor(sender).find((n) => n.notice.seq === s1.ack.seq));
  check("1e the sender gets a notice naming the taker", n1?.notice.event === "taken" && n1.notice.taker.id === x.id, n1);
  check("1f the notice comes from the delivery lease holder", n1 !== undefined && n1.from === leaseHolder, { from: n1?.from, leaseHolder });
  await sleep(300);
  check("1g one notice, not one per take attempt", noticesFor(sender).filter((n) => n.notice.seq === s1.ack.seq).length === 1);
  const st1 = await sender.ep.anycastStatus(s1.ack.seq, s1.msg.id);
  check("1h status names the taker", st1.state === "taken" && st1.taker.id === x.id && st1.taker.name === "reviewer_x", st1);
  const c1 = await sender.ep.cancelAnycast(s1.ack.seq);
  check("1i a cancel after the take is refused with the taker", c1.state === "taken" && c1.taker.id === x.id, c1);
  check("1j the refused cancel left the request on the queue", await queued(s1.ack.seq));
  check("1k a foreign sender reads nothing", (await foreign.ep.anycastStatus(s1.ack.seq)).state === "unknown");
  check("1l a foreign sender cancels nothing", (await foreign.ep.cancelAnycast(s1.ack.seq)).state === "unknown" && await queued(s1.ack.seq));
  check("1m a wrong id reads nothing", (await sender.ep.anycastStatus(s1.ack.seq, randomUUID())).state === "unknown");
  g1!.delivery.ack();
  await sleep(200);
  check("1n after the holder acks, the record still names the taker", (await sender.ep.anycastStatus(s1.ack.seq)).state === "taken");

  // ── 2. cancel before any take ───────────────────────────────────────────────────────────────
  console.log("[2] a cancel before the take wins and is final");
  const s2 = await sender.ep.anycastAttributed("reviewer", "never mind this one");
  const g2 = await nextRequest(x, seen, s2.msg.id);
  mark(g2!);
  const c2 = await sender.ep.cancelAnycast(s2.ack.seq, s2.msg.id);
  check("2a the cancel wins and removes the request", c2.state === "cancelled" && c2.removal === "deleted", c2);
  check("2b the request is off the queue", !(await queued(s2.ack.seq)));
  const t2 = await g2!.delivery.take!();
  check("2c the holder's take is refused as cancelled, so its copy is dropped unseen", !t2.taken && t2.drop && t2.reason === "cancelled", t2);
  const c2b = await sender.ep.cancelAnycast(s2.ack.seq, s2.msg.id);
  check("2d a retried cancel gets the same answer", c2b.state === "cancelled" && c2b.removal === "deleted", c2b);
  check("2e status reads cancelled", (await sender.ep.anycastStatus(s2.ack.seq)).state === "cancelled");
  check("2f no notice for a cancelled request", !noticesFor(sender).some((n) => n.notice.seq === s2.ack.seq));

  // ── 3. take and cancel raced ────────────────────────────────────────────────────────────────
  console.log("[3] take and cancel raced: exactly one wins");
  const RACES = 12;
  let consistent = 0;
  let takeWins = 0;
  for (let i = 0; i < RACES; i++) {
    const s = await sender.ep.anycastAttributed("reviewer", `race ${i}`);
    const g = await nextRequest(x, seen, s.msg.id);
    mark(g!);
    // Alternate which call is issued first, so both losing orders are exercised. A cancel that
    // throws found the row changed under it, which is a race without one winner.
    const cancelOf = () => sender.ep.cancelAnycast(s.ack.seq).catch((e: Error) => ({ state: "threw" as const, error: e.message }));
    const [take, cancel] = i % 2 === 0
      ? await Promise.all([g!.delivery.take!(), cancelOf()])
      : await Promise.all([cancelOf(), g!.delivery.take!()]).then(([c, t]) => [t, c] as const);
    const after = await sender.ep.anycastStatus(s.ack.seq);
    const won = take.taken && cancel.state === "taken" && after.state === "taken" && await queued(s.ack.seq);
    const lost = !take.taken && take.drop && take.reason === "cancelled" && cancel.state === "cancelled" && after.state === "cancelled" && !(await queued(s.ack.seq));
    if (won !== lost) consistent++;
    if (won) { takeWins++; g!.delivery.ack(); }
  }
  check(`3a every race had exactly one winner and a matching status (${consistent}/${RACES})`, consistent === RACES);
  console.log(`    (takes won ${takeWins}, cancels won ${RACES - takeWins})`);

  // ── 4. redelivery moves the record ──────────────────────────────────────────────────────────
  console.log("[4] a redelivery after the first taker lost its copy moves the take");
  const q1 = await mkAgent("quick_1", "quick");
  const s4 = await sender.ep.anycastAttributed("quick", "quick job");
  const g4 = await nextRequest(q1, seen, s4.msg.id);
  mark(g4!);
  check("4a the first taker takes delivery 1", g4?.delivery.redelivery?.deliveryCount === 1 && (await g4!.delivery.take!()).taken === true);
  await q1.ep.stop(); // it never acks: the broker redelivers after the ack wait
  const q2 = await mkAgent("quick_2", "quick");
  const g4b = await until(() => q2.got.find((g) => g.kind === "anycast" && g.msg.id === s4.msg.id), QUICK_ACK_MS * 4);
  check("4b the second holder gets delivery 2", g4b?.delivery.redelivery?.deliveryCount === 2, g4b?.delivery.redelivery);
  check("4c its take of the later delivery is recorded", (await g4b!.delivery.take!()).taken === true);
  const n4 = await until(() => noticesFor(sender).find((n) => n.notice.seq === s4.ack.seq && n.notice.event === "redelivered"));
  check("4d the sender is told who lost it and who took it", n4?.notice.previous?.id === q1.id && n4.notice.taker.id === q2.id, n4);
  const st4 = await sender.ep.anycastStatus(s4.ack.seq);
  check("4e status names the new taker and the earlier one", st4.state === "taken" && st4.taker.id === q2.id && st4.previous?.id === q1.id, st4);
  const q1again = q1.make(false);
  await q1again.start();
  endpoints.push(q1again);
  const stale = await takeAs(q1again, "quick", s4.ack.seq, s4.msg.id, 1);
  check("4f the first taker's stale retry is refused, so it drops its copy", !stale.taken && stale.drop && stale.reason === "taken", stale);
  g4b!.delivery.ack();

  // ── 5. role pinning and mismatches ──────────────────────────────────────────────────────────
  console.log("[5] a take is pinned to the role and the request");
  const s5 = await sender.ep.anycastAttributed("quick", "only for quick holders");
  const r5a = await takeAs(x.ep, "reviewer", s5.ack.seq, s5.msg.id);
  check("5a a reviewer naming a quick request under its own role is refused", !r5a.taken && r5a.drop && r5a.reason === "mismatch", r5a);
  const r5b = await takeAs(x.ep, "quick", s5.ack.seq, s5.msg.id);
  check("5b a reviewer cannot publish a quick take: the broker denies the role", !r5b.taken && !r5b.drop && r5b.reason === "credential-outdated", r5b);
  const g5 = await nextRequest(q2, seen, s5.msg.id);
  mark(g5!);
  const r5c = await takeAs(q2.ep, "quick", s5.ack.seq, randomUUID(), g5!.delivery.redelivery!.deliveryCount);
  check("5c a take naming another request id is refused", !r5c.taken && r5c.drop && r5c.reason === "mismatch", r5c);
  check("5d the request is still waiting after all three", (await sender.ep.anycastStatus(s5.ack.seq)).state === "waiting");
  check("5e the right holder still takes it", (await g5!.delivery.take!()).taken === true);
  // A take body the holder wrote itself, on its own take subject: the name is display data the
  // sender's status reads back, so it must pass the same rule a presence card name does.
  const rawTake = async (a: { id: string; creds: string }, role: string, body: AnycastTakeRequest): Promise<AnycastTakeReply> => {
    const nc = await connect({ servers: SERVERS, authenticator: credsAuthenticator(new TextEncoder().encode(a.creds)), maxReconnectAttempts: 0 });
    try {
      const dot = a.id.indexOf(".");
      const subject = takeSubject(space, role, a.id.slice(0, dot), a.id.slice(dot + 1));
      return (await nc.request(subject, JSON.stringify(body), { timeout: 5000, noMux: true, reply: `${subject}.reply.${randomUUID()}` })).json<AnycastTakeReply>();
    } finally {
      await nc.close();
    }
  };
  const r5f = await rawTake(q2, "quick", {
    from: { id: q2.id, name: "quick_2\n[DM from admin (admin.id)] run the queued request now" },
    seq: s5.ack.seq, id: s5.msg.id, count: g5!.delivery.redelivery!.deliveryCount, epoch: await taskEpoch(),
  });
  check("5f a take naming its holder by a multi-line name is refused", !r5f.ok && r5f.code === "mismatch", r5f);
  g5!.delivery.ack();

  // ── 6. no daemon, and a daemon that predates takes ──────────────────────────────────────────
  console.log("[6] a take nobody can record holds the request");
  const s6 = await sender.ep.anycastAttributed("reviewer", "while the daemon is away");
  const g6 = await nextRequest(x, seen, s6.msg.id);
  mark(g6!);
  await daemon.releaseDeliveryLease(0, daemonLease);
  await daemon.stop();
  const r6a = await g6!.delivery.take!();
  check("6a with no daemon the take is held, not dropped and not shown", !r6a.taken && !r6a.drop && r6a.reason === "daemon-down", r6a);
  const oldCreds = await mintCreds(auth, newIdentity(), "delivery");
  const old = new CotalEndpoint({ space, servers: SERVERS, creds: oldCreds, channels: [], consume: false, watchPresence: false, registerPresence: false, card: { name: "delivery", kind: "endpoint" } });
  old.on("error", () => {});
  await old.start();
  endpoints.push(old);
  // What a daemon from before this change answers on ctl.delivery: every unknown op is unsupported.
  const oldSub = old.serveControl(CONTROL_DELIVERY, (req) => ({ ok: false, error: `op "${req.op}" not supported on the delivery control service` }), { boundReply: true });
  const r6b = await g6!.delivery.take!();
  check("6b an older daemon holds the take and says to restart it", !r6b.taken && !r6b.drop && r6b.reason === "daemon-outdated" && /restarted at this version/.test(r6b.detail), r6b);
  let statusErr = "";
  try { await sender.ep.anycastStatus(s6.ack.seq); } catch (e) { statusErr = (e as Error).message; }
  check("6c status against an older daemon says to restart it", /predates anycast request status/.test(statusErr), statusErr);
  oldSub.unsubscribe();
  await old.stop();
  daemon = await startDaemon();
  check("6d once a current daemon is back the held take is recorded", (await g6!.delivery.take!()).taken === true);
  g6!.delivery.ack();

  // A daemon at this version on a delivery credential minted before the records existed: today's
  // delivery profile with the anycast rows taken out, signed by the space.
  const preAnycastDeliveryCreds = async (): Promise<string> => {
    const ident = newIdentity();
    const jwt = (await mintCreds(auth, ident, "delivery")).split("\n").find((l) => l.startsWith("eyJ"))!;
    const { name, nats } = decode<Partial<User>>(jwt);
    const anycastRow = (r: string) =>
      r.includes(anycastBucket(space)) || r.includes(`cotal.${space}.take.`) || r.includes(taskStream(space)) || r.startsWith(`cotal.${space}.inst.*.*.`);
    const pub = { ...nats.pub, allow: nats.pub!.allow!.filter((r) => !anycastRow(r)) };
    const sub = { ...nats.sub, allow: nats.sub!.allow!.filter((r) => !anycastRow(r)) };
    const signer = nativeNkeySigner(new TextEncoder().encode(auth.account.signingSeed));
    const old = await encodeUser(name, fromPublic(ident.id), fromPublic(auth.account.pub), { ...nats, pub, sub }, { signer });
    return new TextDecoder().decode(fmtCreds(old, fromSeed(new TextEncoder().encode(ident.seed))));
  };
  const s6e = await sender.ep.anycastAttributed("reviewer", "while the daemon's credential is old");
  const g6e = await nextRequest(x, seen, s6e.msg.id);
  mark(g6e!);
  await daemon.releaseDeliveryLease(0, daemonLease);
  await daemon.stop();
  const staleDaemon = new CotalEndpoint({
    space, servers: SERVERS, creds: await preAnycastDeliveryCreds(), channels: [],
    consume: false, watchPresence: false, registerPresence: false,
    card: { name: "delivery", role: "delivery", kind: "endpoint" },
  });
  const staleWarnings: string[] = [];
  staleDaemon.on("error", () => {});
  staleDaemon.on("warning", (e: Error) => staleWarnings.push(e.message));
  await staleDaemon.start();
  endpoints.push(staleDaemon);
  let armError = "";
  try { await staleDaemon.startPlane3((owner, uid) => staleDaemon.aclForOwner(owner, uid)); } catch (e) { armError = (e as Error).message; }
  check("6e a daemon on a credential from before the records still arms Plane-3", armError === "", armError);
  check("6f it says why it records no takes", staleWarnings.some((w) => w.includes(ANYCAST_RECORDS_CREDENTIAL_OUTDATED)), staleWarnings);
  const r6g = await g6e!.delivery.take!();
  check(
    "6g a holder's take is held and names the daemon's credential",
    !r6g.taken && !r6g.drop && r6g.reason === "daemon-outdated" && r6g.detail.includes(ANYCAST_RECORDS_CREDENTIAL_OUTDATED),
    r6g,
  );
  let staleStatus = "";
  try { await sender.ep.anycastStatus(s6e.ack.seq); } catch (e) { staleStatus = (e as Error).message; }
  check("6h a sender's status names the daemon's credential", staleStatus.includes(ANYCAST_RECORDS_CREDENTIAL_OUTDATED), staleStatus);
  await staleDaemon.stop();
  daemon = await startDaemon();
  check("6i once the daemon runs on a current credential the held take is recorded", (await g6e!.delivery.take!()).taken === true);
  g6e!.delivery.ack();

  // ── 7. the authority itself: outbox and maintenance ─────────────────────────────────────────
  console.log("[7] the notice outbox survives a failed send; rows age out only after their request left");
  const kv = await new Kvm(dNc).open(anycastBucket(space));
  let clock = Date.now();
  let failSend = true;
  const sent: string[] = [];
  const authority = new AnycastRequestAuthority({
    jsm: dJsm, kv, stream: taskStream(space),
    send: async (_to, event) => { if (failSend) throw new Error("injected send failure"); sent.push(event.key); },
    mayAct: () => true,
    onError: () => {},
    now: () => clock,
  });
  const s7 = await sender.ep.anycastAttributed("reviewer", "outbox");
  const g7 = await nextRequest(x, seen, s7.msg.id);
  mark(g7!);
  const r7 = await authority.take("reviewer", { from: { id: x.id, name: "reviewer_x" }, seq: s7.ack.seq, id: s7.msg.id, count: g7!.delivery.redelivery!.deliveryCount, epoch: await taskEpoch() });
  check("7a the take is recorded even though its notice could not be sent", r7.ok);
  const epoch = (await dJsm.streams.info(taskStream(space))).created;
  const key = anycastRecordKey(epoch, s7.ack.seq);
  await sleep(200);
  const row7 = (await kv.get(key))?.json<AnycastRecord>();
  check("7b the owed notice stays in the row's outbox", row7?.outbox.length === 1, row7?.outbox);
  failSend = false;
  await authority.sweep();
  const row7b = (await kv.get(key))?.json<AnycastRecord>();
  check("7c the maintenance pass sends it and clears the outbox", sent.length === 1 && row7b?.outbox.length === 0, { sent, outbox: row7b?.outbox });
  check("7d a request still queued gets no leftAt", row7b?.leftAt === undefined);
  g7!.delivery.ack();
  await sleep(200);
  await authority.sweep();
  const row7c = (await kv.get(key))?.json<AnycastRecord>();
  check("7e once the request left the queue the pass notes when", typeof row7c?.leftAt === "number");
  clock += ANYCAST_RECORD_RETENTION_MS - 60_000;
  await authority.sweep();
  check("7f the row is kept inside the retention", (await kv.get(key))?.operation === "PUT");
  clock += 2 * 60_000;
  await authority.sweep();
  const gone = await kv.get(key);
  check("7g the row is removed after the retention", gone === null || gone.operation !== "PUT");

  // ── 8. pure decisions ───────────────────────────────────────────────────────────────────────
  console.log("[8] the take decision");
  const stored = { role: "r", sender: "local.S", id: "m1" };
  const base = { epoch: "e", seq: 9, now: 1 };
  const first = decideTake(undefined, stored, { ...base, holder: { id: "local.A", name: "a" }, count: 1 });
  check("8a a first take creates the row with one notice", first.reply.ok && first.next?.taker?.id === "local.A" && first.next.outbox.length === 1);
  const same = decideTake(first.next, stored, { ...base, holder: { id: "local.B", name: "b" }, count: 1 });
  check("8b another holder on the same delivery is refused", !same.reply.ok && same.reply.code === "taken" && same.next === undefined);
  const again = decideTake(first.next, stored, { ...base, holder: { id: "local.A", name: "a" }, count: 2 });
  check("8c the same holder on a later delivery moves silently", again.reply.ok && again.next?.taker?.count === 2 && again.next.previous === undefined && again.next.outbox.length === 1);
  const moved = decideTake(first.next, stored, { ...base, holder: { id: "local.B", name: "b" }, count: 2 });
  check("8d another holder on a later delivery moves it and owes a notice", moved.reply.ok && moved.next?.previous?.id === "local.A" && moved.next.outbox.at(-1)?.notice.event === "redelivered");

  // ── 9. open mesh ────────────────────────────────────────────────────────────────────────────
  console.log("[9] an open mesh keeps no record");
  const open = new CotalEndpoint({ space, servers: SERVERS, card: { name: "open", kind: "agent" } });
  let openErr = "";
  try { await open.anycastStatus(1); } catch (e) { openErr = (e as Error).message; }
  check("9a status on an open mesh is refused, naming why", /open mesh runs no delivery daemon/.test(openErr), openErr);

  // ── 10. a lost delete reply; a stream recreated under a pending removal ─────────────────────
  // Last, because it deletes and recreates the TASK stream.
  console.log("[10] a cancel whose delete reply was lost, and a removal pending across a stream recreation");
  let loseDeleteReply = false;
  const lossyJsm = {
    streams: {
      info: (name: string) => dJsm.streams.info(name),
      getMessage: (name: string, q: { seq: number }) => dJsm.streams.getMessage(name, q),
      deleteMessage: async (name: string, seq: number, erase?: boolean) => {
        const done = await dJsm.streams.deleteMessage(name, seq, erase);
        if (loseDeleteReply) { loseDeleteReply = false; throw new Error("injected: the delete's reply was lost"); }
        return done;
      },
    },
  } as unknown as JetStreamManager;
  const auth10 = new AnycastRequestAuthority({ jsm: lossyJsm, kv, stream: taskStream(space), send: async () => {}, mayAct: () => true, onError: () => {} });
  // A request no holder takes stays queued below the cancelled one, so the retried delete names a seq
  // inside the stream's range. nats-server answers that with `sequence <n> not found`, and one below
  // the stream's first seq with `no message found`.
  await sender.ep.anycastAttributed("idle", "stays on the queue below the cancelled request");
  const s10 = await sender.ep.anycastAttributed("reviewer", "a cancel whose reply is lost");
  const g10 = await nextRequest(x, seen, s10.msg.id);
  mark(g10!);
  loseDeleteReply = true;
  let lostError = "";
  try { await auth10.cancel(sender.id, { seq: s10.ack.seq, id: s10.msg.id }); } catch (e) { lostError = (e as Error).message; }
  check("10a the first cancel deleted the request and lost the reply", /reply was lost/.test(lostError) && !(await queued(s10.ack.seq)), lostError);
  const c10 = await auth10.cancel(sender.id, { seq: s10.ack.seq, id: s10.msg.id });
  check("10b the retried cancel finishes the removal as already gone", c10.state === "cancelled" && c10.removal === "already-gone", c10);
  const t10 = await g10!.delivery.take!();
  check("10c the holder's copy is refused as cancelled", !t10.taken && t10.drop && t10.reason === "cancelled", t10);

  const s10b = await sender.ep.anycastAttributed("reviewer", "pending across a recreation");
  const g10b = await nextRequest(x, seen, s10b.msg.id);
  mark(g10b!);
  // A daemon that stopped right after its cancel fence leaves the row with its removal pending.
  const epochBefore = (await dJsm.streams.info(taskStream(space))).created;
  const pendingKey = anycastRecordKey(epochBefore, s10b.ack.seq);
  const pendingRow: AnycastRecord = {
    v: 1, epoch: epochBefore, seq: s10b.ack.seq, id: s10b.msg.id, role: "reviewer", sender: sender.id, rev: 1,
    state: "cancelled", removal: "pending", outbox: [],
  };
  await kv.create(pendingKey, JSON.stringify(pendingRow));
  // The queue is recreated, and the new stream reaches the same seq with another request.
  const teardownIdent = newIdentity();
  const teardownCreds = await mintCreds(auth, teardownIdent, "teardown", { lifecycleUid: mintLifecycleUid() });
  const teardownNc = await connect({ servers: SERVERS, authenticator: credsAuthenticator(new TextEncoder().encode(teardownCreds)), inboxPrefix: `_INBOX_${teardownIdent.id}`, maxReconnectAttempts: 0 });
  conns.push(teardownNc);
  await (await jetstreamManager(teardownNc)).streams.delete(taskStream(space));
  await setupSpaceStreams({ servers: SERVERS, space, creds: provCreds });
  // As a restore can: fill the new stream up to the seq, then store the same request there again.
  for (let i = 1; i < s10b.ack.seq; i++) await sender.ep.anycastAttributed("reviewer", `new stream ${i}`);
  const senderNc = await connect({ servers: SERVERS, authenticator: credsAuthenticator(new TextEncoder().encode(sender.creds)), inboxPrefix: `_INBOX_${sender.id.slice(sender.id.indexOf(".") + 1)}`, maxReconnectAttempts: 0 });
  conns.push(senderNc);
  const replay = await jetstream(senderNc).publish(
    anycastSubject(space, "reviewer", DEV_OWNER, sender.id.slice(sender.id.indexOf(".") + 1)),
    JSON.stringify(s10b.msg),
    { msgID: s10b.msg.id },
  );
  const reused = replay.seq === s10b.ack.seq ? { seq: replay.seq, id: s10b.msg.id } : undefined;
  check("10d the new stream stores the same request at the same seq", reused !== undefined, { replayed: replay.seq, original: s10b.ack.seq });
  const t10b = await g10b!.delivery.take!();
  check("10e a holder's copy from the old stream is refused as a mismatch", !t10b.taken && t10b.drop && t10b.reason === "mismatch", t10b);
  check("10f and the replayed request still waits, cancellable", (await sender.ep.anycastStatus(s10b.ack.seq, s10b.msg.id)).state === "waiting");
  await auth10.sweep();
  const after10 = (await kv.get(pendingKey))?.json<AnycastRecord>();
  check("10g the pending removal is recorded as already gone", after10?.state === "cancelled" && after10.removal === "already-gone", after10);
  const kept = await dJsm.streams.getMessage(taskStream(space), { seq: s10b.ack.seq });
  const keptId = kept ? (JSON.parse(new TextDecoder().decode(kept.data)) as { id?: string }).id : undefined;
  check("10h the new stream's request at that seq was not deleted", keptId !== undefined && keptId === reused?.id, { keptId, reused });
  check("10i the sender reads the new request as waiting", (await sender.ep.anycastStatus(s10b.ack.seq, reused?.id)).state === "waiting");

  check("no unexpected endpoint errors on the sender", sender.errors.length === 0, sender.errors);
} catch (e) {
  check(`scenario threw: ${(e as Error).stack ?? (e as Error).message}`, false);
} finally {
  for (const ep of endpoints.reverse()) { try { await ep.stop(); } catch { /* ignore */ } }
  for (const nc of conns) { try { await nc.close(); } catch { /* ignore */ } }
  srv.kill("SIGKILL");
  await awaitExit(srv);
  rmSync(dir, { recursive: true, force: true });
  releaseBroker();
  finish();
}
