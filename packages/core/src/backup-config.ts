import {
  DiscardPolicy,
  RetentionPolicy,
  StorageType,
  StoreCompression,
  type StreamConfig,
} from "@nats-io/jetstream";
import { nanos } from "@nats-io/transport-node";
import {
  aclBucket,
  channelBucket,
  chatStream,
  deliveryBucket,
  dlvStream,
  dmStream,
  inboxStream,
  managerBucket,
  membersBucket,
  membershipBucket,
  presenceBucket,
  spacePrefix,
  taskStream,
  artifactBucket,
  objectStoreStream,
} from "./subjects.js";
import { possessionBucket, attachmentBucket } from "./artifact-index.js";

export type SpaceBackupSelection = "full" | "registry";
export type SpaceBackupStreamClass = "messages" | "registry" | "authorization";
/** Why a stream is outside the backup artifact. `artifact` is its own class deliberately: object
 *  bytes are neither transient (they outlive a session), derived (nothing can recompute them),
 *  nor a lease. Excluding them is a RETENTION decision — pin extends lifetime, not durability —
 *  and giving it an honest name keeps a later reader from reading it as "derived, so recoverable".*/
export type SpaceBackupExcludedClass = "transient" | "derived" | "lease" | "artifact";

export interface SpaceBackupStream {
  name: string;
  class: SpaceBackupStreamClass;
}

export interface SpaceBackupExcludedStream {
  name: string;
  class: SpaceBackupExcludedClass;
}

export interface SpaceBackupInventory {
  backedUp: readonly SpaceBackupStream[];
  excluded: readonly SpaceBackupExcludedStream[];
  full: readonly string[];
  registry: readonly string[];
}

/** The complete Cotal stream inventory at a stable backup cut. Only the eight `backedUp` streams
 * enter a full artifact; the five excluded streams are transient, derived, leases, or the artifact
 * object store. EVERY stream a space owns must appear in one list or the other:
 * {@link validateSpaceBackupInventory} is exact set-equality, so an unenumerated stream fails
 * validation for the WHOLE space, and a missing one fails it the same way. */
export function spaceBackupInventory(space: string): SpaceBackupInventory {
  const registry = `KV_${channelBucket(space)}`;
  const backedUp: SpaceBackupStream[] = [
    { name: registry, class: "registry" },
    { name: chatStream(space), class: "messages" },
    { name: dmStream(space), class: "messages" },
    { name: taskStream(space), class: "messages" },
    { name: inboxStream(space), class: "messages" },
    { name: dlvStream(space), class: "messages" },
    { name: `KV_${aclBucket(space)}`, class: "authorization" },
    { name: `KV_${membersBucket(space)}`, class: "authorization" },
  ];
  const excluded: SpaceBackupExcludedStream[] = [
    { name: `KV_${presenceBucket(space)}`, class: "transient" },
    { name: `KV_${membershipBucket(space)}`, class: "derived" },
    { name: `KV_${deliveryBucket(space)}`, class: "lease" },
    { name: `KV_${managerBucket(space)}`, class: "lease" },
    { name: objectStoreStream(artifactBucket(space)), class: "artifact" },
    // The INDEX stores follow the BYTES. §7 already decided that pin extends lifetime, not
    // durability — artifacts do not survive a restore — so restoring possession and attachment rows
    // over bytes that were never backed up would rebuild an index pointing at nothing: rows whose
    // authorization passes and whose blob is gone. Excluding all three keeps them consistent, and
    // restore rebuilds them empty.
    { name: `KV_${possessionBucket(space)}`, class: "artifact" },
    { name: `KV_${attachmentBucket(space)}`, class: "artifact" },
  ];
  return {
    backedUp,
    excluded,
    full: backedUp.map((s) => s.name),
    registry: [registry],
  };
}

/** Reject a missing, foreign, or additional stream before selecting artifact components. */
export function validateSpaceBackupInventory(space: string, actualNames: readonly string[]): SpaceBackupInventory {
  const inventory = spaceBackupInventory(space);
  const expected = [...inventory.full, ...inventory.excluded.map((s) => s.name)].sort();
  const actual = [...actualNames].sort();
  if (new Set(actual).size !== actual.length)
    throw new Error("space backup inventory contains duplicate stream names");
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    const expectedSet = new Set(expected);
    const actualSet = new Set(actual);
    const missing = expected.filter((name) => !actualSet.has(name));
    const unexpected = actual.filter((name) => !expectedSet.has(name));
    throw new Error(
      `space backup inventory mismatch: missing [${missing.join(", ")}], unexpected [${unexpected.join(", ")}]`,
    );
  }
  return inventory;
}

export interface BackupStreamState {
  messages: number;
  bytes: number;
  first_seq: number;
  last_seq: number;
  consumer_count: number;
  first_ts?: string;
  last_ts?: string;
  deleted?: number[];
  num_deleted?: number;
  num_subjects?: number;
  subjects?: Record<string, number>;
  lost?: { msgs?: number[] | null; bytes?: number };
}

