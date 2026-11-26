/**
 * The Codex mapper, driven against a REAL app-server thread's rollout.
 *
 * The fixture is DERIVED, not authored, and that distinction is the whole argument. It is one real
 * thread produced by this connector's own host: every record, every field name,
 * every ordering and every id is what codex actually wrote. Only free TEXT is replaced, character
 * for character, because the thread ran in the human's workspace and this file is public. An
 * authored fixture would encode the same beliefs the mapper encodes, so it could not catch the
 * mapper being wrong about the record shape, which is exactly what went wrong once already in this
 * lane (the vocabulary was censused on the operator's own sessions, a different population).
 *
 * PROVENANCE IS PRINTED PER CELL, because the ledger is a grading input and a suite that hides it
 * is worse than one that has no cells at all:
 *   `live:`   asserted against the derived real-thread fixture.
 *   `shape:`  asserted against a record built from the MEASURED key-shape census of the 34 394
 *             `response_item` records this mapper reads, message, reasoning, and the two
 *             tool-call families with their outputs, out of 74 031 records across 288 threads
 *             (field names, types and presence counts). The shapes are measured; the
 *             particular record is not real. An exhausted model quota on this account is why, and the
 *             connector live end-to-end proof supersedes every one of these.
 *
 * Never prints record content: cells report counts, type names and ids.
 *
 * Run: `pnpm smoke:agui-codex-map`
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { AguiBrackets, type AguiEvent, type Merged } from "@cotal-ai/connector-core";
import { createCodexMapper, type CodexRecord } from "../src/agui-map.js";

/** The unit a record mapped to, or `null`: a turn the mapper opens no run for maps to none. */
const unitOf = <U extends { runId: string }>(r: U | { turn: true } | null): U | null => (r !== null && "runId" in r ? r : null);
let pass = 0;
let fail = 0;
/** A cell COUNTS and continues. It does not throw.
 *
 *  An asserting helper names only the FIRST fact a change breaks: the file dies on it and every
 *  later cell, including the one a reader is looking for, never runs. That turns a run into a red
 *  prefix, and a red prefix cannot say which facts held and which did not. Cells print only when
 *  they fail, so a cell name in this log always means that cell failed. */
const c = (name: string, cond: boolean, extra?: unknown): void => {
  if (cond) {
    pass++;
    return;
  }
  fail++;
  console.log(`  x FAIL: ${name}`, extra !== undefined ? JSON.stringify(extra) : "");
};

const FIXTURE = fileURLToPath(new URL("./fixtures/thread-shape.jsonl", import.meta.url));
const records: CodexRecord[] = readFileSync(FIXTURE, "utf8")
  .split("\n")
  .filter((l) => l.trim().length > 0)
  .map((l) => JSON.parse(l) as CodexRecord);

const THREAD = "01a01586-5f04-7c53-a91b-78386b50a901";

/** Replay every record through a fresh mapper, feeding every event to the bracket machine so a
 *  vocabulary violation fails here rather than at the broker. */
/** `reasoning` is the launch's `reasoningEvents`. */
function replay(recs: CodexRecord[], reasoning = true): {
  events: AguiEvent[];
  perRecord: ({ runId: string; events: AguiEvent[] } | null)[];
  bracketError: string | null;
  runs: string[];
} {
  let n = 0;
  const mapper = createCodexMapper({ threadId: THREAD, mintRunId: () => `run-${++n}`, reasoning });
  const brackets = new AguiBrackets();
  const events: AguiEvent[] = [];
  const perRecord: ({ runId: string; events: AguiEvent[] } | null)[] = [];
  const runs: string[] = [];
  let bracketError: string | null = null;
  for (const r of recs) {
    const out = unitOf(mapper.map(r));
    perRecord.push(out);
    if (out === null) continue;
    if (!runs.includes(out.runId)) runs.push(out.runId);
    for (const e of out.events) {
      events.push(e);
      try {
        brackets.accept(e);
      } catch (err) {
        bracketError ??= (err as Error).message;
      }
    }
  }
  return { events, perRecord, bracketError, runs };
}

const kinds = (evts: AguiEvent[]): Record<string, number> => {
  const out: Record<string, number> = {};
  for (const e of evts) out[(e as { type: string }).type] = (out[(e as { type: string }).type] ?? 0) + 1;
  return out;
};

