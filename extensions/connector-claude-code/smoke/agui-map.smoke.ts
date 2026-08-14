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
 * Run: pnpm smoke:agui-map           (needs a session; see the refusal message)
 */
import { readFileSync, existsSync, writeFileSync, appendFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AguiBrackets, type AguiEvent } from "../../connector-core/src/agui.js";
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
// PART 2 — THE DEFECT, ASSERTED RATHER THAN DESCRIBED, AND SCOPED TO THE SESSIONS IT ACTUALLY HITS.
//
// §3.1's prompt rule is `origin.kind === "human"`. An earlier revision of this block asserted, flatly
// and for every session, that no user entry carries `origin.kind` and so THE ENTIRE SESSION MAPS TO
// NOTHING. **That is false, and a real session is what falsified it:** on a 5938-record INTERACTIVE
// session with 892 user entries the field is present and the rule selects normally. The defect is
// real but it is HEADLESS-ONLY (`claude -p`), where provenance rides `promptSource: "sdk"` instead.
//
// So the arm is DETECTED from the session rather than assumed, and each arm asserts the outcome that
// belongs to it. A cell that fails because it met the other kind of session is not a finding, it is
// a cell that did not say what it was about — and it would have read as "the mapper is broken" for
// whoever ran it next.
// ---------------------------------------------------------------------------------------------
// Exactly one synthetic record in the whole suite, declared here because PART 2 needs it as a
// control and PART 3 needs it as a crutch. It is what §3.1 says a prompt looks like — and the
// measurement below is that no real record in either session shape looks like this.
const OPENER: ClaudeEntry = {
  type: "user",
  uuid: "synthetic-opener",
  timestamp: "2026-08-14T21:00:00.000Z",
  origin: { kind: "human" },
  message: { content: "open the run" },
};

const asSpecified = createClaudeMapper({ threadId: THREAD, mintRunId: mint, now: () => 0 });
const asSpecifiedUnits = entries.map((e) => asSpecified.map(e)).filter((u) => u !== null);
// The observed `origin.kind` values, reported so a failure names the vocabulary it actually met.
// These are KEY/ENUM names, never content — rule 2 still holds.
const originKinds = [...new Set(entries.map((e) => (e.origin === undefined ? "<absent>" : `kind=${String(e.origin.kind)}`)))].sort();
const humanOrigin = entries.filter((e) => e.origin?.kind === "human").length;
const ARM = entries.every((e) => e.origin === undefined) ? "HEADLESS" : "INTERACTIVE";

c(`defect-B:arm-is-${ARM}-by-measurement-not-assumption`, entries.length > 0, {
  userEntries: typeHist.get("user") ?? 0,
  originKinds,
});

// THE DEFECT, AND IT IS NOT HEADLESS-ONLY. Measured on both real shapes: an interactive session of
// 5938 records with 892 user entries carries `origin` on 67 of them and every one is
// `kind:"channel"` (a Cotal mesh delivery). `kind:"human"` occurs ZERO times in either shape, so
// §3.1's rule selects nothing and a real session maps to NO events at all.
//
// Pinned rather than repaired: what the rule SHOULD key on is a design ruling, and inventing one
// here would put a guess in the connector and a green cell on top of it.
c("defect-B:NO-user-entry-in-this-real-session-carries-origin.kind===human", humanOrigin === 0, {
  humanOrigin,
  userEntries: typeHist.get("user") ?? 0,
});
c("defect-B:so-the-rule-AS-SPECIFIED-opens-no-run-on-THIS-real-session", asSpecified.openRun() === null, { originKinds });
c("defect-B:and-the-WHOLE-real-session-maps-to-nothing", asSpecifiedUnits.length === 0, {
  units: asSpecifiedUnits.length,
  records: entries.length,
});

// CONTROL — the inverse of the predicate. Without it, all three cells above are equally satisfied by
// a mapper whose prompt rule is broken outright, and "opens no run" would prove nothing about
// `origin.kind`. Feed the ONE thing the spec says a prompt looks like and require a run to open.
c("control:the-mapper-DOES-open-a-run-on-an-origin.kind===human-entry", (() => {
  let n = 0;
  const m = createClaudeMapper({ threadId: THREAD, mintRunId: () => `run-${(n += 1)}`, now: () => 0 });
  return m.map(OPENER) !== null && m.openRun() !== null;
})());

// ---------------------------------------------------------------------------------------------
// PART 3 — the same real records, with ONE synthetic entry in front to open a run.
//
// This is the compensation for defect (B) and it is a declared crutch, not a fixture: exactly one
// record is synthetic (a prompt carrying `origin.kind: "human"`, which is what the spec says a
// prompt looks like), and the other 30 are the real session's own bytes. When the prompt rule is
// ruled on, this block loses its synthetic head and reads the file straight through.
// ---------------------------------------------------------------------------------------------
const run = (opts?: { reasoning?: boolean }): { runId: string; events: AguiEvent[] }[] => {
  let n = 0;
  const m = createClaudeMapper({
    threadId: THREAD,
    mintRunId: () => `run-${(n += 1)}`,
    now: () => 0,
    ...(opts?.reasoning ? { reasoning: true } : {}),
  });
  return [OPENER, ...entries].map((e) => m.map(e)).filter((u): u is { runId: string; events: AguiEvent[] } => u !== null);
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

c("real:the-thinking-SIGNATURE-never-appears-in-any-emitted-event", (() => {
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
  for (const e of [OPENER, ...entries]) m.map(e);
  return m.openRun() !== null;
})());

console.log(`agui-map smoke: ${pass} passed, ${fail} failed  [session: ${SESSION.split("/").pop()}, ${entries.length} records]`);
process.exit(fail === 0 ? 0 : 1);
