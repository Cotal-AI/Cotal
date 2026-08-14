/**
 * §3.1's mapping, driven against a REAL Claude session JSONL — not a fixture.
 *
 * **Why a real session is the requirement and not a preference.** This lane's founding defect was a
 * class whose entire purpose was "never consume a partial record" passing a full mutation sweep,
 * because every hand-written fixture happened to end on a record boundary. A fixture author writes
 * the records the spec describes; a real session contains the records the harness actually emits.
 * Everything this suite found, it found in the gap between those two sets.
 *
 * ---------------------------------------------------------------------------------------------
 * THREE RULES GOVERN WHAT THIS SUITE MAY READ AND SAY. **RULES 1 AND 2 ARE INDEPENDENT CONTROLS
 * AND NEITHER IS REDUNDANT WITH THE OTHER — do not remove one on the grounds that the other covers
 * it.** Rule 1 bounds WHICH files may be opened; rule 2 bounds WHAT may leave this process. A
 * suite that obeyed only rule 1 would still print the contents of whatever it was pointed at; a
 * suite that obeyed only rule 2 would still open files it has no business opening, and "we read it
 * but printed nothing" is not a defence for reading it. They fail in different directions.
 *
 *   1. **Never glob a session directory.** A session is addressed by an exact path, and the one
 *      this lane runs it against is a session it GENERATED ITSELF in a scratch project. Walking
 *      `~/.claude/projects/` would make the suite's input whatever the operator happened to be
 *      doing that afternoon.
 *   2. **Never print record content.** Failures report counts, byte offsets, type names and key
 *      names. Never a text body, a prompt, a tool input, or a tool result. A smoke that dumps the
 *      offending record on failure is a content exfiltration path that only fires when something
 *      goes wrong, which is the worst possible time for it to fire.
 *   3. **Another session only behind an explicit env var, never a default and never a glob.**
 *      `COTAL_AGUI_SESSION` names one file. There is no search, no "latest", no directory.
 * ---------------------------------------------------------------------------------------------
 *
 * **This suite is deliberately NOT in `smoke:ci`, and that limit is stated rather than hidden.** It
 * needs a real session file, and the capture is not committed: a genuine session carries the
 * operator's local skill/command inventory in its context records, and committing one would both
 * publish that and freeze the shape the plan requires to stay real. So a green from this suite is
 * only ever a claim about the session it names, and it names it.
 *
 * **What this suite does NOT re-prove: that the emitted events conform to the AG-UI schemas.** The
 * mapper never hand-builds an event object — every event leaves through a `connector-core`
 * constructor, and `agui-conformance.smoke.ts` parses every one of those constructors' output with
 * the real zod schema that owns it. Re-parsing here would be a second mechanism preventing one
 * outcome, and this lane's rule is that two mechanisms make a cell asserting the outcome prove
 * neither. What is unproven WITHOUT a real session, and therefore what this suite is for, is
 * SELECTION (which records become events), IDENTITY (what the ids are keyed on), and BRACKETING
 * (whether the sequence a real session produces is well-formed).
 *
 * MUTATION LEDGER — verdicts as NAMES, never counts, and **this header goes stale silently every
 * time a cell is added, so re-measure before trusting it**. All restores verified by the tool, and
 * the tree swept clean afterwards with an instrument first proven able to see dirt (plant → detect
 * → remove); "clean" is also what a blind sweep returns.
 *
 * **THE ARM IS PART OF EACH VERDICT.** `[A]` is the 30-record headless capture, `[B]` the
 * 5938-record interactive one. A kill on `[A]` says little about a cell whose subject barely occurs
 * there: the tool-call and bracket cells see a handful of blocks on `[A]` and hundreds on `[B]`, so
 * grading them on `[A]` alone would have been the "green list you choose" mistake in miniature.
 *
 *   M1  [A] pass `signature` into `reasoningMessageContent`  -> **SURVIVED**, and that is recorded
 *       rather than deleted: the constructor returns an explicit field literal (`agui.ts:882`), so
 *       an unknown ARGUMENT key cannot reach the output at all. The outcome cell was riding a
 *       barrier it did not assert. It is why `mechanism:*` exists, and M1 stays in the ledger
 *       because a survivor that produced a fix is the most useful line in it.
 *   M1b [A] put the signature into `cotal` instead (the real channel — passed by reference)
 *       -> KILLED `real:no-signature-KEY-is-emitted-by-any-event-of-a-real-session`
 *   M2  [A] skip thinking blocks that carry a signature
 *       -> KILLED `real:a-signed-thinking-block-still-EMITS-its-reasoning-minus-the-signature`
 *   M3  [A] force the read offset to 0 -> **WRONG-RED**, not a kill: the seal is verified at the
 *       cursor offset (`durable-source.ts:206`), so it threw before reaching the cell it named.
 *       Red is not proof, and the tool refusing to score it is the only reason that is known.
 *   M3b [A] make each record's cursor point at its own START instead of its end
 *       -> KILLED `source:resuming-from-record-k-yields-exactly-the-records-after-k`
 *   M4  [A] drop the `origin.kind === "human"` test from the prompt rule
 *       -> KILLED `defect-B:so-the-rule-AS-SPECIFIED-opens-no-run-on-THIS-real-session`
 *       **STALE: that cell no longer exists.** The A/B split replaced the `defect-B:*` block, so
 *       this row grades a suite that is gone. Kept visible rather than deleted, because a ledger
 *       row silently outliving its cell is exactly the drift this header warns about — and it is
 *       re-run below as M8 against what replaced it.
 *   M5  [A] make the constructor spread its input (`...o`)
 *       -> KILLED `mechanism:the-event-constructor-DROPS-an-unknown-key`
 *   M6  [B] drop `TOOL_CALL_END` — graded on B because A carries too few tool blocks for the cell
 *       to be doing work -> KILLED `real:every-tool_use-block-became-a-START-ARGS-END-triple`
 *   M7  [B] make the RESULT name an id no START opened
 *       -> KILLED `real:every-RESULT-names-a-toolCallId-that-a-START-opened`
 *
 *   M8  [B] open a run on any string-content entry (drop the `promptSource` test)
 *       -> PREDICTED to kill `split:every-run-opened-came-from-a-promptSource-bearing-record`
 *          [PENDING EXECUTION — this row is a prediction, not a verdict]
 *   M9  [B] drop the compaction-summary exclusion
 *       -> PREDICTED to SURVIVE, as a redundancy rather than a hole.
 *          [PENDING EXECUTION — this row is a prediction, not a verdict] The compaction summary carries
 *       no `promptSource` either, so the run-opening test already excludes it on every capture
 *       available and the positive marker is a second mechanism guarding the same outcome. It is
 *       KEPT — a harness that starts stamping `promptSource` on compaction records would make it
 *       load-bearing overnight — but **no cell here proves it works**, and claiming otherwise would
 *       repeat M1 exactly. Graded by nothing; said so rather than left to look covered.
 *
 * **⚠️ THE HUMAN ARM IS DECLARED-UNMEASURED.** Every capture available contains ZERO human-typed
 * prompts — `~/.claude/history.jsonl` reports 0 for all three sessions and 0 for this project — so
 * `UNMEASURED:a-spec-shaped-human-prompt-opens-a-run-attributed-human` drives a record built from
 * §3.1's measurement rather than read from a file. **It grades the code path, not the harness's real
 * shape. A green here must NOT be read as "human prompts work."**
 *
 * **ALSO NOT GRADED:** no mutation aimed at the bracket cell on either arm.
 *
 * Run: pnpm smoke:agui-map           (needs a session; see the refusal message)
 */
