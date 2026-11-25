/**
 * The prompt desk, broker-free (SPEC 13.22). Two things that need no broker:
 *
 * - The state table as a pure function. Every (state, event) pair is run through `stepPrompt` and
 *   matched against the table's rows, written out here as data in the order the table has them. Each
 *   pair must match exactly one row, every row must be reached, and each step must be the one its row
 *   says, the rows that cannot happen and are never reached included.
 * - The measured bound: the complete encoded `prompts` reply at 64 summaries of the largest size the
 *   desk admits, and the largest full `prompt` reply, each with its envelope, against the 524288-byte
 *   `max_payload` floor. Both replies validate against the endpoint's output schemas.
 *
 * The desk itself, its answer checks, its timers and its interleavings run on a real broker in
 * `pnpm smoke:prompt-desk:auth`.
 *
 * Run: pnpm smoke:prompt-desk   (no broker; part of smoke:ci)
 */
import {
  AGENT_CONTRACTS, AGENT_PROMPT_CONTENT_MAX_BYTES, AGENT_PROMPT_LIST_MAX, agentPromptDigest, canonicalJson,
  type PromptAnswerRef, type PromptOutcome, type PromptSeen, type PromptState,
} from "@cotal-ai/core";
import { createSuite } from "@cotal-ai/smoke-kit";
import { PROMPT_DESK_MIN_MAX_PAYLOAD, PROMPT_SUMMARY_MAX_BYTES, stepPrompt, type PromptEvent, type PromptStep } from "../src/prompt-desk.js";
import { AT, bytesOf, contentOfBytes, contentWithLargestSummary, everyState, summaryOf } from "./_prompt-fixtures.js";

const { check, finish } = createSuite();

// ---- the state table --------------------------------------------------------------------------
console.log("\nthe state table, row by row");

const NOW = "2026-11-17T12:34:56.789Z";
const ANSWER: PromptAnswerRef = { by: { id: "u_alice.web", uid: "a".repeat(26), authority: "owner" }, option: "allow", effect: "proceed", at: AT };
const OTHER: PromptAnswerRef = { by: { id: "u_bob.builder", uid: "b".repeat(26), authority: "grant" }, option: "deny", effect: "refuse", at: AT };
const closedAt = (outcome: PromptOutcome): PromptState => ({ kind: "closed", at: AT, outcome });
const SEENS: PromptSeen[] = [
  { tie: "prompt", effect: "proceed" }, { tie: "prompt", effect: "cancel" },
  { tie: "subject", effect: "proceed" }, { tie: "subject", effect: "refuse" }, { tie: "none" },
];
const STATES: [string, PromptState][] = [
  ["open", { kind: "open" }],
  ["sent, unconfirmed", { kind: "sent", answer: ANSWER, delivery: "unconfirmed" }],
  ["sent, delivered", { kind: "sent", answer: ANSWER, delivery: "delivered" }],
  ["closed, answered", closedAt({ kind: "answered", answer: ANSWER })],
  ["closed, unconfirmed", closedAt({ kind: "unconfirmed", answer: ANSWER, seen: SEENS[2] })],
  ["closed, undelivered", closedAt({ kind: "undelivered", answer: ANSWER })],
  ["closed, local", closedAt({ kind: "local", seen: SEENS[0] })],
  ["closed, local with late", closedAt({ kind: "local", seen: SEENS[1], late: ANSWER })],
  ["closed, withdrawn", closedAt({ kind: "withdrawn", seen: SEENS[4] })],
  ["closed, expired", closedAt({ kind: "expired" })],
];
const seenName = (s: PromptSeen) => (s.tie === "none" ? "none" : `${s.tie}/${s.effect}`);
const EVENTS: [string, PromptEvent][] = [
  ["A", { kind: "accept", answer: OTHER }],
  ...(["confirmed", "delivered", "gone", "failed"] as const).map((result): [string, PromptEvent] => [`D ${result}`, { kind: "delivery", result }]),
  ["S confirmed", { kind: "settle", evidence: { kind: "confirmed" } }],
  ...SEENS.map((seen): [string, PromptEvent] => [`S local ${seenName(seen)}`, { kind: "settle", evidence: { kind: "local", seen } }]),
  ...SEENS.map((seen): [string, PromptEvent] => [`S observed ${seenName(seen)}`, { kind: "settle", evidence: { kind: "observed", seen } }]),
  ["S withdrawn", { kind: "settle", evidence: { kind: "withdrawn" } }],
  ["X", { kind: "expiry" }],
  ["T", { kind: "settle-time" }],
  ["C", { kind: "close" }],
];

