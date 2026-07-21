/**
 * The SEALED auth-ledger scanner: the LastPerSubject enumeration over the space's ONE auth KV
 * stream (`KV_cotal_auth_<space>`), and the ONLY place a `CONSUMER.CREATE` on that stream lives.
 *
 * WHY IT EXISTS (SPEC 13.9, the 46e778f + 4cf1e2f4 re-verify): a consumer-create request BODY is
 * NOT subject-ACL confinable — the extended `CONSUMER.CREATE.<stream>.<name>.<filter>` grant still
 * admits a `durable_name` + PUSH `deliver_subject` body (nats-server#8274), i.e. a durable exporter
 * of every current/future auth row that SURVIVES the holder's connection and JWT revoke. So NO
 * standing or runtime-reachable credential (the barrier, the admission mediator, the session path,
 * the piece-2 executor) may hold `CONSUMER.CREATE` on an authority stream. The dynamic-enumeration
 * CREATE lives ONLY here.
 *
 * THE SEAL (fact/security first-pass blockers, this round):
 *  - the composition OWNS ITS AUTHORITY: {@link openAuthLedgerScannerCandidate} opens a DEDICATED, minimal
 *    credential+connection ({@link authorityScannerGrants}: exactly the one literal consumer name's
 *    CREATE/INFO/NEXT/DELETE + the stream shape read, nothing else) and never exposes it. No caller
 *    receives the raw `NatsConnection`, the JWT/seed, the grant builder, or a raw-prefix scan — only
 *    the CLOSED, validated ops below, each of which forces its exact filter from a validated id.
 *    `close()` tears the owned client down.
 *  - Honest boundary (security's wording correction): the broker necessarily authenticates this
 *    connection, so "network-stealable" is the wrong frame. The property is that the JWT, the user
 *    seed, the authenticator, and the raw connection NEVER reach a caller/runtime surface, a child
 *    process, a log, or persistence. A process-memory compromise of the trusted auth service reaches
 *    this CREATE — the SAME residual class as the data-account signing seed the process already holds
 *    — not broker confinement and not a leaked credential.
 *
 * THE SCAN (why LastPerSubject, no fence): under the normative history=1 auth store a same-subject
 * `active→revoked` overwrite EVICTS the pre-scan revision, so a seq/INFO cutoff (the rejected
 * `next_by_subj@B` walk) would then DROP that subject and leave its holder un-revoked. A
 * LastPerSubject consumer carries NO upper fence: it delivers each subject's CURRENT last, so a
 * concurrent overwrite is SEEN, never dropped. Security's least-privilege + completeness pins:
 *  - ONE exact literal consumer name; every scan over this stream SERIALIZES on one critical
 *    section (fail-closed pre-clean → create → full bind-verify → drain to a re-proved zero →
 *    unconditional delete), so concurrent callers never share, steal, or delete each other's read.
 *  - the config is FORCED — pull (no `deliver_subject`), ephemeral (no `durable_name`),
 *    `AckPolicy.None`, `DeliverPolicy.LastPerSubject`, memory storage, bounded inactivity. The
 *    bind-verify re-reads the created consumer and refuses if ANY forced field drifted.
 *  - pre-clean is FAIL-CLOSED and PROVES absence: it proceeds only on a confirmed delete
 *    (`delete(...) === true`) or a structured ConsumerNotFound; a `false` return or any other error
 *    (timeout/permission/leader) fails the scan. Final cleanup is unconditional; a leaked orphan is
 *    collected by the bounded inactivity and pre-cleaned next run.
 *  - completeness is FAIL-CLOSED: the drain re-reads `num_pending` and stops only at a freshly
 *    observed zero (never a stale initial count), so a subject overwritten WHILE draining is fetched
 *    in a later round; last-write-wins by subject keeps the current row. A run that cannot reach the
 *    fresh zero (unbounded churn, a stuck delivery) fails closed rather than looping.
 *  - the injected scanner is BRANDED to its exact space ({@link assertScannerSpace}): the barrier
 *    registry rejects a hand-assembled or foreign-space scanner, so enumeration can never be
 *    silently empty/foreign and let a barrier advance over live descendants.
 *
 * CAPABILITY INTEGRITY + SERIALIZATION (panel HIGHs on the seal claim):
 *  - the returned handle is FROZEN: the brand proves construction identity, the freeze proves the
 *    reference's ops are still the module's (a post-brand `scanStageFamily = async () => []` swap
 *    throws instead of surviving the injection assert). The ops close over module-private state, so
 *    the frozen handle carries the registry's frozen-marker seal's integrity in one object. The
 *    swap vector was reachable only from inside the trusted process (the signing-seed residual
 *    class above), never externally; it is refused anyway because the invariant must be enforced,
 *    not asserted.
 *  - the serialization critical section lives at MODULE level, keyed by space, so a second branded
 *    same-space instance (however composed) shares the ONE chain and can never interleave
 *    pre-clean/create/fetch/delete on the literal name with a live scan (a per-instance lock cannot
 *    see a sibling instance). Cross-PROCESS duplication is the two-authority-planes split-brain
 *    class, excluded by the one-plane-per-space composition; a foreign re-resolution of the name is
 *    made loud by the per-message exact-prefix validation in the drain.
 */