import { readFileSync, existsSync, writeFileSync, appendFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AguiBrackets, reasoningMessageContent, type AguiEvent } from "../../connector-core/src/agui.js";
import { JsonlFileSource } from "../../connector-core/src/durable-source.js";
import { createClaudeMapper, type ClaudeEntry } from "../src/agui-map.js";

let pass = 0;
let fail = 0;
const c = (n: string, v: boolean, extra?: unknown): void => {
  if (v) {
    pass += 1;
    return;
  }
  fail += 1;
  // Rule 2 lives HERE, at the only place a failure can print anything. `extra` is supplied by each
  // cell as counts/names; nothing in this file passes a record or an event body into it.
  console.error(`  x FAIL: ${n}${extra === undefined ? "" : ` ${JSON.stringify(extra)}`}`);
};

/**
 * The session under test. Rule 3, taken literally: ONE exact path from ONE env var. No glob, no
 * directory walk, no "most recent" — and **no default**, because a default path is a default, and a
 * checked-in one would also be a machine-specific string in a public tree.
 */
const SESSION = process.env.COTAL_AGUI_SESSION ?? "";

if (SESSION === "" || !existsSync(SESSION)) {
  // No fallback to a fixture. A mapping suite that quietly degraded to hand-written records would
  // be asserting exactly the thing the plan forbids it to assert.
  console.error(
    `agui-map smoke: COTAL_AGUI_SESSION names no readable session JSONL, so there is nothing real ` +
      `to map.\n` +
      `  This suite refuses rather than falling back to a fixture.\n` +
      `  Produce one:  mkdir -p /tmp/agui-scratch-session && cd /tmp/agui-scratch-session &&\n` +
      `                claude -p "<some prompt that uses a tool>" --allowedTools Read,Bash\n` +
      `  Or name one:  COTAL_AGUI_SESSION=/exact/path/to/<session>.jsonl pnpm smoke:agui-map`,
  );
  process.exit(1);
}

