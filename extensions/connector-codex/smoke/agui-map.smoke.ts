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
 *   `shape:`  asserted against a record built from the MEASURED key-shape census of 34 394 corpus
 *             records (field names, types and presence counts). The shapes are measured; the
 *             particular record is not real. An exhausted model quota on this account is why, and the
 *             connector live end-to-end proof supersedes every one of these.
 *
 * Never prints record content: cells report counts, type names and ids.
 *
 * Run: `pnpm smoke:agui-codex-map`
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { AguiBrackets, type AguiEvent } from "@cotal-ai/connector-core";
import { createCodexMapper, type CodexRecord } from "../src/agui-map.js";

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
function replay(recs: CodexRecord[]): {
  events: AguiEvent[];
  perRecord: ({ runId: string; events: AguiEvent[] } | null)[];
  bracketError: string | null;
  runs: string[];
} {
  let n = 0;
  const mapper = createCodexMapper({ threadId: THREAD, mintRunId: () => `run-${++n}` });
  const brackets = new AguiBrackets();
  const events: AguiEvent[] = [];
  const perRecord: ({ runId: string; events: AguiEvent[] } | null)[] = [];
  const runs: string[] = [];
  let bracketError: string | null = null;
  for (const r of recs) {
    const out = mapper.map(r);
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

  const withReasoning = replay([
    start,
    { timestamp: ts, type: "response_item", payload: { type: "reasoning", id: "r1", encrypted_content: "OPAQUE", summary: [{ type: "summary_text", text: "thinking" }] } },
    done,
  ]);
  const kr = kinds(withReasoning.events);
  c("shape:a reasoning record becomes REASONING START/CONTENT/END", kr.REASONING_MESSAGE_START === 1 && kr.REASONING_MESSAGE_CONTENT === 1 && kr.REASONING_MESSAGE_END === 1, kr);
  const deltas = withReasoning.events
    .filter((e) => (e as { type: string }).type === "REASONING_MESSAGE_CONTENT")
    .map((e) => (e as { delta: string }).delta);
  c("shape:encrypted_content is NEVER published", deltas.every((d) => !d.includes("OPAQUE")), { deltas: deltas.length });

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

  // THE UNION. `output` is a string on 6 353 corpus records and a list on 380. A mapper that
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
