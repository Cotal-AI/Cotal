/**
 * Host half of user-mode tool-results serving (SPEC §13.6, §13.9): issue or renew ONE managed
 * incarnation's `tool-results` serving material for the participant Manager that launched it.
 *
 * THE FENCES, AT EVERY MINT (issue and renew alike):
 * - the request is the closed core `tool-result-serve-authority` shape;
 * - its space is this host's space, and the manager's authorizing `actor` holds `supervise`;
 * - the manager-authority envelope is current: an open manager gate at the request's serve epoch,
 *   held by this owner's manager serve principal, with the host-keyed registration proof over
 *   actor, instance, lifecycle and public identities ({@link assertCurrentManagerRegistration},
 *   the same check enrollment and retirement preparation run);
 * - the target is this owner's live host-enrolled managed row at exactly that lifecycle, whose
 *   ledger parent is that authorizing actor, and whose lifecycle head, once activated, is `active`
 *   at that lifecycle. A revoked, retiring, tombstoned, successor or foreign target refuses before
 *   any effect.
 *
 * THE EFFECT. `issue` registers the incarnation's instance for its owner (gate, barrier,
 * registration, grant, ready status) and signs a short `endpoint-serve` JWT for the participant's
 * public serving key, scoped by the grant to that instance and its three handle-only commands. A
 * failure after the registration takes this call's record back down. `renew` re-authorizes the
 * same registration at the same epoch and re-signs; it never re-registers or widens. The answer
 * carries only public consent anchors; no seed, signer or provider material leaves the host.
 */
import {
  EpEnvelopeError,
  mintPublicUserJwt,
  parseToolResultServeAuthorityRequest,
  principalKey,
  registerToolResultServeInstance,
  renewToolResultServeGrant,
  deregisterToolResultServing,
  type AnchorResolver,
  type ServiceDeregistration,
  type SpaceAuth,
  type ToolResultConsentAnchorRecord,
  type ToolResultServeAuthorityMaterial,
  type ToolResultServeAuthorityRequest,
} from "@cotal-ai/core";
import { findManagedActor } from "./ledger.js";
import { assertCurrentManagerRegistration, type ObserveManagerGate } from "./managed-agent-enrollment.js";

/** The server cap on one serving credential. The managed row carries no expiry of its own, and
 *  the anchors the answer carries are only as current as the latest renewal, so the cap is short:
 *  a withdrawn anchor, a revoked row or a moved gate stops serving within one renewal. */
export const TOOL_RESULT_SERVE_TTL_SEC = 600;

export interface AuthorizeToolResultServeArgs {
  request: unknown;
  space: string;
  owner: string;
  /** The authorizing actor's ledger scope, read by the dispatcher from `request.actor`'s row. */
  scope: string[];
  dir: string;
  proofSecret: string | Uint8Array;
  observeManagerGate: ObserveManagerGate;
  readHead: (owner: string, actor: string) => Promise<{ lifecycleUid: string; state: string } | undefined>;
}

/** Every fence above the effect. Returns the parsed request for the caller to act on. */
export async function authorizeToolResultServe(args: AuthorizeToolResultServeArgs): Promise<ToolResultServeAuthorityRequest> {
  let r: ToolResultServeAuthorityRequest;
  try {
    r = parseToolResultServeAuthorityRequest(args.request);
  } catch (e) {
    throw new EpEnvelopeError("contract-invalid", e instanceof Error ? e.message : String(e));
  }
  if (r.space !== args.space)
    throw new EpEnvelopeError("permission-denied", `tool-results serve request names space ${r.space}, not host space ${args.space}`);
  if (!args.scope.includes("supervise"))
    throw new EpEnvelopeError("permission-denied", 'tool-results serve issuance needs scope "supervise"; spawn/admin do not imply it');
  await assertCurrentManagerRegistration(r, args, "tool-results serve");
  const row = findManagedActor(args.dir, args.owner, r.target.actor);
  if (row === undefined || row.lifecycleUid !== r.target.lifecycleUid)
    throw new EpEnvelopeError("expired", `no live managed grant for ${args.owner}/${r.target.actor} at lifecycle ${r.target.lifecycleUid}`);
  if (row.parent !== principalKey(args.owner, r.actor).key)
    throw new EpEnvelopeError("permission-denied", `managed agent ${r.target.actor} is not enrolled under the authorizing actor ${r.actor}`);
  // The head activates at the child's first connect-credential mint, which comes AFTER this issue
  // (the Manager writes the serving file before it launches the session). So an absent head is a
  // fresh enrollment not yet activated, authorized by the live row above; any head that exists
  // must be this lifecycle and active. A retiring or retired head, or a successor's, refuses.
  const head = await args.readHead(args.owner, r.target.actor);
  if (head !== undefined && (head.lifecycleUid !== r.target.lifecycleUid || head.state !== "active"))
    throw new EpEnvelopeError("expired", `managed agent ${r.target.actor} lifecycle ${r.target.lifecycleUid} is not the active head (${head.state} at ${head.lifecycleUid})`);
  return r;
}

