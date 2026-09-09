/**
 * FAIL CLOSED ON TOOL-RESULT BODIES.
 *
 * `events.<owner>.<actor>` carries a DIFFERENT read ACL from wherever a tool read. A
 * `tool_result` block at this mapper has no trusted provenance and no evidence the destination
 * audience may read it, so the body is not republished. `TOOL_CALL_RESULT.content` is mandatory,
 * so the event is suppressed rather than emitted empty or with a placeholder.
 *
 * Observers lose the tool output they see today. That is the point, not a regression.
 *
 * THE CLAIM IS JOINED, SO IT GETS A DECOY PER FACT. "No tool-result body is emitted" is
 * satisfied completely by a mapper that emits nothing at all, so a one-armed suite would go green
 * against a filter that had broken everything. The two arms are therefore:
 *
 *   A. SAFETY  — a tool_result record emits NO TOOL_CALL_RESULT and the placeholder never appears.
 *   B. LIVENESS — the matching tool_use still emits START/ARGS/END, and a human prompt still
 *                 opens a run with its body.
 *
 * A mutation that restores verbatim result content reddens A while B stays green; a mutation that
 * drops tool_use lifecycle as well reddens B while A stays green.
 *
 * THE SAFETY CELL ASSERTS ABSENCE OF THE BYTES, NOT ABSENCE OF AN EVENT TYPE. Checking only that
 * no TOOL_CALL_RESULT appears would pass a mapper that moved the body into a delta on some other
 * event, or into cotal metadata. So the corpus is searched for the placeholder itself.
 *
 * Placeholders only. No live ACL crossing, no real tool output, no secrets.
 *
 * Run: npx tsx extensions/connector-claude-code/smoke/agui-tool-result.smoke.ts
 */
import { createClaudeMapper, type ClaudeEntry } from "../src/agui-map.js";

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

const RESULT_PLACEHOLDER = "SYNTHETIC-TOOL-RESULT-PLACEHOLDER-695-NOT-A-SECRET";
const ARGS_PLACEHOLDER = "SYNTHETIC-TOOL-ARGS-PLACEHOLDER-695-NOT-A-SECRET";
const PROMPT = "synthetic human prompt for 695 liveness";

const mk = (o: Partial<ClaudeEntry> & { uuid: string }): ClaudeEntry => o as ClaudeEntry;

const human = (uuid: string, text: string): ClaudeEntry =>
  mk({
    uuid,
    type: "user",
    timestamp: "2026-08-15T00:00:00.000Z",
    origin: { kind: "human" },
    message: { role: "user", content: text },
  } as never);

const toolUse = (uuid: string, id: string, name: string, input: unknown): ClaudeEntry =>
  mk({
    uuid,
    type: "assistant",
    timestamp: "2026-08-15T00:00:01.000Z",
    message: {
      role: "assistant",
      content: [{ type: "tool_use", id, name, input }],
    },
  } as never);

const toolResult = (uuid: string, toolUseId: string, content: unknown, isError = false): ClaudeEntry =>
  mk({
    uuid,
    type: "user",
    timestamp: "2026-08-15T00:00:02.000Z",
    message: {
      role: "user",
      content: [{ type: "tool_result", tool_use_id: toolUseId, content, is_error: isError }],
    },
  } as never);

const mapAll = (entries: ClaudeEntry[]) => {
  let n = 0;
  const m = createClaudeMapper({ threadId: "thread-695", mintRunId: () => `run-${++n}` });
  const events: Record<string, unknown>[] = [];
  for (const e of entries) {
    const out = m.map(e);
    if (out) events.push(...(out.events as unknown as Record<string, unknown>[]));
  }
  return { events, mapper: m };
};

{
  const { events } = mapAll([
    human("u0", PROMPT),
    toolUse("a1", "t1", "Read", { path: ARGS_PLACEHOLDER }),
    toolResult("u1", "t1", RESULT_PLACEHOLDER, true),
  ]);
  const wire = JSON.stringify(events);
  const types = events.map((e) => e.type);

  c("a tool_result placeholder does NOT appear anywhere on the wire", !wire.includes(RESULT_PLACEHOLDER));
  c("NO TOOL_CALL_RESULT is emitted for a tool_result record",
    !types.includes("TOOL_CALL_RESULT"), types);
  c("an is_error flag is not a loophole that restores the body",
    !events.some((e) => (e.cotal as Record<string, unknown> | undefined)?.isError === true)
      && !wire.includes(RESULT_PLACEHOLDER));
}

{
  const { events } = mapAll([
    human("u0", PROMPT),
    toolUse("a1", "t1", "Read", { path: ARGS_PLACEHOLDER }),
    toolResult("u1", "t1", RESULT_PLACEHOLDER),
  ]);
  const wire = JSON.stringify(events);
  const types = events.map((e) => e.type);
  const start = events.find((e) => e.type === "TOOL_CALL_START") as
    | { toolCallId?: string; toolCallName?: string; parentMessageId?: string }
    | undefined;
  const args = events.find((e) => e.type === "TOOL_CALL_ARGS") as { toolCallId?: string } | undefined;
  const end = events.find((e) => e.type === "TOOL_CALL_END") as { toolCallId?: string } | undefined;

  c("DECOY/LIVENESS — a human prompt still emits its body", wire.includes(PROMPT));
  c("DECOY/LIVENESS — tool_use still emits START/ARGS/END",
    types.includes("TOOL_CALL_START") && types.includes("TOOL_CALL_ARGS") && types.includes("TOOL_CALL_END"),
    types);
  c("DECOY/LIVENESS — the START keeps toolCallId, name, and parentMessageId",
    start?.toolCallId === "t1" && start?.toolCallName === "Read" && start?.parentMessageId === "a1#0",
    start);
  c("DECOY/LIVENESS — ARGS and END keep the same toolCallId",
    args?.toolCallId === "t1" && end?.toolCallId === "t1",
    { args, end });
  c("DECOY/LIVENESS — ARGS still carry the synthetic input, which is not the result body",
    wire.includes(ARGS_PLACEHOLDER) && !wire.includes(RESULT_PLACEHOLDER));
}

{
  const { events } = mapAll([
    human("u0", PROMPT),
    toolUse("a1", "t1", "Read", { path: ARGS_PLACEHOLDER }),
    toolResult("u1", "t1", [{ type: "text", text: RESULT_PLACEHOLDER }]),
  ]);
  const wire = JSON.stringify(events);
  c("an array-shaped tool_result is suppressed the same way as a string",
    !wire.includes(RESULT_PLACEHOLDER) && !events.some((e) => e.type === "TOOL_CALL_RESULT"));
}

const EXPECTED = 9;
c(`every cell ran - ${EXPECTED} expected`, pass + fail === EXPECTED, `${pass + fail} cells reported`);

console.log(`agui-tool-result smoke: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
