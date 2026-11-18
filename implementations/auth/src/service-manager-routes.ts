import { assertDerivedOwnerToken, assertLifecycleToken, assertValidOwnerToken, EpEnvelopeError, type RemoteManagedAgentEnrollmentRequest, type RemoteManagedAgentPrepareRetirementRequest, type RemoteManagerAdminAuthorizationRequest, type RemoteManagerAuthorityRequest, type RemoteManagerMaintenanceRequest, type RemoteRetainedAgentValidationRequest } from "@cotal-ai/core";
import { type IncomingMessage, type ServerResponse } from "node:http";
import { validateRetainedManagedAgent } from "./continuity.js";
import { deriveOwnerForIdpSubject } from "./derive.js";
import { verifyIdpToken } from "./idp.js";
import { findInteractiveActor, ledgerAuthorizeGrant } from "./ledger.js";
import { completeRemoteRetainedAgentValidation } from "./retained-manager-validation.js";
import { readJsonBody, REFUSAL_STATUS, refuseCapability, refuseExchange, RequestBodyError, send, sendRequestError } from "./service-http.js";
import type { ExchangePolicy, HandlerCtx, ManagedLifecycleActivationRequest, ManagedLifecycleActivationResult } from "./service.js";

type ManagerAuthorityDispatchCtx = Pick<HandlerCtx, "space" | "dir" | "secrets" | "managerServiceAuthority" | "maintainRemoteManager" | "validateRetainedAgent" | "enrollManagedAgent" | "prepareManagedAgentRetirement" | "scanManagerGoalIndex" | "authorizeManagerAdmin" | "authorizeManagerParticipation" | "admitManagerRun" | "submitManagerRun" | "issueManagerRunAttempt" | "revokeManagerRun" | "cancelManagerRun">;

/** Dispatch one already-authenticated manager-authority body through the fixed host validator. */
export async function dispatchManagerAuthorityRequest(
  ctx: ManagerAuthorityDispatchCtx,
  owner: string,
  body: { request: unknown },
): Promise<unknown> {
  if (body.request === null || typeof body.request !== "object" || Array.isArray(body.request))
    throw new Error("manager-service authority request must be an object");
  const request = body.request as { kind?: unknown; actor?: unknown };
  if (typeof request.actor !== "string") throw new Error("manager-service authority request requires an actor");
  const row = ledgerAuthorizeGrant(ctx.dir)(owner, request.actor);
  // #1972: this service owns the ledger and the space's provisioning authority, so it is the host
  // that enrolls a remote manager's managed agent and prepares its terminal release.
  if (request.kind === "manager-managed-agent-enrollment")
    return ctx.enrollManagedAgent({ owner, scope: row.scope ?? [], request: body.request as RemoteManagedAgentEnrollmentRequest });
  if (request.kind === "manager-managed-agent-prepare-retirement")
    return ctx.prepareManagedAgentRetirement({ owner, scope: row.scope ?? [], request: body.request as RemoteManagedAgentPrepareRetirementRequest });
  // The hosted runtime kinds read and drive host-owned intent state that stock does not hold.
  if (request.kind === "manager-managed-agent-runtime-create" || request.kind === "manager-managed-agent-runtime-status")
    throw new EpEnvelopeError("unimplemented", "managed agent runtime create and status must be handled by host platform interception");
  // A delegated user intent creates and consumes a record in the host's intent store, which stock does not hold.
  if (request.kind === "delegated-user-intent" || request.kind === "manager-delegated-user-intent-execution")
    throw new EpEnvelopeError("unimplemented", "delegated user intent admission and execution must be handled by host platform interception");
  if (request.kind === "manager-retained-agent-validation") {
    const retained = await ctx.validateRetainedAgent({
      owner,
      scope: row.scope ?? [],
      request: body.request as RemoteRetainedAgentValidationRequest,
    });
    const authority = await validateRetainedManagedAgent({
      store: ctx.secrets,
      dir: ctx.dir,
      space: ctx.space,
      owner: retained.target.owner,
      actor: retained.target.actor,
      actorToken: retained.actorToken,
      sentinelCreds: retained.sentinelCreds,
    });
    return completeRemoteRetainedAgentValidation(retained, owner, authority);
  }
  if (request.kind === "manager-goal-index-scan")
    return ctx.scanManagerGoalIndex({ owner, scope: row.scope ?? [], request: body.request as import("@cotal-ai/core").RemoteManagerGoalIndexScanRequest });
  if (request.kind === "manager-admin-authorization")
    return ctx.authorizeManagerAdmin({ owner, scope: row.scope ?? [], request: body.request as RemoteManagerAdminAuthorizationRequest });
  if (request.kind === "manager-participation-authorization")
    return ctx.authorizeManagerParticipation
      ? ctx.authorizeManagerParticipation({ owner, scope: row.scope ?? [], request: body.request as import("@cotal-ai/core").RemoteManagerParticipationAuthorizationRequest })
      : Promise.reject(new EpEnvelopeError("unimplemented", "manager participation authorization is unavailable"));
  if (request.kind === "manager-run-admission")
    return ctx.admitManagerRun({ owner, scope: row.scope ?? [], request: body.request });
  if (request.kind === "manager-run-submission") {
    if (!ctx.submitManagerRun) throw new EpEnvelopeError("unimplemented", "issuing host has no keyed submission handler");
    return ctx.submitManagerRun({ owner, scope: row.scope ?? [], request: body.request });
  }
  if (request.kind === "manager-run-cancel") {
    if (!ctx.cancelManagerRun) throw new EpEnvelopeError("unimplemented", "this issuing host has no run-cancel handler");
    return ctx.cancelManagerRun({ owner, scope: row.scope ?? [], request: body.request });
  }
  if (request.kind === "manager-run-revoke") {
    if (ctx.revokeManagerRun === undefined) throw new EpEnvelopeError("unimplemented", "this issuing host has no run revoke handler");
    return ctx.revokeManagerRun({ owner, scope: row.scope ?? [], request: body.request });
  }
  if (request.kind === "manager-run-attempt")
    return ctx.issueManagerRunAttempt({ owner, scope: row.scope ?? [], request: body.request });
  if (request.kind === "manager-service-maintenance")
    return ctx.maintainRemoteManager({ owner, scope: row.scope ?? [], request: body.request as RemoteManagerMaintenanceRequest });
  return ctx.managerServiceAuthority({ owner, scope: row.scope ?? [], request: body.request as RemoteManagerAuthorityRequest });
}

