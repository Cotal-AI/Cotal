/**
 * A replacement safety predicate graded against the predicate it replaced, on the same corpus.
 *
 * Every existing cell asks what the CURRENT function returns. None asks what the PREVIOUS function
 * returned for the same input, which is how three successive heads of the egress fence shipped a
 * classifier weaker than the one they replaced and no check named any of them. This file is that
 * check, for any pair of refs, over the frozen-body egress predicate in
 * `extensions/connector-core/src/agui.ts`.
 *
 * ROLE, NOT NAME. The export has already renamed and re-shaped once:
 * `frozenBodyViolatesEgressPolicy` (boolean) became `frozenBodyEgressVerdict` (three-way). A
 * harness pinned to one identifier is the next rename's first casualty. The loader reads that
 * file BY PATH at each ref and binds whichever exported function occupies the frozen-body
 * classifier ROLE. A boolean arm answers ALLOW / REFUSE / THROW. A three-way arm answers
 * clean / forbidden-kind / unreadable, and a throw from a three-way is recorded as a throw,
 * never coerced into a boolean. The comparison that names WEAKER / STRICTER is the explicit
 * publish mapping recorded next to the loader, not a silent `if (x) refuse`.
 *
 * THIS COMMIT IS THE AXIS LIST. The axes below are derived from the read pattern of
 * `frozenBodyEgressVerdict` and `parseAguiFrame` on origin/main (`7c221ac71`), and from the
 * three-way vocabulary, BEFORE any 1429 lane artifact was opened. Corpus rows, the loader, and
 * the two grading pairs land in a later change. A file that printed 0 today would be a number
 * about nothing, so this commit refuses to run rather than report.
 *
 * Follows `packages/lang/smoke/differential.smoke.ts`: CORPUS / DIVERGENT / HELD, both-direction
 * grading, and prose on what a zero does not prove. #1426 is the adjacent reachability gap;
 * this instrument does not close it. T-PARSE and T-READONCE already pin the envelope class and
 * the representation class on THIS sha; this file's value is cross-ref grading, which neither
 * of them does.
 *
 * Run: pnpm smoke:egress-guard-differential
 */

/**
 * One axis is one READ the predicate actually performs, or one answer it can give. A corpus
 * that varies a field nobody reads is a green loop over nothing. A corpus that varies only the
 * field the last finding named is how the hole moved rather than closed.
 *
 * Derived from, in order: iterating `body`; `isAguiFramePart` (kind, never throws);
 * `parseAguiFrame` (protocol, threadId, runId, epoch, seq, events array, element type);
 * scanning `frame.events` for the forbidden set; the three-way vocabulary and the outer catch
 * that makes the `unknown[]` signature mean it. `parseAguiFrame` ends `return part as AguiFrame`
 * — a CAST, not a copy — so a later scan of `frame.events` re-reads the caller's object.
 */
export const AXES = [
  {
    id: "control",
    rationale:
      "A well-formed allowed frame and a well-formed forbidden frame must both reach the predicate in the same run; without them a green is indistinguishable from a corpus that never entered the function.",
  },
  {
    id: "envelope-protocol",
    rationale:
      "parseAguiFrame's first field check after routing; a predecessor that skipped the parse published a wrong-protocol frame.",
  },
  {
    id: "envelope-threadId",
    rationale: "parseAguiFrame requires threadId to be a non-empty string.",
  },
  {
    id: "envelope-runId",
    rationale: "parseAguiFrame requires runId to be a non-empty string.",
  },
  {
    id: "envelope-epoch",
    rationale: "parseAguiFrame requires epoch to be a non-empty string.",
  },
  {
    id: "envelope-seq",
    rationale:
      "parseAguiFrame requires seq to be a non-negative safe integer, so missing, negative, fractional, NaN and Infinity are distinct failures of that predicate.",
  },
  {
    id: "events-shape",
    rationale:
      "parseAguiFrame requires Array.isArray(events) && length > 0; missing, empty, string, object and null are the skip-vs-throw split that shipped at 1698fe253.",
  },
  {
    id: "event-element",
    rationale:
      "parseAguiFrame requires each element to be a non-null object whose type is a recognised AG-UI discriminator; null, number, string, missing type, unknown type and a nested smuggle are the element-level holes a list-level check cannot see.",
  },
  {
    id: "forbidden-kind",
    rationale:
      "The scan's positive: TOOL_CALL_ARGS and TOOL_CALL_RESULT on a well-formed frame must answer forbidden-kind (or boolean refuse), not unreadable and not clean.",
  },
  {
    id: "allowed-kind",
    rationale:
      "Sibling types the policy must still publish: text, tool start/end, run lifecycle, RUN_ERROR. A fail-closed catch can buy totality by refusing these.",
  },
  {
    id: "routing-kind",
    rationale:
      "isAguiFramePart inspects kind and nothing else; a wrong kind or a non-object part is skipped, which is the named non-frame gap this function neither widens nor closes.",
  },
  {
    id: "body-composition",
    rationale:
      "The predicate classifies a BODY, not a part: empty, mixed frame+junk, unreadable-then-forbidden, forbidden-then-unreadable. forbidden-kind wins across parts; an earlier unreadable must not hide a later forbidden event.",
  },
  {
    id: "iteration-totality",
    rationale:
      "The outer catch is the unknown[] signature meaning it: a Proxy whose Symbol.iterator traps, or an array with a throwing index accessor, raises before any per-part catch. JSON cannot produce these; they grade the exported signature.",
  },
  {
    id: "representation",
    rationale:
      "parseAguiFrame returns a cast, so the scan re-reads the caller's object. Own accessor, inherited accessor, and a Proxy whose getOwnPropertyDescriptor reports a data property while get is stateful are the class a snapshot read is weaker on.",
  },
  {
    id: "json-roundtrip",
    rationale:
      "A WAL body is JSON; a live constructor result and JSON.parse(JSON.stringify) of it must classify the same for every JSON-representable row, or the live object is grading a shape disk will never hold.",
  },
] as const;

export type AxisId = (typeof AXES)[number]["id"];

console.log("egress-guard-differential: axes derived, corpus not yet loaded");
for (const axis of AXES) {
  console.log(`  axis ${axis.id}: ${axis.rationale}`);
}
throw new Error(
  "egress-guard-differential: this commit is the axis derivation; it refuses to report a zero over an empty corpus",
);
