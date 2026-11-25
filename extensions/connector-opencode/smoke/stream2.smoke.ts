/**
 * OPENCODE 2.x STREAMS A REPLY ON THE EVENT PLANE BEFORE ITS STEP ENDS.
 *
 * OpenCode 2.0.24 keeps a streaming element empty in the session's message list until its step ends,
 * and sends its text as `session.text.delta` and `session.reasoning.delta` events naming the step's
 * message and the element's ordinal among its kind. The plugin journals the deltas, and the event
 * plane reads the journal in among the list's records. Here the plugin runs from `src` against a
 * real `nats-server` and a fake OpenCode 2.x server, fed those events in 2.0.24's order through the
 * host context, and a second endpoint reads the subject live:
 *
 *  - an element's text reaches the subject while its step runs, under a stream id of its own, and
 *    the saved element ends that message without publishing the text a second time;
 *  - an interrupted step whose element was never saved ends its stream before the run closes.
 *
 * The mapper cells at the end grade the key a saved element closes, found from its position among
 * the message's elements of its kind, and that reasoning deltas are dropped when reasoning is not
 * published.
 *
 * Run: pnpm smoke:opencode2-stream   (needs nats-server on PATH; starts its own broker)
 */
import { spawn } from "node:child_process";
import { createServer as createHttpServer } from "node:http";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { once } from "node:events";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CotalEndpoint, LAUNCH_MATERIAL_ENV, isReachable, seedChannelRegistry, writeLaunchMaterial } from "@cotal-ai/core";
import { SMOKE_BROKER_TOKEN, awaitBrokerReady, createSuite, freePort, teardownOnSignal } from "@cotal-ai/smoke-kit";
import { setupCotal } from "../src/plugin2.js";
import type { OpenCode2Message } from "../src/agui-source2.js";
import { createOpenCode2Mapper } from "../src/agui-map2.js";
import { fakeOpenCode2Context } from "./_boot-plugin.js";

const { check, finish, passed, failed } = createSuite();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const PORT = await freePort();
const servers = `nats://127.0.0.1:${PORT}`;
const SPACE = "oc2stream";
const CHANNEL = "events.local.otto";
const S = "ses_oc2_stream";

const dir = mkdtempSync(join(tmpdir(), SMOKE_BROKER_TOKEN));
mkdirSync(join(dir, "ws"), { recursive: true });
const broker = spawn("nats-server", ["-js", "-a", "127.0.0.1", "-p", String(PORT), "-sd", join(dir, "js")], { stdio: "ignore" });
const releaseBroker = teardownOnSignal(broker, dir);
const auth = `Basic ${Buffer.from("opencode:test-secret").toString("base64")}`;

const list: OpenCode2Message[] = [];
const oc = createHttpServer((req, res) => {
  if (req.headers.authorization !== auth) return void res.writeHead(401).end();
  req.resume();
  req.on("end", () => {
    const url = new URL(req.url ?? "/", "http://x");
    const json = (body: unknown) => void res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(body));
    if (req.method === "POST" && url.pathname === "/api/session") return json({ data: { id: S } });
    if (req.method === "GET" && url.pathname === `/api/session/${S}/message`)
      return json({ data: [...list].sort((a, b) => (a.id < b.id ? 1 : -1)), cursor: { previous: null, next: null } });
    res.writeHead(404).end();
  });
});
oc.listen(0, "127.0.0.1");
await once(oc, "listening");

for (const k of Object.keys(process.env)) if (k.startsWith("COTAL_")) delete process.env[k];
Object.assign(process.env, {
  COTAL_NAME: "Otto",
  COTAL_ID: "otto",
  COTAL_SPACE: SPACE,
  COTAL_EVENTS: "1",
  COTAL_WORKSPACE_ROOT: join(dir, "ws"),
  COTAL_OPENCODE_SERVER_URL: `http://127.0.0.1:${(oc.address() as { port: number }).port}`,
  OPENCODE_SERVER_USERNAME: "opencode",
  OPENCODE_SERVER_PASSWORD: "test-secret",
  [LAUNCH_MATERIAL_ENV]: writeLaunchMaterial({ servers, reasoningEvents: true }),
});

