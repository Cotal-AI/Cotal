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
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { once } from "node:events";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CotalEndpoint, seedChannelRegistry, isReachable } from "@cotal-ai/core";
import { SMOKE_BROKER_TOKEN, awaitBrokerReady, freePort, teardownOnSignal } from "@cotal-ai/smoke-kit";
import { bootPlugin, disposeInProcess } from "./_boot-plugin.js";

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
/** While set, every read of the session's messages waits on it: the position read a turn end
 *  takes is in flight until it is released. */
let readGate: Promise<void> | undefined;
let releaseRead: (() => void) | undefined;
const holdReads = (): void => {
  readGate = new Promise<void>((r) => (releaseRead = r));
};
let reads = 0;
const oc = createHttpServer((req, res) => {
  if (req.headers.authorization !== auth) return void res.writeHead(401).end();
  req.setEncoding("utf8");
  req.on("data", () => {});
  req.on("end", async () => {
    if (req.method === "POST" && req.url === "/session")
      return void res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ id: A }));
    const m = req.url?.match(/^\/session\/([^/]+)\/message$/);
    if (req.method === "GET" && m && readGate) await readGate;
    if (req.method === "GET" && m) reads++;
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
  await awaitBrokerReady(() => isReachable(servers), { servers, attempts: 50, delayMs: 200 });
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
  // THE TURN END WAITS BEHIND ITS POSITION READ. The terminal's position is the session's messages
  // over HTTP; an event arm that returns before that read answers lets the next turn in ahead of
  // it, and the position then names the next turn (Sol, round 14 of 2026-10-13, through the built
  // plugin: a failed turn closed as a finish and its successor as the error). The read is held
  // here, and the arm must still be in flight while it is.
  holdReads();
  const errored = fire({
    type: "session.error",
    properties: { sessionID: A, error: { name: "APIError", data: { message: "upstream returned 500", statusCode: 500, isRetryable: true } } },
  }).then(() => "returned" as const);
  const errorArm = await Promise.race([errored, sleep(600).then(() => "in flight" as const)]);
  check("barrier:the error arm is still in flight while the terminal's position read is held", errorArm === "in flight", errorArm);
  // A NATIVE PROMPT waits behind the same read. OpenCode awaits the prompt hook before it saves the
  // user message, so a hook that returns here lets the next turn's records land ahead of the
  // position (Sol, round 15 of 2026-10-13, through the built plugin: the driven path waited and the
  // typed one did not).
  const typed = (hooks as unknown as { "chat.message": (i: unknown, o: unknown) => Promise<void> })["chat.message"]({ sessionID: A }, { parts: [{ type: "text", text: "next prompt" }] }).then(() => "returned" as const);
  const promptHook = await Promise.race([typed, sleep(600).then(() => "in flight" as const)]);
  check("barrier:a native prompt is held while the terminal's position read is held", promptHook === "in flight", promptHook);
  releaseRead?.();
  readGate = undefined;
  await errored;
  check("barrier:the native prompt goes through once the read has answered", (await Promise.race([typed, sleep(2_000).then(() => "stuck" as const)])) === "returned");
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

  // ---- Turn 3: a turn that ends on `session.idle`, the same barrier on the other arm.
  content.set(A, [...turn(A, 1), ...turn(A, 2), ...turn(A, 3)]);
  await part(A);
  await sleep(2_000);
  await busy(A);
  holdReads();
  const idled = fire({ type: "session.idle", properties: { sessionID: A } }).then(() => "returned" as const);
  const idleArm = await Promise.race([idled, sleep(600).then(() => "in flight" as const)]);
  check("barrier:the idle arm is still in flight while the terminal's position read is held", idleArm === "in flight", idleArm);
  releaseRead?.();
  readGate = undefined;
  await idled;
  await sleep(2_500);

  // ---- Turn 4: the API error lands while a text part is still filling. The part never gets its
  // end mark and the message never reports completed, so no read settles it; the turn end's
  // position is past it all the same. The settle must not pump the session's messages without end
  // for a record no read can answer (Sol, round 15 of 2026-10-13, through the built plugin: 934
  // reads in 500 ms and the run left open).
  const a4 = `msg_${A}_0009`;
  content.set(A, [...turn(A, 1), ...turn(A, 2), ...turn(A, 3), {
    info: { id: `msg_${A}_0008`, sessionID: A, role: "user", time: { created: 40 } },
    parts: [{ id: `msg_${A}_0008_p0`, messageID: `msg_${A}_0008`, sessionID: A, type: "text", text: "prompt", time: { start: 40, end: 40 } }],
  }, {
    info: { id: a4, sessionID: A, role: "assistant", time: { created: 41 } },
    parts: [
      { id: `${a4}_p0`, messageID: a4, sessionID: A, type: "text", text: "answer-4", time: { start: 41, end: 42 } },
      { id: `${a4}_p1`, messageID: a4, sessionID: A, type: "text", text: "cut off", time: { start: 43 } },
    ],
  }]);
  await part(A);
  await sleep(2_000);
  await busy(A);
  const before = reads;
  const unsettled = fire({
    type: "session.error",
    properties: { sessionID: A, error: { name: "APIError", data: { message: "upstream closed the stream", statusCode: 502, isRetryable: true } } },
  }).then(() => "returned" as const);
  check("unsettled:the error arm returns while the part stays unfinished", (await Promise.race([unsettled, sleep(3_000).then(() => "stuck" as const)])) === "returned");
  await sleep(1_500);
  check("unsettled:the settle read the session a bounded number of times, not without end", reads - before <= 8, { reads: reads - before });

  // ---- Turn 5: a plain turn after the one whose part never finished. The session is not wedged
  // behind that part: its answer reaches the wire and it closes as a finish (Sol, round 16 of
  // 2026-10-13, through the built plugin: with the part left unsettled, every later read stopped
  // at it and no later turn was ever published).
  content.set(A, [...(content.get(A) as unknown[]), ...turn(A, 5)]);
  await part(A);
  await sleep(2_000);
  await busy(A);
  await fire({ type: "session.idle", properties: { sessionID: A } });
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
  const a3 = idx((e) => e.text.includes("answer-3"));
  const abortedTurnCloses = closesBetween(a2, a3);
  const a4i = idx((e) => e.text.includes("answer-4"));
  const idleTurnCloses = closesBetween(a3, a4i);
  const a5i = idx((e) => e.text.includes("answer-5"));
  const unsettledTurnCloses = closesBetween(a4i, a5i);
  const afterUnsettledCloses = closesBetween(a5i, -1);

  check("fail:the API-error turn closed EXACTLY ONCE — `RUN_ERROR` closes a run, so nothing may follow it",
    failedTurnCloses.length === 1, failedTurnCloses);
  check("fail:and that close is RUN_ERROR, not RUN_FINISHED — THE DEFECT",
    failedTurnCloses[0]?.type === "RUN_ERROR", failedTurnCloses[0]);
  check("fail:the RUN_ERROR carries the fixed message and no code",
    failedTurnCloses[0]?.message === "run failed" && !failedTurnCloses[0]?.code,
    failedTurnCloses[0]);

  check("abort:the user-aborted turn closed exactly once", abortedTurnCloses.length === 1, abortedTurnCloses);
  check("abort:and THAT close is RUN_FINISHED — a Stop is not a failed turn, and a blanket mapping would fail here",
    abortedTurnCloses[0]?.type === "RUN_FINISHED", abortedTurnCloses[0]);
  check("idle:the turn that ended on session.idle closed exactly once, as a finish", a3 >= 0 && idleTurnCloses.length === 1 && idleTurnCloses[0]?.type === "RUN_FINISHED", { a3, idleTurnCloses });

  check("unsettled:the turn whose part never finished closed exactly once, as the error, on its own turn",
    a4i >= 0 && unsettledTurnCloses.length === 1 && unsettledTurnCloses[0]?.type === "RUN_ERROR", { a4i, unsettledTurnCloses });

  check("unsettled:the turn after it is published, so the session is not wedged behind the unfinished part",
    a5i >= 0 && afterUnsettledCloses.length === 1 && afterUnsettledCloses[0]?.type === "RUN_FINISHED", { a5i, afterUnsettledCloses });

  // ---- Cell count, because a harness that threw early would DELETE cells rather than fail them.
  const EXPECTED = 16;
  check(`every cell ran - ${EXPECTED} expected, a cell that vanishes is invisible without this`,
    pass + fail === EXPECTED, `${pass + fail} cells reported`);

  console.log(`opencode-run-error smoke: ${pass} passed, ${fail} failed`);
} finally {
  await disposeInProcess(hooks);
  oc.close();
  broker.kill("SIGKILL");
  await sleep(150);
  rmSync(dir, { recursive: true, force: true });
  releaseBroker();
}
assert.ok(true);
process.exit(fail === 0 ? 0 : 1);