const INTERACTIVE_RETIRE_KEYS = new Set(["owner", "actor", "lifecycleUid"]);

/** The interactive retirement door. Every refusal before the barrier starts retired nothing and
 *  answers `outcome: "not-executed"` (SPEC 13.3), with the plane's native `code` when the plane
 *  raised it. A failure inside the barrier answers 400 with no outcome, which reads as unknown. */
export async function handleInteractiveLifecycleRetirement(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: HandlerCtx,
): Promise<void> {
  const before = { outcome: "not-executed" } as const;
  if (req.method !== "POST") return send(res, 405, { error: "POST only", ...before });
  if (req.headers.origin !== undefined) return send(res, 403, { error: "browser-origin requests are not served here", ...before });
  if (!/^application\/json\b/.test(req.headers["content-type"] ?? ""))
    return send(res, 415, { error: "content-type must be application/json", ...before });
  if (req.headers.authorization !== `Bearer ${ctx.cap}`)
    return refuseCapability(res, ctx, "missing/invalid exchange capability - interactive lifecycle retirement is a loopback operator action", { ...before });
  const body = await readJsonBody(req);
  if (body === null || typeof body !== "object" || Array.isArray(body))
    return send(res, 400, { error: "interactive lifecycle retirement needs { owner, actor, lifecycleUid }", ...before });
  for (const key of Object.keys(body))
    if (!INTERACTIVE_RETIRE_KEYS.has(key))
      return send(res, 400, { error: `interactive lifecycle retirement carries the unknown field "${key}"`, ...before });
  const raw = body as { owner?: unknown; actor?: unknown; lifecycleUid?: unknown };
  if (typeof raw.owner !== "string" || typeof raw.actor !== "string" || typeof raw.lifecycleUid !== "string")
    return send(res, 400, { error: "interactive lifecycle retirement needs string { owner, actor, lifecycleUid }", ...before });
  let owner: string, actor: string, lifecycleUid: string;
  try {
    owner = assertDerivedOwnerToken(raw.owner);
    actor = assertValidOwnerToken(raw.actor);
    lifecycleUid = assertLifecycleToken(raw.lifecycleUid);
  } catch (e) {
    return send(res, 400, { error: e instanceof Error ? e.message : String(e), ...before });
  }
  const row = findInteractiveActor(ctx.dir, owner, actor);
  if (!row) return send(res, 404, { error: `interactive actor "${owner}/${actor}" is not granted`, ...before });
  if (row.lifecycleUid !== lifecycleUid)
    return send(res, 409, { error: `interactive actor "${owner}/${actor}" is current at lifecycle ${row.lifecycleUid ?? "<missing>"}, not ${lifecycleUid}`, ...before });
  try {
    return send(res, 200, await ctx.retireInteractiveLifecycle({ owner, actor, lifecycleUid }));
  } catch (e) {
    if (e instanceof EpEnvelopeError && e.outcome === "not-executed")
      return send(res, REFUSAL_STATUS[e.code] ?? 500, { error: e.message, code: e.code, outcome: e.outcome });
    throw e;
  }
}