// ---------------------------------------------------------------- live, the real thread
{
  const R = replay(records);
  const k = kinds(R.events);
  c("live:every record in the real thread was offered to the mapper", R.perRecord.length === records.length, {
    offered: R.perRecord.length,
    records: records.length,
  });
  c("live:no frame violated the brackets", R.bracketError === null, R.bracketError);
  c("live:the thread opened at least one run", (k.RUN_STARTED ?? 0) > 0, k);
  c("live:every run that opened also ended", (k.RUN_STARTED ?? 0) === (k.RUN_FINISHED ?? 0) + (k.RUN_ERROR ?? 0), k);

  // THE FINDING A SUCCESSFUL TURN COULD NOT HAVE PRODUCED. Every turn in this thread failed, and
  // codex wrote NO `event_msg/error` for any of them: the failure is carried on `task_complete`.
  const errorRecords = records.filter(
    (r) => r.type === "event_msg" && (r.payload as { type?: string } | undefined)?.type === "error",
  ).length;
  c("live:the real thread contains NO event_msg/error record", errorRecords === 0, { errorRecords });
  c("live:and RUN_ERROR was emitted anyway, from task_complete.error", (k.RUN_ERROR ?? 0) > 0, k);

  const failed = records.filter(
    (r) =>
      r.type === "event_msg" &&
      (r.payload as { type?: string } | undefined)?.type === "task_complete" &&
      (r.payload as { error?: unknown } | undefined)?.error != null,
  ).length;
  c("live:one RUN_ERROR per errored task_complete", (k.RUN_ERROR ?? 0) === failed, { RUN_ERROR: k.RUN_ERROR, failed });

  const runErrors = R.events.filter((e) => (e as { type: string }).type === "RUN_ERROR") as {
    code?: string;
    message?: string;
  }[];
  c("live:RUN_ERROR carries the codex error code", runErrors.every((e) => typeof e.code === "string" && e.code.length > 0), {
    codes: [...new Set(runErrors.map((e) => e.code))],
  });

  // WITHHELD. The user's own words and the developer instructions never reach `events.<owner>.<actor>`,
  // which carries a different read ACL from the channel the user typed into.
  const userIds = new Set<string>();
  for (const r of records) {
    const p = r.payload as { type?: string; role?: string; id?: string } | undefined;
    if (r.type === "response_item" && p?.type === "message" && p.role !== "assistant" && p.id) userIds.add(p.id);
  }
  const carried = R.events.filter((e) => userIds.has(String((e as { messageId?: string }).messageId ?? ""))).length;
  c("live:NO event carries a withheld record's id as its messageId", carried === 0, { withheld: userIds.size, carried });
  c("live:and there were withheld records to withhold", userIds.size > 0, { withheld: userIds.size });

  // The same inbound DM is written TWICE, as a response_item/message role=user and as an
  // event_msg/user_message. Both are dropped; the pair is asserted so a future mapper cannot start
  // emitting one of them without this going red.
  let pairs = 0;
  for (let i = 0; i < records.length - 1; i++) {
    const a = records[i]!.payload as { type?: string; role?: string } | undefined;
    const b = records[i + 1]!.payload as { type?: string } | undefined;
    if (a?.type === "message" && a.role === "user" && b?.type === "user_message") pairs++;
  }
  c("live:every inbound DM is written as a record PAIR", pairs > 0, { pairs });
  const dropped = records.filter(
    (r, i) => R.perRecord[i] === null && (r.payload as { type?: string } | undefined)?.type === "user_message",
  ).length;
  c("live:and both halves of the pair are dropped", dropped === pairs, { dropped, pairs });

  // A non-uuid turn id sits at record 6 of every thread. Nothing may assume a uuid.
  const oddTurn = records.some(
    (r) => r.type === "turn_context" && !/^[0-9a-f-]{36}$/.test(String((r.payload as { turn_id?: string })?.turn_id ?? "")),
  );
  c("live:the thread carries a NON-uuid turn id and the mapper survived it", oddTurn && R.bracketError === null, { oddTurn });

  // The primer materializes the rollout before any turn, so records precede the first run.
  const firstStart = records.findIndex(
    (r) => r.type === "event_msg" && (r.payload as { type?: string } | undefined)?.type === "task_started",
  );
  c("live:records precede the first run and none of them emitted", firstStart > 0 && R.perRecord.slice(0, firstStart).every((x) => x === null), {
    firstStart,
  });
}

// ------------------------------------------------------- resume, from persisted WAL bracket state
{
  let n = 0;
  const mapper = createCodexMapper({
    threadId: THREAD,
    mintRunId: () => `new-run-${++n}`,
    resumeRunId: "persisted-run",
  });
  const ts = "2026-08-18T15:00:00.000Z";
  const toolResult = unitOf(mapper.map({
    timestamp: ts,
    type: "response_item",
    payload: { type: "function_call_output", call_id: "call-resumed", output: "resumed output" },
  }));
  c("resume:records before the terminal stay on the WAL's existing run", toolResult?.runId === "persisted-run", toolResult?.runId);
  const terminal = unitOf(mapper.map({
    timestamp: ts,
    type: "event_msg",
    payload: { type: "task_complete", turn_id: "native-turn-not-persisted", error: null },
  }));
  c(
    "resume:a task_complete after process recovery closes the WAL's existing run",
    terminal?.runId === "persisted-run" && terminal.events.some((e) => (e as { type: string }).type === "RUN_FINISHED"),
    terminal,
  );
  const next = unitOf(mapper.map({
    timestamp: ts,
    type: "event_msg",
    payload: { type: "task_started", turn_id: "next-native-turn" },
  }));
  c("resume:the next native turn starts a NEW run after the persisted one closed", next?.runId === "new-run-1", next?.runId);
}

