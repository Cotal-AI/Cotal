import { Worker } from "node:worker_threads";
import { deadline, TimeoutError, type NatsConnection } from "@nats-io/transport-node";
import { jetstreamManager } from "@nats-io/jetstream";
import { Kvm } from "@nats-io/kv";
import { canonicalJson, CREDENTIAL_LIFETIMES, credsClaims, dialerFor, idFromCreds, isAccountNkey, observeBrokerConnectionIdentity,
  requireBrokerFloor, spaceQuiescenceReaderGrants, spaceQuiescenceResources, standaloneConnectOpts } from "@cotal-ai/core";
import { observeQueueQuiescence, type QueueQuiescenceObservation } from "./quiescence-queues.js";
import { observeWorkflowQuiescence } from "./quiescence-workflows.js";
import { observeAuthorityQuiescence } from "./quiescence-authority.js";
import { observeAnycastQuiescence } from "./quiescence-anycast.js";

export interface SpaceQuiescenceOptions {
  servers: string;
  space: string;
  /** The account pin comes from the host's provisioned space identity, not the credential. */
  accountPublicKey: string;
  /** A bounded native credential minted with the space-quiescence-reader profile. */
  creds: string;
  tls: boolean;
  timeoutMs?: number;
}

export interface SpaceQuiescenceObservation {
  state: "quiescent" | "active" | "unknown";
  complete: boolean;
  observedAt: number;
  reasons: Array<{ source: "credential" | "identity" | "queues" | "authority" | "workflows" | "anycast" | "stability" | "deadline" | "connection"; state: "active" | "unknown" }>;
  counts: { streams: number; consumers: number; authRecords: number; records: number; liveAuthorityRows: number; liveRootCredentialRows: number; unsettledAuthorityRows: number; activeRuns: number; waitingCheckpoints: number; armedTimers: number; anycastRecords: number; owedNotices: number; pendingRemovals: number };
}

function snapshot(value: QueueQuiescenceObservation): string {
  return canonicalJson({
    streams: [...value.streams].sort(([a], [b]) => a.localeCompare(b)).map(([name, info]) => [name, info.created, info.config, info.state]),
    consumers: [...value.consumers].sort(([a], [b]) => a.localeCompare(b)).map(([name, info]) => [name, info.created, info.config,
      info.num_pending, info.num_ack_pending, info.num_redelivered,
      info.delivered.consumer_seq, info.delivered.stream_seq, info.ack_floor.consumer_seq, info.ack_floor.stream_seq]),
  });
}

function observationOptions(opts: SpaceQuiescenceOptions) {
  if (typeof opts.tls !== "boolean" || typeof opts.servers !== "string" || !opts.servers || !isAccountNkey(opts.accountPublicKey))
    throw new Error("space quiescence requires explicit servers, TLS policy and a provisioned account pin");
  const resources = spaceQuiescenceResources(opts.space);
  const timeoutMs = opts.timeoutMs ?? 10_000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 2_147_483_647)
    throw new Error("space quiescence timeout must be a positive supported millisecond interval");
  return { resources, timeoutMs };
}

function emptyObservation(observedAt = Date.now()): SpaceQuiescenceObservation {
  return { state: "unknown", complete: false, observedAt, reasons: [],
    counts: { streams: 0, consumers: 0, authRecords: 0, records: 0, liveAuthorityRows: 0, liveRootCredentialRows: 0, unsettledAuthorityRows: 0, activeRuns: 0, waitingCheckpoints: 0, armedTimers: 0, anycastRecords: 0, owedNotices: 0, pendingRemovals: 0 } };
}

function observationUser(opts: SpaceQuiescenceOptions, startedAt: number): { user: string } | { error: "identity" | "credential" } {
  try {
    const user = idFromCreds(opts.creds), claims = credsClaims(opts.creds);
    if ((claims.nats?.issuer_account ?? claims.iss) !== opts.accountPublicKey) return { error: "identity" };
    const lifetime = CREDENTIAL_LIFETIMES["space-quiescence-reader"].defaultTtlSeconds;
    if (lifetime === undefined || !Number.isSafeInteger(claims.iat) || !Number.isSafeInteger(claims.exp) || claims.exp! <= startedAt / 1000 ||
        claims.iat! > startedAt / 1000 || claims.exp! <= claims.iat! || claims.exp! - claims.iat! > lifetime)
      return { error: "credential" };
    const expected = spaceQuiescenceReaderGrants(opts.space, user);
    for (const direction of ["pub", "sub"] as const) {
      const actual = claims.nats?.[direction];
      if (!actual || !Array.isArray(actual.allow) || (actual.deny?.length ?? 0) !== 0 ||
          canonicalJson([...actual.allow].sort()) !== canonicalJson([...expected[direction].allow].sort())) return { error: "credential" };
    }
    return { user };
  } catch { return { error: "credential" }; }
}

async function observeOwned<T>(opts: SpaceQuiescenceOptions, unknown: (source: "deadline" | "connection") => T): Promise<T> {
  const { timeoutMs } = observationOptions(opts), started = performance.now();
  let worker: Worker | undefined, timer: ReturnType<typeof setTimeout> | undefined;
  try {
    worker = new Worker(new URL("./space-quiescence-worker.js", import.meta.url), { env: {}, stdout: true, stderr: true });
    worker.stdout.resume(); worker.stderr.resume();
    return await new Promise<T>(resolve => {
      const expire = () => {
        const remaining = timeoutMs - (performance.now() - started);
        if (remaining > 0) timer = setTimeout(expire, remaining);
        else resolve(unknown("deadline"));
      };
      worker!.once("message", (result: T) => resolve(performance.now() - started >= timeoutMs ? unknown("deadline") : result));
      worker!.once("error", () => resolve(unknown("connection")));
      worker!.once("exit", () => resolve(unknown("connection")));
      expire();
      worker!.postMessage(opts);
    });
  } catch { return unknown("connection"); }
  finally {
    clearTimeout(timer);
    await worker?.terminate();
  }
}