import { AckPolicy, DeliverPolicy, JetStreamApiCodes, JetStreamApiError, jetstream, jetstreamManager, type JetStreamClient, type JetStreamManager } from "@nats-io/jetstream";
import type { NatsConnection } from "@nats-io/transport-node";
import { EpEnvelopeError, assertInboxConnId, assertLifecycleToken, epAuthBucket, type PlaneConnTuple } from "@cotal-ai/core";
import { openAuthorityClient, type AuthorityClient } from "./authority-client.js";
import type { ScanGuard } from "./plane-claim.js";

/** The ONE literal consumer name every scan over the auth stream reuses (the grant pins exactly
 *  this token). Scans over it serialize on the MODULE-LEVEL per-space chain below, never a
 *  per-instance lock, so a sibling instance can never delete a live read. */
const SCANNER_CONSUMER_NAME = "cotal-ledger-scan";

/** fact-5 ENFORCED (panel HIGH): the serialization critical section for a space's literal consumer
 *  name lives at MODULE level, keyed by space, shared by every instance for that space. */
const SPACE_SCAN_CHAINS = new Map<string, Promise<unknown>>();
const serializedForSpace = <T>(space: string, fn: () => Promise<T>): Promise<T> => {
  const tail = SPACE_SCAN_CHAINS.get(space) ?? Promise.resolve();
  const run = tail.then(fn, fn);
  SPACE_SCAN_CHAINS.set(space, run.then(() => undefined, () => undefined));
  return run;
};
/** Bounded inactivity (ns): a leaked orphan (a run that crashed before its unconditional delete)
 *  is broker-collected within this window, and the next run's pre-clean removes it by name. */
const INACTIVE_THRESHOLD_NS = 30_000_000_000;
/** Drain bounds (fail-closed, not spin). A LastPerSubject consumer over a quiescent family settles
 *  to zero pending in a handful of rounds; a concurrent same-subject overwrite (a mint that won its
 *  fence, or a crashing revoker) adds at most a bounded burst that the next round re-reads and
 *  drains. NOT "a frozen gate permits no new family writes" — the staged-mint/concurrent-revoke
 *  analysis disproves that; the completeness fence is the freshly-observed zero, and a run that
 *  cannot reach it (unbounded churn, a stuck delivery) fails closed rather than looping. */
const MAX_DRAIN_ROUNDS = 4096;
/** Consecutive rounds that observe pending > 0 yet deliver nothing before the scan fails closed —
 *  a consumer that claims pending but never delivers is a completeness hazard, not a slow one. */
const MAX_NO_PROGRESS_ROUNDS = 8;

/** One KV key segment (no dots — the separator — no wildcards): the closed ops validate every
 *  id token before it forms a filter, so a dot/wildcard can never widen the scan. */
