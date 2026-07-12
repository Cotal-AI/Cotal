/**
 * v0.4 NATS + JetStream binding (SPEC §13.12) — the per-space control-surface resources and
 * the §13.9 consumer-name grammar with the infrastructure consumer configs over them.
 *
 * Streams are space infrastructure: `STREAM.CREATE` is denied to agents, so
 * {@link createEndpointStreams} runs once at space setup (like `createSpaceStreams`). It is the
 * single source of the resource definitions — the table in §13.12 — so setup and every consumer
 * of a stream name can never diverge. Consumer CONFIGS here are equally single-source: each is
 * created by exactly one trusted principal (provisioner or the owning infra principal) and the
 * §13.9 grant rows are generated against these same names and filters.
 */
import {
  AckPolicy,
  DeliverPolicy,
  RetentionPolicy,
  StorageType,
  type ConsumerConfig,
  type JetStreamManager,
} from "@nats-io/jetstream";
import { nanos } from "@nats-io/transport-node";
import type { Kvm } from "@nats-io/kv";
import { spacePrefix, token } from "./subjects.js";
import {
  endpointToken,
  assertIdToken,
  assertPoolToken,
  assertLifecycleToken,
  callerTokens,
  type EpCaller,
} from "./endpoint-subjects.js";
import { epjStreamName, epfStreamName, canonDurable } from "./endpoint-journal.js";
import { recordsBucket } from "./endpoint-records.js";

// Re-exported so the binding module presents the complete §13.12 name table even though the
// journal/records helpers own the definitions their own logic is written against.
export { epjStreamName, epfStreamName, canonDurable, recordsBucket };

/** §13.12 stream names for the remaining per-space control-surface streams. */
export function epeStreamName(space: string): string { return `EPE_${token(space)}`; }
export function eptReqStreamName(space: string): string { return `EPT_REQ_${token(space)}`; }
export function eptStreamName(space: string): string { return `EPT_${token(space)}`; }
export function eprStreamName(space: string): string { return `EPR_${token(space)}`; }
export function epwStreamName(space: string): string { return `EPW_${token(space)}`; }
export function epcStreamName(space: string): string { return `EPC_${token(space)}`; }

/** The per-space auth store (§13.12): credential ledger + issuance/source gates + session
 *  ledger. Trusted auth path ONLY — no agent/endpoint/observer/admin/host profile holds any
 *  grant — and `allow_direct=false`: every fence on it is a leader-served revision-pinned CAS,
 *  and Direct Get's follower/mirror reads would defeat read-your-writes (§13.1). */
export function epAuthBucket(space: string): string {
  return `cotal_auth_${token(space)}`;
}

// ---- §13.12 retention knobs (documented defaults, overridable per space policy) ----

/** EPJ duplicate window: the server MINIMUM (100 ms), set explicitly. A `0` is not accepted
 *  (it normalizes to the 120 s default), and native dedupe is deliberately NOT relied upon —
 *  submitters never set `Nats-Msg-Id`, and a wide window is exactly the cross-caller
 *  suppression surface §13.4 refuses — so the window is pinned as small as the server allows. */
export const EPJ_DUPLICATE_WINDOW_MS = 100;

/** Default age bound on raw submissions (EPJ). The §13.12 floor is "≥ recovery/redelivery
 *  lag" of the canonicalizer; 24 h covers any realistic canonicalizer outage while keeping the
 *  untrusted log from growing unbounded. */
export const EP_SUBMISSION_MAX_AGE_MS = 24 * 60 * 60 * 1000;

/** Default age bound on events (EPE) — progress/catch-up telemetry, space policy. */
export const EP_EVENT_MAX_AGE_MS = 24 * 60 * 60 * 1000;

/** Default age bound on the two writer-ingress streams (EPT_REQ, EPR). The floor is
 *  "≥ writer recovery lag"; the same 24 h envelope as EPJ. */
export const EP_INGRESS_MAX_AGE_MS = 24 * 60 * 60 * 1000;