// ------------------------------------------------------- shape, from the measured key census
// Built from the measured key-shape census of the corpus: `message[assistant]` always has `content: list` of
// `output_text` plus `phase`; `reasoning` always has `summary: list` of `summary_text` plus
// `encrypted_content`; `function_call` always has `call_id`/`name`/`arguments`;
// `function_call_output.output` is a UNION, `str` on 6 353 records and `list` on 380.
{
  const ts = "2026-08-18T15:00:00.000Z";
  const start = { timestamp: ts, type: "event_msg", payload: { type: "task_started", turn_id: "t1" } };
  const done = { timestamp: ts, type: "event_msg", payload: { type: "task_complete", turn_id: "t1", error: null } };

  const withText = replay([
    start,
    { timestamp: ts, type: "response_item", payload: { type: "message", role: "assistant", phase: "final", id: "m1", content: [{ type: "output_text", text: "hello" }] } },
    done,
  ]);
  const kt = kinds(withText.events);
  c("shape:an assistant message becomes START/CONTENT/END", kt.TEXT_MESSAGE_START === 1 && kt.TEXT_MESSAGE_CONTENT === 1 && kt.TEXT_MESSAGE_END === 1, kt);
  c("shape:and it uses the record's native id as the messageId", withText.events.some((e) => (e as { messageId?: string }).messageId === "m1"));
  c("shape:brackets legal", withText.bracketError === null, withText.bracketError);

  // THE TWO SHAPES `task_complete.error` CAN ARRIVE IN, and the reason the mapper reads both. The
  // dict is the only one that occurs today: all 6 error values across 1 785 real `task_complete`
  // records carry `message` plus `codex_error_info`, and zero are bare strings. The string cell is
  // therefore not a claim about the corpus, it is a guard on the direction the failure would go if
  // that ever changed, because a mapper that only understands the dict would read a string as a
  // SUCCESS and publish RUN_FINISHED for a turn that failed.
  const errDict = replay([
    start,
    { timestamp: ts, type: "event_msg", payload: { type: "task_complete", turn_id: "t1", error: { message: "stream disconnected", codex_error_info: "stream_error" } } },
  ]);
  const ed = errDict.events.find((e) => (e as { type: string }).type === "RUN_ERROR") as { message?: string; code?: string } | undefined;
  c("error:the dict shape becomes RUN_ERROR carrying its message and code", ed?.message === "stream disconnected" && ed?.code === "stream_error", ed);
  c("error:and the run does not ALSO finish", kinds(errDict.events).RUN_FINISHED === undefined, kinds(errDict.events));
  const errString = replay([
    start,
    { timestamp: ts, type: "event_msg", payload: { type: "task_complete", turn_id: "t1", error: "bare string failure" } },
  ]);
  const es = errString.events.find((e) => (e as { type: string }).type === "RUN_ERROR") as { message?: string; code?: string } | undefined;
  c("error:a bare string error is a FAILED run, not a finished one", es?.message === "bare string failure" && kinds(errString.events).RUN_FINISHED === undefined, {
    es,
    kinds: kinds(errString.events),
  });
  c("error:and it carries no invented code", es?.code === undefined, es);
  c("error:a null error is a success, so the cells above are about the error and not about the branch", kinds(replay([start, done]).events).RUN_FINISHED === 1, {
    kinds: kinds(replay([start, done]).events),
  });

  const thinking: CodexRecord = { timestamp: ts, type: "response_item", payload: { type: "reasoning", id: "r1", encrypted_content: "OPAQUE", summary: [{ type: "summary_text", text: "thinking" }] } };
  const withReasoning = replay([start, thinking, done]);
  const kr = kinds(withReasoning.events);
  c("shape:a reasoning record becomes REASONING START/CONTENT/END", kr.REASONING_MESSAGE_START === 1 && kr.REASONING_MESSAGE_CONTENT === 1 && kr.REASONING_MESSAGE_END === 1, kr);
  const deltas = withReasoning.events
    .filter((e) => (e as { type: string }).type === "REASONING_MESSAGE_CONTENT")
    .map((e) => (e as { delta: string }).delta);
  c("shape:encrypted_content is NEVER published", deltas.every((d) => !d.includes("OPAQUE")), { deltas: deltas.length });
  const unasked = kinds(replay([start, thinking, done], false).events);
  c("shape:without reasoningEvents a reasoning record publishes nothing", unasked.REASONING_MESSAGE_START === undefined && unasked.REASONING_MESSAGE_CONTENT === undefined && unasked.RUN_FINISHED === 1, unasked);

  const withTool = replay([
    start,
    { timestamp: ts, type: "response_item", payload: { type: "function_call", call_id: "call-9", name: "shell", arguments: '{"cmd":"ls"}' } },
    { timestamp: ts, type: "response_item", payload: { type: "function_call_output", call_id: "call-9", output: "ok" } },
    done,
  ]);
  const ktool = kinds(withTool.events);
  c("shape:a tool call becomes START/ARGS/END plus RESULT", ktool.TOOL_CALL_START === 1 && ktool.TOOL_CALL_ARGS === 1 && ktool.TOOL_CALL_END === 1 && ktool.TOOL_CALL_RESULT === 1, ktool);
  const res = withTool.events.find((e) => (e as { type: string }).type === "TOOL_CALL_RESULT") as { toolCallId: string; messageId: string; content: string };
  // BOTH ends of the call are asserted, and separately. A mutation that synthesized the START's id
  // survived a cell that only read the RESULT's: the counts were unchanged and the blast radius
  // showed up in a differently-named bracket cell, which is a red that is not evidence for the
  // claim the cell makes.
  const startEvt = withTool.events.find((e) => (e as { type: string }).type === "TOOL_CALL_START") as { toolCallId: string };
  c("shape:TOOL_CALL_START carries the NATIVE call_id, not a synthesized key", startEvt.toolCallId === "call-9", { toolCallId: startEvt.toolCallId });
  c("shape:toolCallId is the NATIVE call_id, not a synthesized key", res.toolCallId === "call-9", { toolCallId: res.toolCallId });
  c("shape:TOOL_CALL_RESULT carries the messageId every connector owes, derived from the call id", res.messageId === "res:call-9", { messageId: res.messageId });

  // The result marker rides in the same unit as the result, so a read that starts with the output
  // still holds a public event. `isError` comes only from an end record the mapper saw for the call.
  const markerOf = (u: { events: AguiEvent[] } | null) => u?.events.find((e) => (e as { type: string; name?: string }).type === "CUSTOM") as { name: string; value: Record<string, unknown> } | undefined;
  const resultOf = (u: { events: AguiEvent[] } | null) => u?.events.find((e) => (e as { type: string }).type === "TOOL_CALL_RESULT") as { cotal?: { isError?: boolean } } | undefined;
  const outputUnit = withTool.perRecord[2] ?? null;
  c("shape:the output's unit holds RESULT and the cotal.toolResult marker", markerOf(outputUnit)?.name === "cotal.toolResult" && resultOf(outputUnit) !== undefined, outputUnit?.events.map((e) => (e as { type: string }).type));
  c("shape:with no end record the marker and the RESULT leave isError out",
    JSON.stringify(markerOf(outputUnit)?.value) === JSON.stringify({ toolCallId: "call-9" }) && resultOf(outputUnit)?.cotal === undefined, { marker: markerOf(outputUnit)?.value, cotal: resultOf(outputUnit)?.cotal });
  const ended = (call: string, end: CodexRecord["payload"]) => {
    const r = replay([
      start,
      { timestamp: ts, type: "response_item", payload: { type: "function_call", call_id: call, name: "exec_command", arguments: "{}" } },
      { timestamp: ts, type: "event_msg", payload: end },
      { timestamp: ts, type: "response_item", payload: { type: "function_call_output", call_id: call, output: "out" } },
      done,
    ]);
    const unit = r.perRecord[3] ?? null;
    return { marker: markerOf(unit)?.value.isError, result: resultOf(unit)?.cotal?.isError, err: r.bracketError };
  };
  const endCases: [string, CodexRecord["payload"], boolean][] = [
    ["exec_command_end with exit code 0", { type: "exec_command_end", call_id: "e0", exit_code: 0 }, false],
    ["exec_command_end with exit code 1", { type: "exec_command_end", call_id: "e1", exit_code: 1 }, true],
    ["patch_apply_end that succeeded", { type: "patch_apply_end", call_id: "p0", success: true }, false],
    ["patch_apply_end that failed", { type: "patch_apply_end", call_id: "p1", success: false }, true],
    ["mcp_tool_call_end with an Err result", { type: "mcp_tool_call_end", call_id: "m1", result: { Err: "boom" } }, true],
    ["mcp_tool_call_end with an Ok result marked isError", { type: "mcp_tool_call_end", call_id: "m2", result: { Ok: { content: [], isError: true } } }, true],
    ["mcp_tool_call_end with an Ok result", { type: "mcp_tool_call_end", call_id: "m3", result: { Ok: { content: [] } } }, false],
  ];
  for (const [label, end, want] of endCases) {
    const got = ended((end as { call_id: string }).call_id, end);
    c(`shape:${label} sets isError ${want} on the marker and the RESULT`, got.marker === want && got.result === want && got.err === null, got);
  }
  const otherCall = ended("x1", { type: "exec_command_end", call_id: "someone-else", exit_code: 1 });
  c("shape:an end record for another call says nothing about this one", otherCall.marker === undefined && otherCall.result === undefined, otherCall);

  // THE UNION. `output` is a string on 6 353 `function_call_output` records and a list on 380, and
  // the other output family leans the other way, 664 string against 1 660 list. A mapper that
  // assumes one throws on the other, and a thrown mapper is a dead event plane, not a dropped record.
  const listOutput = replay([
    start,
    { timestamp: ts, type: "response_item", payload: { type: "function_call", call_id: "call-8", name: "shell", arguments: "{}" } },
    { timestamp: ts, type: "response_item", payload: { type: "function_call_output", call_id: "call-8", output: [{ type: "output_text", text: "listy" }] } },
    done,
  ]);
  const kl = kinds(listOutput.events);
  c("shape:a LIST-shaped tool output still produces exactly one RESULT", kl.TOOL_CALL_RESULT === 1, kl);
  // Existence is not delivery. A mapper that quietly serialized a list to nothing would satisfy the
  // cell above and put an empty result on the wire, which reads to an observer as a tool that
  // returned nothing rather than as a mapper that dropped it.
  const listRes = listOutput.events.find((e) => (e as { type: string }).type === "TOOL_CALL_RESULT") as { content: string };
  c("shape:and the LIST output's content actually reaches the event", listRes.content.includes("listy"), { len: listRes.content.length });
  c("shape:and the run still closed cleanly", kl.RUN_FINISHED === 1 && listOutput.bracketError === null, { kl, err: listOutput.bracketError });

  // A record for a turn other than the open one must not close it: codex retries a failed turn
  // under a FRESH turn id, and each retry is its own run.
  const foreign = replay([
    start,
    { timestamp: ts, type: "event_msg", payload: { type: "task_complete", turn_id: "OTHER", error: null } },
    done,
  ]);
  const kf = kinds(foreign.events);
  // THE COUNT IS 1 IN BOTH WORLDS, so it is not the assertion. Unfenced, the foreign record closes
  // the run and the real one maps to null; fenced, the foreign one maps to null and the real one
  // closes it. What separates them is WHICH record emitted, so that is what is asserted.
  c("shape:a task_complete for a DIFFERENT turn emits NOTHING", foreign.perRecord[1] === null, { got: foreign.perRecord[1] });
  c("shape:and the run is closed by its OWN turn's record", foreign.perRecord[2] !== null && kf.RUN_FINISHED === 1, kf);
  c("shape:and exactly one run existed throughout", foreign.runs.length === 1, { runs: foreign.runs.length });

  // turn_id is NOT required on turn_aborted: one corpus reading has it on 61 of 61 and another on
  // 18 of 19, and throwing on a missing one would convert a rare heterogeneity into a dead stream.
  const aborted = replay([
    start,
    { timestamp: ts, type: "event_msg", payload: { type: "turn_aborted", reason: "user" } },
  ]);
  const ka = kinds(aborted.events);
  c("shape:turn_aborted WITHOUT a turn id still ends the run", ka.RUN_FINISHED === 1, ka);
  c("shape:and it ends it as an interrupt, not a success", (aborted.events.find((e) => (e as { type: string }).type === "RUN_FINISHED") as { outcome?: { type: string } }).outcome?.type === "interrupt");
}

