/**
 * A FAILED OPENCODE TURN MUST NOT BE PUBLISHED AS A FINISHED ONE (#596).
 *
 * **THE DEFECT.** `session.error` is the bus event OpenCode fires when a turn dies — an upstream
 * API error, a provider auth failure, an output-length stop. The plugin already reacts to it as a
 * failure everywhere except on the wire: it leaves the surfaced batch un-acked so it can retry, it
 * schedules a retry, and it distinguishes a user's Stop/Cancel from a real failure. But the run it
 * closes on that same line closed with `RUN_FINISHED`, exactly as a turn that succeeded does, so a
 * reader of the plane could not tell the two apart. `RUN_ERROR` is in the vocabulary, the bracket
 * machine accepts it as a close and the dashboard renders it; the shared close path simply had no
 * way to say it.
 *
 * **THE PLUGIN IS REAL AND THE BROKER IS REAL.** The plugin closure from `src` runs against a real
 * `nats-server` with a fake OpenCode HTTP server standing in for the session store, and every claim
 * below is read back OFF THE SUBJECT by a second endpoint. A recorder that returns a shaped value
 * could not testify here: the claim is about what an observer of the channel sees, in order.
 *
 * **WHAT WOULD MAKE THIS THE WRONG EXPERIMENT**, named before the run rather than discovered after:
 *   - `session.error` returns early unless a turn is in flight (`busy || awaitingTurnEnd`), so a
 *     phase that forgets to drive `session.status: busy` first would exercise nothing and every
 *     ordering cell below would grade an absence. The `control:` cells fail in that case.
 *   - an emitter that never started publishes nothing, and a suite that reads zero everywhere
 *     "confirms" whatever it was pointed at. Both turns' text is graded on its own cell.
 *   - a blanket "every `session.error` is a failure" would pass every failure cell here and still
 *     be wrong, because a user's Stop is not a failed turn. The abort phase is the positive control
 *     for that, and it is the reason this file drives two errors rather than one.
 *
 * Run: pnpm smoke:opencode-run-error   (needs nats-server on PATH; starts its own broker)
 */
import { strict as assert } from "node:assert";
import { spawn } from "node:child_process";
import { createServer as createHttpServer } from "node:http";
import { createServer as createNetServer } from "node:net";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { once } from "node:events";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CotalEndpoint, seedChannelRegistry, isReachable } from "@cotal-ai/core";
import { SMOKE_BROKER_TOKEN, teardownOnSignal } from "@cotal-ai/smoke-kit";
import { bootPlugin } from "./_boot-plugin.js";

