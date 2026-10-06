/**
 * §3.2's mapping, driven over a session DERIVED FROM A REAL ONE, plus the arms and boundaries a
 * captured session does not reliably contain.
 *
 * **The fixture is not authored, and that distinction is the whole argument.** It is a real
 * OpenCode session rebuilt field by field by `scripts/redact-opencode-session.mjs` from the
 * declared field set, identifiers replaced through an ORDER-PRESERVING pseudonym map, free text and
 * tool payloads collapsed to placeholders that keep only emptiness. The records are OpenCode's; only
 * the strings are gone. Order preservation is asserted by the redactor rather than assumed, because
 * this source's cursor IS the id pair: a map that kept equality and lost order would produce a
 * fixture on which the cursor's own correctness could not be tested, and every cursor cell would
 * still pass.
 *
 * The derivation is checked rather than trusted: over the real session the mapper produced 2911
 * events (RUN 13/13, TEXT 232, REASONING 83, TOOL 485 of each), and over the fixture it produces the
 * same counts. That equality is the evidence the redaction preserved what these cells assert.
 *
 * Never prints record content: cells report counts, type names, and the fixture's own ids.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { AguiBrackets, AGUI_EVENT_TYPE, runFinished } from "@cotal-ai/connector-core";
import { OpenCodeSessionSource, type OpenCodeMessageWithParts, type OpenCodePart } from "../src/agui-source.js";
import { createOpenCodeMapper } from "../src/agui-map.js";

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

const here = dirname(fileURLToPath(import.meta.url));
const fixture = JSON.parse(
  readFileSync(join(here, "fixtures", "session-shape.json"), "utf8"),
) as OpenCodeMessageWithParts[];

const ids = (() => {
  let n = 0;
  return () => `run-${++n}`;
})();

/** Replay the whole fixture through source and mapper, feeding every event to the bracket machine. */
async function replay(reasoning: boolean) {
  const src = new OpenCodeSessionSource({ read: async () => fixture });
  const mapper = createOpenCodeMapper({ threadId: "ses_fixture", mintRunId: ids, reasoning });
  const brackets = new AguiBrackets();
  const events: Record<string, unknown>[] = [];
  let cursor: string | undefined = "";
  let records = 0;
  let bracketError: string | null = null;
  for (;;) {
    const r = await src.read(cursor);
    if (r.records.length === 0) break;
    for (const rec of r.records) {
      records += 1;
      const out = mapper.map(rec.value);
      if (out === null) continue;
      for (const e of out.events) {
        try {
          brackets.accept(e);
        } catch (err) {
          bracketError ??= String((err as Error).message);
        }
        events.push(e as Record<string, unknown>);
      }
    }
    cursor = r.cursor;
  }
  // The plugin closes the last run at `session.idle` through the holder: the emitter publishes
  // RUN_FINISHED for the run its brackets hold open and reports it to `forgetOpenRun`.
  const last = brackets.runId;
  if (last !== undefined) {
    const e = runFinished({ threadId: "ses_fixture", runId: last, timestamp: 1 });
    try {
      brackets.accept(e);
    } catch (err) {
      bracketError ??= String((err as Error).message);
    }
    events.push(e as Record<string, unknown>);
    mapper.forgetOpenRun(last);
  }
  const byType = new Map<string, number>();
  for (const e of events) byType.set(String(e.type), (byType.get(String(e.type)) ?? 0) + 1);
  return { mapper, brackets, events, byType, records, bracketError };
}

const R = await replay(true);

