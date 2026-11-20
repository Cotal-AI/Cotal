/** Package-internal service host operations: register admission, decide (approve or refuse),
 * revoke, create-only name binding, caller grants and caller revocation up to deny-new and its
 * cutoff marker, the operation, proposal and caller-policy reads and one owner's assignment state,
 * over closed per-key records in the auth bucket. The index does not export it; only the
 * owner-proved public authority door calls register. It grants no serving, registration, issuance
 * from caller policy, terminal caller revocation, restore, terminal retirement or KICK.
 *
 * Every write is one zero-history create or one exact-revision CAS on one key, issued through the
 * shared custody writer (service-write.ts) under the same plane-claim hold check and fatal latch as
 * native custody, and only inside the invocation's write scope: the keys discovery located before
 * its effect connection opened. That connection's credential publishes only those keys and expires
 * at the invocation's original deadline. A step that needs a key outside it holds before anything is issued. No record carries a TTL and none is ever deleted or purged. There are no
 * multi-key batches: every window between two writes is either fenced on its key or settled from
 * what a later invocation reads. The invocation limit and the original deadline are limits, never
 * waits, fences or proof that an earlier write cannot still land. */
import type { MsgRequest } from "@nats-io/jetstream";
import type { NatsConnection } from "@nats-io/transport-node";
import { EpEnvelopeError, GOVERN_HEAD, RECORD_KINDS, assertLifecycleToken, canonicalJson, contractArtifactCanonicalBytes, epAuthBucket, contractDigest, contractStoreContext, endpointCapabilitiesWithin, endpointRegistrationBarrier, epgateKey, parseEndpointCapabilities, parseServiceSpec, parseServiceStatus, publishContractArtifact, recordAtomicKey, recordSpecKey, recordStatusKey, registerServiceInstance, serviceEndpointActor, serviceGateApprovalLive, serviceWitnessDigest, verifyClusterManifest, verifyClusterRoot, writeServiceStatus, type ContractStoreContext, type EpCapability, type ServiceAuthorityStatus, type ServiceRegistrationSnapshot, type ServicePrincipal, type ServiceRegistrationWitness, type ServiceSpec, type ServiceUidCustodyV1 } from "@cotal-ai/core";
import { openAuthorityClient, serviceHostEffectGrants, serviceHostEffectLabel, type ServiceHostEffectReads } from "./authority-client.js";
import { callerParentRefs } from "./service-caller-ancestry.js";
import { findActorUnified, findInteractiveActor } from "./ledger.js";
import { openLifecycleRegistry, registryMaxPayload, registryServerId, registryStores, type LifecycleRegistry } from "./lifecycle-registry.js";
import { activatedServiceGateRow, serviceGateRows, type ServiceAssignmentBinding, type ServiceGateRows } from "./native-service-gate.js";
import { nativeServiceNameAuthority, serviceNameKey, serviceNameRowBytes } from "./native-service-name.js";
import { genuinePlaneHold, readPlaneClaim, type PlaneClaimHold } from "./plane-claim.js";
import { SERVICE_CALLER_PAYLOAD_KEY, parseServiceCallerPayloadRecord, serviceCallerPayloadCheck, serviceCallerWriteFits, type ServiceCallerPayloadLimits, type ServiceCallerPayloadRecord } from "./service-caller-payload.js";
import { callerAppendStep, callerBeginStep, callerCutoffStep, immutableGrantView, parseNativeServiceCallerPolicy, servicePolicyKey, type NativeServiceCallerPolicy } from "./service-caller-policy.js";
import { encodeRoundTrip } from "./service-custody-shapes.js";
import { serviceAssignmentGate, serviceCustodyKeys, serviceReservationKeys } from "./service-custody.js";
import { parseServiceHostRequest, parseServiceProposalClusters, parseServiceProposalCommands, type ServiceApprovalResult, type ServiceCallerGrant, type ServiceCallerPolicyView, type ServiceDenyNew, type ServiceHostDebt, type ServiceHostOutcome, type ServiceHostReason, type ServiceHostRequest, type ServiceHostResult, type ServiceNameView, type ServiceOperationRefusal, type ServiceOperationTerminalView, type ServiceOperationView, type ServiceInstanceView, type ServiceProposalTombstoneView, type ServiceProposalView, type ServiceSelector } from "./service-host-contract.js";
import { readRegistryServiceRoot } from "./service-root-reader.js";
import { HOSTS, Held, S1_REQUEST_TIMEOUT_MS, bounded, context, endpoint, held, leader, message, openServiceCustodyHost, readyAfter, readyBefore, scopeCovers, write, type Ctx, type EndpointRow, type ServiceWriteScope } from "./service-write.js";
import type { ServiceKeys } from "./store.js";
import { bad, closed, hexN, digest, pick, owner, endpointName, token, withStatus, parseServiceHostOperationRecord, parseServiceProposalRecord, parseServiceAssignmentRecord, parseServiceRequestIntentRecord, parseServiceRequestIntentIndexRecord, parseServiceAdmissionRecord, parseServiceCallerIndexRecord, byEntry, parseServiceCutoffMarkerRecord, serviceMarkerCeilSeconds, SERVICE_CUTOFF_MARGIN_S, enc, requestDigestOf, S2A_MAX_PENDING, S2A_MAX_PENDING_PER_OWNER, S3_MAX_INTENTS_PER_INSTANCE, S3_MAX_CALLER_GRANTS_PER_INSTANCE, type Rec, type RegisterPlan, type GrantBody, type CallerGrantPlan, type CallerRevokePlan, type RegisterResult, type GrantResult, type OpResult, type Final, type Progress, type OpLive, type Op, type Command, type ProposalLive, type ProposalTerminal, type Proposal, type CapEntry, type Capacity, type Assignment, type Admission, type ServiceServeOperation, type Intent, type IntentIndex, type CallerIndex, type CutoffMarker } from "./service-host-records.js";
export { S3_MAX_INTENTS_PER_INSTANCE, parseServiceHostOperationRecord, parseServiceProposalRecord, parseServiceCapacityRecord, parseServiceAssignmentRecord, parseServiceRequestIntentRecord, parseServiceRequestIntentIndexRecord, parseServiceAdmissionRecord, serviceMarkerCeilSeconds } from "./service-host-records.js";
export type { ServiceServeOperation } from "./service-host-records.js";
import { S2A_OPERATION_TTL_MS, S2A_INVOCATION_MS, S2A_PROPOSAL_LIFETIME_MS, S2A_MAX_PROPOSAL_BYTES, S2A_MAX_REDECIDE, ADMISSION_KEY, CAPACITY_KEY, opKey, proposalKey, assignmentKey, intentKey, intentIndexKey, callerIndexKey, cutoffKey, seconds, serviceHostOperationId, callerGrantId, proposalIdOf, type Read, read, readOp, readProposal, readCapacity, readAssignment, readAdmission, readIntent, readIntentIndex, put, putCapacity, isEntry, eligible, nameOf, release, isFinal, updateOp, settle, outcomeOf, debtOf, retryDebt, type Arms, type Inv, denied, finalArm, type Live } from "./service-host-kernel.js";
import { serviceHostDecisions } from "./service-host-decisions.js";

// ---- engine -------------------------------------------------------------------------------------

/** What discovery located for one invocation before its effect connection opens. */
export interface ServiceHostScopeTarget {
  operation: "startup" | "register" | "decide" | "revoke" | "name-bind" | "serve" | "caller-grant" | "caller-revoke";
  operationId: string | null;
  proposalId: string | null;
  owner: string | null;
  endpoint: string | null;
  instanceId: string | null;
  lifecycleUid: string | null;
  /** A serving invocation's public operation; required exactly when `operation` is `serve`. */
  serve?: ServiceServeOperation;
  /** The contract artifacts (sha256 hex) a serving registration publishes. */
  contract?: readonly string[];
  /** A caller operation's grantee lifecycle uid, whose policy row it writes. */
  granteeUid?: string;
  /** A caller revoke's cutoff operation: the one whose marker key it may create. */
  cutoffOperationId?: string;
}
/** One invocation's scope: its target, the exact keys it may write and its original deadline. The
 *  engine guards every write with `keys` and never starts a request at or past `deadlineMs`, so an
 *  effect credential granted from the same keys and expiring from the same deadline cannot differ
 *  from it. */
export interface ServiceHostEffectScope extends ServiceHostScopeTarget { readonly keys: ServiceWriteScope; readonly reads: ServiceHostEffectReads; readonly deadlineMs: number }

/** The one key source for an invocation's writes: its own S2-A records, plus native custody's keys
 *  for the located reservation. A decide with a reservation can bootstrap it; a revoke only cancels. */
export function serviceHostScopeKeys(account: { accountPublicKey: string; space: string }, t: ServiceHostScopeTarget): ServiceWriteScope {
  const auth: string[] = [], records: string[] = [], authFamilies: string[] = [];
  const opKeyOf = () => opKey(hexN(t.operationId, 32));
  const custody = (run: "bootstrap" | "cancel") => {
    if (t.owner === null || t.endpoint === null || t.instanceId === null || t.lifecycleUid === null) return;
    const actor = serviceEndpointActor({ ...account, owner: t.owner, endpoint: t.endpoint, instanceId: t.instanceId });
    const k = serviceCustodyKeys({ owner: t.owner, actor, endpoint: t.endpoint, instanceId: t.instanceId, lifecycleUid: t.lifecycleUid }, run);
    records.push(...k.records); auth.push(...k.auth); authFamilies.push(...k.authFamilies);
  };
  switch (t.operation) {
    case "startup": auth.push(ADMISSION_KEY); break;
    case "register": auth.push(opKeyOf(), proposalKey(hexN(t.proposalId, 64)), CAPACITY_KEY); break;
    case "decide":
      auth.push(opKeyOf(), proposalKey(hexN(t.proposalId, 64)), CAPACITY_KEY);
      if (t.lifecycleUid !== null && t.endpoint !== null && t.instanceId !== null) { auth.push(assignmentKey(t.endpoint, t.instanceId)); custody("bootstrap"); }
      break;
    case "revoke":
      if (t.endpoint === null || t.instanceId === null) bad("a revoke scope names its selector");
      auth.push(opKeyOf(), assignmentKey(t.endpoint, t.instanceId), CAPACITY_KEY, ...(t.proposalId === null ? [] : [proposalKey(hexN(t.proposalId, 64))]));
      custody("cancel");
      break;
    case "name-bind":
      if (t.endpoint === null) bad("a name binding scope names its endpoint");
      auth.push(serviceNameKey(t.endpoint));
      break;
    // A caller operation writes its op, the grantee's policy row and the payload precondition's
    // withdrawal, plus the instance index for a grant or the cutoff marker for a revoke. No custody key.
    case "caller-grant":
      if (t.endpoint === null || t.instanceId === null || t.granteeUid === undefined) bad("a caller grant scope names its selector and grantee");
      auth.push(opKeyOf(), servicePolicyKey(t.granteeUid), callerIndexKey(t.endpoint, t.instanceId), SERVICE_CALLER_PAYLOAD_KEY);
      break;
    case "caller-revoke":
      if (t.granteeUid === undefined || t.cutoffOperationId === undefined) bad("a caller revoke scope names its grantee and cutoff operation");
      auth.push(opKeyOf(), servicePolicyKey(t.granteeUid), cutoffKey(t.cutoffOperationId), SERVICE_CALLER_PAYLOAD_KEY);
      break;
    case "serve": {
      // A serving request writes its intent and its instance's index, then only its own effect's keys.
      if (t.endpoint === null || t.instanceId === null || t.serve === undefined) bad("a serving scope names its selector and operation");
      auth.push(intentKey(hexN(t.operationId, 32)), intentIndexKey(t.endpoint, t.instanceId));
      if (t.serve === "register" || t.serve === "activate") auth.push(epgateKey(t.endpoint, t.instanceId));
      records.push(...serveRecordKeys(t).writes);
      break;
    }
  }
  const uniq = (a: string[]) => Object.freeze([...new Set(a)]);
  return Object.freeze({ records: uniq(records), auth: uniq(auth), authFamilies: uniq(authFamilies) });
}
/** A native registration writes and reads the spec and the endpoint's governance head; readiness
 *  writes the status and reads it with the spec. */
function serveRecordKeys(t: ServiceHostScopeTarget): { writes: string[]; reads: string[] } {
  if (t.operation !== "serve" || t.endpoint === null || t.instanceId === null) return { writes: [], reads: [] };
  const sel = [t.endpoint, assertLifecycleToken(t.instanceId, "instanceId")];
  const spec = recordSpecKey(RECORD_KINDS.svc, sel), status = recordStatusKey(RECORD_KINDS.svc, sel), govern = recordAtomicKey(GOVERN_HEAD, [t.endpoint]);
  if (t.serve === "register") return { writes: [spec, govern], reads: [spec, govern] };
  if (t.serve === "ready") return { writes: [status], reads: [spec, status] };
  return { writes: [], reads: [] };
}
/** What one invocation's effect credential may read by Direct Get and publish to the contract store. */
function serviceHostScopeReads(t: ServiceHostScopeTarget): ServiceHostEffectReads {
  const contract = t.operation === "serve" && t.serve === "register" ? [...(t.contract ?? [])] : [];
  return Object.freeze({ records: Object.freeze([...new Set(serveRecordKeys(t).reads)]), contract: Object.freeze([...new Set(contract)]) });
}
const NO_WRITES: ServiceWriteScope = Object.freeze({ records: Object.freeze([]), auth: Object.freeze([]), authFamilies: Object.freeze([]) });
/** One per-invocation effect connection's registry. `gone` resolves when the connection is gone for
 *  good, which fences the invocation. `close` runs only after every awaited call returned. */
export interface ServiceHostEffect { registry: LifecycleRegistry; gone: Promise<void>; close(): Promise<void>;
  /** The contract store over the same connection; a serving registration holds without it. */
  contract?: ContractStoreContext }

/** Open one invocation's effect connection: a fresh identity whose credential publishes exactly
 *  `scope.keys`, never reconnects or renews, and expires at `scope.deadlineMs` rounded up to the
 *  whole second. The registry over it is the effect registry. */
export async function openServiceHostEffect(
  opts: { server: string; space: string; dataAccount: ServiceKeys["dataAccount"]; log: (line: string) => void; onConnection?: (nc: NatsConnection, label: string) => void },
  scope: Pick<ServiceHostEffectScope, "keys" | "deadlineMs"> & { reads?: ServiceHostEffectReads },
): Promise<ServiceHostEffect> {
  const client = await openAuthorityClient({
    server: opts.server, space: opts.space, dataAccount: opts.dataAccount, log: opts.log, label: serviceHostEffectLabel(opts.space),
    grants: (connId) => serviceHostEffectGrants(opts.space, connId, scope.keys, scope.reads), noReconnect: true, serviceHostInvocation: { deadlineMs: scope.deadlineMs },
    ...(opts.onConnection ? { onConnection: opts.onConnection } : {}),
  });
  try {
    return { registry: await openLifecycleRegistry(client.nc, opts.space), gone: client.gone!, close: () => client.close(),
      contract: await contractStoreContext(client.nc, opts.space) };
  }
  catch (e) { await client.close().catch(() => {}); throw e; }
}
export interface ServiceHostOperationsOptions {
  /** A standing read-only registry used only to locate an invocation's keys. */
  discovery: LifecycleRegistry;
  openEffect(scope: ServiceHostEffectScope): Promise<ServiceHostEffect>;
  /** This process's genuine plane-claim hold; every invocation's custody host checks it. */
  hold: PlaneClaimHold;
  accountPublicKey: string;
  /** The actor ledger directory an owner's current interactive row is read from. */
  ledgerDir: string;
  /** Required. Only normal startup is supported; restore refuses construction. */
  startup?: { kind: "normal" } | { kind: "restore"; restoreId: string };
  /** Serving reads a registered closure's artifacts from the contract store; without it a
   *  serving read that needs them is unavailable. */
  serving?: { readContractArtifact(digest: string): Promise<unknown> };
}
/** One verified public serving request (SPEC 13.1). The face verified the proof: `owner` is an IdP
 *  owner, whose current interactive row the engine still requires, or a service proof's witness
 *  owner whose proof binds `witness`. */