/** What a row says: the next state and the hooks, nothing, a warning, or that it is never fed. */
type Want =
  | { kind: "move"; next: PromptState; deliver?: true; end?: boolean }
  | { kind: "stay"; warn: boolean; report?: true }
  | { kind: "cannot-happen" | "never-reached" };
const isOpen = (s: PromptState) => s.kind === "open";
const isSent = (s: PromptState) => s.kind === "sent";
const isUnconfirmed = (s: PromptState) => s.kind === "sent" && s.delivery === "unconfirmed";
const isDelivered = (s: PromptState) => s.kind === "sent" && s.delivery === "delivered";
const isClosed = (s: PromptState) => s.kind === "closed";
const answerOf = (s: PromptState) => (s as { answer: PromptAnswerRef }).answer;
const evidenceOf = (e: PromptEvent) => (e.kind === "settle" ? e.evidence : undefined);
const seenOf = (e: PromptEvent) => (evidenceOf(e) as { seen: PromptSeen }).seen;
const S = (kind: string) => (e: PromptEvent) => evidenceOf(e)?.kind === kind;
const D = (result?: string) => (e: PromptEvent) => e.kind === "delivery" && (result === undefined || e.result === result);
const is = (kind: PromptEvent["kind"]) => (e: PromptEvent) => e.kind === kind;
const close = (outcome: PromptOutcome, end: boolean): Want => ({ kind: "move", next: { kind: "closed", at: NOW, outcome }, end });
const NONE: PromptSeen = { tie: "none" };

interface Row { label: string; state(s: PromptState): boolean; event(e: PromptEvent): boolean; want(s: PromptState, e: PromptEvent): Want }
const ROWS: Row[] = [
  { label: "open | A", state: isOpen, event: is("accept"), want: (_s, e) => ({ kind: "move", next: { kind: "sent", answer: (e as { answer: PromptAnswerRef }).answer, delivery: "unconfirmed" }, deliver: true }) },
  { label: "open | S local", state: isOpen, event: S("local"), want: (_s, e) => close({ kind: "local", seen: seenOf(e) }, false) },
  { label: "open | S observed, tied to the prompt", state: isOpen, event: (e) => S("observed")(e) && seenOf(e).tie === "prompt", want: (_s, e) => close({ kind: "local", seen: seenOf(e) }, false) },
  { label: "open | S observed, tied to the subject or to nothing", state: isOpen, event: (e) => S("observed")(e) && seenOf(e).tie !== "prompt", want: (_s, e) => close({ kind: "withdrawn", seen: seenOf(e) }, false) },
  { label: "open | S withdrawn", state: isOpen, event: S("withdrawn"), want: () => close({ kind: "withdrawn", seen: NONE }, false) },
  { label: "open | S confirmed", state: isOpen, event: S("confirmed"), want: () => ({ kind: "stay", warn: true }) },
  { label: "open | X", state: isOpen, event: is("expiry"), want: () => close({ kind: "expired" }, false) },
  { label: "open | C", state: isOpen, event: is("close"), want: () => close({ kind: "withdrawn", seen: NONE }, false) },
  { label: "open | D", state: isOpen, event: D(), want: () => ({ kind: "stay", warn: true }) },
  { label: "sent | A (never reached)", state: isSent, event: is("accept"), want: () => ({ kind: "never-reached" }) },
  { label: "sent, unconfirmed | D delivered", state: isUnconfirmed, event: D("delivered"), want: (s) => ({ kind: "move", next: { kind: "sent", answer: answerOf(s), delivery: "delivered" } }) },
  { label: "sent, unconfirmed | D confirmed", state: isUnconfirmed, event: D("confirmed"), want: (s) => close({ kind: "answered", answer: answerOf(s) }, true) },
  { label: "sent, unconfirmed | D gone", state: isUnconfirmed, event: D("gone"), want: (s) => close({ kind: "undelivered", answer: answerOf(s) }, true) },
  { label: "sent, unconfirmed | D failed", state: isUnconfirmed, event: D("failed"), want: () => ({ kind: "stay", warn: true }) },
  { label: "sent, delivered | D (cannot happen)", state: isDelivered, event: D(), want: () => ({ kind: "cannot-happen" }) },
  { label: "sent | S confirmed", state: isSent, event: S("confirmed"), want: (s) => close({ kind: "answered", answer: answerOf(s) }, true) },
  { label: "sent | S local", state: isSent, event: S("local"), want: (s, e) => close({ kind: "local", seen: seenOf(e), late: answerOf(s) }, true) },
  { label: "sent | S observed", state: isSent, event: S("observed"), want: (s, e) => close({ kind: "unconfirmed", answer: answerOf(s), seen: seenOf(e) }, true) },
  { label: "sent | S withdrawn", state: isSent, event: S("withdrawn"), want: (s) => close({ kind: "unconfirmed", answer: answerOf(s), seen: NONE }, true) },
  { label: "sent | X", state: isSent, event: is("expiry"), want: () => ({ kind: "stay", warn: false }) },
  { label: "sent | T", state: isSent, event: is("settle-time"), want: (s) => close({ kind: "unconfirmed", answer: answerOf(s), seen: NONE }, true) },
  { label: "open | T (cannot happen)", state: isOpen, event: is("settle-time"), want: () => ({ kind: "cannot-happen" }) },
  { label: "sent | C", state: isSent, event: is("close"), want: (s) => close({ kind: "unconfirmed", answer: answerOf(s), seen: NONE }, true) },
  { label: "closed | A (never reached)", state: isClosed, event: is("accept"), want: () => ({ kind: "never-reached" }) },
  { label: "closed | S", state: isClosed, event: is("settle"), want: () => ({ kind: "stay", warn: true, report: true }) },
  { label: "closed | D, X, T, C", state: isClosed, event: (e) => ["delivery", "expiry", "settle-time", "close"].includes(e.kind), want: () => ({ kind: "stay", warn: false }) },
];

