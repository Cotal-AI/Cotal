/**
 * The chat stream's history limit on a real broker: the age and per-sender count a space keeps its
 * channel posts for, set by `cotal up` and `cotal history limit`.
 *
 * Every cell runs against a live nats-server, because each claim is the broker's: the provisioner's
 * permission to update one stream and no other, the expiry the broker runs once an age lands, and a
 * limit that survives a broker restart. The auth phase runs as the real scoped credentials. The open
 * phase drives real endpoints for the recall reads.
 *
 * The expiry cell waits out the two-minute minimum age, so this suite takes about two and a half
 * minutes. Its posts are written first and the other open-mode cells run while they age.
 *
 * Run: pnpm smoke:chat-history-limit   (needs nats-server on PATH; part of smoke:ci)
 */
import { randomUUID } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { jetstream, jetstreamManager, type JetStreamManager } from "@nats-io/jetstream";
import { Kvm } from "@nats-io/kv";
import { connect, nanos, type NatsConnection } from "@nats-io/transport-node";
import {
  CHAT_HISTORY_DEFAULT,
  ChatHistoryChanged,
  ChatHistoryUpdateUnknown,
  CotalEndpoint,
  DEV_OWNER,
  LEGACY_CHAT_HISTORY,
  PLANE3_MAX_MSGS_PER_SUBJECT,
  artifactBucket,
  canonicalBackupStreamConfig,
  channelBucket,
  chatStream,
  createSpaceAuth,
  dlvStream,
  dmStream,
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
  setChatHistoryLimit,
  setupSpaceStreams,
  standaloneConnectOpts,
  taskStream,
  type ChatHistoryLimit,
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
const MIN = 60_000, DAY = 86_400_000;
const limitOf = (config: { max_age?: number; max_msgs_per_subject?: number }): ChatHistoryLimit => ({ maxAgeMs: (config.max_age ?? 0) / 1_000_000, perSender: config.max_msgs_per_subject ?? Number.NaN });
const same = (a: ChatHistoryLimit | undefined, b: ChatHistoryLimit) => a !== undefined && a.maxAgeMs === b.maxAgeMs && a.perSender === b.perSender;
/** The error a call throws, or undefined. A cell reached through a throw could not name what failed. */
const thrown = async (fn: () => Promise<unknown>): Promise<unknown> => {
  try { await fn(); return undefined; } catch (e) { return e; }
};

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

const chatLimit = async (jsm: JetStreamManager, space: string) => limitOf((await jsm.streams.info(chatStream(space))).config);

// ── auth mode: the scoped credentials ────────────────────────────────────────────────────────────
console.log("the provisioner's grant and cotal up's migration (auth mode):");
const S = `chl${randomUUID().slice(0, 6)}`;
const auth = await createSpaceAuth(S);
const authBroker = await broker((port, storeDir) => serverConfig(auth, [auth], { port, host: "127.0.0.1", storeDir, transport: { kind: "plaintext" } }));
const endpoints: CotalEndpoint[] = [];
try {
  const provisioner = await mintCreds(auth, newIdentity(), "provisioner");
  const nc = await connect({ servers: authBroker.servers, ...standaloneConnectOpts({ creds: provisioner, tls: false }) });
  const jsm = await jetstreamManager(nc);
  // A space from before the limit was configurable: its chat stream on the legacy pair.
  await jsm.streams.add(canonicalBackupStreamConfig(S, chatStream(S), LEGACY_CHAT_HISTORY));
  const first = await thrown(() => setupSpaceStreams({ servers: authBroker.servers, space: S, creds: provisioner }));
  const migrated = first === undefined ? await chatLimit(jsm, S) : undefined;
  check("cotal up's setup, as the provisioner, moves a legacy chat stream to 30 days and 1000 per sender", first === undefined && same(migrated, CHAT_HISTORY_DEFAULT), first ?? migrated);
  const repeat = await setupSpaceStreams({ servers: authBroker.servers, space: S, creds: provisioner });
  check("a repeat setup changes nothing and reports no migration", repeat.chatHistory === undefined && same(await chatLimit(jsm, S), CHAT_HISTORY_DEFAULT), repeat);
  const plane3 = await Promise.all([inboxStream(S), dlvStream(S)].map(async (name) => (await jsm.streams.info(name)).config));
  check("INBOX and DLV keep their own 1000 per subject and no age", plane3.every((c) => c.max_msgs_per_subject === PLANE3_MAX_MSGS_PER_SUBJECT && c.max_age === 0), plane3.map((c) => [c.name, c.max_msgs_per_subject, c.max_age]));

  const operatorSet = { maxAgeMs: 7 * DAY, perSender: 500 };
  const set = await thrown(() => setChatHistoryLimit(jsm, S, operatorSet, CHAT_HISTORY_DEFAULT));
  check("the provisioner may set the chat stream's limit", set === undefined && same(await chatLimit(jsm, S), operatorSet), set);
  await setupSpaceStreams({ servers: authBroker.servers, space: S, creds: provisioner });
  check("cotal up leaves an operator's limit as it is", same(await chatLimit(jsm, S), operatorSet));

  // The grant is the chat stream's update alone. Each refusal is the broker's permission check.
  for (const name of [taskStream(S), dmStream(S), inboxStream(S), dlvStream(S), `KV_${channelBucket(S)}`]) {
    const { config } = await jsm.streams.info(name);
    const refused = await thrown(() => jsm.streams.update(name, config));
    check(`the provisioner may not update ${name}`, isPublishPermissionDenied(refused), refused);
  }
  for (const [what, call] of [["purge", () => jsm.streams.purge(chatStream(S))], ["delete", () => jsm.streams.delete(chatStream(S))]] as const) {
    const refused = await thrown(call);
    check(`the provisioner may not ${what} the chat stream`, isPublishPermissionDenied(refused), refused);
  }
  // The delivery credential reads the chat stream's config but holds no update grant: its write is a
  // refusal the broker answered, so nothing changed, not an outcome left unknown.
  const reader = await connect({ servers: authBroker.servers, ...standaloneConnectOpts({ creds: await mintCreds(auth, newIdentity(), "delivery"), tls: false }) });
  const deniedWrite = await thrown(async () => setChatHistoryLimit(await jetstreamManager(reader), S, { maxAgeMs: DAY, perSender: 500 }, operatorSet));
  await reader.close();
  check("a credential without the update grant is refused, not reported as an unknown outcome", isPublishPermissionDenied(deniedWrite) && !(deniedWrite instanceof ChatHistoryUpdateUnknown), deniedWrite);
  check("...and the limit is unchanged", same(await chatLimit(jsm, S), operatorSet));
  const obj = await jsm.streams.info(objectStoreStream(artifactBucket(S)));
  const objUpdate = await thrown(() => jsm.streams.update(obj.config.name, obj.config));
  check("the artifact store's update stays granted", objUpdate === undefined, objUpdate);

  // ── catch-up: the cap rule tombstones a join, a passed stream head does not ──
  console.log("\ndurable join catch-up over the stream's limits (auth mode):");
  const mgr = new CotalEndpoint({ space: S, servers: authBroker.servers, creds: provisioner, channels: [], consume: false, watchPresence: false, registerPresence: false, card: { name: "prov", role: "manager", kind: "endpoint" } });
  const daemon = new CotalEndpoint({ space: S, servers: authBroker.servers, creds: await mintCreds(auth, newIdentity(), "delivery"), channels: [], consume: false, watchPresence: true, registerPresence: false, card: { name: "delivery", role: "delivery", kind: "endpoint" } });
  for (const ep of [mgr, daemon]) { ep.on("error", () => {}); await ep.start(); endpoints.push(ep); }
  await daemon.startPlane3((owner, lifecycleUid) => daemon.aclForOwner(owner, lifecycleUid));
  const posterId = newIdentity(), posterUid = mintLifecycleUid();
  const posterCreds = await provisionAgent(mgr, auth, posterId, { allowSubscribe: ["elsewhere", "held", "capped"], allowPublish: ["elsewhere", "held", "capped"], subscribe: [], lifecycleUid: posterUid });
  const poster = new CotalEndpoint({ space: S, servers: authBroker.servers, creds: posterCreds, channels: [], consume: false, lifecycleUid: posterUid, watchPresence: false, registerPresence: false, card: { id: posterId.id, name: "poster", role: "agent", kind: "agent" } });
  poster.on("error", () => {});
  await poster.start();
  endpoints.push(poster);
  // The membership store's writer is the delivery daemon, so its credential writes the pending row.
  const membership = await connect({ servers: authBroker.servers, ...standaloneConnectOpts({ creds: await mintCreds(auth, newIdentity(), "delivery"), tls: false }) });
  const members = await new Kvm(membership).open(membersBucket(S));
  const owner = principalKey(DEV_OWNER, newIdentity().id).key;
  const uid = mintLifecycleUid();
  /** A join committed and not yet activated, as a crash between the two leaves it: its catch-up
   *  window opens at `joinCursor`, which a fresh join would set to the current frontier. */
  const pending = (channel: string, joinCursor: number) => commitMemberRevision(members, {
    channel, owner, lifecycleUid: uid, state: "durable-active", joinCursor, generation: 1, activated: false, writerIdentity: "smoke", updatedAt: Date.now(),
  });
  const lastSeq = async () => (await jsm.streams.info(chatStream(S))).state.last_seq;

  // Head: another channel's posts are removed below this join's window. The channel lost nothing.
  const headCursor = await lastSeq();
  await pending("held", headCursor);
  for (const i of [1, 2]) await poster.multicast(`other ${i}`, { channel: "elsewhere" });
  for (const i of [1, 2]) await poster.multicast(`held ${i}`, { channel: "held" });
  await wait(300);
  const purger = await connect({ servers: authBroker.servers, ...standaloneConnectOpts({ creds: await mintCreds(auth, newIdentity(), "purger"), tls: false }) });
  await (await jetstreamManager(purger)).streams.purge(chatStream(S), { seq: headCursor + 3 });
  await purger.close();
  const head = (await jsm.streams.info(chatStream(S))).state.first_seq;
  check("the rig: the stream's head is past the join's window start", head > headCursor + 1, { head, headCursor });
  const joined = await daemon.durableJoinFor(owner, "held", uid);
  const heldRow = await readMember(members, "held", owner, uid);
  check("a join whose window the stream head passed, with nothing of its channel removed, activates", joined.durable === true && joined.reason === undefined, joined);
  check("...and its row stays open", heldRow?.record.activated === true && heldRow.record.leaveCursor === undefined, heldRow?.record);

  // Cap: one sender's posts past the count are evicted inside the window.
  await setChatHistoryLimit(jsm, S, { maxAgeMs: 7 * DAY, perSender: 2 }, operatorSet);
  const capCursor = await lastSeq();
  await pending("capped", capCursor);
  for (const i of [1, 2, 3, 4]) await poster.multicast(`capped ${i}`, { channel: "capped" });
  await wait(300);
  const capped = await daemon.durableJoinFor(owner, "capped", uid);
  const cappedRow = await readMember(members, "capped", owner, uid);
  check("a join whose window lost a sender's posts to the per-sender count is refused as durable", capped.durable === false && capped.reason === "activation catch-up window partially evicted by retention", capped);
  check("...and its row is tombstoned", cappedRow?.record.leaveCursor !== undefined, cappedRow?.record);
  await membership.close();
  await nc.close();
} catch (e) {
  // A throw ends the phase, not the suite, so the open phase still runs and the summary prints.
  check(`the auth phase ran without throwing: ${e instanceof Error ? e.message : String(e)}`, false, e instanceof Error ? e.stack : e);
} finally {
  for (const ep of endpoints.splice(0)) await ep.stop().catch(() => {});
  await authBroker.stop();
}

// ── open mode: the helper, the migration boundary, recall, expiry ────────────────────────────────
console.log("\nthe limit, the migration boundary and recall (open mode):");
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
  const writtenAt = Date.now();

  // The boundary of cotal up's migration.
  for (const [space, limit, what] of [["chlcustomcount", { maxAgeMs: 0, perSender: 500 }, "no age and another count"], ["chlweek", { maxAgeMs: 7 * DAY, perSender: 1000 }, "an age of 7 days"]] as const) {
    await jsm.streams.add(canonicalBackupStreamConfig(space, chatStream(space), limit));
    const r = await setupSpaceStreams({ servers: open.servers, space });
    check(`cotal up leaves a chat stream with ${what} as it is`, r.chatHistory === undefined && same(await chatLimit(jsm, space), limit), r);
  }
  const drifted = "chldrift";
  await jsm.streams.add({ ...canonicalBackupStreamConfig(drifted, chatStream(drifted), LEGACY_CHAT_HISTORY), max_bytes: 10 * 1024 * 1024 });
  const refusal = await thrown(() => setupSpaceStreams({ servers: open.servers, space: drifted }));
  const after = (await jsm.streams.info(chatStream(drifted))).config;
  check("a legacy chat stream with any other drift is refused, not migrated", refusal instanceof Error && refusal.message.includes("max_bytes"), refusal);
  check("...and left as it was", after.max_age === 0 && after.max_bytes === 10 * 1024 * 1024, { max_age: after.max_age, max_bytes: after.max_bytes });

  // The helper.
  const V = "chlhelper";
  await setupSpaceStreams({ servers: open.servers, space: V });
  for (const [limit, what] of [[{ maxAgeMs: 0, perSender: 1000 }, "no age"], [{ maxAgeMs: MIN, perSender: 1000 }, "an age below the two-minute duplicate window"], [{ maxAgeMs: 2 * MIN + 500, perSender: 1000 }, "an age that is not whole seconds"], [{ maxAgeMs: DAY, perSender: 0 }, "a count of 0"]] as const) {
    const e = await thrown(() => setChatHistoryLimit(jsm, V, limit));
    check(`setChatHistoryLimit refuses ${what}`, e instanceof Error && e.message.startsWith("invalid chat history limit"), e);
  }
  const moved = await thrown(() => setChatHistoryLimit(jsm, V, { maxAgeMs: DAY, perSender: 10 }, { maxAgeMs: 7 * DAY, perSender: 10 }));
  check("a stream that holds another limit than the caller read is refused", moved instanceof ChatHistoryChanged && same(moved.found, CHAT_HISTORY_DEFAULT), moved);
  check("...and nothing was written", same(await chatLimit(jsm, V), CHAT_HISTORY_DEFAULT));
  const noop = await setChatHistoryLimit(jsm, V, CHAT_HISTORY_DEFAULT, CHAT_HISTORY_DEFAULT);
  check("setting the limit a stream holds is a no-op", noop === undefined);

  // Recall: the cap rule and the head rule.
  const R = "chlrecall";
  await setupSpaceStreams({ servers: open.servers, space: R });
  await setChatHistoryLimit(jsm, R, { maxAgeMs: 30 * DAY, perSender: 3 });
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
  const expiry = await setChatHistoryLimit(jsm, E, { maxAgeMs: 2 * MIN, perSender: 1000 }, CHAT_HISTORY_DEFAULT);
  let messages = -1;
  for (let i = 0; i < 50 && messages !== 0; i++) { messages = (await jsm.streams.info(chatStream(E))).state.messages; if (messages !== 0) await wait(200); }
  check("setting a 2-minute age makes the broker delete posts older than it", expiry !== undefined && messages === 0, { expiry, messages });
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
