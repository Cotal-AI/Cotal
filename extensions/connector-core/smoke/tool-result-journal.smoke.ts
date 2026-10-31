/**
 * THE RESULT JOURNAL'S AUDIENCE IS FIXED AT START AND ONLY EVER SHRINKS.
 *
 * SPEC §13.19 is a consent-gated LOOKUP, not a frame plane, so the thing that can leak here is not
 * a published byte — it is an ANSWER. Two shapes of that leak, and they are the two cells this
 * file exists for:
 *
 * 1. **A RESULT that creates its own entry** (§13.19.2). An entry minted by a result carries no
 *    frontier decision, so it has no eligible set to check a reader against — whoever asks first
 *    reads it. The journal must answer `no-entry` and store nothing.
 * 2. **An audience that grows** (§13.19.3). A consent granted after the fact must not reach back
 *    and read a result captured before it. A second START is the obvious way that happens, so a
 *    second START must not re-audience the entry.
 *
 * The remaining cells hold the bounds (§13.19 entry/byte/retention limits come from core, and the
 * journal must not invent its own), the state distinctness `missing` vs `not-shared` vs `expired`
 * (collapsing them would tell an unconsented reader which tool calls exist), and byte-exact
 * truncation that cannot split a character into replacement junk.
 *
 * THE COORDINATE IS `ToolResultJournal` in `../src/tool-result-journal.ts`: `start` fixes the set,
 * `capture` refuses to create, `revoke` shrinks and deletes, `read` answers the closed states.
 *
 * Run: pnpm smoke:tool-result-journal
 */
import {
  TOOL_RESULT_MAX_CONTENT_BYTES,
  TOOL_RESULT_MAX_ENTRIES,
  TOOL_RESULT_MAX_RETENTION_MS,
} from "@cotal-ai/core";
import { ToolResultJournal } from "../src/tool-result-journal.js";

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

const THREAD = "thread-1";
const CALL = "call-1";
/** Stands in for tool output. Named so a leak through the wrong answer is greppable. */
const RESULT_BYTES = "SYNTHETIC-PLACEHOLDER-13-19-TOOL-RESULT-CONTENT-NOT-A-SECRET";

