import {
  AckPolicy,
  DeliverPolicy,
  ReplayPolicy,
  type ConsumerConfig,
  type ConsumerInfo,
} from "@nats-io/jetstream";
import { nanos, type Msg, type NatsConnection } from "@nats-io/transport-node";
import {
  canonicalBackupStreamConfig,
  spaceBackupInventory,
  validateBackupStreamState,
  validateCanonicalBackupStreamConfig,
  type BackupStreamState,
  type SpaceBackupSelection,
} from "./backup-config.js";
import {
  dlvDurableConfig,
  dmDurableConfig,
  fanoutDurableConfig,
  inboxReaderConfig,
  taskDurableConfig,
} from "./streams.js";
import {
  FANOUT_DURABLE,
  INBOX_READER_DURABLE,
  assertInboxConnId,
  chatStream,
  dlvStream,
  dmStream,
  inboxStream,
  taskStream,
} from "./subjects.js";

const DEFAULT_TRANSFER_TIMEOUT_MS = 5 * 60 * 1000;
const DEFAULT_SINK_TIMEOUT_MS = 1_000;
const MAX_SINK_TIMEOUT_MS = 1_500;

interface ApiErrorResponse {
  error?: { code?: number; err_code?: number; description?: string };
}

export class JetStreamBackupError extends Error {
  constructor(message: string, readonly code?: number, readonly errCode?: number) {
    super(message);
    this.name = "JetStreamBackupError";
  }
}

export interface StreamSnapshotMetadata {
  config: Record<string, unknown>;
  state: BackupStreamState;
}

export interface DownloadStreamSnapshotOptions {
  deliverSubject: string;
  onChunk(chunk: Uint8Array): void | Promise<void>;
  timeoutMs?: number;
  /** Per-chunk sink deadline. Must stay below the server's two-second snapshot flow timeout. */
  sinkTimeoutMs?: number;
  checkMessages?: boolean;
}

function decodeJson<T>(data: Uint8Array, context: string): T {
  try {
    return JSON.parse(new TextDecoder().decode(data)) as T;
  } catch (cause) {
    throw new JetStreamBackupError(`${context}: invalid JSON response: ${(cause as Error).message}`);
  }
}

function throwApiError(response: ApiErrorResponse, context: string): void {
  if (!response.error) return;
  throw new JetStreamBackupError(
    `${context}: ${response.error.description ?? "JetStream API error"}`,
    response.error.code,
    response.error.err_code,
  );
}

function statusError(msg: Msg, context: string): JetStreamBackupError | undefined {
  const code = msg.headers?.code ?? 0;
  if (code < 300) return undefined;
  return new JetStreamBackupError(`${context}: ${code} ${msg.headers?.description || "status error"}`, code);
}

function assertExactSubject(subject: string, label: string): string {
  if (
    typeof subject !== "string" ||
    subject.length === 0 ||
    subject.startsWith(".") ||
    subject.endsWith(".") ||
    subject.includes("..") ||
    /[\s*>]/.test(subject)
  ) throw new Error(`${label} must be one exact NATS subject`);
  return subject;
}

function assertBackupStream(space: string, stream: string): string {
  canonicalBackupStreamConfig(space, stream);
  return stream;
}

async function withDeadline<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new JetStreamBackupError(message)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Download a no-consumer native snapshot through one ordered, deadline-bounded sink. Each ackable
 * binary chunk is ACKed only after its sink call succeeds. Completion requires a clean empty EOF
 * after all accepted chunks. */
