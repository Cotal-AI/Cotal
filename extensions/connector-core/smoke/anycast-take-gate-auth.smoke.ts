/**
 * The connector half of anycast request status, live (SPEC §8.1): on a JWT-auth broker with a real
 * delivery daemon, a MeshAgent holding a role shows a role request only once its take is recorded,
 * drops one its sender cancelled first without ever showing it, holds one nobody can record, and a
 * sending MeshAgent shows the daemon's notice as a notice. A read takes only the requests it shows,
 * a request taken and not yet shown is taken again after a reconnect, a take still waiting when the
 * link drops ends with that link and its request is announced again, and an exact drain acks no
 * request that was never shown. A request's arrival is announced once: a read that waits on its take
 * announces nothing more, so a gateway reader is woken once per request and again by the next DM,
 * and only a take that lands after its read stopped waiting is announced again. `cotal_anycast` is driven through its spec for the send, status and
 * cancel results and for the calls it must refuse, including a seq that names two of this session's
 * requests after the role queue was recreated. A held request wakes nothing while its retry is waited
 * out or once its copy ran out, a read whose caller left takes nothing, a read reports what its own
 * takes left held and carries what needs no take when a take is undecided, naming nothing of a
 * request it never asked, a read after a reconnect on the same connection asks again while with no
 * read since the old take ending announces the request again, a copy from a recreated stream is
 * delivered again at once, and a
 * gateway read that waits on a take leaves its reader's wake latch neither set over an empty inbox
 * nor unsignalled for a message that arrived during it. While the link is down a held request is
 * offered to no read, its take out or not, and wakes nothing, and it is announced again once the
 * link is back. A held request keeps its arrival place among what needs no take, offered and then
 * shown ahead of chatter that arrived after it.
 *
 * Run: pnpm smoke:anycast-take-gate:auth   (needs `nats-server` on PATH; local-only)
 */
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer, connect as netConnect, type Socket } from "node:net";
import { connect, credsAuthenticator, nanos, type Msg } from "@nats-io/transport-node";
import { jetstreamManager } from "@nats-io/jetstream";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import {
  ANYCAST_NOTICE_KEY,
  ANYCAST_TAKES_OP,
  CotalEndpoint,
  DEV_OWNER,
  createSpaceAuth,
  isReachable,
  mintCreds,
  mintLifecycleUid,
  newIdentity,
  provisionAgent,
  seedChannelRegistry,
  serverConfig,
  setupSpaceStreams,
  spacePrefix,
  TAKE_ROUTE,
  takeServeFilter,
  taskStream,
} from "../../../packages/core/dist/index.js";
import { MeshAgent, type InboxItem } from "../src/agent.js";
import type { AgentConfig } from "../src/config.js";
import { cotalToolSpecs, type CotalToolSpec } from "../src/tool-specs.js";
import { fmtItem } from "../src/framing.js";
import { registerCotalGatewayTools, type GatewayConnection } from "../src/gateway.js";
import { pickFreePort } from "./_free-port.js";
import { SMOKE_BROKER_TOKEN, awaitBrokerReady, createSuite, teardownOnSignal } from "@cotal-ai/smoke-kit";

const PORT = await pickFreePort();
const servers = `nats://127.0.0.1:${PORT}`;
const space = `anycast-gate-${randomUUID().slice(0, 8)}`;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const { check, finish } = createSuite();
const awaitExit = (proc: ReturnType<typeof spawn>, timeoutMs = 3000): Promise<void> =>
  new Promise((resolve) => {
    if (proc.exitCode !== null || proc.signalCode !== null) return resolve();
    proc.once("exit", () => resolve());
    setTimeout(resolve, timeoutMs);
  });
async function until<T>(read: () => T | undefined | false, ms = 8000): Promise<T | undefined> {
  const deadline = Date.now() + ms;
  for (;;) {
    const v = read();
    if (v !== undefined && v !== false) return v;
    if (Date.now() > deadline) return undefined;
    await sleep(50);
  }
}

const dir = mkdtempSync(join(tmpdir(), SMOKE_BROKER_TOKEN));
const auth = await createSpaceAuth(space);
writeFileSync(join(dir, "server.conf"), serverConfig(auth, [auth], { transport: { kind: "plaintext" }, port: PORT, storeDir: join(dir, "js") }));
const srv = spawn("nats-server", ["-c", join(dir, "server.conf")], { stdio: "ignore" });
const releaseBroker = teardownOnSignal(srv, dir);
const stops: Array<() => Promise<unknown>> = [];