const KEY_SEGMENT = /^[A-Za-z0-9_-]+$/;
function assertSegment(v: string, what: string): string {
  if (!KEY_SEGMENT.test(v))
    throw new EpEnvelopeError("failed-precondition", `the sealed scanner's ${what} ${JSON.stringify(v)} is not a KV-safe key segment (SPEC 13.9)`);
  return v;
}

/** One raw enumerated entry, WITH its KV operation so the DOMAIN parse layer's fail-loud contract
 *  can treat a DEL/PURGE marker as corruption (a bucket's own `keys()`/`watch()` would filter
 *  markers out). SEAM NOTE: consumed ONLY by the domain parse layer that owns this scanner
 *  (credential-ledger.ts), which turns each entry into a closed parsed row BEFORE anything leaves;
 *  it is never placed on a barrier/mediator/session dependency (those receive only parsed rows). */
export interface RawScanEntry {
  key: string;
  data: Uint8Array;
  seq: number;
  op: string | undefined;
}

/** The sealed auth-ledger scanner: CLOSED, validated ops only — no raw prefix, no NATS/JS handle,
 *  no credential. Each op forces its exact filter from a validated id. */
export interface AuthLedgerScanner {
  /** LastPerSubject over `cred.<lifecycleUid>.>` — the current last of every credential row in the
   *  agent family (markers included). */
  scanCredentialFamily(lifecycleUid: string): Promise<RawScanEntry[]>;
  /** LastPerSubject over `bysrc.<issuerKeyId>.<id>.>` — the current last of every lineage-index row
   *  under one handle. */
  scanBysrc(issuerKeyId: string, id: string): Promise<RawScanEntry[]>;
  /** LastPerSubject over `stage.>` — every durable operation intent and session release pin (the
   *  caller separates the single-segment operation intents from the multi-segment pins). */
  scanStageFamily(): Promise<RawScanEntry[]>;
  /** LastPerSubject over `session.>` — the current last of every session-ledger row (markers
   *  included, so the sweep sees a DEL/PURGE a bucket's own `keys()`/`watch()` would hide). Shares
   *  this instance's ONE literal consumer name + lock with the credential-ledger scans (fact-5:
   *  auth-ledger and session operations are one scanner over the one auth stream). */
  scanSessions(): Promise<RawScanEntry[]>;
  /** Tear down the owned credential+connection. */
  close(): Promise<void>;
}

/** STRUCTURAL not-found classification (not a message regex): @nats-io/jetstream@3.4.0 throws a
 *  ConsumerNotFoundError extends JetStreamApiError whose `.code` is the JS API err_code
 *  (`JetStreamApiCodes.ConsumerNotFound` = 10014); `.status` is the HTTP 404. The pre-clean proceeds
 *  ONLY on this exact structured shape — any other error fails the scan closed. */
const isConsumerNotFound = (e: unknown): boolean =>
  e instanceof JetStreamApiError && e.code === JetStreamApiCodes.ConsumerNotFound;

/** The production scanner's BRAND (HIGH: security/distsys, site-1 re-verify): the ONLY way to be an
 *  AuthLedgerScanner the barrier registry accepts is to be built by {@link buildScanner} in THIS
 *  module, which pins the scanner's exact space. A hand-assembled structural object (e.g. one whose
 *  ops return `[]`) or a real scanner for a DIFFERENT space is rejected by {@link assertScannerSpace},
 *  so a barrier can never enumerate an empty/foreign family and advance over live descendants. */
const SCANNER_BRAND = new WeakMap<AuthLedgerScanner, string>();

/** Assert `scanner` was built by this module for exactly `space` — the registry's space-bond and
 *  anti-hand-assembly discipline extended to the injected scanner (SPEC 13.12/13.9). */