export async function downloadStreamSnapshot(
  nc: NatsConnection,
  stream: string,
  opts: DownloadStreamSnapshotOptions,
): Promise<StreamSnapshotMetadata> {
  assertExactSubject(opts.deliverSubject, "snapshot deliverSubject");
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TRANSFER_TIMEOUT_MS;
  if (!Number.isInteger(timeoutMs) || timeoutMs <= 0) throw new Error("snapshot timeoutMs must be positive");
  const sinkTimeoutMs = opts.sinkTimeoutMs ?? DEFAULT_SINK_TIMEOUT_MS;
  if (!Number.isInteger(sinkTimeoutMs) || sinkTimeoutMs <= 0 || sinkTimeoutMs > MAX_SINK_TIMEOUT_MS)
    throw new Error(`snapshot sinkTimeoutMs must be between 1 and ${MAX_SINK_TIMEOUT_MS}`);

  let metadata: StreamSnapshotMetadata | undefined;
  let eof = false;
  let phase: "active" | "failing" | "settled" = "active";
  let processing = Promise.resolve();
  let inFlightSink: Promise<void> | undefined;
  let resolveDone!: (metadata: StreamSnapshotMetadata) => void;
  let rejectDone!: (error: Error) => void;
  const done = new Promise<StreamSnapshotMetadata>((resolve, reject) => {
    resolveDone = resolve;
    rejectDone = reject;
  });
  async function sinkChunk(chunk: Uint8Array): Promise<void> {
    const sink = Promise.resolve().then(() => opts.onChunk(chunk));
    const sinkSettled = sink.then(() => {}, () => {});
    inFlightSink = sinkSettled;
    void sinkSettled.then(() => {
      if (inFlightSink === sinkSettled) inFlightSink = undefined;
    });
    await withDeadline(sink, sinkTimeoutMs, "snapshot sink deadline exceeded");
  }
  // Observe the internal promise immediately; the async function's returned promise adopts it below.
  void done.catch(() => {});
  let timer: ReturnType<typeof setTimeout> | undefined;
  let sub: ReturnType<NatsConnection["subscribe"]> | undefined;
  sub = nc.subscribe(opts.deliverSubject, {
    callback: (error, msg) => {
      if (phase !== "active") return;
      if (error) return fail(error);
      processing = processing.then(async () => {
        if (phase !== "active") return;
        const protocolError = statusError(msg, `snapshot ${stream}`);
        if (protocolError) throw protocolError;
        if (msg.data.length === 0) {
          eof = true;
          complete();
          return;
        }
        // `window_size` arrived in NATS 2.12.5, and legacy flow control can omit replies on several
        // data chunks; only empty data is EOF, while a reply merely makes this chunk ACKable.
        await sinkChunk(msg.data.slice());
        if (phase !== "active") return;
        if (msg.reply && !msg.respond()) throw new JetStreamBackupError(`snapshot ${stream}: chunk ACK failed`);
      }).catch((cause) => fail(cause instanceof Error ? cause : new Error(String(cause))));
    },
  });
  if (phase === "active")
    timer = setTimeout(() => fail(new JetStreamBackupError(`snapshot ${stream}: transfer deadline exceeded`)), timeoutMs);
  else
    try { sub.unsubscribe(); } catch { /* already closed */ }

  function cleanup(): void {
    if (timer) clearTimeout(timer);
    try { sub?.unsubscribe(); } catch { /* already closed */ }
  }
  function fail(error: Error): void {
    if (phase !== "active") return;
    phase = "failing";
    cleanup();
    const sink = inFlightSink;
    void (async () => {
      if (sink) {
        try {
          await withDeadline(sink, sinkTimeoutMs, "snapshot sink settlement deadline exceeded");
        } catch { /* the transfer already has its primary failure */ }
      }
      phase = "settled";
      rejectDone(error);
    })();
  }
  function complete(): void {
    if (!eof || !metadata || phase !== "active") return;
    phase = "settled";
    cleanup();
    resolveDone(metadata);
  }

  const deadline = Date.now() + timeoutMs;
  void (async () => {
    await nc.flush();
    if (phase !== "active") return;
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new JetStreamBackupError(`snapshot ${stream}: transfer deadline exceeded`);
    const responseMsg = await nc.request(
      `$JS.API.STREAM.SNAPSHOT.${stream}`,
      JSON.stringify({
        deliver_subject: opts.deliverSubject,
        no_consumers: true,
        ...(opts.checkMessages ? { jsck: true } : {}),
      }),
      { timeout: remaining },
    );
    if (phase !== "active") return;
    const response = decodeJson<ApiErrorResponse & { config?: Record<string, unknown>; state?: Record<string, unknown> }>(
      responseMsg.data,
      `snapshot ${stream} initiation`,
    );
    throwApiError(response, `snapshot ${stream} initiation`);
    if (!response.config || !response.state)
      throw new JetStreamBackupError(`snapshot ${stream} initiation: response omitted config or state`);
    metadata = { config: response.config, state: validateBackupStreamState(response.state) };
    complete();
  })().catch((cause) => fail(cause instanceof Error ? cause : new Error(String(cause))));
  return done;
}

