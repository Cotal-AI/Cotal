/**
 * The history limits on a real broker: the age and per-subject count that CHAT, INBOX, DLV and DM keep
 * their entries for. A new space starts with no age limit and 1000 per sender on CHAT, 1000 per agent
 * lifecycle on INBOX and DLV, and no count limit on DM. `cotal up` and an open-mode connect change no
 * existing stream's limit, and `cotal history limit` sets them.
 *
 * Every cell runs against a live nats-server, because each claim is the broker's: the provisioner's
 * permission to update those four streams and no other, the expiry the broker runs once an age lands,
 * and a limit that survives a broker restart. The auth phase runs as the real scoped credentials,
 * with the delivery daemon's writer stamping each stored copy with the DLV count it wrote under. The
 * open phase drives real endpoints for the connect and the recall reads.
 *
 * The expiry cell waits out the two-minute minimum age, so this suite takes about three minutes. Its
 * posts are written first and the other open-mode cells run while they age.
 *
 * Run: pnpm smoke:chat-history-limit   (needs nats-server on PATH; part of smoke:ci)
 */
import { randomUUID } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, connect as tcpConnect, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { jetstream, jetstreamManager, type JetStreamManager } from "@nats-io/jetstream";
import { Kvm } from "@nats-io/kv";
import { connect, headers, nanos, type NatsConnection } from "@nats-io/transport-node";
import {
  CHAT_HISTORY_DEFAULT,
  CotalEndpoint,
  DEV_OWNER,
  DM_HISTORY_DEFAULT,
  HistoryLimitChanged,
  HistoryLimitUpdateUnknown,
  INBOX_HISTORY_DEFAULT,
  artifactBucket,
  canonicalBackupStreamConfig,
  channelBucket,
  chatStream,
  createSpaceAuth,
  dinboxSubject,
  dlvDurable,
  dlvStream,
  dlvSubject,
  dmStream,
  historyLimitStreamName,
  inboxStream,
  isPublishPermissionDenied,
  isReachable,
  membersBucket,
  mintCreds,
  mintLifecycleUid,
  newIdentity,
  objectStoreStream,
  provisionAgent,
  openServerConfig,
  principalKey,
  serverConfig,
  setHistoryLimit,
  setupSpaceStreams,
  standaloneConnectOpts,
  taskStream,
  type CotalMessage,
  type Delivery,
  type HistoryLimit,
  type HistoryLimitStream,
} from "../src/index.js";
import { commitMemberRevision, readMember } from "../src/members.js";
import { pickFreePort } from "./_free-port.js";
import { SMOKE_BROKER_TOKEN, emitSentinel, teardownOnSignal } from "@cotal-ai/smoke-kit";

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
let ok = 0, fail = 0;
const check = (name: string, pass: boolean, extra?: unknown) => {
  if (pass) { ok++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log("  ✗ FAIL:", name, extra ?? ""); }
};
const until = async (cond: () => boolean | Promise<boolean>, timeoutMs = 15_000): Promise<boolean> => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) { if (await cond()) return true; await wait(100); }
  return cond();
};
const MIN = 60_000, HOUR = 3_600_000, DAY = 86_400_000;
const NONE = -1;
const STREAMS: readonly HistoryLimitStream[] = ["chat", "inbox", "dlv", "dm"];
const A: Record<HistoryLimitStream, string> = { chat: "a chat", inbox: "an INBOX", dlv: "a DLV", dm: "a DM" };
const limitOf = (config: { max_age?: number; max_msgs_per_subject?: number }): HistoryLimit => ({ maxAgeMs: (config.max_age ?? 0) / 1_000_000, perSubject: config.max_msgs_per_subject ?? Number.NaN });
const same = (a: HistoryLimit | undefined, b: HistoryLimit) => a !== undefined && a.maxAgeMs === b.maxAgeMs && a.perSubject === b.perSubject;
/** The error a call throws, or undefined. A cell reached through a throw could not name what failed. */
const thrown = async (fn: () => Promise<unknown>): Promise<unknown> => {
  try { await fn(); return undefined; } catch (e) { return e; }
};

/** A TCP hop to a broker. Armed, it holds every byte the broker sends a connection from the moment
 *  that connection asks for DLV's stream info, until released: the daemon's count read hangs while
 *  the cell acts. */
async function hopTo(port: number): Promise<{ servers: string; arm(): void; holding(): boolean; release(): void; close(): void }> {
  let armed = false, held = false;
  const waiting: (() => void)[] = [];
  const server: Server = createServer((client) => {
    const upstream = tcpConnect(port, "127.0.0.1");
    let holdingThis = false;
    const parked: Buffer[] = [];
    client.on("data", (chunk) => {
      upstream.write(chunk);
      if (armed && !held && /\$JS\.API\.STREAM\.INFO\.DLV_/.test(chunk.toString("latin1"))) {
        held = holdingThis = true;
        waiting.push(() => { holdingThis = false; for (const b of parked.splice(0)) client.write(b); });
      }
    });
    upstream.on("data", (chunk) => { if (holdingThis) parked.push(chunk); else client.write(chunk); });
    for (const [a, b] of [[client, upstream], [upstream, client]] as const) { a.on("error", () => b.destroy()); a.on("close", () => b.destroy()); }
  });
  const hopPort = await pickFreePort();
  await new Promise<void>((resolve) => server.listen(hopPort, "127.0.0.1", resolve));
  return {
    servers: `nats://127.0.0.1:${hopPort}`,
    arm() { armed = true; },
    holding: () => held,
    release() { armed = false; for (const go of waiting.splice(0)) go(); },
    close() { server.close(); },
  };
}

