/**
 * `/new` MUST NOT TAKE THE EVENT PLANE DARK, and this suite exists because it did.
 *
 * **THE DEFECT.** A holder binds to one thread for the life of its emitter and refuses a second one
 * terminally: the write-ahead log is keyed to the thread, so re-adopting would continue one
 * session's epoch and sequence against another session's bytes. That refusal is correct. What was
 * wrong was the caller: the plugin adopted every top-level `session.created` into the SAME holder,
 * so the second one killed it and every later flush and run close became a silent no-op. Measured
 * on this harness before the fix: session one published, `/new` logged the refusal, and session two
 * published nothing, then nothing again on the turn after that.
 *
 * The consumer harm is the reason this is not a cosmetic lifecycle bug. The refusal is logged on the
 * connector's side only. On the subject an external observer holds a run that never ends and a
 * stream that simply stops, with no divergence marker anywhere on the wire.
 *
 * **THE PLUGIN IS REAL AND THE BROKER IS REAL.** The plugin closure from `src` runs against a real
 * `nats-server` and real opencode bus events, with a fake OpenCode HTTP server standing in for the
 * session store. A recorder that returns a shaped value could not testify here: the claim is about
 * what reaches a SUBJECT, and it is asked of the broker, never of the emitter.
 *
 * **THE POSITIVE CONTROL IS A CELL, NOT A COMMENT.** Three earlier drafts of this harness read zero
 * frames in every phase and would have "confirmed" the defect for a reason that had nothing to do
 * with it. `adopt` does not read; the FIRST pump is what parks the cursor at the current end, and in
 * production that first pump is a `message.part.updated` fired as soon as a part exists, so the park
 * lands on a nearly empty session. A harness that skips it parks on the whole finished turn and
 * reads zero everywhere. An instrument that answers zero to everything is not evidence, so the first
 * session's frames are graded on their own cell and this file cannot silently become one.
 *
 * WHAT THIS FILE DOES NOT COVER, stated rather than left to be found. It says nothing about the
 * mapping of a record to events (`smoke:agui-opencode-map`), about what the source considers
 * settled (`smoke:agui-opencode-source`), or about whether a real `cotal spawn --events` arms the
 * launch at all (`smoke:opencode-events-arm` for the connector's own decision,
 * `smoke:spawn-foreground-events` for the caller's). Its subject is one thing: what the plugin does
 * with a SECOND top-level session.
 *
 * Run: pnpm smoke:opencode-events-reset   (needs nats-server on PATH; starts its own broker)
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
import { cotal } from "../src/plugin.js";

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
const SPACE = "ocreset";
// The identity the plugin authenticates as decides the subject, so the channel is named from it.
const CHANNEL = "events.local.otto";
const A = "ses_00000000000000000000000001";
const B = "ses_00000000000000000000000002";
const CHILD = "ses_00000000000000000000000003";

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
    return;
  }
  fail++;
  console.log(`  ✗ ${name}${extra !== undefined ? ` - ${JSON.stringify(extra)}` : ""}`);
};

/**
 * One turn of a session. IDS SORT IN CREATION ORDER because real OpenCode ids are monotonic and the
 * source orders a session by message id then part id. Ids that sort the other way would reorder the
 * session and make a later turn land BEFORE the cursor, which is a property of a fixture rather than
 * of the code under test. The text carries the turn number so a cell can locate one turn's events in
 * the replayed stream instead of counting and hoping.
 */
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
        { id: `${a}_p0`, messageID: a, sessionID, type: "text", text: `answer-${sessionID.slice(-1)}-${n}`,
          time: { start: 10 * n + 1, end: 10 * n + 2 } },
        { id: `${a}_p1`, messageID: a, sessionID, type: "tool", callID: `call_${a}`, tool: "bash",
          state: { status: "completed", input: { cmd: "ls" }, output: "ok", time: { start: 10 * n + 3, end: 10 * n + 4 } } },
      ],
    },
  ];
}

// The plugin's own stderr, captured so a holder death is OBSERVED rather than inferred from silence.
const logs: string[] = [];
const realWrite = process.stderr.write.bind(process.stderr);
(process.stderr as unknown as { write: (c: string) => boolean }).write = (chunk: string): boolean => {
  if (typeof chunk === "string" && chunk.includes("[cotal-connector]")) logs.push(chunk.trim());
  return realWrite(chunk as never);
};

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

const probe = new CotalEndpoint({ space: SPACE, servers, card: { name: "Probe", kind: "agent", id: "probe" } });
probe.on("error", () => {});

