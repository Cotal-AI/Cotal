/**
 * THE EGRESS FENCE MUST REFUSE UNKNOWN PROPERTIES ON A FRAME ENVELOPE.
 *
 * Issue #1432: the AG-UI egress fence checked only `.events[].type`, so tool bytes on a sibling
 * property of the event, on an unknown top-level property, or nested inside an allowed event's
 * unknown field all published untouched. The fence now validates the whole envelope against a
 * closed schema (known frame-level keys, known per-event keys per type) and refuses any envelope
 * with an unknown or extra property, naming the path.
 *
 * THREE ATTACK VECTORS, THREE CELLS:
 * 1. Sibling property at frame level (`recovery: { type: "TOOL_CALL_RESULT", content: "<bytes>" }`)
 * 2. Unknown top-level property (`smuggled: "secret"`)
 * 3. Unknown field nested inside an allowed event (`events[0].leaked: "<bytes>"`)
 *
 * POSITIVE CONTROLS:
 * - A well-formed frame with only known keys passes.
 * - A well-formed frame with `cotal` metadata on events passes.
 * - A JSON-round-tripped frame passes (simulating WAL recovery).
 * - `frozenBodyEgressVerdict` returns `"forbidden-kind"` for in-events TOOL_CALL_RESULT (existing
 *   behaviour preserved).
 *
 * THE COORDINATE IS `frozenBodyEgressVerdict` AND `extraPropertyPath`. The verdict is what
 * `AguiEmitter.attempt()` uses to decide whether to publish. `extraPropertyPath` is the function
 * that identifies the first unknown property and returns its dotted path.
 *
 * RECOVERY CELL: an `AguiEmitter.start()` against a WAL with a `sent_unacked` body carrying a
 * sibling property must halt with `egress-extra-property`, not republish.
 *
 * Run: pnpm smoke:agui-egress-closed-schema
 */
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eventChannel, type Part } from "@cotal-ai/core";
import { memorySubjectFrontier } from "@cotal-ai/smoke-kit";
import {
  AguiEmitter,
  AguiEmitterHalted,
  aguiFrame,
  extraPropertyPath,
  frozenBodyEgressVerdict,
  type FrozenBodyEgressVerdict,
  isAguiFramePart,
  parseAguiFrame,
  runStarted,
  runFinished,
  textMessageContent,
  textMessageEnd,
  textMessageStart,
  toolCallEnd,
  toolCallStart,
  type AguiEvent,
  type RecordMapper,
} from "../src/agui.js";
import { JsonlFileSource } from "../src/durable-source.js";
import { EventWal } from "../src/event-wal.js";
import { createClaudeMapper, type ClaudeEntry } from "../../connector-claude-code/src/agui-map.js";

let pass = 0;
let fail = 0;
const c = (n: string, v: boolean, extra?: unknown): void => {
  if (v) {
    pass += 1;
    return;
  }
  fail += 1;
  console.error(`  x FAIL: ${n}${extra === undefined ? "" : ` ${JSON.stringify(extra)}`}`);
};

const PRINCIPAL = { owner: "local", actor: "aaa" };
const PRINCIPAL_KEY = "local.aaa";
const SPACE = "main";
const THREAD = "thread-1";
const CHANNEL = eventChannel(PRINCIPAL);

const SIBLING_TOOL_BYTES = "SYNTHETIC-PLACEHOLDER-1432-SIBLING-TOOL-BYTES-NOT-A-SECRET";
const SMUGGLED_SECRET = "SYNTHETIC-PLACEHOLDER-1432-SMUGGLED-SECRET-NOT-A-SECRET";
const NESTED_TOOL_BYTES = "SYNTHETIC-PLACEHOLDER-1432-NESTED-TOOL-BYTES-NOT-A-SECRET";

interface Call {
  id: string;
  expectedLastSubjectSeq: number;
  parts: Part[];
  channel: string;
}

class FakeEndpoint {
  readonly principal = PRINCIPAL;
  readonly actorIsEphemeral = false;
  maxPayload = 65536;
  preflightCalls = 0;
  publishes: Call[] = [];
  answers: ({ seq: number; duplicate: boolean } | Error)[] = [];
  async assertExpectationSemantics(): Promise<void> {
    this.preflightCalls += 1;
  }
  encodedSize(o: { channel: string; parts: Part[]; id: string; expectedLastSubjectSeq: number }): number {
    return Buffer.byteLength(JSON.stringify(o), "utf8") + 64;
  }
  async multicastExpecting(o: {
    channel: string;
    parts: Part[];
    id: string;
    expectedLastSubjectSeq: number;
  }): Promise<{ ack: { seq: number; duplicate: boolean } }> {
    this.publishes.push({
      id: o.id,
      expectedLastSubjectSeq: o.expectedLastSubjectSeq,
      parts: o.parts,
      channel: o.channel,
    });
    const a = this.answers.shift() ?? { seq: this.publishes.length, duplicate: false };
    if (a instanceof Error) throw a;
    return { ack: a };
  }
}

