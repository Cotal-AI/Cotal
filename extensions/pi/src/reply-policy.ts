/**
 * Whether a Pi peer should automatically route its final assistant text back
 * to the peer that originated the current turn. Defaults on for compatibility;
 * explicit-DM workflows opt out with persona frontmatter `autoReply: false`.
 */
export function autoReplyEnabled(
  value: string | undefined = process.env.PI_PEER_AUTO_REPLY,
  source = "PI_PEER_AUTO_REPLY",
): boolean {
  if (value === undefined || value === "" || value === "true") return true;
  if (value === "false") return false;
  throw new Error(`${source} must be "true" or "false" (got ${JSON.stringify(value)})`);
}

/**
 * Route one implicit turn reply when policy permits it. Returning whether a
 * delivery occurred makes the policy directly testable without a mesh.
 */
export function maybeDeliverAutoReply<T>(
  enabled: boolean,
  origin: T | undefined,
  reply: string | undefined,
  deliver: (origin: T, reply: string) => void,
): boolean {
  if (!enabled || origin === undefined || !reply) return false;
  deliver(origin, reply);
  return true;
}
