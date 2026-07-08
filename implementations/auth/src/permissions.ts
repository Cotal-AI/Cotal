/**
 * The callout's `permissionsFor` supplier — the thin `@cotal-ai/auth` adapter that turns a validated
 * user token into a call to core's IdP-agnostic, principal-shaped `permissionsFor` builder. This is the
 * boundary the flip's Q4 review pinned: core asserts only the generic owner+actor grammar; this adapter
 * enforces the token-specific invariants (derived owner, `act.scope` as the single capability authority)
 * and resolves the agent's channel ACL server-side, then hands core a `MintPrincipal`.
 */
import { permissionsFor, assertDerivedOwnerToken, type MintPrincipal, type MintOpts } from "@cotal-ai/core";
import type { ValidatedUserToken } from "./token.js";

/** The per-agent channel/role ACL a user-mode grant needs — resolved SERVER-SIDE (the spawn ledger /
 *  persona registry, keyed by the authenticated principal), because the user token carries the identity
 *  and capabilities but NOT the channel read/post ACL. Injected by the composition root that launches the
 *  callout (`cotal up`), so this package stays free of any ledger/persona storage concern. */
export type AclResolver = (
  t: ValidatedUserToken,
) => Pick<MintOpts, "allowSubscribe" | "allowPublish" | "role">;

/**
 * Build the callout's `permissionsFor` hook. Maps `ValidatedUserToken` → `MintPrincipal` → core's
 * `permissionsFor("agent", …)`. `connId` here is the CLIENT-CHOSEN inbox nonce the callout reads from
 * `req.connect_opts.name` (NOT `req.user_nkey`, which the client cannot know pre-connect); it scopes the
 * reply inbox `_INBOX_<connId>.>`.
 *
 * Invariants enforced HERE (not in core):
 *  - the owner is a DERIVED owner (`u_…`) — user mode never accepts the reserved dev `local` owner;
 *  - `act.scope` is the SINGLE capability authority: a token that ALSO carries a top-level `scope` must
 *    have them agree, else it is rejected (the confused-authority guard the Q4 review required closed the
 *    moment `permissionsFor(validated)` became production).
 */
export function calloutPermissions(
  resolveAcl: AclResolver,
): (t: ValidatedUserToken, connId: string) => Record<string, unknown> {
  return (t, connId) => {
    assertDerivedOwnerToken(t.owner); // user-mode owners are derived — never `local`, never an nkey
    const caps = t.act.scope ?? [];
    // Single capability authority: if a top-level `scope` is present it must equal `act.scope` exactly —
    // two independent capability lists is a confused-authority footgun (which one gates the spawn grant?).
    const norm = (xs: string[]) => JSON.stringify([...xs].sort());
    if (t.scope.length && norm(t.scope) !== norm(caps))
      throw new Error(
        "callout permissions: top-level scope != act.scope — act.scope is the single capability authority",
      );
    const acl = resolveAcl(t);
    const principal: MintPrincipal = { owner: t.owner, actor: t.act.actor, connId };
    return permissionsFor("agent", t.space, principal, { ...acl, capabilities: caps });
  };
}
