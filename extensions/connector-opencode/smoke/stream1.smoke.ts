/**
 * OPENCODE 1.x STREAMS A REPLY ON THE EVENT PLANE BEFORE IT SAVES THE PART.
 *
 * OpenCode 1.19.6 creates a text or reasoning part empty, sends its text as `message.part.delta`
 * bus events, and then saves the part whole with an end mark. The plugin journals the deltas, and
 * the event plane reads the journal in among the session's records. Here the plugin runs from `src`
 * against a real `nats-server` and a fake OpenCode server, fed those bus events in that order, and a
 * second endpoint reads the subject live:
 *
 *  - a part's text reaches the subject while the part is still unsaved, under a stream id of its own,
 *    and its saved record ends that message without publishing the text a second time;
 *  - a part a turn left unfinished closes before the run does;
 *  - a part removed before it was saved is ended by the turn's end, before the run closes.
 *
 * The mapper cells at the end grade what a live run rarely shows: reasoning deltas are dropped when
 * reasoning is not published, and a saved text that does not continue what streamed is published as
 * a message of its own after the partial one ends.
 *
 * Run: pnpm smoke:opencode1-stream   (needs nats-server on PATH; starts its own broker)
 */
import { spawn } from "node:child_process";
import { createServer as createHttpServer } from "node:http";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { once } from "node:events";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CotalEndpoint, LAUNCH_MATERIAL_ENV, isReachable, seedChannelRegistry, writeLaunchMaterial } from "@cotal-ai/core";
import { SMOKE_BROKER_TOKEN, awaitBrokerReady, createSuite, freePort, teardownOnSignal } from "@cotal-ai/smoke-kit";
import type { OpenCodeRecord } from "../src/agui-source.js";
import { createOpenCodeMapper } from "../src/agui-map.js";
import { bootPlugin, disposeInProcess } from "./_boot-plugin.js";

const { check, finish, passed, failed } = createSuite();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const PORT = await freePort();
const servers = `nats://127.0.0.1:${PORT}`;
const SPACE = "ocstream";
const CHANNEL = "events.local.otto";
const S = "ses_00000000000000000000000001";

const dir = mkdtempSync(join(tmpdir(), SMOKE_BROKER_TOKEN));
mkdirSync(join(dir, "ws"), { recursive: true });
const broker = spawn("nats-server", ["-js", "-a", "127.0.0.1", "-p", String(PORT), "-sd", join(dir, "js")], { stdio: "ignore" });
const releaseBroker = teardownOnSignal(broker, dir);
const auth = `Basic ${Buffer.from("opencode:test-secret").toString("base64")}`;