/** Default age bound on authoritative schedules + fires (EPT). The floor is
 *  "≥ max deadline + margin": a schedule stored longer than this cannot outlive its stream
 *  row, so the default admits deadlines up to ~30 days. */
export const EP_TIMER_MAX_AGE_MS = 31 * 24 * 60 * 60 * 1000;

/** Delete-marker TTL on the auth store — enables the stream's per-key TTL machinery
 *  (`allow_msg_ttl`), which `cred.`/`bysrc.` rows use (per-key TTL ≤ credential TTL). The
 *  bucket itself carries NO age retention: `gate.`/`srcgate.`/`session.` authority keys
 *  persist until explicitly terminal (§13.12). */
export const EP_AUTH_MARKER_TTL_MS = 60 * 60 * 1000;

export interface EndpointStreamOptions {
  /** Age bound on EPJ (default {@link EP_SUBMISSION_MAX_AGE_MS}). Floor: canonicalizer recovery lag. */
  submissionMaxAgeMs?: number;
  /** Age bound on EPF; 0/omitted = no age eviction (facts are the canonical record; horizons
   *  are enforced by policy above the broker, never by silently losing facts under a horizon). */
  factMaxAgeMs?: number;
  /** Age bound on EPE (default {@link EP_EVENT_MAX_AGE_MS}). */
  eventMaxAgeMs?: number;
  /** Age bound on EPT_REQ + EPR (default {@link EP_INGRESS_MAX_AGE_MS}). Floor: writer recovery lag. */
  ingressMaxAgeMs?: number;
  /** Age bound on EPT (default {@link EP_TIMER_MAX_AGE_MS}). Floor: max deadline + margin. */
  timerMaxAgeMs?: number;
}

/**
 * Create (idempotently) the §13.12 per-space control-surface resources: the seven JetStream
 * streams, the work-pool WorkQueue, and the two KV buckets. Privileged — runs at space setup.
 * `jsm.streams.add`/`kvm.create` are idempotent for an identical config and FAIL LOUD on a
 * config delta, which is wanted: a drifted resource is an operator error, never silently adopted.
 *
 * Sessions (`eps`) are deliberately absent: core-only, never captured (§13.12).
 */
