/** The node-free half of goal-result verification (SPEC 13.6): the closed fact shape and its terminal
 *  states, shared by `endpoint-action` and the browser entry. Moved unchanged from `endpoint-action.ts`. */
import { EpEnvelopeError } from "./endpoint-error.js";
import type { GoalRef, GoalState } from "./endpoint-action.js";

/** All five are TERMINAL and immutable; first-terminal-fact-wins applies uniformly. */
export const GOAL_TERMINAL_STATES: readonly GoalState[] = Object.freeze(["succeeded", "failed", "cancelled", "expired", "uncertain"]);

export function assertClosedKeys(o: Record<string, unknown>, allowed: readonly string[], what: string): void {
  for (const k of Object.keys(o))
    if (!allowed.includes(k))
      throw new EpEnvelopeError("internal", `${what} carries unknown field ${JSON.stringify(k)}; a closed schema admits no extras - garbled state never authorizes (SPEC 13.4)`);
}

/** Every check `parseGoalResultFact` runs except the outcome digest, which each host computes itself
 *  (synchronously in Node, through Web Crypto in a browser). */
export function assertGoalResultFactShape(raw: unknown, subject: string, ref: GoalRef): Record<string, unknown> {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw))
    throw new EpEnvelopeError("internal", `goal result fact on ${subject} is not an object; garbled state never authorizes (SPEC 13.6)`);
  const o = raw as Record<string, unknown>;
  assertClosedKeys(o, ["v", "goalId", "fingerprint", "state", "outcomeDigest", "data", "committer", "ts"], `goal result fact on ${subject}`);
  if (o.committer !== undefined) {
    const cm = o.committer as Record<string, unknown>;
    if (cm === null || typeof cm !== "object" || Array.isArray(cm))
      throw new EpEnvelopeError("internal", `goal result fact on ${subject} committer is not an object; garbled state never authorizes (SPEC 13.6)`);
    assertClosedKeys(cm, ["instanceId", "epoch"], `goal result fact on ${subject} committer`);
    if (typeof cm.instanceId !== "string" || cm.instanceId.length === 0
      || typeof cm.epoch !== "number" || !Number.isSafeInteger(cm.epoch) || cm.epoch < 0)
      throw new EpEnvelopeError("internal", `goal result fact on ${subject} carries a malformed committer; garbled state never authorizes (SPEC 13.6)`);
  }
  if (o.v !== 1 || typeof o.goalId !== "string" || typeof o.fingerprint !== "string" || o.fingerprint.length === 0
    || typeof o.state !== "string" || !(GOAL_TERMINAL_STATES as readonly string[]).includes(o.state)
    || typeof o.outcomeDigest !== "string" || o.outcomeDigest.length === 0
    || typeof o.ts !== "number" || !Number.isSafeInteger(o.ts) || o.ts < 0)
    throw new EpEnvelopeError("internal", `goal result fact on ${subject} is malformed; garbled state never authorizes (SPEC 13.6)`);
  if (o.goalId !== ref.goalId)
    throw new EpEnvelopeError("internal", `goal result fact on ${subject} names goalId ${JSON.stringify(o.goalId)}, not its subject's ${ref.goalId}; a mis-subjected fact never authorizes (SPEC 13.4)`);
  return o;
}

/** The refusal both hosts raise for a fact whose payload does not hash to its `outcomeDigest`. */
export function goalOutcomeDigestMismatch(subject: string): EpEnvelopeError {
  return new EpEnvelopeError("internal", `goal result fact on ${subject} carries an outcomeDigest that does not match its payload; a digest-inconsistent fact never authorizes (SPEC 13.6)`);
}
