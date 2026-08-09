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
  DiscardPolicy,
  RetentionPolicy,
  StorageType,
  type ConsumerConfig,
  type JetStreamManager,
  type StreamConfig,
} from "@nats-io/jetstream";
import { nanos } from "@nats-io/transport-node";
import type { Kvm } from "@nats-io/kv";
import { spacePrefix, token, assertInboxConnId } from "./subjects.js";
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
import { AUTHORITY_KIND_DEFS, callerReadableRecordKind } from "./endpoint-records.js";
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

/** The CLOSED set of streams a §13.1 retirement may record a frontier cutoff over: exactly the
 *  per-space streams that carry a retired lifecycle's durable data a later durable reader can
 *  replay (facts EPF, work EPW, events EPE, and the records KV). A retirement intent's
 *  `frontierStreams` must be a subset of this set; it is NOT a caller-selectable arbitrary stream
 *  list. This is the ONE source consumed by both the intent validation and the barrier's
 *  `STREAM.INFO` grant, so the frontier authority and the frontier-writable set never drift
 *  (nats-server subject ACLs cannot scope INFO to an intent-selected name). The auth store is
 *  deliberately absent: it is the control plane, never a lifecycle-data frontier. */
export function retirementFrontierStreams(space: string): string[] {
  return [epfStreamName(space), epwStreamName(space), epeStreamName(space), recordsKvStreamName(space)];
}

/** The per-space auth store (§13.12): credential ledger + issuance/source gates + session
 *  ledger. Trusted auth path ONLY — no agent/endpoint/observer/admin/host profile holds any
 *  grant — and `allow_direct=false`: every fence on it is a leader-served revision-pinned CAS,
 *  and Direct Get's follower/mirror reads would defeat read-your-writes (§13.1). */
export function epAuthBucket(space: string): string {
  return `cotal_auth_${token(space)}`;
}

/** The per-space SESSION ledger store (P2 item 6, §13.6): the `session.<id>` rows the manager's
 *  session plane CASes over. DEDICATED — split out of the auth bucket deliberately. KV reads are
 *  subject-BLIND (a `STREAM.MSG.GET` on a bucket serves any key, the campaign's known vector class),
 *  so co-locating session rows with credentials + gates would let the standing session-ledger cred read
 *  the whole control plane. A dedicated bucket makes that blind read STRUCTURALLY confined to session
 *  rows and nothing else. `allow_direct=false` for the SAME reason the auth bucket carries it: every
 *  ledger fence is a leader-served revision-pinned CAS (the one-use `createIssuing`, the finalize +
 *  terminal updates), and Direct Get's follower/mirror reads would defeat read-your-writes (§13.1). */
export function sessionsBucket(space: string): string {
  return `cotal_sessions_${token(space)}`;
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
 * streams, the work-pool WorkQueue, and the KV buckets (records + auth + the §13.6 session ledger).
 * Privileged — runs at space setup. `jsm.streams.add`/`kvm.create` are idempotent for an identical
 * config and FAIL LOUD on a config delta, which is wanted: a drifted resource is an operator error,
 * never silently adopted.
 *
 * The session byte SUBJECTS (`eps`) are deliberately absent: core-only, never captured (§13.12).
 * Only the durable `session.<id>` ledger rows are captured — in their own dedicated bucket
 * ({@link createSessionsStore}), never the auth bucket.
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
  // EPW — work pools, one item per subject. NO allow_direct: the §13.6 reconciliation probe
  // (an acked item leaves the WorkQueue, an in-flight one remains readable — exactly the
  // predicate) is a FENCING read that gates the re-enqueue decision, so it goes leader-served
  // STREAM.MSG.GET (SPEC 13.6:1797-1799), never a follower-servable Direct Get whose stale miss
  // would re-arm settled work. Nothing else reads EPW: the pool workers drain it via the
  // WorkQueue consumer (CONSUMER.MSG.NEXT), not by subject read.
  await jsm.streams.add({
    name: epwStreamName(space),
    subjects: [`${p}.epw.>`],
    retention: RetentionPolicy.Workqueue,
    storage: StorageType.File,
    allow_direct: false,
  });
  await ensureContractStore(jsm, space);
  await ensureAuthorityStores(jsm, kvm, space);
  // P2 item 6: the DEDICATED §13.6 session ledger bucket. The eps byte SUBJECTS stay core-only and
  // uncaptured (above), but the `session.<id>` ledger rows are a captured authority KV — kept in
  // their own bucket so the manager's standing session-ledger cred's bucket-blind STREAM.MSG.GET reads
  // ONLY session rows (the §13.9 subject-blindness structural fix). Provisioned here so every mesh
  // that ensures the endpoint streams (auth + open both run this at the manager's boot) has it.
  await createSessionsStore(jsm, kvm, space);
}

