import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { connect, createServer, type Socket, type AddressInfo } from "node:net";
import { MeshAgent, prepareInlineDelivery } from "@cotal-ai/connector-core";
import type { CotalMessage } from "@cotal-ai/core";
import { NativeDeliveries, isNativeInlineFrame } from "../src/native-deliveries.js";
import type { NativeInlineFrame } from "../src/native-deliveries.js";
import { openWakeFeed, wakeSocketPath } from "../src/wake-feed.js";
import { createClaudeHandle } from "../src/hooks.js";

const agent = new MeshAgent({ space: "inline", name: "inline", id: "inline_self", kind: "agent",
  servers: "nats://127.0.0.1:1", subscribe: [], allowSubscribe: [], allowPublish: [], tls: false });
agent.on("error", () => {});
const acked: string[] = [];
const incoming = (id: string, text: string) => {
  const message: CotalMessage = { id, space: "inline", to: "inline_self", ts: Date.now(), from: { id: "sender", name: "sender" }, parts: [{ kind: "text", text }] };
  agent.ep.emit("message", message, { durable: true, ack: () => acked.push(id), nak() {} }, { historical: false, kind: "dm" });
};
const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const until = async (test: () => boolean) => { for (let n = 0; n < 200 && !test(); n++) await wait(10); assert(test()); };
const feed = await openWakeFeed(process.pid);
const route = wakeSocketPath(process.pid);
const session = "inline-session";
const monitorPath = new URL("../dist/monitor.cjs", import.meta.url).pathname;
const monitor = spawn(process.execPath, [monitorPath, "--native", "--session", session], {
  env: Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("COTAL_"))), stdio: ["ignore", "pipe", "pipe"],
});
let stdout = "", stderr = "";
monitor.stdout.on("data", (piece) => { stdout += piece; });
monitor.stderr.on("data", (piece) => { stderr += piece; });
const frames: NativeInlineFrame[] = [];
let offset = 0;
const nextFrame = async () => {
  await until(() => stdout.slice(offset).includes("\n"));
  const end = stdout.indexOf("\n", offset);
  const line = stdout.slice(offset, end); offset = end + 1;
  assert(line.startsWith("Cotal inline delivery: "));
  const frame = JSON.parse(line.slice("Cotal inline delivery: ".length));
  assert(isNativeInlineFrame(frame)); frames.push(frame);
  return frame;
};
const helper = (frame: NativeInlineFrame, action: string, extra = {}) => new Promise<Record<string, unknown>>((resolve, reject) => {
  const child = spawn(process.execPath, [monitorPath, "--native", "--session", session, "--native-delivery"], { env: { ...process.env, COTAL_NAME: "", COTAL_LINK: "", COTAL_AGENT_FILE: "" }, stdio: ["pipe", "pipe", "pipe"] });
  let output = "";
  child.stdout.on("data", (piece) => { output += piece; });
  child.on("error", reject);
  child.on("close", (code) => { try { assert.equal(code, 0); resolve(JSON.parse(output)); } catch (error) { reject(error); } });
  child.stdin.end(JSON.stringify({ id: frame.id, route: frame.route, session: frame.inline.session, receipt: frame.inline.receipt, action, ...extra }));
});
let settled = 0, retried = 0;
const send = () => {
  const batch = prepareInlineDelivery(agent, { connectionId: "connection", fits: (payload) => feed.fitsInline("connection", session, payload) });
  assert(batch);
  assert(feed.sendInline("connection", session, batch, () => { settled++; }, () => { retried++; }));
  return batch;
};
try {
  await until(() => feed.supportsInline(session));
  incoming("first", "Complete short text");
  const event = { hook_event_name: "UserPromptSubmit" };
  const observed = await createClaudeHandle({ delivery: false }).handle(agent, event);
  assert.deepEqual(observed, {});
  assert(!agent.isInFlight("first"), "native lifecycle observation must not create an ignored command-hook delivery hold");
  const managed = createClaudeHandle();
  await managed.handle(agent, event);
  assert(agent.isInFlight("first"), "managed hooks retain their existing delivery owner");
  managed.onReply(event, false);
  assert(!agent.isInFlight("first"));
  const batch = send();
  const frame = await nextFrame();
  assert.equal(acked.length, 0, "socket/monitor parsing cannot acknowledge anything");
  assert(agent.isInFlight("first"));
  assert(feed.inlinePending(session), "new arrivals coalesce behind the open handoff rather than falling back to inbox cues");
  assert.equal((await helper(frame, "commit", { uuid: "native-row" })).ok, false, "commit without claim is refused");
  assert.equal((await helper(frame, "claim", { id: "foreign" })).ok, false);
  assert.equal((await helper(frame, "claim")).ok, true);
  incoming("late", "Arrived after the immutable offer");
  assert.equal((await helper(frame, "commit", { uuid: "native-row" })).ok, true);
  assert.deepEqual(acked, ["first"]);
  assert(!agent.isInFlight("first") && !batch.current());
  assert.equal((await helper(frame, "commit", { uuid: "native-row" })).ok, true, "same receipt is idempotent");
  assert.equal(settled, 1);
  assert(!feed.inlinePending(session));
  assert.equal(agent.peekInbox().length, 1);
  console.log("  ✓ real monitor/helper sockets enforce claim, native receipt, exact ACK and idempotence");

  send();
  const stale = await nextFrame();
  agent.drainInbox();
  assert.equal((await helper(stale, "claim")).ok, false, "explicit inbox read invalidates the offer");
  assert.equal((await helper(stale, "retry")).ok, true);
  assert.equal((await helper(stale, "retry")).ok, true);
  assert.equal(retried, 1, "duplicate retries do not loop rearming");
  incoming("refused", "Native refusal must retain this");
  send();
  const refused = await nextFrame();
  assert.equal((await helper(refused, "reject")).ok, true);
  assert(agent.peekInbox().some((item) => item.id === "refused"));
  assert(!agent.isInFlight("refused"));
  assert(!acked.includes("refused"));
  console.log("  ✓ explicit read races, bounded one-time retry and native rejection preserve the inbox");

  let writer: Socket | undefined;
  const pair = createServer((socket) => { writer = socket; });
  await new Promise<void>((resolve) => pair.listen(0, "127.0.0.1", resolve));
  const socket = connect((pair.address() as AddressInfo).port, "127.0.0.1");
  let offered = "";
  socket.on("data", (piece) => { offered += piece; });
  await until(() => !!writer);
  const timeout = new NativeDeliveries(route, 20);
  const expired = prepareInlineDelivery(agent, { connectionId: "expire", fits: () => true })!;
  assert(timeout.send(writer!, "expire", session, expired, () => {}, () => {}));
  await until(() => offered.includes("\n"));
  const queued: NativeInlineFrame = JSON.parse(offered);
  await wait(40);
  assert(agent.isInFlight("refused"), "a long native tool does not expire an offer before its boundary");
  const claim = { id: queued.id, session, receipt: queued.inline.receipt, action: "claim" };
  assert.equal(timeout.request(claim).ok, true);
  assert.equal(timeout.request({ ...claim, action: "defer" }).ok, true);
  await wait(40);
  assert(agent.isInFlight("refused"), "a state-change deferral returns ownership to the live reader");
  assert.equal(timeout.request(claim).ok, true);
  await until(() => !agent.isInFlight("refused"));
  assert(!acked.includes("refused"), "an unconfirmed admission timeout releases holds without an ACK");
  timeout.close(); socket.destroy(); writer!.destroy();
  await new Promise<void>((resolve) => pair.close(() => resolve()));
  assert(!isNativeInlineFrame({ ...frame, inline: { ...frame.inline, text: "x".repeat(5000) } }));
  assert(!stdout.includes('"recvKey"'));
  console.log("  ✓ expired and malformed offers remain non-consuming; receive keys never cross the socket");

  send();
  const closed = await nextFrame();
  await agent.stop();
  assert(!feed.inlinePending(session), "a closed connection cannot retain this session's offer slot");
  assert.equal((await helper(closed, "claim")).ok, false);
  assert(!acked.includes("refused"), "releasing a closed connection's offer never acknowledges it");
  console.log("  ✓ a stopped connection releases its stale session offer without an ACK");
} finally {
  feed.close();
  monitor.kill("SIGTERM");
  await new Promise<void>((resolve) => { if (monitor.exitCode !== null || monitor.signalCode !== null) resolve(); else monitor.once("exit", () => resolve()); });
  await agent.stop();
}
assert.equal(stderr, "");
console.log("NATIVE INLINE SOCKET TESTS PASSED");