/** The NATS 2.10 stream-config surface Cotal permits in an artifact or restore request. */
export type CanonicalBackupStreamConfig = Pick<
  StreamConfig,
  | "name"
  | "subjects"
  | "retention"
  | "storage"
  | "max_consumers"
  | "max_msgs"
  | "max_bytes"
  | "max_age"
  | "max_msgs_per_subject"
  | "max_msg_size"
  | "discard"
  | "num_replicas"
  | "duplicate_window"
  | "allow_direct"
  | "mirror_direct"
  | "discard_new_per_subject"
  | "allow_rollup_hdrs"
  | "deny_delete"
  | "deny_purge"
  | "sealed"
  | "consumer_limits"
> & {
  no_ack: boolean;
  compression: typeof StoreCompression.None;
};

const DEFAULT_DUPLICATE_WINDOW = nanos(2 * 60 * 1000);
export const BACKUP_MAX_MSGS_PER_SUBJECT = 1000;
export const BACKUP_PLANE3_DEDUP_WINDOW_MS = 2 * 60 * 60 * 1000;
const PLANE3_DUPLICATE_WINDOW = nanos(BACKUP_PLANE3_DEDUP_WINDOW_MS);

function baseConfig(name: string, subjects: string[]): CanonicalBackupStreamConfig {
  return {
    name,
    subjects,
    retention: RetentionPolicy.Limits,
    storage: StorageType.File,
    max_consumers: -1,
    max_msgs: -1,
    max_bytes: -1,
    max_age: 0,
    max_msgs_per_subject: -1,
    max_msg_size: -1,
    discard: DiscardPolicy.Old,
    num_replicas: 1,
    no_ack: false,
    duplicate_window: DEFAULT_DUPLICATE_WINDOW,
    compression: StoreCompression.None,
    allow_direct: false,
    mirror_direct: false,
    discard_new_per_subject: false,
    allow_rollup_hdrs: false,
    deny_delete: false,
    deny_purge: false,
    sealed: false,
    consumer_limits: {},
  };
}

/** Current canonical config for one of the eight backed-up streams. Restore callers must use this
 * config, not the config embedded in untrusted snapshot bytes. */
export function canonicalBackupStreamConfig(space: string, stream: string): CanonicalBackupStreamConfig {
  const p = spacePrefix(space);
  if (stream === chatStream(space)) {
    return {
      ...baseConfig(stream, [`${p}.chat.>`]),
      max_msgs_per_subject: BACKUP_MAX_MSGS_PER_SUBJECT,
      allow_direct: true,
    };
  }
  if (stream === dmStream(space)) return baseConfig(stream, [`${p}.inst.>`]);
  if (stream === taskStream(space)) {
    return { ...baseConfig(stream, [`${p}.svc.>`]), retention: RetentionPolicy.Workqueue };
  }
  if (stream === inboxStream(space)) {
    return {
      ...baseConfig(stream, [`${p}.dinbox.>`]),
      max_msgs_per_subject: BACKUP_MAX_MSGS_PER_SUBJECT,
      duplicate_window: PLANE3_DUPLICATE_WINDOW,
    };
  }
  if (stream === dlvStream(space)) {
    return {
      ...baseConfig(stream, [`${p}.dlv.>`]),
      max_msgs_per_subject: BACKUP_MAX_MSGS_PER_SUBJECT,
      duplicate_window: PLANE3_DUPLICATE_WINDOW,
    };
  }
  for (const bucket of [channelBucket(space), aclBucket(space), membersBucket(space)]) {
    if (stream === `KV_${bucket}`) {
      return {
        ...baseConfig(stream, [`$KV.${bucket}.>`]),
        max_msgs_per_subject: 1,
        discard: DiscardPolicy.New,
        allow_direct: true,
        allow_rollup_hdrs: true,
      };
    }
  }
  throw new Error(`stream ${JSON.stringify(stream)} is not a backed-up stream for space ${JSON.stringify(space)}`);
}

const INERT_CONFIG_DEFAULTS: Record<string, unknown> = {
  description: "",
  template_owner: "",
  first_seq: 0,
  placement: null,
  mirror: null,
  sources: [],
  subject_transform: null,
  republish: null,
  metadata: {},
  allow_msg_ttl: false,
  subject_delete_marker_ttl: 0,
  allow_msg_schedules: false,
  allow_atomic: false,
  allow_batched: false,
  allow_msg_counter: false,
  persist_mode: "",
};

function normalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalize);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, item]) => [key, normalize(item)]),
    );
  }
  return value;
}

/** Validate every active and security-sensitive stream setting, including explicit rejection of
 * mirrors, sources, transforms, republish, placement, sealing, metadata, and future active features. */