const THREAD = "sess-under-test";
let minted = 0;
const mint = (): string => `run-${(minted += 1)}`;

// ---------------------------------------------------------------------------------------------
// PART 1 — the real session, read through the SHIPPED durable source.
//
// Read through `JsonlFileSource` rather than `readFileSync().split()` on purpose: the production
// path is the one that has to survive a partial trailing record, and a suite that split the file
// itself would be grading a reader nothing ships.
//
// **ADOPT-THEN-APPEND, because a fresh adopt is not a read of the file.** An earlier revision of
// this suite called `source.read(undefined)` and asserted it returned every record. It returns
// ZERO — `undefined` is a fresh adopt, defined at `durable-source.ts:179` to start at the last
// complete record boundary rather than replay history, which is what an emitter attaching to a
// live session must do. Against a real 30-record session that read 0 and took eleven downstream
// cells with it. The suite was wrong, not the source.
//
// So the session is driven through the shape production actually has: adopt an EMPTY file, then
// let the records arrive. The real session's bytes are appended to the adopted file (same inode —
// the cursor is bound to `<dev>:<ino>` and a replacement is refused by design), and the read
// resumes from the adopt cursor. No cursor is hand-built here: constructing a `<dev>:<ino>:0:<seal>`
// string would mean re-implementing `sealAt`, which is the same sin as splitting the file myself.
// ---------------------------------------------------------------------------------------------
const raw = readFileSync(SESSION);
const rawLines = raw.toString("utf8").split("\n").filter((l) => l.trim() !== "").length;

const replay = join(mkdtempSync(join(tmpdir(), "agui-map-")), "session.jsonl");
writeFileSync(replay, "");
const source = new JsonlFileSource<ClaudeEntry>(replay);

const adopt = await source.read(undefined);
c("source:a-fresh-adopt-yields-NO-records", adopt.records.length === 0, { records: adopt.records.length });

appendFileSync(replay, raw);
const read = await source.read(adopt.cursor);

c("source:reads-every-complete-record", read.records.length === rawLines, {
  viaSource: read.records.length,
  completeLines: rawLines,
});
// A cursor is OPAQUE (`durable-source.ts:14`), so the thing to assert is the property the contract
// actually promises — RESUMABILITY — not an ordering of the token's bytes.
//
// The cell that used to sit here compared cursors with `>`, i.e. lexicographically. It failed on a
// real session at record 3, where the offset goes 902 -> 2767: strictly increasing as a number,
// inverted as a string. It was asserting a property of the ENCODING that the interface declines to
// promise, and it would have gone red on any session crossing a digit-width boundary — which is to
// say, essentially all of them. That is the "comment asserting something outside its own function"
// rule applied to a cell: the suite does not get to know what is inside the token.
c("source:cursors-are-distinct-per-record", new Set(read.records.map((r) => r.cursor)).size === read.records.length, {
  records: read.records.length,
});