async function freePort(): Promise<number> {
  const s = createNetServer();
  s.listen(0, "127.0.0.1");
  await once(s, "listening");
  const port = (s.address() as { port: number }).port;
  await new Promise<void>((r) => s.close(() => r()));
  return port;
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const PORT = await freePort();
const servers = `nats://127.0.0.1:${PORT}`;
const SPACE = "ocrunerr";
// The identity the plugin authenticates as decides the subject, so the channel is named from it.
const CHANNEL = "events.local.otto";
const A = "ses_00000000000000000000000001";

const dir = mkdtempSync(join(tmpdir(), SMOKE_BROKER_TOKEN));
mkdirSync(join(dir, "ws"), { recursive: true });
const broker = spawn("nats-server", ["-js", "-p", String(PORT), "-sd", join(dir, "js")], { stdio: "ignore" });
const releaseBroker = teardownOnSignal(broker, dir);
const auth = `Basic ${Buffer.from("opencode:test-secret").toString("base64")}`;

let pass = 0;
let fail = 0;
const check = (name: string, cond: boolean, extra?: unknown): void => {
  if (cond) {
    pass++;
    console.log(`  ✓ ${name}`);
    return;
  }
  fail++;
  console.log(`  ✗ ${name}${extra !== undefined ? ` - ${JSON.stringify(extra)}` : ""}`);
};

/** One turn of a session. Ids sort in creation order, as real OpenCode ids do; the text carries the
 *  turn number so a cell can LOCATE one turn in the replayed stream instead of counting and hoping. */
function turn(sessionID: string, n: number): unknown[] {
  const u = `msg_${sessionID}_${String(2 * n).padStart(4, "0")}`;
  const a = `msg_${sessionID}_${String(2 * n + 1).padStart(4, "0")}`;
  return [
    {
      info: { id: u, sessionID, role: "user", time: { created: 10 * n } },
      parts: [{ id: `${u}_p0`, messageID: u, sessionID, type: "text", text: "prompt", time: { start: 10 * n, end: 10 * n } }],
    },
    {
      info: { id: a, sessionID, role: "assistant", time: { created: 10 * n + 1, completed: 10 * n + 9 } },
      parts: [
        { id: `${a}_p0`, messageID: a, sessionID, type: "text", text: `answer-${n}`,
          time: { start: 10 * n + 1, end: 10 * n + 2 } },
      ],
    },
  ];
}

const content = new Map<string, unknown[]>();
const oc = createHttpServer((req, res) => {
  if (req.headers.authorization !== auth) return void res.writeHead(401).end();
  req.setEncoding("utf8");
  req.on("data", () => {});
  req.on("end", () => {
    if (req.method === "POST" && req.url === "/session")
      return void res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ id: A }));
    const m = req.url?.match(/^\/session\/([^/]+)\/message$/);
    if (req.method === "GET" && m)
      return void res
        .writeHead(200, { "content-type": "application/json" })
        .end(JSON.stringify(content.get(decodeURIComponent(m[1]!)) ?? []));
    if (req.method === "POST" && req.url?.endsWith("/prompt_async")) return void res.writeHead(204).end();
    res.writeHead(404).end();
  });
});
oc.listen(0, "127.0.0.1");
await once(oc, "listening");
const ocPort = (oc.address() as { port: number }).port;

// The plugin reads its identity from COTAL_* env. Scrub what this process inherited: a live seat's
// creds would point these cells at someone else's broker.
for (const k of Object.keys(process.env)) if (k.startsWith("COTAL_")) delete process.env[k];
Object.assign(process.env, {
  COTAL_NAME: "Otto",
  COTAL_ID: "otto",
  COTAL_SPACE: SPACE,
  COTAL_SERVERS: servers,
  COTAL_ROLE: "generalist",
  COTAL_EVENTS: "1",
  COTAL_WORKSPACE_ROOT: join(dir, "ws"),
  COTAL_OPENCODE_SERVER_URL: `http://127.0.0.1:${ocPort}`,
  OPENCODE_SERVER_USERNAME: "opencode",
  OPENCODE_SERVER_PASSWORD: "test-secret",
});

