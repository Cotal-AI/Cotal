import { createHash } from "node:crypto";
import { holdRequestId, type JournalEntry } from "@cotal-ai/lang";

/** A second deadline for one step, derived so a resume re-derives it instead of remembering it.
 *  Same shape and alphabet as a request id, so it is a valid `<token>` by construction. */
export function derivedToken(requestId: string, purpose: string): string {
  return createHash("sha256").update(`${requestId}:${purpose}`, "utf8").digest("base64url").slice(0, 43);
}

/** An ask attempt's pause token: attempt 1 IS the step's request id; a re-ask derives its own. */
export function askAttemptToken(requestId: string, attempt: number): string {
  return attempt === 1 ? requestId : derivedToken(requestId, `ask-attempt-${attempt}`);
}

/**
 * The pause tokens a step owns. The run authority grants from this, the adoption re-arm re-arms
 * it and a cancelled loser's discharge claims it, so a pause the live path arms is one all three
 * know. A held step also owns its hold id, whatever its kind, once the hold's bind lands.
 */
export function pauseTokens(entry: JournalEntry): string[] {
  const id = entry.requestId;
  if (id === undefined) return [];
  const own = kindPauseTokens(entry, id);
  return entry.hold === undefined ? own : [...own, holdRequestId(id)];
}

/**
 * The kinds that ARM a timer, which is more than the kinds that look like a pause: a `wait`'s idle
 * window and timeout, an ask attempt's deadline and a turn's deadline authority are mediated
 * deadlines exactly as `sleep`'s is. Derived tokens are re-derived rather than recorded, so a
 * resume never carries state the key already determines. Listing one that was never minted is
 * harmless: the re-arm and the claim read the checkpoint's own status first.
 */
function kindPauseTokens(entry: JournalEntry, id: string): string[] {
  if (entry.kind === "sleep" || entry.kind === "checkpoint" || entry.kind === "turn") return [id];
  if (entry.kind === "wait") return [id, derivedToken(id, "wait-timeout")];
  if (entry.kind === "waitUntil") {
    // Only the observation the entry is on can be parked: the earlier ones settled, which is how
    // the wait got here, and observation 0 looks without parking.
    const observation = (entry.observations ?? []).length;
    return observation === 0 ? [] : [derivedToken(id, `observe-${observation}`)];
  }
  if (entry.kind !== "ask") return [];
  // An ask's old attempt drops out as soon as the next bind lands, and a recorded token that is
  // not its attempt's derivation owns nothing.
  const attempt = entry.external?.attempt ?? 1;
  if (typeof attempt !== "number" || !Number.isSafeInteger(attempt) || attempt < 1) return [];
  const expected = askAttemptToken(id, attempt);
  if (entry.external?.askToken !== undefined && entry.external.askToken !== expected) return [];
  return [expected];
}