export async function createEndpointStreams(
  jsm: JetStreamManager,
  kvm: Kvm,
  space: string,
  opts: EndpointStreamOptions = {},
): Promise<void> {
  const p = spacePrefix(space);
  // EPJ — raw submissions, untrusted, at-least-once. NO allow_direct (nothing reads it but the
  // canonicalizer's durable and harness MSG.GET); duplicate window pinned to the server minimum.
  await jsm.streams.add({
    name: epjStreamName(space),
    subjects: [`${p}.epj.>`],
    retention: RetentionPolicy.Limits,
    storage: StorageType.File,
    max_age: nanos(opts.submissionMaxAgeMs ?? EP_SUBMISSION_MAX_AGE_MS),
    duplicate_window: nanos(EPJ_DUPLICATE_WINDOW_MS),
  });
  // EPF — canonical facts; acceptance is create-only CAS; allow_direct serves the §13.9
  // last-by-subject fact reads (trusted principals only; callers read via the mediator).
  await jsm.streams.add({
    name: epfStreamName(space),
    subjects: [`${p}.epf.>`],
    retention: RetentionPolicy.Limits,
    storage: StorageType.File,
    allow_direct: true,
    ...(opts.factMaxAgeMs ? { max_age: nanos(opts.factMaxAgeMs) } : {}),
  });
  // EPE — events/progress.
  await jsm.streams.add({
    name: epeStreamName(space),
    subjects: [`${p}.epe.>`],
    retention: RetentionPolicy.Limits,
    storage: StorageType.File,
    max_age: nanos(opts.eventMaxAgeMs ?? EP_EVENT_MAX_AGE_MS),
  });
  // EPT_REQ — schedule REQUESTS. Message schedules DISABLED (the default; asserted by the
  // smoke): a client-set scheduling header here cannot arm anything, which is what closes the
  // ADR-51 confused deputy — only the timer writer's `.armed` publish (on EPT) schedules.
  await jsm.streams.add({
    name: eptReqStreamName(space),
    subjects: [`${p}.ept.*.*.*.*.schedule`],
    retention: RetentionPolicy.Limits,
    storage: StorageType.File,
    max_age: nanos(opts.ingressMaxAgeMs ?? EP_INGRESS_MAX_AGE_MS),
  });
  // EPR — record-write ingress, consumed only by the per-kind record writers.
  await jsm.streams.add({
    name: eprStreamName(space),
    subjects: [`${p}.epr.>`],
    retention: RetentionPolicy.Limits,
    storage: StorageType.File,
    max_age: nanos(opts.ingressMaxAgeMs ?? EP_INGRESS_MAX_AGE_MS),
  });
  // EPT — authoritative schedules (.armed) + fires (.fire). AllowMsgSchedules; each schedule
  // targets its sibling `.fire` (ADR-51 forbids target = publish subject), and both patterns
  // live on THIS stream because ADR-51 requires the target be captured by the same stream.
  await jsm.streams.add({
    name: eptStreamName(space),
    subjects: [`${p}.ept.*.*.*.*.armed`, `${p}.ept.*.*.*.*.fire`],
    retention: RetentionPolicy.Limits,
    storage: StorageType.File,
    allow_msg_schedules: true,
    max_age: nanos(opts.timerMaxAgeMs ?? EP_TIMER_MAX_AGE_MS),
  });
  // EPW — work pools, one item per subject. allow_direct serves the subject-confined
  // reconciliation probe: an acked item leaves the WorkQueue, an in-flight one remains
  // readable, which is exactly the §13.6 predicate.
  await jsm.streams.add({
    name: epwStreamName(space),
    subjects: [`${p}.epw.>`],
    retention: RetentionPolicy.Workqueue,
    storage: StorageType.File,
    allow_direct: true,
  });
  // EPC — content-addressed contract artifacts: one immutable message per digest subject,
  // create-only mediated publication, NO age eviction (artifacts are permanent). allow_direct:
  // the subject-scoped last-by-subject read IS the fetch path.
  await jsm.streams.add({
    name: epcStreamName(space),
    subjects: [`${p}.epc.>`],
    retention: RetentionPolicy.Limits,
    storage: StorageType.File,
    allow_direct: true,
  });
  // Records KV — per-key CAS; allow_direct for plain reads (the lifecycle head and every
  // fenced read still go leader-served STREAM.MSG.GET, a caller choice, §13.9).
  await kvm.create(recordsBucket(space), { allow_direct: true });
  // Auth KV — leader-served only; per-key TTL machinery on (cred./bysrc. rows), NO bucket age.
  await kvm.create(epAuthBucket(space), {
    allow_direct: false,
    markerTTL: EP_AUTH_MARKER_TTL_MS,
  });
}

// ---- §13.9 consumer-name grammar (normative; dash-form, collision-free by construction) ----

/** `poolD = pool_<e>_<pool>` — parses uniquely from its LAST `_` because a pool token contains
 *  no `_` (`[a-z0-9-]`) while `<e>` may. */
export function poolDurable(endpoint: string, pool: string): string {
  return `pool_${endpointToken(endpoint)}_${assertPoolToken(pool)}`;
}

/** `timerD = timerw_<space>` — the space's single timer-writer durable. */
export function timerWriterDurable(space: string): string {
  return `timerw_${token(space)}`;
}

/** `recwD-k = recw_<space>-<kind>` — ONE record-writer durable per record kind (§13.9's writer
 *  separation). Parses from its LAST `-`? No — from the FIRST `-` after the fixed prefix is
 *  ambiguous when the space token contains `-`; the collision-freedom argument is simpler: the
 *  durable exists once per (space, kind) pair inside a per-space stream, so only the `<kind>`
 *  tail must be unique within one space, and kinds are unique by the registry. The kind token
 *  is the `epr` subject's kind token (id grammar, dot-free). */
export function recordWriterDurable(space: string, kind: string): string {
  return `recw_${token(space)}-${assertIdToken(kind, "record kind")}`;
}

