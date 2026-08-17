/**
 * `assertValidName` — the shared identity rule, tested against the SOURCE that defines it.
 *
 * WHY THIS FILE EXISTS, and it is not "more coverage". The rule is enforced in `packages/core`, but
 * the suite that first covered it lives in `connector-core` and reaches the rule through
 * `@cotal-ai/core` — that package's **`dist/`**. So a mutation to `packages/core/src/resolve.ts`
 * changed nothing the cells executed: **deleting the refusal entirely left every refusal cell
 * green.** The cells documented a rule they could not have detected the absence of.
 *
 * That is the same false-green door `smoke:mutation-reachable` was built to close, entered through
 * the side it does not watch: that guard asserts a suite imports its OWN package by source path and
 * says nothing about a CROSS-PACKAGE dependency resolving to `dist/`. Found in review, on cells
 * written one commit earlier by someone describing that exact hazard at the time.
 *
 * The arrangement, not a reminder: the rule's cells live beside the rule and import `../src/`. A
 * mutation here cannot miss them, and no build has to have happened first.
 *
 * Run: pnpm smoke:valid-name
 */
import { assertValidName } from "../src/resolve.js";

let ok = 0, fail = 0;
const c = (n: string, v: boolean, extra?: unknown) => {
  if (v) ok++; else { fail++; console.log("  x FAIL:", n, extra ?? ""); }
};

/** Assert WHICH refusal fired — a cell that only checks "something threw" credits the wrong rule. */
const refuses = (label: string, name: string, mustMention: RegExp) => {
  let err: unknown;
  try { assertValidName(name); } catch (e) { err = e; }
  c(label, err instanceof Error && mustMention.test(err.message), err instanceof Error ? err.message : "did not throw");
};
const accepts = (label: string, name: string) => {
  let err: unknown;
  try { assertValidName(name); } catch (e) { err = e; }
  c(label, err === undefined, err instanceof Error ? `threw: ${err.message}` : undefined);
};

// ── The surrogate rule: an identity rule, not tidiness. ───────────────────────────────────────
//    An unpaired surrogate cannot be encoded as UTF-8 — every encoder substitutes U+FFFD — so the
//    moment such a name crosses a UTF-8 boundary, DISTINCT names become the SAME bytes. Measured
//    consequences: `createHash().update(name)` hashes the replaced bytes, so three distinct names
//    produced one digest and shared one channel, one publish grant and one event stream; and the
//    launch environment normalizes the name toward a child process, so a child's idea of its own
//    name can differ from its parent's while both believe they agree.
refuses("a lone HIGH surrogate is refused", "\uD800", /unpaired UTF-16 surrogate/);
refuses("a lone LOW surrogate is refused", "\uDC00", /unpaired UTF-16 surrogate/);
refuses("a high surrogate at end-of-string is refused (charCodeAt past the end is NaN)", "A\uD800", /unpaired UTF-16 surrogate/);
refuses("a high surrogate followed by a non-surrogate is refused", "\uD800A", /unpaired UTF-16 surrogate/);
refuses("a low surrogate BEFORE a high one is refused (right code units, wrong order)", "\uDC00\uD800", /unpaired UTF-16 surrogate/);
refuses("a surrogate buried mid-string is refused, not just at the edges", "ada \uD800 lovelace", /unpaired UTF-16 surrogate/);

// ── THE CONTROLS. Without these the cells above pass for a rule that refuses everything, which
//    would break every emoji and astral name — a fix worse than the defect it closes.
accepts("a WELL-FORMED surrogate pair (U+1F600) is accepted", "agent 😀");
accepts("U+FFFD is itself a legitimate character and is accepted", "�");
accepts("a plain ASCII name is accepted", "worker");
accepts("a human display name with a space is accepted", "Ada Lovelace");
accepts("a name of only astral characters is accepted", "😀😁");
// The boundary either side of the surrogate block must not be swept up with it.
accepts("U+D7FF, immediately below the surrogate block, is accepted", "퟿");
accepts("U+E000, immediately above it, is accepted", "");

// ── The pre-existing rules must still hold: a fix that quietly widened or narrowed them would
//    otherwise pass unnoticed, since nothing else in this file drives them.
refuses("an empty name is refused", "", /non-empty/);
refuses("a name with surrounding whitespace is refused", " ada ", /non-empty|whitespace/);
refuses("a multi-line name is refused", "ada\nlovelace", /single line/);
refuses("a name containing '/' is refused", "owner/name", /reserved/);
refuses("a name containing a backslash is refused", "a\\b", /reserved/);

console.log(`valid-name smoke: ${ok} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
