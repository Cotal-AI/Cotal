import {
  DiscardPolicy,
  RetentionPolicy,
  StorageType,
  StoreCompression,
  type StreamConfig,
} from "@nats-io/jetstream";
import { nanos } from "@nats-io/transport-node";
import { endpointAuthorityStoreDefinitions, endpointPlaneStreamNames, recordsKvStreamName, wfjStreamName } from "./endpoint-binding.js";
import { recordsBucket } from "./endpoint-records.js";
import { admissionBucket, admissionStoreDefinition } from "./run-admission.js";
import { spaceDeletionStreams } from "./space-deletion-targets.js";
import {
  aclBucket,
  anycastBucket,
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
  isTransferStream,
  objectStoreStream,
} from "./subjects.js";

export type SpaceBackupSelection = "full" | "registry";
/** `workflow` is the state a workflow run resumes from: its step journal, its records and its
 *  admission. Every other endpoint store is control state and is recreated empty. */
export type SpaceBackupStreamClass = "messages" | "registry" | "authorization" | "workflow";
/** Why a stream is outside the backup artifact. `artifact` is its own class deliberately: object
 *  bytes are neither transient (they outlive a session), derived (nothing can recompute them),
 *  nor a lease. Excluding them is a RETENTION decision — pin extends lifetime, not durability —
 *  and giving it an honest name keeps a later reader from reading it as "derived, so recoverable".*/
export type SpaceBackupExcludedClass = "transient" | "derived" | "lease" | "control" | "artifact" | "transfer";

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

/** The complete Cotal stream inventory at a stable backup cut. Only the `backedUp` streams enter a
 * full artifact; excluded streams are transient, derived, leases, nonportable control state, or the
 * artifact object store. EVERY stream a space owns must appear in one list or the other:
 * {@link validateSpaceBackupInventory} is exact set-equality, so an unenumerated stream fails
 * validation for the WHOLE space, and a missing one fails it the same way.
 *
 * The two lists classify exactly {@link spaceDeletionStreams}, the set `deleteSpace` removes and the
 * teardown grant names, and this throws when they differ. Without that, a stream added to the
 * deletion set alone, or classified here alone, would leave backup and teardown disagreeing about
 * what the space owns, and only the backup side is ever checked against a live space. */
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
    { name: wfjStreamName(space), class: "workflow" },
    { name: recordsKvStreamName(space), class: "workflow" },
    { name: `KV_${admissionBucket(space)}`, class: "workflow" },
  ];
  const workflow = new Set(backedUp.filter((s) => s.class === "workflow").map((s) => s.name));
  const excluded: SpaceBackupExcludedStream[] = [
    { name: `KV_${presenceBucket(space)}`, class: "transient" },
    { name: `KV_${membershipBucket(space)}`, class: "derived" },
    { name: `KV_${deliveryBucket(space)}`, class: "lease" },
    { name: `KV_${managerBucket(space)}`, class: "lease" },
    { name: `KV_${anycastBucket(space)}`, class: "control" },
    ...endpointPlaneStreamNames(space).filter((name) => !workflow.has(name)).map((name) => ({ name, class: "control" as const })),
    { name: objectStoreStream(artifactBucket(space)), class: "artifact" },
  ];
  const classified = [...backedUp, ...excluded].map((s) => s.name);
  const owned = spaceDeletionStreams(space);
  const unclassified = owned.filter((name) => !classified.includes(name));
  const unowned = classified.filter((name) => !owned.includes(name));
  if (unclassified.length || unowned.length || classified.length !== owned.length)
    throw new Error(
      `spaceBackupInventory: ${space}'s backup classes and its deletion set disagree ` +
        `(unclassified: ${unclassified.join(", ") || "none"}; not deleted: ${unowned.join(", ") || "none"}; ` +
        `${classified.length} classified, ${owned.length} owned)`,
    );
  return {
    backedUp,
    excluded,
    full: backedUp.map((s) => s.name),
    registry: [registry],
  };
}

/** Reject a missing, foreign, or additional stream before selecting artifact components.
 *
 * `atRest` is for a STOPPED store reopened on a fresh broker, which is what backup reads. The
 * presence and derived membership buckets are memory-backed, and a memory stream does not survive
 * the broker stop that makes a cut, so those streams may be absent there. A bucket an older Cotal
 * created file-backed is still on disk and is accepted too. Every other stream stays exact. A live
 * space, such as a restore after it recreates its infrastructure, requires both Memory streams. */