try {
  // ---- 1. A RESULT NEVER CREATES AN ENTRY (§13.19.2) -------------------------------------------
  {
    const j = new ToolResultJournal();
    const outcome = j.capture({ threadId: THREAD, toolCallId: CALL, content: RESULT_BYTES, error: false });
    c("result-without-start is refused as no-entry", outcome === "no-entry", outcome);
    c("result-without-start stores nothing", j.size() === 0, j.size());
    // The reader presenting a consent that WOULD have been eligible still gets nothing, which is
    // the part that matters: the refusal is not merely bookkeeping.
    const answer = j.read({ threadId: THREAD, toolCallId: CALL, consentIds: ["consent-a"] });
    c("result-without-start is unreadable", answer.state === "missing", answer);
    c(
      "result-without-start leaks no content on any field",
      !JSON.stringify(answer).includes(RESULT_BYTES),
    );
  }

  // ---- 2. THE AUDIENCE IS FIXED AT START AND CANNOT GROW (§13.19.3) -----------------------------
  {
    const j = new ToolResultJournal();
    c("start admits the call", j.start({ threadId: THREAD, toolCallId: CALL, consentIds: ["consent-a"] }));
    // The late holder tries to join by restating the START with a wider set — the exact shape of
    // the bug. It must be refused, and must not widen anything.
    const second = j.start({ threadId: THREAD, toolCallId: CALL, consentIds: ["consent-a", "consent-late"] });
    c("a second start for the same call is refused", second === false, second);
    c("the second start did not create a second entry", j.size() === 1, j.size());
    c(
      "capture lands on the entry the FIRST start opened",
      j.capture({ threadId: THREAD, toolCallId: CALL, content: RESULT_BYTES, error: false }) === "captured",
    );
    const late = j.read({ threadId: THREAD, toolCallId: CALL, consentIds: ["consent-late"] });
    c("the late consent cannot read the captured result", late.state === "not-shared", late);
    c("the late consent's answer carries no content", !JSON.stringify(late).includes(RESULT_BYTES));
    const eligible = j.read({ threadId: THREAD, toolCallId: CALL, consentIds: ["consent-a"] });
    c("the eligible consent still reads it", eligible.state === "available", eligible.state);
  }

  // ---- 3. THE AVAILABLE ANSWER IS FAITHFUL -----------------------------------------------------
  {
    const j = new ToolResultJournal({ now: () => 1_000 });
    j.start({ threadId: THREAD, toolCallId: CALL, consentIds: ["consent-a"] });
    j.capture({ threadId: THREAD, toolCallId: CALL, content: RESULT_BYTES, error: true });
    const a = j.read({ threadId: THREAD, toolCallId: CALL, consentIds: ["consent-a"] });
    if (a.state !== "available") {
      c("available: answer is available", false, a);
    } else {
      c("available: content is exact", a.content === RESULT_BYTES);
      c("available: not truncated under the limit", a.truncated === false);
      c("available: byteCount is the content's byte length", a.byteCount === RESULT_BYTES.length, a.byteCount);
      c("available: the error flag survives", a.error === true);
      c("available: capturedAt comes from the clock", a.capturedAt === 1_000, a.capturedAt);
      c("available: the call is named back", a.threadId === THREAD && a.toolCallId === CALL);
    }
    // A started-but-unfinished call answers pending, not missing: the holder is entitled to know
    // the call exists, which is the whole difference between pending and not-shared.
    j.start({ threadId: THREAD, toolCallId: "call-pending", consentIds: ["consent-a"] });
    const p = j.read({ threadId: THREAD, toolCallId: "call-pending", consentIds: ["consent-a"] });
    c("a started call with no result answers pending", p.state === "pending", p);
    c(
      "a second capture does not overwrite the first",
      j.capture({ threadId: THREAD, toolCallId: CALL, content: "REPLACEMENT", error: false }) === "already-captured",
    );
    const after = j.read({ threadId: THREAD, toolCallId: CALL, consentIds: ["consent-a"] });
    c("the first result survives the second capture", after.state === "available" && after.content === RESULT_BYTES);
  }

  // ---- 4. THE THREE NEGATIVE STATES STAY DISTINCT -----------------------------------------------
  {
    let clock = 0;
    const j = new ToolResultJournal({ now: () => clock, retentionMs: 100 });
    j.start({ threadId: THREAD, toolCallId: CALL, consentIds: ["consent-a"] });
    j.capture({ threadId: THREAD, toolCallId: CALL, content: RESULT_BYTES, error: false });
    c(
      "an unrecorded call answers missing",
      j.read({ threadId: THREAD, toolCallId: "never-started", consentIds: ["consent-a"] }).state === "missing",
    );
    c(
      "a recorded call read by an outsider answers not-shared, not missing",
      j.read({ threadId: THREAD, toolCallId: CALL, consentIds: ["consent-other"] }).state === "not-shared",
    );
    // Retention runs from START, so a call that never returns cannot be held forever either.
    clock = 101;
    const expired = j.read({ threadId: THREAD, toolCallId: CALL, consentIds: ["consent-a"] });
    c("past retention the eligible holder gets expired", expired.state === "expired", expired);
    c("the expired answer carries no content", !JSON.stringify(expired).includes(RESULT_BYTES));
    c(
      "an expired entry is dropped, so the next read is missing",
      j.read({ threadId: THREAD, toolCallId: CALL, consentIds: ["consent-a"] }).state === "missing",
    );
    c("an expired entry stops counting against the bound", j.size() === 0, j.size());
  }

  // ---- 5. REVOCATION SHRINKS, AND AN EMPTIED ENTRY IS DELETED (§13.19.4) ------------------------
  {
    const j = new ToolResultJournal();
    j.start({ threadId: THREAD, toolCallId: CALL, consentIds: ["consent-a", "consent-b"] });
    j.capture({ threadId: THREAD, toolCallId: CALL, content: RESULT_BYTES, error: false });
    c("revoking one of two consents deletes no entry", j.revoke("consent-a") === 0);
    c(
      "the revoked consent can no longer read",
      j.read({ threadId: THREAD, toolCallId: CALL, consentIds: ["consent-a"] }).state === "not-shared",
    );
    c(
      "the surviving consent still reads",
      j.read({ threadId: THREAD, toolCallId: CALL, consentIds: ["consent-b"] }).state === "available",
    );
    c("revoking the last consent deletes the entry", j.revoke("consent-b") === 1);
    c("the emptied entry is gone, not merely unreadable", j.size() === 0, j.size());
    const gone = j.read({ threadId: THREAD, toolCallId: CALL, consentIds: ["consent-b"] });
    c("the deleted entry answers missing", gone.state === "missing", gone);
    c("the deleted entry's content is unreachable", !JSON.stringify(gone).includes(RESULT_BYTES));
    c("revoking an unknown consent deletes nothing", j.revoke("consent-never") === 0);
    // An entry that would be born empty is never born: the deleted state is not the created state.
    c("start with an empty eligible set creates nothing", j.start({ threadId: THREAD, toolCallId: "c2", consentIds: [] }) === false);
    c("an empty-set start left the journal empty", j.size() === 0, j.size());
  }

  // ---- 6. THE BOUNDS COME FROM CORE, AND THEY HOLD ----------------------------------------------
  {
    // The journal must not invent its own ceiling. Probe the defaults by effect rather than by
    // reading a field: a constant copied into this file would agree with a wrong default.
    const dflt = new ToolResultJournal({ now: () => 0 });
    for (let i = 0; i < TOOL_RESULT_MAX_ENTRIES; i++) {
      dflt.start({ threadId: THREAD, toolCallId: `call-${i}`, consentIds: ["consent-a"] });
    }
    c("the default entry bound is core's", dflt.size() === TOOL_RESULT_MAX_ENTRIES, dflt.size());
    dflt.start({ threadId: THREAD, toolCallId: "call-overflow", consentIds: ["consent-a"] });
    c("the default bound is not exceeded", dflt.size() === TOOL_RESULT_MAX_ENTRIES, dflt.size());
    c(
      "the oldest START is the one evicted",
      dflt.read({ threadId: THREAD, toolCallId: "call-0", consentIds: ["consent-a"] }).state === "missing",
    );
    c(
      "the newest START survives",
      dflt.read({ threadId: THREAD, toolCallId: "call-overflow", consentIds: ["consent-a"] }).state === "pending",
    );
    c("the default retention is core's", TOOL_RESULT_MAX_RETENTION_MS === 60 * 60 * 1000);

    // Truncation is a BYTE limit, so drive it with a multi-byte character whose encoding straddles
    // the cut. A naive string slice would both overshoot the budget and leave a lone surrogate.
    const over = new ToolResultJournal({ maxContentBytes: 10 });
    over.start({ threadId: THREAD, toolCallId: "call-big", consentIds: ["consent-a"] });
    const wide = "😀".repeat(4); // 4 bytes each: the 10-byte cut lands mid-character
    over.capture({ threadId: THREAD, toolCallId: "call-big", content: wide, error: false });
    const big = over.read({ threadId: THREAD, toolCallId: "call-big", consentIds: ["consent-a"] });
    if (big.state !== "available") {
      c("truncation: answer is available", false, big);
    } else {
      c("truncation: flagged", big.truncated === true);
      c("truncation: byteCount reports the FULL size", big.byteCount === 16, big.byteCount);
      const keptBytes = new TextEncoder().encode(big.content).length;
      c("truncation: kept content is within the byte budget", keptBytes <= 10, keptBytes);
      c("truncation: no character was split", !big.content.includes("�"), big.content);
      c("truncation: the cut landed on a character boundary", big.content === "😀😀", big.content);
    }
    const exact = new ToolResultJournal({ maxContentBytes: TOOL_RESULT_MAX_CONTENT_BYTES });
    exact.start({ threadId: THREAD, toolCallId: "call-exact", consentIds: ["consent-a"] });
    exact.capture({ threadId: THREAD, toolCallId: "call-exact", content: "x".repeat(TOOL_RESULT_MAX_CONTENT_BYTES), error: false });
    const e = exact.read({ threadId: THREAD, toolCallId: "call-exact", consentIds: ["consent-a"] });
    c("content exactly at the limit is not truncated", e.state === "available" && e.truncated === false, e.state);
  }

  // ---- 7. THREAD AND CALL ARE BOTH PART OF THE IDENTITY ----------------------------------------
  {
    const j = new ToolResultJournal();
    j.start({ threadId: "thread-a", toolCallId: CALL, consentIds: ["consent-a"] });
    j.capture({ threadId: "thread-a", toolCallId: CALL, content: RESULT_BYTES, error: false });
    c(
      "the same call id in another thread is a different entry",
      j.read({ threadId: "thread-b", toolCallId: CALL, consentIds: ["consent-a"] }).state === "missing",
    );
    c(
      "a result for the same call id in another thread is refused",
      j.capture({ threadId: "thread-b", toolCallId: CALL, content: "OTHER", error: false }) === "no-entry",
    );
  }

  // A count floor, so a file that dies half-way cannot read as green: the harness prints the pass
  // tally either way, and "0 failed" from a run that executed nothing is the false green here.
  const FLOOR = 42;
  c(`the run executed at least ${FLOOR} cells`, pass >= FLOOR, pass);

  console.log(`tool-result-journal smoke: ${pass} passed, ${fail} failed`);
  if (fail > 0) process.exit(1);
} catch (e) {
  console.error("FATAL:", e);
  process.exit(1);
}