/** One broker on a free port over a store directory that outlives a restart. */
async function broker(conf: (port: number, storeDir: string) => string): Promise<{ servers: string; restart(): Promise<void>; stop(): Promise<void> }> {
  const port = await pickFreePort();
  const dir = mkdtempSync(join(tmpdir(), SMOKE_BROKER_TOKEN));
  const servers = `nats://127.0.0.1:${port}`;
  const confPath = join(dir, "server.conf");
  writeFileSync(confPath, conf(port, join(dir, "js")));
  let child: ChildProcess, release: () => void;
  const start = async () => {
    child = spawn("nats-server", ["-c", confPath], { stdio: "ignore" });
    release = teardownOnSignal(child, dir);
    for (let i = 0; i < 100; i++) { if (await isReachable(servers)) return; await wait(100); }
    throw new Error(`broker never came up on ${port}`);
  };
  const exit = () => new Promise<void>((resolve) => { if (child.exitCode !== null || child.signalCode !== null) resolve(); else child.once("exit", () => resolve()); });
  await start();
  return {
    servers,
    // A graceful stop, so the restart reads what the broker itself persisted.
    async restart() { child.kill("SIGTERM"); await exit(); release(); await start(); },
    async stop() { child.kill("SIGKILL"); await exit(); release(); rmSync(dir, { recursive: true, force: true }); },
  };
}

const limitIn = async (jsm: JetStreamManager, space: string, stream: HistoryLimitStream) => limitOf((await jsm.streams.info(historyLimitStreamName(space, stream))).config);
const chatLimit = (jsm: JetStreamManager, space: string) => limitIn(jsm, space, "chat");
const limitsIn = async (jsm: JetStreamManager, space: string) => Object.fromEntries(await Promise.all(STREAMS.map(async (s) => [s, await limitIn(jsm, space, s)] as const))) as Record<HistoryLimitStream, HistoryLimit>;
const sameAll = (a: Record<HistoryLimitStream, HistoryLimit>, b: Record<HistoryLimitStream, HistoryLimit>) => STREAMS.every((s) => same(a[s], b[s]));