/** `effD = eff_<e>` — the endpoint's ONE shared effects durable (instances pull-compete). */
export function effectsDurable(endpoint: string): string {
  return `eff_${endpointToken(endpoint)}`;
}

/** `decD = dec_<uid>-<e>` — a caller's decision-reader durable (one per journal capability).
 *  Parses from its FIRST `-`: `<uid>` is `[a-z0-9]` and contains none. */
export function decisionReaderDurable(uid: string, endpoint: string): string {
  return `dec_${assertLifecycleToken(uid)}-${endpointToken(endpoint)}`;
}

/** `goalD = goal_<uid>-<e>` — a caller's goal-result durable (one per action capability). */
export function goalReaderDurable(uid: string, endpoint: string): string {
  return `goal_${assertLifecycleToken(uid)}-${endpointToken(endpoint)}`;
}

/** `eveD = eve_<uid>-<e>-<gid>-<n>` — one per granted event subtree: `<gid>` is the mint-time
 *  grant id (two independent mints for one lifecycle never collide), `<n>` the subtree's
 *  zero-based index within THAT grant. The deprovision key is `<uid>-…-<gid>-…`. */
export function eventReaderDurable(uid: string, endpoint: string, grantId: string, n: number): string {
  if (!Number.isInteger(n) || n < 0) throw new Error(`event-reader subtree index must be a non-negative integer, got ${n}`);
  return `eve_${assertLifecycleToken(uid)}-${endpointToken(endpoint)}-${assertIdToken(grantId, "grantId")}-${n}`;
}

/** `recD = rec_<uid>-<gid>-<n>` — one per granted record subtree (grammar as {@link eventReaderDurable}). */
export function recordReaderDurable(uid: string, grantId: string, n: number): string {
  if (!Number.isInteger(n) || n < 0) throw new Error(`record-reader subtree index must be a non-negative integer, got ${n}`);
  return `rec_${assertLifecycleToken(uid)}-${assertIdToken(grantId, "grantId")}-${n}`;
}

// ---- Infrastructure consumer configs (pull durables, explicit ack, full-tail single filters) ----
// Each config is created by exactly ONE principal per the §13.9 matrix; every filter below is
// the matrix row's full-tail form, so the emitted grants and these configs cannot diverge.

/** The canonicalizer's durable on EPJ (`canon_<e>`): every raw submission to one endpoint.
 *  Acks only after the durable decision (and, for pool routes, after the enqueue), §13.4. */
export function canonConsumerConfig(
  space: string,
  endpoint: string,
  opts: { ackWaitMs?: number; maxAckPending?: number } = {},
): Partial<ConsumerConfig> {
  return {
    durable_name: canonDurable(endpoint),
    filter_subject: `${spacePrefix(space)}.epj.${endpointToken(endpoint)}.>`,
    ack_policy: AckPolicy.Explicit,
    ack_wait: nanos(opts.ackWaitMs ?? 60_000),
    deliver_policy: DeliverPolicy.All,
    max_ack_pending: opts.maxAckPending ?? 1000,
  };
}

/** The endpoint's ONE shared effects durable on EPF (`eff_<e>`, filter `epf.<e>.dec.>`):
 *  instances pull-compete so each accepted decision effects exactly once live (at-least-once);
 *  ack ONLY after the effect is durably recorded (§13.9 ack barrier). */
export function effectsConsumerConfig(
  space: string,
  endpoint: string,
  opts: { ackWaitMs?: number; maxAckPending?: number } = {},
): Partial<ConsumerConfig> {
  return {
    durable_name: effectsDurable(endpoint),
    filter_subject: `${spacePrefix(space)}.epf.${endpointToken(endpoint)}.dec.>`,
    ack_policy: AckPolicy.Explicit,
    ack_wait: nanos(opts.ackWaitMs ?? 60_000),
    deliver_policy: DeliverPolicy.All,
    max_ack_pending: opts.maxAckPending ?? 1000,
  };
}

