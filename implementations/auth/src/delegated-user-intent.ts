/**
 * Host policy for a delegated user intent (SPEC 13.16): a signed-in user admits one launch or one
 * retirement, and the platform control holder executes it while the intent and the agent stay the
 * user's.
 *
 * Both decisions write nothing and mint nothing. The host that owns the intent store persists the
 * admission record, consumes it with one revision-pinned CAS, and runs the enrollment and retirement
 * writers it already runs for a user's own remote manager, with the decision's owner and parent.
 * The holder's registration proves only which instance and epoch present the intent: no decision
 * reads, requires or returns `supervise`.
 */
import {
  DELEGATED_USER_INTENT_MAX_TTL_SECONDS,
  EpEnvelopeError,
  assertDerivedOwnerToken,
  managedRetirementOpId,
  mintLifecycleUid,
  parseDelegatedUserIntentRequest,
  parseRemoteDelegatedUserIntentExecutionRequest,
  remoteManagerActors,
  type DelegatedUserIntentAdmission,
  type DelegatedUserIntentRequest,
  type DelegatedUserLaunchTarget,
  type PlatformControlAssignment,
  type RemoteDelegatedUserIntentExecutionRequest,
  type RemoteDelegatedUserIntentExecutionResult,
  type RemoteManagedAgentPrepareRetirementRequest,
} from "@cotal-ai/core";
import { timingSafeEqual } from "node:crypto";
import { assertWithinSpawnerGrant, ledgerAuthorizeGrant } from "./ledger.js";
import type { ObserveManagerGate } from "./managed-agent-enrollment.js";
import type { PlatformControlDeps } from "./platform-control.js";
import { remoteManagerCurrentRegistrationProof } from "./retained-manager-validation.js";

/** The host's record of one admitted intent. The host is its only writer: create-only at admission,
 * then one revision-pinned CAS from `admitted` to `consumed` that writes `execution` before any
 * effect, then revision-pinned CASes only: a sweeper's claim, the one write that sets `outcome`,
 * and the executor's `released`. */
export interface DelegatedUserIntentRecord extends Omit<DelegatedUserIntentAdmission, "v" | "kind" | "requestId"> {
  v: 1;
  /** `<owner>.<actor>`: the launched agent's ledger parent, and the principal the envelope walk starts from. */
  parent: string;
  state: "admitted" | "consumed";
  /** Written by the consuming CAS and never changed after. Absent while `admitted`. */
  execution?: DelegatedUserIntentExecutionPin;
  /** The host incarnation that claimed the execution for its executor because it believes that
   * executor gone. Absent until a sweeper claims; a later sweeper may replace it. */
  sweptBy?: DelegatedUserIntentIncarnation;
  /** Set once, when the pinned execution ends. Absent while it runs or while the host recovers it. */
  outcome?: "enrolled" | "retired" | "aborted";
  /** Set once, only by the executor's own flight, after a sweeper's claim: the flight has stopped
   * and revoked any grant at the pinned UID. Absent on every other record. */
  released?: true;
}

/** One run of one host process, as SPEC §13.7 names an executor. An instance id without its process
 * epoch names a process, never the run of it that holds a flight. */
export interface DelegatedUserIntentIncarnation {
  instanceId: string;
  /** The process epoch (§13.1) of the host's own serving instance, advanced by every restart. */
  processEpoch: number;
}

/** What the consuming CAS fixes before any effect, so that a retry, a lost answer or a host restart
 * resumes the same execution at the same lifecycle. */
export interface DelegatedUserIntentExecutionPin {
  /** The holder request that consumed the record. Null when the host consumed a holder-gone retirement itself. */
  requestId: string | null;
  serveEpoch: number | null;
  /** Launch: selected by the host before the CAS, and the only UID its writer enrolls. Retire: the target's. */
  lifecycleUid: string;
  /** Launch only: the holder's token digest. */
  tokenHash?: string;
  /** Retire only: managedRetirementOpId(lifecycleUid). */
  opId?: string;
  /** The host incarnation whose flight consumed the record: the execution's only executor. */
  executor: DelegatedUserIntentIncarnation;
}