// ---------------------------------------------------------------------------- the real session
{
  const parts = fixture.reduce((n, m) => n + m.parts.length, 0);
  c("fixture:every record in the session was offered to the mapper", R.records === parts, { R: R.records, parts });
  c("fixture:no frame violated the brackets", R.bracketError === null, R.bracketError);
  c("fixture:no run is left open at the end", R.brackets.runId === undefined, R.brackets.runId ?? null);
  const next = R.mapper.map({
    part: { id: "prt_after", messageID: "msg_after", type: "text", text: "x", time: { start: 2, end: 3 } },
    message: { id: "msg_after", role: "assistant", time: { created: 2 } },
  });
  c("fixture:the mapper agrees that no run is open, so the next assistant record opens one",
    next?.events[0]?.type === AGUI_EVENT_TYPE.RUN_STARTED, next?.events[0]?.type);
  c("fixture:runs are balanced", R.byType.get(AGUI_EVENT_TYPE.RUN_STARTED) === R.byType.get(AGUI_EVENT_TYPE.RUN_FINISHED),
    { started: R.byType.get(AGUI_EVENT_TYPE.RUN_STARTED), finished: R.byType.get(AGUI_EVENT_TYPE.RUN_FINISHED) });
  c("fixture:text brackets are balanced",
    R.byType.get(AGUI_EVENT_TYPE.TEXT_MESSAGE_START) === R.byType.get(AGUI_EVENT_TYPE.TEXT_MESSAGE_END));
  c("fixture:every tool call has a result", R.byType.get(AGUI_EVENT_TYPE.TOOL_CALL_START) === R.byType.get(AGUI_EVENT_TYPE.TOOL_CALL_RESULT));
}

// ---------------------------------------------------------------- authorship: the safety property
{
  // Counted from the fixture rather than asserted as a constant, so the cell states a RELATION
  // between the source and the emission rather than a number that could drift into agreeing with a
  // broken mapper.
  const assistantText = fixture
    .filter((m) => m.info.role === "assistant")
    .flatMap((m) => m.parts)
    .filter((p) => p.type === "text" && !p.synthetic && !p.ignored && p.text).length;
  const userPartIds = new Set(
    fixture.filter((m) => m.info.role !== "assistant").flatMap((m) => m.parts).map((p) => p.id),
  );
  c("authorship:TEXT_MESSAGE_START count equals the ASSISTANT text parts exactly",
    R.byType.get(AGUI_EVENT_TYPE.TEXT_MESSAGE_START) === assistantText,
    { emitted: R.byType.get(AGUI_EVENT_TYPE.TEXT_MESSAGE_START), assistantText });
  c("authorship:the session really does contain user text parts, so the cell above is not vacuous",
    userPartIds.size > 0, userPartIds.size);
  const leaked = R.events.filter((e) => typeof e.messageId === "string" && userPartIds.has(e.messageId as string));
  c("authorship:NO event carries a user part id as its messageId", leaked.length === 0, leaked.length);
  const leakedParent = R.events.filter((e) => typeof e.parentMessageId === "string" && userPartIds.has(e.parentMessageId as string));
  c("authorship:and none carries one as parentMessageId either", leakedParent.length === 0, leakedParent.length);
}