/** The step in the shape a row states it. */
function got(step: PromptStep): Want {
  if (step.kind === "move") return { kind: "move", next: step.next, ...(step.deliver ? { deliver: true } : {}), ...(step.end ? { end: step.end.attempted } : {}) };
  if (step.kind === "stay") return { kind: "stay", warn: step.warn !== undefined, ...(step.report ? { report: true } : {}) };
  return { kind: step.kind };
}

let unmatched = 0, ambiguous = 0;
const perRow = new Map<Row, { pairs: number; wrong: string[] }>(ROWS.map((r) => [r, { pairs: 0, wrong: [] }]));
for (const [sName, s] of STATES) {
  for (const [eName, e] of EVENTS) {
    const rows = ROWS.filter((r) => r.state(s) && r.event(e));
    if (rows.length === 0) { unmatched++; console.log(`    no row for ${sName} | ${eName}`); continue; }
    if (rows.length > 1) { ambiguous++; console.log(`    ${rows.length} rows for ${sName} | ${eName}: ${rows.map((r) => r.label).join("; ")}`); continue; }
    const tally = perRow.get(rows[0])!;
    tally.pairs++;
    const want = canonicalJson(rows[0].want(s, e)), have = canonicalJson(got(stepPrompt(s, e, NOW)));
    if (want !== have) tally.wrong.push(`${sName} | ${eName}: want ${want}, got ${have}`);
  }
}
check(`every (state, event) pair matches exactly one row: ${STATES.length} states x ${EVENTS.length} events = ${STATES.length * EVENTS.length} pairs`,
  unmatched === 0 && ambiguous === 0, { unmatched, ambiguous });
for (const [row, tally] of perRow)
  check(`${row.label}: ${tally.pairs} pair(s), each as the row says`, tally.pairs > 0 && tally.wrong.length === 0, tally.wrong);
check(`all ${ROWS.length} rows of the table are reached`, [...perRow.values()].every((t) => t.pairs > 0));
{
  // A move to a closed state is stamped with the time of the step, and a closed state never moves.
  const closing = stepPrompt({ kind: "open" }, { kind: "expiry" }, NOW);
  check("a closing step carries the step's time in `at`", closing.kind === "move" && closing.next.kind === "closed" && closing.next.at === NOW);
  const moves = STATES.filter(([, s]) => s.kind === "closed").flatMap(([, s]) => EVENTS.map(([, e]) => stepPrompt(s, e, NOW).kind));
  check(`no event moves a closed state: ${moves.length} pairs, none a move`, moves.every((k) => k !== "move"));
  const back = STATES.flatMap(([, s]) => EVENTS.map(([, e]) => stepPrompt(s, e, NOW))).filter((st) => st.kind === "move" && st.next.kind === "open");
  check("no step returns a prompt to open", back.length === 0);
}