/** The host's terminal step for a managed lifecycle whose remote manager is gone: the same request
 *  guards as the interactive door, but it requires the managed grant to be REVOKED first (the
 *  `prepareAgentRetirement` contract) and runs the rail's `managedRetirementOpId(uid)` operation. */
export async function handleManagedLifecycleRetirement(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: HandlerCtx,
): Promise<void> {
  if (req.method !== "POST") return send(res, 405, { error: "POST only" });
  if (req.headers.origin !== undefined) return send(res, 403, { error: "browser-origin requests are not served here" });
  if (!/^application\/json\b/.test(req.headers["content-type"] ?? ""))
    return send(res, 415, { error: "content-type must be application/json" });
  if (req.headers.authorization !== `Bearer ${ctx.cap}`)
    return refuseCapability(res, ctx, "missing/invalid exchange capability - managed lifecycle retirement is a loopback host action");
  const body = await readJsonBody(req);
  if (body === null || typeof body !== "object" || Array.isArray(body))
    return send(res, 400, { error: "managed lifecycle retirement needs { owner, actor, lifecycleUid }" });
  for (const key of Object.keys(body))
    if (!INTERACTIVE_RETIRE_KEYS.has(key))
      return send(res, 400, { error: `managed lifecycle retirement carries the unknown field "${key}"` });
  const raw = body as { owner?: unknown; actor?: unknown; lifecycleUid?: unknown };
  if (typeof raw.owner !== "string" || typeof raw.actor !== "string" || typeof raw.lifecycleUid !== "string")
    return send(res, 400, { error: "managed lifecycle retirement needs string { owner, actor, lifecycleUid }" });
  const owner = assertDerivedOwnerToken(raw.owner);
  const actor = assertValidOwnerToken(raw.actor);
  const lifecycleUid = assertLifecycleToken(raw.lifecycleUid);
  try {
    return send(res, 200, await ctx.retireManagedLifecycle({ owner, actor, lifecycleUid }));
  } catch (e) {
    if (e instanceof EpEnvelopeError && e.code === "conflict") return send(res, 409, { error: e.message });
    throw e;
  }
}

const MANAGED_ACTIVATE_KEYS = new Set(["accountPublicKey", "owner", "actor", "lifecycleUid"]);

/** The separate host process's exact activation door. The capability selects this running auth
 *  authority, while `accountPublicKey` binds the request to the account assignment the host meant
 *  to address. Every route and parser refusal precedes the plane call. The plane then supplies the
 *  existing readiness fence and UID-exact lifecycle semantics unchanged. */
