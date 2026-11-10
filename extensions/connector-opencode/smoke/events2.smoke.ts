/**
 * OPENCODE 2.x CARRIES THE AG-UI EVENT PLANE (#5007).
 *
 * The 2.x adapter used to exit on an armed plane, so every launch with events on, the CLI's default,
 * failed on OpenCode 2.x. Here the 2.x `setupCotal` runs armed against a real `nats-server` and a fake
 * OpenCode 2.x server that serves measured message lists (`fixtures/opencode2-sessions.json`) as each
 * session grows. Durable events fed through the host context wake the reads, as the real event
 * stream does, and a second endpoint reads the stream back off the subject and grades it as an
 * order: what a turn publishes, what it withholds, how a failed turn ends, and that the same principal
 * started again goes on publishing its new session on its channel.
 *
 * Run: pnpm smoke:opencode2-events   (needs nats-server on PATH; starts its own broker)
 */
import { spawn } from "node:child_process";
import { createServer as createHttpServer } from "node:http";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { once } from "node:events";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { CotalEndpoint, isReachable, principalKey, seedChannelRegistry } from "@cotal-ai/core";
import { eventWalLocation } from "@cotal-ai/connector-core";
import { SMOKE_BROKER_TOKEN, awaitBrokerReady, createSuite, freePort, teardownOnSignal } from "@cotal-ai/smoke-kit";
import { setupCotal } from "../src/plugin2.js";
import type { OpenCode2Message } from "../src/agui-source2.js";
import { fakeOpenCode2Context } from "./_boot-plugin.js";

const { check, finish, passed, failed } = createSuite();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const here = dirname(fileURLToPath(import.meta.url));
const fixture = JSON.parse(readFileSync(join(here, "fixtures", "opencode2-sessions.json"), "utf8")) as {
  sessions: { name: string; snapshots: OpenCode2Message[][] }[];
};
const snapshotsOf = (name: string): OpenCode2Message[][] => fixture.sessions.find((s) => s.name === name)!.snapshots;

const PORT = await freePort();
const servers = `nats://127.0.0.1:${PORT}`;
const SPACE = "oc2events";
const CHANNEL = "events.local.otto";
const SESSIONS = ["ses_oc2_first", "ses_oc2_restarted"];

const dir = mkdtempSync(join(tmpdir(), SMOKE_BROKER_TOKEN));
const workspaceRoot = join(dir, "ws");
mkdirSync(workspaceRoot, { recursive: true });
const broker = spawn("nats-server", ["-js", "-a", "127.0.0.1", "-p", String(PORT), "-sd", join(dir, "js")], { stdio: "ignore" });
const releaseBroker = teardownOnSignal(broker, dir);
const auth = `Basic ${Buffer.from("opencode:test-secret").toString("base64")}`;

