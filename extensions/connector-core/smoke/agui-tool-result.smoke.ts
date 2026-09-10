/**
 * THE EVENTS PLANE MUST NOT REPUBLISH TOOL-CALL CONTENT.
 *
 * `events.<owner>.<actor>` carries a different read ACL from the channel a mesh read tool ran on.
 * TOOL_CALL_ARGS and TOOL_CALL_RESULT copy tool inputs and outputs onto that channel unredacted.
 * Issue #695 is that class. Fail closed: suppress both kinds at the emitter, before beginSend, and
 * refuse to republish a frozen pre-fix body that still carries them.
 *
 * **THIS SUITE OBSERVES THE RECORDED PUBLISH.** What FakeEndpoint.multicastExpecting was handed,
 * not the mapper's return and not the WAL body. The mapper's return is upstream of recover()'s
 * bypass. The WAL body is frozen pre-policy by design. The publish is the only coordinate where
 * recover()'s bypass and the write path are both visible, and where nothing downstream can rebuild
 * a clean value. A cell on the mapper would pass with the bypass wide open. That is why PR #1415's
 * two mutation kills proved the suite depended on the mutated lines rather than that a live entry
 * point reached them.
 *
 * **SIX CARRIERS, SIX CELLS.** Codex args, Codex result, Claude args, Claude result, OpenCode args,
 * OpenCode result. One OpenCode tool part produces both kinds, which is the honest reproduction;
 * the assertions still fail independently: each cell searches for THAT carrier's own mark. A
 * one-line policy change that reopens only args reddens only the three args cells.
 *
 * **THE RECOVERY CELL DRIVES `AguiEmitter.start()`.** Constructor is private; `start` is static
 * async. A suite that only pumps cannot see recover()'s verbatim republish of a sent_unacked body.
 *
 * **THE NEGATIVE CONTROL IS ALSO ON THE PUBLISH.** A mixed unit of sibling text plus a tool result
 * must still publish the text (lifecycle survived the policy) and must not publish the result mark.
 * A pass cannot mean "something downstream re-added the text".
 *
 * The `agui-tool-result` smoke suite shape and its mutation-config idea originate in PR #1415.
 * This file carries that lineage onto the class (six carriers + recover) rather than reinventing it.
 *
 * Synthetic placeholders only. No live ACL crossing.
 *
 * Run: pnpm smoke:agui-tool-result
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
  applyAguiEgressPolicy,
  frozenBodyEgressVerdict,
  type FrozenBodyEgressVerdict,
  isAguiFramePart,
  parseAguiFrame,
  runStarted,
  textMessageContent,
  textMessageEnd,
  textMessageStart,
  toolCallEnd,
  toolCallResult,
  toolCallStart,
  type AguiEvent,
  type RecordMapper,
} from "../src/agui.js";
import { JsonlFileSource } from "../src/durable-source.js";
import { EventWal } from "../src/event-wal.js";
import { createClaudeMapper, type ClaudeEntry } from "../../connector-claude-code/src/agui-map.js";
import { createCodexMapper, type CodexRecord } from "../../connector-codex/src/agui-map.js";
import { createOpenCodeMapper } from "../../connector-opencode/src/agui-map.js";
import type { OpenCodeRecord } from "../../connector-opencode/src/agui-source.js";

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

const CLAUDE_ARGS = "SYNTHETIC-PLACEHOLDER-695-CLAUDE-ARGS-NOT-A-SECRET";
const CLAUDE_RESULT = "SYNTHETIC-PLACEHOLDER-695-CLAUDE-RESULT-NOT-A-SECRET";
const CODEX_ARGS = "SYNTHETIC-PLACEHOLDER-695-CODEX-ARGS-NOT-A-SECRET";
const CODEX_RESULT = "SYNTHETIC-PLACEHOLDER-695-CODEX-RESULT-NOT-A-SECRET";
const OC_ARGS = "SYNTHETIC-PLACEHOLDER-695-OC-ARGS-NOT-A-SECRET";
const OC_RESULT = "SYNTHETIC-PLACEHOLDER-695-OC-RESULT-NOT-A-SECRET";
const RECOVER_RESULT = "SYNTHETIC-PLACEHOLDER-695-RECOVER-RESULT-NOT-A-SECRET";
const SIBLING_TEXT = "SYNTHETIC-PLACEHOLDER-695-SIBLING-TEXT-MUST-SURVIVE";
const DROPPED_SECRET = "SYNTHETIC-PLACEHOLDER-695-ALREADY-DROPPED-NOT-A-SECRET";

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

const dir = mkdtempSync(join(tmpdir(), "agui-tool-result-"));
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

const publishedEvents = (ep: FakeEndpoint): AguiEvent[] => {
  const out: AguiEvent[] = [];
  for (const p of ep.publishes) {
    for (const part of p.parts) {
      if (!isAguiFramePart(part)) continue;
      out.push(...parseAguiFrame(part).events);
    }
  }
  return out;
};

const typesOf = (ep: FakeEndpoint): string[] => publishedEvents(ep).map((e) => e.type);

/**
 * Adopt an empty source first, then append, then pump. A first pump on a file that already
 * contains records is an adopt-from-end and publishes nothing. That is not this suite's
 * coordinate.
 */