// A LINE THAT IS NOT AN OBJECT IS A DROP, NOT A THROW. `JsonlFileSource` hands over
// `JSON.parse(line)` unchecked, so a line reading `null` arrives at the mapper as `null`. The
// asserted fact is the DROP rather than the absence of a throw: a throw kills the emitter, the
// holder is terminal on error, and the seat then publishes nothing for the rest of its life with
// one log line inside its own process as the only trace.
//
// THE REPLAY RUNS INSIDE A CATCH, and that is what makes this a cell rather than a stack trace. An
// unguarded throw here takes the whole file down before any check prints, so the run is red with a
// RED PREFIX and no cell name in it: the reader cannot tell which fact broke, and a mutation that
// removes the guard grades as "red for some reason" instead of "this cell caught it".
{
  const ts = "2026-08-18T15:00:00.000Z";
  const start = { timestamp: ts, type: "event_msg", payload: { type: "task_started", turn_id: "t1" } };
  const done = { timestamp: ts, type: "event_msg", payload: { type: "task_complete", turn_id: "t1", error: null } };
  const degenerate = [null, undefined, 5, "x", []] as unknown as CodexRecord[];
  let thrown: string | null = null;
  let R: ReturnType<typeof replay> | null = null;
  try {
    R = replay([start, ...degenerate, done]);
  } catch (e) {
    thrown = (e as Error).message;
  }
  c("degenerate:a null JSONL line is DROPPED, not thrown on", thrown === null && R !== null && R.perRecord[1] === null, {
    thrown,
    got: R?.perRecord[1],
  });
  c(
    "degenerate:and so is every other non-object line",
    R !== null && R.perRecord.slice(1, 1 + degenerate.length).every((x) => x === null),
    { thrown, perRecord: R?.perRecord.slice(1, 1 + degenerate.length) },
  );
  // The drop is COUNTED, so it stays visible to a reader of the census rather than vanishing into
  // "nothing happened". A silent drop and a correct map are the same shape from outside.
  const dropped = R === null ? -1 : R.perRecord.filter((x) => x === null).length;
  c("degenerate:the census counts them as dropped", dropped === degenerate.length, { dropped, expected: degenerate.length });
  const k = R === null ? {} : kinds(R.events);
  c("degenerate:and the run around them still opens and closes exactly once", k.RUN_STARTED === 1 && k.RUN_FINISHED === 1 && R?.bracketError === null, { thrown, k });
}