// ---------------------------------------------------------------------------- the arm table
{
  const mapper = createOpenCodeMapper({ threadId: "t", mintRunId: ids });
  const msg = { id: "msg_1", role: "assistant", time: { created: 1, completed: 2 } };
  const emit = (part: OpenCodePart) => mapper.map({ part, message: msg })?.events.map((e) => (e as { type: string }).type) ?? [];
  const first = emit({ id: "prt_0", messageID: "msg_1", type: "text", text: "hi", time: { start: 1, end: 2 } });
  c("arms:the first assistant record opens a run", first[0] === AGUI_EVENT_TYPE.RUN_STARTED, first);
  c("arms:text maps to the three-event bracket",
    first.slice(1).join(",") === [AGUI_EVENT_TYPE.TEXT_MESSAGE_START, AGUI_EVENT_TYPE.TEXT_MESSAGE_CONTENT, AGUI_EVENT_TYPE.TEXT_MESSAGE_END].join(","),
    first.slice(1));
  c("arms:a step-start maps to nothing", emit({ id: "prt_1", messageID: "msg_1", type: "step-start" }).length === 0);
  c("arms:a step-finish maps to nothing, usage included",
    emit({ id: "prt_2", messageID: "msg_1", type: "step-finish", cost: 1 }).length === 0);
  c("arms:a patch maps to nothing", emit({ id: "prt_3", messageID: "msg_1", type: "patch" }).length === 0);
  c("arms:a synthetic text part maps to nothing",
    emit({ id: "prt_4", messageID: "msg_1", type: "text", text: "x", synthetic: true, time: { start: 1, end: 2 } }).length === 0);
  c("arms:an ignored text part maps to nothing",
    emit({ id: "prt_5", messageID: "msg_1", type: "text", text: "x", ignored: true, time: { start: 1, end: 2 } }).length === 0);
  c("arms:an EMPTY text part maps to nothing",
    emit({ id: "prt_6", messageID: "msg_1", type: "text", text: "", time: { start: 1, end: 2 } }).length === 0);
  c("arms:reasoning is OFF by default", emit({ id: "prt_7", messageID: "msg_1", type: "reasoning", text: "think", time: { start: 1, end: 2 } }).length === 0);
}
{
  const mapper = createOpenCodeMapper({ threadId: "t", mintRunId: ids, reasoning: true });
  const msg = { id: "msg_1", role: "assistant", time: { created: 1, completed: 2 } };
  const out = mapper.map({ part: { id: "prt_1", messageID: "msg_1", type: "reasoning", text: "think", time: { start: 1, end: 2 } }, message: msg });
  const types = out!.events.map((e) => (e as { type: string }).type);
  c("arms:reasoning ON emits the three-event bracket",
    types.slice(1).join(",") === [AGUI_EVENT_TYPE.REASONING_MESSAGE_START, AGUI_EVENT_TYPE.REASONING_MESSAGE_CONTENT, AGUI_EVENT_TYPE.REASONING_MESSAGE_END].join(","),
    types);
}

// ---------------------------------------------------------------------------- tool identity
{
  const mapper = createOpenCodeMapper({ threadId: "t", mintRunId: ids });
  const msg = { id: "msg_1", role: "assistant", time: { created: 1, completed: 9 } };
  const ok = mapper.map({
    part: { id: "prt_1", messageID: "msg_1", type: "tool", callID: "toolu_native", tool: "bash",
            state: { status: "completed", input: { a: 1 }, output: "done", time: { start: 5, end: 6 } } },
    message: msg,
  })!.events as Record<string, unknown>[];
  const start = ok.find((e) => e.type === AGUI_EVENT_TYPE.TOOL_CALL_START)!;
  const result = ok.find((e) => e.type === AGUI_EVENT_TYPE.TOOL_CALL_RESULT)!;
  const args = ok.find((e) => e.type === AGUI_EVENT_TYPE.TOOL_CALL_ARGS)!;
  c("tool:toolCallId is the NATIVE callID, not a synthesized key", start.toolCallId === "toolu_native", start.toolCallId);
  c("tool:the tool name rides through", start.toolCallName === "bash", start.toolCallName);
  c("tool:ARGS carries the WHOLE input, stringified", args.delta === JSON.stringify({ a: 1 }), args.delta);
  c("tool:RESULT carries a messageId", typeof result.messageId === "string" && (result.messageId as string).length > 0, result.messageId);
  c("tool:and it does NOT collide with the call's own observation id",
    result.messageId !== start.parentMessageId, { result: result.messageId, parent: start.parentMessageId });
  c("tool:the source timestamp comes from state.time, where a tool part actually keeps it",
    start.timestamp === 5, start.timestamp);
  const failed = mapper.map({
    part: { id: "prt_2", messageID: "msg_1", type: "tool", callID: "toolu_bad", tool: "bash",
            state: { status: "error", error: "boom", time: { start: 7 } } },
    message: msg,
  })!.events as Record<string, unknown>[];
  const badResult = failed.find((e) => e.type === AGUI_EVENT_TYPE.TOOL_CALL_RESULT)!;
  c("tool:a FAILED call reports its error as the content, not an empty string",
    badResult.content === "boom", badResult.content);
  c("tool:and is marked isError", (badResult.cotal as { isError?: boolean } | undefined)?.isError === true, badResult.cotal);
}

