/**
 * The platform control door (SPEC 13.1, 13.6, 13.9): one in-process method on the hosted
 * auth-service handle. It issues the manager-service request family for the one control manager the
 * platform backend assigned to this context's account, under a derived `p_…` owner. It has no route,
 * no capability and no IdP input, and it adds no request kind: each inner request goes through the
 * same parser and plane function the human route uses, with the assignment in place of `supervise`.
 */
import {
  EpEnvelopeError,
  assertPlatformOwnerToken,
  remoteManagerActors,
  type PlatformControlAssignment,
  type PlatformControlAuthorityRequest,
  type PlatformControlAuthorityResult,
  type PlatformControlInnerRequest,
} from "@cotal-ai/core";

/** Who an issuance is for. A human holder carries its fresh ledger scope; a platform holder carries
 * the assignment the door read for this call. The platform arm never carries a scope. */
export type ManagerAuthorityHolder =
  | { holder?: "human"; owner: string; scope: string[] }
  | { holder: "platform"; owner: string; assignment: PlatformControlAssignment };

/** The one authorization step every manager-service function shares: `supervise` for a human (its
 * existing refusal sentence unchanged), the door's current assignment for the platform control
 * manager. */
export function requireManagerAuthorityHolder(h: ManagerAuthorityHolder, instanceId: string, humanRefusal: string): void {
  if (h.holder === "platform") {
    assertPlatformOwnerToken(h.owner);
    if (h.assignment.state !== "assigned" || h.assignment.instanceId !== instanceId)
      throw new EpEnvelopeError("permission-denied", `platform control instance ${instanceId} is not the current assignment's instance`);
    return;
  }
  if (!h.scope.includes("supervise")) throw new EpEnvelopeError("permission-denied", humanRefusal);
}

const INNER_KINDS = new Set([
  "manager-service-authority",
  "manager-service-maintenance",
  "manager-retained-agent-validation",
  "manager-goal-index-scan",
  "manager-admin-authorization",
  "manager-run-admission",
  "manager-run-attempt",
]);
const MANAGED_AGENT_KINDS = new Set([
  "manager-managed-agent-enrollment",
  "manager-managed-agent-prepare-retirement",
  "manager-managed-agent-runtime-create",
  "manager-managed-agent-runtime-status",
]);

const SESSION_FIELDS = "endpoint,epoch,exp,id,sessionId";

function badRequest(what: string): never {
  throw new EpEnvelopeError("bad-request", `platform control request ${what}`);
}

/** Closed envelope parser. Unknown fields, `idpToken` included, are refused, never ignored. The
 * reused manager-service parser checks the `session` members but not its key set, so the door closes
 * that nested object here; the human route's parser is unchanged. */
export function parsePlatformControlAuthorityRequest(raw: unknown): PlatformControlAuthorityRequest {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) badRequest("must be an object");
  const o = raw as Record<string, unknown>;
  const allowed = new Set(["v", "kind", "space", "accountPublicKey", "assignmentRevision", "request"]);
  for (const key of Object.keys(o)) if (!allowed.has(key)) badRequest(`carries unknown field ${JSON.stringify(key)} (the protocol is closed)`);
  if (o.v !== 1 || o.kind !== "platform-control-authority") badRequest('must carry { v: 1, kind: "platform-control-authority" }');
  if (typeof o.space !== "string" || o.space.length === 0) badRequest("requires a space");
  if (typeof o.accountPublicKey !== "string" || !/^A[A-Z2-7]{55}$/.test(o.accountPublicKey)) badRequest("requires an account public key");
  if (typeof o.assignmentRevision !== "number" || !Number.isSafeInteger(o.assignmentRevision) || o.assignmentRevision < 0)
    badRequest("requires a non-negative integer assignmentRevision");
  const inner = o.request;
  if (inner === null || typeof inner !== "object" || Array.isArray(inner)) badRequest("requires an inner request object");
  const kind = (inner as { kind?: unknown }).kind;
  if (typeof kind === "string" && MANAGED_AGENT_KINDS.has(kind))
    throw new EpEnvelopeError("unimplemented", "managed agent kinds are decided by the platform on its own route, not by the platform control door");
  if (typeof kind !== "string" || !INNER_KINDS.has(kind)) badRequest(`carries unknown inner kind ${JSON.stringify(kind)}`);
  if ((inner as { actor?: unknown }).actor !== "cli") badRequest('inner request actor must be the envelope constant "cli"');
  for (const key of ["instanceId", "managerLifecycleUid"] as const)
    if (typeof (inner as Record<string, unknown>)[key] !== "string") badRequest(`inner request requires ${key}`);
  const session = (inner as { session?: unknown }).session;
  if (session !== undefined && (session === null || typeof session !== "object" || Object.keys(session).sort().join(",") !== SESSION_FIELDS))
    badRequest("inner session must be exactly { id, endpoint, sessionId, epoch, exp } (the protocol is closed)");
  return o as unknown as PlatformControlAuthorityRequest;
}