// Resume from record k and require exactly the records after k. That is the property the contract
// promises and the one production depends on.
//
// THE CAP IS REAL AND IT IS NAMED, because a silent cap reads as "covered everything". Each read
// returns the WHOLE remainder, so walking every k is quadratic in bytes — on a 9.6MB session that
// is tens of GB of reads and the suite simply stops finishing. So: every k up to `FULL_WALK`, and
// above it a deterministic subset that always includes both ends and **every offset digit-width
// transition** — those transitions are exactly where the lexicographic cell this replaced actually
// broke (902 -> 2767), so the sample is chosen to contain the known failure shape rather than to be
// evenly spread. `walked` is reported so a green states how much of the session it walked.
const FULL_WALK = 200;
const ks: number[] = (() => {
  const n = read.records.length;
  if (n <= FULL_WALK) return [...Array(n).keys()];
  const off = (i: number): number => Number(read.records[i]!.cursor.split(":")[2]);
  const picked = new Set<number>([0, 1, n - 2, n - 1]);
  for (let i = 1; i < n; i += 1)
    if (String(off(i)).length !== String(off(i - 1)).length) { picked.add(i - 1); picked.add(i); }
  for (let i = 0; i < n; i += Math.ceil(n / 50)) picked.add(i);
  return [...picked].filter((i) => i >= 0 && i < n).sort((a, b) => a - b);
})();

c("source:resuming-from-record-k-yields-exactly-the-records-after-k", await (async () => {
  for (const k of ks) {
    const rest = await source.read(read.records[k]!.cursor);
    if (rest.records.length !== read.records.length - k - 1) return false;
    // Identity, not just count: the first record back must be the one that followed k.
    if (rest.records.length > 0 && rest.records[0]!.cursor !== read.records[k + 1]!.cursor) return false;
  }
  return read.records.length > 1 && ks.length > 1;
})(), { records: read.records.length, walked: ks.length, full: read.records.length <= FULL_WALK });

const entries = read.records.map((r) => r.value);
const typeHist = new Map<string, number>();
for (const e of entries) typeHist.set(String(e.type), (typeHist.get(String(e.type)) ?? 0) + 1);

c("session:is-a-multi-turn-session-with-tool-use", (() => {
  let toolUse = 0;
  let toolResult = 0;
  for (const e of entries) {
    const content = e.message?.content;
    if (!Array.isArray(content)) continue;
    for (const b of content) {
      if (b.type === "tool_use") toolUse += 1;
      if (b.type === "tool_result") toolResult += 1;
    }
  }
  return toolUse >= 2 && toolResult >= 2 && (typeHist.get("assistant") ?? 0) >= 4;
})(), { types: [...typeHist] });

// ---------------------------------------------------------------------------------------------
// PART 2 — RUN-OPENING AND ATTRIBUTION ARE TWO PREDICATES, AND THIS BLOCK ASSERTS THE SPLIT.
//
// HISTORY, kept because the cells only make sense against it. §3.1 opened a run only on
// `origin.kind === "human"`, which made one provenance predicate do two jobs: a turn started by a
// peer produced NO RUN, so an agent-driven session mapped to nothing at all. Three real sessions
// (5938 / 30 / 1088 records) contain ZERO human-typed prompts — confirmed independently by
// `~/.claude/history.jsonl`, which records typed prompts by a different mechanism and reports 0 for
// all three — so on this fleet's workload the connector emitted nothing.
//
// That is a COVERAGE gap, not a bad token: §3.1's own session measured `kind:"human"` 44 times
// beside 3068 `kind:"channel"` injections, so the predicate does select on a session containing
// what it selects. Ruled: run-opening keys on `promptSource` PRESENT — a positive marker, present
// on all 67 mesh deliveries and both sdk prompts, absent on all 824 tool results and on the
// compaction summary — and provenance becomes a FIELD (`cotal.turnSource`), never a gate.
//
// **AND THE REPAIR THAT WAS NOT TAKEN, recorded so nobody re-derives it:** "origin absent = human"
// selects 825 of the interactive session's 892 user entries, because in a Claude session `user` is
// also the role of a TOOL RESULT. The one non-tool-result among those 825 is a context-compaction
// summary, so the true human count is 0 and the predicate over-matches by 825 — a flood that would
// have looked like the connector working.
// ---------------------------------------------------------------------------------------------
// Exactly one synthetic record in the whole suite. It carries BOTH `origin.kind:"human"` and
// `promptSource:"typed"`, which is the shape §3.1 measured 44 of — not a shape invented here.
const OPENER: ClaudeEntry = {
  type: "user",
  uuid: "synthetic-opener",
  timestamp: "2026-08-14T21:00:00.000Z",
  origin: { kind: "human" },
  promptSource: "typed",
  message: { content: "open the run" },
};