// THE STATED GAP, PINNED. Codex's model-side built-in tools (web search, tool search, image
// generation) are NOT published, and that is a decision rather than an oversight: their records are
// an END with no START, and there is no key that joins the two halves. `response_item/web_search_call`
// carries `id`, `status` and `action` and NO `call_id`; `event_msg/web_search_end` carries `call_id`.
// A bracket built across that divide would be a correlation invented by analogy with `function_call`.
// This cell exists so the gap is a stated limit rather than a silent drop, and so that anyone who
// later publishes the family has to come here and change the sentence the docs make.
//
// Same catch, same reason: publishing that END record produces a result for a call nothing started,
// which the bracket machine refuses by throwing, and an unguarded throw would take the file down
// before the cell that names the gap ever printed.
{
  const ts = "2026-08-18T15:00:00.000Z";
  const start = { timestamp: ts, type: "event_msg", payload: { type: "task_started", turn_id: "t1" } };
  const done = { timestamp: ts, type: "event_msg", payload: { type: "task_complete", turn_id: "t1", error: null } };
  let thrown: string | null = null;
  let R: ReturnType<typeof replay> | null = null;
  try {
    R = replay([
      start,
      { timestamp: ts, type: "response_item", payload: { type: "web_search_call", id: "ws_1", status: "completed", action: { type: "search", query: "q" } } },
      { timestamp: ts, type: "event_msg", payload: { type: "web_search_end", call_id: "call-ws", query: "q", action: { type: "search" } } },
      done,
    ]);
  } catch (e) {
    thrown = (e as Error).message;
  }
  const k = R === null ? {} : kinds(R.events);
  c("gap:a web_search_call is dropped, deliberately", thrown === null && R !== null && R.perRecord[1] === null, { thrown, got: R?.perRecord[1] });
  c("gap:and so is its end record, which carries the only call id", R !== null && R.perRecord[2] === null, { thrown, got: R?.perRecord[2] });
  c("gap:no tool event is published for the built-in family", thrown === null && k.TOOL_CALL_START === undefined && k.TOOL_CALL_RESULT === undefined, { thrown, k });
  // The run must survive the family it cannot describe. A gap that also broke the brackets would be
  // a second defect wearing the first one's clothes.
  c("gap:and the run still opens and closes exactly once around it", k.RUN_STARTED === 1 && k.RUN_FINISHED === 1 && R?.bracketError === null, { thrown, k });
}

