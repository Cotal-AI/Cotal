/**
 * The effects executor's RE-READ DECISION (SPEC §13.4; § S4 steps 3-4).
 *
 * An effects durable is at-least-once and shared. A handler can be redelivered while an earlier
 * handler for the same acceptance is still live on the SAME executor, and a winner's reply to its
 * own CAS can be dropped — in which case the winner re-reads a row BYTE-IDENTICAL to the one it
 * would have written. Nothing in the payload distinguishes any of that. Only the `goaleff` row
 * plus the identity of whoever is asking can.
 *
 * WHY THIS IS A SEPARATE FUNCTION AND NOT A BRANCH INSIDE THE LOOP. The property being asserted is
 * "exactly one physical launch" and "exactly zero", and a live process is an expensive and flaky
 * way to count to one. The decision that determines the count is a pure function of two values.
 * Separating it is what makes both directions assertable at all.
 *
 * AND BOTH DIRECTIONS ARE REQUIRED, WHICH IS THE WHOLE POINT. `≤ 1` is satisfied by ZERO. An
 * implementation that stands down on every ambiguity — including a winner re-reading its OWN
 * nonce — launches nothing for every accepted goal and passes every at-most-one test ever written.
 * That is not the fence holding; it is the fence eating the work. So the contract is stated as
 * exact outcomes per case, never as a bound.
 */
import type { GoalEffRow, GoalEffExecutor } from "./endpoint-goaleff.js";

/** What the handler does next. Each is a DIFFERENT action, not a severity ordering. */
export type EffectDecision =
  /** No row exists: this handler races for the election with a create-only CAS. */
  | { action: "claim"; why: string }
  /** The row is ours and pre-launch: make the launch call. EXACTLY ONE handler reaches this. */
  | { action: "launch"; why: string }
  /** The row is ours and the call already returned: finish the BOOKKEEPING, never the work. */
  | { action: "complete"; why: string }
  /** The row is not ours: do nothing and ack. This is the ZERO side, and it must not be the answer
   *  to a case that deserves `launch` — that is the degeneracy this type exists to make visible. */
  | { action: "stand-down"; why: string }
  /** Terminal already: the goal is finished; ack the redelivery. */
  | { action: "ack"; why: string }
  /** OUR row at `launching`: the durable state cannot say whether the spawn call was made.
   *  `claimed → launching` is written BEFORE the call and `launching → launched` after it returns,
   *  so `launching` spans "about to call" and "called, outcome unknown" — two states with opposite
   *  correct actions and no field between them. R1″ chooses `uncertain` plus ZERO over any retry,
   *  so this is NOT a launch, and it is not a stand-down either: the goal must be settled
   *  `uncertain` rather than silently abandoned. It becomes decidable the moment a durable
   *  runtime-attempt token exists, which is a named capability gap and not a design choice. */
  | { action: "settle-uncertain"; why: string };

export interface EffectAsker { executor: GoalEffExecutor; attemptId: string }

function sameIncarnation(a: GoalEffExecutor, b: GoalEffExecutor): boolean {
  // BOTH FIELDS. A restarted manager carries the same `instanceId` and a different `processEpoch`,
  // and it is a different incarnation with an empty handle table — comparing the id alone lets a
  // successor adopt a predecessor's in-flight launch, which is the split-brain in miniature.
  return a.instanceId === b.instanceId && a.processEpoch === b.processEpoch;
}

/**
 * Decide what a redelivered handler does, given the row as re-read and who is asking.
 *
 * `row` is `null` when no row exists on the coordinate. That is NOT ambiguity — it is the ordinary
 * state of a goal nobody has claimed yet, and treating it as ambiguity is how an executor stands
 * down forever.
 */
export function decideEffect(row: GoalEffRow | null, asker: EffectAsker): EffectDecision {
  if (row === null)
    return { action: "claim", why: "no row on the coordinate: this is an unclaimed goal, not an ambiguous one" };

  if (row.phase === "settled")
    return { action: "ack", why: "the row is settled: the goal is finished and this delivery is a duplicate" };

  const mine = sameIncarnation(row.executor, asker.executor) && row.attemptId === asker.attemptId;
  if (!mine)
    return {
      action: "stand-down",
      why: `the row carries a FOREIGN election (${JSON.stringify(row.executor)}/${row.attemptId}, `
         + `asker ${JSON.stringify(asker.executor)}/${asker.attemptId}): another handler won, and a `
         + `re-read that finds someone else's nonce is a LOSS, never a licence to proceed`,
    };

  if (row.phase === "claimed")
    return { action: "launch", why: "the row carries our OWN nonce at a pre-launch phase: our reply was dropped, "
                                  + "not our claim — standing down here would launch nothing for a goal we won" };
  if (row.phase === "launching")
    return {
      action: "settle-uncertain",
      why: "our own nonce at `launching`: the row says the pre-launch CAS landed and says NOTHING about "
         + "whether the spawn call was then made — `launching` is written before the call and cleared after "
         + "it returns, so it covers both 'about to call' and 'called, outcome unknown'. Retrying here is "
         + "the double launch the election exists to prevent; standing down abandons a goal that may be "
         + "half-done. R1″ settles `uncertain` with ZERO launches, and this stays undecidable until a "
         + "durable runtime-attempt token records the call itself",
    };
  return {
    action: "complete",
    why: "our own nonce at `launched`: the call already returned, so what is unfinished is the BOOKKEEPING "
       + "and not the work — launching again would produce the second process the election exists to prevent",
  };
}
