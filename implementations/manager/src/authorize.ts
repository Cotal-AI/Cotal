import { parsePrincipalKey } from "@cotal-ai/core";

/** What the named-target decision needs to know about the managed row — the manager's spawn-time
 *  records only, never payload fields, personas, or presence display data. */
export interface NamedControlTarget {
  name: string;
  /** Authenticated principal that requested the spawn (`req.from.id` at spawn time). */
  spawner: string;
  /** The derived owner (`u_…`) a user-mode agent runs under; absent on static/open meshes. */
  userOwner?: string;
}

/**
 * The named-target (stop/attach) authorization decision — pure, so the policy is pinnable without
 * a broker. The caller already passed the broker's tier admission (cred-gated publish); this
 * decides what the manager honors, fail-closed, ONLY from the subject-pinned caller principal and
 * the target's spawn-time records:
 *
 * - **Admin tier**: any named target (reaching that subject IS the cross-agent authority — the
 *   static `control-caller-admin` cred, or a user-mode bearer whose scope carries `admin`).
 * - **Privileged tier, both modes**: the caller's own child (`spawner === caller`).
 * - **Privileged tier, user mesh (owner-domain)**: any agent whose stored owner equals the
 *   caller's owner — the human is the administrative boundary of their own subtree, so their cli
 *   actor and sibling agents reach every agent they own, not just what they personally spawned.
 *   Failing that, a FRESH ledger read granting `admin` allows (so a scope edit bites the next op
 *   with no reconnect); else the refusal names the boundary and the ADD-to-current re-grant
 *   (a bare `--scope admin` upsert would silently strip `spawn`).
 *
 * Fail closed everywhere: an unparseable caller, a target with no stored owner, or an unreadable
 * ledger authorizes nothing.
 */
export async function authorizeNamedControl(opts: {
  target: NamedControlTarget;
  /** Subject-pinned caller principal (`req.from.id`) — non-forgeable in auth mode. */
  caller: string;
  /** True when the request arrived on the admin control tier. */
  admin: boolean;
  /** True on a per-user-auth mesh. */
  userMode: boolean;
  /** Fresh capability-scope read for a principal's ledger row; `undefined` = no row. Consulted
   *  only on a user mesh. A throw is treated as "no row". */
  scopeOf: (owner: string, actor: string) => Promise<string[] | undefined>;
}): Promise<string | undefined> {
  const { target, caller, admin, userMode } = opts;
  if (admin) return undefined;
  if (target.spawner === caller) return undefined;
  if (userMode) {
    const pr = parsePrincipalKey(caller);
    if (pr && target.userOwner && pr.owner === target.userOwner) return undefined;
    if (pr) {
      const scope = await opts.scopeOf(pr.owner, pr.actor).catch(() => undefined);
      if (scope?.includes("admin")) return undefined;
    }
    return (
      `not authorized: ${target.name} runs under another owner - your grant covers agents under your own owner; ` +
      `cross-owner stop/attach needs scope "admin" on your actor. Re-grant with "admin" ADDED to your current ` +
      `scope (the upsert replaces the list; see \`cotal actor list\`)`
    );
  }
  return `not authorized: ${target.name} was not spawned by ${caller} (admin tier required)`;
}

/**
 * The manifest-launch authorization decision — pure, same contract style as
 * {@link authorizeNamedControl}. The dispatch already rejects a static-mesh privileged-tier
 * `launch` (operator-only there), so this decides the remaining cases:
 *
 * - **Admin tier**: allowed (operator behavior, both modes).
 * - **Privileged tier, user mesh**: you deploy your own team — the launch spec's apply-time
 *   stamped owner must EQUAL the subject-pinned caller's owner. Fail-closed on an unparseable
 *   caller or a spec with no owner; the cross-owner refusal names the `admin` ADD-to-current
 *   re-grant.
 */
export function authorizeLaunch(opts: {
  /** The launch spec's apply-time stamped owner (`u_…`); absent = an ownerless spec. */
  specOwner: string | undefined;
  /** Subject-pinned caller principal (`req.from.id`). */
  caller: string;
  /** True when the request arrived on the admin control tier. */
  admin: boolean;
  /** The run id, for the refusal copy only. */
  runId: string;
}): string | undefined {
  if (opts.admin) return undefined;
  const callerOwner = parsePrincipalKey(opts.caller)?.owner;
  if (callerOwner === undefined) return `launch denied: caller "${opts.caller}" is not a valid principal`;
  if (opts.specOwner === undefined || opts.specOwner !== callerOwner)
    return (
      `not authorized: run ${opts.runId} was applied under another owner - a spawn-scoped deploy launches only ` +
      `your own manifest agents; cross-owner deploys need scope "admin" on your actor. Re-grant with "admin" ` +
      `ADDED to your current scope (the upsert replaces the list; see \`cotal actor list\`)`
    );
  return undefined;
}