export function validateCanonicalBackupStreamConfig(
  space: string,
  stream: string,
  actual: Readonly<Record<string, unknown>>,
): CanonicalBackupStreamConfig {
  const expected = canonicalBackupStreamConfig(space, stream);
  const known = new Set([...Object.keys(expected), ...Object.keys(INERT_CONFIG_DEFAULTS)]);
  const unknown = Object.keys(actual).filter((key) => !known.has(key));
  if (unknown.length) throw new Error(`${stream} config has unsupported fields: ${unknown.sort().join(", ")}`);

  const comparable: Record<string, unknown> = {};
  for (const [key, expectedValue] of Object.entries(expected))
    comparable[key] = actual[key] === undefined ? expectedValue : actual[key];
  for (const [key, expectedValue] of Object.entries(INERT_CONFIG_DEFAULTS)) {
    const actualValue = actual[key];
    comparable[key] = actualValue === undefined || actualValue === null ? expectedValue : actualValue;
  }
  // Newer servers annotate a request-level floor in their reserved metadata namespace. It is
  // server-owned protocol bookkeeping, not caller configuration; no other metadata is canonical.
  if (
    comparable.metadata &&
    typeof comparable.metadata === "object" &&
    !Array.isArray(comparable.metadata) &&
    Object.entries(comparable.metadata as Record<string, unknown>)
      .every(([key, value]) => key.startsWith("_nats.") && typeof value === "string")
  ) comparable.metadata = {};
  const target: Record<string, unknown> = { ...expected, ...INERT_CONFIG_DEFAULTS };
  if (JSON.stringify(normalize(comparable)) !== JSON.stringify(normalize(target))) {
    const drift = Object.keys(target).filter(
      (key) => JSON.stringify(normalize(comparable[key])) !== JSON.stringify(normalize(target[key])),
    );
    throw new Error(`${stream} config is not canonical: ${drift.map((key) => `${key}=${JSON.stringify(comparable[key])}`).join(", ")}`);
  }
  return expected;
}

export function validateBackupStreamState(state: Readonly<Record<string, unknown>>): BackupStreamState {
  const allowed = new Set([
    "messages", "bytes", "first_seq", "last_seq", "consumer_count", "first_ts", "last_ts",
    "deleted", "num_deleted", "num_subjects", "subjects", "lost",
  ]);
  const unknown = Object.keys(state).filter((key) => !allowed.has(key));
  if (unknown.length) throw new Error(`stream state has unsupported fields: ${unknown.sort().join(", ")}`);
  for (const key of ["messages", "bytes", "first_seq", "last_seq", "consumer_count"] as const) {
    const value = state[key];
    if (!Number.isSafeInteger(value) || (value as number) < 0)
      throw new Error(`stream state ${key} must be a non-negative safe integer`);
  }
  const messages = state.messages as number;
  const firstSequence = state.first_seq as number;
  const lastSequence = state.last_seq as number;
  if (messages === 0) {
    const initial = firstSequence === 0 && lastSequence === 0;
    const exhausted = lastSequence < Number.MAX_SAFE_INTEGER && firstSequence === lastSequence + 1;
    if (!initial && !exhausted)
      throw new Error("empty stream state must be initial or exhausted at last_seq + 1");
  } else {
    if (firstSequence < 1 || firstSequence > lastSequence)
      throw new Error("non-empty stream state has an invalid first/last sequence window");
    if (messages > lastSequence - firstSequence + 1)
      throw new Error("stream state messages exceed its first/last sequence window");
  }
  for (const seq of (state.deleted as unknown[] | undefined) ?? [])
    if (!Number.isSafeInteger(seq) || (seq as number) < 1)
      throw new Error("stream state deleted sequences must be positive safe integers");
  for (const key of ["num_deleted", "num_subjects"] as const) {
    const value = state[key];
    if (value !== undefined && (!Number.isSafeInteger(value) || (value as number) < 0))
      throw new Error(`stream state ${key} must be a non-negative safe integer`);
  }
  for (const key of ["first_ts", "last_ts"] as const) {
    const value = state[key];
    if (value !== undefined && (typeof value !== "string" || Number.isNaN(Date.parse(value))))
      throw new Error(`stream state ${key} must be an ISO timestamp`);
  }
  if (state.subjects !== undefined) {
    if (!state.subjects || typeof state.subjects !== "object" || Array.isArray(state.subjects))
      throw new Error("stream state subjects must be an object");
    for (const count of Object.values(state.subjects as Record<string, unknown>))
      if (!Number.isSafeInteger(count) || (count as number) < 0)
        throw new Error("stream state subject counts must be non-negative safe integers");
  }
  if (state.lost !== undefined) {
    if (!state.lost || typeof state.lost !== "object" || Array.isArray(state.lost))
      throw new Error("stream state lost must be an object");
    const lost = state.lost as Record<string, unknown>;
    const lostUnknown = Object.keys(lost).filter((key) => key !== "msgs" && key !== "bytes");
    if (lostUnknown.length) throw new Error(`stream state lost has unsupported fields: ${lostUnknown.join(", ")}`);
    if (lost.bytes !== undefined && (!Number.isSafeInteger(lost.bytes) || (lost.bytes as number) < 0))
      throw new Error("stream state lost.bytes must be a non-negative safe integer");
    if (lost.msgs !== undefined && lost.msgs !== null) {
      if (!Array.isArray(lost.msgs) || lost.msgs.some((seq) => !Number.isSafeInteger(seq) || seq < 1))
        throw new Error("stream state lost.msgs must contain positive safe integers");
    }
  }
  return state as unknown as BackupStreamState;
}