type Ev = Record<string, unknown> & { type: string };
const seen: Ev[] = [];
const reader = new CotalEndpoint({ space: SPACE, servers, card: { name: "Reader", kind: "agent", id: "reader" }, channels: [CHANNEL] });
reader.on("error", () => {});
reader.on("message", (m: { channel?: string; parts?: { data?: unknown }[] }) => {
  if (m?.channel !== CHANNEL) return;
  for (const p of m.parts ?? []) for (const e of ((p.data ?? p) as { events?: Ev[] }).events ?? []) seen.push(e);
});

const ctx = fakeOpenCode2Context();
let seq = 0;
let n = 0;
const at = () => 1794314200000 + ++n * 10;
/** A durable event of the session, as the server appends one to its log for each change to the list. */
const durable = async (type: string, data: Record<string, unknown> = {}) => {
  ctx.feed({ type, created: Date.now(), durable: { aggregateID: S, seq: seq++ }, data: { sessionID: S, ...data } });
  await sleep(250);
};
/** A delta, which the server sends with no log position. */
const delta = async (type: "text" | "reasoning", message: string, ordinal: number, text: string) => {
  ctx.feed({ type: `session.${type}.delta`, created: Date.now(), data: { sessionID: S, assistantMessageID: message, ordinal, delta: text } });
  await sleep(300);
};
const under = (messageId: string) => seen.filter((e) => e.messageId === messageId).map((e) => [e.type, e.delta]);
const joined = (messageId: string) => seen.filter((e) => e.messageId === messageId && typeof e.delta === "string").map((e) => e.delta).join("");

const exits: unknown[] = [];
const exit = process.exit;
process.exit = ((code?: number) => {
  exits.push(code);
}) as typeof process.exit;
let stop: void | (() => Promise<void>) = undefined;
try {
  await awaitBrokerReady(() => isReachable(servers), { servers, attempts: 50, delayMs: 200 });
  await seedChannelRegistry({ servers, space: SPACE, file: { defaults: { replay: false }, channels: { [CHANNEL]: { replay: true } } } });
  await reader.start();
  stop = await setupCotal(ctx);
  await sleep(2_000);

  // ---- Turn 1: reasoning, then text, each streamed while the step runs and saved at its end.
  list.push({ id: "msg_01", type: "user", time: { created: at() }, text: "prompt" } as OpenCode2Message);
  await durable("session.execution.started");
  const step: OpenCode2Message = { id: "msg_02", type: "assistant", time: { created: at() }, content: [] };
  list.push(step);
  await durable("session.step.started", { assistantMessageID: step.id });
  const reasoningStart = at();
  step.content = [{ type: "reasoning", text: "", time: { created: reasoningStart } }];
  await durable("session.reasoning.started", { assistantMessageID: step.id, ordinal: 0 });
  await delta("reasoning", step.id, 0, "thought ");
  await delta("reasoning", step.id, 0, "one");
  await sleep(700);
  const rKey = `stream:${step.id}:reasoning:0`;
  check("live:the reasoning reaches the subject under its stream id while the step runs",
    joined(rKey) === "thought one" && under(rKey)[0]?.[0] === "REASONING_MESSAGE_START", under(rKey));
  step.content.push({ type: "text", text: "" });
  await durable("session.text.started", { assistantMessageID: step.id, ordinal: 0 });
  await delta("text", step.id, 0, "answer ");
  await delta("text", step.id, 0, "one");
  await sleep(700);
  const tKey = `stream:${step.id}:text:0`;
  check("live:the text reaches the subject under its stream id while the step runs",
    joined(tKey) === "answer one" && !under(tKey).some(([t]) => t === "TEXT_MESSAGE_END"), under(tKey));
  step.content = [{ type: "reasoning", text: "thought one", time: { created: reasoningStart, completed: at() } }, { type: "text", text: "answer one" }];
  step.time = { ...step.time, streamed: at(), completed: at() };
  await durable("session.step.streamed", { assistantMessageID: step.id });
  await durable("session.step.ended", { assistantMessageID: step.id });
  list.push({ id: "msg_03", type: "idle", time: { created: at() }, outcome: "succeeded" });
  await durable("session.execution.succeeded");
  await sleep(1_500);
  check("saved:each saved element ends its stream once and is not published again under its position id",
    under(rKey).filter(([t]) => t === "REASONING_MESSAGE_END").length === 1 && under(tKey).filter(([t]) => t === "TEXT_MESSAGE_END").length === 1 &&
      under(`${step.id}#0`).length === 0 && under(`${step.id}#1`).length === 0, { r: under(rKey), t: under(tKey) });

  // ---- Turn 2: the step is interrupted and its text element is never saved.
  list.push({ id: "msg_04", type: "user", time: { created: at() }, text: "prompt" } as OpenCode2Message);
  await durable("session.execution.started");
  const cut: OpenCode2Message = { id: "msg_05", type: "assistant", time: { created: at() }, content: [] };
  list.push(cut);
  await durable("session.step.started", { assistantMessageID: cut.id });
  cut.content = [{ type: "text", text: "" }];
  await durable("session.text.started", { assistantMessageID: cut.id, ordinal: 0 });
  await delta("text", cut.id, 0, "half ");
  await delta("text", cut.id, 0, "an answer");
  cut.content = [];
  cut.time = { ...cut.time, completed: at() };
  cut.error = { type: "aborted", message: "Step interrupted" };
  await durable("session.execution.interrupted");
  await sleep(2_000);

  const cKey = `stream:${cut.id}:text:0`;
  const end = seen.findIndex((e) => e.messageId === cKey && e.type === "TEXT_MESSAGE_END");
  const close = seen.findIndex((e, i) => i > end && (e.type === "RUN_FINISHED" || e.type === "RUN_ERROR"));
  check("interrupted:the stream of an element its interrupted step never saved ends before the run closes",
    joined(cKey) === "half an answer" && end >= 0 && close > end, { end, close, events: under(cKey) });
  const types = seen.map((e) => e.type);
  check("runs:two runs opened and each closed once", types.filter((t) => t === "RUN_STARTED").length === 2 &&
    types.filter((t) => t === "RUN_FINISHED" || t === "RUN_ERROR").length === 2, types);
  check("arm:no seat exited", exits.length === 0, { exits });
} finally {
  ctx.end();
  await stop?.().catch(() => {});
  await reader.stop().catch(() => {});
  oc.close();
  broker.kill("SIGKILL");
  await sleep(150);
  rmSync(dir, { recursive: true, force: true });
  releaseBroker();
  process.exit = exit;
}

