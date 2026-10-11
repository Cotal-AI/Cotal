import type { KV, KvEntry } from "@nats-io/kv";
import {
  assertDerivedOwnerToken, assertLifecycleToken, contractDigest, endpointToken, EpEnvelopeError,
  isCasLoss, mintLifecycleUid, principalKey, spacePrefix, type EpCaller, type HostedEnvironmentReference,
} from "@cotal-ai/core";
import type { EnvironmentManagerAdmissionCoordinates } from "./environment-manager-admission.js";

/** Read from the host's confirmed provider binding, never assembled from a guest request. */
export interface EnvironmentManagerAdmissionSource {
  environmentId: string;
  caller: EpCaller;
  profileDigest: string;
  environment: HostedEnvironmentReference;
  /** Provider admission ceiling in epoch milliseconds. */
  expiresAt: number;
}

export interface EnvironmentManagerAdmissionIndex {
  reserve(source: EnvironmentManagerAdmissionSource): Promise<EnvironmentManagerAdmissionCoordinates>;
  get(environmentId: string): Promise<EnvironmentManagerAdmissionCoordinates | undefined>;
}

/** Immutable host configuration; callers cannot select another account or authority instance. */
interface IndexContext {
  space: string;
  accountPublicKey: string;
  authorityEndpoint: string;
  authorityInstanceId: string;
}
interface IndexRecord {
  v: 1;
  source: EnvironmentManagerAdmissionSource;
  context: IndexContext;
  instanceId: string;
  lifecycleUid: string;
  operationId: string;
}
const text = (value: unknown): value is string => typeof value === "string" && value.length > 0 && value.length <= 256;
const closed = (value: unknown, fields: string[]): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value) &&
  Object.keys(value).length === fields.length && Object.keys(value).every(key => fields.includes(key));
function sourceValue(value: unknown): EnvironmentManagerAdmissionSource {
  if (!closed(value, ["environmentId", "caller", "profileDigest", "environment", "expiresAt"]) ||
    typeof value.environmentId !== "string" || !/^[a-f0-9]{64}$/.test(value.environmentId) ||
    typeof value.profileDigest !== "string" || !/^sha256:[a-f0-9]{64}$/.test(value.profileDigest) ||
    !closed(value.caller, ["owner", "actor", "uid"]) || !text(value.caller.owner) || !text(value.caller.actor) || !text(value.caller.uid) ||
    !closed(value.environment, ["kind", "id"]) || !text(value.environment.kind) || !text(value.environment.id) ||
    !Number.isSafeInteger(value.expiresAt) || Number(value.expiresAt) < 1)
    throw new EpEnvelopeError("failed-precondition", "environment manager admission source is malformed");
  assertDerivedOwnerToken(value.caller.owner);
  principalKey(value.caller.owner, value.caller.actor);
  assertLifecycleToken(value.caller.uid, "environment caller uid");
  return structuredClone(value) as unknown as EnvironmentManagerAdmissionSource;
}
export function environmentManagerAdmissionIndexBucket(space: string): string {
  spacePrefix(space);
  return `cotal_environment_managers_${space}`;
}
function key(id: string): string {
  if (!/^[a-f0-9]{64}$/.test(id)) throw new EpEnvelopeError("bad-request", "invalid environment id");
  return `manager.${id}`;
}

/** Dedicated non-expiring, leader-read private index. It preselects native coordinates only;
 * it neither validates host policies nor admits a guest or issues a credential. */