export interface PlatformControlDeps {
  space: string;
  accountPublicKey: string;
  owner: string;
  observeAssignment(space: string, accountPublicKey: string): Promise<PlatformControlAssignment | null>;
  /** Read-only view of one manager instance: whether its `svc.manager` record is current, and its gate. */
  observeManagerInstance(instanceId: string): Promise<{ registered: boolean; gate: { state: string; principal: string } | null }>;
  dispatch(holder: Extract<ManagerAuthorityHolder, { holder: "platform" }>, request: PlatformControlInnerRequest): Promise<unknown>;
}

/** Build the door. Every refusal below runs before dispatch and writes nothing. */
export function makePlatformControlAuthority(deps: PlatformControlDeps) {
  return async <R extends PlatformControlInnerRequest>(raw: PlatformControlAuthorityRequest<R>): Promise<PlatformControlAuthorityResult<R>> => {
    const envelope = parsePlatformControlAuthorityRequest(raw);
    if (envelope.space !== deps.space || envelope.accountPublicKey !== deps.accountPublicKey)
      throw new EpEnvelopeError("permission-denied", "platform control request names another space or account than this authority context");
    let assignment: PlatformControlAssignment | null;
    try {
      assignment = await deps.observeAssignment(deps.space, deps.accountPublicKey);
    } catch (e) {
      throw new EpEnvelopeError("unavailable", `platform control assignment is unreadable: ${(e as Error)?.message ?? String(e)}`);
    }
    const inner = envelope.request as PlatformControlInnerRequest & { space: string; instanceId: string; managerLifecycleUid: string; operation?: string; accountPublicKey?: string };
    if (!assignment || assignment.state !== "assigned")
      throw new EpEnvelopeError("permission-denied", "platform control has no current assignment for this account");
    if (assignment.v !== 1 || assignment.space !== deps.space || assignment.accountPublicKey !== deps.accountPublicKey ||
        assignment.assignmentRevision !== envelope.assignmentRevision)
      throw new EpEnvelopeError("permission-denied", "platform control request does not match the current assignment's account or revision");
    if (inner.instanceId !== assignment.instanceId || inner.managerLifecycleUid !== assignment.lifecycleUid)
      throw new EpEnvelopeError("permission-denied", "platform control request names an instance or lifecycle the current assignment does not");
    if (inner.space !== deps.space || (inner.accountPublicKey !== undefined && inner.accountPublicKey !== deps.accountPublicKey))
      throw new EpEnvelopeError("permission-denied", "platform control inner request names another space or account");
    // The assigned instance's gate, when it exists, must name this owner's serve principal: the door
    // never issues for an instance another owner registered.
    const own = await deps.observeManagerInstance(assignment.instanceId);
    const servePrincipal = `${deps.owner}.${remoteManagerActors(assignment.instanceId).serve}`;
    if (own.gate && own.gate.principal !== servePrincipal)
      throw new EpEnvelopeError("permission-denied", `platform control instance ${assignment.instanceId} is registered to another principal`);
    if (inner.kind === "manager-service-authority" && (inner.operation === "prepare" || inner.operation === "activate") &&
        assignment.predecessorInstanceId !== undefined) {
      // Read-only: the door never probes, freezes, evicts, revokes or deregisters the predecessor.
      const predecessor = await deps.observeManagerInstance(assignment.predecessorInstanceId);
      if (predecessor.registered || predecessor.gate?.state === "frozen")
        throw new EpEnvelopeError("failed-precondition", `platform control predecessor ${assignment.predecessorInstanceId} is still registered or frozen; it must stop through its own path first`);
    }
    return await deps.dispatch({ holder: "platform", owner: deps.owner, assignment }, inner) as PlatformControlAuthorityResult<R>;
  };
}
