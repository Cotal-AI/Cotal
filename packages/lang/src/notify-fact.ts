/**
 * The `notify` fact's bound, enforced where the VALUE exists.
 *
 * The validator checks a fact written as a literal, exactly, and its own comment has always said
 * the other half out loud: *a computed one is checked at the effect boundary by the same rules*.
 * This is that half. It matters because the computed case is the one the bound exists for —
 * The rule is that no interpolation hook may launder a turn result's free text into another
 * agent's prompt, and a static check cannot see a string that does not exist until the run
 * produces it. Over-cap is an ERROR, never a truncation: silently shortening prose would make the
 * program's intent unrecoverable while still delivering a message.
 *
 * **A length bound is not a shape bound**, which is the second half of the same rule and is easy to
 * miss: 128 characters is ample room for a closing tag and an instruction after it. The render is a
 * fixed table whose whole property is that it cannot be mistaken for an instruction, and a value
 * carrying a newline is a value that can forge a row, a closing tag, or a line of prose below the
 * table. So a detail string is a SINGLE LINE of printable text, checked here rather than in the
 * renderer: the renderer must be unable to receive one, not merely careful with it.
 */
import { NOTIFY_BOUND } from "./primitives.js";

/** C0/C1 controls and the Unicode line separators — everything that can end a line. */
const CONTROL_RE = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/;

/**
 * The first way this fact breaks the bound, or `null` when it holds.
 *
 * Returns rather than throws so the interpreter raises in its own vocabulary (L3043 with the run's
 * blame frame) and a test can ask the question without catching anything.
 */
export function notifyFactViolation(fact: unknown): string | null {
  if (fact === null || typeof fact !== "object" || Array.isArray(fact))
    return "a notify fact is a record with `decision`, `outcome`, and an optional `detail`";

  const o = fact as Record<string, unknown>;
  for (const key of Object.keys(o))
    if (key !== "decision" && key !== "outcome" && key !== "detail")
      return `a notify fact carries \`decision\`, \`outcome\`, and an optional \`detail\`, and nothing else; \`${key}\` would be an unbounded channel from the program into another agent's context`;

  for (const field of ["decision", "outcome"] as const) {
    const value = o[field];
    if (typeof value !== "string") return `a notify fact needs a \`${field}\`, named as a token`;
    if (!NOTIFY_BOUND.tokenRe.test(value))
      return `\`${field}\` names a decision, so it is a kebab-case token of 1 to 64 characters; ${JSON.stringify(value.slice(0, 64))} is not one`;
  }

  const detail = o.detail;
  if (detail === undefined) return null;
  if (detail === null || typeof detail !== "object" || Array.isArray(detail))
    return "`detail` is a record of short scalars";

  const entries = Object.entries(detail as Record<string, unknown>);
  if (entries.length > NOTIFY_BOUND.maxDetailKeys)
    return `\`detail\` carries at most ${NOTIFY_BOUND.maxDetailKeys} keys; this one has ${entries.length}. The cap is what keeps a notice a decision rather than a message`;

  for (const [key, value] of entries) {
    if (!NOTIFY_BOUND.detailKeyRe.test(key))
      return `\`${key}\` is not a detail key; they are kebab-case tokens of at most 32 characters`;
    if (typeof value === "number") {
      if (!Number.isFinite(value)) return `\`${key}\` is a number that is not finite; a notice records a decision, not a NaN`;
      continue;
    }
    if (typeof value === "boolean") continue;
    if (typeof value !== "string")
      return `\`${key}\` is not a scalar; detail values are a short string, a number, or a boolean, because a nested structure is an unbounded pipe into another agent's context`;
    if (value.length > NOTIFY_BOUND.maxDetailStringLength)
      return `a detail string is at most ${NOTIFY_BOUND.maxDetailStringLength} characters; \`${key}\` is ${value.length}. Longer than that is prose, and prose belongs in the channel where the agent can answer it`;
    if (CONTROL_RE.test(value))
      return `\`${key}\` carries a line break or control character; a notice renders as one table row, and a value that can end a line can forge one`;
  }
  return null;
}