export async function handleManagedLifecycleActivation(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: HandlerCtx,
): Promise<void> {
  const before = { outcome: "not-executed" } as const;
  if (req.method !== "POST") return send(res, 405, { error: "POST only", code: "bad-request", ...before });
  if (req.headers.origin !== undefined)
    return send(res, 403, { error: "browser-origin requests are not served here", code: "permission-denied", ...before });
  if (!/^application\/json\b/.test(req.headers["content-type"] ?? ""))
    return send(res, 415, { error: "content-type must be application/json", code: "bad-request", ...before });
  if (req.headers.authorization !== `Bearer ${ctx.cap}`)
    return refuseCapability(res, ctx, "missing/invalid exchange capability - managed lifecycle activation is a loopback host action", { code: "unauthenticated", ...before });
  let body: unknown;
  try {
    body = await readJsonBody(req);
  } catch (e) {
    if (e instanceof RequestBodyError)
      return send(res, e.status, { error: e.message, code: "bad-request", ...before });
    return send(res, 400, { error: e instanceof Error ? e.message : String(e), code: "bad-request", ...before });
  }
  const malformed = (why: string) => send(res, 400, { error: `managed lifecycle activation ${why}`, code: "bad-request", ...before });
  if (body === null || typeof body !== "object" || Array.isArray(body))
    return malformed("needs { accountPublicKey, owner, actor, lifecycleUid }");
  for (const key of Object.keys(body))
    if (!MANAGED_ACTIVATE_KEYS.has(key)) return malformed(`carries the unknown field "${key}"`);
  const raw = body as Partial<Record<keyof ManagedLifecycleActivationRequest, unknown>>;
  if (typeof raw.accountPublicKey !== "string" || typeof raw.owner !== "string" || typeof raw.actor !== "string" || typeof raw.lifecycleUid !== "string")
    return malformed("needs string { accountPublicKey, owner, actor, lifecycleUid }");
  if (raw.accountPublicKey !== ctx.accountPublicKey)
    return send(res, 403, { error: "managed lifecycle activation names a foreign account authority", code: "permission-denied", ...before });
  let target: { owner: string; actor: string; lifecycleUid: string };
  try {
    target = {
      owner: assertDerivedOwnerToken(raw.owner),
      actor: assertValidOwnerToken(raw.actor),
      lifecycleUid: assertLifecycleToken(raw.lifecycleUid),
    };
  } catch (e) {
    return malformed(e instanceof Error ? e.message : String(e));
  }
  try {
    await ctx.activateManagedLifecycle(target);
    const result: ManagedLifecycleActivationResult = { accountPublicKey: ctx.accountPublicKey, ...target, activated: true };
    return send(res, 200, result);
  } catch (e) {
    if (e instanceof EpEnvelopeError)
      return send(res, e.code === "already-exists" ? 409 : (REFUSAL_STATUS[e.code] ?? 500), {
        error: e.message,
        code: e.code,
        outcome: e.outcome ?? "unknown",
        ...(e.details !== undefined ? { details: e.details } : {}),
      });
    return send(res, 500, {
      error: e instanceof Error ? e.message : String(e),
      code: "internal",
      outcome: "unknown",
    });
  }
}

/** The envelope-error to HTTP mapping this door answers with. A code the catalog grows but this
 *  table does not name becomes 403 rather than a 500: a refusal is a refusal, and a door that
 *  answered 500 to a new permission code would read as a host fault to the platform calling it. */
const VERIFY_ENROLLMENT_STATUS: Partial<Record<string, number>> = {
  "unauthenticated": 401,
  "permission-denied": 403,
  "conflict": 409,
  "failed-precondition": 412,
  "bad-request": 400,
};

const VERIFY_ENROLLMENT_KEYS = new Set(["owner", "request"]);

/**
 * #1972 §2.2 item 3: the host platform's decision door for a remote manager's managed-agent
 * enrollment or terminal-release preparation.
 *
 * The platform that owns the database, the durables, and the ledger terminates its own public
 * route, authenticates the human there, and POSTs the resulting owner token plus the participant's
 * verbatim request here. This process answers because it is the only one holding the manager gate
 * connection and the data-account signing seed: the proof check and the gate read happen inside it,
 * and no secret crosses back.
 *
 * The caller supplies an OWNER and a REQUEST, and nothing else. The caller's scope is derived from
 * this machine's ledger (`ledgerAuthorizeGrant`), never accepted from the body — a platform bug that
 * forwarded a participant-supplied scope array could otherwise hand `supervise` to any caller.
 */
