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
import { spacePrefix } from "./subjects.js";
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
 *  seam enforces what is checkable at the record: grammar, ownership stability, and CAS. */
export async function registerServiceInstance(
  kv: KV,
  args: { spec: ServiceSpec; instanceId: string; registrant: { owner: string }; authority: ServiceNameAuthority },
): Promise<{ registrationRevision: number }> {
  const spec = parseServiceSpec(args.spec, { endpoint: args.spec.endpoint });
  assertBoundedOwner(args.registrant.owner, "registrant owner");
  if (args.registrant.owner !== spec.owner)
    throw new EpEnvelopeError("permission-denied", `the registration's authenticated caller "${args.registrant.owner}" is not the descriptor owner "${spec.owner}" (SPEC 13.9: authenticated caller binding, never a payload claim)`);
  assertServiceNameAuthority(spec.endpoint, spec.owner, args.authority);
  const key = recordSpecKey(RECORD_KINDS.svc, [spec.endpoint, assertLifecycleToken(args.instanceId, "instanceId")]);
  const current = await kv.get(key);
  if (current && current.operation === "PUT") {
    const stored = parseServiceSpec(decodeJson(current.value, key), { endpoint: spec.endpoint });
    if (stored.owner !== spec.owner)
      throw new EpEnvelopeError("permission-denied", `instance "${args.instanceId}" is registered to owner "${stored.owner}"; a re-registration can never change ownership (SPEC 13.1: instance ids are never reused across identities)`);
    return { registrationRevision: await updateRecordEntry(kv, key, spec, current.revision) };
  }
  return { registrationRevision: await createRecordEntry(kv, key, spec) };
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
    commands: Object.freeze([...commands]) as readonly string[],
    surface: Object.freeze(surface),
    descriptor: deriveDescriptor(
      { endpoint: spec.endpoint, owner: spec.owner, ...(spec.endpointType !== undefined ? { endpointType: spec.endpointType } : {}) },
      clusters,
    ),
  });
  AUTHORIZED_SERVE.set(grant, {
    space: args.space, endpoint: spec.endpoint, instanceId: iId, epoch: args.epoch,
    owner: spec.owner, registrationRevision: specEntry.revision, commands: [...commands],
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
 *  never a follower's stale `open`). ONE key binds BOTH currency authorities the serve mint
 *  depends on: `processEpoch` (advanced by a takeover barrier) and `registrationRevision`
 *  (advanced by a re-registration barrier). `revision` is the KV store revision the mint's CAS
 *  pins. */
export interface EpGateState {
  state: "open" | "frozen" | "retired";
  generation: number;
  processEpoch: number;
  registrationRevision: number;
  revision: number;
}

/** One staged credential-ledger row (§13.1 `cred.`/`bysrc.`): written BEFORE the winning CAS
 *  and TAGGED with the exact authority tuple the credential authorizes, so a later barrier's
 *  enumeration both finds it and can prove which surface/incarnation it covered. */
export interface EpServeLedgerRow {
  credentialId: string;
  generation: number;
  processEpoch: number;
  registrationRevision: number;
}

/** The durable, single-key issuance-gate seam the serve mint's release fence rides (§13.1). One
 *  gate per instance; production wires it to `gate.<lifecycleUid>` in the credential ledger (the
 *  D13/D14 auth path, `allow_direct=false`, revision-pinned CAS). Both the takeover barrier and
 *  the re-registration barrier CAS this SAME key to `frozen` before proceeding and reopen it at
 *  the successor `(generation, processEpoch, registrationRevision)`, so mint-finalize and either
 *  barrier serialize on one key — never a pseudo-transaction across two. */
export interface EpIssuanceGate {
  /** Leader-served read of the gate; `null` when there is no gate for this instance (fail
   *  closed — a serve credential never mints against a missing gate). */
  observe: () => Promise<EpGateState | null> | EpGateState | null;
  /** Write the staged credential-ledger row (the §13.1 "write rows" step), before the CAS. */
  stage: (row: EpServeLedgerRow) => Promise<void> | void;
  /** Revision-pinned CAS: keep the gate `open`, unchanged, at `expectedRevision`. TRUE iff this
   *  mint won the single-key serialization; FALSE on any change (a freeze/retire, or a
   *  reopen at a new generation/epoch/registrationRevision advanced the revision). */
  commit: (expectedRevision: number) => Promise<boolean> | boolean;
  /** Mark the staged row revoked on CAS loss / abort (the credential is never released). */
  revoke: (row: EpServeLedgerRow) => Promise<void> | void;
}

/**
 * The serve-credential release fence (§13.1 "observe gate → write rows → CAS the gate →
 * release"). `mintCreds` calls this AFTER building the credential and BEFORE returning it, so a
 * credential is released only when its ledger row is durably written and its winning CAS proves
 * the gate was still `open` at the SAME `(generation, processEpoch, registrationRevision)` the
 * artifact was verified against:
 *  - observe the gate; a missing gate or a `frozen`/`retired` state refuses (`expired`);
 *  - the observed `processEpoch` and `registrationRevision` MUST equal the artifact's — a
 *    takeover (epoch) or re-registration (revision) that already froze+reopened advanced one of
 *    them, and this mint's surface is superseded (`expired`);
 *  - stage the ledger row (tagged with all three authority coordinates), then revision-pinned
 *    CAS the gate; a LOSS (a concurrent barrier's freeze CAS won the single key) revokes the
 *    staged row and releases nothing (`expired`).
 * The race is closed by serialization on ONE key: a mint that wins wrote its row before its
 * winning CAS, so a later barrier enumerates and revokes it; a mint that loses never released.
 */
export async function finalizeServeIssuance(gate: EpIssuanceGate, serve: EpServeGrant, credentialId: string): Promise<void> {
  const snap = assertServeGrantAuthorized(serve);
  if (typeof credentialId !== "string" || credentialId.length === 0 || credentialId.length > 128)
    throw new EpEnvelopeError("internal", "credentialId must be a bounded non-empty identifier (the minted credential's public key)");
  const obs = await gate.observe();
  if (obs === null)
    throw new EpEnvelopeError("expired", `no issuance gate for "${snap.endpoint}/${snap.instanceId}"; a serve credential never mints against a missing gate (SPEC 13.1)`);
  if (obs.state !== "open")
    throw new EpEnvelopeError("expired", `the issuance gate for "${snap.endpoint}/${snap.instanceId}" is ${obs.state}; minting is closed (SPEC 13.1)`);
  // JOINT currency on ONE key: a takeover advances processEpoch, a re-registration advances
  // registrationRevision; either that has already frozen+reopened the gate supersedes the
  // branded surface, and the read below is safe only because the CAS re-checks the same key.
  if (obs.processEpoch !== snap.epoch)
    throw new EpEnvelopeError("expired", `the issuance gate is at processEpoch ${obs.processEpoch}, not the authorized ${snap.epoch}; a takeover superseded this incarnation (SPEC 13.1)`);
  if (obs.registrationRevision !== snap.registrationRevision)
    throw new EpEnvelopeError("expired", `the issuance gate is at registrationRevision ${obs.registrationRevision}, not the authorized ${snap.registrationRevision}; a re-registration superseded the branded surface (SPEC 13.5/13.9)`);
  const row: EpServeLedgerRow = {
    credentialId, generation: obs.generation, processEpoch: obs.processEpoch, registrationRevision: obs.registrationRevision,
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
    await gate.revoke(row);
    throw new EpEnvelopeError("expired", `the issuance gate advanced during mint (a takeover or re-registration won the serialization on ${snap.endpoint}/${snap.instanceId}); this mint released nothing (SPEC 13.1)`);
  }
}