const asSpecified = createClaudeMapper({ threadId: THREAD, mintRunId: mint, now: () => 0 });
const asSpecifiedUnits = entries.map((e) => asSpecified.map(e)).filter((u) => u !== null);
// Observed vocabularies, reported so a failure names what it actually met. KEY/ENUM names only.
const originKinds = [...new Set(entries.map((e) => (e.origin === undefined ? "<absent>" : `kind=${String(e.origin.kind)}`)))].sort();
const promptSources = [...new Set(entries.map((e) => e.promptSource ?? "<absent>"))].sort();

c("split:the-real-session-DOES-open-runs-without-a-synthetic-opener", asSpecifiedUnits.length > 0, {
  units: asSpecifiedUnits.length,
  records: entries.length,
  originKinds,
  promptSources,
});

// THE NEGATIVE TWIN. Without it, "opens runs" is satisfied by a mapper that opens one on every
// record — which is precisely the 825-over-match, and nothing above could fail that way.
c("split:a-tool-result-opens-NO-run", (() => {
  let n = 0;
  const m = createClaudeMapper({ threadId: THREAD, mintRunId: () => `run-${(n += 1)}`, now: () => 0 });
  const before = m.openRun();
  const unit = m.map({
    type: "user",
    uuid: "tool-result-entry",
    timestamp: "2026-08-14T21:00:02.000Z",
    message: { content: [{ type: "tool_result", tool_use_id: "toolu_never_started", content: "x" }] },
  } as ClaudeEntry);
  return before === null && m.openRun() === null && unit === null;
})());

// And the same claim over the REAL population rather than one hand-built record: every run opened
// across the session must come from a record carrying `promptSource`. A count is not enough here —
// the mapper could open the right NUMBER of runs off the wrong records.
c("split:every-run-opened-came-from-a-promptSource-bearing-record", (() => {
  let n = 0;
  const m = createClaudeMapper({ threadId: THREAD, mintRunId: () => `run-${(n += 1)}`, now: () => 0 });
  let opens = 0;
  for (const e of entries) {
    const was = m.openRun();
    m.map(e);
    const now2 = m.openRun();
    if (now2 !== null && now2 !== was) {
      opens += 1;
      if (e.promptSource === undefined) return false;
      if (e.isCompactSummary === true || e.isVisibleInTranscriptOnly === true) return false;
    }
  }
  return opens > 0;
})(), { userEntries: typeHist.get("user") ?? 0 });

// ATTRIBUTION IS CARRIED, and it is the half that used to be a gate.
c("split:every-RUN_STARTED-carries-a-cotal.turnSource", (() => {
  let n = 0;
  const m = createClaudeMapper({ threadId: THREAD, mintRunId: () => `run-${(n += 1)}`, now: () => 0 });
  const starts = entries.flatMap((e) => m.map(e)?.events ?? []).filter((e) => e.type === "RUN_STARTED");
  return starts.length > 0 && starts.every((s) => typeof (s as { cotal?: { turnSource?: string } }).cotal?.turnSource === "string");
})());

// FAILS LOUD on an unseen provenance — asserted as a REFUSAL, and asserting WHICH refusal. A
// mapper that threw on everything would satisfy a bare "it threw", so the message is matched and a
// control requires the same path to SUCCEED on a provenance that is known.
c("split:an-unseen-origin.kind-REFUSES-rather-than-guessing", (() => {
  let n = 0;
  const m = createClaudeMapper({ threadId: THREAD, mintRunId: () => `run-${(n += 1)}`, now: () => 0 });
  try {
    m.map({ ...OPENER, uuid: "future-harness", origin: { kind: "telepathy" } } as ClaudeEntry);
    return false;
  } catch (err) {
    return /unrecognised origin\.kind/.test((err as Error).message);
  }
})());
c("control:a-KNOWN-origin.kind-on-the-same-path-does-NOT-refuse", (() => {
  let n = 0;
  const m = createClaudeMapper({ threadId: THREAD, mintRunId: () => `run-${(n += 1)}`, now: () => 0 });
  try {
    return m.map({ ...OPENER, uuid: "known-origin", origin: { kind: "channel" } } as ClaudeEntry) !== null;
  } catch {
    return false;
  }
})());

