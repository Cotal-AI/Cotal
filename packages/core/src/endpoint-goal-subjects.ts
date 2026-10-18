import { spacePrefix } from "./subjects.js";
import { callerTokens, endpointToken, type EpCaller } from "./endpoint-subjects.js";

/** Per-goal live progress read row (§13.9 "Live event progress", reserved `goal` topic):
 *  `epe.<endpoint>.*.*.goal.<cO>.<cA>.<cUid>.>` — the caller identity in the subject gives
 *  mint-time read containment; delivered on the caller's own core subscription only. */
export function epGoalProgressGrantRow(space: string, endpoint: string, caller: EpCaller): string {
  return `${spacePrefix(space)}.epe.${endpointToken(endpoint)}.*.*.goal.${callerTokens(caller).join(".")}.>`;
}