/** True while `record` holds the alias `(record.owner, record.intent.target.actor)`: consumed with
 * no `outcome`, or claimed by a sweeper (`sweptBy`) and not yet `released`. */
export function delegatedUserIntentHoldsAlias(record: DelegatedUserIntentRecord): boolean {
  return (record.state === "consumed" && record.outcome === undefined) || (record.sweptBy !== undefined && record.released !== true);
}

/** In-process executions keyed by intentId, each bound to its pin, as RetirementFlights binds a
 * retirement to its coordinates. A host process holds at most one flight per intent. */
export type DelegatedUserIntentFlights = Map<string, {
  pin: DelegatedUserIntentExecutionPin;
  promise: Promise<RemoteDelegatedUserIntentExecutionResult>;
}>;

function samePin(a: DelegatedUserIntentExecutionPin, b: DelegatedUserIntentExecutionPin): boolean {
  return a.requestId === b.requestId && a.serveEpoch === b.serveEpoch && a.lifecycleUid === b.lifecycleUid &&
    a.tokenHash === b.tokenHash && a.opId === b.opId &&
    a.executor.instanceId === b.executor.instanceId && a.executor.processEpoch === b.executor.processEpoch;
}

/** Join the flight for `intentId`, or start `run` and register it. Returns undefined when that
 * intent is in flight under a different pin: the caller refuses with `conflict` and starts nothing. */
export function joinOrStartDelegatedUserIntent(
  flights: DelegatedUserIntentFlights,
  intentId: string,
  pin: DelegatedUserIntentExecutionPin,
  run: () => Promise<RemoteDelegatedUserIntentExecutionResult>,
): Promise<RemoteDelegatedUserIntentExecutionResult> | undefined {
  const existing = flights.get(intentId);
  if (existing !== undefined) return samePin(existing.pin, pin) ? existing.promise : undefined;
  const flight = run();
  void flight.catch(() => {}).finally(() => { if (flights.get(intentId)?.promise === flight) flights.delete(intentId); });
  flights.set(intentId, { pin, promise: flight });
  return flight;
}

/** The platform control door's assignment observer as it shipped, unchanged. It is keyed by account,
 * which has at most one current row, and both decisions require that row to name the intent's instance. */
export type ObservePlatformControlAssignment = PlatformControlDeps["observeAssignment"];

export interface AuthorizeDelegatedUserIntentAdmissionArgs {
  request: DelegatedUserIntentRequest;
  space: string;
  accountPublicKey: string;
  /** Derived from the verified IdP subject with deriveOwnerForIdpSubject. Never read from the request. */
  owner: string;
  /** This host's ledger directory. The decision reads the actor's row itself. */
  dir: string;
  observeAssignment: ObservePlatformControlAssignment;
  observeManagerGate: ObserveManagerGate;
  /** The host's launch record of this owner whose `execution.lifecycleUid` is `lifecycleUid`, read fresh. Retire only. */
  observeLaunchRecord(owner: string, lifecycleUid: string): Promise<DelegatedUserIntentRecord | null>;
  /** The host's records of this owner whose `intent.target.actor` is `actor`, read fresh. Launch only. */
  observeAliasRecords(owner: string, actor: string): Promise<DelegatedUserIntentRecord[]>;
  /** platformControlOwner(...) for this space and account. */
  platformOwner: string;
  now: number;
}

/** A read is never a fence and never cached: an observer that fails refuses this call only. */
async function observe<T>(what: string, read: () => Promise<T>): Promise<T> {
  try {
    return await read();
  } catch (e) {
    throw new EpEnvelopeError("unavailable", `delegated user intent ${what} is unreadable: ${e instanceof Error ? e.message : String(e)}`);
  }
}

type Gate = Awaited<ReturnType<ObserveManagerGate>>;

