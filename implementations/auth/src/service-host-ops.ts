/** Package-internal service host operations: register admission, decide (approve or refuse),
 * revoke, create-only name binding, caller grants and caller revocation up to deny-new and its
 * cutoff marker, the operation, proposal and caller-policy reads and one owner's assignment state,
 * over closed per-key records in the auth bucket. The index does not export it; only the
 * owner-proved public authority door calls register. It grants no serving, registration, issuance
 * from caller policy, terminal caller revocation, restore or terminal retirement; on a bound
 * revoke after deny-new lands, it drives verified-gone principal eviction through `evictPrincipal`
 * when configured.
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
import { EpEnvelopeError, GOVERN_HEAD, RECORD_KINDS, assertLifecycleToken, canonicalJson, contractArtifactCanonicalBytes, epAuthBucket, contractDigest, contractStoreContext, endpointRegistrationBarrier, epgateKey, publishContractArtifact, recordAtomicKey, recordSpecKey, recordStatusKey, registerServiceInstance, serviceEndpointActor, serviceGateApprovalLive, serviceWitnessDigest, writeServiceStatus, type ContractStoreContext, type EvictionResult, type ServiceAuthorityStatus, type ServiceGateAuthority, type ServiceRegistrationSnapshot, type ServiceRegistrationWitness, type ServiceUidCustodyV1 } from "@cotal-ai/core";
import { openAuthorityClient, serviceHostEffectGrants, serviceHostEffectLabel, type ServiceHostEffectReads } from "./authority-client.js";
import { findInteractiveActor } from "./ledger.js";
import { openLifecycleRegistry, registryStores, type LifecycleRegistry } from "./lifecycle-registry.js";
import { activatedServiceGateRow, serviceGateRows, type ServiceAssignmentBinding, type ServiceGateRows } from "./native-service-gate.js";
import { nativeServiceNameAuthority, serviceNameKey, serviceNameRowBytes } from "./native-service-name.js";
import { type PlaneClaimHold } from "./plane-claim.js";
import { SERVICE_CALLER_PAYLOAD_KEY } from "./service-caller-payload.js";
import { servicePolicyKey } from "./service-caller-policy.js";
import { serviceAssignmentGate, serviceCustodyKeys, serviceReservationKeys } from "./service-custody.js";
import { parseServiceHostRequest, parseServiceProposalClusters, parseServiceProposalCommands, type ServiceApprovalResult, type ServiceDenyNew, type ServiceHostDebt, type ServiceHostOutcome, type ServiceHostReason, type ServiceHostRequest, type ServiceHostResult, type ServiceNameView, type ServiceOperationRefusal, type ServiceOperationTerminalView, type ServiceOperationView, type ServiceInstanceView, type ServiceProposalTombstoneView, type ServiceProposalView } from "./service-host-contract.js";
import { HOSTS, Held, bounded, context, endpoint, held, message, openServiceCustodyHost, readyAfter, readyBefore, scopeCovers, write, type Ctx, type EndpointRow, type ServiceWriteScope } from "./service-write.js";
import type { ServiceKeys } from "./store.js";
import { bad, closed, hexN, digest, pick, owner, endpointName, token, parseServiceHostOperationRecord, parseServiceProposalRecord, parseServiceAssignmentRecord, parseServiceRequestIntentRecord, parseServiceRequestIntentIndexRecord, parseServiceAdmissionRecord, enc, requestDigestOf, S2A_MAX_PENDING, S2A_MAX_PENDING_PER_OWNER, S3_MAX_INTENTS_PER_INSTANCE, type Rec, type RegisterPlan, type RegisterResult, type Final, type OpLive, type Op, type Command, type ProposalLive, type ProposalTerminal, type Proposal, type CapEntry, type Capacity, type Assignment, type Admission, type ServiceServeOperation, type Intent, type IntentIndex } from "./service-host-records.js";
export { S3_MAX_INTENTS_PER_INSTANCE, parseServiceHostOperationRecord, parseServiceProposalRecord, parseServiceCapacityRecord, parseServiceAssignmentRecord, parseServiceRequestIntentRecord, parseServiceRequestIntentIndexRecord, parseServiceAdmissionRecord, serviceMarkerCeilSeconds } from "./service-host-records.js";
export type { ServiceServeOperation } from "./service-host-records.js";
import { S2A_OPERATION_TTL_MS, S2A_INVOCATION_MS, S2A_PROPOSAL_LIFETIME_MS, S2A_MAX_PROPOSAL_BYTES, S2A_MAX_REDECIDE, ADMISSION_KEY, CAPACITY_KEY, opKey, proposalKey, assignmentKey, intentKey, intentIndexKey, callerIndexKey, cutoffKey, seconds, serviceHostOperationId, proposalIdOf, type Read, read, readOp, readProposal, readCapacity, readAssignment, readAdmission, readIntent, readIntentIndex, put, putCapacity, isEntry, eligible, nameOf, release, settle, outcomeOf, debtOf, retryDebt, type Arms, type Inv, denied, finalArm, badRequest } from "./service-host-kernel.js";
import { serviceHostDecisions } from "./service-host-decisions.js";
import { serviceHostCaller } from "./service-host-caller.js";
import { serviceHostServing, type Binding, type Bound } from "./service-host-serving.js";

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

function servingApprovalLive(authority: ServiceGateAuthority, now: number, instanceId: string): boolean {
  if (serviceGateApprovalLive(authority, now)) return true;
  const { rootExpiresAt, approvalExpiresAt } = authority;
  const at = (expiry: number) => {
    const utc = new Date(expiry * 1000).toJSON();
    return utc === null ? "" : ` at ${utc} (UTC)`;
  };
  if (authority.state === "approved" && rootExpiresAt !== null) {
    if (approvalExpiresAt !== null && approvalExpiresAt <= now)
      console.error(`Service instance ${instanceId}: The approval expired${at(approvalExpiresAt)}.`);
    if (rootExpiresAt <= now)
      console.error(`Service instance ${instanceId}: The root credential expired${at(rootExpiresAt)}. Restarting this instance does not replace its root. Ask whoever runs the integration whether it can register a replacement.`);
  }
  return false;
}
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
  /** Verified-gone connection eviction for a revoked assignment's serving principal; when omitted,
   *  `revoke` skips V5 eviction and confirms `cancelled-nonterminal` from deny-new alone, leaving
   *  an open serving connection up to its 60 s credential expiry. `openAuthAuthorityPlane` and
   *  `startAuthService` always supply `makeDeliveryAdminEvictor`. */
  evictPrincipal?: (principal: string) => Promise<EvictionResult>;
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

  const { decide, revoke, denyNewOf, view } = serviceHostDecisions({ space, accountPublicKey, invoke, readCtx, heldArm, unread, discoveryCtx, discoveryHeld, authorityCtx, coverCustody, evictPrincipal: opts.evictPrincipal });

  const { deniedServe, bindingOf, namesBinding, namesSelector, stampWitness, grammarHeld, snapshotOf, reportedAt, rootExpiresAt, native, servedGate, sameIntent } = serviceHostServing({ space, accountPublicKey, discovery, opts });

  const { callerGrant, callerRevoke, callerPolicyRead, callerPolicyList } = serviceHostCaller({ space, accountPublicKey, opts, invoke, readCtx, heldArm, unread, discoveryCtx, discoveryHeld, authorityCtx });

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
      if (!servingApprovalLive(a, seconds(Date.now()), b.binding.instanceId)) return deniedServe("expired");
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
      if (!servingApprovalLive(a, seconds(Date.now()), b.binding.instanceId)) return deniedServe("expired");
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
    if (!servingApprovalLive(a, seconds(Date.now()), b.binding.instanceId)) return deniedServe("expired");
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