// ── auth mode: the scoped credentials ────────────────────────────────────────────────────────────
console.log("the provisioner's grant and the default limits (auth mode):");
const S = `chl${randomUUID().slice(0, 6)}`;
const auth = await createSpaceAuth(S);
const authBroker = await broker((port, storeDir) => serverConfig(auth, [auth], { port, host: "127.0.0.1", storeDir, transport: { kind: "plaintext" } }));
const endpoints: CotalEndpoint[] = [];
// The delivery daemon reaches the broker through the hop, so the last auth cell can hold its count read.
const daemonHop = await hopTo(Number(new URL(authBroker.servers).port));
try {
  const provisioner = await mintCreds(auth, newIdentity(), "provisioner");
  const nc = await connect({ servers: authBroker.servers, ...standaloneConnectOpts({ creds: provisioner, tls: false }) });
  const jsm = await jetstreamManager(nc);
  const first = await thrown(() => setupSpaceStreams({ servers: authBroker.servers, space: S, creds: provisioner }));
  const created = first === undefined ? await limitsIn(jsm, S) : undefined;
  // The literal pairs, not the exported defaults, so a default that drifts is caught here.
  const literal = { chat: { maxAgeMs: 0, perSubject: 1000 }, inbox: { maxAgeMs: 0, perSubject: 1000 }, dlv: { maxAgeMs: 0, perSubject: 1000 }, dm: { maxAgeMs: 0, perSubject: NONE } };
  check("a new space's chat stream starts with no age limit and 1000 per sender", same(created?.chat, literal.chat), first ?? created);
  check("its INBOX and DLV start with no age limit and 1000 per agent lifecycle", same(created?.inbox, literal.inbox) && same(created?.dlv, literal.dlv), created);
  check("its DM stream starts with no age limit and no count limit", same(created?.dm, literal.dm), created);
  const repeat = await thrown(() => setupSpaceStreams({ servers: authBroker.servers, space: S, creds: provisioner }));
  check("a repeat setup changes nothing", repeat === undefined && sameAll(await limitsIn(jsm, S), literal), repeat);

  // INBOX and DLV on different limits, as a change that stopped partway leaves them.
  const operatorSet: Record<HistoryLimitStream, HistoryLimit> = {
    chat: { maxAgeMs: 7 * DAY, perSubject: 500 },
    inbox: { maxAgeMs: 3 * HOUR, perSubject: 400 },
    dlv: { maxAgeMs: 0, perSubject: 300 },
    dm: { maxAgeMs: 30 * DAY, perSubject: NONE },
  };
  const defaults: Record<HistoryLimitStream, HistoryLimit> = { chat: CHAT_HISTORY_DEFAULT, inbox: INBOX_HISTORY_DEFAULT, dlv: INBOX_HISTORY_DEFAULT, dm: DM_HISTORY_DEFAULT };
  for (const stream of STREAMS) {
    const set = await thrown(() => setHistoryLimit(jsm, S, stream, operatorSet[stream], defaults[stream]));
    check(`the provisioner may set the ${stream} stream's limit`, set === undefined && same(await limitIn(jsm, S, stream), operatorSet[stream]), set);
  }
  const resetup = await thrown(() => setupSpaceStreams({ servers: authBroker.servers, space: S, creds: provisioner }));
  check("cotal up leaves an operator's limit on each of the four streams as it is, and finds the rest of each config canonical", resetup === undefined && sameAll(await limitsIn(jsm, S), operatorSet), resetup ?? await limitsIn(jsm, S));

  // The grant is those four streams' update alone. Each refusal is the broker's permission check.
  for (const name of [taskStream(S), `KV_${channelBucket(S)}`]) {
    const { config } = await jsm.streams.info(name);
    const refused = await thrown(() => jsm.streams.update(name, config));
    check(`the provisioner may not update ${name}`, isPublishPermissionDenied(refused), refused);
  }
  for (const name of [chatStream(S), inboxStream(S), dlvStream(S), dmStream(S)]) {
    for (const [what, call] of [["purge", () => jsm.streams.purge(name)], ["delete", () => jsm.streams.delete(name)]] as const) {
      const refused = await thrown(call);
      check(`the provisioner may not ${what} ${name}`, isPublishPermissionDenied(refused), refused);
    }
  }
  // The delivery credential reads the chat stream's config but holds no update grant: its write is a
  // refusal the broker answered, so nothing changed, not an outcome left unknown.
  const reader = await connect({ servers: authBroker.servers, ...standaloneConnectOpts({ creds: await mintCreds(auth, newIdentity(), "delivery"), tls: false }) });
  const deniedWrite = await thrown(async () => setHistoryLimit(await jetstreamManager(reader), S, "chat", { maxAgeMs: DAY, perSubject: 500 }, operatorSet.chat));
  await reader.close();
  check("a credential without the update grant is refused, not reported as an unknown outcome", isPublishPermissionDenied(deniedWrite) && !(deniedWrite instanceof HistoryLimitUpdateUnknown), deniedWrite);
  check("...and the limit is unchanged", same(await chatLimit(jsm, S), operatorSet.chat));
  const obj = await jsm.streams.info(objectStoreStream(artifactBucket(S)));
  const objUpdate = await thrown(() => jsm.streams.update(obj.config.name, obj.config));
  check("the artifact store's update stays granted", objUpdate === undefined, objUpdate);

  // ── catch-up copies what the stream holds and judges no retention ──
  // A removed sequence does not record its subject, so stream state cannot tell this channel's
  // eviction from another channel's removal. SPEC §4 bounds the durable guarantee by the limit.
  console.log("\ndurable join catch-up over the stream's limits (auth mode):");
  const mgr = new CotalEndpoint({ space: S, servers: authBroker.servers, creds: provisioner, channels: [], consume: false, watchPresence: false, registerPresence: false, card: { name: "prov", role: "manager", kind: "endpoint" } });
  const daemon = new CotalEndpoint({ space: S, servers: daemonHop.servers, creds: await mintCreds(auth, newIdentity(), "delivery"), channels: [], consume: false, watchPresence: true, registerPresence: false, card: { name: "delivery", role: "delivery", kind: "endpoint" } });
  for (const ep of [mgr, daemon]) { ep.on("error", () => {}); await ep.start(); endpoints.push(ep); }
  await daemon.startPlane3((owner, lifecycleUid) => daemon.aclForOwner(owner, lifecycleUid));
  const posterId = newIdentity(), posterUid = mintLifecycleUid();
  const joinChannels = ["elsewhere", "held", "full", "capped", "gone"];
  const posterCreds = await provisionAgent(mgr, auth, posterId, { allowSubscribe: joinChannels, allowPublish: [...joinChannels, "stamp.>"], subscribe: [], lifecycleUid: posterUid });
  const poster = new CotalEndpoint({ space: S, servers: authBroker.servers, creds: posterCreds, channels: [], consume: false, lifecycleUid: posterUid, watchPresence: false, registerPresence: false, card: { id: posterId.id, name: "poster", role: "agent", kind: "agent" } });
  poster.on("error", () => {});
  await poster.start();
  endpoints.push(poster);
  // The membership store's writer is the delivery daemon, so its credential writes the pending row.
  const membership = await connect({ servers: authBroker.servers, ...standaloneConnectOpts({ creds: await mintCreds(auth, newIdentity(), "delivery"), tls: false }) });
  const members = await new Kvm(membership).open(membersBucket(S));
  const actor = newIdentity().id;
  const owner = principalKey(DEV_OWNER, actor).key;
  /** A join committed and not yet activated, with its window opening at `joinCursor`. Each cell
   *  commits it after the posts that window covers, as when the row lands after the cursor was
   *  read: the fan-out passed those posts before the row existed, so only catch-up copies them.
   *  Each join has its own lifecycle, so its inbox holds only its own copies. */
  const pending = async (channel: string, joinCursor: number) => {
    const lifecycleUid = mintLifecycleUid();
    await commitMemberRevision(members, { channel, owner, lifecycleUid, state: "durable-active", joinCursor, generation: 1, activated: false, writerIdentity: "smoke", updatedAt: Date.now() });
    return lifecycleUid;
  };
  const lastSeq = async () => (await jsm.streams.info(chatStream(S))).state.last_seq;
  const held = async (channel: string) => Object.values((await jsm.streams.info(chatStream(S), { subjects_filter: `cotal.${S}.chat.*.*.${channel}` })).state.subjects ?? {}).reduce((a, n) => a + n, 0);
  const copies = async (lifecycleUid: string) => {
    const subject = dinboxSubject(S, DEV_OWNER, actor, lifecycleUid);
    return (await jsm.streams.info(inboxStream(S), { subjects_filter: subject })).state.subjects?.[subject] ?? 0;
  };
  const join = async (channel: string, lifecycleUid: string) => {
    const result = await daemon.durableJoinFor(owner, channel, lifecycleUid);
    const row = (await readMember(members, channel, owner, lifecycleUid))?.record;
    return { result, row, open: result.durable === true && row?.activated === true && row.leaveCursor === undefined, copies: await copies(lifecycleUid) };
  };
  const purger = await connect({ servers: authBroker.servers, ...standaloneConnectOpts({ creds: await mintCreds(auth, newIdentity(), "purger"), tls: false }) });
  const purgerJsm = await jetstreamManager(purger);

  // Head: another channel's posts are removed below this join's window. The channel lost nothing.
  const headCursor = await lastSeq();
  for (const i of [1, 2]) await poster.multicast(`other ${i}`, { channel: "elsewhere" });
  for (const i of [1, 2]) await poster.multicast(`held ${i}`, { channel: "held" });
  await wait(300);
  // A purge to a sequence removes every message below it, so held's posts at +3 and +4 stay.
  await purgerJsm.streams.purge(chatStream(S), { seq: headCursor + 3 });
  const head = (await jsm.streams.info(chatStream(S))).state.first_seq;
  check("the rig: the stream's head is past the join's window start, and the joined channel keeps both posts", head > headCursor + 1 && await held("held") === 2, { head, headCursor, held: await held("held") });
  const heldJoin = await join("held", await pending("held", headCursor));
  check("a join whose window the stream head passed, with nothing of its channel removed, activates with both posts", heldJoin.open && heldJoin.copies === 2, heldJoin);

  // The per-sender count, at a limit of 2.
  await setHistoryLimit(jsm, S, "chat", { maxAgeMs: 7 * DAY, perSubject: 2 }, operatorSet.chat);
  // Exactly at the count, behind another channel's post: nothing of this channel was removed.
  const fullCursor = await lastSeq();
  await poster.multicast("other 3", { channel: "elsewhere" });
  for (const i of [1, 2]) await poster.multicast(`full ${i}`, { channel: "full" });
  await wait(300);
  const fullJoin = await join("full", await pending("full", fullCursor));
  check("a join whose channel is exactly at the per-sender count, behind another channel's post, activates with both posts", fullJoin.open && fullJoin.copies === 2, fullJoin);
  // Past the count: the sender's two oldest posts in the window are evicted.
  const capCursor = await lastSeq();
  for (const i of [1, 2, 3, 4]) await poster.multicast(`capped ${i}`, { channel: "capped" });
  await wait(300);
  const capJoin = await join("capped", await pending("capped", capCursor));
  check("a join whose window lost a sender's posts to the per-sender count activates with the two the stream still holds", capJoin.open && capJoin.copies === 2 && await held("capped") === 2, { ...capJoin, held: await held("capped") });
  // A channel-filtered purge empties the channel while older posts elsewhere keep the head.
  const goneCursor = await lastSeq();
  for (const i of [1, 2]) await poster.multicast(`gone ${i}`, { channel: "gone" });
  await wait(300);
  await purgerJsm.streams.purge(chatStream(S), { filter: `cotal.${S}.chat.*.*.gone` });
  const goneJoin = await join("gone", await pending("gone", goneCursor));
  check("a join over a channel a filtered purge emptied activates with nothing to copy", goneJoin.open && goneJoin.copies === 0 && await held("gone") === 0, goneJoin);
  await purger.close();
  // Back to a count the stamp cells' posts fit under.
  await setHistoryLimit(jsm, S, "chat", operatorSet.chat);

  // ── the DLV count the writer stamps on each stored copy ──
  // A copy warns when its own stamp says the store was full, whatever the count is when it is read.
  // Each change waits out the writer's five-second reuse of its count read before the posts that
  // must carry the new count.
  console.log("\nthe count stamped on each stored copy (auth mode):");
  const STAMP_READ_MS = 5_500;
  const setDlv = async (perSubject: number) => { await setHistoryLimit(jsm, S, "dlv", { maxAgeMs: 0, perSubject }); };
  const agent = async (channel: string) => {
    const id = newIdentity(), uid = mintLifecycleUid();
    const creds = await provisionAgent(mgr, auth, id, { allowSubscribe: ["stamp.>"], subscribe: [], lifecycleUid: uid });
    const principal = principalKey(DEV_OWNER, id.id).key;
    if (channel) await commitMemberRevision(members, { channel, owner: principal, lifecycleUid: uid, state: "durable-active", joinCursor: await lastSeq(), generation: 1, activated: true, writerIdentity: "smoke", updatedAt: Date.now() });
    const subject = dlvSubject(S, DEV_OWNER, id.id, uid);
    const stored = async () => (await jsm.streams.info(dlvStream(S), { subjects_filter: subject })).state.subjects?.[subject] ?? 0;
    /** Copies its durable has not delivered yet. The store also keeps the ones it acknowledged. */
    const unread = async () => (await jsm.consumers.info(dlvStream(S), dlvDurable(DEV_OWNER, id.id, uid))).num_pending;
    /** Connects, reads until `last` arrives, and returns the limits each notice carried. */
    const read = async (last: string) => {
      const ep = new CotalEndpoint({ space: S, servers: authBroker.servers, creds, channels: [], lifecycleUid: uid, heartbeatMs: 500, ttlMs: 2000, card: { id: id.id, name: `stamp-${channel || "raw"}`, kind: "agent" } });
      const got: string[] = [], notices: number[] = [];
      ep.on("error", () => {});
      ep.on("stored-copies-full", (full: { limit: number }) => notices.push(full.limit));
      ep.on("message", (m: CotalMessage, d: Delivery) => { got.push(m.parts.map((p) => (p.kind === "text" ? p.text : "")).join("")); d.ack(); });
      await ep.start();
      const arrived = await until(() => got.includes(last), 20_000);
      await ep.stop();
      return { arrived, got: got.length, notices };
    };
    return { id, uid, subject, stored, unread, read };
  };
  const post = async (channel: string, n: number, tag = channel) => { for (let i = 0; i < n; i++) await poster.multicast(`${tag}-${i}`, { channel }); };

  await setDlv(5);
  await wait(STAMP_READ_MS);
  const [raised, raisedToNone] = [await agent("stamp.a"), await agent("stamp.a")];
  await post("stamp.a", 8);
  const fullAt5 = await until(async () => await raised.stored() === 5 && await raisedToNone.stored() === 5);
  check("the rig: with a count of 5, two away agents' stores hold 5 of 8 posts", fullAt5, { raised: await raised.stored(), raisedToNone: await raisedToNone.stored() });
  await setDlv(50);
  const afterRaise = await raised.read("stamp.a-7");
  check("copies stored under 5 still warn, at 5, after the count is raised to 50", afterRaise.arrived && afterRaise.notices.length >= 1 && afterRaise.notices.every((n) => n === 5), afterRaise);
  await setDlv(NONE);
  const afterNone = await raisedToNone.read("stamp.a-7");
  check("copies stored under 5 still warn, at 5, after the count is raised to none", afterNone.arrived && afterNone.notices.length >= 1 && afterNone.notices.every((n) => n === 5), afterNone);

  await wait(STAMP_READ_MS);
  const fromNone = await agent("stamp.c");
  await post("stamp.c", 8);
  check("the rig: with no count, an away agent's store holds all 8 posts", await until(async () => await fromNone.stored() === 8), await fromNone.stored());
  await setDlv(50);
  await wait(STAMP_READ_MS);
  const from50 = await agent("stamp.d");
  await post("stamp.d", 8);
  check("the rig: with a count of 50, an away agent's store holds all 8 posts", await until(async () => await from50.stored() === 8), await from50.stored());
  await setDlv(5);
  const trimmed = await until(async () => await fromNone.stored() === 5 && await from50.stored() === 5);
  check("the rig: lowering the count to 5 trims both stores to 5 at once", trimmed, { fromNone: await fromNone.stored(), from50: await from50.stored() });
  const loweredFromNone = await fromNone.read("stamp.c-7");
  check("copies stored under no count give no notice after the count drops to 5", loweredFromNone.arrived && loweredFromNone.notices.length === 0, loweredFromNone);
  const loweredFrom50 = await from50.read("stamp.d-7");
  check("copies stored under 50 give no notice after the count drops to 5", loweredFrom50.arrived && loweredFrom50.notices.length === 0, loweredFrom50);
  // The same store, now written under 5, warns: the silence above was the stamp, not a dead notice.
  await wait(STAMP_READ_MS);
  await post("stamp.d", 8, "again");
  check("the rig: the agent's next 8 copies, stored under 5, leave 5 unread", await until(async () => await from50.unread() === 5), await from50.unread());
  const nowAt5 = await from50.read("again-7");
  check("...and the same agent's next copies, stored under 5, warn at 5", nowAt5.arrived && nowAt5.notices.length >= 1 && nowAt5.notices.every((n) => n === 5), nowAt5);

  // A copy with no stamp, as a daemon from before the stamp wrote it, counts as stored under 1000.
  await setDlv(1000);
  const writer = await connect({ servers: authBroker.servers, ...standaloneConnectOpts({ creds: await mintCreds(auth, newIdentity(), "delivery"), tls: false }) });
  const writerJs = jetstream(writer);
  const unstamped = async (who: Awaited<ReturnType<typeof agent>>, n: number) => {
    const h = headers();
    h.set("Cotal-Delivery-Frame", "1");
    for (let i = 0; i < n; i++) {
      const msg = { id: randomUUID(), ts: Date.now(), space: S, from: { id: posterId.id, name: "poster" }, channel: "stamp.e", parts: [{ kind: "text", text: `old-${i}` }] };
      await writerJs.publish(who.subject, JSON.stringify({ version: 1, channel: "stamp.e", msg }), { headers: h });
    }
  };
  const [old1000, old999] = [await agent(""), await agent("")];
  await unstamped(old1000, 1000);
  await unstamped(old999, 999);
  await writer.close();
  const read1000 = await old1000.read("old-999");
  check("1000 copies without the stamp warn, at 1000, as the old daemon's count was", read1000.arrived && read1000.notices.length >= 1 && read1000.notices.every((n) => n === 1000), { ...read1000, notices: read1000.notices.slice(0, 3) });
  const read999 = await old999.read("old-998");
  check("999 copies without the stamp give no notice", read999.arrived && read999.notices.length === 0, { ...read999, notices: read999.notices.slice(0, 3) });

  // The count read is broker I/O between the writer's shard fence and its write. A daemon that stands
  // down while it waits must not write the copy: its successor transfers the entry.
  const fenced = await agent("stamp.f");
  await wait(STAMP_READ_MS);
  daemonHop.arm();
  await post("stamp.f", 1, "fenced");
  const heldRead = await until(() => daemonHop.holding(), 10_000);
  await daemon.quiescePlane3();
  daemonHop.release();
  await wait(2_000);
  check("the rig: the writer's DLV count read was held while the daemon stood down", heldRead && daemon.plane3IsQuiesced(), { heldRead, quiesced: daemon.plane3IsQuiesced() });
  check("a daemon that stands down during its count read writes no stored copy", await fenced.stored() === 0, await fenced.stored());

  await membership.close();
  await nc.close();
} catch (e) {
  // A throw ends the phase, not the suite, so the open phase still runs and the summary prints.
  check(`the auth phase ran without throwing: ${e instanceof Error ? e.message : String(e)}`, false, e instanceof Error ? e.stack : e);
} finally {
  for (const ep of endpoints.splice(0)) await ep.stop().catch(() => {});
  daemonHop.close();
  await authBroker.stop();
}

