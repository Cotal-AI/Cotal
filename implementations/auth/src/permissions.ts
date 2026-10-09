/**
 * The callout's `permissionsFor` supplier — the thin `@cotal-ai/auth` adapter that turns a validated
 * user token into a call to core's IdP-agnostic, principal-shaped `permissionsFor` builder. This is the
 * boundary the flip's Q4 review pinned: core asserts only the generic owner+actor grammar; this adapter
 * enforces the token-specific invariants (derived owner, `act.scope` as the single capability authority)
 * and resolves the agent's channel ACL server-side, then hands core a `MintPrincipal`.
 */
import { permissionsFor, assertDerivedOwnerToken, type MintPrincipal, type MintOpts } from "@cotal-ai/core";
import { VIEW_REQUIRED_SCOPE } from "./token.js";
import type { UserTokenSession, ValidatedUserToken } from "./token.js";

/** #2312: the identity plane's session decision (see `session-redemption.ts`). */
export type SessionVerifier = (
  principal: { owner: string; actor: string; lifecycleUid?: string },
  claim: { endpoint: string; sessionId: string; epoch: number },
) => Promise<UserTokenSession>;

/** Out-of-band key on a session-caller permission set: the grant expiry (unix seconds) the callout
 *  binds the minted JWT to, instead of the bearer's. Stripped before the JWT is encoded. */
export const SESSION_EXP = "__cotalSessionExp";

/** The callout's issuing seam for an eligible user's `manager-caller` view (SPEC 13.15). `mint`
 *  builds the view's permission set for the given `issued` pair, so the evidence is the set that is signed.
 *  Issues a fresh generation, or renews the generation the connection's accepted row already names. */
export type UserCallerIssuer = (args: {
  t: ValidatedUserToken;
  connId: string;
  mint: (issued: { generation: string; acceptedToken: string }) => Record<string, unknown>;
}) => Promise<Record<string, unknown>>;

/** The per-agent channel/role ACL a user-mode grant needs — resolved SERVER-SIDE (the spawn ledger /
 *  persona registry, keyed by the authenticated principal), because the user token carries the identity
 *  and capabilities but NOT the channel read/post ACL. Injected by the composition root that launches the
 *  callout (`cotal up`), so this package stays free of any ledger/persona storage concern. */
