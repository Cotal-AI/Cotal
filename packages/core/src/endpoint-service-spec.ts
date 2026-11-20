/**
 * The v0.4 service registry's value shapes (SPEC §13.7 "Descriptor and describe"): the `svc`
 * spec and status records, their consuming-boundary validators, the virtual activation policy,
 * and service-name authority. Split verbatim out of endpoint-service.ts, which re-exports it, so
 * the package's exports are unchanged.
 */
import { isContractDigest } from "./canonical.js";
import { endpointToken, assertBoundedOwner } from "./endpoint-subjects.js";
import { EpEnvelopeError } from "./endpoint-envelope.js";
import type { SupervisorWriteGrant } from "./endpoint-supervisor.js";

// ---- value shapes (§13.7 "Descriptor and describe") ------------------------------------------

/** The `svc….spec` value: the instance's registered descriptor identity. The spec KEY's store
 *  revision is the instance's `registrationRevision` (§13.7): it advances only when the
 *  mediated registration path writes the key, so an advance during a scatter is exactly a
 *  re-registration. */
export interface ServiceSpec {
  endpoint: string;
  /** The serving owner — determined by the NAME (§13.2 single-owner names), recorded here. */
  owner: string;
  endpointType?: string;
  /** Complete-closure digests of the served cluster documents (§13.7). */
  clusterDigests: string[];
  /** The discovery protocol version — additive evolution only (§13.7). */
  protocol: { v: 1 };
  /** Virtual-endpoint activation policy (§13.6), opaque to the registry. */
  activation?: Record<string, unknown>;
}

/** The `svc….status` value: the instance's own convergence projection, written epoch-fenced
 *  through its `epr` rail (§13.9: the writer reads the epoch from the broker-authenticated
 *  subject, never from payload). `state` is a bounded token; readers key on
 *  {@link SERVICE_READY}/{@link SERVICE_EXITED} (§13.6: an entity's convergence is observable
 *  on its own status record). */
export interface ServiceStatus {
  epoch: number;
  state: string;
  observedSpecRevision: number;
  [key: string]: unknown;
}

/** The convergence states the SPEC keys on (§13.6 item 6). */
export const SERVICE_READY = "ready";
export const SERVICE_EXITED = "exited";
/** Restart-intensity escalation (§13.6 virtual endpoints): the instance stops restarting and
 *  the lifecycle retires terminally; readers treat it as permanently not-startable. The state
 *  is IRREVERSIBLE at {@link writeServiceStatus}: no later status write (any epoch) replaces
 *  it — the only touch a stored escalated row admits is the supervisor's own revision-pinned
 *  retirement mark, written directly by the reconciler, never through this writer. */
export const SERVICE_ESCALATED = "escalated";

/** The SUPERVISOR-OWNED status fields (§13.6 restart intensity): the durable restart history
 *  and the retirement-complete mark. {@link writeServiceStatus} carries them forward on every
 *  INSTANCE-side write and strips whatever the caller supplied; ONLY a holder of the branded
 *  {@link SupervisorWriteGrant} may originate them or the `escalated` state. */
export const SERVICE_RESTART_HISTORY_FIELD = "restarts";
export const SERVICE_RETIRED_MARK_FIELD = "retiredAt";


/** The §13.6 virtual activation policy (`spec.activation`), a CLOSED schema: `mode` is the
 *  literal `on-demand` and `capacity` (the pool admission bound) is REQUIRED — an unbounded
 *  pool is not a policy, and a free-floating capacity knob unbound from the registration was
 *  the drift the panel refused. The restart knobs default per SPEC (3 within 60s). */
export interface VirtualActivationPolicy {
  mode: "on-demand";
  capacity: number;
  maxRestarts?: number;
  restartWindowMs?: number;
}

export function parseActivationPolicy(raw: unknown): VirtualActivationPolicy {
  const o = isRec(raw) ? raw : svcFail("activation policy is not an object");
  for (const k of Object.keys(o)) if (!["mode", "capacity", "maxRestarts", "restartWindowMs"].includes(k)) svcFail(`activation policy carries unknown field "${k}" (closed schema)`);
  if (o.mode !== "on-demand") svcFail(`activation.mode "${String(o.mode)}" is not "on-demand"`);
  if (typeof o.capacity !== "number" || !Number.isSafeInteger(o.capacity) || o.capacity <= 0) svcFail("activation.capacity must be a positive integer (a virtual pool is bounded by policy, never open-ended)");
  if (o.maxRestarts !== undefined && (typeof o.maxRestarts !== "number" || !Number.isSafeInteger(o.maxRestarts) || o.maxRestarts <= 0)) svcFail("activation.maxRestarts must be a positive integer");
  if (o.restartWindowMs !== undefined && (typeof o.restartWindowMs !== "number" || !Number.isSafeInteger(o.restartWindowMs) || o.restartWindowMs <= 0)) svcFail("activation.restartWindowMs must be a positive integer");
  return o as unknown as VirtualActivationPolicy;
}

const STATE_TOKEN = /^[a-z][a-z0-9-]{0,31}$/;
const isRec = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);
const wireInt = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v) && v >= 0;

function svcFail(what: string): never {
  throw new EpEnvelopeError("internal", `service record does not validate: ${what}`);
}

/** Validate a `svc….spec` value at its consuming boundary (§13.3: every plane is
 *  runtime-validated; mediated-writer state that does not validate is a writer bug, never a
 *  data error). The body's endpoint must AGREE with the key's endpoint qualifier. */