export interface StreamRestoreSession {
  stream: string;
  deliverSubject: string;
}

/** Initiate restore with caller-supplied, current canonical config and separately validated state.
 * Snapshot-embedded config is never trusted or sent to the target broker. */
export async function initiateStreamRestore(
  nc: NatsConnection,
  space: string,
  stream: string,
  config: Readonly<Record<string, unknown>>,
  state: Readonly<Record<string, unknown>>,
  timeoutMs = DEFAULT_TRANSFER_TIMEOUT_MS,
): Promise<StreamRestoreSession> {
  const canonicalConfig = validateCanonicalBackupStreamConfig(space, stream, config);
  const canonicalState = validateBackupStreamState(state);
  const responseMsg = await nc.request(
    `$JS.API.STREAM.RESTORE.${stream}`,
    JSON.stringify({ config: canonicalConfig, state: canonicalState }),
    { timeout: timeoutMs },
  );
  const response = decodeJson<ApiErrorResponse & { deliver_subject?: string }>(responseMsg.data, `restore ${stream} initiation`);
  throwApiError(response, `restore ${stream} initiation`);
  if (!response.deliver_subject) throw new JetStreamBackupError(`restore ${stream} initiation: missing deliver_subject`);
  assertExactSubject(response.deliver_subject, "restore deliver_subject");
  if (!response.deliver_subject.startsWith(`$JS.SNAPSHOT.RESTORE.${stream}.`))
    throw new JetStreamBackupError(`restore ${stream} initiation returned a cross-stream delivery subject`);
  return { stream, deliverSubject: response.deliver_subject };
}

/** Upload one non-empty binary restore chunk and await the server's storage ACK. */
export async function uploadStreamRestoreChunk(
  nc: NatsConnection,
  session: StreamRestoreSession,
  chunk: Uint8Array,
  timeoutMs = DEFAULT_TRANSFER_TIMEOUT_MS,
): Promise<void> {
  if (!(chunk instanceof Uint8Array) || chunk.length === 0)
    throw new Error("restore chunks must be non-empty Uint8Array values; empty is reserved for finalization");
  const response = await nc.request(session.deliverSubject, chunk, { timeout: timeoutMs });
  const error = statusError(response, `restore ${session.stream} chunk`);
  if (error) throw error;
  if (response.data.length)
    throw new JetStreamBackupError(`restore ${session.stream} chunk: ${new TextDecoder().decode(response.data)}`);
}

export interface StreamRestoreResult {
  config: Record<string, unknown>;
  state: BackupStreamState;
}

/** Send the empty EOF request and require the final stream-create response. */
export async function finalizeStreamRestore(
  nc: NatsConnection,
  session: StreamRestoreSession,
  timeoutMs = DEFAULT_TRANSFER_TIMEOUT_MS,
): Promise<StreamRestoreResult> {
  const responseMsg = await nc.request(session.deliverSubject, new Uint8Array(0), { timeout: timeoutMs });
  const transportError = statusError(responseMsg, `restore ${session.stream} finalization`);
  if (transportError) throw transportError;
  const response = decodeJson<ApiErrorResponse & { config?: Record<string, unknown>; state?: Record<string, unknown> }>(
    responseMsg.data,
    `restore ${session.stream} finalization`,
  );
  throwApiError(response, `restore ${session.stream} finalization`);
  if (!response.config || !response.state)
    throw new JetStreamBackupError(`restore ${session.stream} finalization: response omitted config or state`);
  return { config: response.config, state: validateBackupStreamState(response.state) };
}

export interface PersistentConsumerCheckpoint {
  stream: string;
  name: string;
  ackFloorStreamSequence: number;
  creationLowerBound: number;
  streamState: Pick<BackupStreamState, "messages" | "first_seq" | "last_seq">;
}

function principalFromDurable(name: string, prefix: string): { owner: string; actor: string } | undefined {
  if (!name.startsWith(prefix)) return undefined;
  const match = /^([A-Za-z0-9_]+)-([A-Za-z0-9_]+)$/.exec(name.slice(prefix.length));
  return match ? { owner: match[1], actor: match[2] } : undefined;
}

