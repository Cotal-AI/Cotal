/**
 * A LAUNCH WITH `reasoningEvents` PUBLISHES THE MODEL'S REASONING, on OpenCode 1.x and 2.x.
 *
 * The mappers hold the reasoning arm, off by default (agui-map.ts, agui-map2.ts). The launch hands a
 * seat the choice through its launch material, so this suite boots each plugin from `src` with
 * material that says `reasoningEvents`, against a real `nats-server` and a fake OpenCode server, and
 * reads the subject back from a second endpoint. Each turn's saved reasoning must arrive as one
 * reasoning message carrying its text, inside the turn's run and before its answer. The unarmed
 * default is graded where the plane is: `smoke:opencode2-events` and `smoke:agui-opencode2-map`.
 *
 * Run: pnpm smoke:opencode-reasoning-events   (needs nats-server on PATH; starts its own broker)
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
import { bootPlugin, disposeInProcess, fakeOpenCode2Context } from "./_boot-plugin.js";

const { check, finish, passed, failed } = createSuite();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const PORT = await freePort();
const servers = `nats://127.0.0.1:${PORT}`;
const SPACE = "ocreasoning";
const SEATS = { v1: { name: "Otto", id: "otto" }, v2: { name: "Olga", id: "olga" } };
const channelOf = (id: string) => `events.local.${id}`;
const S1 = "ses_00000000000000000000000001";
const S2 = "ses_oc2_reasoning";

const dir = mkdtempSync(join(tmpdir(), SMOKE_BROKER_TOKEN));
const workspaceRoot = join(dir, "ws");
mkdirSync(workspaceRoot, { recursive: true });
const broker = spawn("nats-server", ["-js", "-a", "127.0.0.1", "-p", String(PORT), "-sd", join(dir, "js")], { stdio: "ignore" });
const releaseBroker = teardownOnSignal(broker, dir);
const auth = `Basic ${Buffer.from("opencode:test-secret").toString("base64")}`;

/** 1.x serves a session's whole message list; 2.x serves pages, newest first. */
const v1Messages = new Map<string, unknown[]>();
const v2Messages = new Map<string, OpenCode2Message[]>();
const oc = createHttpServer((req, res) => {
  if (req.headers.authorization !== auth) return void res.writeHead(401).end();
  req.resume();
  req.on("end", () => {
    const url = new URL(req.url ?? "/", "http://x");
    const json = (body: unknown) => void res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(body));
    if (req.method === "POST" && url.pathname === "/session") return json({ id: S1 });
    if (req.method === "POST" && url.pathname === "/api/session") return json({ data: { id: S2 } });
    const v1 = url.pathname.match(/^\/session\/([^/]+)\/message$/);
    if (req.method === "GET" && v1) return json(v1Messages.get(decodeURIComponent(v1[1]!)) ?? []);
    const v2 = url.pathname.match(/^\/api\/session\/([^/]+)\/message$/);
    if (req.method === "GET" && v2) {
      const desc = [...(v2Messages.get(decodeURIComponent(v2[1]!)) ?? [])].sort((a, b) => (a.id < b.id ? 1 : -1));
      return json({ data: desc, cursor: { previous: null, next: null } });
    }
    if (req.method === "POST" && url.pathname.endsWith("/prompt_async")) return void res.writeHead(204).end();
    res.writeHead(404).end();
  });
});
oc.listen(0, "127.0.0.1");
await once(oc, "listening");

/** Point the next boot at one seat, with fresh material: the plugin deletes its material once read. */
function arm(seat: { name: string; id: string }): void {
  for (const k of Object.keys(process.env)) if (k.startsWith("COTAL_")) delete process.env[k];
  Object.assign(process.env, {
    COTAL_NAME: seat.name,
    COTAL_ID: seat.id,
    COTAL_SPACE: SPACE,
    COTAL_ROLE: "generalist",
    COTAL_EVENTS: "1",
    COTAL_WORKSPACE_ROOT: workspaceRoot,
    COTAL_OPENCODE_SERVER_URL: `http://127.0.0.1:${(oc.address() as { port: number }).port}`,
    OPENCODE_SERVER_USERNAME: "opencode",
    OPENCODE_SERVER_PASSWORD: "test-secret",
    // The material carries the broker too: a launch hands a seat one identity plane, never two.
    [LAUNCH_MATERIAL_ENV]: writeLaunchMaterial({ servers, reasoningEvents: true }),
  });
}

/** One 1.x turn whose answer follows its reasoning, as OpenCode 1.19.6 saves them. */
function turn1(): unknown[] {
  const [u, a] = [`msg_${S1}_0002`, `msg_${S1}_0003`];
  return [
    { info: { id: u, sessionID: S1, role: "user", time: { created: 10 } },
      parts: [{ id: `${u}_p0`, messageID: u, sessionID: S1, type: "text", text: "prompt", time: { start: 10, end: 10 } }] },
    { info: { id: a, sessionID: S1, role: "assistant", time: { created: 11, completed: 19 } },
      parts: [
        { id: `${a}_p0`, messageID: a, sessionID: S1, type: "reasoning", text: "thought-1", time: { start: 11, end: 12 } },
        { id: `${a}_p1`, messageID: a, sessionID: S1, type: "text", text: "answer-1", time: { start: 13, end: 14 } },
      ] },
  ];
}