export type AclResolver = (
  t: ValidatedUserToken,
) => Pick<MintOpts, "allowSubscribe" | "allowPublish" | "role" | "lifecycleUid"> & {
  /** The actor's CURRENT capability grant (the row's scope), so the mint can re-contain the
   *  bearer's capabilities against the row AS OF THE MINT, not only as of the connect gate. */
  scope: string[];
  /** The row space the actor was found in. */
  kind?: "interactive" | "managed-agent";
  /** Fresh direct-parent grant, independently of the child's persona-derived scope. An admin
   *  parent's containment bypass does not imply this grant (SPEC 13.15). */
  parentHasRun?: boolean;
};

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
export function calloutPermissions(resolveAcl: AclResolver): (t: ValidatedUserToken, connId: string) => Record<string, unknown>;
export function calloutPermissions(
  resolveAcl: AclResolver,
  authorizeManagerCaller: (owner: string, instanceId: string) => Promise<void>,
): (t: ValidatedUserToken, connId: string) => Record<string, unknown> | Promise<Record<string, unknown>>;
export function calloutPermissions(
  resolveAcl: AclResolver,
  authorizeManagerCaller: (owner: string, instanceId: string) => Promise<void>,
  verifySession: SessionVerifier,
): (t: ValidatedUserToken, connId: string) => Record<string, unknown> | Promise<Record<string, unknown>>;
export function calloutPermissions(
  resolveAcl: AclResolver,
  authorizeManagerCaller: (owner: string, instanceId: string) => Promise<void>,
  verifySession: SessionVerifier,
  issueUserCaller: UserCallerIssuer,
): (t: ValidatedUserToken, connId: string) => Record<string, unknown> | Promise<Record<string, unknown>>;
export function calloutPermissions(
  resolveAcl: AclResolver,
  authorizeManagerCaller?: (owner: string, instanceId: string) => Promise<void>,
  verifySession?: SessionVerifier,
  issueUserCaller?: UserCallerIssuer,
): (t: ValidatedUserToken, connId: string) => Record<string, unknown> | Promise<Record<string, unknown>> {
  return (t, connId) => {
    assertDerivedOwnerToken(t.owner); // user-mode owners are derived — never `local`, never an nkey
    const caps = t.act.scope ?? [];
    // Single capability authority: if a top-level `scope` is present it must equal `act.scope` exactly —
    // two independent capability lists is a confused-authority footgun (which one gates the spawn grant?).
    const norm = (xs: string[]) => JSON.stringify([...xs].sort());
    if (t.scope.length && norm(t.scope) !== norm(caps))
      throw new Error(
        "callout permissions: top-level scope != act.scope - act.scope is the single capability authority",
      );
    const principal: MintPrincipal = { owner: t.owner, actor: t.act.actor, connId };
    // A claimless bearer of EITHER shape mints nothing, even in a composition that skipped the
    // connect gate (the equality against the row's uid follows below; this refusal is the
    // claim-side half).
    if (t.act.lifecycleUid === undefined)
      throw new Error("callout permissions: bearer carries no lifecycle claim - re-exchange for a fresh bearer (lifecycle-bound from v0.4)");
    // FRESH-ROW re-read AT THE MINT, both arms: the connect boundary's ledger read
    // (`ledgerAuthorizeConnect`) is not the final read before authority is minted - a
    // revoke/re-grant landing between the two reads would mint from stale claims (for a view
    // bearer, the full elevated profile; for an agent bearer, capabilities the current grant no
    // longer carries). The resolver re-reads the CURRENT row and enforces lifecycle equality
    // itself; here the bearer's capabilities are re-contained against the CURRENT grant, so a
    // narrowed or moved row refuses at the mint. Two sequential reads narrow the window rather
    // than linearize it (strict revocation linearization is a gate/CAS write, the 13.1 fence
    // pattern); the mint trusts the SECOND read.
    const acl = resolveAcl(t);
    if (acl.lifecycleUid !== t.act.lifecycleUid)
      throw new Error("callout permissions: the current row's lifecycle is not the bearer's - the alias was re-granted during connect; re-exchange for a fresh bearer");
    const current = new Set(acl.scope);
    for (const s of caps)
      if (!current.has(s))
        throw new Error(`callout permissions: bearer capability "${s}" is no longer in the actor's CURRENT grant - re-exchange for a fresh bearer`);
    if (t.act.view !== undefined) {
      // ELEVATED VIEW: the exchange already ledger-authorized it, the connect gate fresh-read
      // the row, and the containment above re-checked the CURRENT row at the mint. The LAST
      // defense-in-depth re-assert: the bearer's own capability list must carry the view's
      // required scope, or nothing is minted. View names ARE profile names (a closed enum,
      // never a client-chosen profile passthrough); channel ACLs don't apply to these profiles.
      const need = VIEW_REQUIRED_SCOPE[t.act.view];
      if (need !== undefined && !caps.includes(need))
        throw new Error(`callout permissions: view "${t.act.view}" without capability "${need}" in act.scope - refusing to mint`);
      if (t.act.view === "manager-service")
        throw new Error('callout permissions: "manager-service" is a typed material exchange, not a connect profile; raw view bearers are refused');
      if (t.act.view === "session-caller") {
        // #2312: the SAME `session-caller` rows the static arm mints, for the ONE session the
        // identity plane re-verifies here against the live session row (the exchange already did
        // once; a session ended or a manager restarted since then refuses at this mint).
        const claim = t.act.session!;
        if (!verifySession)
          throw new Error("callout permissions: session-caller needs the server-side session verifier");
        return verifySession(
          { owner: t.owner, actor: t.act.actor, lifecycleUid: t.act.lifecycleUid },
          { endpoint: claim.endpoint, sessionId: claim.sessionId, epoch: claim.epoch },
        ).then((s) => {
          if (s.exp !== claim.exp) throw new Error("callout permissions: the session row's expiry is not the bearer's session claim");
          return {
            ...permissionsFor("session-caller", t.space, principal, { sessionCaller: { endpoint: s.endpoint, sessionId: s.sessionId, epoch: s.epoch } }),
            [SESSION_EXP]: s.exp,
          };
        });
      }
      if (t.act.view === "transfer-writer")
        return permissionsFor("transfer-writer", t.space, principal, { transferWriter: t.act.transferWriter! });
      if (t.act.view === "manager-caller") {
        const instanceId = t.act.managerInstanceId!;
        if (!authorizeManagerCaller)
          throw new Error("callout permissions: manager-caller needs the server-side manager gate authorizer");
        const mint = (issued?: { generation: string; acceptedToken: string }) => permissionsFor(
          "manager-caller",
          t.space,
          { ...principal, lifecycleUid: t.act.lifecycleUid },
          { capabilities: caps, lifecycleUid: t.act.lifecycleUid, managerInstanceId: instanceId, ...(issued ? { issued } : {}) },
        );
        // Interactive issuance is unchanged. A managed seat needs both its current persona scope
        // and the fresh direct-parent grant. The mint still uses only signed act.scope.
        return authorizeManagerCaller(t.owner, instanceId).then(() =>
          (acl.kind === "interactive" || (acl.kind === "managed-agent" && current.has("run") && acl.parentHasRun === true))
            && issueUserCaller ? issueUserCaller({ t, connId, mint }) : mint());
      }
      return permissionsFor(
        t.act.view,
        t.space,
        // The bearer's ledger lifecycle claim rides the principal: an operator INSTRUMENT view
        // (deployer / control-caller-*) mints lifecycle-keyed ep caller rows (1c.2b) and refuses
        // to mint without one - the claim was already asserted present + row-current above.
        { ...principal, lifecycleUid: t.act.lifecycleUid },
        // The user-mode deployer's ep rows carry the PRIVILEGED instrument set: the manager's
        // owner-equality launch authorization governs, never the admin any-mode reach.
        t.act.view === "deployer" ? { controlTier: "privileged" as const } : {},
      );
    }
    // The ledger row's lifecycleUid rides the PRINCIPAL: core's agent arm mints the lifecycle-keyed
    // dm/dlv/chathist grant names from it (SPEC 13.1) and refuses to mint without one.
    const { scope: _rowScope, kind: _kind, parentHasRun: _parentHasRun, ...aclOpts } = acl;
    return permissionsFor(
      "agent",
      t.space,
      { ...principal, lifecycleUid: acl.lifecycleUid },
      { ...aclOpts, capabilities: caps },
    );
  };
}