function expectedConsumerConfig(space: string, stream: string, name: string): Partial<ConsumerConfig> {
  if (stream === chatStream(space) && name === FANOUT_DURABLE) return fanoutDurableConfig(space);
  if (stream === inboxStream(space) && name === INBOX_READER_DURABLE) return inboxReaderConfig(space);
  if (stream === dmStream(space)) {
    const principal = principalFromDurable(name, "dm_");
    if (principal) return dmDurableConfig(space, principal.owner, principal.actor);
  }
  if (stream === dlvStream(space)) {
    const principal = principalFromDurable(name, "dlv_");
    if (principal) return dlvDurableConfig(space, principal.owner, principal.actor);
  }
  if (stream === taskStream(space) && /^svc_[A-Za-z0-9_-]+$/.test(name))
    return { ...taskDurableConfig(space, name.slice("svc_".length)), deliver_policy: DeliverPolicy.All };
  throw new Error(`unsupported persistent consumer ${stream}/${name}`);
}

const CONSUMER_KEYS = new Set([
  "ack_policy", "ack_wait", "backoff", "deliver_group", "deliver_policy", "deliver_subject",
  "description", "durable_name", "filter_subject", "filter_subjects", "flow_control", "headers_only",
  "idle_heartbeat", "inactive_threshold", "max_ack_pending", "max_batch", "max_bytes", "max_deliver",
  "max_expires", "max_waiting", "mem_storage", "metadata", "name", "num_replicas", "opt_start_seq",
  "opt_start_time", "pause_until", "priority_groups", "priority_policy", "priority_timeout",
  "rate_limit_bps", "replay_policy", "sample_freq",
]);

/** Validate one recognized Cotal pull durable. Limits-retention consumers accept the checkpoint
 * migration shape; TASK remains canonical WorkQueue DeliverAll. */
export function validatePersistentConsumer(space: string, stream: string, info: ConsumerInfo): void {
  const expected = expectedConsumerConfig(space, stream, info.name);
  const config = info.config as ConsumerConfig & Record<string, unknown>;
  const unknown = Object.keys(config).filter((key) => !CONSUMER_KEYS.has(key));
  if (unknown.length) throw new Error(`${stream}/${info.name} has unsupported consumer fields: ${unknown.sort().join(", ")}`);
  if (config.name !== undefined && config.name !== info.name) throw new Error(`${stream}/${info.name} has a mismatched name`);
  if (config.durable_name !== info.name) throw new Error(`${stream}/${info.name} is not a canonical durable`);
  if (config.deliver_subject || config.deliver_group) throw new Error(`${stream}/${info.name} is a push consumer`);
  if (config.filter_subject !== expected.filter_subject || (config.filter_subjects?.length ?? 0) !== 0)
    throw new Error(`${stream}/${info.name} has a noncanonical filter`);
  if (config.ack_policy !== AckPolicy.Explicit || config.ack_wait !== expected.ack_wait)
    throw new Error(`${stream}/${info.name} has noncanonical ACK settings`);

  const task = stream === taskStream(space);
  const migrated = !task && config.deliver_policy === DeliverPolicy.StartSequence;
  const implicitTaskAll = task && config.deliver_policy === undefined;
  if (config.deliver_policy !== expected.deliver_policy && !migrated && !implicitTaskAll)
    throw new Error(`${stream}/${info.name} has a noncanonical delivery policy`);
  if (migrated) {
    if (!Number.isSafeInteger(config.opt_start_seq) || (config.opt_start_seq ?? 0) < 1)
      throw new Error(`${stream}/${info.name} has an invalid creation lower bound`);
  } else if (config.opt_start_seq !== undefined || config.opt_start_time !== undefined) {
    throw new Error(`${stream}/${info.name} has an unexpected start bound`);
  }

  const expectedMaxAck = expected.max_ack_pending ?? 1000;
  if ((config.max_ack_pending ?? 1000) !== expectedMaxAck) throw new Error(`${stream}/${info.name} has noncanonical max_ack_pending`);
  if ((config.max_deliver ?? -1) !== -1 || (config.max_waiting ?? 512) !== 512)
    throw new Error(`${stream}/${info.name} has noncanonical delivery limits`);
  if ((config.replay_policy ?? ReplayPolicy.Instant) !== ReplayPolicy.Instant || (config.num_replicas ?? 0) !== 0)
    throw new Error(`${stream}/${info.name} has noncanonical replay/replica settings`);
  for (const key of [
    "backoff", "description", "flow_control", "headers_only", "idle_heartbeat", "inactive_threshold",
    "max_batch", "max_bytes", "max_expires", "mem_storage", "metadata", "pause_until", "priority_groups",
    "priority_policy", "priority_timeout", "rate_limit_bps", "sample_freq",
  ]) {
    const value = config[key];
    if (
      key === "metadata" && value && typeof value === "object" && !Array.isArray(value) &&
      Object.entries(value as Record<string, unknown>)
        .every(([metadataKey, metadataValue]) => metadataKey.startsWith("_nats.") && typeof metadataValue === "string")
    ) continue;
    if (value !== undefined && value !== false && value !== 0 && value !== "" &&
      !(Array.isArray(value) && value.length === 0) &&
      !(typeof value === "object" && value !== null && Object.keys(value).length === 0))
      throw new Error(`${stream}/${info.name} has active unsupported setting ${key}`);
  }
}