/**
 * Ensure the per-space CONTRACT store (EPC) exists with its normative shape (§13.7/§13.12) —
 * content-addressed artifacts, one immutable message per digest subject, create-only mediated
 * publication, NO age eviction (artifacts are permanent). allow_direct: the subject-scoped
 * last-by-subject read IS the fetch path.
 *
 * PER-SUBJECT IMMUTABILITY is BROKER-ENFORCED, not left to publisher cooperation (the append-shadow
 * blocker, live-confirmed by the panel). The create-only fence `Nats-Expected-Last-Subject-Sequence:
 * 0` is a publisher-SET header the `epc.*` publish grant cannot compel, so a non-cooperative
 * grant-holder could APPEND a second message to an already-published digest subject; `last_by_subj`
 * would then return that shadow and a fail-closed read would make the honest artifact permanently
 * unfetchable (deny_delete/deny_purge block recovery — an operator-reprovision-only DoS, and at
 * §13.11's ep-only cut the SOLE contract path). The store closes this at the SOURCE:
 * `max_msgs_per_subject: 1` + `discard: new` + `discard_new_per_subject: true` makes a second
 * publish to an occupied digest subject BROKER-REJECTED (err 10077) regardless of headers, so a
 * digest subject holds exactly one message forever. `deny_delete`/`deny_purge` then keep that one
 * message from being removed. (The read path additionally defends itself version-agnostically —
 * {@link fetchContractArtifact} prefers the create-only winner over any shadow — so a broker or a
 * legacy stream that lacked the per-subject cap is still safe.)
 *
 * Create-or-verify-AND-harden, safe at every authority-daemon boot (the {@link
 * ensureAuthorityStores} discipline): a fresh space gets the store created with the full shape; a
 * CLEAN pre-existing store (incl. a pre-hardening one from an earlier release, OR the config-A
 * footgun `max_msgs_per_subject:1` + `discard:old` that would DELETE the honest artifact) is UPDATED
 * to the three config-B flags (idempotent, like the records store's rollup/deny update) and then
 * VERIFIED - a shape that cannot be brought to config B FAILS LOUD, never silently adopted.
 *
 * The config-B upgrade ENFORCES per-subject immutability GOING FORWARD; it does NOT heal a shadow
 * that predates it. Applying `max_msgs_per_subject:1` trims each subject to its newest message, so a
 * legacy store that ALREADY holds a shadow (some digest subject with >1 message) would have the
 * honest create-only winner trimmed away and the shadow cemented. Rather than silently cement it,
 * the upgrade REFUSES LOUD on such a store (`messages > num_subjects`), so the operator reprovisions
 * a clean store. This is a narrow guard: a fresh deploy is born at config B and never reaches it.
 *
 * FAIL-LOUD IS THE AGENT'S DEFENSE (critic completeness item): because this verify refuses to serve
 * unless all three config-B flags are present, the manager NEVER serves an un-hardened EPC store —
 * so a shadow-append cannot exist on any store an agent reads. That is why the ordinary agent
 * baseline needs only the subject-scoped `last_by_subj` read (never the bare `next_by_subj` the
 * shadow fallback uses): on every store the manager actually serves, `last_by_subj` always verifies
 * and the fallback never triggers. The {@link fetchContractArtifact} create-only-winner fallback is
 * defense-in-depth for the publisher path (the executor, which holds `next_by_subj`) and for a
 * hypothetical un-hardened store the manager would refuse to serve anyway. On the pinned broker
 * floor (nats-server >= 2.12, well past the 2.9 that added `discard_new_per_subject`) config B always
 * lands; an older broker that ignores the flag is caught here and the daemon fails to start.
 */
export async function ensureContractStore(jsm: JetStreamManager, space: string): Promise<void> {
  const name = epcStreamName(space);
  const subject = `${spacePrefix(space)}.epc.>`;
  const hardening = { max_msgs_per_subject: 1, discard: DiscardPolicy.New, discard_new_per_subject: true } as const;
  if (await jsm.streams.info(name).catch(() => undefined) === undefined) {
    await jsm.streams.add({
      name,
      subjects: [subject],
      retention: RetentionPolicy.Limits,
      storage: StorageType.File,
      allow_direct: true,
      deny_delete: true,
      deny_purge: true,
      ...hardening,
    });
  } else {
    // Upgrade path: an EPC stream from a pre-hardening release lacks the per-subject cap. Add it
    // idempotently (a live update of max_msgs_per_subject + discard settings is allowed and, tested,
    // leaves a CLEAN store's artifacts intact). A stream that WON'T take the update surfaces at the
    // verify below.
    const info = await jsm.streams.info(name);
    const cur = info.config;
    if (cur.max_msgs_per_subject !== 1 || cur.discard !== DiscardPolicy.New || cur.discard_new_per_subject !== true) {
      // HEAL-OR-FAIL, never cement (critic upgrade-trim residual): applying max_msgs_per_subject:1
      // TRIMS each subject to its NEWEST message. On a CLEAN legacy store (create-only, ≤1 message
      // per subject) that trims nothing. But if a legacy store ALREADY holds a shadow (a raw append
      // left a subject with >1 message, from before this hardening existed), the trim would keep the
      // NEWEST (the shadow) and DELETE the honest create-only winner - cementing the shadow
      // permanently. `messages > num_subjects` is exactly "some subject has more than one message",
      // so refuse the upgrade LOUD there: the operator reprovisions a clean store rather than the
      // daemon silently trim-cementing a pre-existing shadow. (Fresh deploys are born at config B and
      // never reach this; the check only guards a legacy store that was shadowed before its first
      // config-B boot.)
      const { messages, num_subjects } = info.state;
      if (messages > 0 && (num_subjects === undefined || messages > num_subjects))
        throw new Error(`the contract store ${name} is a pre-hardening stream that cannot be proven clean (${messages} messages across ${String(num_subjects)} subjects) - a subject holding more than one message means a shadow-append predates this immutability upgrade, and applying the per-subject cap would TRIM to the newest (shadow) message and delete the honest artifact; reprovision a clean store rather than cement the shadow (SPEC 13.7/13.12)`);
      await jsm.streams.update(name, { ...cur, ...hardening });
    }
  }
  const cfg = (await jsm.streams.info(name)).config as StreamConfig & { discard_new_per_subject?: boolean };
  if (cfg.allow_direct !== true || cfg.deny_delete !== true || cfg.deny_purge !== true)
    throw new Error(`the contract store ${name} has a drifted shape (allow_direct=${String(cfg.allow_direct)}, deny_delete=${String(cfg.deny_delete)}, deny_purge=${String(cfg.deny_purge)}); an authority store is never silently adopted - reprovision it (SPEC 13.12)`);
  if (cfg.max_msgs_per_subject !== 1 || cfg.discard !== DiscardPolicy.New || cfg.discard_new_per_subject !== true)
    throw new Error(`the contract store ${name} does not enforce per-subject immutability (max_msgs_per_subject=${String(cfg.max_msgs_per_subject)}, discard=${String(cfg.discard)}, discard_new_per_subject=${String(cfg.discard_new_per_subject)}); a digest subject must hold exactly one broker-immutable message or an append-shadow can DoS the store - reprovision it (SPEC 13.7/13.12)`);
  if (!Array.isArray(cfg.subjects) || cfg.subjects.length !== 1 || cfg.subjects[0] !== subject)
    throw new Error(`the contract store ${name} does not carry exactly the subject ${subject} (got ${JSON.stringify(cfg.subjects)}); a stream that captures anything else is not the contract store - reprovision it (SPEC 13.12)`);
  if (cfg.storage !== "file")
    throw new Error(`the contract store ${name} has storage ${JSON.stringify(cfg.storage)}, not file; a non-durable contract store forgets permanent artifacts on restart - reprovision it (SPEC 13.12)`);
}