/** A record kind's writer durable on EPR (`recw_<space>-<kind>`, filter on the kind token of
 *  §13.2's `epr` grammar) — one principal and one consumer PER KIND, never a single writer
 *  draining every kind (§13.9). */
export function recordWriterConsumerConfig(
  space: string,
  kind: string,
  opts: { ackWaitMs?: number } = {},
): Partial<ConsumerConfig> {
  return {
    durable_name: recordWriterDurable(space, kind),
    filter_subject: `${spacePrefix(space)}.epr.*.*.*.${assertIdToken(kind, "record kind")}.>`,
    ack_policy: AckPolicy.Explicit,
    ack_wait: nanos(opts.ackWaitMs ?? 60_000),
    deliver_policy: DeliverPolicy.All,
  };
}

/** The timer writer's durable on EPT_REQ (`timerw_<space>`, full-tail filter on `.schedule`).
 *  The writer validates each request (rejecting any client scheduling header and any
 *  stale-generation request) before publishing the authoritative `.armed` on EPT. */
export function timerWriterConsumerConfig(
  space: string,
  opts: { ackWaitMs?: number } = {},
): Partial<ConsumerConfig> {
  return {
    durable_name: timerWriterDurable(space),
    filter_subject: `${spacePrefix(space)}.ept.*.*.*.*.schedule`,
    ack_policy: AckPolicy.Explicit,
    ack_wait: nanos(opts.ackWaitMs ?? 60_000),
    deliver_policy: DeliverPolicy.All,
  };
}

/** A pool's durable on the EPW WorkQueue (`pool_<e>_<pool>`, exact filter
 *  `epw.<e>.<pool>.>`) — provisioner-pre-created; the owning endpoint binds it (§13.5). Exact
 *  per-pool filters keep WorkQueue consumers non-overlapping by construction. `ack_wait` is
 *  ONLY the broker's redelivery-to-owner timer; the authoritative lease deadline lives in the
 *  owner's lease record (§13.12). */
export function poolConsumerConfig(
  space: string,
  endpoint: string,
  pool: string,
  opts: { ackWaitMs?: number } = {},
): Partial<ConsumerConfig> {
  return {
    durable_name: poolDurable(endpoint, pool),
    filter_subject: `${spacePrefix(space)}.epw.${endpointToken(endpoint)}.${assertPoolToken(pool)}.>`,
    ack_policy: AckPolicy.Explicit,
    ack_wait: nanos(opts.ackWaitMs ?? 60_000),
  };
}

/** A caller's decision-reader durable on EPF (`dec_<uid>-<e>`, exact filter on the caller's
 *  own `dec` triple) — pre-created PULL by the provisioner at capability mint; owned and bound
 *  by the READ MEDIATOR, never the caller (§13.9 mediated reads). */
export function decisionReaderConfig(
  space: string,
  endpoint: string,
  caller: EpCaller,
  opts: { ackWaitMs?: number } = {},
): Partial<ConsumerConfig> {
  return {
    durable_name: decisionReaderDurable(caller.uid, endpoint),
    filter_subject: `${spacePrefix(space)}.epf.${endpointToken(endpoint)}.dec.${callerTokens(caller).join(".")}.>`,
    ack_policy: AckPolicy.Explicit,
    ack_wait: nanos(opts.ackWaitMs ?? 60_000),
    deliver_policy: DeliverPolicy.All,
  };
}

/** A caller's goal-result durable on EPF (`goal_<uid>-<e>`; grammar as {@link decisionReaderConfig}). */
export function goalReaderConfig(
  space: string,
  endpoint: string,
  caller: EpCaller,
  opts: { ackWaitMs?: number } = {},
): Partial<ConsumerConfig> {
  return {
    durable_name: goalReaderDurable(caller.uid, endpoint),
    filter_subject: `${spacePrefix(space)}.epf.${endpointToken(endpoint)}.goal.${callerTokens(caller).join(".")}.>`,
    ack_policy: AckPolicy.Explicit,
    ack_wait: nanos(opts.ackWaitMs ?? 60_000),
    deliver_policy: DeliverPolicy.All,
  };
}