const drive = async (name: string, map: RecordMapper<unknown>, recs: unknown[]) => {
  const { wal, source, src } = await fresh(name);
  const ep = new FakeEndpoint();
  const started = await attempt(() =>
    AguiEmitter.start({ endpoint: ep, wal, subjectFrontier: memorySubjectFrontier(), source, map }),
  );
  if (started.err || started.value === undefined) {
    return { ep, started, pumped: { err: started.err }, wire: "[]", types: [] as string[] };
  }
  const adopt = await attempt(() => started.value!.pump());
  if (adopt.err) {
    return { ep, started, pumped: adopt, wire: publishedWire(ep), types: typesOf(ep) };
  }
  append(src, ...recs);
  const pumped = await attempt(() => started.value!.pump());
  return { ep, started, pumped, wire: publishedWire(ep), types: typesOf(ep) };
};

try {
  // Equivalence the chokepoint rests on: a live frame and a JSON-round-tripped WAL body expose
  // the same `.events[].type` discriminator to parseAguiFrame. Measured here, not reasoned.
  {
    const live = aguiFrame({
      threadId: THREAD,
      runId: "run-eq",
      epoch: "epoch-eq",
      seq: 1,
      events: [
        runStarted({ threadId: THREAD, runId: "run-eq", timestamp: 1 }),
        toolCallResult({
          messageId: "m",
          toolCallId: "t",
          content: RECOVER_RESULT,
          timestamp: 1,
        }),
      ],
    });
    const roundTrippedPart = JSON.parse(JSON.stringify(live)) as unknown;
    const liveTypes = parseAguiFrame(live).events.map((e) => e.type);
    const rtTypes = parseAguiFrame(roundTrippedPart).events.map((e) => e.type);
    c(
      "chokepoint:parseAguiFrame reads TOOL_CALL_RESULT off a live frame AND off a JSON-round-tripped body",
      liveTypes.includes("TOOL_CALL_RESULT") &&
        rtTypes.includes("TOOL_CALL_RESULT") &&
        liveTypes.join(",") === rtTypes.join(","),
    );
    c(
      "chokepoint:CONTROL-a-frame-with-only-lifecycle-does-not-violate",
      frozenBodyEgressVerdict([
        aguiFrame({
          threadId: THREAD,
          runId: "run-eq-2",
          epoch: "epoch-eq",
          seq: 1,
          events: [runStarted({ threadId: THREAD, runId: "run-eq-2", timestamp: 1 })],
        }),
      ]) === "clean",
    );
  }

  // ── CLAUDE ARGS ──────────────────────────────────────────────────────────────────────────────
  {
    let i = 0;
    const mapper = createClaudeMapper({ threadId: THREAD, mintRunId: () => `run-ca-${++i}` });
    const { ep, pumped, wire, types } = await drive("claude-args", mapper.map, [
      {
        uuid: "ca-prompt",
        type: "user",
        timestamp: "2026-08-15T00:00:00.000Z",
        origin: { kind: "human" },
        message: { role: "user", content: "look" },
      } satisfies Partial<ClaudeEntry>,
      {
        uuid: "ca-tool",
        type: "assistant",
        timestamp: "2026-08-15T00:00:01.000Z",
        message: {
          role: "assistant",
          content: [{ type: "tool_use", id: "t-ca", name: "Read", input: { path: CLAUDE_ARGS } }],
        },
      } satisfies Partial<ClaudeEntry>,
    ]);
    c("carrier:claude-args mark is absent from the recorded publish", !wire.includes(CLAUDE_ARGS), {
      types,
      channel: ep.publishes[0]?.channel,
      err: pumped.err?.message,
    });
    c(
      "carrier:claude-args CONTROL the publish is on events.local.aaa",
      ep.publishes.length > 0 && ep.publishes.every((p) => p.channel === CHANNEL),
    );
    c(
      "carrier:claude-args CONTROL TOOL_CALL_START and END still published",
      types.includes("TOOL_CALL_START") && types.includes("TOOL_CALL_END") && !types.includes("TOOL_CALL_ARGS"),
      types,
    );
  }

  // ── CLAUDE RESULT ────────────────────────────────────────────────────────────────────────────
  {
    let i = 0;
    const mapper = createClaudeMapper({ threadId: THREAD, mintRunId: () => `run-cr-${++i}` });
    const { pumped, wire, types } = await drive("claude-result", mapper.map, [
      {
        uuid: "cr-prompt",
        type: "user",
        timestamp: "2026-08-15T00:00:00.000Z",
        origin: { kind: "human" },
        message: { role: "user", content: "look" },
      } satisfies Partial<ClaudeEntry>,
      {
        uuid: "cr-tool",
        type: "assistant",
        timestamp: "2026-08-15T00:00:01.000Z",
        message: {
          role: "assistant",
          content: [{ type: "tool_use", id: "t-cr", name: "Read", input: { path: "x" } }],
        },
      } satisfies Partial<ClaudeEntry>,
      {
        uuid: "cr-result",
        type: "user",
        timestamp: "2026-08-15T00:00:02.000Z",
        message: { role: "user", content: [{ type: "tool_result", tool_use_id: "t-cr", content: CLAUDE_RESULT }] },
      } satisfies Partial<ClaudeEntry>,
    ]);
    c("carrier:claude-result mark is absent from the recorded publish", !wire.includes(CLAUDE_RESULT), {
      types,
      err: pumped.err?.message,
    });
    c(
      "carrier:claude-result CONTROL TOOL_CALL_RESULT is not on the publish",
      !types.includes("TOOL_CALL_RESULT"),
      types,
    );
  }

  // ── CODEX ARGS ───────────────────────────────────────────────────────────────────────────────
  {
    const mapper = createCodexMapper({ threadId: THREAD, mintRunId: () => "run-xa" });
    const ts = "2026-08-15T00:00:00.000Z";
    const { pumped, wire, types } = await drive("codex-args", mapper.map, [
      { timestamp: ts, type: "event_msg", payload: { type: "task_started", turn_id: "t1" } } satisfies CodexRecord,
      {
        timestamp: ts,
        type: "response_item",
        payload: { type: "function_call", call_id: "call-xa", name: "shell", arguments: `{"cmd":"${CODEX_ARGS}"}` },
      } satisfies CodexRecord,
    ]);
    c("carrier:codex-args mark is absent from the recorded publish", !wire.includes(CODEX_ARGS), {
      types,
      err: pumped.err?.message,
    });
    c(
      "carrier:codex-args CONTROL TOOL_CALL_START and END still published",
      types.includes("TOOL_CALL_START") && types.includes("TOOL_CALL_END") && !types.includes("TOOL_CALL_ARGS"),
      types,
    );
  }

  // ── CODEX RESULT ─────────────────────────────────────────────────────────────────────────────
  {
    const mapper = createCodexMapper({ threadId: THREAD, mintRunId: () => "run-xr" });
    const ts = "2026-08-15T00:00:00.000Z";
    const { pumped, wire, types } = await drive("codex-result", mapper.map, [
      { timestamp: ts, type: "event_msg", payload: { type: "task_started", turn_id: "t1" } } satisfies CodexRecord,
      {
        timestamp: ts,
        type: "response_item",
        payload: { type: "function_call", call_id: "call-xr", name: "shell", arguments: "{}" },
      } satisfies CodexRecord,
      {
        timestamp: ts,
        type: "response_item",
        payload: { type: "function_call_output", call_id: "call-xr", output: CODEX_RESULT },
      } satisfies CodexRecord,
    ]);
    c("carrier:codex-result mark is absent from the recorded publish", !wire.includes(CODEX_RESULT), {
      types,
      err: pumped.err?.message,
    });
    c(
      "carrier:codex-result CONTROL TOOL_CALL_RESULT is not on the publish",
      !types.includes("TOOL_CALL_RESULT"),
      types,
    );
  }

  // ── OPENCODE ARGS and RESULT (one tool part, two cells) ──────────────────────────────────────
  {
    let i = 0;
    const mapper = createOpenCodeMapper({ threadId: THREAD, mintRunId: () => `run-oc-${++i}`, now: () => 1 });
    const rec: OpenCodeRecord = {
      message: { id: "m1", role: "assistant", time: { created: 1, completed: 2 } },
      part: {
        id: "p1",
        messageID: "m1",
        type: "tool",
        callID: "call-oc",
        tool: "bash",
        state: { status: "completed", input: { cmd: OC_ARGS }, output: OC_RESULT, time: { start: 1, end: 2 } },
      },
    };
    const { pumped, wire, types } = await drive("opencode", mapper.map, [rec]);
    c("carrier:opencode-args mark is absent from the recorded publish", !wire.includes(OC_ARGS), {
      types,
      err: pumped.err?.message,
    });
    c("carrier:opencode-result mark is absent from the recorded publish", !wire.includes(OC_RESULT), { types });
    c(
      "carrier:opencode CONTROL START/END published, ARGS/RESULT not",
      types.includes("TOOL_CALL_START") &&
        types.includes("TOOL_CALL_END") &&
        !types.includes("TOOL_CALL_ARGS") &&
        !types.includes("TOOL_CALL_RESULT"),
      types,
    );
  }

  // ── RECOVERY: AguiEmitter.start republish of a frozen pre-fix body ───────────────────────────
  {
    const { wal, walPath, source } = await fresh("recover");
    const sf = memorySubjectFrontier();
    await wal.bindSubjectFrontier(sf);
    const frozen = aguiFrame({
      threadId: THREAD,
      runId: "run-frozen",
      epoch: wal.epoch,
      seq: 1,
      events: [
        runStarted({ threadId: THREAD, runId: "run-frozen", timestamp: 1 }),
        toolCallStart({ toolCallId: "tc-frozen", toolCallName: "Read", timestamp: 1 }),
        toolCallEnd({ toolCallId: "tc-frozen", timestamp: 1 }),
        toolCallResult({
          messageId: "res:tc-frozen",
          toolCallId: "tc-frozen",
          content: RECOVER_RESULT,
          timestamp: 1,
        }),
      ],
    });
    await wal.beginSend({
      id: "frozen-id-695",
      E: 0,
      seq: 1,
      sourceCursor: "1:2:0:0000000000000000",
      body: [frozen as unknown as Part],
      brackets: { run: "run-frozen", text: [], reasoning: [], tools: [] },
    });
    const wal2 = await EventWal.open(walPath, {
      space: SPACE,
      threadId: THREAD,
      principal: PRINCIPAL_KEY,
      subjectMayExist: true,
    });
    c("recover:pending.state is sent_unacked before start", wal2.pending?.state === "sent_unacked", wal2.pending?.state);
    const ep = new FakeEndpoint();
    let mapperCalls = 0;
    const map: RecordMapper<unknown> = (rec) => {
      mapperCalls += 1;
      void rec;
      return null;
    };
    const started = await attempt(() =>
      AguiEmitter.start({ endpoint: ep, wal: wal2, subjectFrontier: sf, source, map }),
    );
    const wire = publishedWire(ep);
    const halted = started.err instanceof AguiEmitterHalted ? started.err : undefined;
    c(
      "recover:AguiEmitter.start refuses a frozen TOOL_CALL_RESULT body rather than publishing it",
      halted?.reason === "egress-policy" && ep.publishes.length === 0 && !wire.includes(RECOVER_RESULT),
      {
        reason: halted?.reason,
        publishes: ep.publishes.length,
        mapperCalls,
        err: started.err?.message,
      },
    );
    c("recover:CONTROL mapper was not the filter (mapper_calls=0)", mapperCalls === 0, { mapperCalls });
    c(
      "recover:CONTROL the pending frame is still on disk, not rewritten",
      (await EventWal.open(walPath, {
        space: SPACE,
        threadId: THREAD,
        principal: PRINCIPAL_KEY,
        subjectMayExist: true,
      })).pending?.state === "sent_unacked",
    );
  }

  // ── RECOVERY: a frozen body whose EVENT LIST CANNOT BE READ ──────────────────────────────────
  //
  // The shape a reviewer used to defeat the earlier fail-open fence, reproduced here as a
  // regression guard at the coordinate where it actually leaked. `events` IS the tool bytes, so a
  // scan of `.events[].type` looks in exactly the right place and finds no array. It survives a
  // JSON round-trip, `EventWal` admits any non-empty `pending.body`, and the old fence published it
  // verbatim onto a channel with a different read ACL. Renderers declining to fold it is not the
  // boundary; the wire is.
  //
  // NOT built with `aguiFrame()`, deliberately: that constructor enforces a non-empty events ARRAY
  // at runtime and would refuse this. A body like it can only be frozen by something other than
  // this version's writer, which is the upgrade-across-a-pending-frame case the halt names.
  {
    const { wal, walPath, source } = await fresh("recover-unreadable");
    const sf = memorySubjectFrontier();
    await wal.bindSubjectFrontier(sf);
    const unreadable = {
      kind: "ag-ui.frame",
      protocol: "ag-ui/0.0.57",
      threadId: THREAD,
      runId: "run-unreadable",
      epoch: wal.epoch,
      seq: 1,
      events: `TOOL_CALL_RESULT: ${RECOVER_RESULT}`,
    };
    await wal.beginSend({
      id: "frozen-unreadable-695",
      E: 0,
      seq: 1,
      sourceCursor: "1:2:0:0000000000000000",
      body: [JSON.parse(JSON.stringify(unreadable)) as Part],
      brackets: { run: "run-unreadable", text: [], reasoning: [], tools: [] },
    });
    const wal2 = await EventWal.open(walPath, {
      space: SPACE,
      threadId: THREAD,
      principal: PRINCIPAL_KEY,
      subjectMayExist: true,
    });
    const ep = new FakeEndpoint();
    const started = await attempt(() =>
      AguiEmitter.start({ endpoint: ep, wal: wal2, subjectFrontier: sf, source, map: () => null }),
    );
    const wire = publishedWire(ep);
    const halted = started.err instanceof AguiEmitterHalted ? started.err : undefined;
    c(
      "recover:an UNREADABLE frozen event list HALTS by name rather than publishing opaque bytes",
      halted?.reason === "egress-unreadable" && ep.publishes.length === 0,
      { reason: halted?.reason, publishes: ep.publishes.length, err: started.err?.message },
    );
    c(
      "recover:the tool bytes carried in that event list never reached the wire",
      !wire.includes(RECOVER_RESULT),
      { wire: wire.slice(0, 200) },
    );
    c(
      "recover:CONTROL the halt is NOT the generic egress-policy one, so the diagnosis is specific",
      halted?.reason !== "egress-policy",
      halted?.reason,
    );
  }

  // ── NEGATIVE CONTROL: sibling text survives; a dropped shape stays dropped ───────────────────
  {
    const map: RecordMapper<{ kind: "mixed" | "drop"; text?: string; result?: string }> = (rec) => {
      if (rec.kind === "drop") return null;
      return {
        runId: "run-mixed",
        events: [
          runStarted({ threadId: THREAD, runId: "run-mixed", timestamp: 1 }),
          textMessageStart({ messageId: "m-mix", timestamp: 2, role: "assistant" }),
          textMessageContent({ messageId: "m-mix", delta: rec.text ?? "", timestamp: 3 }),
          textMessageEnd({ messageId: "m-mix", timestamp: 4 }),
          toolCallStart({ toolCallId: "t-mix", toolCallName: "Read", timestamp: 5 }),
          toolCallEnd({ toolCallId: "t-mix", timestamp: 6 }),
          toolCallResult({
            messageId: "res:t-mix",
            toolCallId: "t-mix",
            content: rec.result ?? "",
            timestamp: 7,
          }),
        ],
      };
    };
    const { pumped, wire, types } = await drive("mixed", map as RecordMapper<unknown>, [
      { kind: "drop", text: DROPPED_SECRET },
      { kind: "mixed", text: SIBLING_TEXT, result: CLAUDE_RESULT },
    ]);
    void pumped;
    c(
      "control:sibling TEXT_MESSAGE_CONTENT reaches the recorded publish (lifecycle survived the policy)",
      wire.includes(SIBLING_TEXT) &&
        types.includes("TEXT_MESSAGE_START") &&
        types.includes("TEXT_MESSAGE_CONTENT") &&
        types.includes("TEXT_MESSAGE_END") &&
        types.includes("TOOL_CALL_START") &&
        types.includes("TOOL_CALL_END") &&
        types.includes("RUN_STARTED"),
      types,
    );
    c(
      "control:the mixed unit's TOOL_CALL_RESULT mark does not reach the recorded publish",
      !wire.includes(CLAUDE_RESULT) && !types.includes("TOOL_CALL_RESULT") && !types.includes("TOOL_CALL_ARGS"),
      types,
    );
    c(
      "control:a mapper-null record stays dropped (already-dropped shape is not resurrected)",
      !wire.includes(DROPPED_SECRET),
    );
    c(
      "control:applyAguiEgressPolicy keeps text and start/end, drops result",
      (() => {
        const kept = applyAguiEgressPolicy([
          textMessageContent({ messageId: "m", delta: SIBLING_TEXT, timestamp: 1 }),
          toolCallResult({ messageId: "r", toolCallId: "t", content: CLAUDE_RESULT, timestamp: 1 }),
        ]);
        const w = JSON.stringify(kept);
        return (
          kept.length === 1 &&
          kept[0]!.type === "TEXT_MESSAGE_CONTENT" &&
          w.includes(SIBLING_TEXT) &&
          !w.includes(CLAUDE_RESULT)
        );
      })(),
    );
  }

  // ── THE FENCE IS TOTAL, AND FAILS CLOSED ────────────────────────────────────────────────────
  //
  // PLACED LAST ON PURPOSE. `frozenBodyEgressVerdict` is what T-ARGS and T-RESULT mutate, so a cell
  // asserting on it directly reddens under those mutations too. Sited earlier it would steal FIRST
  // RED from the carrier cells those mutations are meant to grade, and the fixture's expectRed names
  // a carrier. Last, the carrier cells red first and these still red.
  //
  // WHY THREE ANSWERS AND NOT A BOOLEAN. A frozen body whose event list cannot be read has to go
  // somewhere, and both boolean answers were wrong. Reading it through the strict parser threw a
  // bare vocabulary error out of a machine whose every other abnormal outcome is a named halt.
  // Skipping it PUBLISHED it, and the string case below is not hypothetical: those bytes reached a
  // recorded publish through AguiEmitter.start over a real reopened WAL. The boundary is the wire,
  // not what a renderer folds.
  {
    const verdict = (body: readonly unknown[]): FrozenBodyEgressVerdict | string => {
      try {
        return frozenBodyEgressVerdict(body);
      } catch (e) {
        return `THREW: ${(e as Error).message}`;
      }
    };
    const frame = (extra: Record<string, unknown>) => ({
      kind: "ag-ui.frame",
      protocol: "ag-ui/0.0.57",
      ...extra,
    });

    const malformed = frame({ events: [{ type: "TOOL_CALL_RESULT", content: RECOVER_RESULT }] });
    c(
      "total:a frame too malformed to PARSE but carrying TOOL_CALL_RESULT is forbidden-kind",
      verdict([malformed]) === "forbidden-kind",
      verdict([malformed]),
    );

    // The shape that made fail-open untenable. `events` IS the tool bytes, so the scan looks in
    // exactly the place the bytes live and finds no array. It survives a JSON round-trip intact.
    const eventsIsAString = frame({ events: `TOOL_CALL_RESULT: ${RECOVER_RESULT}` });
    c(
      "total:a frame whose events is a BARE STRING of tool bytes is unreadable, not published",
      verdict([eventsIsAString]) === "unreadable",
      verdict([eventsIsAString]),
    );
    c(
      "total:...and it survives a JSON round-trip, so the WAL cannot launder it",
      verdict([JSON.parse(JSON.stringify(eventsIsAString))]) === "unreadable",
    );

    const noEventList = frame({});
    c(
      "total:a frame-shaped body with NO event list is unreadable rather than clean",
      verdict([noEventList]) === "unreadable",
      verdict([noEventList]),
    );

    const olderProtocol = frame({
      protocol: "ag-ui/0.0.1",
      threadId: THREAD,
      runId: "r",
      epoch: "e",
      seq: 1,
      events: [{ type: "TOOL_CALL_RESULT", content: RECOVER_RESULT }],
    });
    c(
      "total:a frame frozen under an OLDER protocol is read for kinds rather than thrown over",
      verdict([olderProtocol]) === "forbidden-kind",
      verdict([olderProtocol]),
    );

    // "No input makes it throw" has to survive an accessor, or it is not a promise. These cannot
    // come off a WAL, since JSON has no getters, but the exported signature takes `readonly
    // unknown[]` and a function that accepts unknown and throws on some of it traps its caller.
    const eventsGetter = { kind: "ag-ui.frame", protocol: "ag-ui/0.0.57", get events(): unknown { throw new Error("events getter ran"); } };
    c("total:an events GETTER that throws does not escape the fence", verdict([eventsGetter]) === "unreadable", verdict([eventsGetter]));
    const typeGetter = { kind: "ag-ui.frame", protocol: "ag-ui/0.0.57", events: [{ get type(): unknown { throw new Error("type getter ran"); } }] };
    c("total:an event TYPE getter that throws does not escape the fence", verdict([typeGetter]) === "unreadable", verdict([typeGetter]));

    // An element the vocabulary does not define cannot be classified, only refused. The strict read
    // this replaced rejected an unrecognised `type` outright; treating one as harmless publishes
    // tool bytes hung under a nested `events`, or under a case-variant spelling, as clean. Both
    // shapes survive a JSON round-trip.
    const nested = frame({ events: [{ events: [{ type: "TOOL_CALL_RESULT", content: RECOVER_RESULT }] }] });
    c(
      "total:tool bytes under a NESTED events are unreadable rather than clean",
      verdict([nested]) === "unreadable",
      verdict([nested]),
    );
    const caseVariant = frame({ events: [{ type: "tool_call_result", content: RECOVER_RESULT }] });
    c(
      "total:a CASE-VARIANT event type is unreadable rather than clean",
      verdict([caseVariant]) === "unreadable",
      verdict([caseVariant]),
    );

    // Precedence: a body carrying both must report the more specific diagnosis, because the halts
    // are graded on carrying the right one.
    const both = [frame({}), frame({ events: [{ type: "TOOL_CALL_ARGS", delta: CLAUDE_ARGS }] })];
    c("total:forbidden-kind wins over unreadable when a body carries both", verdict(both) === "forbidden-kind", verdict(both));
  }

  const EXPECTED = 35;
  c(`every cell ran - ${EXPECTED} expected`, pass + fail === EXPECTED, `${pass + fail} cells reported`);
} finally {
  rmSync(dir, { recursive: true, force: true });
}

console.log(`agui-tool-result smoke: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