/**
 * Ensure the two per-space AUTHORITY stores exist with their normative shape (§13.12):
 *
 *  - **Records KV** (`cotal_records_<space>`) — per-key CAS; rows are never deleted.
 *    deny_delete/deny_purge close stream-API erasure as defense in depth (a raw KV subject grant
 *    can still emit a DEL marker, which every reader treats as corruption); rollups off. Fenced
 *    reads stay leader-served STREAM.MSG.GET (§13.9).
 *  - **Auth KV** (`cotal_auth_<space>`) — leader-served only (`allow_direct=false`); per-key TTL
 *    machinery on (`cred.`/`bysrc.` rows), NO bucket age.
 *
 * Create-or-verify, so it is safe at EVERY authority-daemon boot (not only first setup): a fresh
 * space gets both stores created; an existing store is verified against the exact flags above and
 * a drift FAILS LOUD naming the store — a drifted authority store is an operator error, never
 * silently adopted (§13.12: the flags are load-bearing for deny-new and the barrier CAS fences).
 */
export async function ensureAuthorityStores(jsm: JetStreamManager, kvm: Kvm, space: string): Promise<void> {
  // CREATE-IF-ABSENT then UNCONDITIONALLY VERIFY: `Kvm.create` opens an existing stream WITHOUT
  // comparing its config (a drifted pre-existing stream is the NORMAL success path, not an error),
  // so the create call proves nothing. Both the just-created and the pre-existing store flow
  // through the SAME final `streams.info` + full normative verify — a drifted authority store is
  // an operator error, never silently adopted (§13.12: the flags + store-binding are load-bearing
  // for deny-new and the barrier CAS fences).
  const recordBucket = recordsBucket(space);
  const recordStream = `KV_${recordBucket}`;
  if (await jsm.streams.info(recordStream).catch(() => undefined) === undefined) {
    await kvm.create(recordBucket, { allow_direct: true });
    const recordConfig = (await jsm.streams.info(recordStream)).config;
    await jsm.streams.update(recordStream, { ...recordConfig, allow_rollup_hdrs: false, deny_delete: true, deny_purge: true });
  }
  const recordCfg = (await jsm.streams.info(recordStream)).config;
  if (recordCfg.allow_direct !== true || recordCfg.allow_rollup_hdrs !== false || recordCfg.deny_delete !== true || recordCfg.deny_purge !== true)
    throw new Error(`the records store ${recordBucket} has a drifted shape (allow_direct=${String(recordCfg.allow_direct)}, allow_rollup_hdrs=${String(recordCfg.allow_rollup_hdrs)}, deny_delete=${String(recordCfg.deny_delete)}, deny_purge=${String(recordCfg.deny_purge)}); an authority store is never silently adopted - reprovision it (SPEC 13.12)`);
  assertAuthorityStoreBinding(recordCfg, recordBucket);

  const authBucket = epAuthBucket(space);
  const authStream = `KV_${authBucket}`;
  if (await jsm.streams.info(authStream).catch(() => undefined) === undefined)
    await kvm.create(authBucket, { allow_direct: false, markerTTL: EP_AUTH_MARKER_TTL_MS });
  const authCfg = (await jsm.streams.info(authStream)).config as StreamConfig & { allow_msg_ttl?: boolean };
  if (authCfg.allow_direct !== false || authCfg.allow_msg_ttl !== true)
    throw new Error(`the auth store ${authBucket} has a drifted shape (allow_direct=${String(authCfg.allow_direct)}, allow_msg_ttl=${String(authCfg.allow_msg_ttl)}); an authority store is never silently adopted - reprovision it (SPEC 13.12)`);
  assertAuthorityStoreBinding(authCfg, authBucket);
}

/** Create (idempotently) the per-space SESSION ledger store (P2 item 6, §13.6): the DEDICATED
 *  {@link sessionsBucket} the manager's session plane CASes `session.<id>` rows over. Kept OUT of
 *  {@link ensureAuthorityStores} deliberately — the auth path never touches session rows, and the
 *  manager provisions this store from its own boot — but it wears the SAME authority-store shape as
 *  the auth bucket: `allow_direct=false` (every ledger fence is a leader-served revision-pinned CAS,
 *  and Direct Get's follower reads would defeat read-your-writes, §13.1) plus the per-key TTL
 *  machinery (a terminal/expired session row can carry a delete-marker TTL). The dedication is the
 *  security substance: the standing session-ledger cred's `kv.get` is a bucket-blind body-selected read,
 *  and a bucket holding ONLY `session.>` rows makes that read expose nothing but session state — the
 *  structural fix for the §13.9 subject-blindness a shared auth bucket would carry (creds + gates).
 *  Create-or-verify, safe at every manager boot; a drifted store FAILS LOUD (§13.12). */