export async function handleVerifyManagedAgentEnrollment(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: HandlerCtx,
): Promise<void> {
  if (req.method !== "POST") return send(res, 405, { error: "POST only" });
  if (req.headers.origin !== undefined) return send(res, 403, { error: "browser-origin requests are not served here" });
  if (!/^application\/json\b/.test(req.headers["content-type"] ?? ""))
    return send(res, 415, { error: "content-type must be application/json" });
  if (req.headers.authorization !== `Bearer ${ctx.cap}`)
    return refuseCapability(res, ctx, "missing/invalid exchange capability - managed agent enrollment verification is a loopback host action");
  const body = await readJsonBody(req);
  if (body === null || typeof body !== "object" || Array.isArray(body))
    return send(res, 400, { error: "managed agent enrollment verification needs { owner, request }" });
  for (const key of Object.keys(body))
    if (!VERIFY_ENROLLMENT_KEYS.has(key))
      return send(res, 400, { error: `managed agent enrollment verification carries the unknown field "${key}"` });
  const raw = body as { owner?: unknown; request?: unknown };
  if (typeof raw.owner !== "string" || raw.request === null || typeof raw.request !== "object" || Array.isArray(raw.request))
    return send(res, 400, { error: "managed agent enrollment verification needs a string owner and an object request" });
  const request = raw.request as { kind?: unknown; actor?: unknown };
  const runtimeKind = request.kind === "manager-managed-agent-runtime-create" || request.kind === "manager-managed-agent-runtime-status";
  if (request.kind !== "manager-managed-agent-enrollment" && request.kind !== "manager-managed-agent-prepare-retirement" && !runtimeKind)
    return send(res, 400, { error: 'managed agent enrollment verification serves only kind "manager-managed-agent-enrollment", "manager-managed-agent-prepare-retirement", "manager-managed-agent-runtime-create" or "manager-managed-agent-runtime-status"' });
  if (typeof request.actor !== "string")
    return send(res, 400, { error: "managed agent enrollment verification request requires an actor" });
  try {
    const owner = assertDerivedOwnerToken(raw.owner);
    // The SCOPE DERIVATION, internal by construction: the interactive row for this exact
    // (owner, actor) on this machine's ledger decides, so `supervise` cannot be asserted by the
    // caller. An ungranted actor throws the ledger's own operator-exact sentence.
    const row = ledgerAuthorizeGrant(ctx.dir)(owner, request.actor);
    const scope = row.scope ?? [];
    if (runtimeKind) {
      // The plane re-reads the same ledger row itself: the runtime decision never takes a scope.
      const decision = await ctx.verifyManagedAgentRuntime({
        owner,
        request: raw.request as import("@cotal-ai/core").RemoteManagedAgentRuntimeRequest,
      });
      return send(res, 200, { authorized: true, ...decision });
    }
    if (request.kind === "manager-managed-agent-enrollment") {
      const { request: verified, parent } = await ctx.verifyManagedAgentEnrollment({
        owner,
        scope,
        request: raw.request as import("@cotal-ai/core").RemoteManagedAgentEnrollmentRequest,
      });
      return send(res, 200, {
        authorized: true,
        owner,
        actor: verified.target.actor,
        instanceId: verified.instanceId,
        serveEpoch: verified.serveEpoch,
        parent,
      });
    }
    const verified = await ctx.verifyManagedAgentPrepareRetirement({
      owner,
      scope,
      request: raw.request as import("@cotal-ai/core").RemoteManagedAgentPrepareRetirementRequest,
    });
    return send(res, 200, {
      authorized: true,
      owner,
      actor: verified.target.actor,
      instanceId: verified.instanceId,
      serveEpoch: verified.serveEpoch,
    });
  } catch (e) {
    const reason = e instanceof Error ? e.message : String(e);
    console.error(`auth-service: refused managed agent enrollment verification: ${reason}`);
    const status = e instanceof EpEnvelopeError ? (VERIFY_ENROLLMENT_STATUS[e.code] ?? 403) : 403;
    return send(res, status, { error: reason });
  }
}

/** The signed-in person's own Manager instances, read-only, on both faces. The proof is the IdP JWT
 *  the human exchange verifies, and the owner is derived from it the same way, so a caller lists only
 *  its own owner's gates. A browser-origin request is refused as on every exchange route; an
 *  embedding's server-side bridge forwards the person's proof. Issuance still re-checks the chosen
 *  instance. */