// ── open mode: the helper, setup and connect, recall, expiry ─────────────────────────────────────
console.log("\nthe limits, what cotal up and a connect leave alone, and recall (open mode):");
const open = await broker((port, storeDir) => openServerConfig({ port, host: "127.0.0.1", storeDir, transport: { kind: "plaintext" } }));
try {
  const nc: NatsConnection = await connect({ servers: open.servers });
  const jsm = await jetstreamManager(nc);
  const js = jetstream(nc);
  const start = async (space: string, name: string) => {
    const ep = new CotalEndpoint({ space, servers: open.servers, card: { name, kind: "agent" }, channels: [], heartbeatMs: 500 });
    ep.on("error", () => {});
    await ep.start();
    endpoints.push(ep);
    return ep;
  };

  // Written first so they age while the cells below run.
  const E = "chlexpire";
  await setupSpaceStreams({ servers: open.servers, space: E });
  const oldPoster = await start(E, "old");
  for (const i of [1, 2, 3]) await oldPoster.multicast(`old ${i}`, { channel: "old" });
  // Durable copies taken at the same time, on the two streams that keep their own bound.
  const copyUid = mintLifecycleUid();
  const copySubjects = [dinboxSubject(E, "o", "a", copyUid), dlvSubject(E, "o", "a", copyUid)];
  for (const subject of copySubjects) await js.publish(subject, JSON.stringify({ copy: true }));
  const writtenAt = Date.now();

  // An existing stream keeps whatever limit it holds through cotal up's setup.
  const kept: [HistoryLimitStream, HistoryLimit, string][] = [
    ["chat", { maxAgeMs: 0, perSubject: 1000 }, "no age and 1000 per sender (every chat stream's limit before 0.134.0)"],
    ["chat", { maxAgeMs: 0, perSubject: 500 }, "no age and another count"],
    ["chat", { maxAgeMs: 30 * DAY, perSubject: 1000 }, "an age of 30 days"],
    ["chat", { maxAgeMs: 0, perSubject: NONE }, "no age and no count"],
    ["inbox", { maxAgeMs: 2 * HOUR, perSubject: 50 }, "an age of 2 hours and 50 per agent"],
    ["inbox", { maxAgeMs: 0, perSubject: NONE }, "no age and no count"],
    ["dlv", { maxAgeMs: 7 * DAY, perSubject: 1000 }, "an age of 7 days"],
    ["dlv", { maxAgeMs: 0, perSubject: NONE }, "no age and no count"],
    ["dm", { maxAgeMs: 2 * MIN, perSubject: 200 }, "an age of 2 minutes and 200 per sender"],
    ["dm", { maxAgeMs: 0, perSubject: 1000 }, "a count of 1000"],
  ];
  for (const [i, [stream, limit, what]] of kept.entries()) {
    const space = `chlkeep${i}`;
    await jsm.streams.add(canonicalBackupStreamConfig(space, historyLimitStreamName(space, stream), limit));
    const r = await thrown(() => setupSpaceStreams({ servers: open.servers, space }));
    check(`cotal up leaves ${A[stream]} stream with ${what} as it is`, r === undefined && same(await limitIn(jsm, space, stream), limit), r ?? await limitIn(jsm, space, stream));
  }
  // A real open-mode connect runs the stream creation on its own path.
  const C = "chlconnect";
  const connectSet: Record<HistoryLimitStream, HistoryLimit> = { chat: { maxAgeMs: 3 * DAY, perSubject: 10 }, inbox: { maxAgeMs: 0, perSubject: 20 }, dlv: { maxAgeMs: 0, perSubject: NONE }, dm: { maxAgeMs: DAY, perSubject: 30 } };
  for (const stream of STREAMS) await jsm.streams.add(canonicalBackupStreamConfig(C, historyLimitStreamName(C, stream), connectSet[stream]));
  const connected = await thrown(() => start(C, "connector"));
  check("an open-mode connect leaves a set limit on each of the four streams as it is", connected === undefined && sameAll(await limitsIn(jsm, C), connectSet), connected ?? await limitsIn(jsm, C));
  for (const stream of STREAMS) {
    const drifted = `chldrift${stream}`;
    const name = historyLimitStreamName(drifted, stream);
    await jsm.streams.add({ ...canonicalBackupStreamConfig(drifted, name), max_bytes: 10 * 1024 * 1024 });
    const refusal = await thrown(() => setupSpaceStreams({ servers: open.servers, space: drifted }));
    const after = (await jsm.streams.info(name)).config;
    check(`${A[stream]} stream with any setting other than its limit off canonical is refused, and left as it was`, refusal instanceof Error && refusal.message.includes("max_bytes") && after.max_bytes === 10 * 1024 * 1024, refusal);
  }

  // The helper.
  const V = "chlhelper";
  await setupSpaceStreams({ servers: open.servers, space: V });
  const refused: [HistoryLimitStream, HistoryLimit, string][] = [
    ["chat", { maxAgeMs: MIN, perSubject: 1000 }, "an age below the two-minute duplicate window"],
    ["chat", { maxAgeMs: 2 * MIN + 500, perSubject: 1000 }, "an age that is not whole seconds"],
    ["chat", { maxAgeMs: DAY, perSubject: 0 }, "a count of 0"],
    ["chat", { maxAgeMs: DAY, perSubject: -2 }, "a count of -2"],
    ["dm", { maxAgeMs: 3651 * DAY, perSubject: NONE }, "an age past 3650 days"],
    ["inbox", { maxAgeMs: 2 * HOUR - 1000, perSubject: 1000 }, "an age below the two-hour duplicate window"],
    ["dlv", { maxAgeMs: HOUR, perSubject: 1000 }, "an age below the two-hour duplicate window"],
  ];
  for (const [stream, limit, what] of refused) {
    const e = await thrown(() => setHistoryLimit(jsm, V, stream, limit));
    check(`setHistoryLimit refuses ${what} on ${stream}`, e instanceof Error && e.message.startsWith(`invalid ${stream} history limit`), e);
  }
  for (const [stream, limit, what] of [["chat", { maxAgeMs: 0, perSubject: NONE }, "no age and no count"], ["inbox", { maxAgeMs: 2 * HOUR, perSubject: 1000 }, "an age of 2 hours"], ["dm", { maxAgeMs: 2 * MIN, perSubject: 1 }, "an age of 2 minutes and a count of 1"]] as const) {
    const e = await thrown(() => setHistoryLimit(jsm, V, stream, limit));
    check(`setHistoryLimit accepts ${what} on ${stream}`, e === undefined && same(await limitIn(jsm, V, stream), limit), e ?? await limitIn(jsm, V, stream));
  }
  const W = "chlhelper2";
  await setupSpaceStreams({ servers: open.servers, space: W });
  const moved = await thrown(() => setHistoryLimit(jsm, W, "chat", { maxAgeMs: DAY, perSubject: 10 }, { maxAgeMs: 7 * DAY, perSubject: 10 }));
  check("a stream that holds another limit than the caller read is refused", moved instanceof HistoryLimitChanged && same(moved.found, CHAT_HISTORY_DEFAULT), moved);
  check("...and nothing was written", same(await chatLimit(jsm, W), CHAT_HISTORY_DEFAULT));
  const week = { maxAgeMs: 7 * DAY, perSubject: 1000 };
  await setHistoryLimit(jsm, W, "chat", week, CHAT_HISTORY_DEFAULT);
  const noop = await setHistoryLimit(jsm, W, "chat", week, week);
  check("setting the limit a stream holds is a no-op", noop === undefined && same(await chatLimit(jsm, W), week), noop);

  // Recall: the cap rule and the head rule.
  const R = "chlrecall";
  await setupSpaceStreams({ servers: open.servers, space: R });
  await setHistoryLimit(jsm, R, "chat", { maxAgeMs: 30 * DAY, perSubject: 3 });
  const [talker, quiet, reader] = [await start(R, "talker"), await start(R, "quiet"), await start(R, "reader")];
  await quiet.multicast("kept", { channel: "keep" });
  for (const i of [1, 2, 3, 4, 5]) await talker.multicast(`busy ${i}`, { channel: "busy" });
  await wait(300);
  const busy = await reader.recallChannel("busy", 1);
  check("recall reports a channel where a sender passed the stream's per-sender count", busy.dropped === true && busy.unanswered === false && busy.messages.length === 3, { dropped: busy.dropped, n: busy.messages.length });
  const keep = await reader.recallChannel("keep", 0);
  check("recall reports a channel below the count, behind a retained head, as complete", keep.dropped === false && keep.messages.length === 1, { dropped: keep.dropped, n: keep.messages.length });

  const H = "chlhead";
  await setupSpaceStreams({ servers: open.servers, space: H });
  const [a, b, hr] = [await start(H, "alpha"), await start(H, "beta"), await start(H, "headreader")];
  for (const i of [1, 2]) await a.multicast(`a ${i}`, { channel: "a" });
  for (const i of [1, 2]) await b.multicast(`b ${i}`, { channel: "b" });
  await wait(300);
  await jsm.streams.purge(chatStream(H), { seq: 3 });
  const gone = await hr.recallChannel("a", 0);
  check("recall reports a channel whose posts are all gone, with the stream head past the watermark", gone.dropped === true && gone.messages.length === 0, gone);
  const atHead = await hr.recallChannel("b", 2);
  check("recall from the stream head is complete", atHead.dropped === false && atHead.messages.length === 2, { dropped: atHead.dropped, n: atHead.messages.length });
  const before = await hr.recallChannel("b", 0);
  check("the head rule reports possible loss on a channel that lost nothing below its first post (documented)", before.dropped === true && before.messages.length === 2, { dropped: before.dropped, n: before.messages.length });
  await b.multicast("c 1", { channel: "c" });
  await a.multicast("d 1", { channel: "d" });
  await wait(300);
  const cSeq = (await jsm.streams.info(chatStream(H))).state.last_seq - 1;
  await jsm.streams.purge(chatStream(H), { filter: `cotal.${H}.chat.*.*.c` });
  const miss = await hr.recallChannel("c", cSeq - 1);
  check("a channel-filtered purge behind a retained head is not seen (documented miss)", miss.dropped === false && miss.messages.length === 0, miss);

  // ── expiry: an age the broker runs, persisted across a restart ──
  console.log("\nthe broker's expiry under a set age (open mode):");
  const due = writtenAt + 2 * MIN + 2_000 - Date.now();
  if (due > 0) await wait(due);
  const expiry = await setHistoryLimit(jsm, E, "chat", { maxAgeMs: 2 * MIN, perSubject: 1000 }, CHAT_HISTORY_DEFAULT);
  let messages = -1;
  for (let i = 0; i < 50 && messages !== 0; i++) { messages = (await jsm.streams.info(chatStream(E))).state.messages; if (messages !== 0) await wait(200); }
  check("setting a 2-minute age makes the broker delete posts older than it", expiry !== undefined && messages === 0, { expiry, messages });
  const copiesKept = await Promise.all([inboxStream(E), dlvStream(E)].map(async (name, i) => (await jsm.streams.info(name, { subjects_filter: copySubjects[i] })).state.subjects?.[copySubjects[i]!] ?? 0));
  check("...while the INBOX and DLV copies taken as old as those posts are kept", copiesKept.every((n) => n === 1), copiesKept);
  const recallReader = await start(E, "expiryreader");
  const expired = await recallReader.recallChannel("old", 0);
  check("recall reports the expired channel as possibly incomplete", expired.dropped === true && expired.messages.length === 0, expired);
  await js.publish(`cotal.${E}.chat.o.a.new`, "fresh");
  for (const ep of endpoints.splice(0)) await ep.stop().catch(() => {});
  await nc.close();
  await open.restart();
  const nc2 = await connect({ servers: open.servers });
  const info = await (await jetstreamManager(nc2)).streams.info(chatStream(E));
  check("the age survives a broker restart, and a newer post is still kept", info.config.max_age === nanos(2 * MIN) && info.state.messages === 1, { max_age: info.config.max_age, messages: info.state.messages });
  await nc2.close();
} catch (e) {
  check(`the open phase ran without throwing: ${e instanceof Error ? e.message : String(e)}`, false, e instanceof Error ? e.stack : e);
} finally {
  for (const ep of endpoints.splice(0)) await ep.stop().catch(() => {});
  await open.stop();
}

console.log(`\nchat-history-limit: ${ok} passed, ${fail} failed`);
emitSentinel({ passed: ok, failed: fail });
process.exit(fail ? 1 : 0);