/** The session lists the fake server holds, newest first per page, as OpenCode 2.x serves them. */
const lists = new Map<string, OpenCode2Message[]>();
const created: string[] = [];
let reads = 0;
const oc = createHttpServer((req, res) => {
  if (req.headers.authorization !== auth) return void res.writeHead(401).end();
  req.resume();
  req.on("end", () => {
    const url = new URL(req.url ?? "/", "http://x");
    const json = (body: unknown) => void res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(body));
    if (req.method === "POST" && url.pathname === "/api/session") {
      const id = SESSIONS[created.length]!;
      created.push(id);
      return json({ data: { id } });
    }
    const m = url.pathname.match(/^\/api\/session\/([^/]+)\/message$/);
    if (req.method === "GET" && m) {
      reads += 1;
      const limit = Number(url.searchParams.get("limit") ?? 50);
      const after = url.searchParams.get("cursor");
      const desc = [...(lists.get(decodeURIComponent(m[1]!)) ?? [])].sort((a, b) => (a.id < b.id ? 1 : -1));
      const start = after === null ? 0 : desc.findIndex((x) => x.id < after);
      const data = start < 0 ? [] : desc.slice(start, start + limit);
      return json({ data, cursor: { previous: null, next: data.at(-1)?.id ?? null } });
    }
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
  COTAL_SERVERS: servers,
  COTAL_EVENTS: "1",
  COTAL_WORKSPACE_ROOT: workspaceRoot,
  COTAL_OPENCODE_SERVER_URL: `http://127.0.0.1:${(oc.address() as { port: number }).port}`,
  OPENCODE_SERVER_USERNAME: "opencode",
  OPENCODE_SERVER_PASSWORD: "test-secret",
});

// The refusal this suite exists for was `process.exit(1)` inside setup, so an exit is recorded as a
// failed cell rather than ending the run.
const exits: unknown[] = [];
const exit = process.exit;
process.exit = ((code?: number) => {
  exits.push(code);
}) as typeof process.exit;

/** Grow one session snapshot by snapshot, with a durable event of it after each, as the server
 *  appends one to the session's log for every change to its list. */
let seq = 0;
async function grow(ctx: ReturnType<typeof fakeOpenCode2Context>, sessionID: string, snapshots: OpenCode2Message[][], end: string): Promise<void> {
  const event = (type: string) => ctx.feed({ type, durable: { aggregateID: sessionID, seq: seq++ }, data: { sessionID } });
  event("session.execution.started");
  for (const snapshot of snapshots) {
    lists.set(sessionID, snapshot);
    event("session.step.ended");
    await sleep(250);
  }
  event(end);
  await sleep(500);
}

const observer = new CotalEndpoint({ space: SPACE, servers, card: { name: "Watcher", kind: "agent", id: "watcher" }, channels: ["general"] });
observer.on("error", () => {});
let stops: Array<() => Promise<void>> = [];
try {
  await awaitBrokerReady(() => isReachable(servers), { servers, attempts: 50, delayMs: 200 });
  await seedChannelRegistry({ servers, space: SPACE, file: { defaults: { replay: false }, channels: { [CHANNEL]: { replay: true } } } });
  await observer.start();

  const first = fakeOpenCode2Context();
  const stopFirst = await setupCotal(first);
  if (stopFirst) stops.push(stopFirst);
  check("arm:a 2.x seat armed for events sets up and does not exit", typeof stopFirst === "function" && exits.length === 0, { exits });
  let card: { meta?: Record<string, unknown> } | undefined;
  for (let i = 0; i < 50 && !card; i++, await sleep(200)) card = observer.getRoster().find((p) => p.card.name === "Otto")?.card;
  check("arm:it joins, and its card says it publishes events", card?.meta?.["ai.cotal.events"] === "on", card?.meta);

  const sid = SESSIONS[0]!;
  const twoTurns = snapshotsOf("shell then text, two turns");
  await grow(first, sid, twoTurns, "session.execution.succeeded");
  // A prompt record carries its text, which the source never reads and the plane never publishes.
  const prompt = { id: "msg_08", type: "user", time: { created: 1794313802000 }, text: "[user 3]" };
  const failedTurn: OpenCode2Message[] = [
    ...twoTurns.at(-1)!,
    prompt,
    { id: "msg_09", type: "assistant", time: { created: 1794313802010, streamed: 1794313802020, completed: 1794313802030 }, content: [{ type: "text", text: "[text 3]" }] },
    { id: "msg_10", type: "idle", time: { created: 1794313802040 }, outcome: "failed", error: { type: "provider.auth", message: "upstream echoed: secret-detail" } },
  ];
  await grow(first, sid, [failedTurn], "session.execution.failed");
  const readsFirst = reads;

  first.end();
  await stopFirst?.();
  stops = [];
  const principal = principalKey("local", "otto").key;
  const { lockPath } = eventWalLocation({ workspaceRoot, space: SPACE, principal, threadId: sid });
  check("release:teardown gives the principal's event lock back, so a replacement seat can publish", !existsSync(lockPath), lockPath);

  const second = fakeOpenCode2Context();
  const stopSecond = await setupCotal(second);
  if (stopSecond) stops.push(async () => {
    second.end();
    await stopSecond();
  });
  await sleep(1_500);
  await grow(second, SESSIONS[1]!, snapshotsOf("interrupted while streaming"), "session.execution.interrupted");

  const reader = new CotalEndpoint({ space: SPACE, servers, card: { name: "Reader", kind: "agent", id: "reader" }, channels: [CHANNEL] });
  reader.on("error", () => {});
  type Ev = Record<string, unknown> & { type: string };
  const seen: Ev[] = [];
  reader.on("message", (m: { channel?: string; parts?: { data?: unknown }[] }) => {
    if (m?.channel !== CHANNEL) return;
    for (const p of m.parts ?? []) for (const e of ((p.data ?? p) as { events?: Ev[] }).events ?? []) seen.push(e);
  });
  await reader.start();
  await sleep(3_000);
  await reader.stop().catch(() => {});

  const types = seen.map((e) => e.type);
  const TEXT = ["TEXT_MESSAGE_START", "TEXT_MESSAGE_CONTENT", "TEXT_MESSAGE_END"];
  const expected = [
    "RUN_STARTED", "TOOL_CALL_START", "TOOL_CALL_END", ...TEXT, "RUN_FINISHED",
    "RUN_STARTED", ...TEXT, "RUN_FINISHED",
    "RUN_STARTED", ...TEXT, "RUN_ERROR",
    "RUN_STARTED", ...TEXT, "RUN_FINISHED",
  ];
  check("control:the stream reads back from the subject, so the cells below grade something", seen.length > 0, { frames: seen.length });
  check("order:each turn's run, its tool call's start and end, its text, and its close, in order and once each",
    JSON.stringify(types) === JSON.stringify(expected), types);
  check("control:the first session was read once for each of the 11 durable events fed to it, so the once-each order above held under repeated reads",
    readsFirst >= 11, { reads: readsFirst });
  check("withheld:no tool argument or result reaches the subject",
    !types.includes("TOOL_CALL_ARGS") && !types.includes("TOOL_CALL_RESULT"));
  const wire = JSON.stringify(seen);
  check("withheld:no prompt, tool input, tool result, reasoning or upstream error text reaches the subject",
    !["[user", "[input", "[result", "[reasoning", "secret-detail", "provider.auth"].some((p) => wire.includes(p)));
  const error = seen.find((e) => e.type === "RUN_ERROR");
  check("fail:the failed turn ends its run with RUN_ERROR carrying only the fixed message", error?.message === "run failed" && error.code === undefined, error);
  const starts = seen.filter((e) => e.type === "RUN_STARTED").map((e) => e.threadId);
  check("restart:the same principal started again publishes its new session after the first, on its channel",
    JSON.stringify(starts) === JSON.stringify([sid, sid, sid, SESSIONS[1]]), starts);
  check("deltas:each assistant text is published whole",
    JSON.stringify(seen.filter((e) => e.type === "TEXT_MESSAGE_CONTENT").map((e) => e.delta)) === JSON.stringify(["[text 1]", "[text 2]", "[text 3]", "[text 1]"]));
  check("arm:no seat exited at any point", exits.length === 0, { exits });
} finally {
  for (const stop of stops) await stop().catch(() => {});
  await observer.stop().catch(() => {});
  oc.close();
  broker.kill("SIGKILL");
  await sleep(150);
  rmSync(dir, { recursive: true, force: true });
  releaseBroker();
  process.exit = exit;
}

const EXPECTED = 12;
check(`meta:every cell ran - ${EXPECTED} expected`, passed() + failed() === EXPECTED, `${passed() + failed()} cells reported`);
finish();
process.exit();