/** Validate the complete consumer inventory for all eight streams and extract conservative checkpoints. */
export function validatePersistentConsumerInventory(
  space: string,
  consumersByStream: Readonly<Record<string, readonly ConsumerInfo[]>>,
  statesByStream: Readonly<Record<string, BackupStreamState>>,
): PersistentConsumerCheckpoint[] {
  const expectedStreams = spaceBackupInventory(space).full;
  const supplied = Object.keys(consumersByStream).sort();
  if (JSON.stringify(supplied) !== JSON.stringify([...expectedStreams].sort()))
    throw new Error("consumer inventory must contain exactly the eight backed-up streams");
  const suppliedStates = Object.keys(statesByStream).sort();
  if (JSON.stringify(suppliedStates) !== JSON.stringify([...expectedStreams].sort()))
    throw new Error("stream state inventory must contain exactly the eight backed-up streams");

  const checkpoints: PersistentConsumerCheckpoint[] = [];
  for (const stream of expectedStreams) {
    const state = validateBackupStreamState(statesByStream[stream] as unknown as Readonly<Record<string, unknown>>);
    const seen = new Set<string>();
    for (const info of consumersByStream[stream] ?? []) {
      if (seen.has(info.name)) throw new Error(`duplicate consumer ${stream}/${info.name}`);
      seen.add(info.name);
      validatePersistentConsumer(space, stream, info);
      const ackFloor = info.ack_floor.stream_seq;
      if (!Number.isSafeInteger(ackFloor) || ackFloor < 0)
        throw new Error(`${stream}/${info.name} has an invalid contiguous ACK floor`);
      const creationLowerBound = info.config.deliver_policy === DeliverPolicy.StartSequence
        ? info.config.opt_start_seq!
        : info.config.deliver_policy === DeliverPolicy.New
        ? Math.max(1, ackFloor + 1)
        : 1;
      const checkpoint: PersistentConsumerCheckpoint = {
        stream,
        name: info.name,
        ackFloorStreamSequence: ackFloor,
        creationLowerBound,
        streamState: {
          messages: state.messages,
          first_seq: state.first_seq,
          last_seq: state.last_seq,
        },
      };
      consumerConfigFromCheckpoint(space, checkpoint);
      checkpoints.push(checkpoint);
    }
  }
  return checkpoints;
}

/** Recreate a validated pull durable. Limits-retention consumers start after the contiguous ACK
 * floor and original lower bound; TASK uses WorkQueue DeliverAll because ACKed entries left the stream. */