function isCurrentAssignment(a: PlatformControlAssignment | null, space: string, accountPublicKey: string, instanceId: string): a is PlatformControlAssignment {
  return a !== null && a.v === 1 && a.state === "assigned" && a.space === space && a.accountPublicKey === accountPublicKey && a.instanceId === instanceId;
}

/** Decides one admission. Writes nothing and mints nothing. Returns the record the host persists. */
export async function authorizeDelegatedUserIntentAdmission(
  args: AuthorizeDelegatedUserIntentAdmissionArgs,
): Promise<DelegatedUserIntentRecord> {
  const r = parseDelegatedUserIntentRequest(args.request);
  if (r.space !== args.space || r.accountPublicKey !== args.accountPublicKey)
    throw new EpEnvelopeError("permission-denied", "delegated user intent names another space or account than this authority context");
  // Only a human's derived owner admits an intent: a platform or service owner never acts as a user.
  try {
    assertDerivedOwnerToken(args.owner);
  } catch (e) {
    throw new EpEnvelopeError("permission-denied", e instanceof Error ? e.message : String(e));
  }
  let scope: string[];
  try {
    scope = ledgerAuthorizeGrant(args.dir)(args.owner, r.actor).scope ?? [];
  } catch (e) {
    throw new EpEnvelopeError("permission-denied", `delegated user intent found no ledger grant for actor "${r.actor}": ${e instanceof Error ? e.message : String(e)}`);
  }
  if (!scope.includes("spawn"))
    throw new EpEnvelopeError("permission-denied", `delegated user intent needs scope "spawn" on actor "${r.actor}"`);
  const parent = `${args.owner}.${r.actor}`;
  const assignment = await observe("assignment", () => args.observeAssignment(args.space, args.accountPublicKey));
  const gate = await observe("manager gate", () => args.observeManagerGate(r.instanceId));
  const servePrincipal = `${args.platformOwner}.${remoteManagerActors(r.instanceId).serve}`;
  let bound: Pick<DelegatedUserIntentRecord, "managerLifecycleUid" | "assignmentRevision" | "serveEpoch">;
  if (r.intent.operation === "launch") {
    if (!isCurrentAssignment(assignment, args.space, args.accountPublicKey, r.instanceId))
      throw new EpEnvelopeError("permission-denied", `platform control instance ${r.instanceId} is not the current assignment's instance for this account`);
    if (gate && gate.principal !== servePrincipal)
      throw new EpEnvelopeError("permission-denied", `manager gate belongs to ${gate.principal}, not serve principal ${servePrincipal}`);
    if (!gate || gate.state !== "open")
      throw new EpEnvelopeError("failed-precondition", `delegated user intent found no current open manager gate for instance ${r.instanceId}`);
    const t = r.intent.target;
    // A dry run of the walk the host's writer repeats at the write: refuse before any record exists.
    try {
      assertWithinSpawnerGrant(args.dir, {
        owner: args.owner,
        actor: t.actor,
        scope: t.capabilities ?? [],
        allowSubscribe: t.allowSubscribe ?? [],
        allowPublish: t.allowPublish ?? [],
        parent,
        ...(t.role !== undefined ? { role: t.role } : {}),
      }, "spawn");
    } catch (e) {
      throw new EpEnvelopeError("permission-denied", e instanceof Error ? e.message : String(e));
    }
    const aliasRecords = await observe("alias records", () => args.observeAliasRecords(args.owner, t.actor));
    if (aliasRecords.some(delegatedUserIntentHoldsAlias))
      throw new EpEnvelopeError("failed-precondition", `actor "${t.actor}" is held by an unfinished delegated execution`);
    bound = { managerLifecycleUid: assignment.lifecycleUid, assignmentRevision: assignment.assignmentRevision, serveEpoch: gate.processEpoch };
  } else {
    const t = r.intent.target;
    if (t.owner !== args.owner)
      throw new EpEnvelopeError("permission-denied", `retirement target owner "${t.owner}" does not match authenticated owner "${args.owner}"`);
    const launch = await observe("launch record", () => args.observeLaunchRecord(args.owner, t.lifecycleUid));
    // The launch record's own `actor` admitted the launch; only its target names the agent.
    if (!launch || launch.owner !== args.owner || launch.intent.operation !== "launch" || launch.outcome !== "enrolled" ||
        launch.execution?.lifecycleUid !== t.lifecycleUid || launch.intent.target.actor !== t.actor || launch.instanceId !== r.instanceId)
      throw new EpEnvelopeError("failed-precondition", `lifecycle ${t.lifecycleUid} of "${t.actor}" is no enrolled delegated launch on instance ${r.instanceId}`);
    const present = isCurrentAssignment(assignment, args.space, args.accountPublicKey, r.instanceId) &&
      assignment.lifecycleUid === launch.managerLifecycleUid && assignment.assignmentRevision === launch.assignmentRevision &&
      gatePresents(gate, servePrincipal, launch.serveEpoch);
    // A gone holder cannot present the intent (execution requires the record's epoch), so the host
    // consumes it itself.
    bound = { managerLifecycleUid: launch.managerLifecycleUid, assignmentRevision: launch.assignmentRevision, serveEpoch: present ? launch.serveEpoch : null };
  }
  return {
    v: 1,
    space: args.space,
    owner: args.owner,
    actor: r.actor,
    parent,
    intentId: mintLifecycleUid(),
    accountPublicKey: args.accountPublicKey,
    instanceId: r.instanceId,
    ...bound,
    intent: r.intent,
    expiresAt: new Date(args.now + DELEGATED_USER_INTENT_MAX_TTL_SECONDS * 1000).toISOString(),
    state: "admitted",
  };
}