// ⚠️ THE HUMAN ARM IS DECLARED-UNMEASURED. Every capture available contains zero human-typed
// prompts, so this cell drives a record built from §3.1's measurement rather than read from a file.
// It grades the code path and NOT the harness's real shape, and saying so is the point: a green
// here must not be read as "human prompts work".
c("UNMEASURED:a-spec-shaped-human-prompt-opens-a-run-attributed-human", (() => {
  let n = 0;
  const m = createClaudeMapper({ threadId: THREAD, mintRunId: () => `run-${(n += 1)}`, now: () => 0 });
  const unit = m.map(OPENER);
  const start = unit?.events.find((e) => e.type === "RUN_STARTED");
  return (start as { cotal?: { turnSource?: string } } | undefined)?.cotal?.turnSource === "human";
})());

// ---------------------------------------------------------------------------------------------
// PART 3 — the real records, read straight through. THE CRUTCH IS GONE.
//
// This block used to prepend one synthetic prompt because nothing in a real session could open a
// run. The comment promised it would "lose its synthetic head" once the prompt rule was ruled on;
// the rule is ruled and the head is removed, so every event below now comes from the session's own
// bytes and nothing else. A declared crutch that outlives its reason stops being declared and
// starts being a fixture.
// ---------------------------------------------------------------------------------------------
const run = (opts?: { reasoning?: boolean }): { runId: string; events: AguiEvent[] }[] => {
  let n = 0;
  const m = createClaudeMapper({
    threadId: THREAD,
    mintRunId: () => `run-${(n += 1)}`,
    now: () => 0,
    ...(opts?.reasoning ? { reasoning: true } : {}),
  });
  return entries.map((e) => m.map(e)).filter((u): u is { runId: string; events: AguiEvent[] } => u !== null);
};

const units = run();
const events = units.flatMap((u) => u.events);

c("real:the-real-records-DO-map-once-a-run-is-open", units.length >= 4 && events.length >= 12, {
  units: units.length,
  events: events.length,
});

// The bracket machine is the shipped one, fed the real sequence in the real order. This is the
// assertion the plan's "verified against a real session" is actually about: a sequence that a real
// harness produced has to be well-formed, and no fixture can establish that.
c("real:the-WHOLE-real-sequence-brackets", (() => {
  const br = new AguiBrackets();
  try {
    for (const e of events) br.accept(e);
    return true;
  } catch (err) {
    c("  bracket-refusal", false, { at: (err as Error).name });
    return false;
  }
})(), { events: events.length });

const typesOf = (t: string): number => events.filter((e) => e.type === t).length;

c("real:every-tool_use-block-became-a-START-ARGS-END-triple", (() => {
  let toolUse = 0;
  for (const e of entries) {
    const content = e.message?.content;
    if (Array.isArray(content)) for (const b of content) if (b.type === "tool_use") toolUse += 1;
  }
  return toolUse > 0 && typesOf("TOOL_CALL_START") === toolUse && typesOf("TOOL_CALL_ARGS") === toolUse && typesOf("TOOL_CALL_END") === toolUse;
})(), { start: typesOf("TOOL_CALL_START"), args: typesOf("TOOL_CALL_ARGS"), end: typesOf("TOOL_CALL_END") });

c("real:every-tool_result-block-became-a-RESULT", (() => {
  let results = 0;
  for (const e of entries) {
    const content = e.message?.content;
    if (Array.isArray(content)) for (const b of content) if (b.type === "tool_result") results += 1;
  }
  return results > 0 && typesOf("TOOL_CALL_RESULT") === results;
})(), { results: typesOf("TOOL_CALL_RESULT") });

c("real:every-RESULT-names-a-toolCallId-that-a-START-opened", (() => {
  const opened = new Set(events.filter((e) => e.type === "TOOL_CALL_START").map((e) => (e as { toolCallId: string }).toolCallId));
  const results = events.filter((e) => e.type === "TOOL_CALL_RESULT") as { toolCallId: string }[];
  return results.length > 0 && results.every((r) => opened.has(r.toolCallId));
})());

