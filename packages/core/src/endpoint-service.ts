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
import {
  endpointToken, assertBoundedOwner, assertLifecycleToken, assertCommandToken,
} from "./endpoint-subjects.js";
import { EpEnvelopeError } from "./endpoint-envelope.js";
import {
  RECORD_KINDS, recordSpecKey, recordStatusKey, readRecord,
  createRecordEntry, updateRecordEntry, assertStatusValue,
} from "./endpoint-records.js";
import { assertDescriptorMatchesSpec, type DescribeDescriptor } from "./endpoint-serve.js";

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

/** A serve-credential grant tuple as {@link authorizeServeGrant} returns it: frozen, and
 *  brand-registered so the credential mint (`permissionsFor`, profile `endpoint-serve`) can
 *  refuse any tuple that did not pass registry authorization. The registry stays discovery
 *  (§13.9) — this seam is what turns a REGISTRATION into mintable serve authority, so a raw
 *  `{endpoint, instanceId, epoch, commands}` literal can never mint a serve credential. */
export interface EpServeGrant {
  endpoint: string;
  instanceId: string;
  epoch: number;
  commands: readonly string[];
}

/** Brand registry: authorized tuple → its immutable authorized snapshot. Like the §13.12
 *  consumer-config family bond, the snapshot (not object identity alone) is what emission
 *  checks, so a post-authorization mutation can never widen the minted rows. */
const AUTHORIZED_SERVE = new WeakMap<EpServeGrant, { endpoint: string; instanceId: string; epoch: number; commands: string[] }>();

/**
 * Authorize a serve-credential tuple against the REGISTERED service (§13.9: serving is granted
 * authority, dual to calling — the registry is discovery, the serve grant is the authority).
 * Runs inside the provisioner at mint time. The fence, in order:
 *  1. the instance must be REGISTERED (its `svc….spec` record exists) — `failed-precondition`;
 *  2. the credential's holder must BE the registered owner (`permission-denied`), and the name
 *     authority is re-checked FRESH (`permission-denied` on drift; a name re-minted to another
 *     owner cannot keep minting serve creds for the old registration's instances);
 *  3. the descriptor must match the registered spec ({@link assertDescriptorMatchesSpec}) and
 *     every minted command must be advertised by it — the registered command set is the
 *     cluster documents', carried by digest in the spec, so the digest-bound descriptor is the
 *     command source (`permission-denied` for a foreign command); `describe` is derived by the
 *     row builder, never minted explicitly;
 *  4. the epoch must EQUAL a fresh read of the authoritative mapping's `processEpoch`
 *     (`expired`): a serve credential binds the CURRENT incarnation — minting another epoch
 *     would arm a superseded (or not-yet-current) incarnation's epoch-pinned egress.
 */
export async function authorizeServeGrant(
  kv: KV,
  args: {
    endpoint: string;
    instanceId: string;
    epoch: number;
    commands: string[];
    descriptor: DescribeDescriptor;
    holder: { owner: string };
    authority: ServiceNameAuthority;
    readProcessEpoch: () => Promise<number> | number;
  },
): Promise<EpServeGrant> {
  const iId = assertLifecycleToken(args.instanceId, "instanceId");
  if (!Number.isSafeInteger(args.epoch) || args.epoch < 0)
    throw new EpEnvelopeError("internal", `epoch ${args.epoch} is not an unsigned integer`);
  const specEntry = await kv.get(recordSpecKey(RECORD_KINDS.svc, [args.endpoint, iId]));
  if (!specEntry || specEntry.operation !== "PUT")
    throw new EpEnvelopeError("failed-precondition", `no registered spec for "${args.endpoint}/${args.instanceId}"; a serve credential is minted only for a REGISTERED instance (SPEC 13.9)`);
  const spec = parseServiceSpec(decodeJson(specEntry.value, recordSpecKey(RECORD_KINDS.svc, [args.endpoint, iId])), { endpoint: args.endpoint });
  assertBoundedOwner(args.holder.owner, "serve credential holder");
  if (args.holder.owner !== spec.owner)
    throw new EpEnvelopeError("permission-denied", `the serve credential holder "${args.holder.owner}" is not the registered owner "${spec.owner}" of "${args.endpoint}" (SPEC 13.9: serving is the registered owner's authority)`);
  assertServiceNameAuthority(spec.endpoint, spec.owner, args.authority);
  assertDescriptorMatchesSpec(args.descriptor, spec);
  if (args.commands.length === 0)
    throw new EpEnvelopeError("failed-precondition", `a serve grant for "${args.endpoint}" needs at least one registered command`);
  if (new Set(args.commands).size !== args.commands.length)
    throw new EpEnvelopeError("failed-precondition", `the serve grant's command list carries duplicates`);
  const advertised = new Set(args.descriptor.clusters.flatMap((c) => c.commands));
  for (const cmd of args.commands) {
    assertCommandToken(cmd);
    if (cmd === "describe")
      throw new EpEnvelopeError("failed-precondition", `"describe" is reserved and derived on every serve credential, never minted explicitly (SPEC 13.7/13.9)`);
    if (!advertised.has(cmd))
      throw new EpEnvelopeError("permission-denied", `command "${cmd}" is not part of "${args.endpoint}"'s registered contract surface (SPEC 13.9: the serve grant binds the REGISTERED command set)`);
  }
  const current = await args.readProcessEpoch();
  if (!Number.isSafeInteger(current) || current < 0)
    throw new EpEnvelopeError("internal", `the authoritative mapping read returned ${JSON.stringify(current)}, not an unsigned processEpoch`);
  if (args.epoch !== current)
    throw new EpEnvelopeError("expired", `serve grant for epoch ${args.epoch} but the authoritative mapping's current processEpoch is ${current}; a serve credential binds the CURRENT incarnation only (SPEC 13.1/13.9)`);
  const grant: EpServeGrant = Object.freeze({
    endpoint: spec.endpoint,
    instanceId: iId,
    epoch: args.epoch,
    commands: Object.freeze([...args.commands]) as readonly string[],
  });
  AUTHORIZED_SERVE.set(grant, { endpoint: spec.endpoint, instanceId: iId, epoch: args.epoch, commands: [...args.commands] });
  return grant;
}

/** The mint-side check: `serve` must be a tuple {@link authorizeServeGrant} returned, field-
 *  for-field equal to its authorized snapshot. A structural copy, a raw literal, or a mutated
 *  tuple refuses — the mint consumes only provisioner-authorized serve authority. */
export function assertServeGrantAuthorized(serve: { endpoint: string; instanceId: string; epoch: number; commands: readonly string[] }): void {
  const minted = AUTHORIZED_SERVE.get(serve as EpServeGrant);
  if (!minted)
    throw new EpEnvelopeError("permission-denied", "the serve tuple was not authorized against the registered service (authorizeServeGrant); a raw tuple never mints a serve credential (SPEC 13.9)");
  if (minted.endpoint !== serve.endpoint || minted.instanceId !== serve.instanceId || minted.epoch !== serve.epoch
    || minted.commands.length !== serve.commands.length || minted.commands.some((cmd, i) => serve.commands[i] !== cmd))
    throw new EpEnvelopeError("permission-denied", "the serve tuple diverges from its authorized snapshot; refusing to mint from mutated serve authority (SPEC 13.9)");
}
