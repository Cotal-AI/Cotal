/**
 * The connector half of anycast request status, live (SPEC §8.1): on a JWT-auth broker with a real
 * delivery daemon, a MeshAgent holding a role shows a role request only once its take is recorded,
 * drops one its sender cancelled first without ever showing it, holds one nobody can record, and a
 * sending MeshAgent shows the daemon's notice as a notice. A read takes only the requests it shows,
 * a request taken and not yet shown is taken again after a reconnect, and an exact drain acks no
 * request that was never shown. `cotal_anycast` is driven through its spec for the send, status and
 * cancel results and for the calls it must refuse, including a seq that names two of this session's
 * requests after the role queue was recreated.
 *
 * Run: pnpm smoke:anycast-take-gate:auth   (needs `nats-server` on PATH; local-only)
 */
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect, credsAuthenticator } from "@nats-io/transport-node";
import { jetstreamManager } from "@nats-io/jetstream";
import {
  ANYCAST_NOTICE_KEY,
  CotalEndpoint,
  DEV_OWNER,
  createSpaceAuth,
  isReachable,
  mintCreds,
  mintLifecycleUid,
  newIdentity,
  provisionAgent,
  serverConfig,
  setupSpaceStreams,
  taskStream,
} from "@cotal-ai/core";
import { MeshAgent, type InboxItem } from "../src/agent.js";
import type { AgentConfig } from "../src/config.js";
import { cotalToolSpecs, type CotalToolSpec } from "../src/tool-specs.js";
import { fmtItem } from "../src/framing.js";
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

  const mkAgent = async (name: string, role?: string) => {
    const ident = newIdentity();
    const uid = mintLifecycleUid();
    const creds = await provisionAgent(mgr, auth, ident, { subscribe: [], allowSubscribe: [], allowPublish: [], role, lifecycleUid: uid });
    const config: AgentConfig = { space, name, role, servers, creds, subscribe: [], allowSubscribe: [], allowPublish: [], kind: "agent", tls: false, id: ident.id, lifecycleUid: uid };
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
  check("1h it was re-announced on incoming once taken", holder.incoming.filter((i) => i.recvKey === key).length >= 2);
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

  // ── 10. one seq naming two of this session's requests ─────────────────────────────────────
  // Last, because it deletes and recreates the TASK stream.
  console.log("[10] a seq this session sent twice, across a queue recreation, is refused as ambiguous");
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
  check("10a the recreated queue reused the seq", reused, { seq6 });
  const ambiguous = await run({ seq: seq6 });
  check(
    "10b a status by that seq is refused as ambiguous",
    ambiguous.isError === true && ambiguous.text.includes(`seq ${seq6} names 2 requests this session sent`) && ambiguous.text.includes("ambiguous"),
    ambiguous.text,
  );
  const ambiguousCancel = await run({ seq: seq6, cancel: true });
  check("10c and so is a cancel, which cancels nothing", ambiguousCancel.isError === true && ambiguousCancel.text.includes("nothing was asked or cancelled"), ambiguousCancel.text);
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