// ---- The mapper alone.
{
  // Read as optional so a mapper without the merged arm fails these cells rather than the run.
  const merged = (m: ReturnType<typeof createOpenCode2Mapper>) => (m as Partial<typeof m>).mapMerged ?? (() => "no merged arm");
  const line = (key: string, kind: "text" | "reasoning", text: string) => ({ deltas: [{ key, kind, text }], timestamp: 1 });
  const off = createOpenCode2Mapper({ threadId: S, mintRunId: () => "run-off" });
  check("mapper:a reasoning delta is dropped when reasoning is not published", merged(off)(line(`stream:msg_a:reasoning:0`, "reasoning", "secret")) === null);

  const on = createOpenCode2Mapper({ threadId: S, mintRunId: () => "run-on", reasoning: true });
  merged(on)(line("stream:msg_a:text:1", "text", "second"));
  const message: OpenCode2Message = {
    id: "msg_a", type: "assistant", time: { created: 1, streamed: 2, completed: 3 },
    content: [{ type: "reasoning", text: "r" }, { type: "text", text: "first" }, { type: "text", text: "second" }],
  };
  const saved = merged(on)({ harness: { message, index: 2, element: message.content![2] } });
  const shape = saved && typeof saved === "object" && "events" in saved ? saved.events.map((e) => [e.type, (e as { messageId?: string }).messageId]) : saved;
  check("mapper:the second text element of a message closes the stream of text ordinal 1, and publishes nothing again",
    JSON.stringify(shape) === JSON.stringify([["TEXT_MESSAGE_END", "stream:msg_a:text:1"]]), shape);
}

const EXPECTED = 8;
check(`meta:every cell ran - ${EXPECTED} expected`, passed() + failed() === EXPECTED, `${passed() + failed()} cells reported`);
finish();
process.exit();