function gatePresents(gate: Gate, servePrincipal: string, serveEpoch: number | null): boolean {
  return gate !== null && gate.state === "open" && gate.principal === servePrincipal && gate.processEpoch === serveEpoch;
}

export interface AuthorizeDelegatedUserIntentExecutionArgs {
  request: RemoteDelegatedUserIntentExecutionRequest;
  space: string;
  accountPublicKey: string;
  platformOwner: string;
  /** The host's record for request.intentId, read fresh. Null is an absent intent. */
  intent: DelegatedUserIntentRecord | null;
  observeAssignment: ObservePlatformControlAssignment;
  observeManagerGate: ObserveManagerGate;
  proofSecret: string | Uint8Array;
  now: number;
}

/** The only facts an execution decision carries, all checked for the current request. */
export interface DelegatedUserIntentDecision {
  intentId: string;
  requestId: string;
  serveEpoch: number;
  owner: string;
  parent: string;
  instanceId: string;
  /** True when the request equals the record's `execution` pin: the host joins that execution's
   * flight, or answers from its outcome, and writes no second CAS. */
  resume: boolean;
  operation: "launch" | "retire";
  target: DelegatedUserLaunchTarget | RemoteManagedAgentPrepareRetirementRequest["target"];
  /** Launch only. */
  tokenHash?: string;
  /** Retire only: managedRetirementOpId(target.lifecycleUid). */
  opId?: string;
}

/** Decides one execution. Writes nothing; the host consumes the record, pinning the execution, before
 * acting on the decision. */