export interface ServiceServeRequest {
  operation: ServiceServeOperation;
  caller: "owner" | "service";
  owner: string; endpoint: string; instanceId: string;
  /** The public request id and digest, and the engine request id of its full idempotency key. */
  requestId: string; requestDigest: string; engineRequestId: string;
  /** activate, renew and ready: the request witness. register: the expected witness, or null for unregistered. */
  witness: ServiceRegistrationWitness | null;
  /** register only: the compiled surface and the submitted artifacts. */
  register?: { clusterDigests: string[]; commands: Command[]; artifacts: unknown[] };
}
export type ServiceServeResult =
  | { state: "registered"; witness: ServiceRegistrationWitness; snapshot: ServiceRegistrationSnapshot }
  /** activate (after its CAS) and renew: the current registration and the fixed bounds material may not outlive. */
  | { state: "current"; witness: ServiceRegistrationWitness; snapshot: ServiceRegistrationSnapshot; rootExpiresAt: number; approvalExpiresAt: number | null }
  | { state: "ready"; witness: ServiceRegistrationWitness; reportedAt: number }
  | { state: "denied"; reason: string }
  /** Unread, unknown or inconsistent: the request may be bound, and its identity must be kept. */
  | { state: "unavailable"; detail: string };
/** One status query by a verified reader: an IdP owner, or a service proof's witness. */
interface ServiceStatusQuery {
  owner: string; endpoint: string; instanceId: string;
  reader: { kind: "owner" } | { kind: "service"; witness: ServiceRegistrationWitness };
  target: { kind: "instance" } | { kind: "operation"; operation: ServiceServeOperation; engineRequestId: string };
}
type ServiceStatusAnswer =
  | { kind: "status"; status: ServiceAuthorityStatus }
  /** A register with no intent: its proposal-phase operation record answers. */
  | { kind: "proposal-phase" }
  /** An owner reader without an interactive row. */
  | { kind: "denied"; reason: "permission-denied" }
  | { kind: "not-found" }
  | { kind: "unavailable"; detail: string };
interface ServiceRegisterRequest {
  v: 1; kind: "service-endpoint-host"; requestId: string; operation: "register";
  input: { owner: string; endpoint: string; instanceId: string; clusterDigests: string[]; commands: Command[];
    /** The public request this admission serves, so a changed public body under one key is a conflict. */
    publicRequest?: { requestId: string; requestDigest: string } };
  granter: { kind: "owner"; owner: string };
}
type ServiceRegisterResult = { v: 1; kind: "service-endpoint-host"; operation: "register"; requestId: string; space: string; accountPublicKey: string } & (
  | { state: "registered"; outcome: ServiceHostOutcome; operationId: string; proposalId: string; proposalDigest: string; revision: number; expiresAtMs: number; debt?: ServiceHostDebt[] }
  | Arms);
export interface ServiceHostOperations {
  readonly space: string;
  readonly accountPublicKey: string;
  /** Internal register admission; the public register route that verifies the owner calls it. */
  register(raw: unknown): Promise<ServiceRegisterResult>;
  /** Owner and operator decisions plus the native reads implemented by this host. */
  handle(raw: unknown): Promise<ServiceHostResult>;
  /** One owner's assignment at a selector, from one discovery read of its record and endpoint gate.
   *  Another owner's assignment reads absent. For the authority door, which proved the owner. */
  serviceState(owner: string, endpoint: string, instanceId: string): Promise<ServiceAssignmentState>;
  /** One verified serving request: intent, quota and binding, then its effect (SPEC 13.1). */
  serve(request: ServiceServeRequest): Promise<ServiceServeResult>;
  /** Instance or serving-operation status, by the precedence rules; never a guessed absence. */
  serveStatus(query: ServiceStatusQuery): Promise<ServiceStatusAnswer>;
  /** The current bound assignment a service witness names, for the native service callout; throws otherwise. */
  serviceBinding(witness: ServiceRegistrationWitness): Promise<ServiceAssignmentBinding>;
  /** The engine-level fatal latch: refuses new invocations and trips every live invocation host. */
  trip(reason: string): void;
  /** From the moment it is called, refuses every later call with the latch's answers. */
  refuse(): void;
  /** Refuses every later call with the latch's answers, then resolves once every register or handle
   *  call that entered before it has returned, from entry: through discovery, effect open and its
   *  writes. It trips nothing; each call already in flight ends under its own discovery and
   *  invocation bounds. */
  close(): Promise<void>;
}

/** The current state of one assignment. `pending-root` has no approval on its endpoint gate yet;
 *  `revoking` has a bound cancel identity. `unavailable` is a failed or inconsistent read, never absence. */
type ServiceAssignmentState =
  | { state: "absent" } | { state: "unavailable" }
  | { state: "pending-root"; proposalId: string; assignmentDigest: string }
  | { state: "approved"; proposalId: string; assignmentDigest: string; approvalDigest: string; registrationRequestId: string | null }
  | { state: "revoking"; proposalId: string; assignmentDigest: string; operationId: string; denyNew: ServiceDenyNew };


function badRequest(detail: string): never { throw new EpEnvelopeError("bad-request", `service host request: ${detail}`); }

/** The host register request a public register's proposal phase admits. Serving recomputes it, so
 *  one public request key binds one body across both phases. */
export function serviceRegisterHostRequest(r: { owner: string; endpoint: string; instanceId: string; engineRequestId: string;
  requestId: string; requestDigest: string; clusterDigests: string[]; commands: Command[] }): ServiceRegisterRequest {
  return { v: 1, kind: "service-endpoint-host", requestId: r.engineRequestId, operation: "register", granter: { kind: "owner", owner: r.owner },
    input: { owner: r.owner, endpoint: r.endpoint, instanceId: r.instanceId, clusterDigests: r.clusterDigests, commands: r.commands,
      publicRequest: { requestId: r.requestId, requestDigest: r.requestDigest } } };
}

/** Structural admission of the internal register request. */
function parseServiceRegisterRequest(raw: unknown): ServiceRegisterRequest {
  let o: Rec, input: Rec, g: Rec;
  try {
    o = closed(raw, ["v", "kind", "requestId", "operation", "input", "granter"]);
    if (o.v !== 1 || o.kind !== "service-endpoint-host" || o.operation !== "register") bad("unknown version, kind or operation");
    hexN(o.requestId, 32);
    g = closed(o.granter, ["kind", "owner"]); pick(g.kind, ["owner"]); owner(g.owner);
    input = closed(o.input, ["owner", "endpoint", "instanceId", "clusterDigests", "commands"], ["publicRequest"]);
    owner(input.owner); endpointName(input.endpoint); token(input.instanceId, "instanceId");
    if (Object.hasOwn(input, "publicRequest")) { const pr = closed(input.publicRequest, ["requestId", "requestDigest"]); hexN(pr.requestId, 32); digest(pr.requestDigest); }
  } catch (e) { return badRequest(message(e)); }
  const clusterDigests = parseServiceProposalClusters(input.clusterDigests), commands = parseServiceProposalCommands(input.commands);
  if (commands.some((c) => !clusterDigests.includes(c.clusterDigest))) badRequest("every command must come from a submitted cluster");
  return structuredClone(o) as unknown as ServiceRegisterRequest;
}