export async function environmentManagerAdmissionIndex(kv: KV, input: IndexContext): Promise<EnvironmentManagerAdmissionIndex> {
  const context = structuredClone(input);
  if (!closed(context, ["space", "accountPublicKey", "authorityEndpoint", "authorityInstanceId"]) ||
    !text(context.space) || !/^A[A-Z2-7]{55}$/.test(context.accountPublicKey))
    throw new EpEnvelopeError("failed-precondition", "environment admission index context is malformed");
  endpointToken(context.authorityEndpoint);
  assertLifecycleToken(context.authorityInstanceId, "authorityInstanceId");
  const status = await kv.status(), config = status.streamInfo.config;
  if (config.name !== `KV_${environmentManagerAdmissionIndexBucket(context.space)}` ||
    JSON.stringify(config.subjects) !== JSON.stringify([`$KV.${environmentManagerAdmissionIndexBucket(context.space)}.>`]) || status.storage !== "file" || status.history !== 1 || status.ttl !== 0 || config.allow_direct !== false ||
    config.allow_msg_ttl || config.retention !== "limits" || config.discard !== "new" ||
    config.mirror || config.sources?.length || config.allow_rollup_hdrs)
    throw new EpEnvelopeError("failed-precondition", "environment admission index needs private file-backed history-1 non-expiring leader-read storage");
  const decode = (entry: KvEntry): { row: IndexRecord; coordinates: EnvironmentManagerAdmissionCoordinates } => {
    if (entry.operation !== "PUT") throw new EpEnvelopeError("failed-precondition", "environment admission index deletion is corruption");
    let raw: unknown;
    try { raw = JSON.parse(entry.string()); }
    catch { throw new EpEnvelopeError("failed-precondition", "environment admission index row is not JSON"); }
    if (!closed(raw, ["v", "source", "context", "instanceId", "lifecycleUid", "operationId"]) || raw.v !== 1 ||
      contractDigest(raw.context) !== contractDigest(context))
      throw new EpEnvelopeError("failed-precondition", "environment admission index row has foreign context or shape");
    const source = sourceValue(raw.source);
    if (entry.key !== key(source.environmentId)) throw new EpEnvelopeError("failed-precondition", "environment admission index key does not match its binding");
    for (const field of ["instanceId", "lifecycleUid", "operationId"] as const) {
      if (!text(raw[field])) throw new EpEnvelopeError("failed-precondition", "environment admission index identity is malformed");
      assertLifecycleToken(raw[field], field);
    }
    const row = { ...raw, source } as unknown as IndexRecord;
    return { row, coordinates: { owner: source.caller.owner, environmentId: source.environmentId,
      admissionRevision: entry.revision, instanceId: row.instanceId, lifecycleUid: row.lifecycleUid,
      operationId: row.operationId, authorityEndpoint: context.authorityEndpoint,
      authorityInstanceId: context.authorityInstanceId, expiresAt: Math.floor(source.expiresAt / 1000) } };
  };
  const read = async (id: string) => { const entry = await kv.get(key(id)); return entry ? decode(entry) : undefined; };
  return {
    async get(id) { return (await read(id))?.coordinates; },
    async reserve(value) {
      const source = sourceValue(value);
      if (Math.floor(source.expiresAt / 1000) <= Math.floor(Date.now() / 1000))
        throw new EpEnvelopeError("permission-denied", "environment admission source has expired");
      const existing = await read(source.environmentId);
      if (existing) {
        if (contractDigest(existing.row.source) !== contractDigest(source))
          throw new EpEnvelopeError("conflict", "environment already has another immutable manager admission binding");
        return existing.coordinates;
      }
      const row: IndexRecord = { v: 1, source, context, instanceId: mintLifecycleUid(), lifecycleUid: mintLifecycleUid(), operationId: mintLifecycleUid() };
      try { await kv.put(key(source.environmentId), JSON.stringify(row), { previousSeq: 0 }); }
      catch (error) {
        if (!isCasLoss(error)) throw new EpEnvelopeError("unavailable", "environment admission reservation outcome is unknown");
      }
      const winner = await read(source.environmentId);
      if (!winner) throw new EpEnvelopeError("unavailable", "environment admission reservation cannot be confirmed");
      if (contractDigest(winner.row.source) !== contractDigest(source))
        throw new EpEnvelopeError("conflict", "environment already has another immutable manager admission binding");
      return winner.coordinates;
    },
  };
}