type Part = { id: string; messageID: string; sessionID: string; type: string; text?: string; time?: { start?: number; end?: number } };
type Message = { info: { id: string; sessionID: string; role: string; time: { created: number; completed?: number } }; parts: Part[] };
const messages: Message[] = [];
const oc = createHttpServer((req, res) => {
  if (req.headers.authorization !== auth) return void res.writeHead(401).end();
  req.resume();
  req.on("end", () => {
    const json = (body: unknown) => void res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(body));
    if (req.method === "POST" && req.url === "/session") return json({ id: S });
    if (req.method === "GET" && req.url === `/session/${S}/message`) return json(messages);
    if (req.method === "POST" && req.url?.endsWith("/prompt_async")) return void res.writeHead(204).end();
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
  COTAL_ROLE: "generalist",
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

let hooks: Awaited<ReturnType<typeof bootPlugin>> | undefined;
const fire = (event: unknown): Promise<void> => (hooks as unknown as { event: (a: unknown) => Promise<void> }).event({ event });
let n = 0;
const id = (kind: string) => `${kind}_${S}_${String(++n).padStart(4, "0")}`;

/** A message the session saved, announced on the bus as OpenCode does. */
async function message(role: string, completed = false): Promise<Message> {
  const m: Message = { info: { id: id("msg"), sessionID: S, role, time: { created: n, ...(completed ? { completed: n } : {}) } }, parts: [] };
  messages.push(m);
  await fire({ type: "message.updated", properties: { info: m.info } });
  return m;
}
/** A part created in `m`, saved whole when `text` is given and empty otherwise. */
async function part(m: Message, type: string, text?: string): Promise<Part> {
  const p: Part = { id: id("prt"), messageID: m.info.id, sessionID: S, type, ...(text !== undefined ? { text, time: { start: n, end: n } } : { text: "", time: { start: n } }) };
  m.parts.push(p);
  await fire({ type: "message.part.updated", properties: { part: p } });
  return p;
}
async function deltas(p: Part, pieces: string[]): Promise<void> {
  for (const delta of pieces) {
    p.text += delta;
    await fire({ type: "message.part.delta", properties: { sessionID: S, messageID: p.messageID, partID: p.id, field: "text", delta } });
    await sleep(300);
  }
  await sleep(700);
}
async function save(p: Part): Promise<void> {
  p.time = { start: p.time?.start, end: n };
  await fire({ type: "message.part.updated", properties: { part: p } });
}
const busy = () => fire({ type: "session.status", properties: { sessionID: S, status: { type: "busy" } } });
const idle = async () => {
  await fire({ type: "session.idle", properties: { sessionID: S } });
  await sleep(2_000);
};

/** The events under one message id, as [type, delta]. */
const under = (messageId: string) => seen.filter((e) => e.messageId === messageId).map((e) => [e.type, e.delta]);
const joined = (messageId: string) => seen.filter((e) => e.messageId === messageId && typeof e.delta === "string").map((e) => e.delta).join("");

const exits: unknown[] = [];
const exit = process.exit;
process.exit = ((code?: number) => {
  exits.push(code);
}) as typeof process.exit;
try {
  await awaitBrokerReady(() => isReachable(servers), { servers, attempts: 50, delayMs: 200 });
  await seedChannelRegistry({ servers, space: SPACE, file: { defaults: { replay: false }, channels: { [CHANNEL]: { replay: true } } } });
  await reader.start();
  hooks = await bootPlugin();
  await sleep(1_500);
  await fire({ type: "session.created", properties: { info: { id: S } } });
  await sleep(2_000);

  // ---- Turn 1: reasoning, then text, each streamed and then saved.
  const u1 = await message("user");
  await part(u1, "text", "prompt");
  await busy();
  const a1 = await message("assistant");
  await part(a1, "step-start");
  const r1 = await part(a1, "reasoning");
  await deltas(r1, ["thought ", "one"]);
  check("live:the reasoning reaches the subject under its stream id while the part is unsaved",
    joined(`stream:${r1.id}`) === "thought one" && under(`stream:${r1.id}`)[0]?.[0] === "REASONING_MESSAGE_START", under(`stream:${r1.id}`));
  await save(r1);
  const t1 = await part(a1, "text");
  await deltas(t1, ["answer ", "one"]);
  check("live:the text reaches the subject under its stream id while the part is unsaved",
    joined(`stream:${t1.id}`) === "answer one" && !under(`stream:${t1.id}`).some(([t]) => t === "TEXT_MESSAGE_END"), under(`stream:${t1.id}`));
  await save(t1);
  await part(a1, "step-finish");
  a1.info.time.completed = n;
  await idle();
  check("saved:each saved part ends its stream once and is not published again under its own id",
    under(`stream:${r1.id}`).filter(([t]) => t === "REASONING_MESSAGE_END").length === 1 && under(`stream:${t1.id}`).filter(([t]) => t === "TEXT_MESSAGE_END").length === 1 &&
      under(r1.id).length === 0 && under(t1.id).length === 0, { r: under(r1.id), t: under(t1.id) });

  // ---- Turn 2: the text is stopped partway, so it is never marked saved.
  const u2 = await message("user");
  await part(u2, "text", "prompt");
  await busy();
  const a2 = await message("assistant");
  await part(a2, "step-start");
  const t2 = await part(a2, "text");
  await deltas(t2, ["half ", "an answer"]);
  await fire({ type: "session.error", properties: { sessionID: S, error: { name: "MessageAbortedError", data: { message: "The operation was aborted" } } } });
  await idle();

  // ---- Turn 3: the text streams, and the part is removed before it is saved.
  const u3 = await message("user");
  await part(u3, "text", "prompt");
  await busy();
  const a3 = await message("assistant");
  await part(a3, "step-start");
  const t3 = await part(a3, "text");
  await deltas(t3, ["draft"]);
  a3.parts.splice(a3.parts.indexOf(t3), 1);
  await fire({ type: "message.part.removed", properties: { sessionID: S, messageID: a3.info.id, partID: t3.id } });
  a3.info.time.completed = n;
  await idle();
  await sleep(1_000);

  const types = seen.map((e) => e.type);
  const closeAfter = (messageId: string) => {
    const end = seen.findIndex((e) => e.messageId === messageId && e.type === "TEXT_MESSAGE_END");
    const close = seen.findIndex((e, i) => i > end && (e.type === "RUN_FINISHED" || e.type === "RUN_ERROR"));
    return { end, close };
  };
  const stopped = closeAfter(`stream:${t2.id}`);
  check("stopped:the text a turn left unfinished is published once, whole, and ends before the run closes",
    joined(`stream:${t2.id}`) === "half an answer" && stopped.end >= 0 && stopped.close > stopped.end && under(t2.id).length === 0, { ...stopped, events: under(`stream:${t2.id}`) });
  const removed = closeAfter(`stream:${t3.id}`);
  check("removed:the stream of a part removed before it was saved ends at the turn's end, before the run closes",
    joined(`stream:${t3.id}`) === "draft" && removed.end >= 0 && removed.close > removed.end, { ...removed, events: under(`stream:${t3.id}`) });
  check("runs:three runs opened and each closed once", types.filter((t) => t === "RUN_STARTED").length === 3 &&
    types.filter((t) => t === "RUN_FINISHED" || t === "RUN_ERROR").length === 3, types);
  check("arm:no seat exited", exits.length === 0, { exits });
} finally {
  await reader.stop().catch(() => {});
  await disposeInProcess(hooks);
  oc.close();
  broker.kill("SIGKILL");
  await sleep(150);
  rmSync(dir, { recursive: true, force: true });
  releaseBroker();
  process.exit = exit;
}

// ---- The mapper alone.
{
  const record = (partId: string, type: string, text: string): OpenCodeRecord => ({
    part: { id: partId, messageID: "msg_a", type, text, time: { start: 1, end: 2 } },
    message: { id: "msg_a", role: "assistant", time: { created: 1 } },
  });
  const line = (key: string, kind: "text" | "reasoning", text: string) => ({ deltas: [{ key, kind, text }], timestamp: 1 });
  // Read as optional so a mapper without the merged arm fails these cells rather than the run.
  const merged = (m: ReturnType<typeof createOpenCodeMapper>) => (m as Partial<typeof m>).mapMerged ?? (() => "no merged arm");
  const off = createOpenCodeMapper({ threadId: S, mintRunId: () => "run-off" });
  check("mapper:a reasoning delta is dropped when reasoning is not published", merged(off)(line("stream:prt_r", "reasoning", "secret")) === null);

  const on = createOpenCodeMapper({ threadId: S, mintRunId: () => "run-on" });
  merged(on)(line("stream:prt_t", "text", "first try"));
  const retried = merged(on)({ harness: record("prt_t", "text", "second answer") });
  const shape = retried && typeof retried === "object" && "events" in retried ? retried.events.map((e) => [e.type, (e as { messageId?: string }).messageId, (e as { delta?: string }).delta]) : retried;
  check("mapper:a saved text that does not continue the stream ends the partial and is published whole under the part id",
    JSON.stringify(shape) === JSON.stringify([
      ["TEXT_MESSAGE_END", "stream:prt_t", null], ["TEXT_MESSAGE_START", "prt_t", null], ["TEXT_MESSAGE_CONTENT", "prt_t", "second answer"], ["TEXT_MESSAGE_END", "prt_t", null],
    ]), shape);
}

const EXPECTED = 9;
check(`meta:every cell ran - ${EXPECTED} expected`, passed() + failed() === EXPECTED, `${passed() + failed()} cells reported`);
finish();
process.exit();