try {
  await awaitBrokerReady(() => isReachable(servers), { servers, attempts: 50, delayMs: 200 });
  const provCreds = await mintCreds(auth, newIdentity(), "provisioner");
  await setupSpaceStreams({ servers, space, creds: provCreds });
  await seedChannelRegistry({ servers, space, creds: provCreds, file: { defaults: { replay: false }, channels: { team: { replay: false } } } });
  const mgr = new CotalEndpoint({ space, servers, creds: provCreds, card: { name: "mgr", kind: "endpoint" }, consume: false, registerPresence: false, watchPresence: false });
  mgr.on("error", () => {});
  await mgr.start();
  stops.push(() => mgr.stop());

  let lease: number | undefined;
  const startDaemon = async () => {
    const d = new CotalEndpoint({ space, servers, creds: await mintCreds(auth, newIdentity(), "delivery"), channels: [], consume: false, watchPresence: false, registerPresence: false, card: { name: "delivery", role: "delivery", kind: "endpoint" } });
    d.on("error", () => {});
    d.on("warning", () => {});
    await d.start();
    await d.startPlane3((owner, uid) => d.aclForOwner(owner, uid));
    lease = await d.acquireDeliveryLease(0);
    stops.push(() => d.stop());
    return d;
  };
  let daemon = await startDaemon();

  const mkAgent = async (name: string, role?: string, channels: string[] = [], via = servers) => {
    const ident = newIdentity();
    const uid = mintLifecycleUid();
    const creds = await provisionAgent(mgr, auth, ident, { subscribe: channels, allowSubscribe: channels, allowPublish: channels, role, lifecycleUid: uid });
    const config: AgentConfig = { space, name, role, servers: via, creds, subscribe: channels, allowSubscribe: channels, allowPublish: channels, kind: "agent", tls: false, id: ident.id, lifecycleUid: uid };
    const agent = new MeshAgent(config);
    agent.on("error", () => {});
    const incoming: InboxItem[] = [];
    agent.on("incoming", (item: InboxItem) => incoming.push(item));
    agent.start();
    stops.push(() => agent.stop());
    await until(() => agent.connected, 10_000);
    const tools = new Map(cotalToolSpecs(config, "smoke").map((s) => [s.name, s] as const));
    const tool = (name: string) => tools.get(name) as CotalToolSpec;
    return { agent, config, incoming, tool, id: `${DEV_OWNER}.${ident.id}` };
  };

  // Every role request a read could show, taken for that read, the way a host that shows it all does.
  const takeAll = (agent: MeshAgent) => agent.takeChosen("all", (preview) => preview);
  const holder = await mkAgent("reviewer_x", "reviewer");
  const sender = await mkAgent("asker");
  await until(() => sender.agent.ep.getRoster().some((p) => p.card.id === holder.id), 8000);
  const anycastTool = sender.tool("cotal_anycast");
  const run = (args: Record<string, unknown>) => anycastTool.run(sender.agent, sender.config, args);

  // ── 1. the send result names holders and the seq ───────────────────────────────────────────
  console.log("[1] send, then the holder shows it only after its take");
  const sent = await run({ role: "reviewer", text: "review the gate please" });
  const seq = Number(/seq (\d+)/.exec(sent.text)?.[1]);
  check("1a the send result gives a seq", Number.isSafeInteger(seq) && !sent.isError, sent.text);
  check("1b it names the holder online at send, by name and id", sent.text.includes(`reviewer_x (${holder.id})`), sent.text);
  check("1c it says how to read status and cancel", sent.text.includes(`seq ${seq} and cancel: true`), sent.text);
  const key = await until(() => holder.agent.inboxKeys().find((k) => k !== undefined));
  check("1d the request reached the holder's connector", key !== undefined);
  check("1e it counts toward a wake while held", holder.agent.inboxWake() >= 1 && holder.agent.inboxScope(key!) === "automatic");
  check("1f a read before the take does not show it", !holder.agent.peekInbox().some((i) => i.recvKey === key));
  await takeAll(holder.agent);
  const shown = holder.agent.peekInbox().find((i) => i.recvKey === key);
  check("1g after its take it is shown", shown !== undefined && shown.kind === "anycast" && shown.text === "review the gate please");
  check("1h it was announced once: the take its read waited on is not announced again", holder.incoming.filter((i) => i.recvKey === key).length === 1);
  holder.agent.drainInboxDeliveries([key!]);

  const notice = await until(() => sender.agent.peekInbox().find((i) => i.notice === "anycast"));
  check("1i the sender gets the taken notice as a notice", notice !== undefined && notice.text.includes(`reviewer_x (${holder.id}) took your @reviewer request (seq ${seq})`), notice);
  check("1j it renders as the delivery daemon's notice, not a peer DM", notice !== undefined && fmtItem(notice).startsWith("[anycast notice from the delivery daemon]"), notice && fmtItem(notice));
  const unanswered = (sender.agent as unknown as { unanswered: Map<string, unknown> }).unanswered;
  check("1k a notice is not a DM waiting for an answer", notice !== undefined && !unanswered.has(notice.id));
  if (notice) sender.agent.drainInboxDeliveries([notice.recvKey]);

  const st = await run({ seq });
  check("1l status names the taker and points to cotal_run", st.text.includes(`taken by reviewer_x (${holder.id})`) && st.text.includes("cotal_run"), st.text);
  const cx = await run({ seq, cancel: true });
  check("1m a cancel after the take is refused, naming the taker", cx.text.startsWith("Not cancelled") && cx.text.includes(holder.id), cx.text);

  // ── 2. cancelled before the take: dropped, never shown ─────────────────────────────────────
  console.log("[2] a request cancelled before its take is never shown");
  const sent2 = await run({ role: "reviewer", text: "scratch that" });
  const seq2 = Number(/seq (\d+)/.exec(sent2.text)?.[1]);
  const key2 = await until(() => holder.agent.inboxKeys().find((k) => k !== key));
  const c2 = await run({ seq: seq2, cancel: true });
  check("2a the cancel wins before any take", c2.text.startsWith(`Cancelled request seq ${seq2}`) && c2.text.includes("removed from the queue"), c2.text);
  await takeAll(holder.agent);
  check("2b the holder never shows it", !holder.agent.peekInbox().some((i) => i.recvKey === key2));
  check("2c and drops its copy", !holder.agent.inboxKeys().includes(key2!));
  check("2d nor records it as asked of the holder", !(holder.agent as unknown as { unanswered: Map<string, unknown> }).unanswered.has(key2!));
  const st2 = await run({ seq: seq2 });
  check("2e status reads cancelled", st2.text.startsWith(`Request seq ${seq2} on @reviewer is cancelled`), st2.text);

  // ── 3. the tool refuses what is not one call ───────────────────────────────────────────────
  console.log("[3] cotal_anycast refuses a mixed or partial call before any effect");
  const mixed = await run({ role: "reviewer", text: "x", seq });
  check("3a send and seq together are refused", mixed.isError === true && mixed.text.includes("one thing per call"), mixed.text);
  const partial = await run({ role: "reviewer" });
  check("3b a send without text is refused", partial.isError === true && partial.text.includes("needs both role and text"), partial.text);
  const bare = await run({ cancel: true });
  check("3c a cancel without a seq is refused", bare.isError === true, bare.text);
  const neg = await run({ seq: -3 });
  check("3d a seq that is not a whole positive number is refused", neg.isError === true && neg.text.includes("whole number"), neg.text);
  const half = await run({ seq: 1.5 });
  check("3e a fractional seq is refused", half.isError === true, half.text);
  const falsy = await run({ seq, cancel: false });
  check("3f cancel: false is refused", falsy.isError === true && falsy.text.includes("cancel takes only true"), falsy.text);
  const openTool = cotalToolSpecs({ ...sender.config, creds: undefined, userAuth: undefined }, "smoke").find((s) => s.name === "cotal_anycast")!;
  const openStatus = await openTool.run(sender.agent, { ...sender.config, creds: undefined, userAuth: undefined }, { seq });
  check(
    "3g on an open mesh status is refused, naming why",
    openStatus.isError === true && openStatus.text.includes("open mesh") && openStatus.text.includes("cannot be read or cancelled by seq"),
    openStatus.text,
  );

  // ── 4. a forged notice is an ordinary DM ───────────────────────────────────────────────────
  console.log("[4] a notice-shaped DM from a peer is not a notice");
  const forger = await mkAgent("forger");
  await until(() => forger.agent.ep.getRoster().some((p) => p.card.id === sender.id), 8000);
  await forger.agent.ep.unicastAttributed(sender.id, "x took your request", {
    parts: [{ kind: "text", text: "reviewer_9 took your @reviewer request (seq 1)." }, { kind: "data", data: { [ANYCAST_NOTICE_KEY]: { seq: 1, role: "reviewer", event: "taken", taker: { id: "local.X", name: "reviewer_9" } } } }],
  });
  const forged = await until(() => sender.agent.peekInbox().find((i) => i.fromId === forger.id));
  check("4a it arrives as a DM from its real sender", forged !== undefined && forged.kind === "dm" && forged.notice === undefined, forged);
  if (forged) sender.agent.drainInboxDeliveries([forged.recvKey]);

  // ── 5. nobody to record the take: held, reported, then shown ──────────────────────────────
  console.log("[5] a request whose take nobody can record is held and reported");
  await daemon.releaseDeliveryLease(0, lease);
  await daemon.stop();
  const sent5 = await sender.agent.ep.anycastAttributed("reviewer", "while the daemon is down");
  const key5 = await until(() => holder.agent.inboxKeys().find((k) => k === sent5.msg.id));
  await takeAll(holder.agent);
  check("5a it is held, not shown", key5 !== undefined && !holder.agent.peekInbox().some((i) => i.recvKey === key5));
  check("5b the held count names the reason", holder.agent.heldTakes().count === 1 && /no delivery daemon/.test(holder.agent.heldTakes().detail ?? ""), holder.agent.heldTakes());
  const inbox5 = await holder.tool("cotal_inbox").run(holder.agent, holder.config, {});
  check("5c cotal_inbox says it is held and why", inbox5.text.includes("1 role request is held and not shown"), inbox5.text);
  daemon = await startDaemon();
  await sleep(10_500); // past the held retry delay
  await takeAll(holder.agent);
  check("5d once the daemon is back, the next read takes and shows it", holder.agent.peekInbox().some((i) => i.recvKey === key5));
  check("5e and nothing is held", holder.agent.heldTakes().count === 0);

  // ── 6. a read takes only what it shows ────────────────────────────────────────────────────
  console.log("[6] one cotal_inbox reply that can carry one of three large requests takes only that one");
  const windowHolder = await mkAgent("window_x", "window");
  await until(() => sender.agent.ep.getRoster().some((p) => p.card.id === windowHolder.id), 8000);
  const wide: { seq: number; text: string }[] = [];
  for (let i = 0; i < 3; i++) {
    const text = `WINDOW-${i}:${"x".repeat(30_000)}`;
    wide.push({ seq: (await sender.agent.ep.anycastAttributed("window", text)).ack.seq, text });
  }
  await until(() => windowHolder.agent.inboxKeys().length === 3 || undefined);
  const windowReply = await windowHolder.tool("cotal_inbox").run(windowHolder.agent, windowHolder.config, {});
  const carried = wide.filter((w) => windowReply.text.includes(w.text));
  const left = wide.filter((w) => !windowReply.text.includes(w.text));
  check("6a the reply carries one request and leaves two", carried.length === 1 && left.length === 2, { carried: carried.length, length: windowReply.text.length });
  const carriedStatus = carried[0] ? await sender.agent.ep.anycastStatus(carried[0].seq) : undefined;
  check("6b the request it carried reads taken", carriedStatus?.state === "taken", carriedStatus);
  const leftStatus = await Promise.all(left.map((w) => sender.agent.ep.anycastStatus(w.seq)));
  check("6c the requests it left still read waiting", leftStatus.length === 2 && leftStatus.every((st) => st.state === "waiting"), leftStatus);
  const leftCancel = left[0] ? await sender.agent.ep.cancelAnycast(left[0].seq) : undefined;
  check("6d and their sender can still cancel one", leftCancel?.state === "cancelled", leftCancel);
  const nextReply = await windowHolder.tool("cotal_inbox").run(windowHolder.agent, windowHolder.config, {});
  check(
    "6e the next read carries the one still waiting and never the cancelled one",
    left[1] !== undefined && nextReply.text.includes(left[1].text) && !nextReply.text.includes(left[0]!.text),
    nextReply.text.slice(0, 300),
  );

  // ── 7. a reconnect between take and show ──────────────────────────────────────────────────
  console.log("[7] a request taken and not yet shown is taken again after a reconnect");
  const sent7 = await sender.agent.ep.anycastAttributed("reviewer", "taken just before the link drops");
  const key7 = await until(() => holder.agent.inboxKeys().find((k) => k === sent7.msg.id));
  const taken7 = await holder.agent.takeChosen("all", (preview) => preview.filter((i) => i.recvKey === key7));
  check("7a it is taken for a read that has not shown it yet", taken7.some((i) => i.recvKey === key7));
  let downPeek: boolean | undefined;
  let downRead: Promise<{ text: string }> | undefined;
  const onDrop = (e: { connected: boolean }) => {
    if (e.connected || downPeek !== undefined) return;
    downPeek = holder.agent.peekInbox().some((i) => i.recvKey === key7);
    downRead = Promise.resolve(holder.tool("cotal_inbox").run(holder.agent, holder.config, { peek: true }));
  };
  holder.agent.on("transport", onDrop);
  await holder.agent.reconnect();
  holder.agent.off("transport", onDrop);
  check("7b when the link drops it is held again, not shown", downPeek === false, { downPeek });
  const downText = downRead ? (await downRead).text : "";
  check("7c a read during the drop does not carry it", downRead !== undefined && !downText.includes("taken just before the link drops"), downText.slice(0, 300));
  await until(() => holder.agent.connected || undefined, 10_000);
  const read7 = await holder.tool("cotal_inbox").run(holder.agent, holder.config, {});
  const status7 = await sender.agent.ep.anycastStatus(sent7.ack.seq);
  check(
    "7d after the reconnect a read takes it again and shows it",
    read7.text.includes("taken just before the link drops") && status7.state === "taken" && status7.taker.id === holder.id,
    { text: read7.text.slice(0, 300), status7 },
  );

  // ── 8. an exact drain of a request never shown ────────────────────────────────────────────
  console.log("[8] an exact drain acks no role request that was never shown");
  const sent8 = await sender.agent.ep.anycastAttributed("reviewer", "never shown before this drain");
  const key8 = await until(() => holder.agent.inboxKeys().find((k) => k === sent8.msg.id));
  const drained8 = holder.agent.drainInboxDeliveries([key8!]);
  check("8a the drain returns nothing for it", drained8.items.length === 0, drained8.items.map((i) => i.text));
  check("8b and does not report it missing", !drained8.missingKeys.includes(key8!), drained8.missingKeys);
  await sleep(150);
  const status8 = await sender.agent.ep.anycastStatus(sent8.ack.seq);
  check("8c it still reads waiting", status8.state === "waiting", status8);
  const shown8 = await takeAll(holder.agent);
  check("8d it is still held, and a read shows it once taken", shown8.some((i) => i.recvKey === key8));
  holder.agent.drainInboxDeliveries([key8!]);

  // ── 9. a waiting request's status reads who holds the role now ────────────────────────────
  console.log("[9] a waiting request's status names the role's holders online now, or says the read failed");
  const sent9 = await run({ role: "reviewer", text: "still waiting" });
  const seq9 = Number(/seq (\d+)/.exec(sent9.text)?.[1]);
  const waiting9 = await run({ seq: seq9 });
  check("9a a waiting request's status names the role's holder online now, by name and id", waiting9.text.startsWith(`Request seq ${seq9} on @reviewer is waiting on the queue, and no holder has taken it (holder online now: reviewer_x (${holder.id})).`), waiting9.text);
  const sentNobody = await run({ role: "nobody", text: "no one holds this role" });
  const seqNobody = Number(/seq (\d+)/.exec(sentNobody.text)?.[1]);
  const waitingNobody = await run({ seq: seqNobody });
  check("9b with no holder online it says none is", waitingNobody.text.startsWith(`Request seq ${seqNobody} on @nobody is waiting on the queue, and no holder has taken it (0 holders online now).`), waitingNobody.text);
  // A roster read that fails gives no holders at all, which is not the same as none online.
  const roleHolders = sender.agent.roleHolders.bind(sender.agent);
  sender.agent.roleHolders = async () => undefined;
  let waitingUnknown: Awaited<ReturnType<typeof run>>;
  try { waitingUnknown = await run({ seq: seq9 }); } finally { sender.agent.roleHolders = roleHolders; }
  check("9c a failed roster read reads unknown, not empty", waitingUnknown.text.includes("(holders unknown now: the presence view was not current)"), waitingUnknown.text);
  await run({ seq: seq9, cancel: true });
  await run({ seq: seqNobody, cancel: true });

  // ── 10. a take a read waits on is not announced again ─────────────────────────────────────
  // Its own role, so no earlier holder competes for these requests. The gateway wakes its reader
  // once per arrival and rearms on a read, so a second announcement during the read would leave
  // the reader signalled over an empty inbox and the next DM would wake nobody.
  console.log("[10] a take a read waits on is not announced again; one that lands after the read is");
  const gw = await mkAgent("gw_holder", "gwrole");
  await until(() => sender.agent.ep.getRoster().some((p) => p.card.id === gw.id), 8000);
  const signals: number[] = [];
  const gwConn: GatewayConnection = { id: "conn-gw", agent: gw.agent, config: gw.config };
  const gwServer = new McpServer({ name: "gw", version: "0" });
  registerCotalGatewayTools(gwServer, {
    account: () => "acc",
    open: async () => gwConn,
    find: async (_account, id) => (id === gwConn.id ? gwConn : undefined),
    close: async () => true,
  }, "gateway", { wake: { listening: () => "Notifications enabled.", signal: (_c, preview) => { signals.push(preview.unread); return true; } } });
  const [gwClientSide, gwServerSide] = InMemoryTransport.createLinkedPair();
  const gwClient = new Client({ name: "smoke", version: "0" });
  await gwServer.connect(gwServerSide);
  await gwClient.connect(gwClientSide);
  stops.push(() => gwClient.close());
  await gwClient.callTool({ name: "cotal_connect", arguments: { name: "gw_holder" } });
  const gwRead = async () => {
    const r = await gwClient.callTool({ name: "cotal_inbox", arguments: { connection_id: gwConn.id } });
    return (r.content as { text?: string }[])[0]?.text ?? "";
  };
  await run({ role: "gwrole", text: "gateway request" });
  await until(() => signals.length === 1, 8000);
  check("10a a role request's arrival is announced once and wakes its gateway reader once", gw.incoming.length === 1 && signals.length === 1, { arrivals: gw.incoming.length, signals });
  const gwShown = await gwRead();
  check(
    "10b a read that waits on the take shows the request and announces it no more",
    gwShown.includes("gateway request") && gw.incoming.length === 1 && signals.length === 1,
    { gwShown, arrivals: gw.incoming.length, signals },
  );
  const beforeDm = signals.length;
  await sender.agent.ep.unicastAttributed(gw.id, "gateway dm after the read");
  await until(() => signals.length > beforeDm, 4000);
  check("10c a DM after that read wakes its reader again", signals.length === beforeDm + 1, { beforeDm, signals });
  await gwRead();
  await run({ role: "gwrole", text: "late take" });
  await until(() => gw.agent.inboxWake() > 0, 8000);
  const lateArrivals = gw.incoming.length;
  check(
    "10d the pending list a notice counts names a held request that a read cannot see yet",
    gw.agent.inboxPending("automatic").some((i) => i.text.includes("late take")) && !gw.agent.peekInbox("automatic").some((i) => i.text.includes("late take")),
    { pending: gw.agent.inboxPending("automatic").map((i) => i.text) },
  );
  const notWaited = await gw.agent.takeChosen("all", (preview) => preview, 0);
  await until(() => gw.agent.peekInbox().some((i) => i.text.includes("late take")), 8000);
  check(
    "10e a take that lands after its read stopped waiting is announced as an arrival",
    notWaited.length === 0 && gw.incoming.length === lateArrivals + 1,
    { notWaited: notWaited.length, arrivals: gw.incoming.length, lateArrivals },
  );
  await gwRead();

  // ── 11. a take still waiting when the link drops ──────────────────────────────────────────
  // A responder that receives the take, or the probe a take falls back to when nothing serves the
  // take rail, and never answers, keeps the take waiting. The link drops only once it has arrived.
  // nats.js does not settle a request whose connection closes before its answer.
  console.log("[11] a take still waiting when the link drops ends with that link, and the request is taken again");
  const stopDaemon = async () => {
    // Nothing here renews the daemon's lease, so the bucket TTL may have expired it already.
    await daemon.releaseDeliveryLease(0, lease).catch(async (e) => { if (await daemon.readDeliveryLease(0)) throw e; });
    await daemon.stop();
  };
  const silentResponder = async (subject: string, queue: string, wanted: (m: Msg) => boolean) => {
    const nc = await connect({ servers, authenticator: credsAuthenticator(new TextEncoder().encode(await mintCreds(auth, newIdentity(), "delivery"))), maxReconnectAttempts: 0 });
    stops.push(() => nc.close());
    let arrived!: () => void;
    const received = new Promise<void>((resolve) => { arrived = resolve; });
    nc.subscribe(subject, { queue, callback: (_e, m) => { if (wanted(m)) arrived(); } });
    await nc.flush();
    return { received: Promise.race([received.then(() => true), sleep(10_000).then(() => false)]), close: () => nc.close() };
  };
  const dropper = await mkAgent("drop_holder", "droprole");
  await until(() => sender.agent.ep.getRoster().some((p) => p.card.id === dropper.id), 8000);
  const sent11 = await sender.agent.ep.anycastAttributed("droprole", "asked as the link drops");
  const key11 = await until(() => dropper.agent.inboxKeys().find((k) => k === sent11.msg.id));
  await stopDaemon();
  const takeRail = await silentResponder(takeServeFilter(space), TAKE_ROUTE, () => true);
  const waitMs11 = 8000;
  const started11 = Date.now();
  const read11 = dropper.agent.takeChosen("all", (preview) => preview.filter((i) => i.recvKey === key11), waitMs11);
  const asked11 = await takeRail.received;
  // The link drops while the take is out, so a read then could not show the request (11h).
  let offered11: boolean | undefined;
  const onDrop11 = (e: { connected: boolean }) => {
    if (e.connected || offered11 !== undefined) return;
    offered11 = dropper.agent.inboxPreview().some((i) => i.recvKey === key11);
  };
  dropper.agent.on("transport", onDrop11);
  await dropper.agent.reconnect();
  dropper.agent.off("transport", onDrop11);
  const shown11 = await read11;
  const ended11 = Date.now() - started11;
  check(
    "11a a read waiting on that take ends with the old link, well before its wait runs out, and shows nothing",
    asked11 && shown11.length === 0 && ended11 < waitMs11 / 2,
    { asked11, shown: shown11.length, ended11 },
  );
  await until(() => dropper.agent.connected || undefined, 10_000);
  const announced11 = await until(() => dropper.incoming.filter((i) => i.recvKey === key11).length === 2 || undefined, 3000);
  check("11b the request is announced again, so its host reads it once more", announced11 === true, { announced: dropper.incoming.filter((i) => i.recvKey === key11).length });
  check("11c no held reason is reported for it", dropper.agent.heldTakes().detail === undefined, dropper.agent.heldTakes());
  await takeRail.close();
  daemon = await startDaemon();
  const read11d = await dropper.agent.takeChosen("all", (preview) => preview.filter((i) => i.recvKey === key11));
  const status11 = await sender.agent.ep.anycastStatus(sent11.ack.seq);
  check(
    "11d the next read takes it on the new link and shows it",
    read11d.some((i) => i.recvKey === key11) && status11.state === "taken" && status11.taker.id === dropper.id,
    { shown: read11d.length, status11 },
  );

  const sent11e = await sender.agent.ep.anycastAttributed("droprole", "asked while only the probe can answer");
  const key11e = await until(() => dropper.agent.inboxKeys().find((k) => k === sent11e.msg.id));
  await stopDaemon();
  const probeRail = await silentResponder(`${spacePrefix(space)}.ctl.delivery.*.*`, "delivery", (m) => m.json<{ op?: string }>().op === ANYCAST_TAKES_OP);
  const started11e = Date.now();
  const read11e = dropper.agent.takeChosen("all", (preview) => preview.filter((i) => i.recvKey === key11e), waitMs11);
  const probed11e = await probeRail.received;
  await dropper.agent.reconnect();
  const shown11e = await read11e;
  const ended11e = Date.now() - started11e;
  check(
    "11e with nothing serving the take rail, a read waiting on the probe the take falls back to ends with the old link too",
    probed11e && shown11e.length === 0 && ended11e < waitMs11 / 2,
    { probed11e, shown: shown11e.length, ended11e },
  );
  await until(() => dropper.agent.connected || undefined, 10_000);
  await probeRail.close();
  daemon = await startDaemon();
  const read11f = await dropper.agent.takeChosen("all", (preview) => preview.filter((i) => i.recvKey === key11e));
  check("11f and the next read takes it on the new link and shows it", read11f.some((i) => i.recvKey === key11e), { shown: read11f.length });

  // A host reads one batch at a time and drops a wake that comes while it reads, as Codex and Jcode
  // drive. The daemon is back before the drop, so only the announcement decides when it is shown.
  const driven = await mkAgent("drive_holder", "driverole");
  await until(() => sender.agent.ep.getRoster().some((p) => p.card.id === driven.id), 8000);
  const driverShown = new Set<string>();
  let driving = false;
  const drive = async () => {
    if (driving) return;
    driving = true;
    try {
      for (const i of await driven.agent.takeChosen("automatic", (preview) => preview, waitMs11)) driverShown.add(i.recvKey);
    } finally {
      driving = false;
    }
  };
  driven.agent.on("incoming", () => void drive());
  await stopDaemon();
  const driveRail = await silentResponder(takeServeFilter(space), TAKE_ROUTE, () => true);
  const sent11g = await sender.agent.ep.anycastAttributed("driverole", "driven across the drop");
  const asked11g = await driveRail.received;
  await driveRail.close();
  daemon = await startDaemon();
  const drivingAtDrop = driving;
  await driven.agent.reconnect();
  const shown11g = await until(() => driverShown.has(sent11g.msg.id) || undefined, 5000);
  check(
    "11g a host that drops a wake while it reads is woken once the link is back, and shows it with no other mail",
    asked11g && drivingAtDrop && shown11g === true,
    { asked11g, drivingAtDrop, shown: [...driverShown] },
  );
  check("11h while the link is down a read is offered no request whose take was out when it dropped", offered11 === false, { offered11 });

  // ── 12. one seq naming two of this session's requests ─────────────────────────────────────
  // After every cell that uses the old stream, because it deletes and recreates the TASK stream.
  console.log("[12] a seq this session sent twice, across a queue recreation, is refused as ambiguous");
  const sent6 = await run({ role: "reviewer", text: "before the queue is recreated" });
  const seq6 = Number(/seq (\d+)/.exec(sent6.text)?.[1]);
  const teardownIdent = newIdentity();
  const teardownCreds = await mintCreds(auth, teardownIdent, "teardown", { lifecycleUid: mintLifecycleUid() });
  const teardownNc = await connect({ servers, authenticator: credsAuthenticator(new TextEncoder().encode(teardownCreds)), inboxPrefix: `_INBOX_${teardownIdent.id}`, maxReconnectAttempts: 0 });
  stops.push(() => teardownNc.close());
  await (await jetstreamManager(teardownNc)).streams.delete(taskStream(space));
  await setupSpaceStreams({ servers, space, creds: provCreds });
  let reused = false;
  for (let i = 0; i < seq6 && !reused; i++) {
    const again = await run({ role: "reviewer", text: `after the recreation ${i}` });
    reused = Number(/seq (\d+)/.exec(again.text)?.[1]) === seq6;
  }
  check("12a the recreated queue reused the seq", reused, { seq6 });
  const ambiguous = await run({ seq: seq6 });
  check(
    "12b a status by that seq is refused as ambiguous",
    ambiguous.isError === true && ambiguous.text.includes(`seq ${seq6} names 2 requests this session sent`) && ambiguous.text.includes("ambiguous"),
    ambiguous.text,
  );
  const ambiguousCancel = await run({ seq: seq6, cancel: true });
  check("12c and so is a cancel, which cancels nothing", ambiguousCancel.isError === true && ambiguousCancel.text.includes("nothing was asked or cancelled"), ambiguousCancel.text);

  // The cells below run after the recreation above, each on a role of its own, so the TASK stream
  // they bind is the new one. Cell 19 relies on reviewer_x still holding the old stream's creation
  // time, so it runs last.
  // With `signals`, the gateway wakes its reader, and each signal is recorded there.
  const gatewayFor = async (h: Awaited<ReturnType<typeof mkAgent>>, signals?: number[]) => {
    const conn: GatewayConnection = { id: `conn-${h.config.name}`, agent: h.agent, config: h.config };
    const server = new McpServer({ name: "gw", version: "0" });
    registerCotalGatewayTools(server, {
      account: () => "acc",
      open: async () => conn,
      find: async (_account, id) => (id === conn.id ? conn : undefined),
      close: async () => true,
    }, "gateway", signals ? { wake: { listening: () => "Notifications enabled.", signal: () => { signals.push(Date.now()); return true; } } } : {});
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "smoke", version: "0" });
    await server.connect(serverSide);
    await client.connect(clientSide);
    stops.push(() => client.close());
    await client.callTool({ name: "cotal_connect", arguments: { name: h.config.name } });
    return async (tool: string, args: Record<string, unknown> = {}, signal?: AbortSignal) => {
      const started = Date.now();
      const r = await client.callTool({ name: tool, arguments: { connection_id: conn.id, ...args } }, undefined, signal ? { signal } : undefined);
      return { ms: Date.now() - started, text: (r.content as { text?: string }[]).map((c) => c.text ?? "").join("\n") };
    };
  };
  const holderOf = async (name: string, role: string, channels: string[] = [], via = servers) => {
    const h = await mkAgent(name, role, channels, via);
    await until(() => sender.agent.ep.getRoster().some((p) => p.card.id === h.id), 8000);
    return h;
  };

  // ── 13. a held request waiting out its retry wakes nothing ────────────────────────────────
  console.log("[13] a role request waiting out a take nobody could decide wakes nothing until the wait ends");
  const backoff = await holderOf("backoff_holder", "backoffrole");
  const backoffCall = await gatewayFor(backoff);
  await stopDaemon();
  const sent13 = await sender.agent.ep.anycastAttributed("backoffrole", "held through a retry wait");
  await until(() => backoff.agent.inboxKeys().includes(sent13.msg.id));
  const held13 = await backoffCall("cotal_inbox");
  check("13a the read reports it held", held13.text.includes("1 role request is held and not shown"), held13.text);
  check(
    "13b while the retry is waited out it counts toward no wake",
    backoff.agent.pendingWake() === 0 && backoff.agent.inboxWake() === 0,
    { pending: backoff.agent.pendingWake(), wake: backoff.agent.inboxWake() },
  );
  const wait13 = await backoffCall("cotal_wait", { seconds: 2 });
  check("13c a cotal_wait then runs its time instead of returning at once", wait13.ms >= 1900 && wait13.text.startsWith("No new messages in 2 seconds"), wait13);
  daemon = await startDaemon();
  const announced13 = await until(() => backoff.incoming.filter((i) => i.recvKey === sent13.msg.id).length === 2 || undefined, 12_000);
  check(
    "13d when the wait ends it is announced again and counts toward a wake",
    announced13 === true && backoff.agent.inboxWake() === 1,
    { announced: backoff.incoming.filter((i) => i.recvKey === sent13.msg.id).length, wake: backoff.agent.inboxWake() },
  );
  const read13 = await backoffCall("cotal_inbox");
  check("13e and the next read shows it", read13.text.includes("held through a retry wait"), read13.text.slice(0, 300));

  // ── 14. a held copy whose ack wait ran out ────────────────────────────────────────────────
  // A short ack wait and one delivery on this role's queue, so the copy runs out within the cell and
  // nothing redelivers it. The holder binds again to read the new ack wait.
  console.log("[14] a held copy whose ack wait ran out wakes nothing and is named nowhere");
  const lapse = await holderOf("lapse_holder", "lapserole");
  const lapseCall = await gatewayFor(lapse);
  const provIdent = newIdentity();
  const provNc = await connect({ servers, authenticator: credsAuthenticator(new TextEncoder().encode(await mintCreds(auth, provIdent, "provisioner"))), inboxPrefix: `_INBOX_${provIdent.id}`, maxReconnectAttempts: 0 });
  stops.push(() => provNc.close());
  await (await jetstreamManager(provNc)).consumers.update(taskStream(space), "svc_lapserole", { ack_wait: nanos(2000), max_deliver: 1 });
  await lapse.agent.reconnect();
  await until(() => lapse.agent.connected || undefined, 10_000);
  const sent14 = await sender.agent.ep.anycastAttributed("lapserole", "held past its ack wait");
  await until(() => lapse.agent.inboxKeys().includes(sent14.msg.id));
  await sleep(2500);
  const notice14 = await lapseCall("cotal_connection_status");
  check("14a once its ack wait ran out it counts toward no wake", lapse.agent.inboxWake() === 0, { wake: lapse.agent.inboxWake() });
  check("14b another tool's reply says nothing is waiting", !notice14.text.includes("waiting. Read"), notice14.text.slice(-200));
  const wait14 = await lapseCall("cotal_wait", { seconds: 2 });
  check("14c and a cotal_wait runs its time", wait14.ms >= 1900 && wait14.text.startsWith("No new messages in 2 seconds"), wait14);

  // ── 15. a read whose caller left ──────────────────────────────────────────────────────────
  // The first read waits on a take nothing answers; the second queues behind it, and its caller
  // leaves before it runs.
  console.log("[15] a read whose caller left before it ran takes nothing");
  const abandoned = await holderOf("abandon_holder", "abandonrole");
  const abandonCall = await gatewayFor(abandoned);
  await stopDaemon();
  const rail15 = await silentResponder(takeServeFilter(space), TAKE_ROUTE, () => true);
  const first15 = await sender.agent.ep.anycastAttributed("abandonrole", "its take hangs");
  await until(() => abandoned.agent.inboxKeys().includes(first15.msg.id));
  const readA15 = abandonCall("cotal_inbox");
  await rail15.received;
  await rail15.close();
  daemon = await startDaemon();
  const second15 = await sender.agent.ep.anycastAttributed("abandonrole", "asked by a read whose caller left");
  await until(() => abandoned.agent.inboxKeys().includes(second15.msg.id));
  const gone15 = new AbortController();
  const readB15 = abandonCall("cotal_inbox", {}, gone15.signal).catch(() => undefined);
  await sleep(100);
  gone15.abort();
  await readA15;
  await readB15;
  await sleep(1000);
  const status15 = await sender.agent.ep.anycastStatus(second15.ack.seq);
  check("15a the request that read would have shown still reads waiting", status15.state === "waiting", status15);
  check("15b and its sender can still cancel it", (await sender.agent.ep.cancelAnycast(second15.ack.seq)).state === "cancelled");

  // ── 16. the held note is read after the read's takes ──────────────────────────────────────
  console.log("[16] a read reports the requests its own takes left held");
  const noted = await holderOf("noted_holder", "notedrole");
  const notedCall = await gatewayFor(noted);
  await stopDaemon();
  const sent16 = await sender.agent.ep.anycastAttributed("notedrole", "held beside a dm");
  await until(() => noted.agent.inboxKeys().includes(sent16.msg.id));
  await sender.agent.ep.unicastAttributed(noted.id, "a dm beside it");
  await until(() => noted.agent.peekInbox().some((i) => i.text === "a dm beside it"));
  const read16 = await notedCall("cotal_inbox");
  check("16a a read that shows a DM names the request its take left held", read16.text.includes("a dm beside it") && read16.text.includes("1 role request is held and not shown"), read16.text);
  const focused = await holderOf("focused_holder", "focusedrole");
  const focusedCall = await gatewayFor(focused);
  await focused.agent.setAttention("focus");
  const sent16b = await sender.agent.ep.anycastAttributed("focusedrole", "held in focus");
  await until(() => focused.agent.inboxKeys().includes(sent16b.msg.id));
  const read16b = await focusedCall("cotal_inbox");
  check("16b in focus mode a read whose take left it held says so, not that the inbox is empty", read16b.text.includes("1 role request is held and not shown") && !read16b.text.includes("Inbox empty"), read16b.text);
  daemon = await startDaemon();

  // ── 17. a take still undecided gives way to what needs none ───────────────────────────────
  // A role request too big to share a reply with the channel post behind it, whose take nothing
  // answers.
  console.log("[17] a read whose take is still undecided carries what needs no take");
  const slow = await holderOf("slow_holder", "slowrole", ["team"]);
  const slowCall = await gatewayFor(slow);
  const poster = await mkAgent("poster", undefined, ["team"]);
  await stopDaemon();
  const rail17 = await silentResponder(takeServeFilter(space), TAKE_ROUTE, () => true);
  const sent17 = await sender.agent.ep.anycastAttributed("slowrole", `big role request ${"r".repeat(40_000)}`);
  await until(() => slow.agent.inboxKeys().includes(sent17.msg.id));
  await poster.agent.send(`channel post ${"c".repeat(20_000)}`, "team");
  await until(() => slow.agent.peekInbox().some((i) => i.text.startsWith("channel post")));
  const read17 = await slowCall("cotal_inbox");
  check(
    "17a the reply carries the channel post and not the request",
    read17.text.includes("channel post") && !read17.text.includes("big role request"),
    read17.text.slice(0, 300),
  );
  check("17b and clears the post", !slow.agent.peekInbox().some((i) => i.text.startsWith("channel post")));
  check("17d an unanswered take is reported while its native request still waits",
    read17.text.includes("1 role request is held and not shown") && slow.agent.heldTakes().count === 1,
    { held: slow.agent.heldTakes(), reply: read17.text.slice(0, 300) });
  check("17e an in-flight take does not wake another empty read",
    slow.agent.pendingWake() === 0 && slow.agent.inboxWake() === 0,
    { pending: slow.agent.pendingWake(), wake: slow.agent.inboxWake() });
  const wait17 = await slowCall("cotal_wait", { seconds: 1 });
  check("17f a wait during an unanswered take waits for new showable work",
    wait17.ms >= 800 && wait17.text === "No new messages in 1 second. Call cotal_wait again to keep listening.",
    { ms: wait17.ms, text: wait17.text });
  // A role request that fits a reply, whose take nothing answers, with one too big for any reply
  // behind it whose take the read never asks for.
  const behind = await holderOf("behind_holder", "behindrole");
  const behindCall = await gatewayFor(behind);
  const sent17c = await sender.agent.ep.anycastAttributed("behindrole", `fits one reply ${"f".repeat(45_000)}`);
  await until(() => behind.agent.inboxKeys().includes(sent17c.msg.id));
  const sent17d = await sender.agent.ep.anycastAttributed("behindrole", `too big for any reply ${"t".repeat(60_000)}`);
  await until(() => behind.agent.inboxKeys().includes(sent17d.msg.id));
  const read17c = await behindCall("cotal_inbox");
  check(
    "17c a read whose take is undecided names nothing of the request behind it that it never asked",
    !read17c.text.includes("larger than one response") && !read17c.text.includes("asker") && !read17c.text.includes("too big for any reply"),
    read17c.text.slice(0, 300),
  );
  await rail17.close();
  daemon = await startDaemon();

  // ── 18. a take in flight across a reconnect on the same connection ────────────────────────
  // The holder reaches the broker through a proxy, so its link drops while the broker stays up and
  // nats.js reconnects the same connection. The take the read asked for gets no answer on the old link.
  console.log("[18] after a reconnect on the same connection a read asks again instead of waiting on the old take");
  const proxyPort = await pickFreePort();
  const proxied = new Set<Socket>();
  const proxy = createServer((client) => {
    const upstream = netConnect(PORT, "127.0.0.1");
    proxied.add(client);
    proxied.add(upstream);
    client.pipe(upstream).pipe(client);
    const end = () => { client.destroy(); upstream.destroy(); proxied.delete(client); proxied.delete(upstream); };
    for (const s of [client, upstream]) { s.on("error", end); s.on("close", end); }
  });
  await new Promise<void>((resolve) => proxy.listen(proxyPort, "127.0.0.1", resolve));
  stops.push(() => new Promise((resolve) => proxy.close(() => resolve(undefined))));
  const inPlace = await holderOf("inplace_holder", "inplacerole", [], `nats://127.0.0.1:${proxyPort}`);
  await stopDaemon();
  // Takes reach a rail that never answers, so each one waits out its request timeout.
  const railNc18 = await connect({ servers, authenticator: credsAuthenticator(new TextEncoder().encode(await mintCreds(auth, newIdentity(), "delivery"))), maxReconnectAttempts: 0 });
  stops.push(() => railNc18.close());
  const asked18: number[] = [];
  railNc18.subscribe(takeServeFilter(space), { queue: TAKE_ROUTE, callback: () => { asked18.push(Date.now()); } });
  await railNc18.flush();
  const sent18 = await sender.agent.ep.anycastAttributed("inplacerole", "asked across an in-place reconnect");
  await until(() => inPlace.agent.inboxKeys().includes(sent18.msg.id));
  const read18 = inPlace.agent.takeChosen("all", (preview) => preview.filter((i) => i.recvKey === sent18.msg.id), 1500);
  await until(() => asked18.length === 1 || undefined, 5000);
  for (const s of proxied) s.destroy();
  await until(() => !inPlace.agent.connected || undefined, 3000);
  await until(() => inPlace.agent.connected || undefined, 15_000);
  await read18;
  await inPlace.agent.takeChosen("all", (preview) => preview.filter((i) => i.recvKey === sent18.msg.id), 500);
  check("18a a read after the reconnect asks for the take again rather than waiting on the old link's", asked18.length === 2, { asked: asked18.length });
  // The old take ends at its request timeout, while the one asked on the new link still waits.
  await sleep(Math.max(0, asked18[0]! + 5_500 - Date.now()));
  check(
    "18b the old take ending announces nothing while the new one is still asked",
    inPlace.incoming.filter((i) => i.recvKey === sent18.msg.id).length === 1,
    { announced: inPlace.incoming.filter((i) => i.recvKey === sent18.msg.id).length },
  );
  await inPlace.agent.takeChosen("all", (preview) => preview.filter((i) => i.recvKey === sent18.msg.id), 200);
  check("18c and a read then waits on the new take rather than asking a third time", asked18.length === 2, { asked: asked18.length });
  // With no read after the reconnect, nothing asks again on the new link, so the old take ending is
  // what tells the host about the request once more. The takes above ended undecided, so their
  // retry wait is let pass first.
  await sleep(Math.max(0, asked18[1]! + 5_000 + 10_500 - Date.now()));
  const sent18d = await sender.agent.ep.anycastAttributed("inplacerole", "asked across a reconnect nothing reads after");
  const announcedAt18d: number[] = [];
  const onAnnounce18d = (i: InboxItem) => { if (i.recvKey === sent18d.msg.id) announcedAt18d.push(Date.now()); };
  inPlace.agent.on("incoming", onAnnounce18d);
  await until(() => inPlace.agent.inboxKeys().includes(sent18d.msg.id));
  void inPlace.agent.takeChosen("all", (preview) => preview.filter((i) => i.recvKey === sent18d.msg.id), 200);
  const asked18d = await until(() => (asked18.length === 3 ? asked18[2] : undefined), 5000);
  // The drop and the return can come faster than a poll, so the agent's own edges are recorded.
  const edges18d: Array<{ connected: boolean; at: number }> = [];
  const onEdge18d = (e: { connected: boolean }) => edges18d.push({ connected: e.connected, at: Date.now() });
  inPlace.agent.on("transport", onEdge18d);
  for (const s of proxied) s.destroy();
  const down18d = await until(() => edges18d.find((e) => !e.connected)?.at, 3000);
  const up18d = await until(() => edges18d.find((e) => e.connected && down18d !== undefined && e.at >= down18d)?.at, 15_000);
  await until(() => inPlace.agent.connected || undefined, 15_000);
  await sleep(Math.max(0, (asked18d ?? Date.now()) + 5_500 - Date.now()));
  inPlace.agent.off("incoming", onAnnounce18d);
  inPlace.agent.off("transport", onEdge18d);
  // Only the arrival is announced before the drop. The link is back while the old take is still out,
  // so the one announcement after the drop is the old take ending, not the return of the link.
  const before18d = announcedAt18d.filter((t) => down18d !== undefined && t < down18d).length;
  const after18d = announcedAt18d.filter((t) => down18d !== undefined && t >= down18d);
  check(
    "18d with no read since the reconnect, the old take ending announces the request once more",
    asked18d !== undefined && down18d !== undefined && up18d !== undefined && up18d - asked18d < 4_000 && before18d === 1 &&
      after18d.length === 1 && after18d[0]! - asked18d >= 4_000 && asked18.length === 3,
    {
      asked18d: asked18d !== undefined, downFromAsk: asked18d && down18d && down18d - asked18d, upFromAsk: asked18d && up18d && up18d - asked18d,
      before18d, afterFromAsk: after18d.map((t) => t - (asked18d ?? 0)), asked: asked18.length,
    },
  );
  await railNc18.close();
  daemon = await startDaemon();

  // ── 19. a holder whose consumer resumed on the recreated stream ───────────────────────────
  // reviewer_x bound before cell 12 recreated the stream. Once its consumer is back, nats.js resumes
  // on the new stream, and the copies it delivers carry the old creation time.
  console.log("[19] a copy from a recreated stream is delivered again at once with the new creation time");
  await mgr.provisionTaskQueue("reviewer");
  const sent19 = await sender.agent.ep.anycastAttributed("reviewer", "after the consumer resumed");
  const arrived19 = await until(() => holder.agent.inboxKeys().includes(sent19.msg.id) || undefined, 90_000);
  const started19 = Date.now();
  let shown19 = false;
  while (!shown19 && Date.now() - started19 < 15_000) {
    shown19 = (await takeAll(holder.agent)).some((i) => i.recvKey === sent19.msg.id);
    if (!shown19) await sleep(500);
  }
  check(
    "19a its first take is refused as a mismatch, and the copy delivered again is taken and shown within seconds",
    arrived19 === true && shown19 && Date.now() - started19 < 15_000,
    { arrived: arrived19, shown: shown19, ms: Date.now() - started19 },
  );

  // ── 20. a gateway reader's wake around a read that waits on a take ────────────────────────
  // Takes reach a rail that records each one a second after it is asked, so a read that takes a role
  // request waits that second and shows it. The gateway clears its wake latch when a read starts and
  // signals nothing while the read runs.
  console.log("[20] a read that waits on a take neither leaves the wake latch set over an empty inbox nor leaves a message unsignalled");
  await stopDaemon();
  const railNc20 = await connect({ servers, authenticator: credsAuthenticator(new TextEncoder().encode(await mintCreds(auth, newIdentity(), "delivery"))), maxReconnectAttempts: 0 });
  stops.push(() => railNc20.close());
  railNc20.subscribe(takeServeFilter(space), { queue: TAKE_ROUTE, callback: (_e, m) => {
    setTimeout(() => m.respond(JSON.stringify({ ok: true })), 1000);
  } });
  await railNc20.flush();
  const buffered = (h: Awaited<ReturnType<typeof mkAgent>>, text: string) => h.agent.peekInbox().some((i) => i.text === text);
  // A read queued behind one whose take waits shows a DM that arrived while it was queued.
  const queued = await holderOf("queued_reader", "queuedrole");
  const queuedSignals: number[] = [];
  const queuedCall = await gatewayFor(queued, queuedSignals);
  await sender.agent.ep.anycastAttributed("queuedrole", "a role request the first read takes");
  await until(() => queuedSignals.length === 1 || undefined, 8000);
  const readA = queuedCall("cotal_inbox");
  await sleep(100);
  const readB = queuedCall("cotal_inbox");
  await sleep(300);
  await sender.agent.ep.unicastAttributed(queued.id, "a DM while a read is queued");
  const [shownA, shownB] = await Promise.all([readA, readB]);
  const signalsAfterReads = queuedSignals.length;
  await sender.agent.ep.unicastAttributed(queued.id, "the next DM");
  await until(() => buffered(queued, "the next DM") || undefined, 5000);
  await until(() => queuedSignals.length > signalsAfterReads || undefined, 3000);
  check(
    "20a a DM that a queued read shows leaves the next DM signalled",
    (shownA.text + shownB.text).includes("a DM while a read is queued") && !buffered(queued, "a DM while a read is queued") &&
      queuedSignals.length === signalsAfterReads + 1,
    { signals: queuedSignals.length, signalsAfterReads, shownA: shownA.text.slice(0, 160), shownB: shownB.text.slice(0, 160) },
  );
  // A DM that arrives after a read chose what it shows stays buffered and is signalled after the read.
  const late = await holderOf("late_reader", "laterole");
  const lateSignals: number[] = [];
  const lateCall = await gatewayFor(late, lateSignals);
  await sender.agent.ep.anycastAttributed("laterole", "a role request the read takes");
  await until(() => lateSignals.length === 1 || undefined, 8000);
  const lateRead = lateCall("cotal_inbox");
  await sleep(300);
  await sender.agent.ep.unicastAttributed(late.id, "a DM after the read chose");
  await until(() => buffered(late, "a DM after the read chose") || undefined, 3000);
  await sleep(300);
  const signalsDuringRead = lateSignals.length;
  const lateShown = await lateRead;
  await until(() => lateSignals.length > signalsDuringRead || undefined, 3000);
  check(
    "20b a DM that arrives after the read chose is signalled once the read returns, not during it",
    signalsDuringRead === 1 && lateSignals.length === 2 && !lateShown.text.includes("a DM after the read chose") && buffered(late, "a DM after the read chose"),
    { signalsDuringRead, signals: lateSignals.length, shown: lateShown.text.slice(0, 160) },
  );

  // ── 21. a held request while the link is down ─────────────────────────────────────────────
  // No take is asked while the link is down, so a read then is offered no held request. A host that
  // reads whenever one is offered would otherwise read it, take nothing, and read it again at once.
  console.log("[21] while the link is down a held request is offered to no read, and is announced once the link is back");
  const down = await holderOf("down_holder", "downrole");
  const sent21 = await sender.agent.ep.anycastAttributed("downrole", "held across a drop it was never asked in");
  await until(() => down.agent.inboxKeys().includes(sent21.msg.id));
  const announced21 = () => down.incoming.filter((i) => i.recvKey === sent21.msg.id).length;
  const before21 = announced21();
  let offered21: boolean | undefined;
  let wake21: number | undefined;
  const onDrop21 = (e: { connected: boolean }) => {
    if (e.connected || offered21 !== undefined) return;
    offered21 = down.agent.inboxPreview().some((i) => i.recvKey === sent21.msg.id);
    wake21 = down.agent.inboxWake();
  };
  down.agent.on("transport", onDrop21);
  await down.agent.reconnect();
  down.agent.off("transport", onDrop21);
  check("21a while the link is down a read is offered no held request, and none wakes", offered21 === false && wake21 === 0, { offered21, wake21 });
  await until(() => down.agent.connected || undefined, 10_000);
  const again21 = await until(() => announced21() === before21 + 1 || undefined, 3000);
  check("21b once the link is back the held request is announced again", again21 === true, { before21, after: announced21() });
  const read21 = await down.agent.takeChosen("all", (preview) => preview.filter((i) => i.recvKey === sent21.msg.id));
  check("21c and the next read takes it and shows it", read21.some((i) => i.recvKey === sent21.msg.id), { shown: read21.length });

  // ── 22. a held request keeps its arrival place ────────────────────────────────────────────
  // A host that shows the head of its inbox shows what arrived first, as it does where no request
  // is held, so a role request that arrived before chatter is offered and shown ahead of it.
  console.log("[22] a role request that arrived before chatter is offered, and shown once taken, ahead of it");
  const order = await holderOf("order_holder", "orderrole", ["team"]);
  const sent22 = await sender.agent.ep.anycastAttributed("orderrole", "arrived before the chatter");
  await until(() => order.agent.inboxKeys().includes(sent22.msg.id));
  for (let n = 0; n < 3; n++) await poster.agent.send(`order chatter ${n}`, "team");
  await until(() => order.agent.peekInbox().filter((i) => i.text.startsWith("order chatter")).length === 3 || undefined);
  const place22 = (items: InboxItem[]) => ({
    request: items.findIndex((i) => i.recvKey === sent22.msg.id),
    chatter: items.flatMap((i, n) => (i.text.startsWith("order chatter") ? [n] : [])),
  });
  const ahead22 = (p: ReturnType<typeof place22>) => p.request >= 0 && p.chatter.length === 3 && p.chatter.every((n) => n > p.request);
  const preview22 = place22(order.agent.inboxPreview());
  check("22a the preview offers the request ahead of the chatter that arrived after it", ahead22(preview22), preview22);
  await order.agent.takeChosen("all", (preview) => preview.filter((i) => i.recvKey === sent22.msg.id));
  const shown22 = place22(order.agent.peekInbox());
  check("22b once taken it is shown in that place", ahead22(shown22), shown22);
} catch (e) {
  check(`scenario threw: ${(e as Error).stack ?? (e as Error).message}`, false);
} finally {
  for (const stop of stops.reverse()) { try { await stop(); } catch { /* ignore */ } }
  srv.kill("SIGKILL");
  await awaitExit(srv);
  rmSync(dir, { recursive: true, force: true });
  releaseBroker();
  finish();
}