export function parseServiceSpec(raw: unknown, key: { endpoint: string }): ServiceSpec {
  const o = isRec(raw) ? raw : svcFail("not an object");
  if (typeof o.endpoint !== "string") svcFail("endpoint");
  if (endpointToken(o.endpoint) !== endpointToken(key.endpoint)) svcFail("endpoint disagrees with the record key");
  if (typeof o.owner !== "string") svcFail("owner");
  try {
    assertBoundedOwner(o.owner, "service owner");
  } catch (e) {
    svcFail(`owner: ${(e as Error).message}`);
  }
  if (o.endpointType !== undefined && typeof o.endpointType !== "string") svcFail("endpointType");
  if (!Array.isArray(o.clusterDigests) || o.clusterDigests.length === 0 || !o.clusterDigests.every(isContractDigest))
    svcFail("clusterDigests must be a non-empty array of sha256 digests");
  if (!isRec(o.protocol) || o.protocol.v !== 1) svcFail("protocol.v");
  if (o.activation !== undefined) parseActivationPolicy(o.activation); // closed schema, capacity REQUIRED (§13.6)
  return o as unknown as ServiceSpec;
}

/** Validate a `svc….status` value at its consuming boundary. */
export function parseServiceStatus(raw: unknown): ServiceStatus {
  const o = isRec(raw) ? raw : svcFail("status not an object");
  if (!wireInt(o.epoch)) svcFail("status.epoch");
  if (typeof o.state !== "string" || !STATE_TOKEN.test(o.state)) svcFail("status.state");
  if (!wireInt(o.observedSpecRevision)) svcFail("status.observedSpecRevision");
  // The SUPERVISOR-OWNED fields are validated at the consuming boundary too, so corrupt/legacy
  // state never rides through the escalation barrier (§13.6): the restart history is an array
  // of {t, epoch} with UNIQUE epochs (a real restart advances the epoch; a duplicate is a
  // fabricated count), and the retirement mark is a non-negative integer that appears ONLY on an
  // escalated row (a mark on a live row would let a forged `retiredAt` fake completion).
  if (o[SERVICE_RESTART_HISTORY_FIELD] !== undefined) {
    const h = o[SERVICE_RESTART_HISTORY_FIELD];
    if (!Array.isArray(h) || !h.every((e) => isRec(e) && wireInt(e.t) && wireInt(e.epoch)))
      svcFail(`status.${SERVICE_RESTART_HISTORY_FIELD} is not an array of {t, epoch}`);
    const epochs = new Set((h as { epoch: number }[]).map((e) => e.epoch));
    if (epochs.size !== h.length) svcFail(`status.${SERVICE_RESTART_HISTORY_FIELD} has duplicate epochs (a fabricated count)`);
  }
  if (o[SERVICE_RETIRED_MARK_FIELD] !== undefined) {
    if (!wireInt(o[SERVICE_RETIRED_MARK_FIELD])) svcFail(`status.${SERVICE_RETIRED_MARK_FIELD} is not a non-negative integer`);
    if (o.state !== SERVICE_ESCALATED) svcFail(`status.${SERVICE_RETIRED_MARK_FIELD} is present on a "${String(o.state)}" row; a retirement mark appears only on an escalated row (§13.6)`);
  }
  return o as unknown as ServiceStatus;
}

// ---- service-name authority (§13.2 single-owner names, §13.9) ---------------------------------

/** The deployment's name-authority source (pluggable — identity is an adapter, §13.9): core
 *  single-label names require operator provisioning authority; reverse-DNS names bind to their
 *  REGISTERED domain owner. The answer comes from the deployment's trusted registry, never from
 *  the registrant's claim. */
export interface ServiceNameAuthority {
  /** ONE atomic leader-served authority decision for `(name, owner)` (§13.9), returning the
   *  authorization result AND the name-authority binding revision from a SINGLE read so the two
   *  can never TEAR across a concurrent transfer (a read is never a fence, §13.1; the returned
   *  revision is a THIRD currency dimension bound into the issuance gate and re-checked at mint,
   *  so a transfer AFTER authorization can never release an old-owner credential). `authorized`
   *  is true iff `owner` may serve `name`: for a core single-label name, iff `owner` holds
   *  operator provisioning authority; for a reverse-DNS name, iff `owner` is the REGISTERED
   *  domain owner (an unregistered name is never authorized, fail-closed). `revision` advances
   *  whenever the name transfers or its operator-authority grant changes. */
  authorize(name: string, owner: string): Promise<{ authorized: boolean; revision: number }> | { authorized: boolean; revision: number };
}

/** Enforce §13.9 name authority before a registration/serve grant is minted, from ONE atomic
 *  snapshot: an endpoint name binds to exactly ONE owner (§13.2), so a registration claiming a
 *  name its owner does not hold fails `permission-denied`, and an UNREGISTERED reverse-DNS name
 *  fails closed. Returns the name-authority binding REVISION read atomically WITH the decision —
 *  the caller binds it into the issuance gate so a transfer between decision and mint is fenced,
 *  never a torn owner-vs-revision read. */
export async function assertServiceNameAuthority(endpoint: string, owner: string, authority: ServiceNameAuthority): Promise<number> {
  endpointToken(endpoint); // grammar first: a malformed name is refused before any authority answer
  assertBoundedOwner(owner, "service owner");
  const snapshot = await authority.authorize(endpoint, owner);
  if (!snapshot.authorized)
    throw new EpEnvelopeError("permission-denied", `service name "${endpoint}" does not authorize owner "${owner}" (SPEC 13.9: a core name needs operator authority; a reverse-DNS name binds to its registered owner and an unregistered one is never adopted first-come)`);
  if (!Number.isSafeInteger(snapshot.revision) || snapshot.revision < 0)
    throw new EpEnvelopeError("internal", `the name-authority revision for "${endpoint}" is ${JSON.stringify(snapshot.revision)}, not an unsigned integer`);
  return snapshot.revision;
}