/** The host's current public `consents`/`tool-results` anchor for its signer, as a closed record,
 *  or nothing (a host with no signer, or one whose anchor is withdrawn, out of window or not so
 *  scoped): the session then refuses every consent. */
export async function currentToolResultConsentAnchors(
  signer: { keyId: string; resolveAnchor: AnchorResolver } | undefined,
  at: number,
): Promise<ToolResultConsentAnchorRecord[] | undefined> {
  if (signer === undefined) return undefined;
  const a = await signer.resolveAnchor(signer.keyId);
  if (a === undefined || a.revoked === true || at < a.validFrom || at > a.validTo) return undefined;
  if (!a.roles.includes("consents") || !(a.scope?.consents ?? []).includes("tool-results")) return undefined;
  return [{ keyId: a.keyId, publicKey: a.publicKey, owner: a.owner, validFrom: a.validFrom, validTo: a.validTo }];
}

export interface ToolResultServeEffect {
  owner: string;
  space: string;
  auth: SpaceAuth;
  servers: string;
  consentAnchors?: ToolResultConsentAnchorRecord[];
}

/** The effect for an already-authorized request: register-and-mint or renew-and-mint. */
export async function issueToolResultServe(r: ToolResultServeAuthorityRequest, e: ToolResultServeEffect): Promise<ToolResultServeAuthorityMaterial> {
  const { owner } = e;
  const target = { auth: e.auth, servers: e.servers, space: e.space, tls: false, lifecycleUid: r.target.lifecycleUid, owner };
  const mint = (fence: Parameters<typeof mintPublicUserJwt>[3]["serveIssuance"], grant: Parameters<typeof mintPublicUserJwt>[3]["endpointServe"]) =>
    mintPublicUserJwt(e.auth, r.serve.id, "endpoint-serve", {
      principal: { owner, actor: r.target.actor },
      lifecycleUid: r.target.lifecycleUid,
      expiresInSeconds: TOOL_RESULT_SERVE_TTL_SEC,
      endpointServe: grant,
      serveIssuance: fence,
    });
  const { grant, minted } = r.operation === "issue"
    ? await registerToolResultServeInstance({ ...target, principal: principalKey(owner, r.target.actor).key, mint })
    : await renewToolResultServeGrant({ ...target, epoch: r.epoch!, mint });
  return {
    v: 1,
    kind: "tool-result-serve-authority",
    operation: r.operation,
    space: e.space,
    owner,
    target: r.target,
    requestId: r.requestId,
    grant,
    credential: minted,
    ...(e.consentAnchors !== undefined ? { consentAnchors: e.consentAnchors } : {}),
  };
}

/** Retirement's half: take the incarnation's `tool-results` record down. An absent record is a
 *  no-op answer, which proves nothing about enforcement; the revoked managed grant and the
 *  credential's short expiry are what end serving. */
export async function retireToolResultServe(args: { auth: SpaceAuth; servers: string; space: string; lifecycleUid: string }): Promise<ServiceDeregistration> {
  return deregisterToolResultServing({ ...args, tls: false });
}