async function runV1(): Promise<void> {
  arm(SEATS.v1);
  const hooks = await bootPlugin();
  try {
    await sleep(1_500);
    const fire = (event: unknown): Promise<void> => (hooks as unknown as { event: (a: unknown) => Promise<void> }).event({ event });
    const part = () => fire({ type: "message.part.updated", properties: { part: { sessionID: S1 } } });
    v1Messages.set(S1, []);
    await fire({ type: "session.created", properties: { info: { id: S1 } } });
    await sleep(1_500);
    await part(); // parks the cursor on the empty session, as a live one does
    await sleep(1_500);
    v1Messages.set(S1, turn1());
    await part();
    await sleep(2_000);
    await fire({ type: "session.status", properties: { sessionID: S1, status: { type: "busy" } } });
    await fire({ type: "session.idle", properties: { sessionID: S1 } });
    await sleep(2_500);
  } finally {
    await disposeInProcess(hooks);
  }
}

async function runV2(): Promise<void> {
  arm(SEATS.v2);
  const ctx = fakeOpenCode2Context();
  const stop = await setupCotal(ctx);
  try {
    await sleep(1_500);
    const event = (type: string, seq: number) => ctx.feed({ type, durable: { aggregateID: S2, seq }, data: { sessionID: S2 } });
    event("session.execution.started", 0);
    v2Messages.set(S2, [
      { id: "msg_01", type: "user", time: { created: 1794314200000 }, text: "prompt" },
      { id: "msg_02", type: "assistant", time: { created: 1794314200010, streamed: 1794314200020, completed: 1794314200030 },
        content: [{ type: "reasoning", text: "thought-2" }, { type: "text", text: "answer-2" }] },
      { id: "msg_03", type: "idle", time: { created: 1794314200040 }, outcome: "succeeded" },
    ] as OpenCode2Message[]);
    event("session.step.ended", 1);
    await sleep(250);
    event("session.execution.succeeded", 2);
    await sleep(2_000);
  } finally {
    ctx.end();
    await stop?.();
  }
}

type Ev = Record<string, unknown> & { type: string };
/** The events one seat published, read back off its subject. */
async function readBack(id: string): Promise<Ev[]> {
  const reader = new CotalEndpoint({ space: SPACE, servers, card: { name: "Reader", kind: "agent", id: `reader_${id}` }, channels: [channelOf(id)] });
  reader.on("error", () => {});
  const seen: Ev[] = [];
  reader.on("message", (m: { channel?: string; parts?: { data?: unknown }[] }) => {
    if (m?.channel !== channelOf(id)) return;
    for (const p of m.parts ?? []) for (const e of ((p.data ?? p) as { events?: Ev[] }).events ?? []) seen.push(e);
  });
  await reader.start();
  await sleep(2_000);
  await reader.stop().catch(() => {});
  return seen;
}

/** The turn's reasoning is one start, content and end with the saved text, after the run opens and
 *  before the answer's text. */
function grade(label: string, seen: Ev[], thought: string, answer: string): void {
  const at = (pred: (e: Ev) => boolean) => seen.findIndex(pred);
  const started = at((e) => e.type === "RUN_STARTED");
  const answered = at((e) => e.type === "TEXT_MESSAGE_CONTENT" && e.delta === answer);
  check(`control:${label} the turn's run and answer reach the subject, so the cell below grades something`,
    started >= 0 && answered > started, seen.map((e) => e.type));
  const reasoning = seen.filter((e) => e.type.startsWith("REASONING_"));
  const first = at((e) => e.type.startsWith("REASONING_"));
  check(`reasoning:${label} the saved reasoning is published as one reasoning message with its text, inside the run and before the answer`,
    JSON.stringify(reasoning.map((e) => [e.type, e.delta])) === JSON.stringify([["REASONING_MESSAGE_START", undefined], ["REASONING_MESSAGE_CONTENT", thought], ["REASONING_MESSAGE_END", undefined]])
      && first > started && first < answered,
    reasoning);
}

const exits: unknown[] = [];
const exit = process.exit;
process.exit = ((code?: number) => {
  exits.push(code);
}) as typeof process.exit;
try {
  await awaitBrokerReady(() => isReachable(servers), { servers, attempts: 50, delayMs: 200 });
  await seedChannelRegistry({
    servers,
    space: SPACE,
    file: { defaults: { replay: false }, channels: { [channelOf(SEATS.v1.id)]: { replay: true }, [channelOf(SEATS.v2.id)]: { replay: true } } },
  });
  await runV1();
  grade("1.x", await readBack(SEATS.v1.id), "thought-1", "answer-1");
  await runV2();
  grade("2.x", await readBack(SEATS.v2.id), "thought-2", "answer-2");
  check("arm:no seat exited", exits.length === 0, { exits });
} finally {
  oc.close();
  broker.kill("SIGKILL");
  await sleep(150);
  rmSync(dir, { recursive: true, force: true });
  releaseBroker();
  process.exit = exit;
}

const EXPECTED = 5;
check(`meta:every cell ran - ${EXPECTED} expected`, passed() + failed() === EXPECTED, `${passed() + failed()} cells reported`);
finish();
process.exit();