const dir = mkdtempSync(join(tmpdir(), "agui-egress-closed-schema-"));
let n = 0;

const attempt = async <T>(fn: () => Promise<T>): Promise<{ value?: T; err?: Error }> => {
  try {
    return { value: await fn() };
  } catch (e) {
    return { err: e as Error };
  }
};

const fresh = async (name: string) => {
  const d = join(dir, `${++n}-${name}`);
  const src = join(d, "session.jsonl");
  const walPath = join(d, "wal.json");
  mkdirSync(d, { recursive: true });
  writeFileSync(src, "");
  const wal = await EventWal.open(walPath, {
    space: SPACE,
    threadId: THREAD,
    principal: PRINCIPAL_KEY,
    subjectMayExist: false,
  });
  return { d, src, walPath, wal, source: new JsonlFileSource<unknown>(src) };
};

const append = (path: string, ...recs: unknown[]) => {
  writeFileSync(path, recs.map((r) => JSON.stringify(r)).join("\n") + "\n", { flag: "a" });
};

const publishedWire = (ep: FakeEndpoint): string => JSON.stringify(ep.publishes);

try {
  // ── DIRECT VERDICT CELLS ────────────────────────────────────────────────────

  // 1. Sibling property at frame level carrying tool bytes
  {
    const frame = {
      kind: "ag-ui.frame" as const,
      protocol: "ag-ui/0.0.57",
      threadId: "t1",
      runId: "r1",
      epoch: "e1",
      seq: 0,
      events: [{ type: "RUN_STARTED", threadId: "t1", runId: "r1", timestamp: 1 }],
      recovery: { type: "TOOL_CALL_RESULT", content: SIBLING_TOOL_BYTES },
    };
    const verdict = frozenBodyEgressVerdict([frame]);
    c("closed-schema:sibling-property frame-level tool bytes are refused", verdict === "extra-property", { verdict });
    const path = extraPropertyPath(frame as Record<string, unknown>);
    c("closed-schema:sibling-property path names 'recovery'", path === "recovery", { path });
  }

  // 2. Unknown top-level property
  {
    const frame = {
      kind: "ag-ui.frame" as const,
      protocol: "ag-ui/0.0.57",
      threadId: "t1",
      runId: "r1",
      epoch: "e1",
      seq: 0,
      events: [{ type: "RUN_STARTED", threadId: "t1", runId: "r1", timestamp: 1 }],
      smuggled: SMUGGLED_SECRET,
    };
    const verdict = frozenBodyEgressVerdict([frame]);
    c("closed-schema:unknown-top-level property is refused", verdict === "extra-property", { verdict });
    const path = extraPropertyPath(frame as Record<string, unknown>);
    c("closed-schema:unknown-top-level path names 'smuggled'", path === "smuggled", { path });
  }

  // 3. Unknown field nested inside an allowed event
  {
    const frame = {
      kind: "ag-ui.frame" as const,
      protocol: "ag-ui/0.0.57",
      threadId: "t1",
      runId: "r1",
      epoch: "e1",
      seq: 0,
      events: [{
        type: "RUN_STARTED",
        threadId: "t1",
        runId: "r1",
        timestamp: 1,
        leaked: { type: "TOOL_CALL_RESULT", content: NESTED_TOOL_BYTES },
      }],
    };
    const verdict = frozenBodyEgressVerdict([frame]);
    c("closed-schema:nested-event-field tool bytes are refused", verdict === "extra-property", { verdict });
    const path = extraPropertyPath(frame as Record<string, unknown>);
    c("closed-schema:nested-event-field path names 'events[0].leaked'", path === "events[0].leaked", { path });
  }

  // ── POSITIVE CONTROLS ──────────────────────────────────────────────────────

  // Well-formed frame with only known keys
  {
    const frame = aguiFrame({
      threadId: "t1", runId: "r1", epoch: "e1", seq: 0,
      events: [runStarted({ threadId: "t1", runId: "r1", timestamp: 1 })],
    });
    c("control:well-formed-lifecycle frame passes", frozenBodyEgressVerdict([frame]) === "clean");
  }

  // Well-formed frame with text events
  {
    const frame = aguiFrame({
      threadId: "t1", runId: "r1", epoch: "e1", seq: 1,
      events: [
        textMessageStart({ messageId: "m1", timestamp: 2 }),
        textMessageContent({ messageId: "m1", delta: "hello", timestamp: 3 }),
        textMessageEnd({ messageId: "m1", timestamp: 4 }),
      ],
    });
    c("control:well-formed-text frame passes", frozenBodyEgressVerdict([frame]) === "clean");
  }

  // Well-formed frame with cotal metadata
  {
    const frame = aguiFrame({
      threadId: "t1", runId: "r1", epoch: "e1", seq: 2,
      events: [runStarted({ threadId: "t1", runId: "r1", timestamp: 5, cotal: { tsSource: "arrival" } })],
    });
    c("control:frame-with-cotal-metadata passes", frozenBodyEgressVerdict([frame]) === "clean");
  }

  // JSON-round-tripped frame (WAL recovery simulation)
  {
    const live = aguiFrame({
      threadId: "t1", runId: "r1", epoch: "e1", seq: 3,
      events: [runStarted({ threadId: "t1", runId: "r1", timestamp: 6 })],
    });
    const rtFrame = JSON.parse(JSON.stringify(live));
    c("control:json-round-tripped frame passes", frozenBodyEgressVerdict([rtFrame]) === "clean");
  }

  // Existing behaviour: in-events forbidden kind still returns "forbidden-kind"
  {
    const frame = {
      kind: "ag-ui.frame" as const,
      protocol: "ag-ui/0.0.57",
      threadId: "t1",
      runId: "r1",
      epoch: "e1",
      seq: 0,
      events: [{ type: "TOOL_CALL_RESULT", messageId: "m", toolCallId: "t", content: "x", timestamp: 1 }],
    };
    c("control:in-events-forbidden-kind still returns forbidden-kind", frozenBodyEgressVerdict([frame]) === "forbidden-kind");
  }

  // Well-formed frame with tool call (start/end, no args/result)
  {
    const frame = aguiFrame({
      threadId: "t1", runId: "r1", epoch: "e1", seq: 4,
      events: [
        toolCallStart({ toolCallId: "tc1", toolCallName: "read", timestamp: 7 }),
        toolCallEnd({ toolCallId: "tc1", timestamp: 8 }),
      ],
    });
    c("control:tool-call-start-end (no args/result) passes", frozenBodyEgressVerdict([frame]) === "clean");
  }

  // Well-formed frame with rawEvent field (AG-UI schema key)
  {
    const frame = {
      kind: "ag-ui.frame" as const,
      protocol: "ag-ui/0.0.57",
      threadId: "t1",
      runId: "r1",
      epoch: "e1",
      seq: 0,
      events: [{ type: "RUN_STARTED", threadId: "t1", runId: "r1", timestamp: 1, rawEvent: { foo: "bar" } }],
    };
    c("control:event-with-rawEvent (AG-UI schema key) passes", frozenBodyEgressVerdict([frame]) === "clean");
  }

  // Well-formed frame with runFinished outcome
  {
    const frame = aguiFrame({
      threadId: "t1", runId: "r1", epoch: "e1", seq: 5,
      events: [runFinished({ threadId: "t1", runId: "r1", timestamp: 9, outcome: { type: "success" } })],
    });
    c("control:runFinished-with-outcome passes", frozenBodyEgressVerdict([frame]) === "clean");
  }

  // ── RECOVERY CELL ──────────────────────────────────────────────────────────
  // An AguiEmitter.start() against a WAL with a sent_unacked body carrying a
  // sibling property must halt with egress-extra-property, not republish.
  {
    const { wal, walPath, source, src } = await fresh("recover-extra-prop");
    const sf = memorySubjectFrontier();
    await wal.bindSubjectFrontier(sf);

    // Write a WAL entry with a sent_unacked body carrying an extra property.
    const body: Part[] = [
      {
        kind: "ag-ui.frame",
        protocol: "ag-ui/0.0.57",
        threadId: THREAD,
        runId: "run-recover",
        epoch: wal.epoch,
        seq: 0,
        events: [{ type: "RUN_STARTED", threadId: THREAD, runId: "run-recover", timestamp: 1 }],
        recovery: { type: "TOOL_CALL_RESULT", content: SIBLING_TOOL_BYTES },
      } as unknown as Part,
    ];
    await wal.beginSend({
      id: "recover-extra-1",
      E: 0,
      seq: 1,
      sourceCursor: "1:2:0:0000000000000000",
      body,
      brackets: { run: "run-recover", text: [], reasoning: [], tools: [] },
    });
    // Close and reopen the WAL to simulate restart.
    const wal2 = await EventWal.open(walPath, {
      space: SPACE,
      threadId: THREAD,
      principal: PRINCIPAL_KEY,
      subjectMayExist: true,
    });
    c("recover:pending.state is sent_unacked before start", wal2.pending?.state === "sent_unacked", wal2.pending?.state);
    const ep = new FakeEndpoint();
    const map: RecordMapper<unknown> = () => null;
    const started = await attempt(() =>
      AguiEmitter.start({ endpoint: ep, wal: wal2, subjectFrontier: sf, source, map }),
    );
    c(
      "recover:AguiEmitter.start halts with egress-extra-property for frozen sibling-property body",
      started.err instanceof AguiEmitterHalted && started.err.reason === "egress-extra-property",
      { err: started.err?.message, reason: started.err instanceof AguiEmitterHalted ? started.err.reason : undefined },
    );
    c(
      "recover:sibling tool bytes do NOT reach the wire",
      !publishedWire(ep).includes(SIBLING_TOOL_BYTES),
    );
  }

  console.log(`agui-egress-closed-schema smoke: ${pass} passed, ${fail} failed`);
  if (fail > 0) process.exit(1);
} catch (e) {
  console.error("FATAL:", e);
  process.exit(1);
} finally {
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
}