// IDENTITY. This is the `message.id` defect: a provider request id repeats across entries and
// across block types, so spending it as `messageId` opens and closes one id repeatedly. Keyed on
// `${uuid}#${blockIndex}` it cannot.
c("real:no-messageId-is-opened-twice", (() => {
  const seen = new Set<string>();
  for (const e of events) {
    if (e.type !== "TEXT_MESSAGE_START" && e.type !== "REASONING_MESSAGE_START") continue;
    const id = (e as { messageId: string }).messageId;
    if (seen.has(id)) return false;
    seen.add(id);
  }
  return seen.size > 0;
})());

c("real:the-provider-message-id-DOES-repeat-in-this-session", (() => {
  // The control for the cell above: if the provider ids were unique here, keying on them would have
  // passed too, and the previous cell would prove nothing about the choice.
  const ids = entries.filter((e) => e.type === "assistant").map((e) => e.message?.id).filter(Boolean);
  return ids.length > new Set(ids).size;
})(), { assistantEntries: typeHist.get("assistant") ?? 0 });

c("real:the-provider-id-is-CARRIED-as-metadata-rather-than-discarded", (() => {
  const withMeta = events.filter((e) => (e as { cotal?: { providerMessageId?: string } }).cotal?.providerMessageId);
  return withMeta.length > 0;
})());

// §7 Q1 / §3.5 — reasoning is off by default, and the signature never leaves, at any setting.
c("real:reasoning-is-OFF-by-default", typesOf("REASONING_MESSAGE_START") === 0);
c("real:reasoning-is-emitted-when-asked", (() => {
  const on = run({ reasoning: true }).flatMap((u) => u.events);
  let thinking = 0;
  for (const e of entries) {
    const content = e.message?.content;
    if (Array.isArray(content)) for (const b of content) if (b.type === "thinking") thinking += 1;
  }
  return thinking > 0 && on.filter((e) => e.type === "REASONING_MESSAGE_START").length === thinking;
})());
// Asserted on the reasoning-ON stream, because OFF proves nothing about a field that only exists
// beside the content this setting emits.
//
// **BY KEY, AND THE PREVIOUS VERSION ONLY SAID SO.** It read
// `!JSON.stringify(on).includes("signature")` under a comment claiming "by KEY, not by value" — a
// substring test over keys AND values alike. On the real 5938-record session it went RED with 29
// hits and ZERO of them a key: the word appears in the reasoning text, because the session is about
// WAL seals and signing. A cell that reddens on what the operator was thinking ABOUT is a cell that
// gets ignored, and the comment asserting a property the code did not have is the "test nobody
// wrote" rule landing on a suite instead of on source.
const signatureKeys = (v: unknown): number => {
  if (Array.isArray(v)) return v.reduce<number>((n, x) => n + signatureKeys(x), 0);
  if (v && typeof v === "object")
    return Object.entries(v).reduce((n, [k, val]) => n + (k === "signature" ? 1 : 0) + signatureKeys(val), 0);
  return 0;
};

// CONTROL FIRST, and it is the inverse of the predicate: a walker that can never find the key
// reports zero for a mapper that leaks and a mapper that does not, and the two are indistinguishable
// from the counting side. So prove the instrument can fail before trusting it to pass.
c("control:the-key-walker-DOES-find-a-signature-key-when-one-is-present",
  signatureKeys([{ type: "REASONING_MESSAGE_CONTENT", delta: "x", signature: "sig" }]) === 1);
c("control:and-does-NOT-fire-on-the-word-in-a-value",
  signatureKeys([{ type: "REASONING_MESSAGE_CONTENT", delta: "the signature is sealed" }]) === 0);

// THE TWO MECHANISMS, ASSERTED SEPARATELY — because a cell on the OUTCOME alone proves neither,
// and this suite found that out by mutation rather than by reasoning about it.
//
// A mutation that passed `signature` straight into `reasoningMessageContent` SURVIVED: the
// constructor builds an explicit field literal (`agui.ts:882`), so an unknown key is structurally
// dropped and the leak could never reach the output through that argument at all. The outcome cell
// below was therefore riding on a barrier it was not testing. `cotal` is the OTHER story — it is
// passed through by reference, so it is a real channel a key can travel down, and it is the one the
// mapper has to be trusted not to use for this.
c("mechanism:the-event-constructor-DROPS-an-unknown-key", (() => {
  const e = reasoningMessageContent({ messageId: "m", delta: "d", timestamp: 0, signature: "SIG" } as never);
  return signatureKeys([e]) === 0;
})());
c("mechanism:but-cotal-meta-IS-a-passthrough-channel-a-key-can-travel-down", (() => {
  const e = reasoningMessageContent({ messageId: "m", delta: "d", timestamp: 0, cotal: { signature: "SIG" } as never });
  return signatureKeys([e]) === 1;
})());