export async function openServiceHostOperations(opts: ServiceHostOperationsOptions): Promise<ServiceHostOperations> {
  if (opts.startup === undefined) throw new EpEnvelopeError("failed-precondition", "service host operations require an explicit startup kind");
  if (opts.startup.kind !== "normal") throw new EpEnvelopeError("unimplemented", "restore startup is not supported; a restored store stays closed");
  // Discovery only reads: its host writes nothing at all.
  const discovery = openServiceCustodyHost({ registry: opts.discovery, hold: opts.hold, accountPublicKey: opts.accountPublicKey, writes: NO_WRITES });
  const space = discovery.host.space, accountPublicKey = opts.accountPublicKey;
  const live = new Set<(reason: string) => void>();
  let tripped: string | undefined, closed = false;
  /** Every register and handle call, from entry until it returns. */
  const entered = new Set<Promise<unknown>>();
  const tracked = <T>(p: Promise<T>): Promise<T> => {
    entered.add(p);
    p.then(() => entered.delete(p), () => entered.delete(p));
    return p;
  };
  const discoveryCtx = (step: string) => { const c = context(HOSTS.get(discovery.host)!, Date.now() + S2A_INVOCATION_MS); c.step = step; return c; };

  /** One invocation: an effect connection for the discovered scope and its original deadline, one
   *  custody host over it sharing the process hold and writing only the scope's keys, and the
   *  engine latch. The connection's loss trips the host. Every awaited call returns before close. */
  async function invoke<T>(target: ServiceHostScopeTarget, run: (inv: Inv) => Promise<T>, deadlineMs = Date.now() + S2A_INVOCATION_MS): Promise<T> {
    if (tripped !== undefined) throw new Held("readiness", "open", `the service host is fenced: ${tripped}`);
    const keys = serviceHostScopeKeys({ accountPublicKey, space }, target), reads = serviceHostScopeReads(target);
    const scope: ServiceHostEffectScope = Object.freeze({ ...target, keys, reads, deadlineMs });
    let effect: ServiceHostEffect;
    try { effect = await opts.openEffect(scope); }
    catch (e) { throw new Held("unavailable", "effect-open", `the invocation's effect connection did not open: ${message(e)}`); }
    try {
      const opened = openServiceCustodyHost({ registry: effect.registry, hold: opts.hold, accountPublicKey, writes: keys }), host = opened.host;
      if (host.space !== space) throw new EpEnvelopeError("permission-denied", "the effect registry belongs to another space");
      // A native registration and a ready status write through their own client, not the custody
      // writer: a trip also closes their connection, so none of their requests is issued after the
      // fence. A request already issued stays unknown.
      const native = target.operation === "serve" && (target.serve === "register" || target.serve === "ready");
      const trip = (reason: string) => { opened.trip(reason); if (native) void effect.close().catch(() => {}); };
      live.add(trip);
      if (tripped !== undefined) trip(tripped);
      // Attached before the first request: a write issued after the loss holds, one in flight across it reports held.
      void effect.gone.then(() => trip("the invocation's effect connection is gone"));
      const h = HOSTS.get(host)!;
      try { return await run({ host, h, writes: h.writes!, endMs: deadlineMs, operationId: target.operationId ?? "", bound: true, ...(effect.contract ? { contract: effect.contract } : {}) }); }
      finally { live.delete(trip); }
    } finally { await effect.close(); }
  }
  const readCtx = (inv: Inv, step: string) => { const c = context(inv.h, inv.endMs); c.step = step; return c; };
  /** Hold before a native custody run whose keys this invocation's scope does not cover. A replay
   *  of the same request discovers the stored reservation and scopes it. */
  const coverCustody = (inv: Inv, ctx: Ctx, reservation: ServiceUidCustodyV1, run: "bootstrap" | "cancel") => {
    const need = serviceReservationKeys(inv.host, reservation, run);
    const gap = [...need.records.filter((k) => !scopeCovers(inv.writes, "records", k)), ...need.auth.filter((k) => !scopeCovers(inv.writes, "auth", k)),
      ...need.authFamilies.filter((f) => !inv.writes.authFamilies.includes(f))];
    if (gap.length) held("scope-mismatch", ctx.step, `native custody needs ${gap.join(", ")} outside this invocation's write scope`);
  };
  /** Normal advancement only, and only before the original deadline. */
  const authorityCtx = (inv: Inv, notAfterMs: number, step: string) => { const c = context(inv.h, Math.min(inv.endMs, notAfterMs)); c.step = step; return c; };
  /** A held step names its operation whenever the request may be bound: until this invocation's own
   *  binding read finds the key absent, and again once its create may be issued. Only a step after
   *  that absence is a zero-write denial, and the absence is point-in-time: another invocation of
   *  the same request already in flight can still bind it later. */
  const heldArm = (inv: Inv, e: Held): Arms => {
    const reason = e.reason === "deadline" && Date.now() >= inv.endMs ? "reconcile-pending" : e.reason;
    return inv.bound ? { state: "held", operationId: inv.operationId, reason, phase: e.step, ...(inv.assignmentDigest ? { assignmentDigest: inv.assignmentDigest } : {}) } : denied("unavailable");
  };
  /** A discovery read failed. A request that is or may be bound is never a zero-write denial; one
   *  bound to another body is a conflict, as its admission would answer. */
  const discoveryHeld = (operationId: string, requestDigest: string, found: Read<Op> | undefined, e: Held, assignmentDigest?: string): Arms => {
    if (found?.state === "absent") return denied("unavailable");
    if (found?.state === "value" && found.row.requestDigest !== requestDigest) return denied("conflict");
    return { state: "held", operationId, reason: e.reason, phase: e.step, ...(assignmentDigest ? { assignmentDigest } : {}) };
  };
  /** The held arm of a request this invocation read nothing about: its deterministic operation
   *  coordinate, the same whether or not the request is bound or its granter authorized. */
  const unread = (requestId: string, reason: string, phase: string, assignmentDigest?: string): Arms =>
    ({ state: "held", operationId: serviceHostOperationId(space, requestId), reason, phase, ...(assignmentDigest ? { assignmentDigest } : {}) });
  const interactive = (o: string) => {
    try { return (findInteractiveActor(opts.ledgerDir, o, "cli") ?? findInteractiveActor(opts.ledgerDir, o, "web")) !== undefined; }
    catch { return false; }
  };

  // Normal-startup admission: absent creates `open` epoch 1; `open` is used; `quarantined` stays.
  // An unknown or unavailable create fails construction closed.
  await invoke({ operation: "startup", operationId: null, proposalId: null, owner: null, endpoint: null, instanceId: null, lifecycleUid: null }, async (inv) => {
    const ctx = readCtx(inv, "admission");
    for (let i = 0; i < S2A_MAX_REDECIDE; i++) {
      const a = await readAdmission(ctx);
      if (a.state === "value") return;
      await put(ctx, ADMISSION_KEY, { v: 1, kind: "service-host-admission", state: "open", epoch: 1, restoreId: null } satisfies Admission, parseServiceAdmissionRecord);
    }
    held("contention", ctx.step);
  });

  // ---- register (R1-R7) ---------------------------------------------------------------------------

  const proposalBodyDigest = (sel: { owner: string; endpoint: string; instanceId: string }, clusterDigests: string[], commands: Command[]) =>
    contractDigest({ v: 1, kind: "service-proposal-body", accountPublicKey, space, ...sel, clusterDigests, commands });

  type Selector = { owner: string; endpoint: string; instanceId: string };
  type Registered = { state: "registered"; outcome: ServiceHostOutcome; operationId: string; proposalId: string; proposalDigest: string; revision: number; expiresAtMs: number; debt?: ServiceHostDebt[] };
  /** R3: the initial refusal reasons, from one read of each authority. */
  async function registerRefusal(ctx: Ctx, sel: Selector, cap: Read<Capacity>, now: number, epoch?: number): Promise<{ reason?: ServiceOperationRefusal & ServiceHostReason; epoch: number }> {
    const adm = await readAdmission(ctx);
    if (adm.state === "absent" || adm.row.state !== "open" || (epoch !== undefined && adm.row.epoch !== epoch)) return { reason: "admission-closed", epoch: adm.state === "value" ? adm.row.epoch : 0 };
    const live = eligible(cap, now);
    if (live.some((e) => e.endpoint === sel.endpoint && e.instanceId === sel.instanceId)) return { reason: "selector-pending", epoch: adm.row.epoch };
    if (live.length >= S2A_MAX_PENDING || live.filter((e) => e.owner === sel.owner).length >= S2A_MAX_PENDING_PER_OWNER) return { reason: "resource-exhausted", epoch: adm.row.epoch };
    if ((await readAssignment(ctx, sel.endpoint, sel.instanceId)).state === "value") return { reason: "selector-bound", epoch: adm.row.epoch };
    const name = await nameOf(ctx, sel.endpoint);
    if (name !== undefined && name.owner !== sel.owner) return { reason: "name-owned", epoch: adm.row.epoch };
    return { epoch: adm.row.epoch };
  }

  async function register(raw: unknown): Promise<ServiceRegisterResult> {
    const req = parseServiceRegisterRequest(raw);
    const env = { v: 1 as const, kind: "service-endpoint-host" as const, operation: "register" as const, requestId: req.requestId, space, accountPublicKey };
    const out = (a: Arms | Registered) => ({ ...env, ...a }) as ServiceRegisterResult;
    // The latch comes before the ledger and every broker read; a tripped engine cannot tell a bound request.
    if (tripped !== undefined || closed) return out(unread(req.requestId, "readiness", "open"));
    const { owner: o, endpoint: e, instanceId: i, clusterDigests, commands } = req.input;
    if (req.granter.owner !== o) return out(denied("permission-denied"));                                   // never binds
    // Authorization precedes every request-key read, and its refusal is one answer whether or not the request is bound.
    if (!interactive(o)) return out(unread(req.requestId, "permission-denied", "authorize"));
    // A native control endpoint is never a service name: refused before any effect, like a name binding.
    try { serviceNameKey(e); }
    catch (err) { if (err instanceof EpEnvelopeError && err.code === "permission-denied") return out(denied("permission-denied")); throw err; }   // never binds
    const operationId = serviceHostOperationId(space, req.requestId), requestDigest = requestDigestOf(req);
    const proposalDigest = proposalBodyDigest({ owner: o, endpoint: e, instanceId: i }, clusterDigests, commands);
    const proposalId = proposalIdOf(proposalDigest, req.requestId);
    const proposalRow = (p: RegisterPlan): ProposalLive => ({ v: 1, kind: "service-proposal", proposalId, proposalDigest, account: { accountPublicKey, space },
      owner: o, endpoint: e, instanceId: i, register: { requestId: req.requestId, requestDigest, operationId }, createdAtMs: p.createdAtMs, expiresAtMs: p.expiresAtMs,
      clusterDigests, commands, state: { state: "proposed" } });
    if (enc.encode(JSON.stringify(proposalRow({ kind: "register", proposalId, proposalDigest, createdAtMs: 0, expiresAtMs: 0 }))).length > S2A_MAX_PROPOSAL_BYTES)
      return out(denied("bad-request"));
    const sel = { owner: o, endpoint: e, instanceId: i };
    try {
      return out(await invoke({ operation: "register", operationId, proposalId, owner: o, endpoint: e, instanceId: i, lifecycleUid: null }, async (inv) => {
        try {
          const ctx = readCtx(inv, "R2-binding");
          for (let n = 0; ; n++) {
            if (n >= S2A_MAX_REDECIDE) held("contention", ctx.step);
            const op = await readOp(ctx, operationId);
            if (op.state === "value") {
              if (op.row.requestDigest !== requestDigest) return denied("conflict");
              return await advanceRegister(inv, op.row);
            }
            inv.bound = false;
            ctx.step = "R3-decide";
            const now = Date.now(), cap = await readCapacity(ctx);
            const decision = await registerRefusal(ctx, sel, cap, now);
            if (decision.reason !== undefined) return denied(decision.reason);
            ctx.step = "R4-binding";
            const binding: OpLive = { v: 1, kind: "service-host-operation", operationId, requestId: req.requestId, requestDigest, operation: "register",
              account: { accountPublicKey, space }, granter: req.granter, admittedAtMs: now, notAfterMs: now + S2A_OPERATION_TTL_MS, admissionEpoch: decision.epoch,
              projection: { subjectOwner: o, endpoint: e, instanceId: i, proposalId },
              plan: { kind: "register", proposalId, proposalDigest, createdAtMs: now, expiresAtMs: now + S2A_PROPOSAL_LIFETIME_MS }, progress: { state: "admitted" }, debt: [] };
            // The create may be issued from here, so a held step names the operation.
            inv.bound = true;
            if ((await put(ctx, opKey(operationId), binding, parseServiceHostOperationRecord)) !== "moved") return await advanceRegister(inv, binding);
            // A lost create is a concurrent first use, so the request stays possibly bound: re-read, then conflict or replay.
          }
        } catch (err) { if (err instanceof Held) return heldArm(inv, err); throw err; }
      }));
    } catch (err) { if (err instanceof Held) return out(unread(req.requestId, err.reason, err.step)); throw err; }

    async function advanceRegister(inv: Inv, first: Op): Promise<Arms | Registered> {
      const ctx = readCtx(inv, "R-replay");
      // The digest is the binding's own: a matching request digest fixes the same proposal body.
      const registered = (r: RegisterResult, outcome: ServiceHostOutcome, debts: ServiceHostDebt[] = []): Registered => ({ state: "registered", outcome, operationId, proposalDigest, ...r, ...(debts.length ? { debt: debts } : {}) });
      const recorded = async (op: Op) => {
        const f = outcomeOf(op)!, left = await retryDebt(ctx, op, async () => req.requestId);
        const s = await settle(ctx, operationId, undefined, left);
        return f.state === "complete" ? registered(f.result as RegisterResult, "recorded", debtOf(s.op)) : finalArm(operationId, f, debtOf(s.op));
      };
      if (outcomeOf(first) !== undefined) return recorded(first);
      const op = first as OpLive, p = op.plan as RegisterPlan;
      /** Close the op: release my entry first, then record the outcome with any debt. */
      const close = async (f: Final) => {
        const debts: ServiceHostDebt[] = (await release(ctx, proposalId, req.requestId)) ? [] : [{ kind: "capacity-release", proposalId }];
        const s = await settle(ctx, operationId, f, debts), stored = outcomeOf(s.op)!;
        if (stored.state === "complete") return registered(stored.result as RegisterResult, s.wrote ? "applied" : "recorded", debtOf(s.op));
        return finalArm(operationId, stored, debtOf(s.op));
      };
      /** R6's one rule for a present proposal. */
      const fromProposal = async (prop: Extract<Read<Proposal>, { state: "value" }>) => {
        const r = prop.row;
        if (r.proposalDigest !== proposalDigest || r.register.operationId !== operationId || r.register.requestId !== req.requestId || r.register.requestDigest !== requestDigest)
          return close({ state: "refused", reason: "conflict" });
        if (r.kind === "service-proposal-terminal" && r.state === "expired") return close({ state: "refused", reason: "expired" });
        const done: Final = { state: "complete", result: { proposalId, revision: prop.revision, expiresAtMs: p.expiresAtMs } };
        if (r.kind === "service-proposal") {
          const s = await settle(ctx, operationId, done, []), stored = outcomeOf(s.op)!;
          return stored.state === "complete" ? registered(stored.result as RegisterResult, s.wrote ? "applied" : "recorded") : finalArm(operationId, stored, debtOf(s.op));
        }
        return close(done);
      };
      /** Past the register bound with the proposal absent: same-key fence, release, refuse. */
      const bound = async () => {
        ctx.step = "R-bound";
        const fence: ProposalTerminal = { v: 1, kind: "service-proposal-terminal", proposalId, proposalDigest, owner: o, endpoint: e, instanceId: i,
          register: { requestId: req.requestId, requestDigest, operationId }, state: "expired", operationId: null, approvalDigest: null, reason: "expired", atMs: Date.now() };
        await put(ctx, proposalKey(proposalId), fence, parseServiceProposalRecord);
        const prop = await readProposal(ctx, proposalId);
        if (prop.state === "absent") return held("proposal-unreadable", ctx.step, "the fenced proposal key is not readable");
        return fromProposal(prop);
      };

      ctx.step = "R6-proposal";
      let prop = await readProposal(ctx, proposalId);
      if (prop.state === "value") return fromProposal(prop);
      if (Date.now() >= op.notAfterMs) return bound();
      for (let n = 0; ; n++) {
        if (n >= S2A_MAX_REDECIDE) held("contention", "R5-capacity");
        ctx.step = "R5-capacity";
        const now = Date.now(), cap = await readCapacity(ctx);
        if (cap.state === "value" && cap.row.pending.some(isEntry(proposalId, req.requestId))) break;
        const decision = await registerRefusal(ctx, sel, cap, now, op.admissionEpoch);
        if (decision.reason !== undefined) return close({ state: "refused", reason: decision.reason });
        if (Date.now() >= op.notAfterMs) return bound();
        const entry: CapEntry = { proposalId, owner: o, endpoint: e, instanceId: i, registerRequestId: req.requestId, expiresAtMs: p.expiresAtMs };
        if ((await putCapacity(authorityCtx(inv, op.notAfterMs, "R5-capacity"), cap, [...eligible(cap, now), entry])) !== "moved") break;
      }
      if (Date.now() >= op.notAfterMs) return bound();
      await put(authorityCtx(inv, op.notAfterMs, "R6-proposal"), proposalKey(proposalId), proposalRow(p), parseServiceProposalRecord);
      ctx.step = "R6-proposal";
      prop = await readProposal(ctx, proposalId);
      if (prop.state === "absent") return held("proposal-unreadable", ctx.step, "the created proposal is not readable");
      return fromProposal(prop);
    }
  }

  const { decide, revoke, denyNewOf, view } = serviceHostDecisions({ space, accountPublicKey, invoke, readCtx, heldArm, unread, discoveryCtx, discoveryHeld, authorityCtx, coverCustody });

  // ---- caller policy: grant, revoke and the policy reads ------------------------------------------

  const readPolicy = (ctx: Ctx, uid: string) => read(ctx, servicePolicyKey(uid), "policy", parseNativeServiceCallerPolicy);
  const readCallerIndex = (ctx: Ctx, e: string, i: string) => read(ctx, callerIndexKey(e, i), "caller-index", parseServiceCallerIndexRecord);
  const readPayload = (ctx: Ctx) => read(ctx, SERVICE_CALLER_PAYLOAD_KEY, "payload", parseServiceCallerPayloadRecord);
  /** Whether a row at a grantee's key is bound to that grantee in this account and space. */
  const boundTo = (row: NativeServiceCallerPolicy, g: ServicePrincipal) =>
    row.accountPublicKey === accountPublicKey && row.space === space && canonicalJson(row.grantee) === canonicalJson(g);
  const emptyPolicy = (g: ServicePrincipal): NativeServiceCallerPolicy => ({ v: 1, accountPublicKey, space, grantee: g, grants: [] });

  /** This connection's live limits: its server's `max_payload` and the auth stream's `max_msg_size`. */
  async function payloadLimits(ctx: Ctx): Promise<ServiceCallerPayloadLimits> {
    const maxPayload = registryMaxPayload(ctx.h.registry);
    const r = await bounded(ctx, () => ctx.jsm.streams.info(`KV_${ctx.bucket.auth}`));
    const size = r.ok ? r.value.config.max_msg_size : undefined;
    return { maxPayload: Number.isSafeInteger(maxPayload) ? maxPayload : undefined, authMaxMsgSize: Number.isSafeInteger(size) ? size : undefined };
  }
  /** Withdraw an asserted payload precondition after a failed live check or a write that would not
   *  fit; only an operator's assertion records it again. A withdrawal whose own write does not land
   *  is made again by the next writer that sees the same failure. */
  async function withdrawPayload(ctx: Ctx, rec: Read<ServiceCallerPayloadRecord>, reason: "live-check" | "payload-precondition", operationId: string | null): Promise<void> {
    if (rec.state !== "value" || rec.row.state !== "asserted") return;
    const step = ctx.step;
    try {
      await put(ctx, SERVICE_CALLER_PAYLOAD_KEY, { v: 1, kind: "service-caller-payload", state: "withdrawn", reason, operationId, atMs: Date.now() } satisfies ServiceCallerPayloadRecord,
        parseServiceCallerPayloadRecord, rec);
    } catch (e) { if (!(e instanceof Held)) throw e; } finally { ctx.step = step; }
  }
  /** Whether the payload precondition holds now, from its durable record and this connection's live limits. */
  async function payloadHolds(ctx: Ctx, operationId: string | null): Promise<boolean> {
    const rec = await readPayload(ctx), check = serviceCallerPayloadCheck(rec.state === "value" ? rec.row : undefined, await payloadLimits(ctx));
    if (check.holds && rec.state === "value" && rec.row.state === "asserted" && rec.row.broker) {
      const broker = rec.row.broker, proof = genuinePlaneHold(opts.hold);
      if (!proof || broker.serverId !== registryServerId(ctx.h.registry)) return false;
      const observed = await bounded(ctx, () => readPlaneClaim(registryStores(ctx.h.registry).authKv, space));
      if (!observed.ok || !observed.value || observed.value.state !== "held" || observed.value.claimId !== broker.claimId || observed.value.generation !== broker.claimGeneration) return false;
      const held = await bounded(ctx, () => proof.assertHeld("after"));
      if (!held.ok) return false;
    }
    if (!check.holds && (check.why === "server-limit" || check.why === "stream-limit")) await withdrawPayload(ctx, rec, "live-check", operationId);
    return check.holds;
  }
  /** Before a policy row write: a row that would not fit the live limits is never issued. The step
   *  holds `payload-precondition`, a known non-issue, never an unknown outcome. */
  async function assertWriteFits(ctx: Ctx, row: NativeServiceCallerPolicy, operationId: string): Promise<void> {
    if (serviceCallerWriteFits(encodeRoundTrip(row, parseNativeServiceCallerPolicy).length, await payloadLimits(ctx))) return;
    await withdrawPayload(ctx, await readPayload(ctx), "payload-precondition", operationId);
    held("payload-precondition", ctx.step, "the policy row write would not fit the live payload limits; nothing was issued");
  }
  /** Containment within the approval's ceiling image for grantee G. The image keeps only entries on
   *  this endpoint pinned to this instance with `instanceOnly`, and drops `any` and `ledger` entries
   *  (no operator target policy is wired) and `owner` or `child` entries for another owner, which can
   *  never cover G. Mode filtering of stored entries waits on grant-time command declarations. A
   *  lowering throw counts as not contained. */
  const withinCeiling = (ceiling: EpCapability[], capabilities: EpCapability[], g: ServicePrincipal, sel: { endpoint: string; instanceId: string }) => {
    const image = ceiling.filter((c) => {
      const t = c.target as { mode: string; tOwner?: string } | undefined;
      return c.endpoint === sel.endpoint && c.instanceId === sel.instanceId && c.instanceOnly === true && t?.mode !== "any" && t?.mode !== "ledger"
        && !((t?.mode === "owner" || t?.mode === "child") && t.tOwner !== g.owner);
    });
    const caller = { owner: g.owner, actor: g.actor, uid: g.lifecycleUid };
    try { return endpointCapabilitiesWithin({ space, child: { caller, capabilities }, parent: { caller, capabilities: image } }); } catch { return false; }
  };

  type GrantOut = Arms | { state: "granted"; grant: ServiceCallerGrant; revision: number };
  const grantedArm = (r: OpResult): GrantOut => { const g = r as GrantResult; return { state: "granted", grant: structuredClone(g.grant), revision: g.revision }; };

  /** caller-grant (G1-G6): an interactive owner grants a current exact-lifecycle grantee rights on
   *  its own approved instance, within the approval's ceiling and covering managed ancestry. A grant
   *  records policy only; the separately composed callout establishes effective authority. */
  async function callerGrant(req: Extract<ServiceHostRequest, { operation: "caller-grant" }>, authorized: boolean): Promise<GrantOut> {
    // Authorization precedes every request-key read, and its refusal is one answer whether or not the request is bound.
    if (!authorized) return unread(req.requestId, "permission-denied", "authorize");
    const operationId = serviceHostOperationId(space, req.requestId), requestDigest = requestDigestOf(req);
    const granterOwner = req.granter.kind === "owner" ? req.granter.owner : badRequest("a caller grant requires an owner decision");
    const { grantee, service, expectedPolicyRevision } = req.input;
    // The scope comes from the input alone, so a grant has no discovery read.
    const scope: ServiceHostScopeTarget = { operation: "caller-grant", operationId, proposalId: null, owner: granterOwner, endpoint: service.endpoint,
      instanceId: service.instanceId, lifecycleUid: null, granteeUid: grantee.lifecycleUid };
    try {
      return await invoke(scope, async (inv) => {
        inv.operationId = operationId;
        try {
          const ctx = readCtx(inv, "G1-binding");
          for (let n = 0; ; n++) {
            if (n >= S2A_MAX_REDECIDE) held("contention", ctx.step);
            const op = await readOp(ctx, operationId);
            if (op.state === "value") return op.row.requestDigest === requestDigest ? await advanceGrant(inv, op.row) : denied("conflict");
            inv.bound = false;
            const admitted = await admitGrant(inv, ctx);
            if (admitted.kind !== "service-host-operation") return admitted.out;
            // The create may be issued from here, so a held step names the operation.
            inv.bound = true;
            if ((await put(ctx, opKey(operationId), admitted, parseServiceHostOperationRecord)) !== "moved") return await advanceGrant(inv, admitted);
          }
        } catch (err) { if (err instanceof Held) return heldArm(inv, err); throw err; }
      });
    } catch (err) { if (err instanceof Held) return unread(req.requestId, err.reason, err.step); throw err; }

    /** G2: the payload precondition, then each eligibility check from one leader read, point in
     *  time. Every refusal is a zero-write denial; the only write before binding is the precondition's
     *  withdrawal after a failed live check. */
    async function admitGrant(inv: Inv, ctx: Ctx): Promise<OpLive | { kind: "out"; out: GrantOut }> {
      const out = (o: GrantOut) => ({ kind: "out" as const, out: o });
      ctx.step = "G2-precondition";
      if (!(await payloadHolds(ctx, null))) return out(denied("unsupported"));
      ctx.step = "G2-eligibility";
      const adm = await readAdmission(ctx);
      if (adm.state === "absent" || adm.row.state !== "open") return out(denied("admission-closed"));
      let row: ReturnType<typeof findActorUnified>;
      try { row = findActorUnified(opts.ledgerDir, grantee.owner, grantee.actor); } catch { return out(denied("not-found")); }
      if (row === undefined) return out(denied("not-found"));
      if (row.kind === "interactive" && row.parent !== undefined) return out(denied("unsupported"));
      if (row.kind === "managed-agent" && row.parent === undefined) return out(denied("unsupported"));
      if (row.lifecycleUid !== grantee.lifecycleUid) return out(denied("not-found"));
      const asg = await readAssignment(ctx, service.endpoint, service.instanceId);
      if (asg.state === "absent" || asg.row.owner !== granterOwner || asg.row.state !== "bound" || asg.row.cancel !== null) return out(denied("not-found"));
      const a = asg.row;
      const gate = await endpoint(ctx, serviceAssignmentGate(inv.host, a.reservation));
      if (gate.kind !== "approved" || gate.row.serviceAuthority.approvalDigest !== service.approvalDigest) return out(denied("conflict"));
      const now = Date.now();
      if (!serviceGateApprovalLive(gate.row.serviceAuthority, seconds(now))) return out(denied("expired"));
      const name = await nameOf(ctx, service.endpoint);
      if (name === undefined || name.owner !== granterOwner || name.revision !== gate.row.nameAuthorityRevision) return out(denied("conflict"));
      const capabilities = parseEndpointCapabilities(req.input.capabilities);
      if (capabilities.length === 0 || capabilities.some((c) => c.endpoint !== service.endpoint || c.instanceId !== service.instanceId || c.instanceOnly !== true))
        return out(denied("bad-request"));
      // A journal row has no instance segment, so it would reach the command's journal on every instance.
      if (capabilities.some((c) => c.journal === true)) return out(denied("unsupported"));
      if (capabilities.some((c) => c.target?.mode === "any" || c.target?.mode === "ledger")) return out(denied("permission-denied"));
      if (!withinCeiling(gate.row.serviceAuthority.callerCeiling, capabilities, grantee, service)) return out(denied("permission-denied"));
      let parentRefs: ServiceCallerGrant["parentRefs"];
      try {
        parentRefs = await callerParentRefs({ space, ledgerDir: opts.ledgerDir, grantee, capabilities, service,
          readPolicy: async (p) => { const read = await readPolicy(ctx, p.lifecycleUid); if (read.state === "absent") return undefined;
            if (!boundTo(read.row, p)) throw new EpEnvelopeError("permission-denied", "parent policy has another exact principal"); return read.row; } });
      } catch (e) { if (e instanceof EpEnvelopeError) return out(denied("permission-denied")); throw e; }
      const policy = await readPolicy(ctx, grantee.lifecycleUid);
      if (policy.state === "value" && !boundTo(policy.row, grantee)) return out(denied("conflict"));
      if ((policy.state === "value" ? policy.revision : 0) !== expectedPolicyRevision) return out(denied("conflict"));
      const body: GrantBody = { grantId: callerGrantId(space, operationId), endpoint: service.endpoint, instanceId: service.instanceId,
        serviceApprovalDigest: service.approvalDigest, capabilities,
        source: { kind: "service-owner", owner: granterOwner, approvalDigest: service.approvalDigest, nameAuthorityRevision: gate.row.nameAuthorityRevision }, parentRefs };
      const step = callerAppendStep(policy.state === "value" ? { row: policy.row, revision: policy.revision } : undefined, emptyPolicy(grantee),
        expectedPolicyRevision, withStatus(body, { state: "active" }));
      if (step.kind === "headroom") return out(denied("resource-exhausted"));
      if (step.kind !== "write") return out(denied("conflict"));
      const index = await readCallerIndex(ctx, service.endpoint, service.instanceId);
      if (index.state === "value" && index.row.entries.length >= S3_MAX_CALLER_GRANTS_PER_INSTANCE) return out(denied("resource-exhausted"));
      ctx.step = "G3-binding";
      return { v: 1, kind: "service-host-operation", operationId, requestId: req.requestId, requestDigest, operation: "grant", account: { accountPublicKey, space },
        granter: req.granter, admittedAtMs: now, notAfterMs: now + S2A_OPERATION_TTL_MS, admissionEpoch: adm.row.epoch,
        projection: { subjectOwner: granterOwner, endpoint: service.endpoint, instanceId: service.instanceId, proposalId: a.proposalId },
        plan: { kind: "caller-grant", grantee, assignmentDigest: a.assignmentDigest, approvalDigest: service.approvalDigest,
          nameAuthorityRevision: gate.row.nameAuthorityRevision, expectedPolicyRevision, request: req.input, grant: body },
        progress: { state: "admitted" }, debt: [] };
    }

    /** G4-G6 from the stored plan. A positive write is recorded `issued` first; past `notAfterMs`
     *  a replay makes no positive write and settles from one read of the policy row. */
    async function advanceGrant(inv: Inv, first: Op): Promise<GrantOut> {
      const ctx = readCtx(inv, "G-replay");
      const stored = outcomeOf(first);
      if (stored !== undefined) return stored.state === "complete" ? grantedArm(stored.result) : finalArm(operationId, stored, debtOf(first));
      let op = first as OpLive;
      const p = op.plan as CallerGrantPlan, uid = p.grantee.lifecycleUid, candidate = withStatus(p.grant, { state: "active" });
      const view = immutableGrantView(candidate), indexKey = callerIndexKey(p.grant.endpoint, p.grant.instanceId), policyKey = servicePolicyKey(uid);
      const mine = (e: { granteeUid: string; grantId: string }) => e.granteeUid === uid && e.grantId === p.grant.grantId;
      const finish = async (f: Final): Promise<GrantOut> => {
        const s = await settle(ctx, operationId, f, []), o = outcomeOf(s.op)!;
        return o.state === "complete" ? grantedArm(o.result) : finalArm(operationId, o, debtOf(s.op));
      };
      const refuse = (reason: ServiceOperationRefusal) => finish({ state: "refused", reason });
      const adopt = (grant: ServiceCallerGrant, revision: number) => finish({ state: "complete", result: { grant, revision } });
      /** Move the live progress from what this invocation last saw; another invocation's record holds. */
      const progressTo = async (next: Progress) => {
        const seen = canonicalJson(op.progress), want = canonicalJson(next);
        const r = await updateOp(ctx, operationId, (cur) => {
          const now = canonicalJson(cur.progress);
          if (isFinal(cur.progress) || now === want) return undefined;
          if (now !== seen) held("contention", ctx.step, "another invocation advanced this operation");
          return { ...cur, progress: next };
        });
        if (r.op.kind !== "service-host-operation" || isFinal(r.op.progress)) held("contention", ctx.step, "the operation settled under another invocation");
        op = r.op;
      };
      /** Record the write as issued, never with too little of the authority window left to start it:
       *  an open record is settled only by a later read, so one without its write holds until the key moves. */
      const issue = async (step: string, key: string, atRevision: number) => {
        if (Date.now() + 2 * S1_REQUEST_TIMEOUT_MS >= Math.min(inv.endMs, op.notAfterMs)) held("deadline", step, "too little of the authority window remains to issue the write");
        await progressTo({ state: "issued", step, key, atRevision });
      };
      /** The grant in the row from one read: present with this plan's immutable view, or absent. Anything else holds. */
      const lookup = async () => {
        const pol = await readPolicy(ctx, uid);
        if (pol.state === "value" && !boundTo(pol.row, p.grantee)) held("witness-mismatch", ctx.step, "the policy row at the grantee key is bound to another principal");
        const grant = pol.state === "value" ? pol.row.grants.find((x) => x.grantId === p.grant.grantId) : undefined;
        if (grant !== undefined && immutableGrantView(grant) !== view) held("witness-mismatch", ctx.step, "the stored grant differs from the operation's witness");
        return { pol, grant, revision: pol.state === "value" ? pol.revision : 0 };
      };

      // An open issued write: one read of its own key settles it, or its outcome stays unknown.
      if (op.progress.state === "issued") {
        const iss = op.progress;
        ctx.step = iss.step;
        if (iss.key === policyKey) {
          const found = await lookup();
          if (found.grant !== undefined) return adopt(found.grant, found.revision);
          if (found.revision <= iss.atRevision) held("outcome-unknown", ctx.step, "the issued append's outcome stays unknown until its key moves");
          await progressTo({ state: "custody", step: "G5-not-landed" });
        } else {
          const idx = await readCallerIndex(ctx, p.grant.endpoint, p.grant.instanceId);
          const landed = idx.state === "value" && idx.row.entries.some(mine);
          if (!landed && (idx.state === "value" ? idx.revision : 0) <= iss.atRevision) held("outcome-unknown", ctx.step, "the issued index write's outcome stays unknown until its key moves");
          await progressTo({ state: "custody", step: landed ? "G4-indexed" : "G4-not-landed" });
        }
      }
      // Past the operation's bound: no positive write. Adopt a landed grant, else the attempt expired.
      if (Date.now() >= op.notAfterMs) {
        ctx.step = "G-expired";
        const found = await lookup();
        return found.grant !== undefined ? adopt(found.grant, found.revision) : refuse("expired");
      }
      // A bound grant whose precondition stopped holding holds before G4 or G5; nothing is issued.
      ctx.step = "G4-precondition";
      if (!(await payloadHolds(ctx, operationId))) held("payload-precondition", ctx.step, "the payload precondition does not hold; nothing was issued");
      for (let n = 0; ; n++) {
        if (n >= S2A_MAX_REDECIDE) held("contention", "G4-index");
        ctx.step = "G4-index";
        const idx = await readCallerIndex(ctx, p.grant.endpoint, p.grant.instanceId);
        if (idx.state === "value" && idx.row.entries.some(mine)) {
          if (op.progress.state === "issued") await progressTo({ state: "custody", step: "G4-indexed" });
          break;
        }
        if (idx.state === "value" && idx.row.entries.length >= S3_MAX_CALLER_GRANTS_PER_INSTANCE) return refuse("resource-exhausted");
        const entries = [...(idx.state === "value" ? idx.row.entries : []), { granteeUid: uid, grantId: p.grant.grantId }].sort(byEntry);
        await issue("G4-index", indexKey, idx.state === "value" ? idx.revision : 0);
        const wrote = await put(authorityCtx(inv, op.notAfterMs, "G4-index"), indexKey, { v: 1, kind: "service-caller-grant-index", entries } satisfies CallerIndex,
          parseServiceCallerIndexRecord, idx.state === "value" ? idx : undefined);
        if (wrote !== "moved") { await progressTo({ state: "custody", step: "G4-indexed" }); break; }
        // A lost write: the next read of the same key settles it before anything is issued again.
      }
      // G5: the grant may already be in the row; otherwise re-check the approval's authority, then append.
      ctx.step = "G5-recheck";
      const found = await lookup();
      if (found.grant !== undefined) return adopt(found.grant, found.revision);
      const asg = await readAssignment(ctx, p.grant.endpoint, p.grant.instanceId);
      if (asg.state === "absent" || asg.row.assignmentDigest !== p.assignmentDigest || asg.row.owner !== op.projection.subjectOwner) return refuse("conflict");
      if (asg.row.state === "fenced" || asg.row.cancel !== null) return refuse("revoked");
      const gate = await endpoint(ctx, serviceAssignmentGate(inv.host, asg.row.reservation));
      if (gate.kind === "revoked") return refuse("revoked");
      if (gate.kind !== "approved" || gate.row.serviceAuthority.approvalDigest !== p.approvalDigest || gate.row.nameAuthorityRevision !== p.nameAuthorityRevision) return refuse("conflict");
      if (!serviceGateApprovalLive(gate.row.serviceAuthority, seconds(Date.now()))) return refuse("expired");
      const name = await nameOf(ctx, p.grant.endpoint);
      if (name === undefined || name.owner !== op.projection.subjectOwner || name.revision !== p.nameAuthorityRevision) return refuse("conflict");
      try {
        const refs = await callerParentRefs({ space, ledgerDir: opts.ledgerDir, grantee: p.grantee, capabilities: p.grant.capabilities, expectedRefs: p.grant.parentRefs,
          service: { endpoint: p.grant.endpoint, instanceId: p.grant.instanceId, approvalDigest: p.approvalDigest },
          readPolicy: async (parent) => { const read = await readPolicy(ctx, parent.lifecycleUid); if (read.state === "absent") return undefined;
            if (!boundTo(read.row, parent)) throw new EpEnvelopeError("permission-denied", "parent policy binding changed"); return read.row; } });
        if (canonicalJson(refs) !== canonicalJson(p.grant.parentRefs)) return refuse("revoked");
      } catch (e) { if (e instanceof EpEnvelopeError) return refuse("revoked"); throw e; }
      const step = callerAppendStep(found.pol.state === "value" ? { row: found.pol.row, revision: found.pol.revision } : undefined, emptyPolicy(p.grantee),
        p.expectedPolicyRevision, candidate);
      if (step.kind === "moved") return refuse("conflict");
      if (step.kind === "headroom") return refuse("resource-exhausted");
      if (step.kind !== "write") held("witness-mismatch", ctx.step, "the stored grant differs from the operation's witness");
      ctx.step = "G5-precondition";
      if (!(await payloadHolds(ctx, operationId))) held("payload-precondition", ctx.step, "the payload precondition does not hold; nothing was issued");
      await issue("G5-append", policyKey, p.expectedPolicyRevision);
      const wrote = await put(authorityCtx(inv, op.notAfterMs, "G5-append"), policyKey, step.row, parseNativeServiceCallerPolicy,
        found.pol.state === "value" ? found.pol : undefined);
      if (wrote !== "moved") return adopt(candidate, wrote);
      ctx.step = "G5-append";
      const after = await lookup();
      if (after.grant !== undefined) return adopt(after.grant, after.revision);
      if (after.revision > p.expectedPolicyRevision) return refuse("conflict");
      return held("outcome-unknown", ctx.step, "the issued append's outcome stays unknown until its key moves");
    }
  }

  /** caller-revoke (K0-K3): deny-new, the op-bound cutoff marker and its fixed deadline. It answers
   *  `pending` and never completes here: a terminal caller revocation needs the post-cutoff receipt
   *  inventory and absence proof this host does not build. */
  async function callerRevoke(req: Extract<ServiceHostRequest, { operation: "caller-revoke" }>, authorized: boolean): Promise<Arms> {
    if (!authorized) return unread(req.requestId, "permission-denied", "authorize");
    const operationId = serviceHostOperationId(space, req.requestId), requestDigest = requestDigestOf(req);
    const { grantee, grantId, expectedPolicyRevision } = req.input;
    const scope: ServiceHostScopeTarget = { operation: "caller-revoke", operationId, proposalId: null, owner: null, endpoint: null, instanceId: null,
      lifecycleUid: null, granteeUid: grantee.lifecycleUid, cutoffOperationId: operationId };
    let found: Read<Op> | undefined;
    // Discovery, read only: the cutoff operation is the one the grant's revoking status names, else this request's own.
    try {
      const dctx = discoveryCtx("discover");
      found = await readOp(dctx, operationId);
      const pol = await readPolicy(dctx, grantee.lifecycleUid);
      const g = pol.state === "value" ? pol.row.grants.find((x) => x.grantId === grantId) : undefined;
      if (g !== undefined && g.status.state !== "active") scope.cutoffOperationId = g.status.operationId;
    } catch (err) { if (err instanceof Held) return discoveryHeld(operationId, requestDigest, found, err); throw err; }
    const deadlineMs = Date.now() + S2A_INVOCATION_MS;
    try {
      const first = await invoke(scope, (inv) => attempt(inv, scope.cutoffOperationId!), deadlineMs);
      if (!("rescope" in first)) return first;
      // Another operation landed deny-new first. Every write this invocation issued had a known
      // outcome and its effect closed; reopen once, under the same deadline, for that operation's marker.
      if (Date.now() >= deadlineMs) return { state: "held", operationId, reason: "reconcile-pending", phase: "K1-rescope" };
      const second = await invoke({ ...scope, cutoffOperationId: first.rescope }, (inv) => attempt(inv, first.rescope), deadlineMs);
      return "rescope" in second ? { state: "held", operationId, reason: "scope-mismatch", phase: "K1-rescope" } : second;
    } catch (err) { if (err instanceof Held) return discoveryHeld(operationId, requestDigest, found, err); throw err; }

    async function attempt(inv: Inv, cutoff: string): Promise<Arms | { rescope: string }> {
      inv.operationId = operationId;
      try {
        const ctx = readCtx(inv, "K0-binding");
        for (let n = 0; ; n++) {
          if (n >= S2A_MAX_REDECIDE) held("contention", ctx.step);
          const op = await readOp(ctx, operationId);
          if (op.state === "value" && op.row.requestDigest === requestDigest) {
            // The digest covers the granter, so a replay is by the recorded granter: an operator, or an
            // owner who is the witness's source owner or grantee owner.
            if (req.granter.kind === "owner" && op.row.kind === "service-host-operation" && op.row.plan.kind === "caller-revoke") {
              const w = op.row.plan;
              if (!((w.grant.source.kind === "service-owner" && w.grant.source.owner === req.granter.owner) || w.grantee.owner === req.granter.owner))
                return { state: "held", operationId, reason: "permission-denied", phase: "authorize" };
            }
            return await advanceCallerRevoke(inv, op.row, cutoff);
          }
          if (op.state === "value") return denied("conflict");
          inv.bound = false;
          ctx.step = "K0-admit";
          const pol = await readPolicy(ctx, grantee.lifecycleUid);
          const g = pol.state === "value" && boundTo(pol.row, grantee) ? pol.row.grants.find((x) => x.grantId === grantId) : undefined;
          if (g === undefined) return denied("not-found");
          // A delegated source is never written here, and only a source or grantee owner may revoke as an owner.
          if (g.source.kind !== "service-owner") return denied("unsupported");
          if (req.granter.kind === "owner" && req.granter.owner !== g.source.owner && req.granter.owner !== grantee.owner) return denied("not-found");
          if (g.status.state === "revoked") return denied("conflict");
          if (g.status.state === "active" && (pol as Live<NativeServiceCallerPolicy>).revision !== expectedPolicyRevision) return denied("conflict");
          const adm = await readAdmission(ctx), now = Date.now();
          const { status: _status, ...body } = g;
          ctx.step = "K0-binding";
          const binding: OpLive = { v: 1, kind: "service-host-operation", operationId, requestId: req.requestId, requestDigest, operation: "revoke",
            account: { accountPublicKey, space }, granter: req.granter, admittedAtMs: now, notAfterMs: now + S2A_OPERATION_TTL_MS,
            admissionEpoch: adm.state === "value" ? adm.row.epoch : 0,
            projection: { subjectOwner: g.source.owner, endpoint: g.endpoint, instanceId: g.instanceId, proposalId: null },
            plan: { kind: "caller-revoke", grantee, grantId, expectedPolicyRevision, request: req.input, grant: body }, progress: { state: "admitted" }, debt: [] };
          inv.bound = true;
          if ((await put(ctx, opKey(operationId), binding, parseServiceHostOperationRecord)) !== "moved") return await advanceCallerRevoke(inv, binding, cutoff);
        }
      } catch (err) { if (err instanceof Held) return heldArm(inv, err); throw err; }
    }

    /** K1-K3 from the stored witness. Each step narrows authority only, so none is bounded by the
     *  operation's `notAfterMs`; each still ends at its invocation's deadline. */
    async function advanceCallerRevoke(inv: Inv, first: Op, cutoff: string): Promise<Arms | { rescope: string }> {
      const ctx = readCtx(inv, "K-replay");
      const stored = outcomeOf(first);
      if (stored !== undefined) return stored.state === "complete" ? held("operation-malformed", ctx.step, "a caller revoke never completes") : finalArm(operationId, stored, debtOf(first));
      const p = (first as OpLive).plan as CallerRevokePlan, policyKey = servicePolicyKey(p.grantee.lifecycleUid);
      const witness = immutableGrantView(withStatus(p.grant, { state: "active" }));
      /** The grant from one read; anything but the witness's immutable view holds and writes nothing. */
      const lookup = async () => {
        const pol = await readPolicy(ctx, p.grantee.lifecycleUid);
        const grant = pol.state === "value" && boundTo(pol.row, p.grantee) ? pol.row.grants.find((x) => x.grantId === p.grantId) : undefined;
        if (grant === undefined || immutableGrantView(grant) !== witness) return held("witness-mismatch", ctx.step, "the grant no longer matches the operation's witness");
        return { pol: pol as Live<NativeServiceCallerPolicy>, grant };
      };
      // K1: deny-new under this operation, or the operation that already holds the grant's intent.
      let holder: string | undefined;
      for (let n = 0; holder === undefined; n++) {
        if (n >= S2A_MAX_REDECIDE) held("contention", "K1-deny-new");
        ctx.step = "K1-deny-new";
        const { pol, grant } = await lookup();
        if (grant.status.state === "revoked") held("terminal-unsupported", ctx.step, "a terminal caller revocation is outside this host");
        const step = callerBeginStep(pol.row, p.grantId, operationId);
        if (step.kind === "held") { holder = step.operationId; break; }
        if (step.kind !== "write") held("witness-mismatch", ctx.step, "the grant no longer matches the operation's witness");
        await assertWriteFits(ctx, step.row, operationId);
        if ((await put(ctx, policyKey, step.row, parseNativeServiceCallerPolicy, pol)) !== "moved") holder = operationId;
      }
      if (holder !== cutoff) return { rescope: holder };
      // K2: the holder's marker, created once from the witness; identical bytes are adopted.
      ctx.step = "K2-marker";
      const markerKey = cutoffKey(holder);
      const marker: CutoffMarker = { v: 1, kind: "service-cutoff-marker", accountPublicKey, space, operationId: holder,
        target: { kind: "caller-grant", grantee: p.grantee, grantId: p.grantId, endpoint: p.grant.endpoint, instanceId: p.grant.instanceId },
        authorityDigest: contractDigest({ v: 1, kind: "service-caller-grant-authority", accountPublicKey, space, grantee: p.grantee, grant: p.grant }) };
      let m = await leader(ctx, "auth", markerKey);
      if (m.state === "absent") { await put(ctx, markerKey, marker, parseServiceCutoffMarkerRecord); m = await leader(ctx, "auth", markerKey); }
      if (m.state === "marker") held("marker-tombstone", ctx.step, `${markerKey} carries a ${m.op} marker`);
      let same = false;
      if (m.state === "value") { try { same = contractDigest(parseServiceCutoffMarkerRecord(m.value)) === contractDigest(marker); } catch { same = false; } }
      if (m.state !== "value" || !same) return held("marker-conflict", ctx.step, "the cutoff marker key holds another value; it is never overwritten");
      const at = serviceMarkerCeilSeconds(m.timestamp);
      if (at === undefined) return held("marker-time-unknown", ctx.step, "the marker's stored time is not a readable server time; now is never substituted");
      const cut = { operationId: holder, markerKey, markerRevision: m.revision, notBefore: at + SERVICE_CUTOFF_MARGIN_S };
      // K3: the deadline, recorded once and never reset.
      for (let n = 0; ; n++) {
        if (n >= S2A_MAX_REDECIDE) held("contention", "K3-deadline");
        ctx.step = "K3-deadline";
        const { pol } = await lookup();
        const step = callerCutoffStep(pol.row, p.grantId, cut);
        if (step.kind === "same") break;
        if (step.kind === "conflict") held("marker-conflict", ctx.step, step.detail);
        if (step.kind !== "write") held("witness-mismatch", ctx.step, "the grant no longer matches the operation's witness");
        await assertWriteFits(ctx, step.row, operationId);
        if ((await put(ctx, policyKey, step.row, parseNativeServiceCallerPolicy, pol)) !== "moved") break;
      }
      await updateOp(ctx, operationId, (cur) => (cur.progress.state === "custody" && cur.progress.step === "cutoff-recorded" ? undefined
        : isFinal(cur.progress) ? undefined : { ...cur, progress: { state: "custody", step: "cutoff-recorded" } })).catch((err) => { if (!(err instanceof Held)) throw err; });
      // The phase is advisory, in the gate's whole-second convention; a terminal proof compares broker time.
      return { state: "pending", operationId, phase: seconds(Date.now()) < cut.notBefore ? "cutoff-wait" : "awaiting-terminal-proof", notBefore: cut.notBefore, denyNew: "landed" };
    }
  }

  type PolicyOut = { state: "present"; record: { value: ServiceCallerPolicyView; revision: number } } | { state: "absent" } | Arms;
  type PolicyPage = { state: "page"; records: Array<{ value: ServiceCallerPolicyView; revision: number }>; nextCursor: string | null } | Arms;
  /** A view of one row; a filtered view carries only that service's grants, and the revision is always the whole row's. */
  const policyView = (row: NativeServiceCallerPolicy, service: ServiceSelector | null): ServiceCallerPolicyView => ({
    grantee: { ...row.grantee }, service: service === null ? null : { endpoint: service.endpoint, instanceId: service.instanceId },
    grants: structuredClone(service === null ? row.grants : row.grants.filter((g) => g.endpoint === service.endpoint && g.instanceId === service.instanceId)) });

  /** caller-policy-read: an operator reads any grantee; an owner reads its own grantees in full or
   *  filtered, and another owner's grantee only filtered to a service the owner holds. */
  async function callerPolicyRead(req: Extract<ServiceHostRequest, { operation: "caller-policy-read" }>): Promise<PolicyOut> {
    try {
      const ctx = discoveryCtx("caller-policy-read");
      const { grantee, service } = req.input, g = req.granter;
      if (g.kind === "owner" && grantee.owner !== g.owner) {
        if (service === null) return { state: "absent" };
        const asg = await readAssignment(ctx, service.endpoint, service.instanceId);
        if (asg.state === "absent" || asg.row.owner !== g.owner) return { state: "absent" };
      }
      const pol = await readPolicy(ctx, grantee.lifecycleUid);
      if (pol.state === "absent") return { state: "absent" };
      if (!boundTo(pol.row, grantee)) return denied("conflict");
      return { state: "present", record: { value: policyView(pol.row, service), revision: pol.revision } };
    } catch (err) { if (err instanceof Held) return denied("unavailable"); throw err; }
  }

  const listCursor = (service: ServiceSelector, ownerFilter: string | null, after: string) =>
    Buffer.from(canonicalJson({ v: 1, op: "caller-policy-list", accountPublicKey, space, service, owner: ownerFilter, after }), "utf8").toString("base64url");
  /** caller-policy-list: one service's grantees, from its instance index, in uid order. Space-wide
   *  enumeration is unsupported. An owner lists only a service it holds; an operator any. Orphan
   *  entries are skipped, and an unreadable row fails the whole page. */
  async function callerPolicyList(req: Extract<ServiceHostRequest, { operation: "caller-policy-list" }>): Promise<PolicyPage> {
    const { service, owner: ownerFilter, cursor, limit } = req.input;
    if (service === null) return denied("unsupported");
    const sel = { endpoint: service.endpoint, instanceId: service.instanceId };
    let after: string | null = null;
    if (cursor !== null) {
      try { after = (JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as Rec)?.after as string; } catch { return denied("bad-request"); }
      if (typeof after !== "string" || listCursor(sel, ownerFilter, after) !== cursor) return denied("bad-request");
    }
    try {
      const ctx = discoveryCtx("caller-policy-list");
      const empty: PolicyPage = { state: "page", records: [], nextCursor: null };
      if (req.granter.kind === "owner") {
        const asg = await readAssignment(ctx, sel.endpoint, sel.instanceId);
        if (asg.state === "absent" || asg.row.owner !== req.granter.owner) return empty;
      }
      const idx = await readCallerIndex(ctx, sel.endpoint, sel.instanceId);
      const uids = [...new Set((idx.state === "value" ? idx.row.entries : []).map((e) => e.granteeUid))].filter((u) => after === null || u > after);
      const records: Array<{ value: ServiceCallerPolicyView; revision: number }> = [];
      let last: string | undefined, more = false;
      for (const uid of uids) {
        const pol = await readPolicy(ctx, uid);
        if (pol.state === "absent") continue;
        if (pol.row.grantee.lifecycleUid !== uid || pol.row.accountPublicKey !== accountPublicKey || pol.row.space !== space) return denied("unavailable");
        const value = policyView(pol.row, sel);
        if (value.grants.length === 0 || (ownerFilter !== null && pol.row.grantee.owner !== ownerFilter)) continue;
        if (records.length === limit) { more = true; break; }
        records.push({ value, revision: pol.revision }); last = uid;
      }
      return { state: "page", records, nextCursor: more && last !== undefined ? listCursor(sel, ownerFilter, last) : null };
    } catch (err) { if (err instanceof Held) return denied("unavailable"); throw err; }
  }

  // ---- reads (never write) ------------------------------------------------------------------------

  type ReadOut<T> = { state: "present"; record: { value: T; revision: number } } | { state: "absent" } | Arms;
  type InstancePage = { state: "page"; records: Array<{ value: ServiceInstanceView; revision: number }>; nextCursor: string | null } | Arms;

  /** One assignment's public view. The assignment revision versions the selector binding; the
   *  endpoint gate, registration stamp, ready status and name are current leader reads. */
  async function instanceView(ctx: Ctx, a: Assignment): Promise<ServiceInstanceView> {
    let binding: ServiceAssignmentBinding, epgate: ServiceGateRows;
    if (a.state === "bound") ({ binding, epgate } = serviceAssignmentGate(discovery.host, a.reservation));
    else {
      const proposal = await readProposal(ctx, a.proposalId);
      if (proposal.state === "absent" || proposal.row.kind !== "service-proposal-terminal" || proposal.row.state !== "approved" || proposal.row.operationId === null)
        return held("assignment-inconsistent", ctx.step, "the fenced assignment has no retained approval");
      const operation = await readOp(ctx, proposal.row.operationId), outcome = operation.state === "value" ? outcomeOf(operation.row) : undefined;
      if (outcome?.state !== "complete") return held("assignment-inconsistent", ctx.step, "the fenced assignment's approval result is not readable");
      const approval = outcome.result as ServiceApprovalResult;
      if (approval.assignment.endpoint !== a.endpoint || approval.assignment.instanceId !== a.instanceId || approval.assignment.assignmentDigest !== a.assignmentDigest
        || approval.approvalDigest !== proposal.row.approvalDigest)
        return held("assignment-inconsistent", ctx.step, "the fenced assignment disagrees with its retained approval");
      binding = { accountPublicKey, space, owner: a.owner, endpoint: a.endpoint, instanceId: a.instanceId,
        lifecycleUid: approval.assignment.lifecycleUid, assignmentDigest: a.assignmentDigest };
      epgate = serviceGateRows(ctx.h.registry, binding);
    }
    const principal = { owner: a.owner, actor: serviceEndpointActor(binding), lifecycleUid: binding.lifecycleUid };
    const name = await nameOf(ctx, a.endpoint), nameBinding = name?.owner === a.owner ? name : null;
    const gate = await endpoint(ctx, { epgate });
    if (gate.kind === "absent" || gate.kind === "pending") {
      if (a.state === "fenced") return held("assignment-inconsistent", ctx.step, "the fenced assignment has no retired endpoint gate");
      return { assignmentDigest: a.assignmentDigest, principal, endpoint: a.endpoint, instanceId: a.instanceId,
      state: a.cancel === null ? "pending-root" : "revoking", rootCredentialId: null, rootExpiresAt: null, approvalDigest: null, approvalExpiresAt: null,
      activationIssued: false, witness: null, nameBinding };
    }
    if (gate.kind === "foreign") return held("assignment-inconsistent", ctx.step, "the endpoint gate belongs to another assignment");
    const authority = gate.row.serviceAuthority, witness = stampWitness(ctx, binding, gate.row) ?? null;
    let state: ServiceInstanceView["state"];
    if (a.state === "fenced") state = "retired";
    else if (a.cancel !== null || gate.kind === "revoked") state = "revoking";
    else if (authority.pendingRegistration !== undefined) state = "registering";
    else if (witness === null) state = "approved-unregistered";
    else state = await reportedAt(ctx, witness) === undefined ? "registered" : "ready";
    return { assignmentDigest: a.assignmentDigest, principal, endpoint: a.endpoint, instanceId: a.instanceId, state,
      rootCredentialId: authority.rootCredentialId, rootExpiresAt: authority.rootExpiresAt, approvalDigest: authority.approvalDigest,
      approvalExpiresAt: authority.approvalExpiresAt, activationIssued: authority.activationIssued, witness, nameBinding };
  }

  async function instanceRead(req: Extract<ServiceHostRequest, { operation: "instance-read" }>): Promise<ReadOut<ServiceInstanceView>> {
    try {
      const ctx = discoveryCtx("instance-read"), a = await readAssignment(ctx, req.input.endpoint, req.input.instanceId);
      if (a.state === "absent" || (req.granter.kind === "owner" && a.row.owner !== req.granter.owner)) return { state: "absent" };
      return { state: "present", record: { value: await instanceView(ctx, a.row), revision: a.revision } };
    } catch (err) { if (err instanceof Held || err instanceof EpEnvelopeError) return denied("unavailable"); throw err; }
  }

  const instanceCursor = (ownerFilter: string | null, afterSeq: number) =>
    Buffer.from(canonicalJson({ v: 1, op: "instance-list", accountPublicKey, space, owner: ownerFilter, afterSeq }), "utf8").toString("base64url");

  async function instanceList(req: Extract<ServiceHostRequest, { operation: "instance-list" }>): Promise<InstancePage> {
    const requestedOwner = req.input.owner;
    if (req.granter.kind === "owner" && requestedOwner !== null && requestedOwner !== req.granter.owner)
      return { state: "page", records: [], nextCursor: null };
    const ownerFilter = req.granter.kind === "owner" ? req.granter.owner : requestedOwner;
    let afterSeq = 0;
    if (req.input.cursor !== null) {
      try { afterSeq = (JSON.parse(Buffer.from(req.input.cursor, "base64url").toString("utf8")) as Rec)?.afterSeq as number; } catch { return denied("bad-request"); }
      if (!Number.isSafeInteger(afterSeq) || afterSeq < 0 || instanceCursor(ownerFilter, afterSeq) !== req.input.cursor) return denied("bad-request");
    }
    try {
      const ctx = discoveryCtx("instance-list"), records: Array<{ value: ServiceInstanceView; revision: number }> = [];
      const bucket = epAuthBucket(space), prefix = `$KV.${bucket}.`, filter = `${prefix}svcasg.*.*`;
      let seq = afterSeq + 1, lastIncluded = afterSeq;
      for (;;) {
        let m;
        const next = await bounded(ctx, () => ctx.jsm.streams.getMessage(`KV_${bucket}`, { seq, next_by_subj: filter } as unknown as MsgRequest));
        if (!next.ok) {
          if ("error" in next && (next.error as { code?: unknown })?.code === 10037) return { state: "page", records, nextCursor: null };
          return denied("unavailable");
        }
        m = next.value;
        if (!m) return { state: "page", records, nextCursor: null };
        seq = m.seq + 1;
        const key = m.subject.slice(prefix.length), current = await read(ctx, key, "assignment", parseServiceAssignmentRecord);
        if (current.state === "absent" || current.revision !== m.seq || (ownerFilter !== null && current.row.owner !== ownerFilter)) continue;
        if (records.length === req.input.limit) return { state: "page", records, nextCursor: instanceCursor(ownerFilter, lastIncluded) };
        records.push({ value: await instanceView(ctx, current.row), revision: current.revision });
        lastIncluded = m.seq;
      }
    } catch (err) { if (err instanceof Held || err instanceof EpEnvelopeError) return denied("unavailable"); throw err; }
  }

  async function operationRead(req: Extract<ServiceHostRequest, { operation: "operation-read" }>): Promise<ReadOut<ServiceOperationView | ServiceOperationTerminalView>> {
    try {
      const ctx = discoveryCtx("operation-read");
      const op = await readOp(ctx, req.input.operationId);
      if (op.state === "absent") return { state: "absent" };
      const g = req.granter, o = op.row;
      if (g.kind === "owner" && !((o.granter.kind === "owner" && o.granter.owner === g.owner) || o.projection.subjectOwner === g.owner)) return { state: "absent" };
      const projection = { ...o.projection };
      if (o.kind === "service-host-operation-terminal")
        return { state: "present", record: { value: { operationId: o.operationId, requestDigest: o.requestDigest, operation: o.operation, projection, outcome: finalView(o.outcome) }, revision: op.revision } };
      const p = o.plan, assignmentDigest = p.kind === "approve" ? serviceAssignmentGate(discovery.host, p.reservation).binding.assignmentDigest : p.kind === "revoke" ? p.expectedAssignmentDigest : null;
      const target: ServiceOperationView["target"] = p.kind === "caller-grant" || p.kind === "caller-revoke" ? { kind: "caller", grantee: { ...p.grantee } }
        : { kind: "service", endpoint: o.projection.endpoint, instanceId: o.projection.instanceId, assignmentDigest };
      const g2 = o.progress;
      const progress: ServiceOperationView["progress"] = g2.state === "admitted" ? { state: "pending", phase: "admitted" }
        : g2.state === "custody" || g2.state === "issued" ? { state: "pending", phase: g2.step }
        : g2.state === "held" ? { state: "held", reason: g2.reason, phase: g2.phase } : finalView(g2);
      return { state: "present", record: { value: { operationId: o.operationId, requestDigest: o.requestDigest, operation: o.operation,
        target, projection, progress, debt: o.debt.map((d) => ({ ...d })) }, revision: op.revision } };
    } catch (err) { if (err instanceof Held) return denied("unavailable"); throw err; }
  }
  const finalView = (f: Final): ServiceOperationTerminalView["outcome"] =>
    f.state === "complete" ? { state: "complete", resultDigest: contractDigest(f.result) } : f.state === "refused" ? { state: "refused", reason: f.reason } : { state: "superseded", boundOperationId: f.boundOperationId };

  async function proposalRead(req: Extract<ServiceHostRequest, { operation: "proposal-read" }>): Promise<ReadOut<ServiceProposalView | ServiceProposalTombstoneView>> {
    try {
      const ctx = discoveryCtx("proposal-read");
      const prop = await readProposal(ctx, req.input.proposalId);
      if (prop.state === "absent" || (req.granter.kind === "owner" && prop.row.owner !== req.granter.owner)) return { state: "absent" };
      const p = prop.row;
      if (p.kind === "service-proposal-terminal") return { state: "present", record: { value: view(p), revision: prop.revision } };
      const name = await nameOf(ctx, p.endpoint);
      return { state: "present", record: { value: { proposalId: p.proposalId, proposalDigest: p.proposalDigest, owner: p.owner, endpoint: p.endpoint, instanceId: p.instanceId,
        state: p.state.state, createdAt: seconds(p.createdAtMs), expiresAt: seconds(p.expiresAtMs), clusterDigests: [...p.clusterDigests], commands: structuredClone(p.commands),
        nameBinding: name !== undefined && (req.granter.kind === "operator" || name.owner === p.owner) ? name : null, decision: p.state.state === "approving" ? { operationId: p.state.operationId, assignmentDigest: p.state.assignmentDigest } : null }, revision: prop.revision } };
    } catch (err) { if (err instanceof Held) return denied("unavailable"); throw err; }
  }

  /** One name binding, as the operator or as the owner it is bound to; another owner's reads absent. */
  async function nameRead(req: Extract<ServiceHostRequest, { operation: "name-read" }>): Promise<ReadOut<ServiceNameView>> {
    try {
      const ctx = discoveryCtx("name-read");
      const name = await nameOf(ctx, req.input.endpoint);
      if (name === undefined || (req.granter.kind === "owner" && name.owner !== req.granter.owner)) return { state: "absent" };
      return { state: "present", record: { value: name, revision: name.revision } };
    } catch (err) { if (err instanceof Held) return denied("unavailable"); throw err; }
  }

  // ---- name binding (create-only) ----------------------------------------------------------------

  type NameOut = Arms | { state: "bound"; binding: ServiceNameView };
  /** One zero-history create of the endpoint's name row through this invocation's custody host. Only
   *  the identical request recovers an existing row; transfer, release and update do not exist. */
  async function nameBind(req: Extract<ServiceHostRequest, { operation: "name-bind" }>): Promise<NameOut> {
    const { endpoint: e, owner: o, expectedRevision, claimReference } = req.input;
    if (expectedRevision !== 0) return denied("unsupported");                                            // never binds
    let key: string;
    try { key = serviceNameKey(e); }
    catch (err) { if (err instanceof EpEnvelopeError && err.code === "permission-denied") return denied("permission-denied"); throw err; }
    const bytes = serviceNameRowBytes({ accountPublicKey, space }, req), requestDigest = contractDigest(req);
    const operationId = serviceHostOperationId(space, req.requestId);
    try {
      return await invoke({ operation: "name-bind", operationId: null, proposalId: null, owner: null, endpoint: e, instanceId: null, lifecycleUid: null }, async (inv) => {
        inv.operationId = operationId;
        try {
          const ctx = readCtx(inv, "N-read");
          for (let n = 0; ; n++) {
            if (n >= S2A_MAX_REDECIDE) held("contention", ctx.step);
            const found = await nameOf(ctx, e);
            if (found !== undefined) {
              if (found.requestId === req.requestId && found.requestDigest === requestDigest && found.owner === o && found.claimReference === claimReference)
                return { state: "bound", binding: found };
              return denied(found.requestId === req.requestId ? "conflict" : "name-bound");
            }
            ctx.step = "N-create";
            await write(ctx, "auth", key, bytes, { create: true });
            ctx.step = "N-read";
          }
        } catch (err) { if (err instanceof Held) return heldArm(inv, err); throw err; }
      });
    } catch (err) { if (err instanceof Held) return unread(req.requestId, err.reason, err.step); throw err; }
  }

  // ---- serving: register, activate, renew and ready (SPEC 13.1) -----------------------------------

  type Bound = { state: "bound"; row: Extract<Assignment, { state: "bound" }>; binding: ServiceAssignmentBinding; epgate: ServiceGateRows };
  type Binding = { state: "absent" } | { state: "fenced"; row: Extract<Assignment, { state: "fenced" }> } | Bound;
  const deniedServe = (reason: string): ServiceServeResult => ({ state: "denied", reason });
  /** The owner's own assignment at a selector; another owner's reads absent. */
  async function bindingOf(ctx: Ctx, o: string, e: string, i: string): Promise<Binding> {
    const asg = await readAssignment(ctx, e, i);
    if (asg.state === "absent" || asg.row.owner !== o) return { state: "absent" };
    if (asg.row.state === "fenced") return { state: "fenced", row: asg.row };
    return { state: "bound", row: asg.row, ...serviceAssignmentGate(discovery.host, asg.row.reservation) };
  }
  /** A witness is a public coordinate: it must name this selector, owner, actor and lifecycle. */
  const namesBinding = (w: ServiceRegistrationWitness, b: ServiceAssignmentBinding) =>
    namesSelector(w, b) && w.principal.actor === serviceEndpointActor(b) && w.principal.lifecycleUid === b.lifecycleUid;
  /** The part of {@link namesBinding} a selector alone decides, before anything is read. */
  const namesSelector = (w: ServiceRegistrationWitness, s: { owner: string; endpoint: string; instanceId: string }) =>
    w.accountPublicKey === accountPublicKey && w.space === space && w.endpoint === s.endpoint && w.instanceId === s.instanceId && w.principal.owner === s.owner;
  /** The witness of a gate's current registration stamp, or undefined when the gate has none. A stamp
   *  whose coordinates disagree with the gate's is inconsistent and holds. */
  function stampWitness(ctx: Ctx, b: ServiceAssignmentBinding, row: EndpointRow): ServiceRegistrationWitness | undefined {
    const a = row.serviceAuthority, stamp = a.registration;
    if (stamp === undefined) return undefined;
    if (a.rootCredentialId === null || a.approvalDigest === null || stamp.processEpoch !== row.processEpoch
      || stamp.registrationRevision !== row.registrationRevision || stamp.nameAuthorityRevision !== row.nameAuthorityRevision)
      return held("registration-inconsistent", ctx.step, "the registration stamp disagrees with its endpoint gate");
    return { accountPublicKey, space, endpoint: b.endpoint, instanceId: b.instanceId,
      principal: { owner: b.owner, actor: serviceEndpointActor(b), lifecycleUid: b.lifecycleUid },
      rootCredentialId: a.rootCredentialId, approvalDigest: a.approvalDigest, processEpoch: stamp.processEpoch,
      registrationRevision: stamp.registrationRevision, nameAuthorityRevision: stamp.nameAuthorityRevision,
      registrationRequestId: stamp.requestId, registrationProof: stamp.registrationProof };
  }
  /** The closures' manifest and root documents, each verified against its digest. */
  async function closureArtifacts(ctx: Ctx, clusterDigests: string[]): Promise<unknown[]> {
    const reader = opts.serving?.readContractArtifact;
    if (reader === undefined) return held("unavailable", ctx.step, "this host has no contract store reader");
    const get = async (d: string) => {
      const r = await bounded(ctx, () => reader(d));
      if (!r.ok) return held("unavailable", ctx.step, "timedOut" in r ? `the contract artifact ${d} read timed out` : message(r.error));
      return r.value;
    };
    const out: unknown[] = [];
    for (const closure of clusterDigests) {
      const manifest = await get(closure);
      const document = await grammarHeld(ctx, async () => { const { root } = verifyClusterManifest(closure, manifest); const raw = await get(root); verifyClusterRoot(root, raw); return raw; });
      out.push(manifest, document);
    }
    return out;
  }
  /** A read that its own parser or verifier refuses holds as inconsistent, never as absence. */
  async function grammarHeld<T>(ctx: Ctx, f: () => Promise<T> | T): Promise<T> {
    try { return await f(); } catch (e) { if (e instanceof Held) throw e; return held("registration-inconsistent", ctx.step, message(e)); }
  }
  /** The registered spec at the witness revision, the name revision and the closures' artifacts. */
  async function snapshotOf(ctx: Ctx, w: ServiceRegistrationWitness, artifacts?: unknown[]): Promise<ServiceRegistrationSnapshot> {
    const cur = await leader(ctx, "records", recordSpecKey(RECORD_KINDS.svc, [w.endpoint, w.instanceId]));
    if (cur.state !== "value" || cur.revision !== w.registrationRevision)
      return held("registration-inconsistent", ctx.step, "the registered spec is not readable at the witness revision");
    const spec: ServiceSpec = await grammarHeld(ctx, () => parseServiceSpec(cur.value, { endpoint: w.endpoint }));
    if (spec.owner !== w.principal.owner) return held("registration-inconsistent", ctx.step, "the registered spec names another owner");
    return { spec: { value: spec, revision: cur.revision }, name: { authorized: true, revision: w.nameAuthorityRevision }, processEpoch: w.processEpoch,
      contractArtifacts: artifacts ?? await closureArtifacts(ctx, spec.clusterDigests) };
  }
  /** The service-reported ready status at the witness's epoch and spec revision, if recorded. */
  async function reportedAt(ctx: Ctx, w: ServiceRegistrationWitness): Promise<number | undefined> {
    const cur = await leader(ctx, "records", recordStatusKey(RECORD_KINDS.svc, [w.endpoint, w.instanceId]));
    if (cur.state === "absent" || cur.state === "marker") return undefined;
    if (cur.state === "malformed") return held("registration-inconsistent", ctx.step, "the service status is not JSON");
    const status = await grammarHeld(ctx, () => parseServiceStatus(cur.value));
    const at = (status as { reportedAt?: unknown }).reportedAt;
    return status.state === "ready" && status.epoch === w.processEpoch && status.observedSpecRevision === w.registrationRevision
      && typeof at === "number" && Number.isSafeInteger(at) && at >= 0 ? at : undefined;
  }
  /** The live native root's expiry in Unix seconds; a refused proof is a definite refusal. */
  async function rootExpiresAt(ctx: Ctx, inv: Inv, b: ServiceAssignmentBinding, rootCredentialId: string): Promise<number | ServiceServeResult> {
    const r = await bounded(ctx, () => readRegistryServiceRoot(inv.h.registry, b, rootCredentialId, Date.now()));
    if (r.ok) return r.value.expiresAt;
    if ("error" in r && r.error instanceof EpEnvelopeError && r.error.code === "permission-denied") return deniedServe("root-revoked");
    return held("unavailable", ctx.step, "timedOut" in r ? "the native root read timed out" : message(r.error));
  }
  /** Run one native multi-request step to completion or the invocation's original deadline, which
   *  ends the step held; the step's own later requests then fail on the closed connection. */
  async function native<T>(ctx: Ctx, start: () => Promise<T>): Promise<T> {
    const remaining = ctx.deadlineMs - Date.now();
    if (remaining <= 0) return held("deadline", ctx.step, "the original deadline has passed; no request starts");
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<"timeout">((r) => { timer = setTimeout(() => r("timeout"), remaining); });
    const settled = start().then((value) => ({ value }), (error: unknown) => ({ error }));
    let r: { value: T } | { error: unknown } | "timeout";
    try { r = await Promise.race([settled, timeout]); } finally { clearTimeout(timer); }
    if (r === "timeout") return held("deadline", ctx.step, "the original deadline was reached during a native step");
    if ("error" in r) return held("unknown", ctx.step, `the native step did not complete: ${message(r.error)}`);
    return r.value;
  }
  /** Classify the assignment's endpoint gate; anything but an approved or revoked service gate is
   *  inconsistent for a bound selector past approval. */
  async function servedGate(ctx: Ctx, b: Bound) {
    const g = await endpoint(ctx, b);
    if (g.kind !== "approved" && g.kind !== "revoked") return held("registration-inconsistent", ctx.step, `the endpoint gate is ${g.kind}`);
    return g;
  }
  const sameIntent = (a: Intent, b: Intent) => canonicalJson({ ...a, admittedAtMs: 0 }) === canonicalJson({ ...b, admittedAtMs: 0 });

  /** A register key the proposal phase already admitted stays bound to that admission's body and
   *  proposal: a changed body is a conflict, and a key of another proposal answers that proposal's
   *  own refusal, or a conflict. */
  async function keyHistory(ctx: Ctx, req: ServiceServeRequest, b: Bound, id: string): Promise<ServiceServeResult | undefined> {
    ctx.step = "S-key";
    const op = await readOp(ctx, id);
    if (op.state === "absent") return undefined;
    const r = req.register!;
    const admitted = serviceRegisterHostRequest({ owner: req.owner, endpoint: req.endpoint, instanceId: req.instanceId, engineRequestId: req.engineRequestId,
      requestId: req.requestId, requestDigest: req.requestDigest, clusterDigests: r.clusterDigests, commands: r.commands });
    if (op.row.operation !== "register" || op.row.requestDigest !== requestDigestOf(admitted)) return deniedServe("conflict");
    const proposalId = op.row.projection.proposalId;
    if (proposalId === b.row.proposalId) return undefined;
    const p = proposalId === null ? undefined : await readProposal(ctx, proposalId);
    if (p?.state === "value") {
      if (p.row.kind === "service-proposal-terminal" && (p.row.state === "refused" || p.row.state === "expired"))
        return deniedServe(p.row.state === "expired" ? "proposal-expired" : "proposal-refused");
      if (p.row.kind === "service-proposal" && p.row.state.state === "proposed" && Date.now() >= p.row.expiresAtMs) return deniedServe("proposal-expired");
    }
    return deniedServe("conflict");
  }

  /** R1 §A: a new admission's key history and state check, read before anything is written. */
  async function admissible(ctx: Ctx, req: ServiceServeRequest, b: Bound, id: string): Promise<ServiceServeResult | undefined> {
    if (req.operation === "register") {
      const k = await keyHistory(ctx, req, b, id);
      if (k !== undefined) return k;
    }
    ctx.step = "S-state";
    if (b.row.cancel !== null) return deniedServe("approval-revoked");
    const g = await servedGate(ctx, b);
    if (g.kind === "revoked") return deniedServe("approval-revoked");
    const a = g.row.serviceAuthority, current = stampWitness(ctx, b.binding, g.row);
    if (req.operation === "register") {
      if (a.activationIssued) return deniedServe("registration-active");
      const p = await readProposal(ctx, b.row.proposalId);
      if (p.state !== "value" || p.row.kind !== "service-proposal-terminal" || p.row.state !== "approved" || p.row.approvalDigest !== a.approvalDigest)
        return held("registration-inconsistent", ctx.step, "the assignment's approved proposal is not readable");
      const r = req.register!;
      if (proposalBodyDigest({ owner: b.binding.owner, endpoint: b.binding.endpoint, instanceId: b.binding.instanceId }, r.clusterDigests, r.commands) !== p.row.proposalDigest)
        return deniedServe("approval-mismatch");
      const expected = req.witness === null ? undefined : serviceWitnessDigest(req.witness);
      if ((current === undefined) !== (expected === undefined) || (current !== undefined && serviceWitnessDigest(current) !== expected)) return deniedServe("conflict");
      return undefined;
    }
    if (current === undefined || serviceWitnessDigest(current) !== serviceWitnessDigest(req.witness!)) return deniedServe("stale-witness");
    return undefined;
  }
  /** Append the request to its instance's index, or find it listed. */
  async function listIntent(ctx: Ctx, b: Bound, id: string, operation: ServiceServeOperation): Promise<ServiceServeResult | undefined> {
    ctx.step = "S-index";
    const { owner: o, endpoint: e, instanceId: i } = b.binding;
    for (let n = 0; n < S2A_MAX_REDECIDE; n++) {
      const cur = await readIntentIndex(ctx, e, i);
      if (cur.state === "value") {
        if (cur.row.owner !== o || cur.row.endpoint !== e || cur.row.instanceId !== i)
          return held("intent-index-inconsistent", ctx.step, "the intent index names another assignment");
        if (cur.row.intents.some((x) => x.operationId === id)) return undefined;
        if (cur.row.intents.length >= S3_MAX_INTENTS_PER_INSTANCE) return deniedServe("resource-exhausted");
      }
      const intents = [...(cur.state === "value" ? cur.row.intents : []), { operationId: id, operation }]
        .sort((x, y) => (x.operationId < y.operationId ? -1 : 1));
      const row: IntentIndex = { v: 1, kind: "service-request-intent-index", owner: o, endpoint: e, instanceId: i, intents };
      if ((await put(ctx, intentIndexKey(e, i), row, parseServiceRequestIntentIndexRecord, cur.state === "value" ? cur : undefined)) !== "moved") return undefined;
    }
    return held("contention", ctx.step);
  }

  async function serve(req: ServiceServeRequest): Promise<ServiceServeResult> {
    if (tripped !== undefined || closed) return { state: "unavailable", detail: "the service host is fenced or closing" };
    const { owner: o, endpoint: e, instanceId: i } = req;
    if (req.caller === "owner" && !interactive(o)) return deniedServe("permission-denied");
    const id = serviceHostOperationId(space, req.engineRequestId);
    let b: Binding;
    try { b = await bindingOf(discoveryCtx("S-binding"), o, e, i); }
    catch (err) { if (err instanceof Held) return { state: "unavailable", detail: `the assignment is not readable (${err.reason})` }; throw err; }
    if (b.state === "absent") return deniedServe("permission-denied");
    if (b.state === "fenced") return deniedServe("approval-revoked");
    if (req.witness !== null && !namesBinding(req.witness, b.binding)) return deniedServe("permission-denied");
    const intent: Intent = { v: 1, kind: "service-request-intent", operationId: id, operation: req.operation, account: { accountPublicKey, space },
      owner: o, endpoint: e, instanceId: i, requestId: req.requestId, requestDigest: req.requestDigest,
      registrationRequestId: req.witness?.registrationRequestId ?? null, witnessDigest: req.witness === null ? null : serviceWitnessDigest(req.witness),
      admittedAtMs: Date.now() };
    const contract = req.register?.artifacts.map((a) => contractDigest(a).slice("sha256:".length)) ?? [];
    const bound = b;
    try {
      return await invoke({ operation: "serve", serve: req.operation, operationId: id, proposalId: null, owner: o, endpoint: e, instanceId: i,
        lifecycleUid: b.binding.lifecycleUid, contract }, async (inv) => {
        const ctx = readCtx(inv, "S-intent");
        const found = await readIntent(ctx, id);
        if (found.state === "value") { if (!sameIntent(found.row, intent)) return deniedServe("conflict"); }
        else {
          const refusal = (await admissible(ctx, req, bound, id)) ?? (await listIntent(ctx, bound, id, req.operation));
          if (refusal !== undefined) return refusal;
          ctx.step = "S-intent-create";
          if ((await put(ctx, intentKey(id), intent, parseServiceRequestIntentRecord)) === "moved") {
            const again = await readIntent(ctx, id);
            if (again.state !== "value") return held("unknown", ctx.step, "the intent create lost but no intent is readable");
            if (!sameIntent(again.row, intent)) return deniedServe("conflict");
          }
        }
        switch (req.operation) {
          case "register": return registerEffect(ctx, inv, req, bound, id);
          case "activate": case "renew": return credentialEffect(ctx, inv, req, bound);
          case "ready": return readyEffect(ctx, inv, req, bound);
        }
      });
    } catch (err) {
      if (err instanceof Held) return { state: "unavailable", detail: `${req.operation} held (${err.reason} at ${err.step})` };
      throw err;
    }
  }

  /** Same-request recovery first, from the stamp alone; otherwise publish, barrier, spec and stamp. */
  async function registerEffect(ctx: Ctx, inv: Inv, req: ServiceServeRequest, b: Bound, id: string): Promise<ServiceServeResult> {
    ctx.step = "R-gate";
    const r = req.register!;
    const stampedHere = (row: EndpointRow) => {
      const stamp = row.serviceAuthority.registration;
      return stamp?.requestId === req.requestId && stamp.requestDigest === req.requestDigest;
    };
    const frozenHere = (row: EndpointRow) => {
      const pending = row.serviceAuthority.pendingRegistration;
      return row.state === "frozen" && pending?.operationId === id && pending.requestId === req.requestId && pending.requestDigest === req.requestDigest;
    };
    const recovered = async (g: Awaited<ReturnType<typeof servedGate>>) => {
      if (!stampedHere(g.row)) return undefined;
      const witness = stampWitness(ctx, b.binding, g.row)!;
      return { state: "registered" as const, witness, snapshot: await snapshotOf(ctx, witness, r.artifacts) };
    };
    // Revocation answers first, as status does; then a completed same request recovers from its
    // stamp before any expected or activation check, with no barrier and no epoch advance.
    const g = await servedGate(ctx, b);
    if (g.kind === "revoked" || b.row.cancel !== null) return deniedServe("approval-revoked");
    const done = await recovered(g);
    if (done !== undefined) return done;
    const a = g.row.serviceAuthority;
    if (a.activationIssued) return deniedServe("registration-active");
    const resuming = frozenHere(g.row);
    const expected = req.witness === null ? undefined : serviceWitnessDigest(req.witness);
    const expectationHolds = (row: EndpointRow) => {
      const current = stampWitness(ctx, b.binding, row);
      return current === undefined ? expected === undefined : serviceWitnessDigest(current) === expected;
    };
    if (!resuming) {
      if (g.row.state !== "open") return deniedServe("registration-pending");
      if (!expectationHolds(g.row)) return deniedServe("conflict");
      if (!serviceGateApprovalLive(a, seconds(Date.now()))) return deniedServe("expired");
    }
    if (inv.contract === undefined) return held("unavailable", ctx.step, "the effect connection has no contract store");
    ctx.step = "R-publish";
    for (const artifact of r.artifacts) {
      await readyBefore(ctx);
      const p = await bounded(ctx, () => publishContractArtifact(inv.contract!, contractArtifactCanonicalBytes(artifact)));
      if (!p.ok) return held("unknown", ctx.step, "timedOut" in p ? "a contract artifact publish timed out" : message(p.error));
    }
    ctx.step = "R-register";
    const stores = registryStores(inv.h.registry), artifacts = new Map(r.artifacts.map((v) => [contractDigest(v), v] as const));
    // A service family is empty before activation, so the barrier keeps no repair cursor.
    const { progress: _progress, ...observed } = endpointRegistrationBarrier(stores.authKv, space,
      { endpoint: b.binding.endpoint, instanceId: b.binding.instanceId, opId: id, serviceRegistration: { requestId: req.requestId, requestDigest: req.requestDigest } });
    void _progress;
    // The barrier freezes the gate revision it observes after the publishes above, whenever it does
    // not find the gate frozen by this operation: also for a request that read it frozen and finds
    // it reopened. The checks above ran on an earlier read, so they are made again on exactly the
    // revision being frozen, and nothing is frozen or written unless they hold. A stamp that already
    // names this request was completed by another invocation of it and answers as a replay does; a
    // freeze of this operation with no stamp yet is that invocation still running, so this one holds.
    let decided: "approval-revoked" | "stamped" | "running" | "conflict" | undefined;
    const barrier = { ...observed, freeze: async (revision: number) => {
      const now = await servedGate(ctx, b);
      if (now.kind === "revoked") decided = "approval-revoked";
      else if (stampedHere(now.row)) decided = "stamped";
      else if (frozenHere(now.row)) decided = "running";
      else if (now.revision !== revision || now.row.state !== "open" || !expectationHolds(now.row)) decided = "conflict";
      return decided === undefined ? await observed.freeze(revision) : null;
    } };
    await readyBefore(ctx);
    try {
      await native(ctx, () => registerServiceInstance(stores.recordsKv, { space, instanceId: b.binding.instanceId, registrant: { owner: b.binding.owner },
        spec: { endpoint: b.binding.endpoint, owner: b.binding.owner, clusterDigests: [...r.clusterDigests], protocol: { v: 1 } },
        authority: nativeServiceNameAuthority(inv.h.registry, { space, accountPublicKey }), barrier, readClusterArtifact: (d) => artifacts.get(d) }));
    } catch (err) {
      if (decided === undefined || !(err instanceof Held)) throw err;
      if (decided === "running") return held("unknown", ctx.step, "another invocation of this request froze the gate and has not completed");
      if (decided !== "stamped") return deniedServe(decided);
      ctx.step = "R-confirm";
      const now = await servedGate(ctx, b);
      if (now.kind === "revoked") return deniedServe("approval-revoked");
      return (await recovered(now)) ?? held("unknown", ctx.step, "this request's registration was replaced while it was confirmed");
    }
    await readyAfter(ctx);
    ctx.step = "R-confirm";
    const after = await recovered(await servedGate(ctx, b));
    return after ?? held("unknown", ctx.step, "the registration completed but its stamp does not name this request");
  }

  /** activate: the monotonic activation CAS at the current witness; renew: the same checks with no
   *  write. Either returns the bounds fresh material must keep; no material is minted here. */
  async function credentialEffect(ctx: Ctx, inv: Inv, req: ServiceServeRequest, b: Bound): Promise<ServiceServeResult> {
    for (let n = 0; n < S2A_MAX_REDECIDE; n++) {
      ctx.step = req.operation === "activate" ? "A-gate" : "W-gate";
      const g = await servedGate(ctx, b);
      if (g.kind === "revoked" || b.row.cancel !== null) return deniedServe("approval-revoked");
      const a = g.row.serviceAuthority, current = stampWitness(ctx, b.binding, g.row);
      if (current === undefined || serviceWitnessDigest(current) !== serviceWitnessDigest(req.witness!)) return deniedServe("stale-witness");
      if (g.row.state !== "open") return deniedServe("registration-pending");
      if (!serviceGateApprovalLive(a, seconds(Date.now()))) return deniedServe("expired");
      const root = await rootExpiresAt(ctx, inv, b.binding, current.rootCredentialId);
      if (typeof root !== "number") return root;
      if (!a.activationIssued) {
        if (req.operation === "renew") return deniedServe("stale-witness");
        ctx.step = "A-activate";
        const next = await grammarHeld(ctx, () => activatedServiceGateRow(g.row, b.binding, current, Date.now()));
        if (next !== undefined) {
          const bytes = enc.encode(JSON.stringify(next));
          await grammarHeld(ctx, () => b.epgate.parse(bytes));
          if ((await write(ctx, "auth", b.epgate.key, bytes, { revision: g.revision, preimage: g.bytes })) === "moved") continue;
        }
      }
      return { state: "current", witness: current, snapshot: await snapshotOf(ctx, current), rootExpiresAt: root, approvalExpiresAt: a.approvalExpiresAt };
    }
    return held("contention", ctx.step);
  }

  /** ready: the service-reported status at the current activated witness, fenced on its epoch. */
  async function readyEffect(ctx: Ctx, inv: Inv, req: ServiceServeRequest, b: Bound): Promise<ServiceServeResult> {
    ctx.step = "Y-gate";
    const g = await servedGate(ctx, b);
    if (g.kind === "revoked" || b.row.cancel !== null) return deniedServe("approval-revoked");
    const a = g.row.serviceAuthority, current = stampWitness(ctx, b.binding, g.row);
    if (current === undefined || serviceWitnessDigest(current) !== serviceWitnessDigest(req.witness!) || !a.activationIssued) return deniedServe("stale-witness");
    if (g.row.state !== "open") return deniedServe("registration-pending");
    if (!serviceGateApprovalLive(a, seconds(Date.now()))) return deniedServe("expired");
    const root = await rootExpiresAt(ctx, inv, b.binding, current.rootCredentialId);
    if (typeof root !== "number") return root;
    const name = await nameOf(ctx, b.binding.endpoint);
    if (name === undefined || name.owner !== b.binding.owner || name.revision !== current.nameAuthorityRevision) return deniedServe("stale-witness");
    ctx.step = "Y-status";
    const at = seconds(Date.now()), stores = registryStores(inv.h.registry);
    await readyBefore(ctx);
    await native(ctx, () => writeServiceStatus(stores.recordsKv, { endpoint: b.binding.endpoint, instanceId: b.binding.instanceId, epoch: current.processEpoch,
      status: { epoch: current.processEpoch, state: "ready", observedSpecRevision: current.registrationRevision, reportedAt: at },
      readProcessEpoch: async () => {
        const now = await servedGate(ctx, b);
        if (now.row.state !== "open" || stampWitness(ctx, b.binding, now.row)?.registrationRequestId !== current.registrationRequestId)
          throw new EpEnvelopeError("conflict", "the registration changed before the ready status was written");
        return now.row.processEpoch;
      } }));
    await readyAfter(ctx);
    return { state: "ready", witness: current, reportedAt: at };
  }

  // ---- serving status (SPEC 13.1 precedence) ------------------------------------------------------

  async function serveStatus(q: ServiceStatusQuery): Promise<ServiceStatusAnswer> {
    if (tripped !== undefined || closed) return { kind: "unavailable", detail: "the service host is fenced or closing" };
    // An owner reads only while it holds an interactive row, as for every owner request; a service
    // reads only its own selector. Both are refused before any read.
    if (q.reader.kind === "owner" && !interactive(q.owner)) return { kind: "denied", reason: "permission-denied" };
    if (q.reader.kind === "service" && !namesSelector(q.reader.witness, q)) return { kind: "not-found" };
    try { return await statusOf(discoveryCtx("T-read"), q); }
    catch (err) { if (err instanceof Held) return { kind: "unavailable", detail: `status held (${err.reason} at ${err.step})` }; throw err; }
  }
  async function statusOf(ctx: Ctx, q: ServiceStatusQuery): Promise<ServiceStatusAnswer> {
    const status = (s: ServiceAuthorityStatus): ServiceStatusAnswer => ({ kind: "status", status: s });
    const unavailable = (detail: string): ServiceStatusAnswer => ({ kind: "unavailable", detail });
    const readerDigest = q.reader.kind === "service" ? serviceWitnessDigest(q.reader.witness) : null;
    let intent: Intent | undefined;
    if (q.target.kind === "operation") {
      const id = serviceHostOperationId(space, q.target.engineRequestId);
      const found = await readIntent(ctx, id);
      if (found.state === "absent") {
        const idx = await readIntentIndex(ctx, q.endpoint, q.instanceId);
        if (idx.state === "value" && idx.row.owner === q.owner && idx.row.intents.some((x) => x.operationId === id))
          return unavailable("the request is listed without its intent; replay it");
        return q.target.operation === "register" && readerDigest === null ? { kind: "proposal-phase" } : { kind: "not-found" };
      }
      intent = found.row;
      if (intent.owner !== q.owner || (readerDigest !== null && intent.witnessDigest !== readerDigest)) return { kind: "not-found" };
    }
    const b = await bindingOf(ctx, q.owner, q.endpoint, q.instanceId);
    if (b.state === "absent") return intent === undefined ? { kind: "not-found" } : unavailable("the intent's assignment is not readable");
    // A service reader's own incarnation before any precedence rule. A fenced assignment keeps no
    // lifecycle, so only the selector check above applies to it.
    if (b.state === "bound" && q.reader.kind === "service" && !namesBinding(q.reader.witness, b.binding)) return { kind: "not-found" };
    // Rule 3: cancellation and revocation first.
    if (b.state === "fenced") return status({ state: "revoking", operationId: b.row.cancel.operationId, phase: "deny-new-landed" });
    const g = await endpoint(ctx, b);
    if (b.row.cancel !== null) return status({ state: "revoking", operationId: b.row.cancel.operationId, phase: g.kind === "revoked" ? "deny-new-landed" : "deny-new-pending" });
    if (g.kind === "revoked" || g.kind === "foreign") return unavailable(`the endpoint gate is ${g.kind} without a bound cancel`);
    if (g.kind === "absent" || g.kind === "pending") {
      if (intent !== undefined) return unavailable("the intent's approval is not readable");
      return status({ state: "registering", operationId: b.row.creation.operationId, phase: "approving" });
    }
    const a = g.row.serviceAuthority, stamp = a.registration, pending = a.pendingRegistration;
    const current = stampWitness(ctx, b.binding, g.row);
    const live = async (w: ServiceRegistrationWitness): Promise<ServiceStatusAnswer> => {
      const snapshot = await snapshotOf(ctx, w), at = await reportedAt(ctx, w);
      return status(at === undefined ? { state: "registered", witness: w, snapshot } : { state: "ready", witness: w, snapshot, reportedAt: at });
    };
    if (intent === undefined) {
      // The instance: the reader's own incarnation, or the owner's current state.
      if (q.reader.kind === "service") {
        if (stamp === undefined) return unavailable("the reader's registration has no stamp");
        if (stamp.requestId !== q.reader.witness.registrationRequestId)
          return status({ state: "superseded", registrationRequestId: q.reader.witness.registrationRequestId, currentRegistrationRequestId: stamp.requestId });
      }
      if (g.row.state === "frozen") return pending ? status({ state: "registering", operationId: pending.operationId, phase: "barrier" }) : unavailable("the gate is frozen without a pending registration");
      if (current === undefined) return status({ state: "approved-unregistered", approvalDigest: a.approvalDigest! });
      if (readerDigest !== null && serviceWitnessDigest(current) !== readerDigest) return unavailable("the reader's witness disagrees with the current stamp");
      return live(current);
    }
    if (intent.operation === "register") {
      // Rule 5: the permanent answers before the transient ones.
      if (stamp?.requestId === intent.requestId && stamp.requestDigest === intent.requestDigest) return live(current!);
      if (stamp !== undefined && (stamp.requestId !== intent.registrationRequestId || a.activationIssued))
        return status({ state: "superseded", registrationRequestId: intent.requestId, currentRegistrationRequestId: stamp.requestId });
      if (pending?.requestId === intent.requestId && pending.requestDigest === intent.requestDigest)
        return status({ state: "registering", operationId: intent.operationId, phase: "barrier" });
      if ((stamp === undefined && intent.registrationRequestId === null) || (stamp?.requestId === intent.registrationRequestId && !a.activationIssued))
        return status({ state: "registering", operationId: intent.operationId, phase: "admitted" });
      return unavailable("the register intent matches no registration state");
    }
    // Rule 6: activate, renew and ready name a registration.
    if (stamp === undefined) return unavailable("the intent's registration has no stamp");
    if (stamp.requestId !== intent.registrationRequestId)
      return status({ state: "superseded", registrationRequestId: intent.registrationRequestId!, currentRegistrationRequestId: stamp.requestId });
    if (g.row.state === "frozen") return pending ? status({ state: "registering", operationId: pending.operationId, phase: "barrier" }) : unavailable("the gate is frozen without a pending registration");
    if (current !== undefined && serviceWitnessDigest(current) === intent.witnessDigest) return live(current);
    return unavailable("the intent's witness disagrees with the current stamp");
  }

  /** The callout's assignment: the current bound assignment the witness names, never a guess. */
  async function serviceBinding(w: ServiceRegistrationWitness): Promise<ServiceAssignmentBinding> {
    if (tripped !== undefined || closed) throw new EpEnvelopeError("unavailable", "the service host is fenced or closing");
    const b = await bindingOf(discoveryCtx("C-binding"), w.principal.owner, w.endpoint, w.instanceId);
    if (b.state !== "bound" || b.row.cancel !== null || !namesBinding(w, b.binding))
      throw new EpEnvelopeError("permission-denied", "the service witness names no current bound assignment");
    return { ...b.binding };
  }

  // ---- one owner's assignment state (read only) ---------------------------------------------------

  async function serviceState(o: string, e: string, i: string): Promise<ServiceAssignmentState> {
    if (tripped !== undefined || closed) return { state: "unavailable" };
    try {
      const ctx = discoveryCtx("state-read");
      const asg = await readAssignment(ctx, e, i);
      if (asg.state === "absent" || asg.row.owner !== o) return { state: "absent" };
      const a = asg.row, ids = { proposalId: a.proposalId, assignmentDigest: a.assignmentDigest };
      if (a.state === "fenced") return { state: "revoking", ...ids, operationId: a.cancel.operationId, denyNew: "landed" };
      const gate = await endpoint(ctx, serviceAssignmentGate(discovery.host, a.reservation));
      if (a.cancel !== null) return { state: "revoking", ...ids, operationId: a.cancel.operationId, denyNew: denyNewOf(gate) };
      const approvalDigest = gate.kind === "approved" ? gate.row.serviceAuthority.approvalDigest : null;
      if (approvalDigest !== null && gate.kind === "approved")
        return { state: "approved", ...ids, approvalDigest, registrationRequestId: gate.row.serviceAuthority.registration?.requestId ?? null };
      if (gate.kind === "absent" || gate.kind === "pending") return { state: "pending-root", ...ids };
      // A revoked gate without a bound cancel identity, an approved gate without its digest, or another assignment's row.
      return { state: "unavailable" };
    } catch (err) { if (err instanceof Held || err instanceof EpEnvelopeError) return { state: "unavailable" }; throw err; }
  }

  // ---- dispatch -----------------------------------------------------------------------------------

  async function handle(raw: unknown): Promise<ServiceHostResult> {
    const req = parseServiceHostRequest(raw);
    const env = { v: 1 as const, kind: "service-endpoint-host" as const, operation: req.operation, requestId: req.requestId, space, accountPublicKey };
    const out = (r: object) => ({ ...env, ...r }) as ServiceHostResult;
    // The latch comes before the ledger and every broker read. A request that could bind holds under its
    // operation coordinate, with no deny-new claim because no gate was read; a read never binds.
    const binds = req.operation === "decide" || req.operation === "revoke" || req.operation === "name-bind" || req.operation === "caller-grant" || req.operation === "caller-revoke";
    if (tripped !== undefined || closed) return out(binds ? unread(req.requestId, "readiness", "open", req.operation === "revoke" ? req.input.expectedAssignmentDigest : undefined) : denied("unavailable"));
    const authorized = req.granter.kind === "operator" || interactive(req.granter.owner);
    switch (req.operation) {
      case "decide": return out(await decide(req, authorized));
      case "revoke": return out(await revoke(req, authorized));
      case "name-bind": return out(await nameBind(req));
      case "operation-read": return out(authorized ? await operationRead(req) : denied("permission-denied"));
      case "proposal-read": return out(authorized ? await proposalRead(req) : denied("permission-denied"));
      case "name-read": return out(authorized ? await nameRead(req) : denied("permission-denied"));
      case "instance-read": return out(authorized ? await instanceRead(req) : denied("permission-denied"));
      case "instance-list": return out(authorized ? await instanceList(req) : denied("permission-denied"));
      case "caller-grant": return out(await callerGrant(req, authorized));
      case "caller-revoke": return out(await callerRevoke(req, authorized));
      case "caller-policy-read": return out(authorized ? await callerPolicyRead(req) : denied("permission-denied"));
      case "caller-policy-list": return out(authorized ? await callerPolicyList(req) : denied("permission-denied"));
      default: return out(denied("unsupported"));
    }
  }

  return Object.freeze({
    space, accountPublicKey,
    register: (raw: unknown) => tracked(register(raw)),
    handle: (raw: unknown) => tracked(handle(raw)),
    serviceState: (owner: string, endpoint: string, instanceId: string) => tracked(serviceState(owner, endpoint, instanceId)),
    serve: (request: ServiceServeRequest) => tracked(serve(request)),
    serveStatus: (query: ServiceStatusQuery) => tracked(serveStatus(query)),
    serviceBinding: (witness: ServiceRegistrationWitness) => tracked(serviceBinding(witness)),
    refuse() { closed = true; },
    async close() {
      closed = true;
      while (entered.size > 0) await Promise.allSettled([...entered]);
    },
    trip(reason: string) {
      if (tripped === undefined) tripped = reason;
      discovery.trip(tripped);
      for (const t of live) t(tripped);
    },
  });
}
