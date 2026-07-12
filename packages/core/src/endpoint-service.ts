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
 *  REGISTERED domain owner. Both answers come from the deployment's trusted registry, never
 *  from the registrant's claim. */
export interface ServiceNameAuthority {
  /** True iff `owner` holds operator provisioning authority for core (single-label) names. */
  isOperatorOwner(owner: string): boolean;
  /** The registered owner of a reverse-DNS name, or `undefined` when unregistered (fail-closed). */
  domainOwnerOf(name: string): string | undefined;
  /** The store revision of the NAME's authority binding (§13.9): a monotonic coordinate that
   *  advances whenever the name is transferred to a different owner or its operator-authority
   *  grant changes. It is a THIRD currency dimension the serve mint fences on (§13.1: a read is
   *  never a fence). {@link authorizeServeGrant} records it into the artifact, the issuance gate
   *  carries it, and {@link finalizeServeIssuance} refuses when it has advanced — so a name
   *  transfer AFTER authorization can never release an old-owner credential, exactly as a
   *  takeover (epoch) or re-registration (registrationRevision) cannot. The production reader is
   *  the trusted name-authority registry (§13.9); a transfer freezes+reopens every affected
   *  instance gate advancing this coordinate. */
  authorityRevision(name: string): number;
}

/** Enforce §13.9 name authority before a registration is written: an endpoint name binds to
 *  exactly ONE owner (§13.2), so the name alone determines the serving owner — a registration
 *  claiming a name its owner does not hold fails `permission-denied`, and an UNREGISTERED
 *  reverse-DNS name fails closed rather than being adopted first-come. */
