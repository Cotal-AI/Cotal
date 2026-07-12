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
  endpointToken, assertBoundedOwner, assertLifecycleToken,
} from "./endpoint-subjects.js";
import { EpEnvelopeError } from "./endpoint-envelope.js";
import {
  RECORD_KINDS, recordSpecKey, recordStatusKey, readRecord,
  createRecordEntry, updateRecordEntry, assertStatusValue,
} from "./endpoint-records.js";

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

/** Register (or re-register) a service instance: name authority, then the spec-key CAS. The
 *  returned `registrationRevision` is the spec key's store revision (§13.7) — a re-registration
 *  advances it, which is exactly what invalidates a frozen scatter slot (§13.5 `churn`). A
 *  concurrent registration race is a loud `conflict` (§13.8: re-read and re-decide). */
export async function registerServiceInstance(
  kv: KV,
  args: { spec: ServiceSpec; instanceId: string; authority: ServiceNameAuthority },
): Promise<{ registrationRevision: number }> {
  const spec = parseServiceSpec(args.spec, { endpoint: args.spec.endpoint });
  assertServiceNameAuthority(spec.endpoint, spec.owner, args.authority);
  const key = recordSpecKey(RECORD_KINDS.svc, [spec.endpoint, assertLifecycleToken(args.instanceId, "instanceId")]);
  const current = await kv.get(key);
  const revision = current && current.operation === "PUT"
    ? await updateRecordEntry(kv, key, spec, current.revision)
    : await createRecordEntry(kv, key, spec);
  return { registrationRevision: revision };
}

/** Write an instance's status, EPOCH-FENCED (§13.6/§13.8: a superseded epoch cannot commit).
 *  `epoch` is the WRITER-AUTHENTICATED epoch — in production the record writer reads it from
 *  the broker-authenticated `epr` subject (§13.9), never from the payload; this helper trusts
 *  its caller to be that seam and additionally requires the payload to agree. A write from an
 *  epoch behind the recorded one fails `expired`; the racing CAS loss is a loud `conflict`. */
export async function writeServiceStatus(
  kv: KV,
  args: { endpoint: string; instanceId: string; epoch: number; status: ServiceStatus },
): Promise<number> {
  const status = parseServiceStatus(args.status);
  if (status.epoch !== args.epoch)
    throw new EpEnvelopeError("internal", `status.epoch ${status.epoch} disagrees with the writer-authenticated epoch ${args.epoch} (SPEC 13.9: the epoch rides the subject)`);
  assertStatusValue(status);
  // The endpoint NAME rides through: the kind's own qualifier assert tokenizes it exactly once.
  const key = recordStatusKey(RECORD_KINDS.svc, [args.endpoint, assertLifecycleToken(args.instanceId, "instanceId")]);
  const current = await kv.get(key);
  if (current && current.operation === "PUT") {
    const recorded = parseServiceStatus(JSON.parse(new TextDecoder().decode(current.value)));
    if (args.epoch < recorded.epoch)
      throw new EpEnvelopeError("expired", `status write from epoch ${args.epoch} is superseded (recorded epoch ${recorded.epoch}); a superseded incarnation cannot commit (SPEC 13.6)`);
    return updateRecordEntry(kv, key, status, current.revision);
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
 *  service registry at send time — registered spec present, status present, and not
 *  {@link SERVICE_EXITED}. An empty or unreadable registry is `failed-precondition`, never an
 *  empty success (§13.5). The read grant this runs under is a §13.9 matrix row. */
export async function freezeExpectedSet(kv: KV, endpoint: string): Promise<FrozenInstance[]> {
  const e = endpointToken(endpoint);
  const frozen: FrozenInstance[] = [];
  const iter = await kv.keys(`svc.${e}.*.spec`);
  const instanceIds: string[] = [];
  for await (const key of iter) instanceIds.push(key.split(".")[2]);
  for (const instanceId of instanceIds) {
    // The NAME, not the pre-tokenized `e`: the kind's qualifier assert tokenizes exactly once.
    const rec = await readRecord(kv, RECORD_KINDS.svc, [endpoint, instanceId]);
    if (!rec || !rec.status) continue; // registered but never converged: not a live class member
    const status = parseServiceStatus(rec.status.value);
    if (status.state === SERVICE_EXITED) continue;
    frozen.push({ instanceId, registrationRevision: rec.spec.revision, epoch: status.epoch });
  }
  if (frozen.length === 0)
    throw new EpEnvelopeError("failed-precondition", `service "${endpoint}" has no live registered instances; an empty registry is never an empty scatter success (SPEC 13.5)`);
  return frozen;
}
