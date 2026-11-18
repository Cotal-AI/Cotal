/**
 * Shared fixtures for the prompt desk suites: prompt contents, and an oracle that measures a
 * summary the way SPEC 13.22 bounds it, written apart from the desk so the suites can check the
 * desk against it.
 */
import { canonicalJson, type PromptAnswerRef, type PromptContent, type PromptOutcome, type PromptSeen, type PromptState, type PromptSummary } from "@cotal-ai/core";

export const permission = (title = "Allow Bash: npm test?", extra: Partial<PromptContent> = {}): PromptContent => ({
  kind: "permission", title,
  subject: { type: "tool", name: "Bash", input: { kind: "shown", value: { command: "npm test" } }, cwd: "/work" },
  options: [
    { id: "allow", label: "Allow", effect: "proceed" },
    { id: "deny", label: "Deny", effect: "refuse", note: "optional" },
  ],
  source: { harness: "smoke", scope: "main" },
  ...extra,
});

/** A question with a form: `submit` sends values, `dismiss` sends nothing, `why` needs a note. */
export const question = (): PromptContent => ({
  kind: "question", title: "Which suite should run?",
  options: [
    { id: "submit", label: "Submit", effect: "proceed", form: "required" },
    { id: "dismiss", label: "Dismiss", effect: "refuse" },
    { id: "why", label: "Refuse with a reason", effect: "refuse", note: "required" },
  ],
  form: { schema: { type: "object", properties: {
    suite: { type: "string", title: "Suite", oneOf: [{ const: "unit", title: "Unit" }, { const: "e2e", title: "End to end", description: "slow" }] },
    retries: { type: "integer", minimum: 0, maximum: 3 },
  }, required: ["suite"] } },
  source: { harness: "smoke" },
});

/** Every timestamp has one 24-byte form. */
export const AT = "2026-11-17T12:00:00.000Z";
const LONGEST_BY = { id: `${"o".repeat(64)}.${"a".repeat(64)}`, uid: "u".repeat(32), authority: "grant" as const };
const SEEN: PromptSeen = { tie: "subject", effect: "proceed" };

/** Every state a summary of `content` can carry, with the answerer, option id and sighting at their
 *  longest legal values. */
export function everyState(content: PromptContent): PromptState[] {
  const closed = (outcome: PromptOutcome): PromptState => ({ kind: "closed", at: AT, outcome });
  const states: PromptState[] = [{ kind: "open" }, closed({ kind: "expired" }), closed({ kind: "withdrawn", seen: SEEN }), closed({ kind: "local", seen: SEEN })];
  for (const o of content.options) {
    const answer: PromptAnswerRef = { by: LONGEST_BY, option: o.id, effect: o.effect, at: AT };
    states.push({ kind: "sent", answer, delivery: "unconfirmed" }, { kind: "sent", answer, delivery: "delivered" },
      closed({ kind: "answered", answer }), closed({ kind: "unconfirmed", answer, seen: SEEN }),
      closed({ kind: "undelivered", answer }), closed({ kind: "local", seen: SEEN, late: answer }));
  }
  return states;
}

export const summaryOf = (content: PromptContent, state: PromptState, id = "a".repeat(26)): PromptSummary => ({
  id, digest: `sha256:${"0".repeat(64)}`, openedAt: AT, expiresAt: AT, state, kind: content.kind, title: content.title,
  contentBytes: Buffer.byteLength(canonicalJson(content)), ...(content.source ? { source: content.source } : {}),
});
export const bytesOf = (v: unknown): number => Buffer.byteLength(JSON.stringify(v));
/** The largest summary of `content`, in bytes, over every state it can reach. */
export const largestSummary = (content: PromptContent): number => Math.max(...everyState(content).map((s) => bytesOf(summaryOf(content, s))));

/** A permission prompt whose largest summary is exactly `target` bytes, made long with escaped
 *  control characters (six bytes each on the wire) in the title and the source. `measure` picks
 *  another size to hit, such as the summary in one state. */
export function contentWithLargestSummary(target: number, tag = "a", measure: (c: PromptContent) => number = largestSummary): PromptContent {
  const fill = (extra: number): PromptContent => {
    // Fields and their character limits after the tag or prefix; each \u0001 adds 6 bytes, each letter 1.
    const caps = [200 - tag.length, 127, 127, 127];
    const parts = caps.map(() => "");
    let left = extra;
    for (let i = 0; i < caps.length && left > 0; i++) {
      const six = Math.min(caps[i], Math.floor(left / 6));
      parts[i] += "\u0001".repeat(six);
      left -= six * 6;
      const ones = Math.min(caps[i] - six, left);
      parts[i] += "x".repeat(ones);
      left -= ones;
    }
    if (left > 0) throw new Error(`a summary cannot reach ${target} bytes`);
    return permission(`${tag}${parts[0]}`, { source: { harness: `h${parts[1]}`, scope: `s${parts[2]}`, toolCallId: `t${parts[3]}` } });
  };
  let extra = Math.max(0, target - measure(fill(0)));
  for (let i = 0; i < 8; i++) {
    const c = fill(extra);
    const got = measure(c);
    if (got === target) return c;
    extra += target - got;
  }
  throw new Error(`no content has a largest summary of exactly ${target} bytes`);
}

/** A permission prompt whose canonical content is exactly `target` bytes, padded in the tool input.
 *  `allowId` names the proceed option, up to the 32 characters an option id may have. */
export function contentOfBytes(target: number, allowId = "allow"): PromptContent {
  const make = (n: number): PromptContent => permission("Allow Bash: a long command?", {
    subject: { type: "tool", name: "Bash", input: { kind: "shown", value: { command: "x".repeat(n) } } },
    options: [{ id: allowId, label: "Allow", effect: "proceed" }, { id: "deny", label: "Deny", effect: "refuse", note: "optional" }],
  });
  const base = Buffer.byteLength(canonicalJson(make(0)));
  const c = make(target - base);
  if (Buffer.byteLength(canonicalJson(c)) !== target) throw new Error(`no content is exactly ${target} bytes`);
  return c;
}
