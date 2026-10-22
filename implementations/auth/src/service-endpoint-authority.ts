/** The public service endpoint authority door (`/service-endpoint-authority`, SPEC 13.1): the account
 * info read; register through its proposal and registration phases; activate, renew and ready; and
 * instance and operation status, over the service host engine. The face verifies every proof; this
 * module never sees a proof secret, and it signs serving material only with the bounds the engine
 * returned for the current registration. Revoke and the Describe view stay unsupported. */
import { createHash, randomBytes } from "node:crypto";
import {
  EpEnvelopeError, GOVERNED_TRAIT_URNS, SERVICE_ACCESS_TTL_SECONDS, SERVICE_RENEWAL_TTL_SECONDS, canonicalJson, contractDigest,
  serviceAuthorityRequestDigest, serviceWitnessDigest, verifyClusterManifest, verifyClusterRoot,
  type EpCommandAuthority, type ServiceAuthorityInfo, type ServiceAuthorityRequest, type ServiceAuthorityStatus, type ServiceRegistrationWitness,
} from "@cotal-ai/core";
import type { ServiceHostRequest, ServiceHostResult, ServiceProposalTombstoneView, ServiceProposalView } from "./service-host-contract.js";
import { serviceHostOperationId, serviceRegisterHostRequest, type ServiceHostOperations, type ServiceServeOperation, type ServiceServeResult } from "./service-host-ops.js";

export const SERVICE_ENDPOINT_AUTHORITY_PATH = "/service-endpoint-authority";

/** What one face serves: the receiver's own account and space, the engine its plane opened, and
 *  the issuer that signs serving material once the engine has fixed its bounds. */
export interface ServiceAuthorityDoor { space: string; accountPublicKey: string; engine: ServiceHostOperations; material?: ServiceMaterialIssuer }
/** Signs the access bearer and renewal proof of a current registration; it checks nothing else. */
export interface ServiceMaterialIssuer {
  issueServiceAccess(claims: { witness: ServiceRegistrationWitness; expiresAt: number }): Promise<string>;
  issueServiceRenewal(claims: { witness: ServiceRegistrationWitness; expiresAt: number }): Promise<string>;
}

/** An HTTP status and a body. A protocol body echoes the request; a 5xx body is a plain error, because
 *  the request may be bound and its effect is unknown to the caller. */
export interface ServiceAuthorityReply { status: number; body: unknown }

type Command = EpCommandAuthority & { name: string };
type Echo = Pick<ServiceAuthorityRequest, "v" | "kind" | "operation" | "requestId" | "space" | "accountPublicKey" | "endpoint" | "instanceId">;

export function serviceAuthorityInfo(door: ServiceAuthorityDoor): ServiceAuthorityInfo {
  return { v: 1, kind: "service-endpoint-authority-info", space: door.space, accountPublicKey: door.accountPublicKey };
}

/** The engine request id of one public request: the full public idempotency key (account, space,
 *  derived owner, endpoint, instance, operation, requestId), so another owner's or selector's equal
 *  requestId never reaches this request's binding. */
export function serviceAuthorityEngineRequestId(door: Pick<ServiceAuthorityDoor, "space" | "accountPublicKey">, owner: string,
  request: Pick<ServiceAuthorityRequest, "endpoint" | "instanceId">, operation: ServiceAuthorityRequest["operation"], requestId: string): string {
  const key = canonicalJson(["cotal-service-endpoint-authority", 1, door.accountPublicKey, door.space, owner, request.endpoint, request.instanceId, operation, requestId]);
  return createHash("sha256").update(key, "utf8").digest("hex").slice(0, 32);
}

/** Why a submitted closure set is refused. Nothing is admitted from a refused set. */
export class ServiceRegistrationRefusal extends Error {
  constructor(readonly reason: "closure-invalid" | "unsupported-runtime", detail: string) { super(detail); }
}