export function assertScannerSpace(scanner: AuthLedgerScanner, space: string): void {
  const bonded = SCANNER_BRAND.get(scanner);
  if (bonded === undefined)
    throw new EpEnvelopeError("failed-precondition", "the injected auth-ledger scanner was not built by openAuthLedgerScannerCandidate/makeLedgerScannerOverConnection; a hand-assembled scanner never authorizes an enumeration (SPEC 13.12)");
  if (bonded !== space)
    throw new EpEnvelopeError("failed-precondition", `the injected auth-ledger scanner is bonded to space ${JSON.stringify(bonded)}, not ${JSON.stringify(space)}; a foreign-space scanner would enumerate the wrong (or an empty) family and let a barrier advance over live descendants (SPEC 13.1/13.12)`);
}

/** An INERT plane candidate (#29 HIGH 3, SPEC 13.13): the dedicated scanner connection is OPEN
 *  (non-reconnecting, identity captured for the plane claim row) but NO branded scan capability
 *  exists until the claim CAS wins and the composition calls {@link activate} — a losing opener
 *  closes the candidate having never been able to touch the literal consumer. */
export interface LedgerScannerCandidate {
  /** The connection's claim-pinnable broker identity. */
  tuple: PlaneConnTuple;
  /** Resolves when the non-reconnecting connection is permanently gone (the fencing signal). */
  gone: Promise<void>;
  /** WINNER-ONLY, once: build the branded sealed scanner, its every scan wrapped in the plane
   *  guard (claim re-validated before AND after, inside the serialized critical section). */
  activate(guard: ScanGuard): AuthLedgerScanner;
  close(): Promise<void>;
}

/**
 * Open the sealed auth-ledger scanner CANDIDATE over the space's auth stream: a DEDICATED
 * self-minted plane-owned connection carrying ONLY {@link authorityScannerGrants}. The connection,
 * credential, and raw scan are never handed out; the scan capability itself does not exist until
 * the plane claim is won ({@link LedgerScannerCandidate.activate}).
 */
export async function openAuthLedgerScannerCandidate(opts: {
  server: string;
  space: string;
  dataAccount: { pub: string; signingSeed: string };
  log: (line: string) => void;
}): Promise<LedgerScannerCandidate> {
  const client: AuthorityClient = await openAuthorityClient({
    server: opts.server, space: opts.space, dataAccount: opts.dataAccount, label: `cotal:auth-scan:${opts.space}`,
    grants: (id) => authorityScannerGrants(opts.space, id), log: opts.log, planeCandidate: true,
  });
  // planeCandidate guarantees both (openAuthorityClient throws otherwise); the assert keeps the
  // contract loud if that shape ever drifts.
  if (client.tuple === undefined || client.gone === undefined)
    throw new EpEnvelopeError("internal", "a plane-candidate authority client carries a tuple and a gone signal by contract (SPEC 13.13)");
  let activated = false;
  let closed = false;
  return {
    tuple: client.tuple,
    gone: client.gone,
    activate: (guard: ScanGuard): AuthLedgerScanner => {
      if (closed) throw new EpEnvelopeError("failed-precondition", "this auth-ledger scanner candidate is closed (a losing plane open never activates)");
      if (activated) throw new EpEnvelopeError("failed-precondition", "this auth-ledger scanner candidate is already activated (one branded scanner per candidate)");
      activated = true;
      return buildScanner(client.nc, opts.space, () => client.close(), undefined, guard);
    },
    close: async () => {
      closed = true;
      await client.close();
    },
  };
}

/**
 * TEST/SMOKE-ONLY: build the sealed scanner over an EXISTING connection. A plain-auth test broker
 * has no data-account signing seed to self-mint a JWT, so the JWT-owning {@link openAuthLedgerScannerCandidate}
 * (the PRODUCTION seam, which owns a dedicated credential+connection) does not apply. This factory's
 * `close()` does NOT close the caller's connection (the harness owns it); it is never a production
 * composition path and is never registered as a mintable profile.
 */
export function makeLedgerScannerOverConnection(nc: NatsConnection, space: string, probe?: ScannerProbe, guard?: ScanGuard): AuthLedgerScanner {
  return buildScanner(nc, space, async () => { /* the harness owns nc */ }, probe, guard);
}

