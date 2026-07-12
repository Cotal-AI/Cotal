/**
 * v0.4 service registry (SPEC §13.7 "Descriptor and describe", §13.5 scatter freeze, §13.9
 * writer table) — the `svc` record kind's value shapes with their consuming-boundary
 * validators, service-name authority enforcement, the mediated registration and epoch-fenced
 * status writes, and the scatter expected-set freeze.
 *
 * Registry entries are DISCOVERY, never authority (§13.9): nothing here grants subscribe or
 * reply authority or scatter membership by itself — the serve credential is the authority, and
 * a foreign credential cannot subscribe a class rail, answer as an instance, or enter a frozen
 * scatter set. The helpers below run inside the trusted writer principals the §13.9 writer
 * table names (`provisioner-registration` for spec, `instance-commit-epoch-fenced` for status).
 */
import type { KV } from "@nats-io/kv";
import { spacePrefix, principalKey } from "./subjects.js";
import {
  endpointToken, assertBoundedOwner, assertLifecycleToken, assertCommandToken,
  type EpAuthzMode,
} from "./endpoint-subjects.js";
import { EpEnvelopeError, type EpClass } from "./endpoint-envelope.js";
import {
  RECORD_KINDS, recordSpecKey, recordStatusKey, readRecord,
  createRecordEntry, updateRecordEntry, assertStatusValue,
} from "./endpoint-records.js";
import { verifyClusterManifest, verifyClusterRoot, deriveDescriptor, type ClusterDocument, type DescribeDescriptor } from "./endpoint-cluster.js";

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

const STATE_TOKEN = /^[a-z][a-z0-9-]{0,31}$/;
const isRec = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);
const wireInt = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v) && v >= 0;
const isDigest = (v: unknown): v is string => typeof v === "string" && /^sha256:[0-9a-f]{64}$/.test(v);

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
  if (!Array.isArray(o.clusterDigests) || o.clusterDigests.length === 0 || !o.clusterDigests.every(isDigest))
    svcFail("clusterDigests must be a non-empty array of sha256 digests");
  if (!isRec(o.protocol) || o.protocol.v !== 1) svcFail("protocol.v");
  if (o.activation !== undefined && !isRec(o.activation)) svcFail("activation");
  return o as unknown as ServiceSpec;
}