export async function createSessionsStore(jsm: JetStreamManager, kvm: Kvm, space: string): Promise<void> {
  const bucket = sessionsBucket(space);
  const stream = `KV_${bucket}`;
  if (await jsm.streams.info(stream).catch(() => undefined) === undefined)
    await kvm.create(bucket, { allow_direct: false, markerTTL: EP_AUTH_MARKER_TTL_MS });
  const cfg = (await jsm.streams.info(stream)).config as StreamConfig & { allow_msg_ttl?: boolean };
  if (cfg.allow_direct !== false || cfg.allow_msg_ttl !== true)
    throw new Error(`the sessions store ${bucket} has a drifted shape (allow_direct=${String(cfg.allow_direct)}, allow_msg_ttl=${String(cfg.allow_msg_ttl)}); an authority store is never silently adopted - reprovision it (SPEC 13.12)`);
  assertAuthorityStoreBinding(cfg, bucket);
}

/** The store-BINDING half of the verify (SPEC 13.12): a stream wearing an authority bucket's name
 *  must BE that KV bucket — exactly the one `$KV.<bucket>.>` subject (an extra captured subject
 *  would put foreign bodies inside every body-selected MSG.GET grant on the stream) and durable
 *  file storage (a memory store forgets fences and revocations on restart). */