/** SMOKE-ONLY probes (precedent: AuthorityClient.probeRenewal). Never set in production.
 *  - `afterCreate` fires ONCE after the consumer is created + bind-verified but BEFORE the drain,
 *    forcing the create→drain race: a subject overwritten `active→revoked` (evicting the pre-scan
 *    revision) is still returned at its CURRENT last.
 *  - `afterFirstFetch` fires ONCE after the FIRST drain fetch completes, forcing the mid-drain race:
 *    a subject delivered old in round 1 then overwritten re-appears as pending and is fetched in a
 *    later round (proving the drain re-reads `num_pending` to a fresh zero, not a stale local count). */
export interface ScannerProbe {
  afterCreate?: () => Promise<void>;
  afterFirstFetch?: () => Promise<void>;
}

function buildScanner(nc: NatsConnection, space: string, onClose: () => Promise<void>, probe?: ScannerProbe, guard?: ScanGuard): AuthLedgerScanner {
  const bucket = epAuthBucket(space);
  const stream = `KV_${bucket}`;
  const keyPrefixLen = `$KV.${bucket}.`.length;
  let jsmP: Promise<JetStreamManager> | undefined;
  let jsRef: JetStreamClient | undefined;
  const jsmOf = (): Promise<JetStreamManager> => (jsmP ??= jetstreamManager(nc));
  const jsOf = (): JetStreamClient => (jsRef ??= jetstream(nc));

  // Serialize every scan over the shared literal consumer name on the MODULE-LEVEL per-space
  // chain: a second caller (or a sibling instance) waits rather than colliding on
  // pre-clean/create/fetch/delete.
  const serialized = <T>(fn: () => Promise<T>): Promise<T> => serializedForSpace(space, fn);
  // The PLANE guard (#29 HIGH 3, SPEC 13.13), inside the serialized critical section: the claim
  // is re-validated BEFORE the scan (refuse to enumerate under a lost claim) and AFTER it (a
  // claim lost DURING the scan discards the result — a successor may already own the literal
  // name). Intra-process serialization stays the module chain above; the guard is the
  // CROSS-process authority.
  const guarded = async <T>(fn: () => Promise<T>): Promise<T> => {
    if (guard === undefined) return fn();
    await guard.assertHeld("before");
    const out = await fn();
    await guard.assertHeld("after");
    return out;
  };

  // The RAW scan — MODULE-PRIVATE (a closure over the owned connection): no caller ever supplies
  // `prefix`; the closed ops below force it from a validated id.
  const scanOnce = async (prefix: string): Promise<RawScanEntry[]> => {
    const jsm = await jsmOf();
    const js = jsOf();
    const filterBase = `$KV.${bucket}.${prefix}`; // every returned subject MUST start with this
    const filter = `${filterBase}>`;

    // 1. FAIL-CLOSED pre-clean: PROVE the literal name absent before create (a leftover from a run
    // that crashed before its unconditional delete). Absence is proved ONLY by a confirmed delete
    // (`delete(...) === true`) or a structured ConsumerNotFound; a `false` return, a timeout, a
    // permission/leader error, or any other shape fails the scan (a surviving stale AckNone consumer
    // with an outstanding pull could otherwise advance deliveries and make this run silently omit
    // rows).
    let provedAbsent = false;
    try {
      provedAbsent = (await jsm.consumers.delete(stream, SCANNER_CONSUMER_NAME)) === true;
    } catch (e) {
      if (isConsumerNotFound(e)) provedAbsent = true;
      else throw new EpEnvelopeError("unavailable", `the sealed scanner could not prove its literal consumer absent on ${stream} before create (pre-clean fails closed, SPEC 13.9): ${(e as Error)?.message ?? String(e)}`);
    }
    if (!provedAbsent)
      throw new EpEnvelopeError("unavailable", `the sealed scanner's pre-clean did not confirm the literal consumer deleted or absent on ${stream}; refusing to create over an unproven consumer (fail-closed, SPEC 13.9)`);

    // 2. Create with the FORCED config ONLY (the seam derives every field; no caller config).
    try {
      await jsm.consumers.add(stream, {
        name: SCANNER_CONSUMER_NAME,
        filter_subject: filter,
        ack_policy: AckPolicy.None,
        deliver_policy: DeliverPolicy.LastPerSubject,
        mem_storage: true,
        inactive_threshold: INACTIVE_THRESHOLD_NS,
      });
    } catch (e) {
      throw new EpEnvelopeError("unavailable", `the sealed scanner could not create its consumer on ${stream} (${prefix}); the scan fails closed (SPEC 13.9): ${(e as Error)?.message ?? String(e)}`);
    }

    try {
      // 3. FULL bind-verify: the created consumer must carry EXACTLY the forced shape — the exact
      // name and single filter (no `filter_subjects` multi-filter), pull (no `deliver_subject`),
      // ephemeral (no `durable_name`), AckNone/LastPerSubject, memory storage, the bounded exact
      // inactivity. A drifted or foreign consumer of this name never feeds a scan.
      const info = await jsm.consumers.info(stream, SCANNER_CONSUMER_NAME);
      const cfg = info.config as {
        name?: string; filter_subject?: string; filter_subjects?: string[];
        deliver_subject?: string; durable_name?: string; ack_policy?: string; deliver_policy?: string;
        mem_storage?: boolean; inactive_threshold?: number;
      };
      const drift =
        cfg.name !== SCANNER_CONSUMER_NAME ? `name=${cfg.name}` :
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
        throw new EpEnvelopeError("failed-precondition", `the sealed scanner's consumer on ${stream} does not carry the forced pull/LastPerSubject shape (${drift}); refusing the scan (SPEC 13.9)`);

      // SMOKE-ONLY race window: force a concurrent `active→revoked` overwrite between create and
      // drain, so the history=1 proof runs against the real broker. Never set in production.
      if (probe?.afterCreate) await probe.afterCreate();

      // 4. Drain to a FRESHLY-OBSERVED zero. `num_pending` is re-read each round (never a stale
      // initial count): a subject delivered old (a@1) and then overwritten while draining (a@4)
      // re-appears as pending and is fetched in a later round, so the result is one CURRENT row per
      // subject. The completeness fence is num_pending===0 — NOT a per-fetch `got===want` assertion,
      // which a concurrent eviction (a@1 replaced by a@4 between the info read and the fetch) would
      // trip falsely. Last-write-wins by concrete subject, keeping the HIGHEST safe sequence.
      const latest = new Map<string, { data: Uint8Array; seq: number; op: string | undefined }>();
      const consumer = await js.consumers.get(stream, SCANNER_CONSUMER_NAME);
      let noProgress = 0;
      for (let round = 0; ; round++) {
        const pending = (await consumer.info()).num_pending;
        if (pending === 0) break;
        if (round >= MAX_DRAIN_ROUNDS)
          throw new EpEnvelopeError("unavailable", `the sealed scanner under ${prefix} never settled to zero pending after ${round} rounds; the scan fails closed (SPEC 13.9)`);
        const want = Math.min(pending, 256);
        const iter = await consumer.fetch({ max_messages: want, expires: 5_000 });
        let got = 0;
        for await (const m of iter) {
          got++;
          // CLOSED subject validation: a delivered subject MUST start with the exact computed
          // prefix before we slice its key (a foreign subject never enters the result).
          if (!m.subject.startsWith(filterBase))
            throw new EpEnvelopeError("internal", `the sealed scanner received subject ${m.subject} outside the forced prefix ${filterBase}; refusing (SPEC 13.9)`);
          // Safe positive stream sequence before any ordering decision (a garbled/zero seq never
          // wins a last-write-wins comparison).
          if (!Number.isSafeInteger(m.seq) || m.seq <= 0)
            throw new EpEnvelopeError("internal", `the sealed scanner received a non-positive/unsafe sequence ${m.seq} for ${m.subject}; refusing (SPEC 13.9)`);
          const prev = latest.get(m.subject);
          if (prev === undefined || m.seq > prev.seq)
            latest.set(m.subject, { data: m.data, seq: m.seq, op: m.headers?.get("KV-Operation") || undefined });
        }
        // SMOKE-ONLY mid-drain race window: fire once after the FIRST fetch so a test can overwrite
        // an already-delivered subject and prove the fresh-zero re-read (not a stale local count)
        // picks up the new revision in a later round. Never set in production.
        if (round === 0 && probe?.afterFirstFetch) await probe.afterFirstFetch();
        // A round that observed pending > 0 yet delivered nothing makes no progress toward the
        // fresh zero; a bounded run of those fails closed rather than looping to the round cap.
        if (got === 0) {
          if (++noProgress >= MAX_NO_PROGRESS_ROUNDS)
            throw new EpEnvelopeError("unavailable", `the sealed scanner under ${prefix} reported pending but delivered nothing for ${noProgress} rounds; the scan fails closed (SPEC 13.9)`);
        } else {
          noProgress = 0;
        }
      }
      const out: RawScanEntry[] = [];
      for (const [subject, v] of latest) out.push({ key: subject.slice(keyPrefixLen), data: v.data, seq: v.seq, op: v.op });
      return out;
    } finally {
      // 5. Unconditional cleanup (a leaked orphan is collected by the bounded inactivity).
      try { await jsm.consumers.delete(stream, SCANNER_CONSUMER_NAME); } catch { /* orphan collected by inactivity */ }
    }
  };

  // FROZEN before branding (capability integrity): the brand keys this exact reference, and the
  // freeze guarantees its ops are still the module's when an install seam asserts the brand — a
  // post-brand method swap throws (strict mode) instead of surviving as a silent-empty scanner.
  const scanner: AuthLedgerScanner = Object.freeze({
    scanCredentialFamily: (lifecycleUid: string) =>
      serialized(() => guarded(() => scanOnce(`cred.${assertLifecycleToken(lifecycleUid)}.`))),
    scanBysrc: (issuerKeyId: string, id: string) =>
      serialized(() => guarded(() => scanOnce(`bysrc.${assertSegment(issuerKeyId, "issuerKeyId")}.${assertSegment(id, "handle id")}.`))),
    scanStageFamily: () => serialized(() => guarded(() => scanOnce("stage."))),
    scanSessions: () => serialized(() => guarded(() => scanOnce("session."))),
    close: onClose,
  });
  // BRAND the scanner with its exact space so the barrier registry's assertScannerSpace can reject a
  // hand-assembled or foreign-space scanner (a structural object can never enter the WeakMap).
  SCANNER_BRAND.set(scanner, space);
  return scanner;
}