// Scoped to what a key walk can actually establish: no signature FIELD is emitted. A signature
// pasted into a text VALUE would not be caught here, and deliberately so — checking values is what
// produced 29 false hits on the word in reasoning text. The claim is the field, and it says so.
c("real:no-signature-KEY-is-emitted-by-any-event-of-a-real-session", (() => {
  const on = run({ reasoning: true }).flatMap((u) => u.events);
  return on.length > 0 && signatureKeys(on) === 0;
})());

// And the mapper drops the field rather than the block: a mapper that skipped every signed thinking
// block would also emit no signature key, and would pass the cell above for the wrong reason.
c("real:a-signed-thinking-block-still-EMITS-its-reasoning-minus-the-signature", (() => {
  let n = 0;
  const m = createClaudeMapper({ threadId: THREAD, mintRunId: () => `run-${(n += 1)}`, now: () => 0, reasoning: true });
  m.map(OPENER);
  const unit = m.map({
    type: "assistant",
    uuid: "signed-thinking",
    timestamp: "2026-08-14T21:00:01.000Z",
    message: { id: "msg-signed", content: [{ type: "thinking", thinking: "deliberating", signature: "SIG-DO-NOT-EMIT" }] },
  } as ClaudeEntry);
  const ev = unit?.events ?? [];
  return ev.some((e) => e.type === "REASONING_MESSAGE_CONTENT") && signatureKeys(ev) === 0;
})());

// SELECTION. The classes §3.1 drops must actually be dropped, and the count is the evidence: a
// majority of a real session maps to nothing, which is `[P7]`'s common path rather than an edge.
c("real:the-non-conversational-record-types-map-to-nothing", (() => {
  const dropped = ["attachment", "queue-operation", "ai-title", "last-prompt", "mode"];
  const m = createClaudeMapper({ threadId: THREAD, mintRunId: mint, now: () => 0 });
  m.map(OPENER);
  return entries.filter((e) => dropped.includes(String(e.type))).every((e) => m.map(e) === null);
})(), { types: [...typeHist] });

c("real:the-majority-of-this-session-maps-to-nothing", (() => {
  const m = createClaudeMapper({ threadId: THREAD, mintRunId: mint, now: () => 0 });
  m.map(OPENER);
  const nulls = entries.filter((e) => m.map(e) === null).length;
  return nulls > entries.length / 2;
})(), { records: entries.length });

// BRACKET SEAM. `closeOpenRun` is the vehicle a ruling plugs the `Stop` hook into (defect A).
{
  const m = createClaudeMapper({ threadId: THREAD, mintRunId: () => "r-close", now: () => 0 });
  m.map(OPENER);
  c("seam:closeOpenRun-closes-the-open-run", (() => {
    const closed = m.closeOpenRun(5);
    return closed !== null && closed.runId === "r-close" && closed.events.length === 1 && closed.events[0]!.type === "RUN_FINISHED";
  })());
  c("seam:closeOpenRun-is-idempotent-and-cannot-manufacture-a-second-RUN_FINISHED", m.closeOpenRun(6) === null);
  c("seam:and-the-run-really-is-closed-afterwards", m.openRun() === null);
}

// The last-run-never-closes consequence, pinned so it is not discovered by a consumer.
c("real:the-LAST-run-of-the-session-is-still-open-at-EOF", (() => {
  let n = 0;
  const m = createClaudeMapper({ threadId: THREAD, mintRunId: () => `r-${(n += 1)}`, now: () => 0 });
  for (const e of entries) m.map(e);
  return m.openRun() !== null;
})());

console.log(`agui-map smoke: ${pass} passed, ${fail} failed  [session: ${SESSION.split("/").pop()}, ${entries.length} records]`);
process.exit(fail === 0 ? 0 : 1);