/** Observe native work and authority in an owned worker, including startup in the deadline. Worker
 * exit closes even a native dial stalled before INFO; no private transport hooks are used. Credentials
 * cross only the private message channel. A quiescent result is not an ingress fence: the host must
 * fence issuance/connections, drain its serving lanes, and observe again before unloading an account. */
export async function observeSpaceQuiescence(opts: SpaceQuiescenceOptions): Promise<SpaceQuiescenceObservation> {
  return observeOwned(opts, source => {
    const result = emptyObservation(); result.reasons.push({ source, state: "unknown" }); return result;
  });
}

/** Worker-only native read body. The owning host waits for worker termination before returning. */
export async function observeSpaceQuiescenceInWorker(opts: SpaceQuiescenceOptions): Promise<SpaceQuiescenceObservation> {
  const { resources, timeoutMs } = observationOptions(opts);
  const startedAt = Date.now();
  const result = emptyObservation(startedAt);
  const unknown = (source: SpaceQuiescenceObservation["reasons"][number]["source"]) => {
    result.state = "unknown"; result.complete = false; result.reasons.push({ source, state: "unknown" });
    return result;
  };
  const credential = observationUser(opts, startedAt);
  if ("error" in credential) return unknown(credential.error);
  const { user } = credential;

  let nc: NatsConnection | undefined;
  let finished = false;
  const work = async (): Promise<SpaceQuiescenceObservation> => {
    const connection = await dialerFor(opts.servers)({ servers: opts.servers, ...standaloneConnectOpts({ creds: opts.creds, tls: opts.tls }),
      reconnect: false, maxReconnectAttempts: 0, timeout: timeoutMs, noAsyncTraces: true });
    if (finished) { await connection.close(); return result; }
    nc = connection;
    requireBrokerFloor(connection);
    const identity = await observeBrokerConnectionIdentity(connection, { user, account: opts.accountPublicKey });
    if (identity.state !== "matched") return unknown("identity");
    const jsm = await jetstreamManager(connection);
    const before = await observeQueueQuiescence(jsm, opts.space);
    if (finished) return result;
    result.counts.streams = before.streams.size;
    result.counts.consumers = before.consumersRead;
    result.counts.armedTimers = before.armedTimers;
    if (before.state === "unknown") return unknown("queues");
    const kvm = new Kvm(connection);
    const trackingInfo = before.streams.get(`KV_${resources.anycast}`);
    if (trackingInfo) {
      const tracking = await kvm.open(resources.anycast, { allow_direct: false });
      const anycast = await observeAnycastQuiescence(tracking, trackingInfo.state.messages);
      if (finished) return result;
      result.counts.anycastRecords = anycast.recordsEnumerated;
      result.counts.owedNotices = anycast.owedNotices;
      result.counts.pendingRemovals = anycast.pendingRemovals;
      if (anycast.unknown) return unknown("anycast");
    }
    const auth = await kvm.open(resources.auth, { allow_direct: false });
    const records = await kvm.open(resources.records, { allow_direct: false });
    const authority = await observeAuthorityQuiescence(auth, records, { space: opts.space, accountPublicKey: opts.accountPublicKey, nowMs: startedAt });
    if (finished) return result;
    result.counts.authRecords = authority.authRecords;
    result.counts.records = authority.lifecycleRecords;
    result.counts.liveAuthorityRows = authority.liveAuthorityRows;
    result.counts.liveRootCredentialRows = authority.liveRootCredentialRows;
    result.counts.unsettledAuthorityRows = authority.unsettledAuthorityRows;
    if (authority.unknown) return unknown("authority");
    const workflows = await observeWorkflowQuiescence(records);
    if (finished) return result;
    result.counts.activeRuns = workflows.activeRuns;
    result.counts.waitingCheckpoints = workflows.waitingCheckpoints;
    if (workflows.unknown) return unknown("workflows");
    const after = await observeQueueQuiescence(jsm, opts.space);
    if (finished) return result;
    if (after.state === "unknown" || snapshot(before) !== snapshot(after) || workflows.recordsEnumerated !== authority.lifecycleRecords)
      return unknown("stability");
    const finalIdentity = await observeBrokerConnectionIdentity(connection, { user, account: opts.accountPublicKey });
    if (finished) return result;
    if (finalIdentity.state !== "matched" || finalIdentity.serverId !== identity.serverId || connection.isClosed()) return unknown("identity");
    const observedAt = Date.now();
    if (observedAt < startedAt) return unknown("stability");
    result.observedAt = observedAt;
    if (before.state === "busy") result.reasons.push({ source: "queues", state: "active" });
    if (result.counts.owedNotices || result.counts.pendingRemovals) result.reasons.push({ source: "anycast", state: "active" });
    if (authority.liveAuthorityRows || authority.unsettledAuthorityRows) result.reasons.push({ source: "authority", state: "active" });
    if (workflows.activeRuns || workflows.waitingCheckpoints) result.reasons.push({ source: "workflows", state: "active" });
    result.state = result.reasons.length ? "active" : "quiescent";
    result.complete = true;
    return result;
  };
  try { return structuredClone(await deadline(work(), timeoutMs)); }
  catch (error) { return structuredClone(unknown(error instanceof TimeoutError ? "deadline" : "connection")); }
  finally { finished = true; await nc?.close(); }
}