type Hooks = Awaited<ReturnType<typeof bootPlugin>>;
let hooks: Hooks | undefined;
try {
  for (let i = 0; i < 50; i++) {
    if (await isReachable(servers)) break;
    await sleep(200);
  }
  await seedChannelRegistry({
    servers,
    space: SPACE,
    // Replay is on so the whole stream can be read back at the end and graded as an ORDER.
    file: { defaults: { replay: false }, channels: { [CHANNEL]: { replay: true } } },
  });

  hooks = await bootPlugin();
  await sleep(1_500);
  const fire = (event: unknown): Promise<void> => (hooks as unknown as { event: (a: unknown) => Promise<void> }).event({ event });
  const part = (sessionID: string): Promise<void> => fire({ type: "message.part.updated", properties: { part: { sessionID } } });
  const busy = (sessionID: string): Promise<void> =>
    fire({ type: "session.status", properties: { sessionID, status: { type: "busy" } } });

  // ---- Turn 1: a real turn, then the API error that killed it.
  content.set(A, []);
  await fire({ type: "session.created", properties: { info: { id: A } } });
  await sleep(1_500);
  await part(A); // parks the cursor on the near-empty session, as a live one does
  await sleep(1_500);
  content.set(A, turn(A, 1));
  await part(A);
  await sleep(2_000);

  await busy(A);
  await fire({
    type: "session.error",
    properties: { sessionID: A, error: { name: "APIError", data: { message: "upstream returned 500", statusCode: 500, isRetryable: true } } },
  });
  await sleep(2_500);

  // ---- Turn 2: a real turn, then a USER ABORT. Not a failure, and the control that says so.
  content.set(A, [...turn(A, 1), ...turn(A, 2)]);
  await part(A);
  await sleep(2_000);

  await busy(A);
  await fire({
    type: "session.error",
    properties: { sessionID: A, error: { name: "MessageAbortedError", data: { message: "The operation was aborted" } } },
  });
  await sleep(2_500);

  // ---- Read the whole stream back from the broker and grade it as an ORDER.
  const reader = new CotalEndpoint({
    space: SPACE, servers, card: { name: "Reader", kind: "agent", id: "reader" }, channels: [CHANNEL],
  });
  reader.on("error", () => {});
  type Ev = { type: string; text: string; message: string; code: string };
  const seen: Ev[] = [];
  reader.on("message", (m: { channel?: string; parts?: { data?: unknown }[] }) => {
    if (m?.channel !== CHANNEL) return;
    for (const p of m.parts ?? []) {
      const d = (p as { data?: { events?: unknown[] } }).data ?? p;
      for (const e of ((d as { events?: unknown[] }).events ?? []) as Record<string, unknown>[])
        seen.push({
          type: String(e.type ?? "?"),
          text: String(e.delta ?? ""),
          message: String(e.message ?? ""),
          code: String(e.code ?? ""),
        });
    }
  });
  await reader.start();
  await sleep(3_000);
  await reader.stop().catch(() => {});

  check("control:the stream reads back non-empty, so the order cells below grade something",
    seen.length > 0, { frames: seen.length });

  const idx = (pred: (e: Ev) => boolean): number => seen.findIndex(pred);
  const a1 = idx((e) => e.text.includes("answer-1"));
  const a2 = idx((e) => e.text.includes("answer-2"));
  check("control:BOTH turns reached the subject, in order — a stream missing one grades nothing below",
    a1 >= 0 && a2 >= 0 && a1 < a2, { a1, a2 });

  const isClose = (e: Ev): boolean => e.type === "RUN_FINISHED" || e.type === "RUN_ERROR";
  // SECTION-BOUNDED, never a scan of the whole stream: each turn's close is looked for only in the
  // window between that turn's own text and the next turn's. A whole-stream scan would happily
  // match the OTHER turn's close and report the wrong evidence.
  const closesBetween = (from: number, to: number): Ev[] =>
    seen.slice(from + 1, to < 0 ? seen.length : to).filter(isClose);
  const failedTurnCloses = closesBetween(a1, a2);
  const abortedTurnCloses = closesBetween(a2, -1);

  check("fail:the API-error turn closed EXACTLY ONCE — `RUN_ERROR` closes a run, so nothing may follow it",
    failedTurnCloses.length === 1, failedTurnCloses);
  check("fail:and that close is RUN_ERROR, not RUN_FINISHED — THE DEFECT",
    failedTurnCloses[0]?.type === "RUN_ERROR", failedTurnCloses[0]);
  check("fail:the RUN_ERROR carries the harness's own message and error name as the code",
    failedTurnCloses[0]?.message === "upstream returned 500" && failedTurnCloses[0]?.code === "APIError",
    failedTurnCloses[0]);

  check("abort:the user-aborted turn closed exactly once", abortedTurnCloses.length === 1, abortedTurnCloses);
  check("abort:and THAT close is RUN_FINISHED — a Stop is not a failed turn, and a blanket mapping would fail here",
    abortedTurnCloses[0]?.type === "RUN_FINISHED", abortedTurnCloses[0]);

  // ---- Cell count, because a harness that threw early would DELETE cells rather than fail them.
  const EXPECTED = 7;
  check(`every cell ran - ${EXPECTED} expected, a cell that vanishes is invisible without this`,
    pass + fail === EXPECTED, `${pass + fail} cells reported`);

  console.log(`opencode-run-error smoke: ${pass} passed, ${fail} failed`);
} finally {
  await hooks?.dispose?.();
  oc.close();
  broker.kill("SIGKILL");
  await sleep(150);
  rmSync(dir, { recursive: true, force: true });
  releaseBroker();
}
assert.ok(true);
process.exit(fail === 0 ? 0 : 1);