export async function handleManagerInstances(req: IncomingMessage, res: ServerResponse, ctx: HandlerCtx, policy: ExchangePolicy): Promise<void> {
  if (req.method !== "POST") return send(res, 405, { error: "POST only" });
  if (req.headers.origin !== undefined) return send(res, 403, { error: "browser-origin requests are not served here" });
  if (!/^application\/json\b/.test(req.headers["content-type"] ?? ""))
    return send(res, 415, { error: "content-type must be application/json" });
  if (policy.requireCapability && req.headers.authorization !== `Bearer ${ctx.cap}`)
    return refuseCapability(res, ctx, "missing/invalid exchange capability - read it from the space's auth-service.json");
  const peer = policy.peerKey(req);
  const peerThrottled = policy.throttled(ctx, peer);
  const body = await readJsonBody(req) as { idpToken?: unknown } | null;
  if (typeof body?.idpToken !== "string" || !body.idpToken)
    return send(res, 400, { error: "the manager instance list needs { idpToken: string }" });
  let owner: string;
  try {
    owner = deriveOwnerForIdpSubject(ctx.ownerSecret, ctx.bridgeIdp.issuer, (await verifyIdpToken(body.idpToken, ctx.bridgeIdp)).sub);
  } catch (e) {
    const reason = e instanceof Error ? e.message : String(e);
    return refuseExchange(res, ctx, policy, peer, peerThrottled, `refused a manager instance list: ${reason}`, 401, { error: reason });
  }
  try {
    return send(res, 200, await ctx.listManagerInstances(owner));
  } catch (e) {
    // The proof was good and the gate read was not: unavailable, never an empty list.
    return send(res, 503, { error: `the manager instance list is unavailable: ${e instanceof Error ? e.message : String(e)}` });
  }
}

/** What {@link handleManagerServiceAuthority} reads. Exported so a host that serves the route with a
 *  context it builds itself is held by the compiler to every arm the dispatcher calls. `failures`
 *  and `badCaps` are the face's refusal windows, shared with its `/exchange` so neither route is a
 *  way around the other's budget. */
export type ManagerServiceAuthorityCtx = ManagerAuthorityDispatchCtx & Pick<HandlerCtx, "cap" | "bridgeIdp" | "ownerSecret" | "failures" | "badCaps">;

/** Authenticated manager issuance and maintenance on the selected exchange face. */
export async function handleManagerServiceAuthority(req: IncomingMessage, res: ServerResponse, ctx: ManagerServiceAuthorityCtx, policy: ExchangePolicy): Promise<void> {
  if (req.method !== "POST") return send(res, 405, { error: "POST only" });
  if (req.headers.origin !== undefined) return send(res, 403, { error: "browser-origin requests are not served here" });
  if (!/^application\/json\b/.test(req.headers["content-type"] ?? ""))
    return send(res, 415, { error: "content-type must be application/json" });
  if (policy.requireCapability && req.headers.authorization !== `Bearer ${ctx.cap}`)
    return refuseCapability(res, ctx, "missing/invalid exchange capability - manager-service authority requires the operator exchange capability on this face");
  // A valid token is not probing, so a throttled peer is still verified and only its refusal
  // answers 429, as on /exchange.
  const peer = policy.peerKey(req);
  const peerThrottled = policy.throttled(ctx, peer);
  let body: { idpToken?: unknown; request?: unknown } | null;
  try {
    body = await readJsonBody(req) as typeof body;
  } catch (e) {
    // A host may serve this export without the route tables' catch, so the body refusals are
    // answered here; an escaped rejection would end that host's process.
    return sendRequestError(res, e);
  }
  if (typeof body?.idpToken !== "string" || !body.idpToken)
    return send(res, 400, { error: "manager-service authority needs { idpToken, request }" });
  try {
    const verified = await verifyIdpToken(body.idpToken, ctx.bridgeIdp);
    const owner = deriveOwnerForIdpSubject(ctx.ownerSecret, ctx.bridgeIdp.issuer, verified.sub);
    return send(res, 200, await dispatchManagerAuthorityRequest(ctx, owner, { request: body.request }));
  } catch (e) {
    const reason = e instanceof Error ? e.message : String(e);
    // A conflict, such as a name another lifecycle holds or a stale serve epoch, answers 409.
    return refuseExchange(res, ctx, policy, peer, peerThrottled, `refused manager-service authority: ${reason}`, e instanceof EpEnvelopeError && e.code === "conflict" ? 409 : 403,
      { error: reason, ...(e instanceof EpEnvelopeError && e.details ? { details: e.details } : {}) });
  }
}