/** Compile the submitted closures into the proposal's command surface. Each cluster digest names its
 *  manifest artifact and that manifest's root names the cluster document, both verified by content
 *  digest. Every submitted artifact must belong to a declared closure, and the commands are only what
 *  the verified documents declare. This cut admits ephemeral commands without governed traits only. */
export function compileServiceRegistration(registration: { clusterDigests: string[]; contractArtifacts: unknown[] }): { clusterDigests: string[]; commands: Command[] } {
  const refuse = (reason: ServiceRegistrationRefusal["reason"], detail: string): never => { throw new ServiceRegistrationRefusal(reason, detail); };
  const byDigest = new Map(registration.contractArtifacts.map((a) => [contractDigest(a), a] as const));
  const used = new Set<string>(), names = new Set<string>(), commands: Command[] = [];
  for (const closure of registration.clusterDigests) {
    const manifest = byDigest.get(closure);
    if (manifest === undefined) refuse("closure-invalid", `the closure ${closure} has no submitted manifest`);
    let document: ReturnType<typeof verifyClusterRoot>;
    try {
      const { root } = verifyClusterManifest(closure, manifest);
      if (!byDigest.has(root)) refuse("closure-invalid", `the closure ${closure} has no submitted root document`);
      document = verifyClusterRoot(root, byDigest.get(root));
      used.add(closure); used.add(root);
    } catch (e) {
      if (e instanceof ServiceRegistrationRefusal) throw e;
      return refuse("closure-invalid", e instanceof Error ? e.message : String(e));
    }
    for (const c of document.commands) {
      if (c.class !== "ephemeral") refuse("unsupported-runtime", `command ${c.name} is ${c.class}-class; only ephemeral commands are served`);
      // Governed traits need enforcement hooks this host does not run yet.
      const governed = (c.traits ?? []).filter((t) => GOVERNED_TRAIT_URNS.includes(t));
      if (governed.length) refuse("unsupported-runtime", `command ${c.name} declares the governed trait ${governed[0]}; governed commands are not served`);
      if (names.has(c.name)) refuse("closure-invalid", `command ${c.name} is declared by more than one closure`);
      names.add(c.name);
      commands.push({ name: c.name, clusterDigest: closure, class: c.class, targeted: c.targeted, modes: [...(c.modes ?? [])], capability: c.capability,
        inputDigest: c.inputDigest, outputDigest: c.outputDigest, traits: [...(c.traits ?? [])] });
    }
  }
  if (used.size !== byDigest.size) refuse("closure-invalid", "an artifact belongs to no declared closure");
  commands.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return { clusterDigests: [...registration.clusterDigests], commands };
}

const STATUS: Record<string, number> = {
  unauthenticated: 401, "proof-mismatch": 401, "rate-limited": 429, "resource-exhausted": 429,
  conflict: 409, "selector-pending": 409, "selector-bound": 409, expired: 409, "proposal-refused": 409, "proposal-expired": 409, "approval-revoked": 409,
  "approval-mismatch": 409, "registration-active": 409, "registration-pending": 409, "stale-witness": 409, "root-revoked": 409,
  "bad-request": 422, "closure-invalid": 422, "unsupported-runtime": 422, unsupported: 422,
};

const echoOf = (r: ServiceAuthorityRequest): Echo =>
  ({ v: r.v, kind: r.kind, operation: r.operation, requestId: r.requestId, space: r.space, accountPublicKey: r.accountPublicKey, endpoint: r.endpoint, instanceId: r.instanceId });

/** A `denied` protocol result with its HTTP status: 401 bad proof, 409 conflict or a closed proposal,
 *  422 refused input, 429 a bound, 403 every other authority refusal. */
export function serviceAuthorityDenied(request: ServiceAuthorityRequest, reason: string): ServiceAuthorityReply {
  return { status: STATUS[reason] ?? 403, body: { ...echoOf(request), state: "denied", reason } };
}

const unknown = (detail: string): ServiceAuthorityReply =>
  ({ status: 503, body: { error: `service endpoint authority: ${detail}; the request may be bound, so retain its request identity` } });

