/**
 * A FAILED CLAUDE TURN MUST NOT BE PUBLISHED AS A FINISHED ONE (#596).
 *
 * **THE DEFECT.** Claude Code ends a turn on one of two hooks, and it picks between them itself:
 * `Stop` when the model finished responding, `StopFailure` when the turn died on an API error. The
 * connector registers both (`hooks/hooks.json`) and used to handle them in ONE arm, closing the run
 * the same way for each — so a turn killed by `rate_limit`, `billing_error` or `server_error` was
 * published as `RUN_FINISHED`, byte-identical to a turn that succeeded. `RUN_ERROR` is in the
 * vocabulary, the bracket machine accepts it as a close and the dashboard renders it with its code;
 * the shared close path simply had no way to say it.
 *
 * **THE HANDLER IS THE SHIPPED ONE AND THE BROKER IS REAL.** `createClaudeHandle` from `src` runs
 * against a real `nats-server`, over a real `AguiEmitterHolder` reading a real transcript file
 * through a real write-ahead log — the holder is assembled here exactly as `mcp.ts` assembles it.
 * Every claim below is read back OFF THE SUBJECT by a second endpoint, because the claim is about
 * what an observer of the channel sees, in order.
 *
 * **WHAT WOULD MAKE THIS THE WRONG EXPERIMENT**, named before the run rather than found after:
 *   - an emitter that never started publishes nothing, and a suite that reads zero everywhere
 *     "confirms" whatever it was pointed at. Both turns' text is graded on its own cell.
 *   - the `StopFailure` payload is the harness's, not this file's invention: `hook_event_name`,
 *     a REQUIRED `error` naming one of eleven failure kinds, and an optional free-text
 *     `error_details`. A fixture that fabricated a different field name would prove the mapping
 *     reads something Claude Code never sends. It is driven here in the shape the harness ships.
 *   - a blanket "the turn ended, so call it an error" would pass every failure cell here and still
 *     be wrong. The `Stop` phase is the positive control for that, and it is why this file drives
 *     two turn-ends rather than one.
 *
 * Run: pnpm smoke:claude-run-error   (needs nats-server on PATH; starts its own broker)
 */
import { strict as assert } from "node:assert";
import { spawn } from "node:child_process";
import { createServer as createNetServer } from "node:net";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, appendFileSync } from "node:fs";
import { once } from "node:events";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { CotalEndpoint, seedChannelRegistry, isReachable, principalKey } from "@cotal-ai/core";
import {
  MeshAgent,
  configFromEnv,
  AguiEmitter,
  AguiEmitterHolder,
  JsonlFileSource,
  EventWal,
  FileSubjectFrontier,
  ensureEventWalDir,
  resolveEventsStateRoot,
  type HookEvent,
} from "@cotal-ai/connector-core";
import { createClaudeMapper, type ClaudeEntry, type ClaudeMapper } from "../src/agui-map.js";
import { createClaudeHandle } from "../src/hooks.js";
import { SMOKE_BROKER_TOKEN, teardownOnSignal } from "@cotal-ai/smoke-kit";

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
const SPACE = "ccrunerr";
// The identity the session authenticates as decides the subject, so the channel is named from it.
const CHANNEL = "events.local.cass";
const THREAD = "sess-run-error";

const dir = mkdtempSync(join(tmpdir(), SMOKE_BROKER_TOKEN));
mkdirSync(join(dir, "ws"), { recursive: true });
const transcript = join(dir, `${THREAD}.jsonl`);
writeFileSync(transcript, "");
const broker = spawn("nats-server", ["-js", "-p", String(PORT), "-sd", join(dir, "js")], { stdio: "ignore" });
const releaseBroker = teardownOnSignal(broker, dir);

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

/** One turn, in the transcript's own shape. The assistant text carries the turn number so a cell can
 *  LOCATE one turn in the replayed stream instead of counting and hoping. */
function turn(n: number): string {
  const u = `u-${n}`;
  const a = `a-${n}`;
  return (
    JSON.stringify({
      type: "user",
      uuid: u,
      sessionId: THREAD,
      timestamp: new Date(1_700_000_000_000 + n * 1000).toISOString(),
      origin: { kind: "human" },
      message: { content: `prompt ${n}` },
    }) +
    "\n" +
    JSON.stringify({
      type: "assistant",
      uuid: a,
      sessionId: THREAD,
      timestamp: new Date(1_700_000_000_000 + n * 1000 + 1).toISOString(),
      message: { id: `msg-${n}`, content: [{ type: "text", text: `answer-${n}` }] },
    }) +
    "\n"
  );
}

// The connector reads its identity from COTAL_* env. Scrub what this process inherited: a live
// seat's creds would point these cells at someone else's broker.
for (const k of Object.keys(process.env)) if (k.startsWith("COTAL_")) delete process.env[k];
Object.assign(process.env, {
  COTAL_NAME: "Cass",
  COTAL_ID: "cass",
  COTAL_SPACE: SPACE,
  COTAL_SERVERS: servers,
  COTAL_ROLE: "generalist",
  COTAL_EVENTS: "1",
  COTAL_WORKSPACE_ROOT: join(dir, "ws"),
});