/**
 * The SEALED SCANNER's credential grant on the AUTH stream (SPEC 13.9): exactly the ONE literal
 * enumeration consumer's lifecycle (CREATE/INFO/NEXT/DELETE pinned to {@link SCANNER_CONSUMER_NAME})
 * + the stream shape read + the scoped inbox. This is the ONLY profile that holds `CONSUMER.CREATE`
 * on `KV_cotal_auth_<space>`; {@link openAuthLedgerScannerCandidate} opens it for the trusted process and it
 * is NEVER registered as an external/mintable profile. The bucket is DERIVED from the validated
 * space and the name is the module constant, so no caller-supplied token forms a privileged subject.
 */
export function authorityScannerGrants(space: string, connId: string): { publish: string[]; subscribe: string[] } {
  const bucket = epAuthBucket(space);
  const stream = `KV_${bucket}`;
  const inbox = assertInboxConnId(connId);
  return {
    publish: [
      "$JS.API.INFO",
      `$JS.API.STREAM.INFO.${stream}`,
      `$JS.API.CONSUMER.CREATE.${stream}.${SCANNER_CONSUMER_NAME}.$KV.${bucket}.>`,
      `$JS.API.CONSUMER.INFO.${stream}.${SCANNER_CONSUMER_NAME}`,
      `$JS.API.CONSUMER.MSG.NEXT.${stream}.${SCANNER_CONSUMER_NAME}`,
      `$JS.API.CONSUMER.DELETE.${stream}.${SCANNER_CONSUMER_NAME}`,
    ],
    subscribe: [`_INBOX_${inbox}.>`],
  };
}