/** The caller one verified proof establishes: an IdP owner, or a service renewal or access proof
 *  whose signed witness the face checked. A service proof is never owner authority. */
export type ServiceAuthorityCaller = { kind: "idp"; owner: string } | { kind: "service"; witness: ServiceRegistrationWitness };

/** Answer one parsed request for its verified caller. The face has already checked the account,
 *  space and the proof matrix; for a service proof it checked the signature and that the proof
 *  binds the request's witness. */
export async function answerServiceAuthority(door: ServiceAuthorityDoor, request: ServiceAuthorityRequest, caller: ServiceAuthorityCaller): Promise<ServiceAuthorityReply> {
  const echo = echoOf(request), startedAt = Math.floor(Date.now() / 1000);
  const owner = caller.kind === "idp" ? caller.owner : caller.witness.principal.owner;
  const reply = (status: number, arm: object): ServiceAuthorityReply => ({ status, body: { ...echo, ...arm } });
  const deny = (reason: string) => serviceAuthorityDenied(request, reason);
  if (caller.kind === "service" && "witness" in request && serviceWitnessDigest(request.witness) !== serviceWitnessDigest(caller.witness))
    return deny("proof-mismatch");
  const host = async (operation: "proposal-read" | "operation-read", input: object): Promise<ServiceHostResult> =>
    door.engine.handle({ v: 1, kind: "service-endpoint-host", requestId: randomBytes(16).toString("hex"), operation, input, granter: { kind: "owner", owner } } as ServiceHostRequest);
  /** A read the engine refused: the owner's authority or an unavailable read, never absence. */
  const readRefusal = (r: ServiceHostResult) => (r.state === "denied" && r.reason === "permission-denied" ? deny("permission-denied") : unknown(`the ${r.operation} was not answered`));
  const engineRequestId = (operation: ServiceAuthorityRequest["operation"], requestId: string) => serviceAuthorityEngineRequestId(door, owner, request, operation, requestId);
  const served = (r: ServiceServeResult): ServiceAuthorityReply | undefined =>
    r.state === "denied" ? deny(r.reason) : r.state === "unavailable" ? unknown(r.detail) : undefined;

  /** What a completed register's proposal says now: still proposed, closed, or approved, in which
   *  case the assignment it approved decides whether that approval still stands and whether
   *  another request already registered under it. */
  type Now = { kind: "proposed"; proposalDigest: string } | { kind: "closed"; state: "refused" | "expired"; reason: string }
    | { kind: "approved"; approvalDigest: string } | { kind: "superseded"; current: string }
    | { kind: "revoking"; operationId: string; phase: string } | { kind: "reply"; reply: ServiceAuthorityReply };
  async function proposalNow(proposalId: string): Promise<Now> {
    const p = await host("proposal-read", { proposalId });
    if (p.state !== "present") return { kind: "reply", reply: p.state === "absent" ? unknown("the completed register's proposal is not readable") : readRefusal(p) };
    const v = p.record.value as ServiceProposalView | ServiceProposalTombstoneView;
    // An undecided proposal past its expiry can no longer be approved: it reads as expired once its
    // whole expiry second has passed, so this never reports expired before the engine would refuse.
    // An approving proposal keeps its answer here; its decision settles it.
    if (!("register" in v)) return v.state === "proposed" && Date.now() >= (v.expiresAt + 1) * 1000
      ? { kind: "closed", state: "expired", reason: "expired" } : { kind: "proposed", proposalDigest: v.proposalDigest };
    if (v.state !== "approved") return { kind: "closed", state: v.state, reason: v.reason ?? v.state };
    const s = await door.engine.serviceState(owner, request.endpoint, request.instanceId);
    if (s.state === "approved" && s.proposalId === proposalId && s.approvalDigest === v.approvalDigest)
      return s.registrationRequestId === null ? { kind: "approved", approvalDigest: s.approvalDigest } : { kind: "superseded", current: s.registrationRequestId };
    if (s.state === "revoking" && s.proposalId === proposalId) return { kind: "revoking", operationId: s.operationId, phase: s.denyNew === "landed" ? "deny-new-landed" : "deny-new-pending" };
    return { kind: "reply", reply: unknown("the approved assignment's current state is not readable") };
  }

  if (request.operation === "register") {
    let compiled: ReturnType<typeof compileServiceRegistration>;
    try { compiled = compileServiceRegistration(request.registration); }
    catch (e) { if (e instanceof ServiceRegistrationRefusal) return deny(e.reason); throw e; }
    const requestId = engineRequestId("register", request.requestId), operationId = serviceHostOperationId(door.space, requestId);
    const requestDigest = serviceAuthorityRequestDigest(request);
    // Past approval the owner's assignment decides: its registration phase writes an intent and
    // runs the native registration. Before it, the proposal phase admits or replays the proposal.
    const phase = await door.engine.serviceState(owner, request.endpoint, request.instanceId);
    if (phase.state === "unavailable") return unknown("the selector's assignment is not readable");
    if (phase.state === "approved" || phase.state === "revoking") {
      const r = await door.engine.serve({ operation: "register", caller: "owner", owner, endpoint: request.endpoint, instanceId: request.instanceId,
        requestId: request.requestId, requestDigest, engineRequestId: requestId,
        witness: request.expected.state === "registered" ? request.expected.witness : null,
        register: { ...compiled, artifacts: request.registration.contractArtifacts } });
      if (r.state === "registered") return reply(200, { state: "registered", witness: r.witness, snapshot: r.snapshot });
      return served(r) ?? unknown(`register answered ${r.state}`);
    }
    if (request.expected.state !== "unregistered") return deny("conflict");
    let r: Awaited<ReturnType<ServiceHostOperations["register"]>>;
    try {
      r = await door.engine.register(serviceRegisterHostRequest({ owner, endpoint: request.endpoint, instanceId: request.instanceId, engineRequestId: requestId,
        requestId: request.requestId, requestDigest, ...compiled }));
    } catch (e) { if (e instanceof EpEnvelopeError && e.code === "bad-request") return deny("bad-request"); throw e; }
    const required = (proposalId: string, proposalDigest: string) => reply(202, { state: "approval-required", proposalId, proposalDigest });
    switch (r.state) {
      case "registered": {
        if (r.outcome === "applied") return required(r.proposalId, r.proposalDigest);
        const now = await proposalNow(r.proposalId);
        switch (now.kind) {
          case "proposed": return required(r.proposalId, now.proposalDigest);
          case "closed": return deny(now.state === "expired" ? "proposal-expired" : "proposal-refused");
          // Approved since the phase read: a replay enters the registration phase.
          case "approved": return reply(202, { state: "pending", operationId, phase: "approved-unregistered" });
          case "superseded": return deny("conflict");
          case "revoking": return deny("approval-revoked");
          case "reply": return now.reply;
        }
        break;
      }
      case "refused": return deny(r.reason);
      case "denied": return r.reason === "unavailable" ? unknown("register admission was unavailable") : deny(r.reason);
      case "held": return r.reason === "permission-denied" && r.phase === "authorize" ? deny("permission-denied") : unknown(`register held (${r.reason} at ${r.phase})`);
      case "pending": return unknown(`register pending at ${r.phase}`);
    }
  }

  if (request.operation === "activate" || request.operation === "renew" || request.operation === "ready") {
    if (request.operation !== "ready" && door.material === undefined) return deny("unsupported");
    const r = await door.engine.serve({ operation: request.operation, caller: caller.kind === "idp" ? "owner" : "service", owner,
      endpoint: request.endpoint, instanceId: request.instanceId, requestId: request.requestId, requestDigest: serviceAuthorityRequestDigest(request),
      engineRequestId: engineRequestId(request.operation, request.requestId), witness: request.witness });
    if (r.state === "ready") return reply(200, { state: "ready", witness: r.witness, reportedAt: r.reportedAt });
    if (r.state !== "current") return served(r) ?? unknown(`${request.operation} answered ${r.state}`);
    // Bounds fixed at admission: never extended by a late answer.
    const cap = (ttl: number) => Math.min(startedAt + ttl, r.rootExpiresAt, r.approvalExpiresAt ?? Number.MAX_SAFE_INTEGER);
    const accessExpiresAt = cap(SERVICE_ACCESS_TTL_SECONDS), renewalExpiresAt = cap(SERVICE_RENEWAL_TTL_SECONDS);
    if (accessExpiresAt <= Math.floor(Date.now() / 1000)) return deny("expired");
    let accessBearer: string, renewalProof: string;
    try {
      accessBearer = await door.material!.issueServiceAccess({ witness: r.witness, expiresAt: accessExpiresAt });
      renewalProof = await door.material!.issueServiceRenewal({ witness: r.witness, expiresAt: renewalExpiresAt });
    } catch {
      // Only a fixed expiry that has passed is expired. Any other failure to mint leaves the current
      // registration with no material, so it is unknown and a replay mints replacement material.
      if (accessExpiresAt <= Math.floor(Date.now() / 1000)) return deny("expired");
      return unknown(`the ${request.operation} material was not minted`);
    }
    return reply(200, { state: "credential", witness: r.witness, duty: "serve", accessBearer, accessExpiresAt, renewalProof, renewalExpiresAt, snapshot: r.snapshot });
  }

  if (request.operation === "status") {
    const status = (s: ServiceAuthorityStatus) => reply(200, { state: "status", status: s });
    const target = request.target;
    if (target.kind === "operation" && target.operation === "revoke") return deny("unsupported");
    const answer = await door.engine.serveStatus({ owner, endpoint: request.endpoint, instanceId: request.instanceId,
      reader: caller.kind === "idp" ? { kind: "owner" } : { kind: "service", witness: caller.witness },
      target: target.kind === "instance" ? { kind: "instance" } : { kind: "operation", operation: target.operation as ServiceServeOperation, engineRequestId: engineRequestId(target.operation, target.requestId) } });
    if (answer.kind === "status") return status(answer.status);
    if (answer.kind === "not-found") return deny("not-found");
    if (answer.kind === "denied") return deny(answer.reason);
    if (answer.kind === "unavailable") return unknown(answer.detail);
    // A register with no intent answers from its proposal-phase operation record.
    const operationId = serviceHostOperationId(door.space, engineRequestId("register", (target as { requestId: string }).requestId));
    const op = await host("operation-read", { operationId });
    if (op.state === "absent") return deny("not-found");
    if (op.state !== "present") return readRefusal(op);
    type Step = { state: string; phase?: string; reason?: string };
    const v = op.record.value as { operation: string; projection: { proposalId: string | null } } & ({ progress: Step } | { outcome: Step });
    const progress = "outcome" in v ? v.outcome : v.progress, proposalId = v.projection.proposalId;
    if (v.operation !== "register" || proposalId === null) return deny("not-found");
    if (progress.state === "pending" || progress.state === "held") return status({ state: "registering", operationId, phase: progress.phase! });
    if (progress.state === "refused") return status({ state: "refused", proposalId, reason: progress.reason! });
    if (progress.state === "superseded") return status({ state: "refused", proposalId, reason: "superseded" });
    const now = await proposalNow(proposalId);
    switch (now.kind) {
      case "proposed": return status({ state: "proposed", proposalId, proposalDigest: now.proposalDigest });
      case "closed": return status({ state: "refused", proposalId, reason: now.reason });
      case "approved": return status({ state: "approved-unregistered", approvalDigest: now.approvalDigest });
      case "superseded": return status({ state: "superseded", registrationRequestId: (target as { requestId: string }).requestId, currentRegistrationRequestId: now.current });
      case "revoking": return status({ state: "revoking", operationId: now.operationId, phase: now.phase });
      case "reply": return now.reply;
    }
  }

  // revoke and describe-view need terminal retirement and caller policy, which this cut does not run.
  return deny("unsupported");
}