export async function authorizeDelegatedUserIntentExecution(
  args: AuthorizeDelegatedUserIntentExecutionArgs,
): Promise<DelegatedUserIntentDecision> {
  const r = parseRemoteDelegatedUserIntentExecutionRequest(args.request);
  if (r.space !== args.space || r.accountPublicKey !== args.accountPublicKey)
    throw new EpEnvelopeError("permission-denied", "delegated user intent execution names another space or account than this authority context");
  const rec = args.intent;
  if (!rec || rec.intentId !== r.intentId || rec.space !== args.space || rec.accountPublicKey !== args.accountPublicKey)
    throw new EpEnvelopeError("failed-precondition", `delegated user intent ${r.intentId} was never admitted`);
  let resume = false;
  if (rec.state === "admitted") {
    if (Date.parse(rec.expiresAt) <= args.now)
      throw new EpEnvelopeError("failed-precondition", `delegated user intent ${r.intentId} expired at ${rec.expiresAt}`);
  } else {
    // Only the execution the consuming CAS pinned may present a consumed record again.
    const pin = rec.execution;
    if (!pin || pin.requestId !== r.requestId || pin.serveEpoch !== r.serveEpoch ||
        (r.execute.operation === "launch" && pin.tokenHash !== r.execute.target.tokenHash))
      throw new EpEnvelopeError("failed-precondition", `delegated user intent ${r.intentId} was consumed by another execution`);
    resume = true;
  }
  if (r.instanceId !== rec.instanceId || r.managerLifecycleUid !== rec.managerLifecycleUid ||
      r.assignmentRevision !== rec.assignmentRevision || r.execute.operation !== rec.intent.operation)
    throw new EpEnvelopeError("permission-denied", `delegated user intent ${r.intentId} is bound to another instance, lifecycle, revision or operation`);
  const assignment = await observe("assignment", () => args.observeAssignment(args.space, args.accountPublicKey));
  if (!isCurrentAssignment(assignment, args.space, args.accountPublicKey, rec.instanceId) ||
      assignment.assignmentRevision !== rec.assignmentRevision || assignment.lifecycleUid !== rec.managerLifecycleUid)
    throw new EpEnvelopeError("permission-denied", "platform control assignment no longer names the intent's instance, lifecycle or revision");
  const gate = await observe("manager gate", () => args.observeManagerGate(r.instanceId));
  const servePrincipal = `${args.platformOwner}.${remoteManagerActors(r.instanceId).serve}`;
  if (gate && gate.principal !== servePrincipal)
    throw new EpEnvelopeError("permission-denied", `manager gate belongs to ${gate.principal}, not serve principal ${servePrincipal}`);
  if (!gate || gate.state !== "open")
    throw new EpEnvelopeError("failed-precondition", `delegated user intent execution found no current open manager gate for instance ${r.instanceId}`);
  if (gate.processEpoch !== r.serveEpoch)
    throw new EpEnvelopeError("conflict", `manager serve epoch ${r.serveEpoch} is stale; current is ${gate.processEpoch}`);
  if (r.serveEpoch !== rec.serveEpoch)
    throw new EpEnvelopeError("permission-denied", `delegated user intent ${r.intentId} is bound to serve epoch ${rec.serveEpoch}, not ${r.serveEpoch}`);
  const expectedProof = remoteManagerCurrentRegistrationProof(args.proofSecret, args.platformOwner, r, gate);
  if (!timingSafeEqual(Buffer.from(r.registrationProof), Buffer.from(expectedProof)))
    throw new EpEnvelopeError("permission-denied", "delegated user intent execution proof does not match current host registration");
  const base = { intentId: rec.intentId, requestId: r.requestId, serveEpoch: r.serveEpoch, owner: rec.owner, parent: rec.parent, instanceId: rec.instanceId, resume };
  if (rec.intent.operation === "launch") {
    if (r.execute.operation !== "launch" || r.execute.target.actor !== rec.intent.target.actor)
      throw new EpEnvelopeError("permission-denied", `delegated user intent ${r.intentId} names a launch of "${rec.intent.target.actor}" only`);
    return { ...base, operation: "launch", target: rec.intent.target, tokenHash: r.execute.target.tokenHash };
  }
  const want = rec.intent.target;
  if (r.execute.operation !== "retire" || r.execute.target.owner !== want.owner || r.execute.target.actor !== want.actor ||
      r.execute.target.lifecycleUid !== want.lifecycleUid)
    throw new EpEnvelopeError("permission-denied", `delegated user intent ${r.intentId} names another retirement target`);
  return { ...base, operation: "retire", target: want, opId: managedRetirementOpId(want.lifecycleUid) };
}