// ---- the measured bound -----------------------------------------------------------------------
console.log("\nthe measured bound: the largest replies, with their envelopes, against the max_payload floor");
{
  const REQUEST_ID = "i".repeat(64); // the longest envelope id an echo can carry
  const envelope = (data: unknown) => ({ v: 1, id: REQUEST_ID, ok: true, data });
  // A summary at its largest: the content is padded until the summary, in the state it shows, encodes to
  // exactly the 4096-byte bound. That is more than the desk ever admits for an open or sent prompt.
  const at4096 = (state: PromptState, i: number) => {
    const c = contentWithLargestSummary(PROMPT_SUMMARY_MAX_BYTES, "q", (x) => bytesOf(summaryOf(x, state)));
    const b32 = "abcdefghijklmnopqrstuvwxyz234567";
    return summaryOf(c, state, `${b32[i >> 5]}${b32[i & 31]}${"a".repeat(24)}`);
  };
  const largestOpen = everyState(contentWithLargestSummary(PROMPT_SUMMARY_MAX_BYTES)).filter((s) => s.kind !== "closed")
    .sort((a, b) => bytesOf(b) - bytesOf(a))[0];
  const largestClosed = everyState(contentWithLargestSummary(PROMPT_SUMMARY_MAX_BYTES)).filter((s) => s.kind === "closed")
    .sort((a, b) => bytesOf(b) - bytesOf(a))[0];
  const open = Array.from({ length: AGENT_PROMPT_LIST_MAX }, (_, i) => at4096(largestOpen, i));
  const closed = Array.from({ length: AGENT_PROMPT_LIST_MAX }, (_, i) => at4096(largestClosed, i + AGENT_PROMPT_LIST_MAX));
  const list = { runtime: { id: "r".repeat(64), startedAt: Number.MAX_SAFE_INTEGER }, seq: Number.MAX_SAFE_INTEGER, open, closed };
  const each = [...open, ...closed].map(bytesOf);
  check(`64 summaries, each exactly ${PROMPT_SUMMARY_MAX_BYTES} bytes`, each.length === 64 && each.every((b) => b === PROMPT_SUMMARY_MAX_BYTES), [...new Set(each)]);
  const validList = AGENT_CONTRACTS.prompts.output.validate(list);
  check("the list validates against the prompts output schema", validList, AGENT_CONTRACTS.prompts.output.validate.errors?.[0]);
  const listBytes = bytesOf(envelope(list));
  console.log(`    prompts reply: ${listBytes} bytes (summaries ${64 * PROMPT_SUMMARY_MAX_BYTES}, the rest ${listBytes - 64 * PROMPT_SUMMARY_MAX_BYTES})`);
  check(`the complete encoded prompts reply, ${listBytes} bytes, is under ${PROMPT_DESK_MIN_MAX_PAYLOAD}`, listBytes <= PROMPT_DESK_MIN_MAX_PAYLOAD);

  // The largest full prompt: content at the 262144-byte cap, an option id of 32 characters, and the
  // longest state a `prompt` reply carries (sent, unconfirmed, with the longest answerer).
  const content = contentOfBytes(AGENT_PROMPT_CONTENT_MAX_BYTES, "p".repeat(32));
  const answer: PromptAnswerRef = { by: { id: `${"o".repeat(64)}.${"a".repeat(64)}`, uid: "u".repeat(32), authority: "grant" }, option: "p".repeat(32), effect: "proceed", at: AT };
  const prompt = { id: "a".repeat(26), digest: agentPromptDigest(content), openedAt: AT, expiresAt: AT, state: { kind: "sent", answer, delivery: "unconfirmed" } as PromptState, content: JSON.parse(canonicalJson(content)) };
  check(`the content is exactly ${AGENT_PROMPT_CONTENT_MAX_BYTES} canonical bytes, and its JSON encoding is as long`,
    Buffer.byteLength(canonicalJson(content)) === AGENT_PROMPT_CONTENT_MAX_BYTES && bytesOf(prompt.content) === AGENT_PROMPT_CONTENT_MAX_BYTES);
  const validPrompt = AGENT_CONTRACTS.prompt.output.validate({ prompt });
  check("the full prompt validates against the prompt output schema", validPrompt, AGENT_CONTRACTS.prompt.output.validate.errors?.[0]);
  const promptBytes = bytesOf(envelope({ prompt }));
  console.log(`    prompt reply: ${promptBytes} bytes (content ${AGENT_PROMPT_CONTENT_MAX_BYTES}, the rest ${promptBytes - AGENT_PROMPT_CONTENT_MAX_BYTES})`);
  check(`the largest full prompt reply, ${promptBytes} bytes, is under ${PROMPT_DESK_MIN_MAX_PAYLOAD}`, promptBytes <= PROMPT_DESK_MIN_MAX_PAYLOAD);
}

finish();