// ------------------------------------------------------- code mode, in codex 0.162's rollout shapes
// With code mode, every tool call runs inside one `exec` script. app-server reports no item for the
// script, only for the calls it makes, and the rollout records each of those as an `item_completed`
// once it ends. A direct call writes the same record after its own call record.
{
  const ts = "2026-11-23T18:49:24.000Z";
  const item = (i: Record<string, unknown>) => ({ timestamp: ts, type: "event_msg", payload: { type: "item_completed", thread_id: "th", turn_id: "t1", item: i } });
  const R = replay([
    { timestamp: ts, type: "event_msg", payload: { type: "task_started", turn_id: "t1" } },
    { timestamp: ts, type: "response_item", payload: { type: "custom_tool_call", status: "completed", call_id: "call_wrap", name: "exec", input: "const r = await tools.exec_command({cmd: \"cat notes.txt\"});\ntext(r.output);" } },
    item({ type: "CommandExecution", id: "exec-cmd", command: ["/usr/bin/zsh", "-lc", "cat notes.txt"], cwd: "file:///w/work", status: "completed", aggregated_output: "alpha\nbeta\n", exit_code: 0 }),
    item({ type: "CommandExecution", id: "exec-bad", command: ["/usr/bin/zsh", "-lc", "false"], cwd: "file:///w/work", status: "failed", aggregated_output: "", exit_code: 1 }),
    item({ type: "FileChange", id: "exec-patch", changes: { "/w/work/notes.txt": { type: "update", unified_diff: "@@ -1,2 +1,2 @@\n alpha\n-beta\n+gamma\n", move_path: null } }, status: "completed", stdout: "Success.", stderr: "" }),
    item({ type: "McpToolCall", id: "exec-mcp", server: "cotal", tool: "cotal_status", arguments: { state: "working" }, status: "completed", result: { content: [{ type: "text", text: "status set" }] } }),
    { timestamp: ts, type: "response_item", payload: { type: "custom_tool_call_output", call_id: "call_wrap", output: [{ type: "input_text", text: "Script completed" }] } },
    { timestamp: ts, type: "response_item", payload: { type: "function_call", name: "hello", namespace: "mcp__elicit", call_id: "toolu_1", arguments: "{}" } },
    item({ type: "McpToolCall", id: "toolu_1", server: "elicit", tool: "hello", arguments: {}, status: "completed", result: { content: [{ type: "text", text: "hello" }] } }),
    { timestamp: ts, type: "response_item", payload: { type: "function_call_output", call_id: "toolu_1", output: "hello" } },
    { timestamp: ts, type: "event_msg", payload: { type: "task_complete", turn_id: "t1", error: null } },
  ]);
  type Ev = { type: string; toolCallId?: string; toolCallName?: string; delta?: string; content?: string; cotal?: { isError?: boolean } };
  const evs = R.events as unknown as Ev[];
  const started = evs.filter((e) => e.type === "TOOL_CALL_START");
  const argsOf = (id: string) => JSON.parse(evs.find((e) => e.type === "TOOL_CALL_ARGS" && e.toolCallId === id)?.delta ?? "null") as unknown;
  const resultOf = (id: string) => evs.find((e) => e.type === "TOOL_CALL_RESULT" && e.toolCallId === id);
  c("code-mode:the exec script and its output publish nothing", !evs.some((e) => e.toolCallId === "call_wrap"), started);
  c("code-mode:a command the script ran is an exec_command call with its script and folder",
    started.some((e) => e.toolCallId === "exec-cmd" && e.toolCallName === "exec_command") && JSON.stringify(argsOf("exec-cmd")) === JSON.stringify({ cmd: "cat notes.txt", workdir: "/w/work" }), argsOf("exec-cmd"));
  c("code-mode:its output is the call's result", resultOf("exec-cmd")?.content === "alpha\nbeta\n" && resultOf("exec-cmd")?.cotal?.isError === false, resultOf("exec-cmd"));
  c("code-mode:a command that exits nonzero is a failed result", resultOf("exec-bad")?.cotal?.isError === true, resultOf("exec-bad"));
  c("code-mode:a file change is an apply_patch call with Codex's change list",
    started.some((e) => e.toolCallId === "exec-patch" && e.toolCallName === "apply_patch") &&
      JSON.stringify(argsOf("exec-patch")) === JSON.stringify({ changes: [{ path: "/w/work/notes.txt", kind: { type: "update" }, diff: "@@ -1,2 +1,2 @@\n alpha\n-beta\n+gamma\n" }] }), argsOf("exec-patch"));
  c("code-mode:an MCP call is a call to its tool with its arguments and result",
    started.some((e) => e.toolCallId === "exec-mcp" && e.toolCallName === "cotal_status") && JSON.stringify(argsOf("exec-mcp")) === JSON.stringify({ state: "working" }) && resultOf("exec-mcp")?.content === "status set", { args: argsOf("exec-mcp"), result: resultOf("exec-mcp") });
  c("code-mode:a direct call's item adds no second call", started.filter((e) => e.toolCallId === "toolu_1").length === 1, started);
  c("code-mode:brackets legal", R.bracketError === null, R.bracketError);
}