// ---------------------------------------------------------------------------- run boundaries
{
  const mapper = createOpenCodeMapper({ threadId: "t", mintRunId: ids });
  const a = { id: "msg_1", role: "assistant", time: { created: 1, completed: 2 } };
  const u = { id: "msg_2", role: "user", time: { created: 3 } };
  const first = mapper.map({ part: { id: "prt_1", messageID: "msg_1", type: "text", text: "x", time: { start: 1, end: 2 } }, message: a });
  c("runs:a run is open after the first assistant record", first?.events[0]?.type === AGUI_EVENT_TYPE.RUN_STARTED, first?.events[0]?.type);
  const onUser = mapper.map({ part: { id: "prt_2", messageID: "msg_2", type: "text", text: "prompt" }, message: u });
  c("runs:a user record CLOSES the open run", (onUser?.events[0] as { type?: string } | undefined)?.type === AGUI_EVENT_TYPE.RUN_FINISHED, onUser?.events.length);
  c("runs:and emits nothing of its own", onUser?.events.length === 1, onUser?.events.length);
  c("runs:a second user record returns null rather than a second RUN_FINISHED",
    mapper.map({ part: { id: "prt_3", messageID: "msg_2", type: "text", text: "more" }, message: u }) === null);
  const after = mapper.map({ part: { id: "prt_4", messageID: "msg_1", type: "text", text: "y", time: { start: 4, end: 5 } }, message: a });
  c("runs:the run is gone, so the next assistant record opens a new one",
    after?.events[0]?.type === AGUI_EVENT_TYPE.RUN_STARTED && after.runId !== first?.runId, after?.runId);
}
{
  const mapper = createOpenCodeMapper({ threadId: "t", mintRunId: ids });
  const a = { id: "msg_1", role: "assistant", time: { created: 1, completed: 2 } };
  const text = (id: string) => mapper.map({ part: { id, messageID: "msg_1", type: "text", text: "x", time: { start: 1, end: 2 } }, message: a });
  const held = text("prt_1")!.runId;
  mapper.forgetOpenRun("some-other-run");
  const same = text("prt_2");
  c("runs:forgetOpenRun keyed on a DIFFERENT id leaves the open run alone", same?.runId === held, same?.runId);
  mapper.forgetOpenRun(held);
  const fresh = text("prt_3");
  c("runs:forgetOpenRun keyed on the open run clears it",
    fresh?.events[0]?.type === AGUI_EVENT_TYPE.RUN_STARTED && fresh.runId !== held, fresh?.runId);
}

// ---------------------------------------------------------------------------- honest timestamps
{
  const mapper = createOpenCodeMapper({ threadId: "t", mintRunId: ids, now: () => 4242 });
  const out = mapper.map({
    part: { id: "prt_1", messageID: "msg_1", type: "text", text: "x" },
    message: { id: "msg_1", role: "assistant", time: {} },
  })!.events as Record<string, unknown>[];
  c("stamps:a record with no source clock is stamped from arrival", out[0]!.timestamp === 4242, out[0]!.timestamp);
  c("stamps:and SAYS it was, rather than passing arrival time off as the source's",
    (out[0]!.cotal as { tsSource?: string }).tsSource === "arrival", out[0]!.cotal);
  c("stamps:a record WITH a source clock is not labelled arrival",
    ((createOpenCodeMapper({ threadId: "t", mintRunId: ids }).map({
      part: { id: "prt_1", messageID: "msg_1", type: "text", text: "x", time: { start: 77, end: 78 } },
      message: { id: "msg_1", role: "assistant", time: { created: 1 } },
    })!.events[0] as Record<string, unknown>).cotal as { tsSource?: string }).tsSource === undefined);
}

const EXPECTED = 39;
c(`meta:every cell ran - ${EXPECTED} expected`, pass + fail === EXPECTED, `${pass + fail} cells reported`);

console.log(
  `agui-opencode-map smoke: ${pass} passed, ${fail} failed  ` +
    `[fixture: ${fixture.length} messages, ${fixture.reduce((n, m) => n + m.parts.length, 0)} parts, ${R.events.length} events]`,
);
process.exit(fail === 0 ? 0 : 1);
