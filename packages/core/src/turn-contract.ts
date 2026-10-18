/**
 * The manager's `turn` command contract: the relay a workflow run submits and the acceptance the
 * manager answers with, plus the `cancel` that withdraws it and the terminal both answer with.
 *
 * It lives in core so the manager and every suite that serves a manager-shaped `turn` compile the
 * same objects: implementations never import each other, and a private copy keeps passing after
 * the manager's contract changes.
 */

/** `turn` (workflow runs, cotal-lang §5.3): wake the TARGET seat for one turn on behalf of a
 *  workflow run. The manager relays and stays run-ignorant: `payload` is an opaque bounded string
 *  the seat pulls back verbatim through `turn-pending` — its shape is the runtime↔connector
 *  contract, never this endpoint's. A deadline bounds the whole turn and is REQUIRED at the
 *  wire (the caller defaults it; an unbounded turn goal could never be settled by a successor
 *  incarnation, which refuses to settle a goal with no readiness deadline). It is `deadlineMs`,
 *  counted from the acceptance, or `deadlineAt`, an instant the caller already holds (an ask's
 *  pause): the hold denies at that same instant, and one already past is refused
 *  `deadline-exceeded`. */
export const TURN_INPUT_SCHEMA = {
  type: "object", additionalProperties: false, required: ["payload"],
  oneOf: [{ required: ["deadlineMs"] }, { required: ["deadlineAt"] }],
  properties: {
    payload: { type: "string", minLength: 1, maxLength: 65536 },
    deadlineMs: { type: "integer", minimum: 1 },
    deadlineAt: { type: "integer", minimum: 1 },
    // The goal-chain link when this turn honors a handoff (lang §5.3): the previous turn's goal
    // id, mirrored into this goal's terminal data so the chain is readable from the facts alone.
    handoffFrom: { type: "string", minLength: 1, maxLength: 200 },
  },
} as const;
/** `turn` acceptance: the SEAT the goal was pinned to (its addressing triple), the goal
 *  coordinates, the absolute deadline the manager armed, and the executor coordinate — the same
 *  floor shape `spawn` serves, because a follower recovers the same way. */
export const TURN_OUTPUT_SCHEMA = {
  type: "object", additionalProperties: false,
  required: ["name", "owner", "actor", "uid", "goalId", "fingerprint", "deadlineAt", "executor"],
  properties: {
    name: { type: "string" },
    owner: { type: "string" },
    actor: { type: "string" },
    uid: { type: "string" },
    goalId: { type: "string" },
    fingerprint: { type: "string" },
    deadlineAt: { type: "integer", minimum: 1 },
    executor: {
      type: "object",
      additionalProperties: false,
      required: ["lifecycleUid", "epoch"],
      properties: { lifecycleUid: { type: "string" }, epoch: { type: "integer", minimum: 0 } },
    },
  },
} as const;
/** `turn-yield` output: the goal's terminal state as committed — first-terminal-wins, so a yield
 *  that raced a deadline or a despawn reports the state that actually landed, never a lie. */
export const TURN_YIELD_OUTPUT_SCHEMA = {
  type: "object", additionalProperties: false, required: ["goalId", "state"],
  properties: {
    goalId: { type: "string" },
    state: { enum: ["succeeded", "failed", "cancelled", "expired", "uncertain"] },
  },
} as const;
/** `cancel` (SPEC 13.6 item 4): the reserved goal cancel, served for a turn this manager relays.
 *  Untargeted, because it names a goal rather than a seat: the goal ref derives from the
 *  authenticated caller, so a caller withdraws only a relay it submitted. It answers with the
 *  terminal the goal reached, which is the yield's own output shape. */
export const CANCEL_INPUT_SCHEMA = {
  type: "object", additionalProperties: false, required: ["goalId"],
  properties: {
    goalId: { type: "string", minLength: 1 },
    mode: { enum: ["graceful", "terminate"] },
  },
} as const;