export function validateSpaceBackupInventory(
  space: string,
  actualNames: readonly string[],
  options: { atRest?: boolean } = {},
): SpaceBackupInventory {
  const fixed = spaceBackupInventory(space);
  // A resume transfer bucket exists per receiving manager instance, so it is matched by name shape.
  // Its objects are deleted once staged and are not state to restore.
  const transfers = actualNames.filter((name) => isTransferStream(space, name));
  const inventory = { ...fixed, excluded: [...fixed.excluded, ...transfers.map((name) => ({ name, class: "transfer" as const }))] };
  const actual = [...actualNames].sort();
  const optional = new Set(
    options.atRest ? inventory.excluded.filter((s) => s.class === "transient" || s.class === "derived").map((s) => s.name) : [],
  );
  const expected = [...inventory.full, ...inventory.excluded.map((s) => s.name)]
    .filter((name) => !optional.has(name) || actual.includes(name))
    .sort();
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

const DEFAULT_DUPLICATE_WINDOW_MS = 2 * 60 * 1000;
const DEFAULT_DUPLICATE_WINDOW = nanos(DEFAULT_DUPLICATE_WINDOW_MS);
/** The count a new space's INBOX and DLV streams keep per subject, where a subject is one agent
 *  lifecycle across every channel: its newest copies, delivered ones included, since the reader acks
 *  an entry without deleting it. An operator may set another with `cotal history limit`. It is also
 *  the count of a DLV copy without a {@link DELIVERY_LIMIT_HEADER}, which only a daemon from before
 *  the count was configurable writes. */
export const PLANE3_MAX_MSGS_PER_SUBJECT = 1000;
export const BACKUP_PLANE3_DEDUP_WINDOW_MS = 2 * 60 * 60 * 1000;
const PLANE3_DUPLICATE_WINDOW = nanos(BACKUP_PLANE3_DEDUP_WINDOW_MS);
/** The header the trusted DLV writer stamps on each copy: the DLV count in force when it wrote the
 *  copy, as a whole number, or `none` (SPEC §8). */
export const DELIVERY_LIMIT_HEADER = "Cotal-Delivery-Limit";

/** The message streams a history limit applies to: CHAT, INBOX, DLV and DM. */
export type HistoryLimitStream = "chat" | "inbox" | "dlv" | "dm";

/** How long a message stream keeps an entry (SPEC §8): until it is older than `maxAgeMs`, or until
 *  `perSubject` newer entries share its subject, whichever comes first. A subject is one sender on
 *  one channel in CHAT, one agent lifecycle in INBOX and DLV, and one sender to one recipient in DM.
 *  The broker enforces the pair as the stream's `max_age` and `max_msgs_per_subject`. */
export interface HistoryLimit {
  /** `max_age` in milliseconds. 0 is no age limit. */
  maxAgeMs: number;
  /** `max_msgs_per_subject`. {@link HISTORY_NO_COUNT} is no count limit. */
  perSubject: number;
}

/** `max_msgs_per_subject` for no count limit. */
export const HISTORY_NO_COUNT = -1;

/** A new space's chat stream: no age limit, and each sender's newest 1000 posts on each channel.
 *  Every chat stream held this pair before the limit was configurable, and `cotal up` changes no
 *  existing stream's limit. */
export const CHAT_HISTORY_DEFAULT: Readonly<HistoryLimit> = Object.freeze({ maxAgeMs: 0, perSubject: 1000 });
/** A new space's INBOX and DLV streams: no age limit, and each agent lifecycle's newest 1000 copies. */
export const INBOX_HISTORY_DEFAULT: Readonly<HistoryLimit> = Object.freeze({ maxAgeMs: 0, perSubject: PLANE3_MAX_MSGS_PER_SUBJECT });
/** A new space's DM stream keeps every DM: no age limit and no count limit. */
export const DM_HISTORY_DEFAULT: Readonly<HistoryLimit> = Object.freeze({ maxAgeMs: 0, perSubject: HISTORY_NO_COUNT });
export const HISTORY_MAX_AGE_MS = 3650 * 86_400_000;

/** The limit a new space's `stream` is created with. */
export function historyLimitDefault(stream: HistoryLimitStream): Readonly<HistoryLimit> {
  if (stream === "chat") return CHAT_HISTORY_DEFAULT;
  return stream === "dm" ? DM_HISTORY_DEFAULT : INBOX_HISTORY_DEFAULT;
}

/** The shortest age `stream` may hold: its duplicate window, which the broker requires `max_age` not
 *  to undercut. 2 minutes for CHAT and DM, 2 hours for INBOX and DLV. */
export function historyLimitMinAgeMs(stream: HistoryLimitStream): number {
  return stream === "inbox" || stream === "dlv" ? BACKUP_PLANE3_DEDUP_WINDOW_MS : DEFAULT_DUPLICATE_WINDOW_MS;
}

/** Why `stream` may not hold `limit`, or undefined when it may. An age is none (0) or one
 *  {@link historyAgeProblem} accepts; a count is none ({@link HISTORY_NO_COUNT}) or at least 1. None
 *  for both is allowed. */
export function historyLimitProblem(stream: HistoryLimitStream, limit: HistoryLimit): string | undefined {
  if (limit.perSubject !== HISTORY_NO_COUNT && (!Number.isSafeInteger(limit.perSubject) || limit.perSubject < 1))
    return `the count must be a whole number of at least 1, or none, not ${limit.perSubject}`;
  return limit.maxAgeMs === 0 ? undefined : historyAgeProblem(stream, limit.maxAgeMs);
}

/** Why `stream` may not hold an age of `maxAgeMs`, or undefined when it may: whole seconds from the
 *  stream's duplicate window to 3650 days, so its nanosecond `max_age` stays an exact integer. Here
 *  0 is an age, below every window; only a {@link HistoryLimit} spells none as 0. */
export function historyAgeProblem(stream: HistoryLimitStream, maxAgeMs: number): string | undefined {
  if (!Number.isSafeInteger(maxAgeMs) || maxAgeMs % 1000 !== 0) return "the age must be a whole number of seconds";
  if (maxAgeMs < historyLimitMinAgeMs(stream))
    return `the age must be at least ${stream === "inbox" || stream === "dlv" ? "2h" : "2m"}, the stream's duplicate window, or none`;
  if (maxAgeMs > HISTORY_MAX_AGE_MS) return "the age must be at most 3650d, or none";
  return undefined;
}

/** The limit a stream config holds, read from its `max_age` and `max_msgs_per_subject`. */
export function historyLimitOf(config: Readonly<Record<string, unknown>>): HistoryLimit {
  const age = config.max_age ?? 0, count = config.max_msgs_per_subject;
  return { maxAgeMs: typeof age === "number" ? age / 1_000_000 : Number.NaN, perSubject: typeof count === "number" ? count : Number.NaN };
}

/** The limit a restore holds `stream` at while it checks the restored state: the artifact's
 *  recorded count and no age, so nothing expires before the messages, bytes and sequences are
 *  compared. The recorded age is applied after the last check. The recorded limit is checked here
 *  first, so staging never admits a limit no stream may hold. */
export function historyLimitRestoreStaging(stream: HistoryLimitStream, recorded: HistoryLimit): HistoryLimit {
  const problem = historyLimitProblem(stream, recorded);
  if (problem)
    throw new Error(`the backup records a ${stream} history limit no stream may hold (${problem}): max_age ${recorded.maxAgeMs}ms, ${recorded.perSubject} per subject`);
  return { maxAgeMs: 0, perSubject: recorded.perSubject };
}

/** Which history limit `stream` of `space` carries, or undefined for a stream without one. */
export function historyLimitStreamOf(space: string, stream: string): HistoryLimitStream | undefined {
  if (stream === chatStream(space)) return "chat";
  if (stream === inboxStream(space)) return "inbox";
  if (stream === dlvStream(space)) return "dlv";
  if (stream === dmStream(space)) return "dm";
  return undefined;
}

/** The stream name of `space`'s `stream`. */
export function historyLimitStreamName(space: string, stream: HistoryLimitStream): string {
  if (stream === "chat") return chatStream(space);
  if (stream === "inbox") return inboxStream(space);
  return stream === "dlv" ? dlvStream(space) : dmStream(space);
}

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

/** First-party creation baseline shared by bootstrap and backup definitions. These are desired
 *  native fields, not defaults filled into a broker observation or authorization to create. */
export function spaceStreamCreationBase(name: string, subjects: string[]): CanonicalBackupStreamConfig {
  return baseConfig(name, [...subjects]);
}

/** Current canonical config for one of the backed-up streams. Restore callers must use this config,
 * not the config embedded in untrusted snapshot bytes. `limit` sets the history limit of CHAT, INBOX,
 * DLV or DM, defaulting to the stream's {@link historyLimitDefault}, and is ignored for every other
 * stream; callers validate it. */
export function canonicalBackupStreamConfig(
  space: string,
  stream: string,
  limit?: Readonly<HistoryLimit>,
): CanonicalBackupStreamConfig {
  const p = spacePrefix(space);
  const target = historyLimitStreamOf(space, stream);
  const limits = target && { max_age: nanos((limit ?? historyLimitDefault(target)).maxAgeMs), max_msgs_per_subject: (limit ?? historyLimitDefault(target)).perSubject };
  if (target === "chat") return { ...baseConfig(stream, [`${p}.chat.>`]), ...limits, allow_direct: true };
  if (target === "dm") return { ...baseConfig(stream, [`${p}.inst.>`]), ...limits };
  if (stream === taskStream(space)) {
    return { ...baseConfig(stream, [`${p}.svc.>`]), retention: RetentionPolicy.Workqueue };
  }
  if (target === "inbox") return { ...baseConfig(stream, [`${p}.dinbox.>`]), ...limits, duplicate_window: PLANE3_DUPLICATE_WINDOW };
  if (target === "dlv") return { ...baseConfig(stream, [`${p}.dlv.>`]), ...limits, duplicate_window: PLANE3_DUPLICATE_WINDOW };
  if (stream === wfjStreamName(space)) return baseConfig(stream, [`${p}.wfj.*`]);
  // The records and admission stores are KV buckets hardened after creation, as their own
  // definitions say.
  if (stream === recordsKvStreamName(space))
    return { ...kvStoreConfig(stream, recordsBucket(space)), allow_direct: true, ...endpointAuthorityStoreDefinitions(space).records.hardenAfterCreate };
  if (stream === `KV_${admissionBucket(space)}`)
    return { ...kvStoreConfig(stream, admissionBucket(space)), ...admissionStoreDefinition(space).hardenAfterCreate };
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

/** A KV bucket with one value per key, as the KV client creates it. */
function kvStoreConfig(name: string, bucket: string): CanonicalBackupStreamConfig {
  return {
    ...baseConfig(name, [`$KV.${bucket}.>`]),
    max_msgs_per_subject: 1,
    discard: DiscardPolicy.New,
    allow_rollup_hdrs: true,
  };
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

/** Existing first-party baseline values for read-only comparison outside declared fields.
 *  These are not inferred SDK defaults, missing-field normalization or provisioning authority.
 *  Return fresh nested values so an inspection cannot mutate the backup validator's policy. */
export function streamReadPolicyBaseline(name: string, subjects: string[]) {
  return { ...baseConfig(name, [...subjects]), ...structuredClone(INERT_CONFIG_DEFAULTS) };
}

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
 * mirrors, sources, transforms, republish, placement, sealing, metadata, and future active features.
 * The history limit of CHAT, INBOX, DLV and DM is the one setting that varies: it is read from
 * `actual` and must be one the stream may hold ({@link historyLimitProblem}). A restore that is still
 * checking the state it restored passes `restoreStagingFor`, the limit its artifact recorded, and the
 * config must then hold that limit's staging form exactly ({@link historyLimitRestoreStaging}). */
export function validateCanonicalBackupStreamConfig(
  space: string,
  stream: string,
  actual: Readonly<Record<string, unknown>>,
  opts: { restoreStagingFor?: HistoryLimit } = {},
): CanonicalBackupStreamConfig {
  const limitStream = historyLimitStreamOf(space, stream);
  let limit: HistoryLimit | undefined;
  if (limitStream) {
    limit = opts.restoreStagingFor ? historyLimitRestoreStaging(limitStream, opts.restoreStagingFor) : historyLimitOf(actual);
    if (!opts.restoreStagingFor && historyLimitProblem(limitStream, limit) !== undefined)
      throw new Error(`${stream} config is not canonical: max_age=${JSON.stringify(actual.max_age)}, max_msgs_per_subject=${JSON.stringify(actual.max_msgs_per_subject)} is not a history limit it may hold`);
  }
  const expected = canonicalBackupStreamConfig(space, stream, limit);
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
