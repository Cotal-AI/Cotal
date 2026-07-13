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
  assertGrantId,
  assertPoolToken,
  assertLifecycleToken,
  callerTokens,
  type EpCaller,
} from "./endpoint-subjects.js";
import type { RecordKindDef } from "./endpoint-records.js";
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
  // the subject-scoped last-by-subject read IS the fetch path. Permanence is BROKER-ENFORCED,
  // not just configured-by-omission: deny_delete/deny_purge make message deletion structurally
  // impossible even for a stream-API-holding principal, so a digest subject can never be
  // emptied and re-created (verify-on-read already pins WHAT the subject can hold; these flags
  // pin THAT it holds it — the §13.7 "permanent" claim as a broker property).
  await jsm.streams.add({
    name: epcStreamName(space),
    subjects: [`${p}.epc.>`],
    retention: RetentionPolicy.Limits,
    storage: StorageType.File,
    allow_direct: true,
    deny_delete: true,
    deny_purge: true,
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
 *  grant id, `<n>` the subtree's zero-based index within THAT grant. INJECTIVE by construction:
 *  `<uid>` is `-`-free (leading), `<n>` is digits (trailing), `<gid>` is separator-free
 *  (`assertGrantId`), so `<e>` is the ONLY `-`-bearing component and its extent is unambiguous
 *  (parse `<n>` and `<gid>` off the right, `<uid>` off the left, `<e>` is what remains). Without
 *  the separator-free `<gid>` the two soft components `<e>` and `<gid>` would collide
 *  (`eve_<uid>-a-b-c-0` = endpoint `a-b`/gid `c` OR endpoint `a`/gid `b-c`, §13.9). */
export function eventReaderDurable(uid: string, endpoint: string, grantId: string, n: number): string {
  if (!Number.isInteger(n) || n < 0) throw new Error(`event-reader subtree index must be a non-negative integer, got ${n}`);
  return `eve_${assertLifecycleToken(uid)}-${endpointToken(endpoint)}-${assertGrantId(grantId)}-${n}`;
}

/** `recD = rec_<uid>-<gid>-<n>` — one per granted record subtree (grammar as {@link eventReaderDurable};
 *  `<gid>` separator-free, `<uid>` `-`-free, `<n>` digits, so the single soft component is bounded). */
export function recordReaderDurable(uid: string, grantId: string, n: number): string {
  if (!Number.isInteger(n) || n < 0) throw new Error(`record-reader subtree index must be a non-negative integer, got ${n}`);
  return `rec_${assertLifecycleToken(uid)}-${assertGrantId(grantId)}-${n}`;
}

// ---- Infrastructure consumer configs (pull durables, explicit ack, full-tail single filters) ----
// Each config is created by exactly ONE principal per the §13.9 matrix; every filter below is
// the matrix row's full-tail form, so the emitted grants and these configs cannot diverge.

/** Family brand: every config a builder below mints is registered against the ONE §13.12
 *  stream its family lives on, together with an IMMUTABLE snapshot of the tuple the family
 *  minted (durable + filter). The grant-row builders accept ONLY branded (config, stream)
 *  pairs whose current fields still equal that snapshot — a raw hand-built config, a family
 *  config paired with a foreign stream, or a branded config whose durable/filter was mutated
 *  after mint all refuse loudly. (The snapshot, not a freeze, carries the guarantee: the
 *  config object itself is also handed to `jsm.consumers.add`, which must stay free to read
 *  it as a plain object.) This is what makes "the rows and the configs come from one place"
 *  STRUCTURAL: an authority row can never be built around a tuple the §13.9 matrix did not mint. */
interface FamilyBond { stream: string; durable: string; filter: string }
const FAMILY = new WeakMap<Partial<ConsumerConfig>, FamilyBond>();
function family(stream: string, cfg: Partial<ConsumerConfig>): Partial<ConsumerConfig> {
  FAMILY.set(cfg, { stream, durable: cfg.durable_name!, filter: cfg.filter_subject! });
  return cfg;
}
function assertFamilyPair(stream: string, cfg: Partial<ConsumerConfig>, what: string): void {
  const bond = FAMILY.get(cfg);
  if (bond === undefined)
    throw new Error(`${what} requires a consumer config minted by a §13.9 family builder, not a raw config (durable ${JSON.stringify(cfg.durable_name ?? "")})`);
  if (bond.stream !== stream)
    throw new Error(`${what}: durable ${JSON.stringify(cfg.durable_name ?? "")} belongs to stream ${JSON.stringify(bond.stream)}, not ${JSON.stringify(stream)} (§13.9: no cross-family pairing)`);
  if (cfg.durable_name !== bond.durable || cfg.filter_subject !== bond.filter)
    throw new Error(`${what}: the config's durable/filter diverged from the tuple its family builder minted (minted ${JSON.stringify(bond.durable)} on ${JSON.stringify(bond.filter)}, now ${JSON.stringify(cfg.durable_name ?? "")} on ${JSON.stringify(cfg.filter_subject ?? "")}) — a mutated config is not §13.9 authority`);
  // §13.9 pre-created consumers are PULL-only: a create's delivery target is body-set and
  // unconfined, so a post-mint deliver_subject would fan the stream out to an arbitrary subject.
  if (cfg.deliver_subject !== undefined)
    throw new Error(`${what}: the config carries a deliver_subject — §13.9 family consumers are PULL-only, a push delivery target is unconfined`);
}

/** The canonicalizer's durable on EPJ (`canon_<e>`): every raw submission to one endpoint.
 *  Acks only after the durable decision (and, for pool routes, after the enqueue), §13.4. */
export function canonConsumerConfig(
  space: string,
  endpoint: string,
  opts: { ackWaitMs?: number; maxAckPending?: number } = {},
): Partial<ConsumerConfig> {
  return family(epjStreamName(space), {
    durable_name: canonDurable(endpoint),
    filter_subject: `${spacePrefix(space)}.epj.${endpointToken(endpoint)}.>`,
    ack_policy: AckPolicy.Explicit,
    ack_wait: nanos(opts.ackWaitMs ?? 60_000),
    deliver_policy: DeliverPolicy.All,
    max_ack_pending: opts.maxAckPending ?? 1000,
  });
}

/** The endpoint's ONE shared effects durable on EPF (`eff_<e>`, filter `epf.<e>.dec.>`):
 *  instances pull-compete so each accepted decision effects exactly once live (at-least-once);
 *  ack ONLY after the effect is durably recorded (§13.9 ack barrier). */
export function effectsConsumerConfig(
  space: string,
  endpoint: string,
  opts: { ackWaitMs?: number; maxAckPending?: number } = {},
): Partial<ConsumerConfig> {
  return family(epfStreamName(space), {
    durable_name: effectsDurable(endpoint),
    filter_subject: `${spacePrefix(space)}.epf.${endpointToken(endpoint)}.dec.>`,
    ack_policy: AckPolicy.Explicit,
    ack_wait: nanos(opts.ackWaitMs ?? 60_000),
    deliver_policy: DeliverPolicy.All,
    max_ack_pending: opts.maxAckPending ?? 1000,
  });
}

/** A record kind's writer durable on EPR (`recw_<space>-<kind>`) — one principal and one
 *  consumer PER KIND, never a single writer draining every kind (§13.9). The filter is DERIVED
 *  from the kind's qualifier arity: a NATS `>` matches one-or-more tokens (it does NOT match a
 *  bare parent), so a kind with ≥1 qualifier filters `…<kind>.>` while a ZERO-qualifier kind
 *  (a single space-wide record) filters exactly `…<kind>` — else the writer would miss every
 *  write for that registered grammar. Takes the RecordKindDef so the arity cannot be guessed. */
export function recordWriterConsumerConfig(
  space: string,
  def: RecordKindDef,
  opts: { ackWaitMs?: number } = {},
): Partial<ConsumerConfig> {
  const kind = assertIdToken(def.kind, "record kind");
  const tail = def.qualifiers.length > 0 ? `.${kind}.>` : `.${kind}`;
  return family(eprStreamName(space), {
    durable_name: recordWriterDurable(space, def.kind),
    filter_subject: `${spacePrefix(space)}.epr.*.*.*${tail}`,
    ack_policy: AckPolicy.Explicit,
    ack_wait: nanos(opts.ackWaitMs ?? 60_000),
    deliver_policy: DeliverPolicy.All,
  });
}

/** The timer writer's durable on EPT_REQ (`timerw_<space>`, full-tail filter on `.schedule`).
 *  The writer validates each request (rejecting any client scheduling header and any
 *  stale-generation request) before publishing the authoritative `.armed` on EPT. */
export function timerWriterConsumerConfig(
  space: string,
  opts: { ackWaitMs?: number } = {},
): Partial<ConsumerConfig> {
  return family(eptReqStreamName(space), {
    durable_name: timerWriterDurable(space),
    filter_subject: `${spacePrefix(space)}.ept.*.*.*.*.schedule`,
    ack_policy: AckPolicy.Explicit,
    ack_wait: nanos(opts.ackWaitMs ?? 60_000),
    deliver_policy: DeliverPolicy.All,
  });
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
  return family(epwStreamName(space), {
    durable_name: poolDurable(endpoint, pool),
    filter_subject: `${spacePrefix(space)}.epw.${endpointToken(endpoint)}.${assertPoolToken(pool)}.>`,
    ack_policy: AckPolicy.Explicit,
    ack_wait: nanos(opts.ackWaitMs ?? 60_000),
  });
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
  return family(epfStreamName(space), {
    durable_name: decisionReaderDurable(caller.uid, endpoint),
    filter_subject: `${spacePrefix(space)}.epf.${endpointToken(endpoint)}.dec.${callerTokens(caller).join(".")}.>`,
    ack_policy: AckPolicy.Explicit,
    ack_wait: nanos(opts.ackWaitMs ?? 60_000),
    deliver_policy: DeliverPolicy.All,
  });
}

/** A caller's goal-result durable on EPF (`goal_<uid>-<e>`; grammar as {@link decisionReaderConfig}). */
export function goalReaderConfig(
  space: string,
  endpoint: string,
  caller: EpCaller,
  opts: { ackWaitMs?: number } = {},
): Partial<ConsumerConfig> {
  return family(epfStreamName(space), {
    durable_name: goalReaderDurable(caller.uid, endpoint),
    filter_subject: `${spacePrefix(space)}.epf.${endpointToken(endpoint)}.goal.${callerTokens(caller).join(".")}.>`,
    ack_policy: AckPolicy.Explicit,
    ack_wait: nanos(opts.ackWaitMs ?? 60_000),
    deliver_policy: DeliverPolicy.All,
  });
}

/** Assert a granted subtree filter is a full tail under `prefix` (§13.9 "JetStream API tails
 *  are always spelled in FULL"): a relative tail matches nothing, and a bare `prefix` or one
 *  climbing outside it would widen the reader past its capability. Tokens are literal or full
 *  `*` wildcards (whole-token `*` is NORMATIVE in granted subtrees — the per-goal event row
 *  wildcards the instanceId/epoch positions, §13.9; mint-time literalness constrains the
 *  DURABLE name, not the filter interior), with at most ONE trailing `.>` and never `>` alone
 *  (a whole-plane read is a trusted-reader grant family, not a caller capability). Returns the
 *  tail tokens (after `prefix.`) for provenance checks. */
function assertFullTail(filter: string, prefix: string, what: string): string[] {
  if (!filter.startsWith(`${prefix}.`))
    throw new Error(`${what} filter ${JSON.stringify(filter)} must be a full tail under ${JSON.stringify(prefix)} (§13.9)`);
  const toks = filter.slice(prefix.length + 1).split(".");
  toks.forEach((t, i) => {
    if (t === "*") return;
    if (t === ">" && i === toks.length - 1 && i > 0) return; // one trailing subtree wildcard, never the whole tail
    if (t.length === 0 || /[*>\s]/.test(t))
      throw new Error(`${what} filter ${JSON.stringify(filter)} token ${JSON.stringify(t)} is not a literal token, a full "*" token, or one trailing ">" (§13.9)`);
  });
  return toks;
}

/** `eveD = eve_<uid>-<e>-<gid>-<n>` — one per GRANTED event subtree (§13.9): a PULL durable the
 *  provisioner pre-creates with the capability's EXACT full-tail event filter, bound by the read
 *  mediator (never the caller). `subtree` is the granted `cotal.<space>.epe.…` tail verbatim
 *  (`<n>` is its zero-based index within the grant, sorted at mint). Live event progress is the
 *  caller's own core subscription; this durable is the mediator's catch-up reader. */
export function eventReaderConfig(
  space: string,
  args: { uid: string; endpoint: string; grantId: string; index: number; subtree: string },
  opts: { ackWaitMs?: number } = {},
): Partial<ConsumerConfig> {
  const tail = assertFullTail(args.subtree, `${spacePrefix(space)}.epe`, "event-reader subtree");
  // Durable and filter must carry ONE provenance: the durable's `<e>` names the endpoint the
  // grant was minted for, so a subtree addressing a DIFFERENT endpoint's events would let the
  // attributed durable read outside its mint scope.
  if (tail[0] !== endpointToken(args.endpoint))
    throw new Error(`event-reader subtree ${JSON.stringify(args.subtree)} names endpoint token ${JSON.stringify(tail[0])} but the durable is minted for ${JSON.stringify(endpointToken(args.endpoint))} (§13.9: durable and filter provenance must agree)`);
  return family(epeStreamName(space), {
    durable_name: eventReaderDurable(args.uid, args.endpoint, args.grantId, args.index),
    filter_subject: args.subtree,
    ack_policy: AckPolicy.Explicit,
    ack_wait: nanos(opts.ackWaitMs ?? 60_000),
    deliver_policy: DeliverPolicy.All,
  });
}

/** `recD = rec_<uid>-<gid>-<n>` — one per GRANTED record subtree (§13.9): a PULL durable over the
 *  records KV stream (`KV_cotal_records_<space>`), pre-created by the provisioner with the
 *  capability's EXACT full `$KV.cotal_records_<space>.…` subtree tail, bound by the read
 *  mediator. `<n>` is the subtree's zero-based index within the grant. */
export function recordReaderConfig(
  space: string,
  args: { uid: string; grantId: string; index: number; subtree: string },
  opts: { ackWaitMs?: number } = {},
): Partial<ConsumerConfig> {
  const tail = assertFullTail(args.subtree, `$KV.${recordsBucket(space)}`, "record-reader subtree");
  // The grant family is a per-kind subtree: the kind token pins it. A `*` kind would read
  // across every registered kind — a trusted-reader grant family, not a caller capability.
  if (tail[0] === "*")
    throw new Error(`record-reader subtree ${JSON.stringify(args.subtree)} must pin its record kind (a cross-kind read is not a caller capability, §13.9)`);
  return family(recordsKvStreamName(space), {
    durable_name: recordReaderDurable(args.uid, args.grantId, args.index),
    filter_subject: args.subtree,
    ack_policy: AckPolicy.Explicit,
    ack_wait: nanos(opts.ackWaitMs ?? 60_000),
    deliver_policy: DeliverPolicy.All,
  });
}

/** The backing JetStream STREAM of the records KV (its grant rows key on `KV_<bucket>`, §13.9). */
export function recordsKvStreamName(space: string): string { return `KV_${recordsBucket(space)}`; }

// ---- §13.9 JetStream API grant rows (the single source: derived from the SAME stream + config) ----
// permissionsFor folds these into a profile's `pub.allow`. Every CONSUMER.CREATE row pins the
// EXACT full-tail filter from the consumer config, so a holder can only create the consumer the
// matrix names, never a body-filter-selectable one; a bind-only holder gets INFO/MSG.NEXT/ACK
// with NO create and NO delete. The rows and the consumer configs come from one place here, so
// "the grant and the consumer cannot diverge" is structural, not a convention.

const JSAPI = "$JS.API";

/** A grant NAME component (stream or durable) occupies ONE token of an emitted permission row:
 *  it must be a literal wildcard-free name, or the row silently broadens to every stream/durable
 *  the wildcard matches (a `*` durable grants INFO/MSG.NEXT/ACK on ALL durables of the stream).
 *  Every grammar in this module emits `[A-Za-z0-9_-]`, so anything else is refused loudly. */
function assertGrantName(v: string, what: string): string {
  if (!/^[A-Za-z0-9_-]+$/.test(v))
    throw new Error(`${what} ${JSON.stringify(v)} must be a literal wildcard-free name component ([A-Za-z0-9_-]+)`);
  return v;
}
/** A consume-create row embeds the consumer's filter verbatim, so the filter's tokens become
 *  permission tokens: each must be a literal token, a full `*` token (the matrix's principal
 *  wildcards, e.g. the record writer's `epr.*.*.*`), or ONE trailing `>` — a malformed or
 *  mid-filter `>` token would broaden the row past the §13.9 matrix. */
function assertGrantFilter(filter: string, what: string): string {
  const toks = filter.split(".");
  toks.forEach((t, i) => {
    if (t === "*") return;
    if (t === ">" && i === toks.length - 1 && i > 0) return; // never the WHOLE filter
    if (t.length === 0 || /[*>\s]/.test(t))
      throw new Error(`${what} filter ${JSON.stringify(filter)} token ${JSON.stringify(t)} is not a literal token, a full "*" token, or one trailing ">"`);
  });
  return filter;
}

function consumeCreateRow(stream: string, cfg: Partial<ConsumerConfig>): string {
  // A create row is AUTHORITY: only a (config, stream) pair minted together by a §13.9 family
  // builder may become one — syntax checks alone cannot stop a raw config carrying a broad or
  // foreign-family filter under a legitimate stream + durable.
  assertFamilyPair(stream, cfg, "a consume-create grant");
  if (!cfg.durable_name || !cfg.filter_subject)
    throw new Error("a consume-create grant needs a durable_name and a full-tail filter_subject");
  // The extended-create form embeds the stored-subject filter tail verbatim (§13.9): pinning it
  // is what stops a body-selected filter.
  return `${JSAPI}.CONSUMER.CREATE.${assertGrantName(stream, "grant stream")}.${assertGrantName(cfg.durable_name, "grant durable")}.${assertGrantFilter(cfg.filter_subject, "consume-create")}`;
}
function consumeBindRows(stream: string, durable: string): string[] {
  assertGrantName(stream, "grant stream");
  assertGrantName(durable, "grant durable");
  return [
    `${JSAPI}.CONSUMER.INFO.${stream}.${durable}`,
    `${JSAPI}.CONSUMER.MSG.NEXT.${stream}.${durable}`,
    `$JS.ACK.${stream}.${durable}.>`,
  ];
}
function consumeDeleteRow(stream: string, durable: string): string {
  return `${JSAPI}.CONSUMER.DELETE.${assertGrantName(stream, "grant stream")}.${assertGrantName(durable, "grant durable")}`;
}

/** The canonicalizer principal's EPJ rows: it OWNS its durable (create) and consumes + acks it. */
export function canonicalizerGrants(space: string, endpoint: string): string[] {
  const stream = epjStreamName(space);
  const cfg = canonConsumerConfig(space, endpoint);
  return [consumeCreateRow(stream, cfg), ...consumeBindRows(stream, cfg.durable_name!)];
}

/** A serving instance's effects rows: BIND-ONLY on the provisioner-pre-created shared `eff_<e>`
 *  (INFO/MSG.NEXT/ACK, never create) — instances pull-compete, none owns the durable (§13.9). */
export function effectsBindGrants(space: string, endpoint: string): string[] {
  return consumeBindRows(epfStreamName(space), effectsDurable(endpoint));
}

/** A per-kind record-writer principal's EPR rows: owns + consumes + acks its `recw_<space>-<kind>`. */
export function recordWriterGrants(space: string, def: RecordKindDef): string[] {
  const stream = eprStreamName(space);
  const cfg = recordWriterConsumerConfig(space, def);
  return [consumeCreateRow(stream, cfg), ...consumeBindRows(stream, cfg.durable_name!)];
}

/** The timer-writer principal's EPT_REQ rows: owns + consumes + acks its `timerw_<space>`. */
export function timerWriterGrants(space: string): string[] {
  const stream = eptReqStreamName(space);
  const cfg = timerWriterConsumerConfig(space);
  return [consumeCreateRow(stream, cfg), ...consumeBindRows(stream, cfg.durable_name!)];
}

/** A pool-owning endpoint's EPW rows: BIND-ONLY on the provisioner-pre-created `pool_<e>_<pool>`
 *  (INFO/MSG.NEXT/ACK, never create — the bare create form is body-filter-selectable, §13.5/§13.9). */
export function poolOwnerBindGrants(space: string, endpoint: string, pool: string): string[] {
  return consumeBindRows(epwStreamName(space), poolDurable(endpoint, pool));
}

/** The read mediator's BIND-ONLY rows for one caller-scoped reader durable, on the stream the
 *  durable lives on (EPF for dec/goal, EPE for eve, `KV_cotal_records_<space>` for rec). */
export function readerBindGrants(stream: string, cfg: Partial<ConsumerConfig>): string[] {
  assertFamilyPair(stream, cfg, "a reader bind grant");
  if (!cfg.durable_name) throw new Error("a reader bind grant needs a durable_name");
  return consumeBindRows(stream, cfg.durable_name);
}

/** One pre-created durable the provisioner owns: its stream + the config (durable + full-tail filter). */
export interface PreCreatedDurable { stream: string; config: Partial<ConsumerConfig> }

/** The provisioner's rows for a batch of pre-created durables (§13.9): the exact full-tail
 *  CONSUMER.CREATE for every one it pre-creates, plus the matching CONSUMER.DELETE for
 *  deprovisioning — and nothing else (it never consumes; owners bind). The create pins each
 *  filter, so the provisioner can create ONLY the matrix's durables, not an arbitrary consumer. */
export function provisionerConsumerGrants(durables: PreCreatedDurable[]): string[] {
  const rows: string[] = [];
  for (const d of durables) {
    rows.push(consumeCreateRow(d.stream, d.config), consumeDeleteRow(d.stream, d.config.durable_name!));
  }
  return rows;
}
