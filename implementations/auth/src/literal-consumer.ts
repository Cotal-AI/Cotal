/**
 * The sealed literal-consumer lifecycle every auth scan runs (SPEC 13.9), written once: the
 * auth-ledger scans, the obligation scan and the manager goal-index scan each pass their stream,
 * literal consumer name and forced filter, and keep only their own per-row result handling.
 *
 * The caller owns serialization: every scan over one literal name runs on its scanner's
 * module-level per-space chain, so two scans never share, steal or delete each other's read.
 */
import { AckPolicy, DeliverPolicy, type JetStreamClient, type JetStreamManager } from "@nats-io/jetstream";
import { EpEnvelopeError, isConsumerNotFound } from "@cotal-ai/core";

/** Bounded inactivity (ns): a leaked orphan (a run that crashed before its unconditional delete)
 *  is broker-collected within this window, and the next run's pre-clean removes it by name. */
const INACTIVE_THRESHOLD_NS = 30_000_000_000;
/** Drain bounds (fail-closed, not spin). A LastPerSubject consumer over a quiescent family settles
 *  to zero pending in a handful of rounds; a concurrent same-subject overwrite (a mint that won its
 *  fence, a crashing revoker, an obligation settle) adds at most a bounded burst that the next round
 *  re-reads and drains. NOT "a frozen gate permits no new family writes" — the staged-mint/concurrent-revoke
 *  analysis disproves that; the completeness fence is the freshly-observed zero, and a run that
 *  cannot reach it (unbounded churn, a stuck delivery) fails closed rather than looping. */
const MAX_DRAIN_ROUNDS = 4096;
/** Consecutive rounds that observe pending > 0 yet deliver nothing before the scan fails closed —
 *  a consumer that claims pending but never delivers is a completeness hazard, not a slow one. */
const MAX_NO_PROGRESS_ROUNDS = 8;

/** Does a concrete delivered subject match the requested consumer filter (`*` one token, trailing
 *  `>` a non-empty remainder)? Revalidated PER MESSAGE in the drain: bind-verify proves the config
 *  once at create, this proves every delivered row still belongs to THIS scan's filter, so a
 *  foreign re-resolution of the literal name (a config swapped under the scan) is refused loud. */
const matchesFilter = (subject: string, pattern: string): boolean => {
  const s = subject.split("."), p = pattern.split(".");
  for (let i = 0; i < p.length; i++) {
    if (p[i] === ">") return s.length > i;
    if (i >= s.length || (p[i] !== "*" && p[i] !== s[i])) return false;
  }
  return s.length === p.length;
};

/** SMOKE-ONLY race windows. Never set in production.
 *  - `afterCreate` fires ONCE after the consumer is created + bind-verified but BEFORE the drain,
 *    forcing the create→drain race: a subject overwritten between them (evicting the pre-scan
 *    revision under history=1) is still returned at its CURRENT last.
 *  - `afterFirstFetch` fires ONCE after the FIRST drain fetch completes, forcing the mid-drain race:
 *    a subject delivered old in round 1 then overwritten re-appears as pending and is fetched in a
 *    later round (proving the drain re-reads `num_pending` to a fresh zero, not a stale local count). */
export interface LiteralConsumerProbe {
  afterCreate?: () => Promise<void>;
  afterFirstFetch?: () => Promise<void>;
}

/** One subject's newest delivered row, WITH its KV operation so the caller's parse layer can treat
 *  a DEL/PURGE marker as corruption (a bucket's own `keys()`/`watch()` would filter markers out). */
export interface DrainedRow {
  data: Uint8Array;
  seq: number;
  op: string | undefined;
}

/** One scan over a literal consumer: what it reads, and the scanner its refusals name. */
export interface LiteralConsumerScan {
  /** The scanner every refusal names, such as "the records scanner". */
  label: string;
  stream: string;
  /** The literal consumer name the scanner's grant pins. */
  name: string;
  /** The full forced filter subject, `$KV.<bucket>.<...>.>`. */
  filter: string;
  probe?: LiteralConsumerProbe;
}

/**
 * Run the sealed lifecycle over `scan.name` on `scan.stream`: a fail-closed pre-clean, a create
 * with the forced config only, a full bind-verify, a drain to a freshly observed zero, and an
 * unconditional delete. Returns the newest row per delivered subject.
 */