function assertAuthorityStoreBinding(cfg: StreamConfig, bucket: string): void {
  const expected = `$KV.${bucket}.>`;
  if (!Array.isArray(cfg.subjects) || cfg.subjects.length !== 1 || cfg.subjects[0] !== expected)
    throw new Error(`the store ${bucket} does not carry exactly the subject ${expected} (got ${JSON.stringify(cfg.subjects)}); a stream that captures anything else is not this KV bucket - reprovision it (SPEC 13.12)`);
  if (cfg.storage !== "file")
    throw new Error(`the store ${bucket} has storage ${JSON.stringify(cfg.storage)}, not file; a non-durable authority store forgets fences and revocations on restart - reprovision it (SPEC 13.12)`);
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
    throw new Error(`${what}: the config's durable/filter diverged from the tuple its family builder minted (minted ${JSON.stringify(bond.durable)} on ${JSON.stringify(bond.filter)}, now ${JSON.stringify(cfg.durable_name ?? "")} on ${JSON.stringify(cfg.filter_subject ?? "")}); a mutated config is not §13.9 authority`);
  // §13.9 pre-created consumers are PULL-only: a create's delivery target is body-set and
  // unconfined, so a post-mint deliver_subject would fan the stream out to an arbitrary subject.
  if (cfg.deliver_subject !== undefined)
    throw new Error(`${what}: the config carries a deliver_subject; §13.9 family consumers are PULL-only, a push delivery target is unconfined`);
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
    // UNLIMITED delivery, pinned EXPLICITLY (not left to the server default): the §13.6 virtual
    // admission fence counts pool occupancy as num_pending + num_ack_pending, and a message that
    // exhausts a FINITE max_deliver stays stored but leaves both counters, silently falsifying
    // the count. MaxDeliver is editable post-create, so the occupancy reader ALSO fails closed
    // on any reported value other than -1 (readPoolOccupancy); this pin makes intent explicit
    // and the drift check enforceable.
    max_deliver: -1,
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

/** PRIVATE frozen `kind → authority-head arity` snapshot, built ONCE at module load from the
 *  canonical (runtime-frozen) {@link AUTHORITY_KIND_DEFS}. The reader seam consults THIS map,
 *  never the live export, on every call: the public collection is frozen for contract honesty,
 *  and the seam's guard additionally survives even a hypothetical defeat of that freeze (the
 *  panel's identity-vs-integrity closure: single-source provenance is not post-construction
 *  integrity; the seam reads a private immutable copy). */
const AUTHORITY_HEAD_ARITY: ReadonlyMap<string, number> = new Map(
  AUTHORITY_KIND_DEFS.map((d) => [d.kind, 1 + d.qualifiers.length]),
);

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
  const kind = tail[0];
  // The grant family is a per-kind subtree: the kind token pins it. A `*` kind would read
  // across every registered kind — a trusted-reader grant family, not a caller capability.
  if (kind === "*")
    throw new Error(`record-reader subtree ${JSON.stringify(args.subtree)} must pin its record kind (a cross-kind read is not a caller capability, §13.9)`);
  // ENFORCED partition, ALLOWLIST not deny-list (panel + freelance a559d9c re-verify, #8274): the
  // kind MUST be a registered CALLER-readable record kind. This refuses every AUTHORITY-CONTROL
  // kind (oblig, the sealed records scanner's EXCLUSIVE domain, plus uid/govern/policy/frontier)
  // AND any UNREGISTERED kind, both of which a reader durable would durably EXPORT past revoke. It
  // consumes the same canonical {@link AUTHORITY_KIND_DEFS} the registry is built from, so a new
  // authority kind is excluded by construction: no parallel list to drift. The two refusals are
  // DISTINCT messages (the ux review): an authority kind is forbidden by design with no recourse,
  // while an unregistered kind is usually a typo or a missing registerRecordKind and the caller
  // needs that next step, not the forbidden-kinds list.
  if (!callerReadableRecordKind(kind)) {
    if (AUTHORITY_HEAD_ARITY.has(kind)) {
      const authorityKinds = AUTHORITY_KIND_DEFS.filter((d) => !callerReadableRecordKind(d.kind)).map((d) => d.kind).join("/");
      throw new Error(`record-reader subtree ${JSON.stringify(args.subtree)} targets the authority-control kind ${JSON.stringify(kind)}; authority-control kinds (${authorityKinds}) are never caller reader capabilities by design: their keys are the auth process's own authority state, enumerated only by its sealed scanner (§13.9, nats-server#8274)`);
    }
    throw new Error(`record-reader subtree ${JSON.stringify(args.subtree)} targets ${JSON.stringify(kind)}, which is not a registered record kind; check the kind for a typo, or register it (registerRecordKind, §13.7) before granting a reader over it`);
  }
  // DUAL-token head-disjointness: a kind that is caller-readable AND also carries an authority head
  // (only `lifecycle` today: its atomic HEAD `lifecycle.<owner>.<actor>` is the authority mapping,
  // while `lifecycle.<owner>.<actor>.<uid>.{spec,status}` is the caller audit detail). A reader
  // admits ONLY filters STRICTLY DEEPER than the head (§13.9): never one that can match the atomic
  // head key itself (that key IS the authority mapping), and never a fully-concrete filter
  // SHALLOWER than the head, which can match no record at all (the head is exactly head-arity
  // tokens and the audit detail is deeper), so a dead reader grant refuses loud at mint time.
  // The arity comes from the PRIVATE module-load snapshot, never the live export.
  const headLen = AUTHORITY_HEAD_ARITY.get(kind);
  if (headLen !== undefined) {
    const endsWild = tail[tail.length - 1] === ">";
    const concreteLen = endsWild ? tail.length - 1 : tail.length;
    // A trailing `>` matches subjects of length >= concreteLen+1, so it can match the headLen-token
    // head iff concreteLen < headLen; a fully-concrete filter matches iff its length equals headLen.
    const canMatchHead = endsWild ? concreteLen < headLen : tail.length === headLen;
    if (canMatchHead)
      throw new Error(`record-reader subtree ${JSON.stringify(args.subtree)} can match the authority HEAD key ${JSON.stringify(kind)}.<${headLen - 1} token(s)>; a caller reader may read only the deeper per-UID audit detail, never the ${JSON.stringify(kind)} authority head (§13.9, nats-server#8274)`);
    if (!endsWild && tail.length < headLen)
      throw new Error(`record-reader subtree ${JSON.stringify(args.subtree)} is SHALLOWER than the ${JSON.stringify(kind)} authority head (${headLen} tokens); it can match no record (the caller-readable audit detail is strictly deeper than the head), so the grant would be dead; deepen the filter to the per-UID audit subtree (§13.9)`);
  }
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

/** The canonicalizer principal's POOL-ROUTE rows (§13.9 matrix "Work-pool enqueue" +
 *  "Work-pool reconciliation probe"): the `epw.<e>.>` enqueue publish (create-per-subject rides
 *  the `Nats-Expected-Last-Subject-Sequence: 0` header, §13.6) and the FENCING leader-served
 *  `STREAM.MSG.GET` reconciliation read the §13.6 predicate and the enqueue's CAS-loser
 *  byte-identity check both require (EPW is `allow_direct=false`, so this is the ONLY read
 *  path). The MSG.GET form is BODY-selected (no per-subject confinement in the grant), so these
 *  rows are TRUSTED-canonicalizer-only: never on the pool owner (bind-only,
 *  {@link poolOwnerBindGrants}), never on any caller, observer, or admin profile. The full
 *  canonicalizer aggregate for an endpoint with pool routes is
 *  `[...canonicalizerGrants(...), ...canonicalizerWorkGrants(...)]`. */
export function canonicalizerWorkGrants(space: string, endpoint: string): string[] {
  return [
    `${spacePrefix(space)}.epw.${endpointToken(endpoint)}.>`,
    `${JSAPI}.STREAM.MSG.GET.${epwStreamName(space)}`,
  ];
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

/** The ADMISSION MEDIATOR principal's rows (§13.9 matrix "Acceptance obligation", §13.8): the
 *  ONE writer of ITS endpoint's `oblig.` subtree (create-only winner + revision-pinned CAS;
 *  the target position is a principal wildcard, the endpoint token is LITERAL) plus the
 *  terminal-REJECTION publish on its own endpoint's create-only decision subjects, the fencing
 *  leader reads (records / EPF / EPW `STREAM.MSG.GET`), and the §13.12 bind-time shape proof
 *  (records `STREAM.INFO`). The reply inbox is connection-scoped (`_INBOX_<connId>.>`, never the
 *  account-wide default): every JS API call is request/reply, so an account-wide inbox would
 *  receive other principals' API replies.
 *
 *  NO `CONSUMER.CREATE` on the records stream (SPEC 13.9, site 3 — nats-server#8274). A
 *  consumer-create request BODY is not subject-ACL confinable: the extended
 *  `CONSUMER.CREATE.<records>.<name>.<oblig filter>` row this profile used to hold still admitted a
 *  `durable_name` + PUSH `deliver_subject` body — a durable exporter of the endpoint's whole
 *  `oblig.` subtree that SURVIVES this credential's connection and revoke (reproduced live). So the
 *  mediator's drain-to-quiescence enumeration runs on the SEALED records scanner
 *  ({@link ../../implementations/auth/src/records-scanner.ts openRecordsScanner}), a separate
 *  self-minted credential the trusted process never hands out — this profile holds no consumer
 *  lifecycle on the records stream at all.
 *
 *  D32 residuals, EXPLICIT (accepted only for this trusted per-endpoint profile): (1) the
 *  decision publish is payload-blind, so a compromised mediator can forge an ACCEPTANCE within
 *  its own endpoint — an escalation to injecting executed work, never merely reject/stall —
 *  because rejection-only is not subject-expressible (both decisions MUST share the create-only
 *  decision subject for first-wins settlement); it can never forge beyond its endpoint. (2) its
 *  own-endpoint `$KV...oblig` subject grant cannot enforce create-only/monotonic CAS: it can
 *  overwrite a row to valid `terminal` and hide cleanup debt, or emit DEL/PURGE markers (the
 *  latter fail loud as corruption; stream-level erasure is denied). (3) the body-selected
 *  `STREAM.MSG.GET` fencing reads expose the records/EPF/EPW streams space-wide, and raw JS API
 *  requests carry a caller-selected reply subject, so a compromised mediator can direct fetched
 *  API/message bytes onto a foreign rail (confused-deputy injection, not foreign read access).
 *  The former consumer-create durable-export reach is CLOSED: enumeration moved to the sealed
 *  records scanner and this profile holds no records-stream CREATE. */
export function admissionMediatorGrants(space: string, endpoint: string, connId: string): { publish: string[]; subscribe: string[] } {
  const e = endpointToken(endpoint);
  const stream = recordsKvStreamName(space);
  const obligFilter = `$KV.${recordsBucket(space)}.oblig.*.${e}.>`;
  const publish = [
    obligFilter,
    `${spacePrefix(space)}.epf.${e}.dec.>`,
    `${JSAPI}.STREAM.MSG.GET.${stream}`,
    `${JSAPI}.STREAM.MSG.GET.${epfStreamName(space)}`,
    `${JSAPI}.STREAM.MSG.GET.${epwStreamName(space)}`,
    `${JSAPI}.STREAM.INFO.${stream}`,
    `${JSAPI}.INFO`,
  ];
  return { publish, subscribe: [`_INBOX_${assertInboxConnId(connId)}.>`] };
}

/** The RETIREMENT CLEANER principal's rows (§13.9 matrix "Terminal pool cleanup", §13.1
 *  barrier): minted per (retirement op × endpoint) with the EXACT pools the op intent
 *  enumerates — never a pool wildcard, never space-wide EPW rights. Per listed pool: BIND-ONLY
 *  on the provisioner-pre-created durable (INFO/MSG.NEXT/ACK, never create/update/delete). Plus
 *  the leader-served EPF `STREAM.MSG.GET` its terminal-observe and acceptance re-bind reads
 *  require — a STREAM-level grant whose read exposure is space-wide; that residual is EXPLICIT
 *  per D32 and accepted only for this trusted, bounded-lived, per-op profile. The cleaner holds
 *  NO terminal-publish or lease authority: the op-bounded executor CASes the lease and publishes
 *  its derived terminal, and the cleaner re-reads it before ACK. D32 residuals: raw ACK cannot be
 *  conditioned on a prior terminal, so compromise can suppress listed-pool work terminal-free;
 *  the space-wide EPF `STREAM.MSG.GET` exposes fact content, and its caller-selected reply can
 *  inject fetched API/message bytes onto a foreign rail. The reply inbox is
 *  connection-scoped (`_INBOX_<connId>.>`, never the account-wide default). NO `epw.>` publish,
 *  NO consumer create/update/delete, NO raw stream DELETE. The profile is revoked and its
 *  principal cluster-verified-evicted by the barrier BEFORE any frontier records (§13.1). */
export function retirementCleanerGrants(space: string, endpoint: string, pools: string[], connId: string): { publish: string[]; subscribe: string[] } {
  if (!Array.isArray(pools) || pools.length === 0)
    throw new Error("a retirement-cleaner grant lists at least one exact pool (SPEC 13.9: the op intent enumerates them; a poolless cleaner is no cleaner)");
  endpointToken(endpoint);
  const publish: string[] = [];
  for (const pool of pools) {
    const p = assertPoolToken(pool);
    publish.push(...consumeBindRows(epwStreamName(space), poolDurable(endpoint, p)));
  }
  publish.push(`${JSAPI}.STREAM.MSG.GET.${epfStreamName(space)}`, `${JSAPI}.INFO`);
  return { publish, subscribe: [`_INBOX_${assertInboxConnId(connId)}.>`] };
}

/** The endpoint's COMMIT PRINCIPAL rows (§13.9 matrix "Result/receipt/terminal/resume facts" +
 *  "Claim / action / checkpoint commits"): the enumerated commit fact families on its OWN
 *  endpoint — `goal.*.*.*.*.result` (the goal terminal; the `.bind` leaf under `goal.>` is the
 *  canonicalizer's), `eff.>`, `receipt.>`, `wrk.>`, `cp.>` — and **never `dec.>`/`quar.>`**
 *  (canonicalizer-only; structurally absent from these rows, not merely unused), plus its own
 *  record keys per the §13.7 writer table (`goal.<e>.>`, `cp.<e>.>`, `lease.<e>.>`; the endpoint
 *  qualifier is the FIRST qualifier of all three kinds, so the prefix is subject-expressible).
 *  Read-back is FENCING and therefore leader-served (§13.9 read service): body-selected
 *  `STREAM.MSG.GET` on `EPF_<space>` (create-only CAS emission + idempotent re-commit decisions
 *  over exactly its five fact families) and on `KV_cotal_records_<space>` (the terminal-commit's
 *  spec read and the epoch/deadline currency reads) — the follower-served `DIRECT.GET` forms are
 *  deliberately NOT granted. The reply inbox is connection-scoped (`_INBOX_<connId>.>`, never
 *  the account-wide default).
 *
 *  D32 residuals, EXPLICIT (accepted only for this trusted per-endpoint profile): (1) every
 *  fact publish is payload-blind create-only, so a compromised commit principal can forge an
 *  in-endpoint `wrk`/`goal…result` terminal or `cp` resume for work that never ran — an
 *  escalation to fabricating completed work within its own endpoint, never beyond it; (2) its
 *  raw `$KV` subject grants cannot enforce the per-key CAS/monotonic discipline, so it can
 *  overwrite its own endpoint's goal/cp/lease rows (DEL/PURGE markers fail loud as corruption;
 *  stream-level erasure is denied by the store shape, §13.12); (3) the two body-selected
 *  `STREAM.MSG.GET` fencing reads expose the EPF and records streams space-wide, and a raw JS
 *  API request carries a caller-selected reply subject, so compromise can direct fetched
 *  API/message bytes onto a foreign rail (confused-deputy injection, not foreign write). */
export function commitPrincipalGrants(space: string, endpoint: string, connId: string): { publish: string[]; subscribe: string[] } {
  const e = endpointToken(endpoint);
  const p = spacePrefix(space);
  const records = recordsBucket(space);
  const publish = [
    `${p}.epf.${e}.goal.*.*.*.*.result`,
    // The (i) fence (SPEC 13.6, P2 item 3): an executor-pinned goal's terminal is EPOCH-SCOPED
    // (`…result.<execEpoch>`), one create-only subject per executor epoch, so the commit principal
    // publishes both the flat and the epoch-scoped result leaf.
    `${p}.epf.${e}.goal.*.*.*.*.result.*`,
    `${p}.epf.${e}.eff.>`,
    `${p}.epf.${e}.receipt.>`,
    `${p}.epf.${e}.wrk.>`,
    `${p}.epf.${e}.cp.>`,
    `$KV.${records}.goal.${e}.>`,
    `$KV.${records}.cp.${e}.>`,
    `$KV.${records}.lease.${e}.>`,
    `${JSAPI}.STREAM.MSG.GET.${epfStreamName(space)}`,
    `${JSAPI}.STREAM.MSG.GET.${recordsKvStreamName(space)}`,
    `${JSAPI}.INFO`,
  ];
  return { publish, subscribe: [`_INBOX_${assertInboxConnId(connId)}.>`] };
}

/** The SELF-MEDIATED GOAL-WRITER profile (P2 item 2 "spawn becomes an action"): a standing
 *  connection that both BINDS a goal at accept AND COMMITS its terminal, for an endpoint that
 *  accepts action goals INLINE on its ephemeral serve handler (Model B) rather than through a
 *  separate canonicalizer + effects executor. It is exactly {@link commitPrincipalGrants} (the
 *  `goal.*.*.*.*.result` terminal + `$KV.<records>.goal.<e>.>` record write + the two leader-served
 *  `STREAM.MSG.GET` fencing reads the substrate uses) PLUS the ONE row commitPrincipalGrants
 *  deliberately leaves to the canonicalizer — the goal `.bind` leaf
 *  (`epf.<e>.goal.*.*.*.*.bind`) — so this single principal owns the whole `accepted → terminal`
 *  goal-fact chain of its OWN endpoint. The endpoint's SERVE credential
 *  ({@link import("./endpoint-grants.js").epServePublishRows}) holds NONE of these: a serve
 *  connection is broker-DENIED every goal write, which is the item-2 privilege separation (the
 *  dedicated writer is minted on a distinct connection, the serve rails stay serve-only). All of
 *  commitPrincipalGrants' D32 residuals carry unchanged (payload-blind create-only publish; raw
 *  `$KV` cannot enforce the per-key CAS the substrate layers on; the two body-selected
 *  `STREAM.MSG.GET` reads expose EPF + records space-wide). The reply inbox is connection-scoped
 *  (`_INBOX_<connId>.>`). The `eff`/`wrk`/`receipt`/`cp`/`lease` families in the commit-principal
 *  base are inert for a goal-only endpoint (the manager writes none) but are the commit-principal
 *  profile's standard ceiling; a tighter goal-only ceiling is a follow-up if the panel prefers it. */
export function goalWriterGrants(space: string, endpoint: string, connId: string): { publish: string[]; subscribe: string[] } {
  const base = commitPrincipalGrants(space, endpoint, connId);
  const e = endpointToken(endpoint);
  const bindLeaf = `${spacePrefix(space)}.epf.${e}.goal.*.*.*.*.bind`;
  // must-5 Q-B — the reconcile index: the goal-writer records each accepted goal under
  // `goalidx.<e>.<caller triple>.<goalId>` (create-only) before the bind and deletes it at the
  // terminal, so a successor incarnation can settle orphaned goals. Key-pinned to THIS endpoint's
  // index subtree; the goal-writer holds NO records CONSUMER.CREATE (the boot sweep enumerates the
  // index over the PROVISIONER, never this standing connection).
  const indexRow = `$KV.${recordsBucket(space)}.goalidx.${e}.>`;
  // must-5 (a) — the own-gate currency belt: the manager reads its OWN issuance gate
  // (`epgate.<e>.<iid>`) over this connection before the first-terminal-fact CAS and skips a
  // superseded commit. The auth store is `allow_direct=false`, so the read is a body-selected
  // leader `STREAM.MSG.GET` that cannot be key-pinned to the single gate key — the SAME residual
  // class the `endpoint-serve-executor` carries (reads any auth-bucket row = gate + ledger
  // metadata, never bearer bytes), here on a standing rather than one-shot connection. The manager
  // reads ONLY `epgate.<e>.<iid>`; (a) is the fast-fail belt, (b) barrier-revoke is the durable fence.
  const gateRead = `${JSAPI}.STREAM.MSG.GET.KV_${epAuthBucket(space)}`;
  return { publish: [bindLeaf, indexRow, gateRead, ...base.publish], subscribe: base.subscribe };
}

/** The manager's SESSION-LEDGER rows (P2 item 6): the standing connection that owns the §13.6
 *  session ledger and NOTHING else. It holds NO session rail — not the wildcard it used to hold,
 *  not an exact one. That is the whole point of the split.
 *
 *  §13.6 gives the ledger a job the byte rails do not have: it is "a DURABLE named authority that
 *  survives the serving endpoint", the thing that still knows what to revoke after the endpoint
 *  serving a session is gone. So it is standing and renewable, while the rails it records are
 *  per-session, exact-subject, and die with their session ({@link import("./provision.js").Profile}
 *  `session-serving` / `session-caller`). An earlier revision fused the two into one standing
 *  credential carrying `eps.<endpoint>.*.<epoch>.{in,out}`, which contradicted §13.9:2526 ("no
 *  standing EPS grant exists on either side") and let one credential read and write every live
 *  session's bytes at that epoch. Splitting on the lifetime boundary is what removes the wildcard:
 *  the standing half no longer has rails to widen.
 *
 *  Its store is the DEDICATED {@link sessionsBucket}, NOT the auth bucket. The write is
 *  `$KV.<sessions>.session.*` (create-only CAS + revision-pinned update; `sessionLedgerKey` is the
 *  single-token `session.<id>`). The read is a bucket-blind leader `STREAM.MSG.GET` (allow_direct=
 *  false, so `kv.get` is a body-selected read that cannot be key-pinned) — but the dedicated bucket
 *  holds ONLY `session.>` rows, so that blind read exposes nothing but session ledger state,
 *  structurally closing the §13.9 subject-blindness the auth bucket carries (creds + gates). The
 *  reply inbox is connection-scoped. NO auth-bucket, records-bucket, or messaging-plane grant.
 *
 *  NAMED RESIDUAL: `session.*` is one token wide and carries no endpoint component, because a
 *  `sessionId` is an opaque unguessable token with no endpoint inside it. So this credential can
 *  read and CAS any session row in its space, including another endpoint's. That was equally true
 *  of the credential it replaces; it is not a regression, and it is confined to ledger STATE — row
 *  state and credential ids — never to session bytes, which now require a per-session credential
 *  this profile cannot mint. */
export function sessionLedgerGrants(space: string, connId: string): { publish: string[]; subscribe: string[] } {
  const SESS = sessionsBucket(space);
  return {
    publish: [
      `$KV.${SESS}.session.*`,              // ledger create/update — single-token key (`session.<id>`)
      `${JSAPI}.STREAM.MSG.GET.KV_${SESS}`, // kv.get: leader-served body-selected read, confined to the sessions bucket
      `${JSAPI}.STREAM.INFO.KV_${SESS}`,    // Kvm bind probe (§13.12)
      `${JSAPI}.INFO`,                       // JS-API context info (KV client)
    ],
    subscribe: [`_INBOX_${assertInboxConnId(connId)}.>`], // connection-scoped reply inbox
  };
}

/** The CONTRACT PUBLISHER principal's rows (§13.9 matrix "Contract-artifact publication" +
 *  the trusted-infra half of "Contract-artifact read"): publish `epc.*` (the digest-hex is ONE
 *  subject token; create-only rides `Nats-Expected-Last-Subject-Sequence: 0` at the typed path,
 *  §13.7 — the grant cannot express it, the broker CAS enforces it) and the subject-confined
 *  follower read-back `DIRECT.GET.EPC_<space>.cotal.<space>.epc.>` (NON-fencing by design:
 *  artifacts are content-addressed and verify-on-read is the tamper boundary, §13.7, so a
 *  stale replica serves nothing forgeable). NO `STREAM.INFO`: the deny_delete/deny_purge shape
 *  proof is the provisioner's (§13.12), not this profile's. The reply inbox is
 *  connection-scoped (`_INBOX_<connId>.>`, never the account-wide default).
 *
 *  D32 residuals, EXPLICIT: (1) the `epc.*` publish is payload-blind — a compromised publisher
 *  can publish garbage artifacts at NEW (previously-unused) digest subjects (verify-on-read refuses
 *  to SERVE non-canonical or digest-mismatched bytes, so this is a bounded storage flood carrying
 *  no authority). It can NOT overwrite, shadow, or replace an EXISTING published artifact: the EPC
 *  store's shape ({@link ensureContractStore}: `max_msgs_per_subject:1` + discard-new-per-subject)
 *  makes a second publish to an occupied digest subject broker-REJECTED regardless of the
 *  create-only header, so per-subject immutability is broker-enforced, not publisher-cooperative.
 *  (Earlier revisions relied on the cooperative create-only header alone and a fail-closed read,
 *  which the panel's live repro showed a non-cooperative publisher could defeat by raw append — a
 *  permanent shadow-DoS; the stream shape + the create-only-winner read fallback close it.) (2) the
 *  raw JS API request carries a caller-selected reply subject (the same confused-deputy injection
 *  class as every API-holding profile). */
export function contractPublisherGrants(space: string, connId: string): { publish: string[]; subscribe: string[] } {
  const publish = [
    `${spacePrefix(space)}.epc.*`,
    `${JSAPI}.DIRECT.GET.${epcStreamName(space)}.${spacePrefix(space)}.epc.>`,
    `${JSAPI}.INFO`,
  ];
  return { publish, subscribe: [`_INBOX_${assertInboxConnId(connId)}.>`] };
}
