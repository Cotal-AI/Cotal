/**
 * THE INVARIANT BEHIND ITEM 0: evidence for a whole-output assertion must come from the emitter that
 * assertion is about.
 *
 * WHY THIS IS A CHECKER AND NOT A REGEX IN ONE CELL. `up-tls-routes-live` asserts its security
 * verdict as `assert.match(<entire status output>, /connection\s+.*unreachable/)`. A whole-output
 * matcher is a SHARED NAMESPACE between that suite and every string any code path in `status` can
 * print, so a positive assertion in it is a gate that anything can satisfy. Forbidding the one row
 * known to collide (this lane's delivery row) protects against the instance. Requiring that every
 * matching line be the `connection` row protects against the CLASS, including rows added later by
 * lanes that will never read this file.
 *
 * The polarity matters and is why both directions are supported: a positive whole-output assertion
 * can be FALSELY SATISFIED by new text (silent, so it survives), and a negative one FALSELY BROKEN
 * by it (loud, so it gets fixed). The tree accumulates the dangerous polarity because the safe one
 * gets removed.
 *
 * STATUS: the checker below is EXERCISED (see `status-delivery-row.smoke.ts`). The live cell that
 * feeds it real `cotal status` output on the preflight-OK path is OWED and needs a broker —
 * this lane's owed-work list, item 0, kept outside this repo.
 */

/** Rows are rendered as `  ${name.padEnd(16)} ${value}` (`status.ts:495-497`). The label is the
 *  first token; anything without a two-space indent and a token is not a row (section headers,
 *  blank lines, free-form `console.log`s). Returns undefined for those rather than guessing. */
export function rowLabel(line: string): string | undefined {
  const m = /^ {2}(\S+)/.exec(stripAnsi(line));
  return m?.[1];
}

/** Colour codes sit between the label and the value, so a pattern spanning them must see the text
 *  without them. Stripping is done here rather than at each call site so the checker and the suite
 *  under study read the same string. */
export function stripAnsi(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\x1b\[[0-9;]*m/g, "");
}

/** The verdict. `no-match` is a REFUSAL, not a pass — see {@link evidenceComesOnlyFrom}. */
export type EvidenceVerdict =
  | { ok: true; kind: "conforming"; matched: string[] }
  | { ok: false; kind: "violated"; offenders: string[]; matched: string[] }
  | { ok: false; kind: "no-match"; detail: string };

/**
 * Assert that every line matching `pattern` is a row whose label is `label`.
 *
 * `no-match` IS A REFUSAL AND THIS IS THE WHOLE POINT. "Every line matching X has label Y" is
 * VACUOUSLY TRUE when nothing matches X — the `.every()`-over-an-empty-set trap. If a future change
 * stopped `status` from printing the connection row at all, or reworded it, this check would go
 * green while asserting nothing, and it would go green on precisely the output where the security
 * suite it models has also stopped being satisfied. So an empty match set is reported as its own
 * outcome and the caller must treat it as a failure, never as a pass.
 */
export function evidenceComesOnlyFrom(
  output: string[],
  pattern: RegExp,
  label: string,
): EvidenceVerdict {
  const matched = output.filter((l) => pattern.test(stripAnsi(l)));
  if (matched.length === 0)
    return {
      ok: false,
      kind: "no-match",
      detail: `nothing in the output matched ${String(pattern)} — this is NOT a pass: the property is vacuous over an empty set, and an output that stopped matching is also an output the asserting suite has stopped being satisfied by`,
    };
  const offenders = matched.filter((l) => rowLabel(l) !== label);
  return offenders.length === 0
    ? { ok: true, kind: "conforming", matched }
    : { ok: false, kind: "violated", offenders, matched };
}

/** The verdict for a "must not say X" assertion. `no-subject` is a REFUSAL — see {@link mustNotSay}. */
export type AbsenceVerdict =
  | { ok: true; kind: "absent" }
  | { ok: false; kind: "present"; detail: string }
  | { ok: false; kind: "no-subject"; detail: string };

/**
 * Assert that `subject` does not say `pattern` — and REFUSE when there is no subject to say it.
 *
 * THIS EXISTS BECAUSE THE DEFECT IT PREVENTS ALREADY SHIPPED INTO THIS LANE'S OWN CELLS, STAYED
 * GREEN, AND WAS FOUND BY LUCK. A cell asserted that the delivery row does not blame a credential for
 * a connection failure, written as `!/credential/i.test(value)`. When the row was missing entirely,
 * `value` was the empty string and the assertion PASSED — trivially, because the empty string does
 * not contain "credential". It was noticed only because a different assertion in the same run failed
 * and the output was read closely enough to ask why this one had not.
 *
 * **A "does not say X" assertion is satisfied by a surface that says nothing at all.** That is the
 * same family as `.every()` over an empty set, but it hides better: the empty-set version at least
 * looks like a set operation, while this one looks like a specific claim about specific text.
 * Guarding it by hand — `value.length > 0 && !pattern.test(value)` — works exactly as long as every
 * future author remembers, which is the thing this lane has established does not hold.
 *
 * So absence-of-subject is its own outcome and cannot be read as a pass.
 */
export function mustNotSay(subject: string, pattern: RegExp): AbsenceVerdict {
  if (subject.trim().length === 0)
    return {
      ok: false,
      kind: "no-subject",
      detail: `there is no subject to test: a "must not say ${String(pattern)}" assertion is satisfied by a surface that says nothing at all, so an empty subject is a REFUSAL and never a pass`,
    };
  return pattern.test(subject)
    ? { ok: false, kind: "present", detail: `the subject says ${String(pattern)}: ${subject.slice(0, 200)}` }
    : { ok: true, kind: "absent" };
}

/**
 * The negative-polarity twin: no line may match `pattern` at all.
 *
 * Kept separate rather than folded in, because the two have different vacuity behaviour and
 * collapsing them would hide it. Here an empty match set IS the pass — there is no emitter that is
 * allowed to produce this string, so "nothing matched" is the property itself rather than an absence
 * of evidence for it. Naming that difference is why these are two functions.
 */
export function nothingMatches(output: string[], pattern: RegExp): { ok: boolean; offenders: string[] } {
  const offenders = output.filter((l) => pattern.test(stripAnsi(l)));
  return { ok: offenders.length === 0, offenders };
}