export async function drainLiteralConsumer(jsm: JetStreamManager, js: JetStreamClient, scan: LiteralConsumerScan): Promise<Map<string, DrainedRow>> {
  const { label, stream, name, filter, probe } = scan;

  // 1. FAIL-CLOSED pre-clean: PROVE the literal name absent before create (a leftover from a run
  // that crashed before its unconditional delete). Absence is proved ONLY by a confirmed delete
  // (`delete(...) === true`) or a structured ConsumerNotFound; a `false` return, a timeout, a
  // permission/leader error, or any other shape fails the scan (a surviving stale AckNone consumer
  // with an outstanding pull could otherwise advance deliveries and make this run silently omit
  // rows).
  let provedAbsent = false;
  try {
    provedAbsent = (await jsm.consumers.delete(stream, name)) === true;
  } catch (e) {
    if (isConsumerNotFound(e)) provedAbsent = true;
    else throw new EpEnvelopeError("unavailable", `${label} could not prove its literal consumer absent on ${stream} before create (pre-clean fails closed, SPEC 13.9): ${(e as Error)?.message ?? String(e)}`);
  }
  if (!provedAbsent)
    throw new EpEnvelopeError("unavailable", `${label}'s pre-clean did not confirm the literal consumer deleted or absent on ${stream}; refusing to create over an unproven consumer (fail-closed, SPEC 13.9)`);

  // 2. Create with the FORCED config ONLY (the seam derives every field; no caller config).
  try {
    await jsm.consumers.add(stream, {
      name,
      filter_subject: filter,
      ack_policy: AckPolicy.None,
      deliver_policy: DeliverPolicy.LastPerSubject,
      mem_storage: true,
      inactive_threshold: INACTIVE_THRESHOLD_NS,
    });
  } catch (e) {
    throw new EpEnvelopeError("unavailable", `${label} could not create its consumer on ${stream} (${filter}); the scan fails closed (SPEC 13.9): ${(e as Error)?.message ?? String(e)}`);
  }

  try {
    // 3. FULL bind-verify: the created consumer must carry EXACTLY the forced shape — the exact
    // name and single filter (no `filter_subjects` multi-filter), pull (no `deliver_subject`),
    // ephemeral (no `durable_name`), AckNone/LastPerSubject, memory storage, the bounded exact
    // inactivity. A drifted or foreign consumer of this name never feeds a scan.
    const info = await jsm.consumers.info(stream, name);
    const cfg = info.config as {
      name?: string; filter_subject?: string; filter_subjects?: string[];
      deliver_subject?: string; durable_name?: string; ack_policy?: string; deliver_policy?: string;
      mem_storage?: boolean; inactive_threshold?: number;
    };
    const drift =
      cfg.name !== name ? `name=${cfg.name}` :
      cfg.filter_subject !== filter ? `filter=${cfg.filter_subject}` :
      (Array.isArray(cfg.filter_subjects) && cfg.filter_subjects.length > 0) ? `filter_subjects=${JSON.stringify(cfg.filter_subjects)}` :
      cfg.deliver_subject !== undefined ? `deliver_subject=${cfg.deliver_subject}` :
      cfg.durable_name !== undefined ? `durable=${cfg.durable_name}` :
      cfg.ack_policy !== AckPolicy.None ? `ack=${cfg.ack_policy}` :
      cfg.deliver_policy !== DeliverPolicy.LastPerSubject ? `deliver=${cfg.deliver_policy}` :
      cfg.mem_storage !== true ? `mem_storage=${cfg.mem_storage}` :
      cfg.inactive_threshold !== INACTIVE_THRESHOLD_NS ? `inactive_threshold=${cfg.inactive_threshold}` :
      undefined;
    if (drift !== undefined)
      throw new EpEnvelopeError("failed-precondition", `${label}'s consumer on ${stream} does not carry the forced pull/LastPerSubject shape (${drift}); refusing the scan (SPEC 13.9)`);

    if (probe?.afterCreate) await probe.afterCreate();

    // 4. Drain to a FRESHLY-OBSERVED zero. `num_pending` is re-read each round (never a stale
    // initial count): a subject delivered old (a@1) and then overwritten while draining (a@4)
    // re-appears as pending and is fetched in a later round, so the result is one CURRENT row per
    // subject. The completeness fence is num_pending===0 — NOT a per-fetch `got===want` assertion,
    // which a concurrent eviction (a@1 replaced by a@4 between the info read and the fetch) would
    // trip falsely. Last-write-wins by concrete subject, keeping the HIGHEST safe sequence.
    const latest = new Map<string, DrainedRow>();
    const consumer = await js.consumers.get(stream, name);
    let noProgress = 0;
    for (let round = 0; ; round++) {
      const pending = (await consumer.info()).num_pending;
      if (pending === 0) break;
      if (round >= MAX_DRAIN_ROUNDS)
        throw new EpEnvelopeError("unavailable", `${label} under ${filter} never settled to zero pending after ${round} rounds; the scan fails closed (SPEC 13.9)`);
      const iter = await consumer.fetch({ max_messages: Math.min(pending, 256), expires: 5_000 });
      let got = 0;
      for await (const m of iter) {
        got++;
        // CLOSED subject validation, PER MESSAGE against THIS scan's exact filter: a foreign
        // subject never enters the result, and a literal-name consumer swapped to a different
        // config under the scan is refused loud instead of contaminating it.
        if (!matchesFilter(m.subject, filter))
          throw new EpEnvelopeError("internal", `${label} received subject ${m.subject} outside its requested filter ${filter}; refusing (a foreign re-resolution of the literal consumer name never feeds a scan, SPEC 13.9)`);
        // Safe positive stream sequence before any ordering decision (a garbled/zero seq never
        // wins a last-write-wins comparison).
        if (!Number.isSafeInteger(m.seq) || m.seq <= 0)
          throw new EpEnvelopeError("internal", `${label} received a non-positive/unsafe sequence ${m.seq} for ${m.subject}; refusing (SPEC 13.9)`);
        const prev = latest.get(m.subject);
        if (prev === undefined || m.seq > prev.seq)
          latest.set(m.subject, { data: m.data, seq: m.seq, op: m.headers?.get("KV-Operation") || undefined });
      }
      if (round === 0 && probe?.afterFirstFetch) await probe.afterFirstFetch();
      // A round that observed pending > 0 yet delivered nothing makes no progress toward the
      // fresh zero; a bounded run of those fails closed rather than looping to the round cap.
      if (got === 0) {
        if (++noProgress >= MAX_NO_PROGRESS_ROUNDS)
          throw new EpEnvelopeError("unavailable", `${label} under ${filter} reported pending but delivered nothing for ${noProgress} rounds; the scan fails closed (SPEC 13.9)`);
      } else {
        noProgress = 0;
      }
    }
    return latest;
  } finally {
    // 5. Unconditional cleanup (a leaked orphan is collected by the bounded inactivity).
    try { await jsm.consumers.delete(stream, name); } catch { /* orphan collected by inactivity */ }
  }
}