export function consumerConfigFromCheckpoint(
  space: string,
  checkpoint: PersistentConsumerCheckpoint,
): Partial<ConsumerConfig> {
  if (!Number.isSafeInteger(checkpoint.ackFloorStreamSequence) || checkpoint.ackFloorStreamSequence < 0 ||
      !Number.isSafeInteger(checkpoint.creationLowerBound) || checkpoint.creationLowerBound < 1)
    throw new Error(`${checkpoint.stream}/${checkpoint.name} has an invalid checkpoint`);
  const state = checkpoint.streamState as unknown;
  if (!state || typeof state !== "object" || Array.isArray(state) ||
      JSON.stringify(Object.keys(state as Record<string, unknown>).sort()) !== JSON.stringify(["first_seq", "last_seq", "messages"]))
    throw new Error(`${checkpoint.stream}/${checkpoint.name} has an invalid checkpoint stream state`);
  const { messages, first_seq: firstSequence, last_seq: lastSequence } = state as Record<string, unknown>;
  validateBackupStreamState({
    messages,
    bytes: 0,
    first_seq: firstSequence,
    last_seq: lastSequence,
    consumer_count: 0,
  });
  if (checkpoint.ackFloorStreamSequence > (lastSequence as number))
    throw new Error(`${checkpoint.stream}/${checkpoint.name} ACK floor exceeds snapshot last sequence`);
  if (checkpoint.ackFloorStreamSequence === Number.MAX_SAFE_INTEGER)
    throw new Error(`${checkpoint.stream}/${checkpoint.name} ACK floor has no safe successor`);
  const lastSuccessor = (lastSequence as number) === Number.MAX_SAFE_INTEGER
    ? Number.MAX_SAFE_INTEGER
    : (lastSequence as number) + 1;
  if (checkpoint.creationLowerBound > lastSuccessor)
    throw new Error(`${checkpoint.stream}/${checkpoint.name} creation lower bound exceeds snapshot sequence window`);
  const expected = expectedConsumerConfig(space, checkpoint.stream, checkpoint.name);
  if (checkpoint.stream === taskStream(space)) {
    if (checkpoint.creationLowerBound !== 1)
      throw new Error(`${checkpoint.stream}/${checkpoint.name} has a noncanonical TASK creation lower bound`);
    return expected;
  }
  const startSequence = Math.max(
    checkpoint.ackFloorStreamSequence + 1,
    checkpoint.creationLowerBound,
    (firstSequence as number) || 1,
  );
  if (!Number.isSafeInteger(startSequence) || startSequence > lastSuccessor)
    throw new Error(`${checkpoint.stream}/${checkpoint.name} start sequence exceeds snapshot sequence window`);
  return {
    ...expected,
    deliver_policy: DeliverPolicy.StartSequence,
    opt_start_seq: startSequence,
  };
}

function checkpointCreateSubject(
  space: string,
  checkpoint: PersistentConsumerCheckpoint,
): { subject: string; config: Partial<ConsumerConfig> } {
  const config = consumerConfigFromCheckpoint(space, checkpoint);
  if (!config.filter_subject) throw new Error(`${checkpoint.stream}/${checkpoint.name} has no canonical single filter`);
  return {
    subject: `$JS.API.CONSUMER.CREATE.${checkpoint.stream}.${checkpoint.name}.${config.filter_subject}`,
    config: { ...config, name: checkpoint.name },
  };
}

/** Recreate one validated checkpoint through the NATS 2.10 extended create API, whose subject pins
 * stream, durable name, and its canonical single filter. */
export async function recreateConsumerCheckpoint(
  nc: NatsConnection,
  space: string,
  checkpoint: PersistentConsumerCheckpoint,
  timeoutMs = DEFAULT_TRANSFER_TIMEOUT_MS,
): Promise<ConsumerInfo> {
  const { subject, config } = checkpointCreateSubject(space, checkpoint);
  const responseMsg = await nc.request(
    subject,
    JSON.stringify({ stream_name: checkpoint.stream, config }),
    { timeout: timeoutMs },
  );
  const response = decodeJson<ApiErrorResponse & Partial<ConsumerInfo>>(
    responseMsg.data,
    `checkpoint ${checkpoint.stream}/${checkpoint.name}`,
  );
  throwApiError(response, `checkpoint ${checkpoint.stream}/${checkpoint.name}`);
  if (!response.name || !response.stream_name || !response.config || !response.ack_floor)
    throw new JetStreamBackupError(`checkpoint ${checkpoint.stream}/${checkpoint.name}: incomplete consumer response`);
  const info = response as ConsumerInfo;
  if (info.name !== checkpoint.name || info.stream_name !== checkpoint.stream)
    throw new JetStreamBackupError(`checkpoint ${checkpoint.stream}/${checkpoint.name}: response identity mismatch`);
  validatePersistentConsumer(space, checkpoint.stream, info);
  if (info.config.deliver_policy !== config.deliver_policy || info.config.opt_start_seq !== config.opt_start_seq)
    throw new JetStreamBackupError(`checkpoint ${checkpoint.stream}/${checkpoint.name}: response start policy mismatch`);
  return info;
}

