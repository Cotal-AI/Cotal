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
async function grow(ctx: ReturnType<typeof fakeOpenCode2Context>, sessionID: string, snapshots: OpenCode2Message[][], end: string, endData: Record<string, unknown> = {}): Promise<void> {
  const event = (type: string, extra: Record<string, unknown> = {}) => ctx.feed({ type, durable: { aggregateID: sessionID, seq: seq++ }, data: { sessionID, ...extra } });
  event("session.execution.started");
  for (const snapshot of snapshots) {
    lists.set(sessionID, snapshot);
    event("session.step.ended");
    await sleep(250);
  }
  event(end, endData);
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
  // The failed end carries the error as OpenCode 2.2.5 sends it for a provider 401 (measured live:
  // `session.execution.failed` data `{ sessionID, error: { type, message, status, response } }`).
  await grow(first, sid, [failedTurn], "session.execution.failed", {
    error: { type: "provider.auth", message: "Missing API key", status: 401, response: { body: "{\"error\":\"upstream echoed: secret-detail\"}" } },
  });
  const readsFirst = reads;
  const otto = () => observer.getRoster().find((p) => p.card.name === "Otto");
  let failedPresence = otto();
  for (let i = 0; i < 25 && !failedPresence?.condition; i++, await sleep(200)) failedPresence = otto();
  const { since, ...failure } = failedPresence?.condition ?? { since: undefined };
  check("condition:the failed turn reads idle with OpenCode's own error kind and message as its condition, so no observer sees a bare idle",
    failedPresence?.status === "idle" && JSON.stringify(failure) === JSON.stringify({ code: "auth", source: "provider.auth", message: "Missing API key" }) && typeof since === "number",
    { status: failedPresence?.status, condition: failedPresence?.condition });
  check("withheld:the provider's response body does not reach presence", !JSON.stringify(failedPresence ?? {}).includes("secret-detail"));

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
  const after = otto();
  check("condition:a turn someone stopped is not a failure, and the seat that ran it reports no condition",
    after?.status === "idle" && after.condition === undefined, { status: after?.status, condition: after?.condition });

  // A form, such as the question tool's, waits on a person while it is open. This turn records
  // nothing, so it publishes nothing.
  const fed = (type: string, data: Record<string, unknown>) => second.feed({ type, durable: { aggregateID: SESSIONS[1]!, seq: seq++ }, data });
  fed("session.execution.started", { sessionID: SESSIONS[1]! });
  second.feed({ type: "form.created", data: { form: { id: "frm_1", sessionID: SESSIONS[1]!, title: "Questions", metadata: { kind: "question" }, fields: [] } } });
  let asking = otto();
  for (let i = 0; i < 25 && asking?.status !== "waiting"; i++, await sleep(200)) asking = otto();
  check("waiting:an open question form reads waiting, with the form's title as the activity",
    asking?.status === "waiting" && asking.activity === "Questions", { status: asking?.status, activity: asking?.activity });
  // An answered ask leaves the turn running, so the seat reads working again until the turn ends.
  const settledOn = async (status: string) => {
    let now = otto();
    for (let i = 0; i < 25 && now?.status !== status; i++, await sleep(200)) now = otto();
    return now;
  };
  second.feed({ type: "form.replied", data: { id: "frm_1", sessionID: SESSIONS[1]!, answer: {} } });
  const answered = await settledOn("working");
  check("answered:a question form answered while its turn runs reads working again", answered?.status === "working", { status: answered?.status, activity: answered?.activity });
  second.feed({ type: "permission.asked", data: { id: "per_1", sessionID: SESSIONS[1]!, action: "shell", resources: ["sleep 60"], save: ["sleep *"], source: { type: "tool", messageID: "msg_1", id: "call_1" } } });
  await settledOn("waiting");
  second.feed({ type: "permission.replied", data: { sessionID: SESSIONS[1]!, requestID: "per_1", reply: "once" } });
  const allowed = await settledOn("working");
  check("answered:a permission ask answered while its turn runs reads working again", allowed?.status === "working", { status: allowed?.status, activity: allowed?.activity });
  fed("session.execution.interrupted", { sessionID: SESSIONS[1]! });
  await sleep(300);

  // Read from here on, so a close can be told from one the next prompt makes.
  const reader = new CotalEndpoint({ space: SPACE, servers, card: { name: "Reader", kind: "agent", id: "reader" }, channels: [CHANNEL] });
  reader.on("error", () => {});
  type Ev = Record<string, unknown> & { type: string };
  const seen: Ev[] = [];
  reader.on("message", (m: { channel?: string; parts?: { data?: unknown }[] }) => {
    if (m?.channel !== CHANNEL) return;
    for (const p of m.parts ?? []) for (const e of ((p.data ?? p) as { events?: Ev[] }).events ?? []) seen.push(e);
  });
  await reader.start();

  // A rejected permission ends the execution as interrupted and records no `idle` (measured on
  // OpenCode 2.0.24); the declined call's record is the live one, its text replaced.
  const stopped = snapshotsOf("interrupted while streaming").at(-1)!;
  const userRecord = (id: string, created: number, text: string) => ({ id, type: "user", time: { created }, text });
  const rejected: OpenCode2Message[] = [
    ...stopped,
    userRecord("msg_05", 1794314120000, "[user 2]"),
    { id: "msg_06", type: "assistant", time: { created: 1794314120010, streamed: 1794314120020, completed: 1794314120030 }, error: { type: "aborted", message: "Step interrupted" },
      content: [{ type: "tool", id: "call_2", name: "shell", state: { status: "error", input: { command: "[input 2]" }, error: { type: "aborted", message: "The user declined this tool call" } }, time: { created: 1794314120011, ran: 1794314120015, completed: 1794314120029 } }] },
  ];
  await grow(second, SESSIONS[1]!, [rejected], "session.execution.interrupted");
  const rejectedRun = () => seen.filter((e) => e.type === "RUN_STARTED" && e.threadId === SESSIONS[1]).at(-1)?.runId;
  const closedBeforeNext = async () => {
    for (let i = 0; i < 15; i++, await sleep(200)) if (seen.some((e) => e.type === "RUN_FINISHED" && e.runId === rejectedRun())) return true;
    return false;
  };
  check("interrupted:a turn interrupted with no idle record closes its run before any next prompt", await closedBeforeNext(), { run: rejectedRun(), seen: seen.slice(-6) });
  // A stop whose `idle` record lands after the interrupted event: the run is closed by then.
  const lateStop: OpenCode2Message[] = [
    ...rejected,
    userRecord("msg_07", 1794314130000, "[user 3]"),
    { id: "msg_08", type: "assistant", time: { created: 1794314130010, streamed: 1794314130020, completed: 1794314130030 }, content: [{ type: "text", text: "[text 2]" }] },
  ];
  await grow(second, SESSIONS[1]!, [lateStop], "session.execution.interrupted");
  lists.set(SESSIONS[1]!, [...lateStop, { id: "msg_09", type: "idle", time: { created: 1794314130040 }, outcome: "interrupted" }]);
  second.feed({ type: "session.updated", durable: { aggregateID: SESSIONS[1]!, seq: seq++ }, data: { sessionID: SESSIONS[1]! } });
  await sleep(500);
  const nextTurn: OpenCode2Message[] = [
    ...lists.get(SESSIONS[1]!)!,
    userRecord("msg_10", 1794314140000, "[user 4]"),
    { id: "msg_11", type: "assistant", time: { created: 1794314140010, streamed: 1794314140020, completed: 1794314140030 }, content: [{ type: "text", text: "[text 3]" }] },
    { id: "msg_12", type: "idle", time: { created: 1794314140040 }, outcome: "succeeded" },
  ];
  await grow(second, SESSIONS[1]!, [nextTurn], "session.execution.succeeded");
  // A turn the provider refused before any output, as OpenCode 2.0.24 recorded one live: an
  // assistant record with no content, then the failed idle.
  const refusedTurn: OpenCode2Message[] = [
    ...nextTurn,
    userRecord("msg_13", 1794314150000, "[user 5]"),
    { id: "msg_14", type: "assistant", time: { created: 1794314150010, completed: 1794314150020 }, error: { type: "provider.invalid-request", message: "[error 2]" }, content: [] },
    { id: "msg_15", type: "idle", time: { created: 1794314150030 }, outcome: "failed" },
  ];
  await grow(second, SESSIONS[1]!, [refusedTurn], "session.execution.failed", { error: { type: "provider.invalid-request", message: "Model is unavailable." } });

  await sleep(3_000);
  await reader.stop().catch(() => {});

  const types = seen.map((e) => e.type);
  const TEXT = ["TEXT_MESSAGE_START", "TEXT_MESSAGE_CONTENT", "TEXT_MESSAGE_END"];
  const expected = [
    "RUN_STARTED", "TOOL_CALL_START", "TOOL_CALL_END", "CUSTOM", ...TEXT, "RUN_FINISHED",
    "RUN_STARTED", ...TEXT, "RUN_FINISHED",
    "RUN_STARTED", ...TEXT, "RUN_ERROR",
    "RUN_STARTED", ...TEXT, "RUN_FINISHED",
    "RUN_STARTED", "TOOL_CALL_START", "TOOL_CALL_END", "CUSTOM", "RUN_FINISHED",
    "RUN_STARTED", ...TEXT, "RUN_FINISHED",
    "RUN_STARTED", ...TEXT, "RUN_FINISHED",
    "RUN_STARTED", "RUN_ERROR",
  ];
  check("control:the stream reads back from the subject, so the cells below grade something", seen.length > 0, { frames: seen.length });
  check("order:each turn's run, its tool call's start, end and result marker, its text, and its close, in order and once each",
    JSON.stringify(types) === JSON.stringify(expected), types);
  check("control:the first session was read once for each of the 11 durable events fed to it, so the once-each order above held under repeated reads",
    readsFirst >= 11, { reads: readsFirst });
  check("withheld:no tool argument or result reaches the subject",
    !types.includes("TOOL_CALL_ARGS") && !types.includes("TOOL_CALL_RESULT"));
  const wire = JSON.stringify(seen);
  check("withheld:no prompt, tool input, tool result, reasoning or upstream error text reaches the subject",
    !["[user", "[input", "[result", "[reasoning", "secret-detail", "provider.auth"].some((p) => wire.includes(p)));
  const restarted = seen.filter((e) => e.threadId === SESSIONS[1] && e.type === "RUN_STARTED").map((e) => e.runId).slice(0, 4);
  const closes = seen.filter((e) => e.type === "RUN_FINISHED" && restarted.includes(e.runId)).map((e) => e.runId);
  check("late-idle:an idle recorded after an out-of-band close closes nothing, and each run of the restarted session closes once",
    restarted.length === 4 && new Set(restarted).size === 4 && JSON.stringify(closes) === JSON.stringify(restarted), { restarted, closes });
  check("refused:a turn the provider refused before any output publishes a run of its own that ends with RUN_ERROR",
    JSON.stringify(seen.slice(-2).map((e) => [e.type, e.type === "RUN_STARTED" ? e.threadId : undefined])) === JSON.stringify([["RUN_STARTED", SESSIONS[1]], ["RUN_ERROR", undefined]]), seen.slice(-2));
  const error = seen.find((e) => e.type === "RUN_ERROR");
  check("fail:the failed turn ends its run with RUN_ERROR carrying only the fixed message", error?.message === "run failed" && error.code === undefined, error);
  const starts = seen.filter((e) => e.type === "RUN_STARTED").map((e) => e.threadId);
  check("restart:the same principal started again publishes its new session after the first, on its channel",
    JSON.stringify(starts) === JSON.stringify([sid, sid, sid, SESSIONS[1], SESSIONS[1], SESSIONS[1], SESSIONS[1], SESSIONS[1]]), starts);
  check("deltas:each assistant text is published whole",
    JSON.stringify(seen.filter((e) => e.type === "TEXT_MESSAGE_CONTENT").map((e) => e.delta)) === JSON.stringify(["[text 1]", "[text 2]", "[text 3]", "[text 1]", "[text 2]", "[text 3]"]));
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

const EXPECTED = 21;
check(`meta:every cell ran - ${EXPECTED} expected`, passed() + failed() === EXPECTED, `${passed() + failed()} cells reported`);
finish();
process.exit();