const config = configFromEnv();
config.connector = "claude";
const agent = new MeshAgent(config);
agent.on?.("error", () => {});

// The holder, ASSEMBLED AS `mcp.ts` ASSEMBLES IT. Copied rather than imported because `mcp.ts` is a
// process entry point that owns a control server and an MCP transport; what is under test is the
// hook arm above it, and the seam between them is this object.
let mapper: ClaudeMapper | undefined;
const events = new AguiEmitterHolder<ClaudeEntry>(
  async (transcriptPath: string) => {
    const workspaceRoot = resolveEventsStateRoot(process.env);
    const threadId = THREAD;
    const principal = principalKey(agent.ep.principal.owner, agent.ep.principal.actor).key;
    const { walPath, subjectPath } = await ensureEventWalDir({ workspaceRoot, space: config.space, principal, threadId });
    const subjectFrontier = await FileSubjectFrontier.open(subjectPath, { space: config.space, principal });
    const wal = await EventWal.open(walPath, { space: config.space, threadId, principal, subjectMayExist: false });
    mapper = createClaudeMapper({ threadId, mintRunId: () => randomUUID() });
    return AguiEmitter.start<ClaudeEntry>({
      endpoint: agent.ep,
      wal,
      subjectFrontier,
      source: new JsonlFileSource<ClaudeEntry>(transcriptPath),
      map: mapper.map,
    });
  },
  (e: Error) => console.log(`  [emitter stopped] ${e.message}`),
  (runId: string) => mapper?.forgetOpenRun(runId),
);

const claude = createClaudeHandle({ events: () => events });

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
  agent.start();
  await sleep(2_000);

  const hook = (ev: Record<string, unknown>): Promise<unknown> =>
    claude.handle(agent, { transcript_path: transcript, ...ev } as HookEvent);

  // PARK FIRST, ON AN EMPTY TRANSCRIPT, AND THAT IS PRODUCTION ORDER RATHER THAN A TEST TRICK.
  // `adopt` does not read; the FIRST pump is what parks the cursor at the current end of the file.
  // In a live session `UserPromptSubmit` fires BEFORE the harness writes the turn's first record, so
  // the park lands on an empty file. A harness that appended first would park past its own fixture
  // and read zero everywhere — which is exactly what the first draft of this file did, and the
  // `control:` cell below is what caught it.
  await hook({ hook_event_name: "UserPromptSubmit" });
  await sleep(1_500);

  // ---- Turn 1: a real turn, then the API error that killed it. `StopFailure` in the harness's own
  //      payload shape: a required `error` naming the kind, plus optional free-text detail.
  appendFileSync(transcript, turn(1));
  await hook({
    hook_event_name: "StopFailure",
    error: "rate_limit",
    error_details: "Claude AI usage limit reached",
  });
  await sleep(2_000);

  // ---- Turn 2: a real turn that ENDS NORMALLY. The control that says the mapping is not blanket.
  appendFileSync(transcript, turn(2));
  await hook({ hook_event_name: "Stop" });
  await sleep(2_000);
  await events.settled();

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
  const normalTurnCloses = closesBetween(a2, -1);

  check("fail:the StopFailure turn closed EXACTLY ONCE — `RUN_ERROR` closes a run, so nothing may follow it",
    failedTurnCloses.length === 1, failedTurnCloses);
  check("fail:and that close is RUN_ERROR, not RUN_FINISHED — THE DEFECT",
    failedTurnCloses[0]?.type === "RUN_ERROR", failedTurnCloses[0]);
  check("fail:the RUN_ERROR carries the harness's detail as the message and its error kind as the code",
    failedTurnCloses[0]?.message === "Claude AI usage limit reached" && failedTurnCloses[0]?.code === "rate_limit",
    failedTurnCloses[0]);

  check("stop:the normally-ended turn closed exactly once", normalTurnCloses.length === 1, normalTurnCloses);
  check("stop:and THAT close is RUN_FINISHED — `Stop` is not a failure, and a blanket mapping would fail here",
    normalTurnCloses[0]?.type === "RUN_FINISHED", normalTurnCloses[0]);

  // ---- Cell count, because a harness that threw early would DELETE cells rather than fail them.
  const EXPECTED = 7;
  check(`every cell ran - ${EXPECTED} expected, a cell that vanishes is invisible without this`,
    pass + fail === EXPECTED, `${pass + fail} cells reported`);

  console.log(`claude-run-error smoke: ${pass} passed, ${fail} failed`);
} finally {
  await agent.stop?.().catch?.(() => {});
  broker.kill("SIGKILL");
  await sleep(150);
  rmSync(dir, { recursive: true, force: true });
  releaseBroker();
}
assert.ok(true);
process.exit(fail === 0 ? 0 : 1);
