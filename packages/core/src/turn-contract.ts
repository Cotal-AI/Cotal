/**
 * The manager's `turn` command contract: the relay a workflow run submits and the acceptance the
 * manager answers with.
 *
 * It lives in core so the manager and every suite that serves a manager-shaped `turn` compile the
 * same objects: implementations never import each other, and a private copy keeps passing after
 * the manager's contract changes.
 */

import { callerRailTokens, endpointToken, epPlaneTokens, epReplySubject, type EpCaller } from "./endpoint-subjects.js";
import { assertLifecycleToken, spacePrefix } from "./subjects.js";

/** `turn` (workflow runs, cotal-lang §5.3): wake the TARGET seat for one turn on behalf of a
 *  workflow run. The manager relays and stays run-ignorant: `payload` is an opaque bounded string
 *  the seat pulls back verbatim through `turn-pending` — its shape is the runtime↔connector
 *  contract, never this endpoint's. A deadline bounds the whole turn and is REQUIRED at the
 *  wire (the caller defaults it; an unbounded turn goal could never be settled by a successor
 *  incarnation, which refuses to settle a goal with no readiness deadline). It is `deadlineMs`,
 *  counted from the acceptance, or `deadlineAt`, an instant the caller already holds (an ask's
 *  pause): the hold denies at that same instant, and one already past is refused
 *  `deadline-exceeded`. */
export const TURN_INPUT_SCHEMA = deepFreeze({
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
} as const);
/** `turn` acceptance: the SEAT the goal was pinned to (its addressing triple), the goal
 *  coordinates, the absolute deadline the manager armed, and the executor coordinate — the same
 *  floor shape `spawn` serves, because a follower recovers the same way. */
export const TURN_OUTPUT_SCHEMA = deepFreeze({
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
} as const);

/** Freeze a schema and everything it holds at its declaration. `as const` is type-only, so without
 *  this an importer could change the contract every manager serves and validates against. */
function deepFreeze<T>(v: T): T {
  if (v !== null && typeof v === "object") {
    for (const child of Object.values(v as Record<string, unknown>)) deepFreeze(child);
    Object.freeze(v);
  }
  return v;
}

/** The reserved reply-rail nonce of a turn notice (SPEC 14.3). A seat's own requests use random
 *  nonces, so no reply it awaits can arrive on this one. */
export const TURN_NOTICE_NONCE = "turn-pending-notice-v1";

/** The subject a manager publishes a turn notice on: the seat's own reply rail (the versioned one
 *  when the seat's credential is an issuance, SPEC 13.15), under the manager's instance and serve
 *  epoch. Only that instance's serve credential may publish it, and every baseline seat credential
 *  may read it, so the notice needs no new grant. It carries no turn: the seat answers it with its
 *  authenticated `turn-pending` pull. */
export function turnNoticeSubject(space: string, instanceId: string, epoch: number, seat: EpCaller): string {
  return epReplySubject(space, { endpoint: "manager", instanceId, epoch, caller: seat, nonce: TURN_NOTICE_NONCE });
}

/** The seat's subscription for {@link turnNoticeSubject}: its launching manager instance at any
 *  epoch, so a manager that re-serves under a new epoch still reaches it. */
export function turnNoticeFilter(space: string, instanceId: string, seat: EpCaller): string {
  return [
    spacePrefix(space), ...epPlaneTokens(seat), "reply", endpointToken("manager"), assertLifecycleToken(instanceId, "instanceId"), "*",
    ...callerRailTokens(seat), TURN_NOTICE_NONCE,
  ].join(".");
}

/** A once task as its seat's session reads it: who started the seat, that this is its only task,
 *  and that the seat is stopped when the turn ends. The prompt is the manager-set `context`, shown
 *  as text. It lives here so a seat renders it and a manager measures it at admission
 *  ({@link Connector.turnFrameLimit}) with the same function. */
export function renderOnceTask(t: { goalId: string; payload: string; spawner?: string; deadlineAt?: number }): string {
  let context = t.payload;
  try {
    const p = JSON.parse(t.payload) as { context?: unknown };
    if (typeof p.context === "string") context = p.context;
  } catch { /* shown as it came */ }
  const from = t.spawner ?? "your spawner";
  const deadline = t.deadlineAt !== undefined ? `, or at ${new Date(t.deadlineAt).toISOString()} if you are still working then` : "";
  return `🎯 Cotal — ${from} started this seat for one task (goal ${t.goalId}):\n${context}\n`
    + `(This is the only task this seat takes. Do it with your own tools, and send your result to whoever needs it, for example with cotal_dm to ${from}, before you end your turn: `
    + `this seat is stopped when your turn ends${deadline}, and a result you have not sent reaches no one. If you cannot finish, call cotal_yield with blocked or handoff and say why.)`;
}