export type BackupPermissionScope =
  | { operation: "snapshot"; stream: string; deliverSubject: string }
  | { operation: "inspect"; selection: SpaceBackupSelection };

export type RestorePermissionScope =
  | { operation: "initiate"; stream: string }
  | { operation: "upload"; stream: string; deliverSubject: string }
  | { operation: "validate"; stream: string }
  | { operation: "checkpoint"; checkpoint: PersistentConsumerCheckpoint };

/** Exact snapshot permission set. It has no stream read/admin verbs beyond one snapshot API; chunk
 * ACK authority is created dynamically for the exact reply received, never granted as a wildcard. */
export function backupProfilePermissions(
  space: string,
  connId: string,
  scope: BackupPermissionScope,
): Record<string, unknown> {
  assertInboxConnId(connId);
  const inbox = `_INBOX_${connId}.>`;
  if (scope.operation === "inspect") {
    if (scope.selection !== "full" && scope.selection !== "registry")
      throw new Error(`unsupported backup selection ${JSON.stringify(scope.selection)}`);
    const streams = spaceBackupInventory(space)[scope.selection];
    return {
      pub: {
        allow: [
          "$JS.API.STREAM.NAMES",
          ...streams.flatMap((stream) => [
            `$JS.API.STREAM.INFO.${stream}`,
            `$JS.API.CONSUMER.LIST.${stream}`,
          ]),
        ],
      },
      sub: { allow: [inbox] },
    };
  }
  if (scope.operation !== "snapshot")
    throw new Error(`unsupported backup operation ${(scope as { operation?: unknown }).operation}`);
  assertBackupStream(space, scope.stream);
  assertExactSubject(scope.deliverSubject, "backup deliverSubject");
  if (!scope.deliverSubject.startsWith(`_INBOX_${connId}.`))
    throw new Error("backup deliverSubject must be inside the credential's private inbox");
  return {
    pub: { allow: [`$JS.API.STREAM.SNAPSHOT.${scope.stream}`] },
    sub: { allow: [inbox, scope.deliverSubject] },
    // Each received chunk creates a one-use, short-lived permission for its exact server-generated
    // reply subject. A guessed or wrong snapshot ACK id remains denied.
    resp: { max: 1, ttl: nanos(60_000) },
  };
}

/** Restore initiation, exact-ID upload, stream validation, and one-checkpoint recreation are disjoint
 * credentials. No phase inherits a body-read verb or another phase's mutation authority. */
export function restoreProfilePermissions(
  space: string,
  connId: string,
  scope: RestorePermissionScope,
): Record<string, unknown> {
  assertInboxConnId(connId);
  const inbox = `_INBOX_${connId}.>`;
  if (scope.operation === "checkpoint") {
    const { subject } = checkpointCreateSubject(space, scope.checkpoint);
    return {
      pub: {
        allow: [
          subject,
          `$JS.API.CONSUMER.INFO.${scope.checkpoint.stream}.${scope.checkpoint.name}`,
        ],
      },
      sub: { allow: [inbox] },
    };
  }
  if (scope.operation !== "initiate" && scope.operation !== "upload" && scope.operation !== "validate")
    throw new Error(`unsupported restore operation ${(scope as { operation?: unknown }).operation}`);
  assertBackupStream(space, scope.stream);
  if (scope.operation === "initiate") {
    return { pub: { allow: [`$JS.API.STREAM.RESTORE.${scope.stream}`] }, sub: { allow: [inbox] } };
  }
  if (scope.operation === "validate") {
    return { pub: { allow: [`$JS.API.STREAM.INFO.${scope.stream}`] }, sub: { allow: [inbox] } };
  }
  assertExactSubject(scope.deliverSubject, "restore deliverSubject");
  if (!scope.deliverSubject.startsWith(`$JS.SNAPSHOT.RESTORE.${scope.stream}.`))
    throw new Error("restore deliverSubject does not belong to the scoped stream");
  return { pub: { allow: [scope.deliverSubject] }, sub: { allow: [inbox] } };
}