// ------------------------------------------------------- a plan, from the thread's delta journal
// A plan a code-mode script sets reaches app-server clients only as `turn/plan/updated`, which the
// seat journals as a plan record. A direct update_plan call already carries its plan in the rollout.
{
  const ts = "2026-11-23T19:45:10.000Z";
  const at = (r: CodexRecord): Merged<CodexRecord> => ({ harness: r });
  const planLine = (id: string, explanation: string | null): Merged<CodexRecord> => ({ deltas: [], timestamp: 5, records: [{ type: "plan", id, explanation,
    plan: [{ step: "read", status: "completed" }, { step: "fix", status: "inProgress" }] }] } as Merged<CodexRecord>);
  const start = at({ timestamp: ts, type: "event_msg", payload: { type: "task_started", turn_id: "t1" } });
  const done = at({ timestamp: ts, type: "event_msg", payload: { type: "task_complete", turn_id: "t1", error: null } });
  type Ev = { type: string; toolCallId?: string; toolCallName?: string; delta?: string; content?: string; cotal?: { isError?: boolean } };
  const merged = (values: Merged<CodexRecord>[]): Ev[] => {
    const mapper = createCodexMapper({ threadId: THREAD, mintRunId: () => "run-plan" });
    return values.flatMap((v) => unitOf(mapper.mapMerged(v))?.events ?? []) as unknown as Ev[];
  };
  const scripted = merged([start,
    at({ timestamp: ts, type: "response_item", payload: { type: "custom_tool_call", status: "completed", call_id: "call_wrap", name: "exec", input: "await tools.update_plan({...});" } }),
    planLine("plan_1", "read first"),
    at({ timestamp: ts, type: "response_item", payload: { type: "custom_tool_call_output", call_id: "call_wrap", output: [{ type: "input_text", text: "Script completed" }] } }),
    done]);
  const args = scripted.find((e) => e.type === "TOOL_CALL_ARGS" && e.toolCallId === "plan_1")?.delta;
  c("plan:a plan the script sets is an update_plan call", scripted.some((e) => e.type === "TOOL_CALL_START" && e.toolCallId === "plan_1" && e.toolCallName === "update_plan"),
    scripted.map((e) => e.type));
  c("plan:in update_plan's own arguments", args === JSON.stringify({ explanation: "read first", plan: [{ step: "read", status: "completed" }, { step: "fix", status: "in_progress" }] }), args);
  c("plan:and it ends with the result update_plan returns",
    scripted.some((e) => e.type === "TOOL_CALL_END" && e.toolCallId === "plan_1") && scripted.find((e) => e.type === "TOOL_CALL_RESULT" && e.toolCallId === "plan_1")?.content === "Plan updated",
    scripted.filter((e) => e.toolCallId === "plan_1"));
  const bare = merged([start, planLine("plan_4", null), done]).find((e) => e.type === "TOOL_CALL_ARGS")?.delta;
  c("plan:a plan with no explanation leaves it out", bare !== undefined && !("explanation" in (JSON.parse(bare) as object)), bare);
  const direct = merged([start,
    at({ timestamp: ts, type: "response_item", payload: { type: "function_call", name: "update_plan", call_id: "call_plan", arguments: '{"plan":[{"step":"read","status":"completed"}]}' } }),
    planLine("plan_2", null),
    at({ timestamp: ts, type: "response_item", payload: { type: "function_call_output", call_id: "call_plan", output: "Plan updated" } }),
    done]);
  const starts = direct.filter((e) => e.type === "TOOL_CALL_START").map((e) => e.toolCallId);
  c("plan:a direct update_plan call publishes its plan once, as itself", JSON.stringify(starts) === '["call_plan"]', starts);
  c("plan:a plan line read with no run open publishes nothing", merged([planLine("plan_3", null)]).length === 0);

  // A call the script makes starts as `item/started`, which the seat journals, and ends in the
  // rollout's `item_completed`. Shapes from a live codex 0.162 code-mode turn.
  const startedLine = (item: Record<string, unknown>): Merged<CodexRecord> => ({ deltas: [], timestamp: 6, records: [{ type: "started", item }] } as Merged<CodexRecord>);
  const ended = (item: Record<string, unknown>) => at({ timestamp: ts, type: "event_msg", payload: { type: "item_completed", thread_id: "th", turn_id: "t1", item } });
  const script = at({ timestamp: ts, type: "response_item", payload: { type: "custom_tool_call", status: "completed", call_id: "call_wrap", name: "exec", input: "..." } });
  const scriptDone = at({ timestamp: ts, type: "response_item", payload: { type: "custom_tool_call_output", call_id: "call_wrap", output: [{ type: "input_text", text: "Script completed" }] } });
  const cmdStarted = { type: "commandExecution", id: "exec-cmd", command: "/usr/bin/zsh -lc 'cat notes.txt'", cwd: "/w/work", processId: "3071", source: "unifiedExecStartup", status: "inProgress", aggregatedOutput: null, exitCode: null };
  const cmdEnded = { type: "CommandExecution", id: "exec-cmd", command: ["/usr/bin/zsh", "-lc", "cat notes.txt"], cwd: "file:///w/work", status: "completed", aggregated_output: "alpha\nbeta\n", exit_code: 0 };
  const running = merged([start, script, startedLine(cmdStarted)]);
  const runArgs = running.find((e) => e.type === "TOOL_CALL_ARGS" && e.toolCallId === "exec-cmd")?.delta;
  c("started:a command the script starts is published while it runs, with its script and folder",
    running.some((e) => e.type === "TOOL_CALL_START" && e.toolCallId === "exec-cmd" && e.toolCallName === "exec_command") &&
      runArgs === JSON.stringify({ cmd: "cat notes.txt", workdir: "/w/work" }) && !running.some((e) => e.type === "TOOL_CALL_RESULT"), running.map((e) => e.type));
  const whole = merged([start, script, startedLine(cmdStarted), ended(cmdEnded), scriptDone, done]);
  const ofCmd = whole.filter((e) => e.toolCallId === "exec-cmd").map((e) => e.type);
  c("started:its end publishes only its result", JSON.stringify(ofCmd) === JSON.stringify(["TOOL_CALL_START", "TOOL_CALL_ARGS", "TOOL_CALL_END", "TOOL_CALL_RESULT"]) &&
    whole.find((e) => e.type === "TOOL_CALL_RESULT")?.content === "alpha\nbeta\n", ofCmd);
  const brackets = new AguiBrackets();
  let bracketError: string | null = null;
  for (const e of whole) try { brackets.accept(e as unknown as AguiEvent); } catch (err) { bracketError ??= (err as Error).message; }
  c("started:brackets legal", bracketError === null, bracketError);
  const quoted = merged([start, script, startedLine({ ...cmdStarted, id: "exec-q", command: "/bin/bash -lc 'echo '\\''hi there'\\'' \"$HOME\"'" })])
    .find((e) => e.type === "TOOL_CALL_ARGS")?.delta;
  c("started:a quoted command reads back as the script it runs", quoted === JSON.stringify({ cmd: "echo 'hi there' \"$HOME\"", workdir: "/w/work" }), quoted);
  const patch = merged([start, script, startedLine({ type: "fileChange", id: "exec-patch", status: "inProgress",
    changes: [{ path: "/w/work/notes.txt", kind: { type: "update", move_path: null }, diff: "@@ -1,2 +1,2 @@\n alpha\n-beta\n+gamma\n" }] })]);
  c("started:a file change starts as apply_patch with Codex's change list",
    patch.find((e) => e.type === "TOOL_CALL_START")?.toolCallName === "apply_patch" && patch.find((e) => e.type === "TOOL_CALL_ARGS")?.delta ===
      JSON.stringify({ changes: [{ path: "/w/work/notes.txt", kind: { type: "update" }, diff: "@@ -1,2 +1,2 @@\n alpha\n-beta\n+gamma\n" }] }), patch);
  const mcp = merged([start, script, startedLine({ type: "mcpToolCall", id: "exec-mcp", server: "cotal", tool: "cotal_status", status: "inProgress", arguments: { state: "working" } })]);
  c("started:an MCP call starts under its tool's name with its arguments",
    mcp.find((e) => e.type === "TOOL_CALL_START")?.toolCallName === "cotal_status" && mcp.find((e) => e.type === "TOOL_CALL_ARGS")?.delta === JSON.stringify({ state: "working" }), mcp);
  const directStart = merged([start,
    at({ timestamp: ts, type: "response_item", payload: { type: "function_call", name: "hello", namespace: "mcp__elicit", call_id: "toolu_1", arguments: "{}" } }),
    startedLine({ type: "mcpToolCall", id: "toolu_1", server: "elicit", tool: "hello", status: "inProgress", arguments: {} }),
    at({ timestamp: ts, type: "response_item", payload: { type: "function_call_output", call_id: "toolu_1", output: "hello" } }), done]);
  c("started:a direct call's start publishes nothing", directStart.filter((e) => e.type === "TOOL_CALL_START").length === 1, directStart.map((e) => e.type));
  c("started:a start with no script running publishes nothing", merged([start, startedLine({ ...cmdStarted, id: "call_x" }), done]).every((e) => !e.type.startsWith("TOOL_CALL")));
  const late = merged([start, script, startedLine({ ...cmdStarted, id: "call_late" }),
    at({ timestamp: ts, type: "response_item", payload: { type: "function_call", name: "exec_command", call_id: "call_late", arguments: '{"cmd":"cat notes.txt"}' } }),
    at({ timestamp: ts, type: "response_item", payload: { type: "function_call_output", call_id: "call_late", output: "alpha" } }), scriptDone, done]);
  c("started:a call record read after its start publishes no second start",
    late.filter((e) => e.type === "TOOL_CALL_START" && e.toolCallId === "call_late").length === 1 && late.some((e) => e.type === "TOOL_CALL_RESULT" && e.toolCallId === "call_late"), late.map((e) => `${e.type}:${e.toolCallId}`));
}

// The census is printed, not just asserted: a reader who sees "28 passed" learns nothing about
// whether the fixture had anything in it, and a cell count is not a coverage claim.
{
  let census = "[fixture: census unavailable, the replay threw]";
  try {
    const R = replay(records);
    const k = kinds(R.events);
    const emitted = R.perRecord.filter((x) => x !== null).length;
    census =
      `[fixture: ${records.length} records from one real app-server thread, ${emitted} mapped, ` +
      `${records.length - emitted} dropped, runs ${R.runs.length}, events ${JSON.stringify(k)}]`;
  } catch (e) {
    c("census:the real thread replays without throwing", false, { thrown: (e as Error).message });
  }
  console.log(`agui-codex-map smoke: ${pass} passed, ${fail} failed  ${census}`);
}

if (fail > 0) process.exit(1);