export function assertServiceNameAuthority(endpoint: string, owner: string, authority: ServiceNameAuthority): void {
  endpointToken(endpoint); // grammar first: a malformed name is refused before any authority answer
  assertBoundedOwner(owner, "service owner");
  if (!endpoint.includes(".")) {
    if (!authority.isOperatorOwner(owner))
      throw new EpEnvelopeError("permission-denied", `core service name "${endpoint}" requires operator provisioning authority; owner "${owner}" does not hold it (SPEC 13.9)`);
    return;
  }
  const registered = authority.domainOwnerOf(endpoint);
  if (registered === undefined)
    throw new EpEnvelopeError("permission-denied", `reverse-DNS service name "${endpoint}" has no registered owner; an unregistered name is never adopted first-come (SPEC 13.9)`);
  if (registered !== owner)
    throw new EpEnvelopeError("permission-denied", `reverse-DNS service name "${endpoint}" is registered to "${registered}", not "${owner}" (SPEC 13.9)`);
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
 *  `gate.<lifecycleUid>` key — freeze the gate (so a fresh mint observes `frozen` and refuses, and
 *  a staged-but-uncommitted mint loses its revision-pinned CAS), advance the spec, enumerate and
 *  revoke the ledger rows the superseded surface authorized, then reopen at the successor
 *  `registrationRevision`. This is REQUIRED, not documented: core exports no bare spec-key advance
 *  that could leave a mint's observed `registrationRevision` permanently equal to its snapshot,
 *  win a never-frozen CAS, and silently release a superseded-surface credential. The gate is
 *  created by the provisioner at instance mint (D13); a missing gate is `failed-precondition`. The
 *  production `barrier` wires to the durable KV CAS (D13/D14); the D4 seam is the typed protocol
 *  and its faithful in-memory model, so the barrier's writes serialize with the mint's on one key. */
export async function registerServiceInstance(
  kv: KV,
  args: { spec: ServiceSpec; instanceId: string; registrant: { owner: string }; authority: ServiceNameAuthority; barrier: EpIssuanceBarrier },
): Promise<{ registrationRevision: number }> {
  const spec = parseServiceSpec(args.spec, { endpoint: args.spec.endpoint });
  assertBoundedOwner(args.registrant.owner, "registrant owner");
  if (args.registrant.owner !== spec.owner)
    throw new EpEnvelopeError("permission-denied", `the registration's authenticated caller "${args.registrant.owner}" is not the descriptor owner "${spec.owner}" (SPEC 13.9: authenticated caller binding, never a payload claim)`);
  assertServiceNameAuthority(spec.endpoint, spec.owner, args.authority);
  const key = recordSpecKey(RECORD_KINDS.svc, [spec.endpoint, assertLifecycleToken(args.instanceId, "instanceId")]);

  // §13.1 barrier: freeze the instance's gate FIRST so no serve mint can win against the surface
  // this registration is about to supersede. A non-open gate or a lost freeze is another barrier
  // holding the key — a loud `conflict` (§13.8: re-read and re-decide), never a bare write.
  const obs = await args.barrier.observe();
  if (obs === null)
    throw new EpEnvelopeError("failed-precondition", `no issuance gate for instance "${args.instanceId}"; a registration writes only behind the provisioner-created gate (SPEC 13.1)`);
  if (obs.state === "retired")
    throw new EpEnvelopeError("failed-precondition", `the issuance gate for "${args.instanceId}" is retired; the lifecycle is permanently closed and its id is never reused, so a re-read cannot help (SPEC 13.1)`);
  if (obs.state !== "open")
    throw new EpEnvelopeError("conflict", `the issuance gate for "${args.instanceId}" is ${obs.state}; another barrier holds it — re-read and re-decide (SPEC 13.8)`);
  if (!(await args.barrier.freeze(obs.revision)))
    throw new EpEnvelopeError("conflict", `a concurrent barrier froze the issuance gate for "${args.instanceId}" first; re-read and re-decide (SPEC 13.1/13.8)`);

  // The gate is frozen; every exit below MUST reopen it — at the original coordinate if nothing
  // was written, or at the successor once the spec advanced.
  let newRev: number;
  try {
    const current = await kv.get(key);
    if (current && current.operation === "PUT") {
      const stored = parseServiceSpec(decodeJson(current.value, key), { endpoint: spec.endpoint });
      if (stored.owner !== spec.owner)
        throw new EpEnvelopeError("permission-denied", `instance "${args.instanceId}" is registered to owner "${stored.owner}"; a re-registration can never change ownership (SPEC 13.1: instance ids are never reused across identities)`);
      newRev = await updateRecordEntry(kv, key, spec, current.revision);
    } else {
      newRev = await createRecordEntry(kv, key, spec);
    }
  } catch (err) {
    // Nothing was written — restore the gate to its original currency (bumped generation, so a
    // mid-flight mint's revision pin still loses) and rethrow the original failure.
    await reopenGateAfterAbort(args.barrier, obs, err);
    throw err;
  }

  // The spec advanced to newRev: evict every credential the superseded surface authorized, then
  // reopen at the successor registrationRevision. If the barrier does not complete, the gate is
  // left frozen (fail-closed: no mint proceeds on a frozen gate) for reconciliation.
  try {
    for (const row of await args.barrier.enumerate())
      if (row.state === "active") await args.barrier.revoke(row);
    await args.barrier.reopen({
      generation: obs.generation + 1,
      processEpoch: obs.processEpoch,
      registrationRevision: newRev,
      nameAuthorityRevision: obs.nameAuthorityRevision,
    });
  } catch (err) {
    throw new EpEnvelopeError("unavailable", `re-registration wrote the spec at revision ${newRev} but the issuance barrier did not complete; the gate is left frozen for reconciliation (SPEC 13.1): ${(err as Error)?.message ?? String(err)}`);
  }
  return { registrationRevision: newRev };
}

/** Restore a barrier-frozen gate to `open` at its ORIGINAL currency (bumped generation) after a
 *  registration aborted before any spec write. A failed reopen leaves the gate frozen for
 *  reconciliation and is surfaced with the aborting cause attached (§13.1: fail closed, never a
 *  silently stuck gate). */
async function reopenGateAfterAbort(barrier: EpIssuanceBarrier, obs: EpGateState, cause: unknown): Promise<void> {
  try {
    await barrier.reopen({
      generation: obs.generation + 1,
      processEpoch: obs.processEpoch,
      registrationRevision: obs.registrationRevision,
      nameAuthorityRevision: obs.nameAuthorityRevision,
    });
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
  assertServiceNameAuthority(spec.endpoint, spec.owner, args.authority);
  // §13.9 name-authority coordinate: the revision the owner was verified against, RECORDED (not
  // fenced — a read is never a fence, §13.1). The issuance gate carries it and the mint refuses
  // on drift, so a name transfer after this authorization can never release an old-owner cred.
  const nameAuthorityRevision = args.authority.authorityRevision(spec.endpoint);
  if (!Number.isSafeInteger(nameAuthorityRevision) || nameAuthorityRevision < 0)
    throw new EpEnvelopeError("internal", `the name-authority revision for "${spec.endpoint}" is ${JSON.stringify(nameAuthorityRevision)}, not an unsigned integer`);

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

/** One staged credential-ledger row (§13.1 `cred.`/`bysrc.`): written BEFORE the winning CAS and
 *  carrying the NORMATIVE ledger fields (§13.1) so a later barrier's enumeration can find the
 *  credential, prove which surface/incarnation it covered, and EVICT its holder:
 *   - `holderPrincipal` (owner+actor) is what cluster-wide eviction targets;
 *   - `lifecycleUid` is the instance's never-reused lifecycle identity (the gate key);
 *   - `sourceChain` is the credential's provenance lineage (who delegated it);
 *   - `state` is monotonic — a barrier flips `active`→`revoked`, never back;
 *   - `exp` is the credential's expiry (for ledger audit/GC);
 *   - the three currency coordinates + `generation` pin the incarnation the surface covered. */
export interface EpServeLedgerRow {
  credentialId: string;
  holderPrincipal: string;
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
   *  Create-safe: staging the same `credentialId` twice is the caller's retry, not a new row. */
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
  /** Revision-pinned CAS `open` → `frozen` at `expectedRevision`. TRUE iff this barrier won the
   *  single key; FALSE on any change (another barrier froze/reopened, or the gate retired) — the
   *  caller MUST abort and never write the spec, so no writer proceeds on a stale gate. */
  freeze: (expectedRevision: number) => Promise<boolean> | boolean;
  /** Enumerate the credential-ledger rows under the frozen gate (§13.1 "enumerate the family"):
   *  every credential the incarnation the barrier supersedes authorized, so it can be revoked. */
  enumerate: () => Promise<EpServeLedgerRow[]> | EpServeLedgerRow[];
  /** Flip one enumerated row `active`→`revoked` (§13.1 eviction targets its `holderPrincipal`). */
  revoke: (row: EpServeLedgerRow) => Promise<void> | void;
  /** CAS `frozen` → `open` at the successor coordinate (§13.1): advancing the currency the
   *  barrier changed, so a superseded mint's rebuilt CAS still loses. */
  reopen: (successor: EpGateSuccessor) => Promise<void> | void;
}

/** The minted-credential context the release fence records into its §13.1 ledger row: the
 *  credential's own identity, its holder ACTOR (the owner comes from the authorized grant, so the
 *  eviction target `holderPrincipal` = `owner.actor`), its provenance lineage, and its expiry.
 *  `mintCreds` supplies these from the same values it stamps into the JWT — the ledger row and
 *  the credential describe ONE credential, never two. */
export interface EpServeCredential {
  /** The minted credential's public key (nkey). */
  credentialId: string;
  /** The holder's actor (owner+actor is the §13.1 eviction target). */
  holderActor: string;
  /** The credential's provenance chain (§13.1 `sourceChain`) — who delegated it. */
  sourceChain: readonly string[];
  /** The credential's expiry (unix seconds), or `undefined` for a non-expiring credential. */
  exp?: number;
}

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
  if (typeof credential.credentialId !== "string" || credential.credentialId.length === 0 || credential.credentialId.length > 128)
    throw new EpEnvelopeError("internal", "credentialId must be a bounded non-empty identifier (the minted credential's public key)");
  assertBoundedOwner(credential.holderActor, "serve credential holder actor");
  if (!Array.isArray(credential.sourceChain) || credential.sourceChain.length === 0 || !credential.sourceChain.every((p) => typeof p === "string" && p.length > 0))
    throw new EpEnvelopeError("internal", "the serve credential sourceChain must be a non-empty chain of principals (SPEC 13.1)");
  if (credential.exp !== undefined && (!Number.isSafeInteger(credential.exp) || credential.exp < 0))
    throw new EpEnvelopeError("internal", `the serve credential exp ${JSON.stringify(credential.exp)} is not an unsigned unix timestamp`);
  const obs = await gate.observe();
  if (obs === null)
    throw new EpEnvelopeError("expired", `no issuance gate for "${snap.endpoint}/${snap.instanceId}"; a serve credential never mints against a missing gate (SPEC 13.1)`);
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
    // The eviction target, serialized through the ONE principal serializer the eviction feed keys
    // on (never an ad-hoc `owner.actor` join, subjects.ts principalKey invariant) so the barrier's
    // enumeration key can never drift from the credential's.
    holderPrincipal: principalKey(snap.owner, credential.holderActor).key,
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
  let won: boolean;
  try {
    won = await gate.commit(obs.revision);
  } catch (err) {
    await Promise.resolve(gate.revoke(row)).catch(() => { /* the throw below reports the failure */ });
    throw new EpEnvelopeError("unavailable", `the issuance-gate CAS failed; refusing to release a serve credential (SPEC 13.1): ${(err as Error)?.message ?? String(err)}`);
  }
  if (!won) {
    let revokeFailed: string | undefined;
    try {
      await gate.revoke(row);
    } catch (err) {
      revokeFailed = (err as Error)?.message ?? String(err); // surfaced, never swallowed
    }
    throw new EpEnvelopeError("expired", `the issuance gate advanced during mint (a takeover, re-registration, or name transfer won the serialization on ${snap.endpoint}/${snap.instanceId}); this mint released nothing (SPEC 13.1)${revokeFailed ? `; ALSO the staged-row revoke failed and the row needs barrier reconciliation: ${revokeFailed}` : ""}`);
  }
}