type Hooks = Awaited<ReturnType<typeof cotal>>;
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
  await probe.start();

  // Asked of the BROKER. A count the emitter reports cannot testify that a frame reached a subject.
  const onSubject = async (): Promise<number> =>
    (await probe.listChannels()).find((x: { channel: string; messages?: number }) => x.channel === CHANNEL)?.messages ?? 0;

  hooks = await cotal();
  await sleep(1_500);
  const fire = (event: unknown): Promise<void> => (hooks as unknown as { event: (a: unknown) => Promise<void> }).event({ event });
  const part = (sessionID: string): Promise<void> => fire({ type: "message.part.updated", properties: { part: { sessionID } } });

  // ---- The first session. Its run is left OPEN on purpose: the drain below is what must close it.
  content.set(A, []);
  await fire({ type: "session.created", properties: { info: { id: A } } });
  await sleep(1_500);
  await part(A); // parks the cursor on the near-empty session, as a live one does
  await sleep(1_500);
  content.set(A, turn(A, 1));
  await part(A);
  await sleep(2_500);
  const afterA = await onSubject();
  check("control:the FIRST session's turn reaches the subject", afterA > 0, { afterA });

  // Staged and NOT flushed: the drain must publish it before it closes the run, so this is what
  // separates "flushed then closed" from "closed, dropping what was settled but unsent".
  content.set(A, [...turn(A, 1), ...turn(A, 2)]);

  // ---- `/new`: a second top-level session in the same OpenCode process.
  const beforeNew = await onSubject();
  await fire({ type: "session.created", properties: { info: { id: B } } });
  await sleep(2_000);
  const afterDrain = await onSubject();
  check("reset:the /new drain puts the old session's tail and its close ON THE WIRE",
    afterDrain > beforeNew, { beforeNew, afterDrain });
  check("reset:the emitter did NOT die on the second top-level session",
    !logs.some((l) => l.includes("emitter stopped")), logs.filter((l) => l.includes("emitter stopped")));

  content.set(B, []);
  await part(B);
  await sleep(1_500);
  content.set(B, turn(B, 1));
  await part(B);
  await sleep(2_500);
  const afterB = await onSubject();
  check("reset:the session created by /new PUBLISHES, which is the whole defect",
    afterB > afterDrain, { afterDrain, afterB });

  // ---- A repeated create for the SAME id is not a reset, and a CHILD session is not one either.
  await fire({ type: "session.created", properties: { info: { id: B } } });
  await fire({ type: "session.created", properties: { info: { id: CHILD, parentID: B } } });
  await sleep(1_000);
  content.set(B, [...turn(B, 1), ...turn(B, 2)]);
  await part(B);
  await sleep(2_500);
  const afterRepeat = await onSubject();
  check("reset:a repeated create for the same id and a CHILD session do not break the stream",
    afterRepeat > afterB, { afterB, afterRepeat });
  check("reset:and neither of them killed the emitter either",
    !logs.some((l) => l.includes("emitter stopped")), logs.filter((l) => l.includes("emitter stopped")));

  // ---- Read the whole stream back from the broker and grade it as an ORDER.
  const reader = new CotalEndpoint({
    space: SPACE, servers, card: { name: "Reader", kind: "agent", id: "reader" }, channels: [CHANNEL],
  });
  reader.on("error", () => {});
  const seen: { type: string; thread: string; text: string }[] = [];
  reader.on("message", (m: { channel?: string; parts?: { data?: unknown }[] }) => {
    if (m?.channel !== CHANNEL) return;
    for (const p of m.parts ?? []) {
      const d = (p as { data?: { events?: unknown[] } }).data ?? p;
      for (const e of ((d as { events?: unknown[] }).events ?? []) as Record<string, unknown>[])
        seen.push({ type: String(e.type ?? "?"), thread: String(e.threadId ?? ""), text: String(e.delta ?? "") });
    }
  });
  await reader.start();
  await sleep(3_000);
  await reader.stop().catch(() => {});

  check("control:the stream reads back non-empty, so the order cells below grade something",
    seen.length > 0, { frames: seen.length });

  type Ev = { type: string; thread: string; text: string };
  const first = (pred: (e: Ev) => boolean): number => seen.findIndex(pred);
  const last = (pred: (e: Ev) => boolean): number => seen.reduce((acc, e, i) => (pred(e) ? i : acc), -1);
  // The LAST close of A, not the first. The staged turn opens a run of its own, because a user
  // record closes the run before it and the assistant record after it opens the next one. Two runs
  // for A is the mapper working, so an "exactly once" cell would grade a fiction.
  const lastFinishedA = last((e) => e.type === "RUN_FINISHED" && e.thread === A);
  const firstStartedB = first((e) => e.type === "RUN_STARTED" && e.thread === B);
  const tailA = first((e) => e.text.includes(`answer-${A.slice(-1)}-2`));
  const openedA = seen.filter((e) => e.type === "RUN_STARTED" && e.thread === A).length;
  const closedA = seen.filter((e) => e.type === "RUN_FINISHED" && e.thread === A).length;
  check("order:the old session's LAST run close precedes the new session's FIRST run open",
    lastFinishedA >= 0 && firstStartedB >= 0 && lastFinishedA < firstStartedB, { lastFinishedA, firstStartedB });
  check("order:and the tail it was still holding went out BEFORE that close, not after it",
    tailA >= 0 && lastFinishedA >= 0 && tailA < lastFinishedA, { tailA, lastFinishedA });
  check("order:every run the first session OPENED was closed, so the observer holds none dangling",
    openedA > 0 && openedA === closedA, { openedA, closedA });
  check("thread:the two sessions publish under DIFFERENT thread ids on the one subject",
    seen.some((e) => e.thread === A) && seen.some((e) => e.thread === B), {
      a: seen.filter((e) => e.thread === A).length, b: seen.filter((e) => e.thread === B).length,
    });
  check("thread:and no frame carries the child session, which is not a top-level session",
    !seen.some((e) => e.thread === CHILD), seen.filter((e) => e.thread === CHILD).length);

  // ---- Cell count, because a harness that threw early would DELETE cells rather than fail them.
  const EXPECTED = 12;
  check(`every cell ran - ${EXPECTED} expected, a cell that vanishes is invisible without this`,
    pass + fail === EXPECTED, `${pass + fail} cells reported`);

  console.log(`opencode-events-reset smoke: ${pass} passed, ${fail} failed`);
} finally {
  await hooks?.dispose?.();
  await probe.stop().catch(() => {});
  oc.close();
  broker.kill("SIGKILL");
  await sleep(150);
  rmSync(dir, { recursive: true, force: true });
  releaseBroker();
}
assert.ok(true);
process.exit(fail === 0 ? 0 : 1);