/** Validate a `svc….status` value at its consuming boundary. */
export function parseServiceStatus(raw: unknown): ServiceStatus {
  const o = isRec(raw) ? raw : svcFail("status not an object");
  if (!wireInt(o.epoch)) svcFail("status.epoch");
  if (typeof o.state !== "string" || !STATE_TOKEN.test(o.state)) svcFail("status.state");
  if (!wireInt(o.observedSpecRevision)) svcFail("status.observedSpecRevision");
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

// ---- registration (spec writes, the `provisioner-registration` principal) ---------------------

/** Register (or re-register) a service instance: authenticated-registrant binding, name
 *  authority, then the spec-key CAS. The returned `registrationRevision` is the spec key's
 *  store revision (§13.7) — a re-registration advances it, which is exactly what invalidates a
 *  frozen scatter slot (§13.5 `churn`). A concurrent registration race is a loud `conflict`
 *  (§13.8: re-read and re-decide).
 *
 *  `registrant` is the BROKER-AUTHENTICATED caller of the registration request (its subject
 *  principal, §13.9 — never a payload claim): the descriptor owner must BE that caller, so a
 *  privileged owner's descriptor cannot be registered by anyone else, and a re-registration can
 *  never change an instance's ownership. `instanceId` MUST be provisioner-minted and never
 *  reused (§13.1); the allocator that enforces non-reuse is the lifecycle registry (D13) — this
 *  seam enforces what is checkable at the record: grammar, ownership stability, and CAS.
 *
 *  ISSUANCE-GATE BARRIER (§13.1). A registration is a WRITER on the instance's issuance gate: to
 *  be linearizable against an in-flight serve mint it MUST run the barrier protocol on the SAME
 *  `gate.<lifecycleUid>` key, in order: freeze the gate (so a fresh mint observes `frozen` and
 *  refuses, and a staged-but-uncommitted mint loses its revision-pinned CAS), authorize the owner
 *  under the frozen gate, revoke + VERIFIED-evict the superseded credential family, THEN advance
 *  the spec, then reopen at the successor `registrationRevision`. Old authority dies before new
 *  authority is published. This is REQUIRED, not documented: core exports no bare spec-key advance
 *  that could leave a mint's observed `registrationRevision` permanently equal to its snapshot,
 *  win a never-frozen CAS, and silently release a superseded-surface credential. The gate is
 *  created by the provisioner at instance mint (D13); a missing gate is `failed-precondition`. The
 *  production `barrier` wires to the durable KV CAS (D13/D14); the D4 seam is the typed protocol
 *  and its faithful in-memory model, so the barrier's writes serialize with the mint's on one key. */
export async function registerServiceInstance(
  kv: KV,
  args: { space: string; spec: ServiceSpec; instanceId: string; registrant: { owner: string }; authority: ServiceNameAuthority; barrier: EpIssuanceBarrier },
): Promise<{ registrationRevision: number }> {
  spacePrefix(args.space); // up-front boundary guard on the space arg (mirrors authorizeServeGrant): usable as a subject token, throws on an absent/non-string space at an untyped caller. This is NOT the cross-space authority fence - that is the observed-gate `(space, endpoint, instanceId)` identity check below (trusted-context equality against the per-space KV bucket).
  const spec = parseServiceSpec(args.spec, { endpoint: args.spec.endpoint });
  assertBoundedOwner(args.registrant.owner, "registrant owner");
  if (args.registrant.owner !== spec.owner)
    throw new EpEnvelopeError("permission-denied", `the registration's authenticated caller "${args.registrant.owner}" is not the descriptor owner "${spec.owner}" (SPEC 13.9: authenticated caller binding, never a payload claim)`);
  // The NAME-AUTHORITY decision is deferred until UNDER the frozen gate (phase 1): a transfer must
  // freeze this same gate, so authorizing while we hold the freeze serializes the decision with the
  // transfer — checking here (pre-freeze) would repeat the torn owner-vs-revision read the atomic
  // authorize() closed for authorizeServeGrant.
  const key = recordSpecKey(RECORD_KINDS.svc, [spec.endpoint, assertLifecycleToken(args.instanceId, "instanceId")]);

  // §13.1 barrier: freeze the instance's gate FIRST so no serve mint can win against the surface
  // this registration is about to supersede. A non-open gate or a lost freeze is another barrier
  // holding the key — a loud `conflict` (§13.8: re-read and re-decide), never a bare write.
  const obs = await args.barrier.observe();
  if (obs === null)
    throw new EpEnvelopeError("failed-precondition", `no issuance gate for instance "${args.instanceId}"; a registration writes only behind the provisioner-created gate (SPEC 13.1)`);
  if (obs.space !== args.space || obs.endpoint !== spec.endpoint || obs.lifecycleUid !== args.instanceId)
    throw new EpEnvelopeError("internal", `the issuance gate is for "${obs.space}/${obs.endpoint}/${obs.lifecycleUid}", not "${args.space}/${spec.endpoint}/${args.instanceId}"; a registration drives only its OWN instance's gate, and the instance token is unique only within (space, endpoint) (SPEC 13.1)`);
  if (obs.state === "retired")
    throw new EpEnvelopeError("failed-precondition", `the issuance gate for "${args.instanceId}" is retired; the lifecycle is permanently closed and its id is never reused, so a re-read cannot help (SPEC 13.1)`);
  if (obs.state !== "open")
    throw new EpEnvelopeError("conflict", `the issuance gate for "${args.instanceId}" is ${obs.state}; another barrier holds it — re-read and re-decide (SPEC 13.8)`);
  const token = await args.barrier.freeze(obs.revision);
  if (token === null)
    throw new EpEnvelopeError("conflict", `a concurrent barrier froze the issuance gate for "${args.instanceId}" first; re-read and re-decide (SPEC 13.1/13.8)`);

  // The gate is frozen; every exit below reopens it (token-pinned, at the original coordinate) or
  // deliberately leaves it FROZEN for reconciliation. The successor the completing reopen targets.
  const successorAt = (registrationRevision: number): EpGateSuccessor => ({
    generation: obs.generation + 1, processEpoch: obs.processEpoch, registrationRevision, nameAuthorityRevision: obs.nameAuthorityRevision,
  });

  // PHASE 1 — authorize UNDER the frozen gate, then ownership stability. Both are authority /
  // local reads with NO write side-effect, so any failure (owner not authorized, name-authority
  // drift, a garbled stored spec, an ownership change) is a DEFINITE no-write and no revoke has
  // run → reopen the ORIGINAL coordinate and rethrow.
  //  - the name-authority decision is made HERE (holding the freeze), and the authorized revision
  //    MUST equal the frozen gate's `nameAuthorityRevision`: a transfer that raced would have to
  //    freeze this same gate (it can't) or would leave the gate at a different coordinate, so a
  //    mismatch is a raced transfer — a loud `conflict`, never a stale-owner registration.
  let current: Awaited<ReturnType<KV["get"]>>;
  try {
    const authorizedNameRevision = await assertServiceNameAuthority(spec.endpoint, spec.owner, args.authority);
    if (authorizedNameRevision !== obs.nameAuthorityRevision)
      throw new EpEnvelopeError("conflict", `a name-authority transfer raced this registration: owner "${spec.owner}" is authorized at nameAuthorityRevision ${authorizedNameRevision} but the frozen gate is at ${obs.nameAuthorityRevision}; re-read and re-decide (SPEC 13.9)`);
    current = await kv.get(key);
    if (current && current.operation === "PUT") {
      const stored = parseServiceSpec(decodeJson(current.value, key), { endpoint: spec.endpoint });
      if (stored.owner !== spec.owner)
        throw new EpEnvelopeError("permission-denied", `instance "${args.instanceId}" is registered to owner "${stored.owner}"; a re-registration can never change ownership (SPEC 13.1: instance ids are never reused across identities)`);
    }
  } catch (err) {
    await reopenGateAfterAbort(args.barrier, token, successorAt(obs.registrationRevision), err);
    throw err;
  }

  // PHASE 2 — revoke + VERIFIED eviction of the superseded family BEFORE publishing the new spec
  // (§13.1 order: old authority must die before new authority is visible). Fail-closed: if any
  // revoke/eviction cannot be verified, leave the gate FROZEN for reconciliation — never reopen,
  // or old credentials could come back to life against a pending re-registration.
  //  - revoke every ACTIVE row (an already-`revoked` row was flipped by an earlier barrier);
  //  - but verified-evict the distinct holder principals of the ENTIRE enumerated family: an
  //    already-revoked row from a PARTIALLY FAILED prior barrier may still have a live connection
  //    that was never verified gone, so eviction must not skip it (§13.1).
  try {
    const family = await args.barrier.enumerate();
    for (const row of family) if (row.state === "active") await args.barrier.revoke(row);
    for (const holderPrincipal of new Set(family.map((row) => row.holderPrincipal)))
      if (!(await args.barrier.evict(holderPrincipal)))
        throw new Error(`principal "${holderPrincipal}" is not verified evicted`);
  } catch (err) {
    throw new EpEnvelopeError("unavailable", `re-registration could not revoke + verify-evict the superseded serve family; the gate is left frozen for reconciliation, no new spec published (SPEC 13.1): ${(err as Error)?.message ?? String(err)}`);
  }

  // PHASE 3 — publish the new spec. ANY write error stays FROZEN for reconciliation, never
  // reopening the old coordinate: the KV may have committed while the ack was lost (an ambiguous
  // outcome), and reopening old would release stale-surface credentials against a spec that
  // advanced. Under the frozen gate THIS barrier is the sole spec-key writer, so a write error is
  // genuinely infra/ambiguous — never a concurrent-CAS loss we could treat as a definite no-write.
  let newRev: number;
  try {
    newRev = current && current.operation === "PUT"
      ? await updateRecordEntry(kv, key, spec, current.revision)
      : await createRecordEntry(kv, key, spec);
  } catch (err) {
    throw new EpEnvelopeError("unavailable", `the re-registration spec-write outcome is ambiguous (it may have committed); the gate is left frozen for reconciliation, never reopened at the old coordinate (SPEC 13.1): ${(err as Error)?.message ?? String(err)}`);
  }

  // PHASE 4 — reopen at the successor, TOKEN-pinned: only this barrier (still holding its freeze)
  // may reopen; a lost CAS means a reconciler/newer barrier superseded us → leave frozen.
  try {
    if (!(await args.barrier.reopen(token, successorAt(newRev))))
      throw new Error("the reopen CAS lost its freeze token (a reconciler or newer barrier superseded this one)");
  } catch (err) {
    throw new EpEnvelopeError("unavailable", `re-registration wrote the spec at revision ${newRev} but the reopen did not complete; the gate is left frozen for reconciliation (SPEC 13.1): ${(err as Error)?.message ?? String(err)}`);
  }
  return { registrationRevision: newRev };
}

/** Reopen a barrier-frozen gate (token-pinned) after a registration aborted before any spec write
 *  or revoke — the gate returns to `open` at the given successor. A lost or failed reopen leaves
 *  the gate frozen for reconciliation and is surfaced with the aborting cause attached (§13.1:
 *  fail closed, never a silently stuck gate). */
async function reopenGateAfterAbort(barrier: EpIssuanceBarrier, token: number, successor: EpGateSuccessor, cause: unknown): Promise<void> {
  try {
    if (await barrier.reopen(token, successor)) return;
    throw new Error("the reopen CAS lost its freeze token");
  } catch (err) {
    const e = new EpEnvelopeError("unavailable", `registration aborted and the issuance gate could not be reopened; it is left frozen for reconciliation (SPEC 13.1): ${(err as Error)?.message ?? String(err)}`);
    (e as Error & { cause?: unknown }).cause = cause;
    throw e;
  }
}

function decodeJson(value: Uint8Array, key: string): unknown {
  try {
    return JSON.parse(new TextDecoder().decode(value));
  } catch (e) {
    throw new EpEnvelopeError("internal", `record ${key} does not decode as JSON: ${(e as Error).message}`);
  }
}

/** Write an instance's status with the FULL §13.9 writer fence. `epoch` is the
 *  WRITER-AUTHENTICATED epoch — in production the record writer reads it from the
 *  broker-authenticated `epr` subject (§13.9), never from the payload; this helper trusts its
 *  caller to be that seam and additionally requires the payload to agree. The fence is
 *  THREE-part, in order:
 *   1. a registered spec must exist and `observedSpecRevision` must not run AHEAD of it — a
 *      spec-less status is the torn record state readers reject (§13.4), never written;
 *   2. the epoch must equal a FRESH read of the authoritative lifecycle mapping's
 *      `processEpoch` (`expired` otherwise) — monotonicity against the stored status alone is
 *      NOT sufficient: between the takeover CAS (N→N+1) and the completed revoke/evict barrier
 *      the superseded N still equals the stored epoch (§13.9);
 *   3. a below-stored epoch is `conflict` (§13.9), distinct from the mapping fence.
 *  `readProcessEpoch` is the trusted mapping-reader seam (leader-served, §13.9; the D13
 *  lifecycle registry provides the production reader). The racing CAS loss is a loud `conflict`. */
export async function writeServiceStatus(
  kv: KV,
  args: {
    endpoint: string;
    instanceId: string;
    epoch: number;
    status: ServiceStatus;
    readProcessEpoch: () => Promise<number> | number;
  },
): Promise<number> {
  const status = parseServiceStatus(args.status);
  if (status.epoch !== args.epoch)
    throw new EpEnvelopeError("internal", `status.epoch ${status.epoch} disagrees with the writer-authenticated epoch ${args.epoch} (SPEC 13.9: the epoch rides the subject)`);
  assertStatusValue(status);
  // The endpoint NAME rides through: the kind's own qualifier assert tokenizes it exactly once.
  const iId = assertLifecycleToken(args.instanceId, "instanceId");
  const specEntry = await kv.get(recordSpecKey(RECORD_KINDS.svc, [args.endpoint, iId]));
  if (!specEntry || specEntry.operation !== "PUT")
    throw new EpEnvelopeError("failed-precondition", `status write for "${args.endpoint}/${args.instanceId}" has no registered spec; writing it would create the torn record state readers reject (SPEC 13.4)`);
  if (status.observedSpecRevision > specEntry.revision)
    throw new EpEnvelopeError("failed-precondition", `observedSpecRevision ${status.observedSpecRevision} runs AHEAD of the spec revision ${specEntry.revision}; a status can only observe a registration that exists (SPEC 13.4)`);
  const current = await args.readProcessEpoch();
  if (!Number.isSafeInteger(current) || current < 0)
    throw new EpEnvelopeError("internal", `the authoritative mapping read returned ${JSON.stringify(current)}, not an unsigned processEpoch`);
  if (args.epoch !== current)
    throw new EpEnvelopeError("expired", `status write from epoch ${args.epoch} is not the authoritative mapping's current processEpoch ${current}; stored-status monotonicity alone is insufficient during takeover (SPEC 13.9)`);
  const key = recordStatusKey(RECORD_KINDS.svc, [args.endpoint, iId]);
  const stored = await kv.get(key);
  if (stored && stored.operation === "PUT") {
    const recorded = parseServiceStatus(decodeJson(stored.value, key));
    if (args.epoch < recorded.epoch)
      throw new EpEnvelopeError("conflict", `status write from epoch ${args.epoch} is below the stored status epoch ${recorded.epoch} (SPEC 13.9)`);
    return updateRecordEntry(kv, key, status, stored.revision);
  }
  return createRecordEntry(kv, key, status);
}

// ---- the scatter freeze (§13.5) ---------------------------------------------------------------

/** One frozen scatter slot: `(instanceId, registrationRevision, epoch)` (§13.5). */
export interface FrozenInstance {
  instanceId: string;
  /** The `svc….spec` key's store revision at freeze time. */
  registrationRevision: number;
  epoch: number;
}

/** Freeze the request-scoped expected set (§13.5): the LIVE instances of a class from the
 *  service registry at send time — VALIDATED registered spec, status present and caught up to
 *  the current registration (a stale projection is an instance not yet live under it, so
 *  freezing `(new registrationRevision, pre-registration epoch)` would combine a registration
 *  with liveness it never had), and not {@link SERVICE_EXITED}. An EMPTY or UNREADABLE registry
 *  is `failed-precondition`, never an empty success (§13.5); a MALFORMED registry record fails
 *  loud (`internal`, §13.9: readers fail loud on invalid mediated-writer state). The read grant
 *  this runs under is a §13.9 matrix row. */
export async function freezeExpectedSet(kv: KV, endpoint: string): Promise<FrozenInstance[]> {
  const e = endpointToken(endpoint);
  const frozen: FrozenInstance[] = [];
  const unreadable = (err: unknown): never => {
    // Only the freeze's OWN classifications stay loud: malformed mediated-writer state
    // (`internal`, §13.9) and the torn-state `failed-precondition` the record reader already
    // makes. Every other failure — including a typed `permission-denied` from an
    // access-checked read path — IS the unreadable-registry condition: it normalizes to
    // `failed-precondition` (§13.5), never escapes as a weaker or misleading code.
    if (err instanceof EpEnvelopeError && (err.code === "internal" || err.code === "failed-precondition")) throw err;
    const wrapped = new EpEnvelopeError("failed-precondition", `the service registry for "${endpoint}" is unreadable; an unreadable registry is failed-precondition, never an empty success (SPEC 13.5): ${(err as Error)?.message ?? String(err)}`);
    (wrapped as Error & { cause?: unknown }).cause = err;
    throw wrapped;
  };
  const instanceIds: string[] = [];
  try {
    const iter = await kv.keys(`svc.${e}.*.spec`);
    for await (const key of iter) instanceIds.push(key.split(".")[2]);
  } catch (err) {
    unreadable(err);
  }
  for (const instanceId of instanceIds) {
    // The NAME, not the pre-tokenized `e`: the kind's qualifier assert tokenizes exactly once.
    let rec;
    try {
      rec = await readRecord(kv, RECORD_KINDS.svc, [endpoint, instanceId]);
    } catch (err) {
      unreadable(err);
    }
    if (!rec || !rec.status) continue; // registered but never converged: not a live class member
    parseServiceSpec(rec.spec.value, { endpoint }); // malformed registry state fails LOUD (§13.9)
    const status = parseServiceStatus(rec.status.value);
    if (status.state === SERVICE_EXITED) continue;
    if (rec.staleProjection) continue; // liveness predates the CURRENT registration: not live under it
    frozen.push({ instanceId, registrationRevision: rec.spec.revision, epoch: status.epoch });
  }
  if (frozen.length === 0)
    throw new EpEnvelopeError("failed-precondition", `service "${endpoint}" has no live registered instances; an empty registry is never an empty scatter success (SPEC 13.5)`);
  return frozen;
}

// ---- serve-credential authorization (§13.9 "Serve grants") -------------------------------------

/** One command's VERIFIED registered authority: everything the serve boundary enforces about
 *  the command, taken from a cluster document whose bytes hash to a digest the registered spec
 *  names — never from a caller-supplied declaration. */
export interface EpCommandAuthority {
  /** The registered cluster (closure digest) that declares this command. */
  clusterDigest: string;
  class: EpClass;
  targeted: boolean;
  /** Admitted authorization modes; empty exactly when untargeted (§13.7). */
  modes: readonly EpAuthzMode[];
  capability: string;
  inputDigest: string;
  outputDigest: string;
  /** Declared trait URNs (§13.7), out of the digest-verified cluster bytes; empty when the
   *  declaration carries none. Governed entries (`ai.cotal.guarded`/`ai.cotal.priced`) are
   *  what the serve boundary's pre-effect gate keys on; the rest are vocabulary. */
  traits: readonly string[];
}

/** The registry-authorized serve ARTIFACT {@link authorizeServeGrant} returns: ONE deep-frozen,
 *  brand-registered value binding space, registered identity, epoch, owner, registration
 *  revision, the FULL registered command set (§13.9: the instance credential binds its whole
 *  registered surface; caller-specific scoping happens only in the response-time describe
 *  answer, never in the registration), the digest-VERIFIED per-command surface, and the derived
 *  descriptor — consumed by both the credential mint (`permissionsFor`/`mintCreds`, profile
 *  `endpoint-serve`) and `serveEndpoint`, so neither ever accepts a raw spec/descriptor/command
 *  list again. The registry stays discovery (§13.9); this seam is what turns a REGISTRATION
 *  into serve authority. */
export interface EpServeGrant {
  space: string;
  endpoint: string;
  instanceId: string;
  epoch: number;
  /** The registered owner (the only principal this artifact mints for). */
  owner: string;
  /** The `svc….spec` store revision the surface was verified at (§13.7 `registrationRevision`);
   *  the mint's issuance fence refuses if the registration has advanced (a re-registration
   *  supersedes the branded surface). */
  registrationRevision: number;
  /** The name-authority binding revision the serving owner was verified against (§13.9); the
   *  mint's issuance fence refuses if it has advanced (a name transfer supersedes the owner). */
  nameAuthorityRevision: number;
  commands: readonly string[];
  /** Command → its verified registered declaration. */
  surface: Readonly<Record<string, EpCommandAuthority>>;
  /** The full authoritative descriptor describe publishes: DERIVED from verified registered
   *  bytes, deep-frozen. */
  descriptor: DescribeDescriptor;
}

/** Brand registry: authorized artifact → its immutable authorized snapshot. Like the §13.12
 *  consumer-config family bond, the brand (not structure) is what the consuming seams check,
 *  so a structural copy or post-authorization mutation can never carry serve authority. */
interface AuthorizedServe {
  space: string;
  endpoint: string;
  instanceId: string;
  epoch: number;
  owner: string;
  registrationRevision: number;
  nameAuthorityRevision: number;
  commands: string[];
}
const AUTHORIZED_SERVE = new WeakMap<EpServeGrant, AuthorizedServe>();

/**
 * Authorize a serve credential against the REGISTERED service (§13.9: serving is granted
 * authority, dual to calling — the registry is discovery, the serve grant is the authority).
 * Runs inside the provisioner. The fence, in order:
 *  1. the instance must be REGISTERED (its `svc….spec` record exists) — `failed-precondition`;
 *  2. the credential's holder must BE the registered owner (`permission-denied`), and the name
 *     authority is re-checked FRESH (`permission-denied` on drift);
 *  3. every registered cluster is read through the two-stage §13.7 content-address protocol:
 *     the MANIFEST is fetched at the registered CLOSURE digest and verified, `members` must be
 *     empty (P1 single-document clusters; a non-empty closure is the D8 loader's, refused loud
 *     until then), then the ROOT cluster document is fetched at `manifest.root` and verified.
 *     The verified documents are the ONLY command source — the FULL union of their declared
 *     commands is the surface (no caller subset; caller scoping is response-time describe).
 *     `describe` is derived by the row builder, never a registered command;
 *  4. the epoch must EQUAL a fresh read of the authoritative mapping's `processEpoch`
 *     (`expired`): a serve credential binds the CURRENT incarnation.
 * The returned artifact carries the verified surface, the derived descriptor, and the
 * registration revision. The MINT's fence is the durable issuance gate ({@link
 * finalizeServeIssuance}), NOT this authorization (a read is never a fence, §13.1): this seam
 * produces the surface, the gate serializes its release against takeover and re-registration.
 */
export async function authorizeServeGrant(
  kv: KV,
  args: {
    space: string;
    endpoint: string;
    instanceId: string;
    epoch: number;
    holder: { owner: string };
    authority: ServiceNameAuthority;
    readProcessEpoch: () => Promise<number> | number;
    /** The contract-store read seam (§13.7 digest subjects; the D8 tooling provides the
     *  production reader): the ARTIFACT stored at a digest subject (`epc.<digest>`) — a
     *  cluster MANIFEST at a closure digest, a cluster DOCUMENT at a root artifact digest — or
     *  `undefined` when the store has no such artifact (fail-closed). */
    readClusterArtifact: (digest: string) => Promise<unknown> | unknown;
  },
): Promise<EpServeGrant> {
  spacePrefix(args.space); // grammar: a malformed space token never becomes credential rows
  const iId = assertLifecycleToken(args.instanceId, "instanceId");
  if (!Number.isSafeInteger(args.epoch) || args.epoch < 0)
    throw new EpEnvelopeError("internal", `epoch ${args.epoch} is not an unsigned integer`);
  const specKey = recordSpecKey(RECORD_KINDS.svc, [args.endpoint, iId]);
  const specEntry = await kv.get(specKey);
  if (!specEntry || specEntry.operation !== "PUT")
    throw new EpEnvelopeError("failed-precondition", `no registered spec for "${args.endpoint}/${args.instanceId}"; a serve credential is minted only for a REGISTERED instance (SPEC 13.9)`);
  const spec = parseServiceSpec(decodeJson(specEntry.value, specKey), { endpoint: args.endpoint });
  assertBoundedOwner(args.holder.owner, "serve credential holder");
  if (args.holder.owner !== spec.owner)
    throw new EpEnvelopeError("permission-denied", `the serve credential holder "${args.holder.owner}" is not the registered owner "${spec.owner}" of "${args.endpoint}" (SPEC 13.9: serving is the registered owner's authority)`);
  // §13.9 name authority: ONE atomic snapshot binds the owner DECISION and the binding REVISION
  // together (never a torn owner-vs-revision read, engineer/distsys/security). The revision is
  // RECORDED (not fenced here — a read is never a fence, §13.1); the issuance gate carries it and
  // the mint refuses on drift, so a name transfer after this authorization can never release an
  // old-owner credential.
  const nameAuthorityRevision = await assertServiceNameAuthority(spec.endpoint, spec.owner, args.authority);

  // §13.7 two-stage content-address read: the registered digest is a CLOSURE digest naming a
  // MANIFEST; the manifest's `root` names the cluster DOCUMENT. Both fetched, both verified —
  // a raw root document presented at a closure-digest key would conflate the two identities.
  const read = async (digest: string, what: string): Promise<unknown> => {
    let raw: unknown;
    try {
      raw = await args.readClusterArtifact(digest);
    } catch (err) {
      throw new EpEnvelopeError("unavailable", `the contract-store read seam failed for ${what} ${digest}; serve authorization fails closed (SPEC 13.7): ${(err as Error)?.message ?? String(err)}`);
    }
    if (raw === undefined)
      throw new EpEnvelopeError("failed-precondition", `${what} ${digest} is not readable from the contract store; an unverifiable registered surface never authorizes (SPEC 13.7)`);
    return raw;
  };
  const surface: Record<string, EpCommandAuthority> = {};
  const commands: string[] = [];
  const clusters: { digest: string; document: ClusterDocument; raw: Record<string, unknown> }[] = [];
  for (const closureDigest of spec.clusterDigests) {
    const manifestRaw = await read(closureDigest, "registered cluster manifest");
    let root: string;
    try {
      ({ root } = verifyClusterManifest(closureDigest, manifestRaw));
    } catch (err) {
      throw new EpEnvelopeError("internal", `registered cluster manifest ${closureDigest} of "${args.endpoint}/${args.instanceId}" fails verification; mediated registered state that does not verify is a writer/store bug, never authority (SPEC 13.7): ${(err as Error).message}`);
    }
    const rootRaw = await read(root, "registered cluster document");
    let document: ClusterDocument;
    try {
      document = verifyClusterRoot(root, rootRaw);
    } catch (err) {
      throw new EpEnvelopeError("internal", `registered cluster document ${root} (closure ${closureDigest}) fails verification; mediated registered state that does not verify is never authority (SPEC 13.7): ${(err as Error).message}`);
    }
    for (const cmd of document.commands) {
      if (surface[cmd.name] !== undefined)
        throw new EpEnvelopeError("internal", `the registered clusters of "${args.endpoint}" declare command "${cmd.name}" twice; an ambiguous registered surface never authorizes (SPEC 13.7)`);
      surface[cmd.name] = Object.freeze({
        clusterDigest: closureDigest,
        class: cmd.class,
        targeted: cmd.targeted,
        modes: Object.freeze([...(cmd.modes ?? [])]) as readonly EpAuthzMode[],
        capability: cmd.capability,
        inputDigest: cmd.inputDigest,
        outputDigest: cmd.outputDigest,
        traits: Object.freeze([...(cmd.traits ?? [])]) as readonly string[],
      });
      commands.push(cmd.name);
    }
    // The inline copy for describe is the verified ROOT cluster DOCUMENT (its command
    // declarations), never the manifest: a consumer verifies it against the advertised closure
    // digest by reconstructing the single-member manifest `{v:1, root: digest(document),
    // members:[]}` (§13.7 two-digest read). Inlining the manifest would ship bytes whose
    // `commands` disagree with the sibling command list.
    clusters.push({ digest: closureDigest, document, raw: rootRaw as Record<string, unknown> });
  }
  commands.sort(); // deterministic full surface

  const current = await args.readProcessEpoch();
  if (!Number.isSafeInteger(current) || current < 0)
    throw new EpEnvelopeError("internal", `the authoritative mapping read returned ${JSON.stringify(current)}, not an unsigned processEpoch`);
  if (args.epoch !== current)
    throw new EpEnvelopeError("expired", `serve grant for epoch ${args.epoch} but the authoritative mapping's current processEpoch is ${current}; a serve credential binds the CURRENT incarnation only (SPEC 13.1/13.9)`);

  const grant: EpServeGrant = Object.freeze({
    space: args.space,
    endpoint: spec.endpoint,
    instanceId: iId,
    epoch: args.epoch,
    owner: spec.owner,
    registrationRevision: specEntry.revision,
    nameAuthorityRevision,
    commands: Object.freeze([...commands]) as readonly string[],
    surface: Object.freeze(surface),
    descriptor: deriveDescriptor(
      { endpoint: spec.endpoint, owner: spec.owner, ...(spec.endpointType !== undefined ? { endpointType: spec.endpointType } : {}) },
      clusters,
    ),
  });
  AUTHORIZED_SERVE.set(grant, {
    space: args.space, endpoint: spec.endpoint, instanceId: iId, epoch: args.epoch,
    owner: spec.owner, registrationRevision: specEntry.revision, nameAuthorityRevision, commands: [...commands],
  });
  return grant;
}

/** The brand check every consuming seam runs: `serve` must be the ARTIFACT
 *  {@link authorizeServeGrant} returned, field-for-field equal to its authorized snapshot. A
 *  structural copy, a raw literal, or a diverging value refuses — serve authority flows only
 *  THROUGH the registry authorization. Returns the immutable snapshot (space/owner/epoch/
 *  registrationRevision the release fence checks against). */
export function assertServeGrantAuthorized(serve: EpServeGrant): AuthorizedServe {
  const snap = AUTHORIZED_SERVE.get(serve);
  if (!snap)
    throw new EpEnvelopeError("permission-denied", "the serve artifact was not authorized against the registered service (authorizeServeGrant); a raw or copied value never carries serve authority (SPEC 13.9)");
  if (snap.space !== serve.space || snap.endpoint !== serve.endpoint || snap.instanceId !== serve.instanceId
    || snap.epoch !== serve.epoch || snap.owner !== serve.owner || snap.registrationRevision !== serve.registrationRevision
    || snap.nameAuthorityRevision !== serve.nameAuthorityRevision
    || snap.commands.length !== serve.commands.length || snap.commands.some((cmd, i) => serve.commands[i] !== cmd))
    throw new EpEnvelopeError("permission-denied", "the serve artifact diverges from its authorized snapshot; refusing mutated serve authority (SPEC 13.9)");
  return snap;
}

/** The mint-side CONTEXT binding (`permissionsFor`, profile `endpoint-serve`): brand + snapshot
 *  equality plus the mint context bound to the artifact (same space, and the minted principal
 *  IS the registered owner — an authorized artifact for space A/owner X emits rows for no other
 *  space or principal). This is NOT the freshness fence: {@link finalizeServeIssuance} is, and
 *  `mintCreds` runs it before releasing the credential. */
export function assertServeGrantMintable(serve: EpServeGrant, mint: { space: string; holderOwner: string }): AuthorizedServe {
  const snap = assertServeGrantAuthorized(serve);
  if (mint.space !== snap.space)
    throw new EpEnvelopeError("permission-denied", `the serve artifact was authorized for space "${snap.space}", not "${mint.space}"; serve authority never crosses spaces (SPEC 13.9)`);
  if (mint.holderOwner !== snap.owner)
    throw new EpEnvelopeError("permission-denied", `the serve artifact belongs to the registered owner "${snap.owner}"; principal "${mint.holderOwner}" cannot mint from it (SPEC 13.9)`);
  return snap;
}

// ---- the durable issuance fence (§13.1 "A read is never a fence; only a CAS write is") --------

/** The observed state of an instance's durable issuance gate (§13.1: the auth bucket's
 *  `gate.<lifecycleUid>`, leader-served with `allow_direct=false` so a read is read-your-writes,
 *  never a follower's stale `open`). ONE key binds ALL THREE currency authorities the serve mint
 *  depends on: `processEpoch` (advanced by a takeover barrier), `registrationRevision` (advanced
 *  by a re-registration barrier), and `nameAuthorityRevision` (advanced when the endpoint NAME's
 *  authority binding transfers, §13.9). `generation` is a monotonic freeze/reopen counter (every
 *  barrier bumps it, so a superseded mint's rebuilt CAS loses even if two coordinates coincide).
 *  `revision` is the KV store revision the mint's CAS and every barrier's freeze pin. */
export interface EpGateState {
  /** The gate's space. In production the gate physically lives in the per-space
   *  `KV_cotal_auth_<space>` bucket (§13.9:2393), so the space is the bucket and cannot be crossed;
   *  carrying it here is defense-in-depth for the in-memory seam/fake, so a mint/registration
   *  handed a gate constructed for another space is refused rather than trusting the caller wired
   *  the right bucket. */
  space: string;
  /** The gate's OWN instance identity, `(endpoint, lifecycleUid)` (§13.1). For an endpoint the
   *  lifecycle identity is `instanceId`, which SPEC 13.1:1008-1013 makes unique only within
   *  `(space, endpoint)` (its ≥128-bit CSPRNG entropy is what makes the SPEC's `gate.<lifecycleUid>`
   *  key collision-free within the space bucket). Binding the ENDPOINT here is the explicit
   *  identity check that does not rely on that entropy: a caller that passes a DIFFERENT endpoint's
   *  gate sharing the instance token (or any wrong gate) is refused, never confused, and the
   *  credential family stays per-`(endpoint, instance)`. When D13/D14 wires the durable keys BOTH
   *  families must carry the endpoint (`gate.<endpoint>.<lifecycleUid>` AND the credential-ledger
   *  key, whose SPEC example `cred.<lifecycleUid>.<credentialId>` is likewise endpoint-blind), so the
   *  key derivation matches this check rather than leaning on the instance-token entropy alone. Exact
   *  endpoint-qualified shape is subject to the frozen-SPEC reconciliation (the recorded gate). */
  endpoint: string;
  lifecycleUid: string;
  state: "open" | "frozen" | "retired";
  generation: number;
  processEpoch: number;
  registrationRevision: number;
  nameAuthorityRevision: number;
  revision: number;
}

/** The successor gate coordinate a barrier reopens at (§13.1): the three currency dimensions plus
 *  the bumped `generation`. A re-registration advances `registrationRevision`; a takeover advances
 *  `processEpoch`; a name transfer advances `nameAuthorityRevision`; each also bumps `generation`. */
export interface EpGateSuccessor {
  generation: number;
  processEpoch: number;
  registrationRevision: number;
  nameAuthorityRevision: number;
}

/** One staged credential-ledger row (§13.1 `cred.<lifecycleUid>.<credentialId>` - the SPEC example
 *  is endpoint-blind; D13/D14 must endpoint-qualify this key family too, see EpGateState.endpoint):
 *  written BEFORE
 *  the winning CAS and carrying the NORMATIVE ledger fields (§13.1) so a later barrier's
 *  enumeration can find the credential, prove which surface/incarnation it covered, and EVICT its
 *  holder:
 *   - `credentialId` is the PER-ISSUED-JWT identity (a digest of the credential), so standing
 *     renewal (multiple JWTs for one nkey) writes a DISTINCT row each time — the §13.1 invariant
 *     "every credential ever released resolves to a row" holds, and monotonic `state` is never
 *     overwritten by a re-mint;
 *   - `credentialKey` is the stable holder NKEY the broker revokes by (many JWTs share it);
 *   - `holderPrincipal` (owner.actor) is what cluster-wide eviction targets;
 *   - `lifecycleUid` is the instance's never-reused lifecycle identity (the gate key);
 *   - `sourceChain` is the credential's §13.1 issuance lineage (`root` | `handle.…` | `session.…`);
 *   - `state` is monotonic — a barrier flips `active`→`revoked`, never back;
 *   - `exp` is the credential's expiry (for ledger audit/GC);
 *   - the three currency coordinates + `generation` pin the incarnation the surface covered. */
export interface EpServeLedgerRow {
  credentialId: string;
  credentialKey: string;
  holderPrincipal: string;
  /** The served endpoint — the instance token is unique only within `(space, endpoint)`, so the
   *  credential family is keyed by `(endpoint, lifecycleUid)`, never the instance token alone. */
  endpoint: string;
  lifecycleUid: string;
  sourceChain: readonly string[];
  state: "active" | "revoked";
  exp?: number;
  generation: number;
  processEpoch: number;
  registrationRevision: number;
  nameAuthorityRevision: number;
}

/** The MINT half of the durable, single-key issuance-gate seam the serve release fence rides
 *  (§13.1). One gate per instance; production wires it to `gate.<lifecycleUid>` in the credential
 *  ledger (the D13/D14 auth path, `allow_direct=false`, revision-pinned CAS). A takeover, a
 *  re-registration, and a name transfer are each a {@link EpIssuanceBarrier} that CASes this SAME
 *  key to `frozen` before proceeding and reopens it at the successor coordinate, so mint-finalize
 *  and every barrier serialize on one key — never a pseudo-transaction across two. */
export interface EpIssuanceGate {
  /** Leader-served read of the gate; `null` when there is no gate for this instance (fail
   *  closed — a serve credential never mints against a missing gate). */
  observe: () => Promise<EpGateState | null> | EpGateState | null;
  /** Write the staged credential-ledger row (the §13.1 "write rows" step), before the CAS.
   *  CREATE-ONLY / idempotent-if-identical: staging a `credentialId` that is already present must
   *  succeed only when the row is byte-identical (a retry of the SAME issuance), and CONFLICT when
   *  it differs (a different holder/lineage must never overwrite the row revocation/audit relies
   *  on). Because `credentialId` is a per-JWT digest, a re-mint is a new id, never an overwrite. */
  stage: (row: EpServeLedgerRow) => Promise<void> | void;
  /** Revision-pinned CAS: keep the gate `open`, unchanged, at `expectedRevision`. TRUE iff this
   *  mint won the single-key serialization; FALSE on any change (a freeze/retire, or a
   *  reopen at a new generation/epoch/registrationRevision/nameAuthorityRevision advanced the
   *  revision). */
  commit: (expectedRevision: number) => Promise<boolean> | boolean;
  /** Mark the staged row revoked on CAS loss / abort (the credential is never released). */
  revoke: (row: EpServeLedgerRow) => Promise<void> | void;
}

/** The BARRIER half of the SAME single-key gate (§13.1): the typed protocol a takeover, a
 *  re-registration, or a name transfer runs to serialize itself against in-flight serve mints —
 *  NOT ad-hoc mutation. A barrier freezes the gate FIRST (so a fresh mint observes `frozen` and
 *  refuses, and a staged-but-uncommitted mint loses its revision-pinned CAS), enumerates the
 *  ledger rows the superseded surface authorized, revokes/evicts them, then reopens at the
 *  successor coordinate (advancing the dimension it changed). Both halves are exported TOGETHER
 *  so core never publishes an independently-callable unsafe writer beside the fence: the spec
 *  writer {@link registerServiceInstance} drives this seam and has no bare spec-key advance. */
export interface EpIssuanceBarrier {
  /** Leader-served read of the gate (same key as the mint's {@link EpIssuanceGate.observe}). */
  observe: () => Promise<EpGateState | null> | EpGateState | null;
  /** Revision-pinned CAS `open` → `frozen` at `expectedRevision`, returning the FENCING TOKEN
   *  (the frozen store revision) on success, or `null` on loss (another barrier froze/reopened,
   *  or the gate retired) — a loser MUST abort and never write the spec. The token is consumed by
   *  {@link reopen} so ONLY the barrier that still holds its freeze can reopen: a stalled/duplicate
   *  barrier resuming after a reconciler cannot clobber the newer gate (§13.1). */
  freeze: (expectedRevision: number) => Promise<number | null> | number | null;
  /** Enumerate the credential-ledger rows under the frozen gate (§13.1 "enumerate the family"):
   *  every credential the incarnation the barrier supersedes authorized. */
  enumerate: () => Promise<EpServeLedgerRow[]> | EpServeLedgerRow[];
  /** Flip one enumerated row `active`→`revoked` (§13.1: enforce revocation on the ledger). */
  revoke: (row: EpServeLedgerRow) => Promise<void> | void;
  /** VERIFIED cluster-wide eviction of a revoked `holderPrincipal` (§13.1): enforce the
   *  revocation on every server, evict the principal's live connections, and RE-SCAN — returning
   *  `true` only when the principal is verified GONE. FAIL-CLOSED: `false` (or a throw) means the
   *  barrier MUST NOT complete (no spec write, no reopen); the gate stays frozen for reconciliation
   *  so old authority is never published-over while it is still live. */
  evict: (holderPrincipal: string) => Promise<boolean> | boolean;
  /** Token-pinned CAS `frozen` → `open` at the successor coordinate (§13.1). TRUE iff the gate is
   *  still frozen at THIS barrier's `token`; FALSE if a reconciler/newer barrier superseded it (a
   *  stale reopen loses and never clobbers the newer gate). Advances the currency the barrier
   *  changed, so a superseded mint's rebuilt CAS still loses. */
  reopen: (token: number, successor: EpGateSuccessor) => Promise<boolean> | boolean;
}

/** The minted-credential context the release fence records into its §13.1 ledger row: the
 *  credential's own identity, its holder ACTOR (the owner comes from the authorized grant, so the
 *  eviction target `holderPrincipal` = `owner.actor`), its provenance lineage, and its expiry.
 *  `mintCreds` supplies these from the same values it stamps into the JWT — the ledger row and
 *  the credential describe ONE credential, never two. */
export interface EpServeCredential {
  /** PER-ISSUED-JWT identity (a digest of the credential): the ledger key, unique per JWT so a
   *  standing renewal never overwrites the prior row. */
  credentialId: string;
  /** The stable holder NKEY (public key) the broker revokes by; many JWTs share it. */
  credentialKey: string;
  /** The holder's actor (owner.actor is the §13.1 eviction target). */
  holderActor: string;
  /** The credential's §13.1 issuance lineage: each element `root` | `handle.<issuerKeyId>.<id>` |
   *  `session.<sessionId>` (a root serve mint is `["root"]`). */
  sourceChain: readonly string[];
  /** The credential's expiry (unix seconds), or `undefined` for a non-expiring credential. */
  exp?: number;
}

/** A §13.1 source-chain element, EXACT grammar: the `root` anchor, a handle-redemption step
 *  `handle.<issuerKeyId>.<id>` (exactly two record-grammar id segments), or a session step
 *  `session.<sessionId>` (exactly one). Owner/actor principal components are NOT a lineage; the
 *  mint records `["root"]` for a serve credential minted directly by the provisioner authority.
 *  Ids are the record grammar `[A-Za-z0-9_-]` (uppercase admitted), bounded, and every segment is
 *  non-empty — so `handle.x`, `handle.x.`, and `session.x.y` all refuse. */
const SOURCE_CHAIN_ID = "[A-Za-z0-9_-]{1,64}"; // the §13.2:1248 / assertIdToken id bound
const SOURCE_CHAIN_ELEMENT = new RegExp(`^(root|handle\\.${SOURCE_CHAIN_ID}\\.${SOURCE_CHAIN_ID}|session\\.${SOURCE_CHAIN_ID})$`);

/**
 * The serve-credential release fence (§13.1 "observe gate → write rows → CAS the gate →
 * release"). `mintCreds` calls this AFTER building the credential and BEFORE returning it, so a
 * credential is released only when its ledger row is durably written and its winning CAS proves
 * the gate was still `open` at the SAME `(processEpoch, registrationRevision, nameAuthorityRevision)`
 * the artifact was verified against:
 *  - observe the gate; a missing gate or a `frozen`/`retired` state refuses (`expired`);
 *  - the observed `processEpoch`, `registrationRevision`, and `nameAuthorityRevision` MUST each
 *    equal the artifact's — a takeover (epoch), a re-registration (revision), or a name transfer
 *    (name authority) that already froze+reopened advanced one of them, and this mint's surface
 *    or its owner is superseded (`expired`);
 *  - stage the NORMATIVE ledger row (`holderPrincipal`/`lifecycleUid`/`sourceChain`/`state`/`exp`
 *    plus the three currency coordinates), then revision-pinned CAS the gate; a LOSS (a
 *    concurrent barrier's freeze CAS won the single key) revokes the staged row and releases
 *    nothing (`expired`).
 * The race is closed by serialization on ONE key: a mint that wins wrote its row before its
 * winning CAS, so a later barrier enumerates and revokes/evicts it by `holderPrincipal`; a mint
 * that loses never released.
 */
export async function finalizeServeIssuance(gate: EpIssuanceGate, serve: EpServeGrant, credential: EpServeCredential): Promise<void> {
  const snap = assertServeGrantAuthorized(serve);
  const boundedId = (v: unknown): v is string => typeof v === "string" && v.length > 0 && v.length <= 128;
  if (!boundedId(credential.credentialId))
    throw new EpEnvelopeError("internal", "credentialId must be a bounded non-empty per-JWT identifier");
  if (!boundedId(credential.credentialKey))
    throw new EpEnvelopeError("internal", "credentialKey must be a bounded non-empty identifier (the minted credential's nkey)");
  assertBoundedOwner(credential.holderActor, "serve credential holder actor");
  if (!Array.isArray(credential.sourceChain) || credential.sourceChain.length === 0
    || !credential.sourceChain.every((p) => typeof p === "string" && SOURCE_CHAIN_ELEMENT.test(p)))
    throw new EpEnvelopeError("internal", "the serve credential sourceChain must be a non-empty §13.1 issuance lineage (root | handle.<issuer>.<id> | session.<id>), never principal components");
  if (credential.exp !== undefined && (!Number.isSafeInteger(credential.exp) || credential.exp < 0))
    throw new EpEnvelopeError("internal", `the serve credential exp ${JSON.stringify(credential.exp)} is not an unsigned unix timestamp`);
  const obs = await gate.observe();
  if (obs === null)
    throw new EpEnvelopeError("expired", `no issuance gate for "${snap.endpoint}/${snap.instanceId}"; a serve credential never mints against a missing gate (SPEC 13.1)`);
  // Gate IDENTITY `(space, endpoint, lifecycleUid)`: the instance token is unique only within
  // `(space, endpoint)`, so ALL must match — a caller that handed a foreign gate (another space's,
  // a different endpoint sharing the instance token, or any wrong gate) with coincidentally
  // matching coordinates is refused (the per-space auth bucket is the production space fence; this
  // is the seam's defense-in-depth).
  if (obs.space !== snap.space || obs.endpoint !== snap.endpoint || obs.lifecycleUid !== snap.instanceId)
    throw new EpEnvelopeError("internal", `the issuance gate is for "${obs.space}/${obs.endpoint}/${obs.lifecycleUid}", not the authorized instance "${snap.space}/${snap.endpoint}/${snap.instanceId}"; a serve credential mints only against its OWN gate (SPEC 13.1)`);
  if (obs.state !== "open")
    throw new EpEnvelopeError("expired", `the issuance gate for "${snap.endpoint}/${snap.instanceId}" is ${obs.state}; minting is closed (SPEC 13.1)`);
  // JOINT currency on ONE key: a takeover advances processEpoch, a re-registration advances
  // registrationRevision, a name transfer advances nameAuthorityRevision; any one that has
  // already frozen+reopened the gate supersedes the branded surface or its owner, and the read
  // below is safe only because the CAS re-checks the same key.
  if (obs.processEpoch !== snap.epoch)
    throw new EpEnvelopeError("expired", `the issuance gate is at processEpoch ${obs.processEpoch}, not the authorized ${snap.epoch}; a takeover superseded this incarnation (SPEC 13.1)`);
  if (obs.registrationRevision !== snap.registrationRevision)
    throw new EpEnvelopeError("expired", `the issuance gate is at registrationRevision ${obs.registrationRevision}, not the authorized ${snap.registrationRevision}; a re-registration superseded the branded surface (SPEC 13.5/13.9)`);
  if (obs.nameAuthorityRevision !== snap.nameAuthorityRevision)
    throw new EpEnvelopeError("expired", `the issuance gate is at nameAuthorityRevision ${obs.nameAuthorityRevision}, not the authorized ${snap.nameAuthorityRevision}; a name transfer superseded the serving owner (SPEC 13.9)`);
  const row: EpServeLedgerRow = {
    credentialId: credential.credentialId,
    credentialKey: credential.credentialKey,
    // The eviction target, serialized through the ONE principal serializer the eviction feed keys
    // on (never an ad-hoc `owner.actor` join, subjects.ts principalKey invariant) so the barrier's
    // enumeration key can never drift from the credential's.
    holderPrincipal: principalKey(snap.owner, credential.holderActor).key,
    endpoint: snap.endpoint,
    lifecycleUid: snap.instanceId,
    sourceChain: Object.freeze([...credential.sourceChain]),
    state: "active",
    ...(credential.exp !== undefined ? { exp: credential.exp } : {}),
    generation: obs.generation,
    processEpoch: obs.processEpoch,
    registrationRevision: obs.registrationRevision,
    nameAuthorityRevision: obs.nameAuthorityRevision,
  };
  await gate.stage(row);
  // Best-effort revoke of the staged row on any non-win, ALWAYS surfacing a revoke failure (never
  // swallowed) so the reconciliation debt is visible — the credential is released only on a win.
  const revokeStaged = async (): Promise<string | undefined> => {
    try { await gate.revoke(row); return undefined; }
    catch (err) { return (err as Error)?.message ?? String(err); }
  };
  let won: boolean;
  try {
    won = await gate.commit(obs.revision);
  } catch (err) {
    const revokeFailed = await revokeStaged();
    throw new EpEnvelopeError("unavailable", `the issuance-gate CAS failed; refusing to release a serve credential (SPEC 13.1): ${(err as Error)?.message ?? String(err)}${revokeFailed ? `; ALSO the staged-row revoke failed and the row needs barrier reconciliation: ${revokeFailed}` : ""}`);
  }
  if (!won) {
    const revokeFailed = await revokeStaged();
    throw new EpEnvelopeError("expired", `the issuance gate advanced during mint (a takeover, re-registration, or name transfer won the serialization on ${snap.endpoint}/${snap.instanceId}); this mint released nothing (SPEC 13.1)${revokeFailed ? `; ALSO the staged-row revoke failed and the row needs barrier reconciliation: ${revokeFailed}` : ""}`);
  }
}
