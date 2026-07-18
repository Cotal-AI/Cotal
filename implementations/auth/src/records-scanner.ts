/**
 * The SEALED records-obligation scanner: the LastPerSubject enumeration over the space's ONE
 * records KV stream (`KV_cotal_records_<space>`), confined to the `oblig.` subtree, and the ONLY
 * place a `CONSUMER.CREATE` on that stream lives for obligation enumeration.
 *
 * WHY IT EXISTS (SPEC 13.9, site 3 — the records-stream analogue of {@link ./ledger-scanner.ts}):
 * a consumer-create request BODY is NOT subject-ACL confinable — the extended
 * `CONSUMER.CREATE.<stream>.<name>.<filter>` grant the admission mediator used to hold still
 * admits a `durable_name` + PUSH `deliver_subject` body (nats-server#8274), i.e. a durable exporter
 * of every current/future obligation row that SURVIVES the holder's connection and JWT revoke.
 * Reproduced live against the prior grant: a mediator-scoped credential created a PUSH exporter of
 * its endpoint's whole `oblig.` subtree. So NO standing or runtime-reachable credential (the
 * admission mediator, the retirement barrier's obligation drain) may hold `CONSUMER.CREATE` on the
 * records stream. The dynamic obligation-enumeration CREATE lives ONLY here.
 *
 * THE SEAL is the auth scanner's, verbatim: {@link openRecordsScanner} opens a DEDICATED, minimal
 * credential+connection ({@link recordsScannerGrants}: exactly the one literal consumer name's
 * CREATE/INFO/NEXT/DELETE pinned to the `oblig.` subtree + the stream shape read, nothing else) and
 * never exposes it. Callers receive only the CLOSED, validated {@link RecordsScanner.scanObligations}
 * op, which confines every filter to `oblig.<...>.>`. `close()` tears the owned client down.
 * A process-memory compromise of the trusted process reaches this CREATE — the SAME residual class
 * as the data-account signing seed the process already holds — not broker confinement.
 *
 * THE SCAN (why LastPerSubject, no fence): under the normative records store an obligation row's
 * `provisional→accepted/rejected` settle is a same-subject overwrite (history=1). A seq/INFO cutoff
 * would drop a subject overwritten during the scan; a LastPerSubject consumer carries NO upper
 * fence, so it delivers each subject's CURRENT last and a concurrent settle is SEEN, never dropped —
 * the completeness the retirement barrier's drain-to-quiescence requires. The pre-clean, forced
 * pull/LastPerSubject shape, full bind-verify, and fresh-zero drain are the auth scanner's, and the
 * injected scanner is BRANDED to its exact space ({@link assertRecordsScannerSpace}) so a
 * hand-assembled or foreign-space scanner can never silently empty a drain.
 *
 * CAPABILITY INTEGRITY + SERIALIZATION (panel HIGHs on the seal claim):
 * - The returned handle is FROZEN: the brand proves construction identity, the freeze proves the
 *   reference's ops are still the module's (a post-brand `scanObligations = async () => []` swap
 *   throws instead of surviving the injection assert). The ops close over module-private state, so
 *   the frozen handle carries the registry/mediator seal's integrity in one object. The swap vector
 *   was reachable only from inside the trusted process (the signing-seed residual class), never
 *   externally; it is refused anyway because the invariant must be enforced, not asserted.
 * - fact-5 is ENFORCED, not asserted: every scan over a space's ONE literal consumer name
 *   serializes on a MODULE-LEVEL per-space chain, so a second branded instance (however composed)
 *   can never interleave pre-clean/create/fetch/delete with a live scan and hand back a partial
 *   map. ONE shared instance per space stays the composition rule (#29 injects one), but safety no
 *   longer depends on it. Cross-PROCESS duplication is the two-authority-planes split-brain class
 *   (excluded by the one-plane-per-space composition); the per-message filter revalidation in the
 *   drain makes an OUT-OF-FILTER delivery from a foreign re-resolution loud, while a foreign
 *   same-or-narrower filter stays covered by that composition assumption, not by the check.
 */
import { AckPolicy, DeliverPolicy, JetStreamApiCodes, JetStreamApiError, jetstream, jetstreamManager, type JetStreamClient, type JetStreamManager } from "@nats-io/jetstream";
import type { NatsConnection } from "@nats-io/transport-node";
import { EpEnvelopeError, assertInboxConnId, recordsBucket, recordsKvStreamName } from "@cotal-ai/core";
import { openAuthorityClient, type AuthorityClient } from "./authority-client.js";

/** The ONE literal consumer name every obligation scan over the records stream reuses (the grant
 *  pins exactly this token; separate from the auth-ledger scanner's — fact-5, one name per stream).
 *  Scans over it serialize on the MODULE-LEVEL per-space chain below, never a per-instance lock. */
const RECORDS_SCANNER_CONSUMER_NAME = "cotal-records-scan";

/** fact-5 ENFORCED (panel HIGH): the serialization critical section for a space's literal consumer
 *  name lives at MODULE level, keyed by space, so two branded same-space instances share one chain
 *  and can never interleave pre-clean/create/fetch/delete on that name (a per-instance lock cannot
 *  see a sibling instance). */
const SPACE_SCAN_CHAINS = new Map<string, Promise<unknown>>();
const serializedForSpace = <T>(space: string, fn: () => Promise<T>): Promise<T> => {
  const tail = SPACE_SCAN_CHAINS.get(space) ?? Promise.resolve();
  const run = tail.then(fn, fn);
  SPACE_SCAN_CHAINS.set(space, run.then(() => undefined, () => undefined));
  return run;
};

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
/** Bounded inactivity (ns): a leaked orphan (a run that crashed before its unconditional delete) is
 *  broker-collected within this window, and the next run's pre-clean removes it by name. */
const INACTIVE_THRESHOLD_NS = 30_000_000_000;
/** Drain bounds (fail-closed, not spin) — the auth scanner's rationale (a quiescent subtree settles
 *  in a handful of rounds; a concurrent settle adds a bounded burst the next round re-reads). */
const MAX_DRAIN_ROUNDS = 4096;
/** Consecutive rounds that observe pending > 0 yet deliver nothing before the scan fails closed. */
const MAX_NO_PROGRESS_ROUNDS = 8;

/** One KV key segment (no dots — the separator — no wildcards). */
const KEY_SEGMENT = /^[A-Za-z0-9_-]+$/;

/** Confine a caller's obligation filter to the `oblig.` subtree: it must be `oblig.<...>.>` where
 *  each middle segment is a KV-safe token or the `*` position wildcard (the mediator's target
 *  wildcard `oblig.*.<ep>.>`, the barrier's target pin `oblig.<uid>.>`). Anything else — a widen to
 *  the records root, a head/govern/lease subtree, a dotted injection — is refused, so the closed op
 *  can never enumerate outside `oblig.`. */
function assertObligFilter(filter: string): string {
  const parts = filter.split(".");
  if (parts.length < 2 || parts[0] !== "oblig" || parts[parts.length - 1] !== ">")
    throw new EpEnvelopeError("failed-precondition", `the records scanner filter ${JSON.stringify(filter)} is not an oblig subtree filter (must be oblig.<...>.>) (SPEC 13.9)`);
  for (const seg of parts.slice(1, -1))
    if (seg !== "*" && !KEY_SEGMENT.test(seg))
      throw new EpEnvelopeError("failed-precondition", `the records scanner filter segment ${JSON.stringify(seg)} is neither a KV-safe token nor the * wildcard (SPEC 13.9)`);
  return filter;
}

/** One raw enumerated entry, WITH its KV operation so the domain parse layer (admission-mediator's
 *  {@link enumerateObligationRows}) can treat a DEL/PURGE marker as corruption. SEAM NOTE: consumed
 *  ONLY by that parse layer, which turns each entry into a closed parsed obligation row BEFORE
 *  anything leaves; it is never placed on a barrier/mediator dependency (those receive parsed rows). */
export interface RawRecordsEntry {
  key: string;
  data: Uint8Array;
  seq: number;
  op: string | undefined;
}

/** The sealed records-obligation scanner: the CLOSED, validated op only — no raw prefix, no
 *  NATS/JS handle, no credential. The filter is confined to `oblig.<...>.>`. */
export interface RecordsScanner {
  /** LastPerSubject over `$KV.<records>.<filter>` (filter confined to `oblig.<...>.>`) — the current
   *  last of every obligation row under the filter (markers included, so the caller sees a DEL/PURGE
   *  a bucket's own `keys()`/`watch()` would hide). */
  scanObligations(filter: string): Promise<RawRecordsEntry[]>;
  /** Tear down the owned credential+connection. */
  close(): Promise<void>;
}

/** STRUCTURAL not-found classification (not a message regex): @nats-io/jetstream throws a
 *  JetStreamApiError whose `.code` is the JS API err_code (`JetStreamApiCodes.ConsumerNotFound` =
 *  10014); `.status` is the HTTP 404. The pre-clean proceeds ONLY on this exact structured shape. */
const isConsumerNotFound = (e: unknown): boolean =>
  e instanceof JetStreamApiError && e.code === JetStreamApiCodes.ConsumerNotFound;

/** The records scanner's BRAND (site-3, mirroring the auth scanner): the ONLY way to be a
 *  RecordsScanner a registry/mediator accepts is to be built by {@link buildScanner} in THIS module,
 *  which pins the scanner's exact space. A hand-assembled structural object (e.g. one whose op
 *  returns `[]`) or a real scanner for a DIFFERENT space is rejected by
 *  {@link assertRecordsScannerSpace}, so a drain can never enumerate an empty/foreign subtree and
 *  declare quiescence over live obligations. */
const RECORDS_SCANNER_BRAND = new WeakMap<RecordsScanner, string>();

/** Assert `scanner` was built by this module for exactly `space`. */
export function assertRecordsScannerSpace(scanner: RecordsScanner, space: string): void {
  const bonded = RECORDS_SCANNER_BRAND.get(scanner);
  if (bonded === undefined)
    throw new EpEnvelopeError("failed-precondition", "the injected records scanner was not built by openRecordsScanner/makeRecordsScannerOverConnection; a hand-assembled scanner never authorizes an enumeration (SPEC 13.12)");
  if (bonded !== space)
    throw new EpEnvelopeError("failed-precondition", `the injected records scanner is bonded to space ${JSON.stringify(bonded)}, not ${JSON.stringify(space)}; a foreign-space scanner would enumerate the wrong (or an empty) subtree and let a drain declare quiescence over live obligations (SPEC 13.1/13.12)`);
}

/**
 * Open the sealed records-obligation scanner over the space's records stream: a DEDICATED
 * self-minted connection carrying ONLY {@link recordsScannerGrants}. The returned object exposes
 * only the closed op; the connection, credential, and raw scan are never handed out.
 */
export async function openRecordsScanner(opts: {
  server: string;
  space: string;
  dataAccount: { pub: string; signingSeed: string };
  log: (line: string) => void;
}): Promise<RecordsScanner> {
  const client: AuthorityClient = await openAuthorityClient({
    server: opts.server, space: opts.space, dataAccount: opts.dataAccount, label: `cotal:records-scan:${opts.space}`,
    grants: (id) => recordsScannerGrants(opts.space, id), log: opts.log,
  });
  return buildScanner(client.nc, opts.space, () => client.close());
}

/**
 * TEST/SMOKE-ONLY: build the sealed records scanner over an EXISTING connection. A plain-auth test
 * broker has no data-account signing seed to self-mint a JWT, so the JWT-owning
 * {@link openRecordsScanner} (the PRODUCTION seam) does not apply. This factory's `close()` does
 * NOT close the caller's connection (the harness owns it); it is never a production composition path
 * and is never registered as a mintable profile.
 */
export function makeRecordsScannerOverConnection(nc: NatsConnection, space: string, probe?: RecordsScannerProbe): RecordsScanner {
  return buildScanner(nc, space, async () => { /* the harness owns nc */ }, probe);
}

/** SMOKE-ONLY probes (mirroring the auth scanner). Never set in production.
 *  - `afterCreate` fires ONCE after create + bind-verify but BEFORE the drain (the create→drain race).
 *  - `afterFirstFetch` fires ONCE after the FIRST drain fetch (the mid-drain settle race). */
export interface RecordsScannerProbe {
  afterCreate?: () => Promise<void>;
  afterFirstFetch?: () => Promise<void>;
}

function buildScanner(nc: NatsConnection, space: string, onClose: () => Promise<void>, probe?: RecordsScannerProbe): RecordsScanner {
  const bucket = recordsBucket(space);
  const stream = recordsKvStreamName(space);
  const keyPrefixLen = `$KV.${bucket}.`.length;
  let jsmP: Promise<JetStreamManager> | undefined;
  let jsRef: JetStreamClient | undefined;
  const jsmOf = (): Promise<JetStreamManager> => (jsmP ??= jetstreamManager(nc));
  const jsOf = (): JetStreamClient => (jsRef ??= jetstream(nc));

  const scanOnce = async (rawFilter: string): Promise<RawRecordsEntry[]> => {
    const jsm = await jsmOf();
    const js = jsOf();
    const filter = `$KV.${bucket}.${assertObligFilter(rawFilter)}`;

    // 1. FAIL-CLOSED pre-clean: PROVE the literal name absent before create. Absence is proved ONLY
    // by a confirmed delete (`delete(...) === true`) or a structured ConsumerNotFound; a `false`
    // return or any other error fails the scan (a surviving stale AckNone consumer could otherwise
    // advance deliveries and make this run silently omit rows).
    let provedAbsent = false;
    try {
      provedAbsent = (await jsm.consumers.delete(stream, RECORDS_SCANNER_CONSUMER_NAME)) === true;
    } catch (e) {
      if (isConsumerNotFound(e)) provedAbsent = true;
      else throw new EpEnvelopeError("unavailable", `the records scanner could not prove its literal consumer absent on ${stream} before create (pre-clean fails closed, SPEC 13.9): ${(e as Error)?.message ?? String(e)}`);
    }
    if (!provedAbsent)
      throw new EpEnvelopeError("unavailable", `the records scanner's pre-clean did not confirm the literal consumer deleted or absent on ${stream}; refusing to create over an unproven consumer (fail-closed, SPEC 13.9)`);

    // 2. Create with the FORCED config ONLY (the seam derives every field; no caller config).
    try {
      await jsm.consumers.add(stream, {
        name: RECORDS_SCANNER_CONSUMER_NAME,
        filter_subject: filter,
        ack_policy: AckPolicy.None,
        deliver_policy: DeliverPolicy.LastPerSubject,
        mem_storage: true,
        inactive_threshold: INACTIVE_THRESHOLD_NS,
      });
    } catch (e) {
      throw new EpEnvelopeError("unavailable", `the records scanner could not create its consumer on ${stream} (${rawFilter}); the scan fails closed (SPEC 13.9): ${(e as Error)?.message ?? String(e)}`);
    }

    try {
      // 3. FULL bind-verify: the created consumer must carry EXACTLY the forced shape — the exact
      // name and single filter (no multi-filter), pull (no `deliver_subject`), ephemeral (no
      // `durable_name`), AckNone/LastPerSubject, memory storage, the bounded exact inactivity.
      const info = await jsm.consumers.info(stream, RECORDS_SCANNER_CONSUMER_NAME);
      const cfg = info.config as {
        name?: string; filter_subject?: string; filter_subjects?: string[];
        deliver_subject?: string; durable_name?: string; ack_policy?: string; deliver_policy?: string;
        mem_storage?: boolean; inactive_threshold?: number;
      };
      const drift =
        cfg.name !== RECORDS_SCANNER_CONSUMER_NAME ? `name=${cfg.name}` :
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
        throw new EpEnvelopeError("failed-precondition", `the records scanner's consumer on ${stream} does not carry the forced pull/LastPerSubject shape (${drift}); refusing the scan (SPEC 13.9)`);

      // SMOKE-ONLY race window: force a concurrent settle between create and drain.
      if (probe?.afterCreate) await probe.afterCreate();

      // 4. Drain to a FRESHLY-OBSERVED zero. `num_pending` is re-read each round (never a stale
      // initial count): a subject settled while draining re-appears as pending and is fetched in a
      // later round, so the result is one CURRENT row per subject. The fence is num_pending===0 —
      // NOT a per-fetch got===want assertion, which a concurrent settle would trip falsely.
      const latest = new Map<string, { data: Uint8Array; seq: number; op: string | undefined }>();
      const consumer = await js.consumers.get(stream, RECORDS_SCANNER_CONSUMER_NAME);
      let noProgress = 0;
      for (let round = 0; ; round++) {
        const pending = (await consumer.info()).num_pending;
        if (pending === 0) break;
        if (round >= MAX_DRAIN_ROUNDS)
          throw new EpEnvelopeError("unavailable", `the records scanner under ${rawFilter} never settled to zero pending after ${round} rounds; the scan fails closed (SPEC 13.9)`);
        const want = Math.min(pending, 256);
        const iter = await consumer.fetch({ max_messages: want, expires: 5_000 });
        let got = 0;
        for await (const m of iter) {
          got++;
          // CLOSED subject validation, PER MESSAGE against THIS scan's exact filter (not just the
          // oblig root): a foreign subject never enters the result, and a literal-name consumer
          // swapped to a different config under the scan is refused loud instead of contaminating.
          if (!matchesFilter(m.subject, filter))
            throw new EpEnvelopeError("internal", `the records scanner received subject ${m.subject} outside its requested filter ${filter}; refusing (a foreign re-resolution of the literal consumer name never feeds a scan, SPEC 13.9)`);
          if (!Number.isSafeInteger(m.seq) || m.seq <= 0)
            throw new EpEnvelopeError("internal", `the records scanner received a non-positive/unsafe sequence ${m.seq} for ${m.subject}; refusing (SPEC 13.9)`);
          const prev = latest.get(m.subject);
          if (prev === undefined || m.seq > prev.seq)
            latest.set(m.subject, { data: m.data, seq: m.seq, op: m.headers?.get("KV-Operation") || undefined });
        }
        if (round === 0 && probe?.afterFirstFetch) await probe.afterFirstFetch();
        if (got === 0) {
          if (++noProgress >= MAX_NO_PROGRESS_ROUNDS)
            throw new EpEnvelopeError("unavailable", `the records scanner under ${rawFilter} reported pending but delivered nothing for ${noProgress} rounds; the scan fails closed (SPEC 13.9)`);
        } else {
          noProgress = 0;
        }
      }
      const out: RawRecordsEntry[] = [];
      for (const [subject, v] of latest) out.push({ key: subject.slice(keyPrefixLen), data: v.data, seq: v.seq, op: v.op });
      return out;
    } finally {
      // 5. Unconditional cleanup (a leaked orphan is collected by the bounded inactivity).
      try { await jsm.consumers.delete(stream, RECORDS_SCANNER_CONSUMER_NAME); } catch { /* orphan collected by inactivity */ }
    }
  };

  // FROZEN before branding (capability integrity): the brand keys this exact reference, and the
  // freeze guarantees its ops are still the module's when an install seam asserts the brand — a
  // post-brand method swap throws (strict mode) instead of surviving as a silent-empty scanner.
  const scanner: RecordsScanner = Object.freeze({
    scanObligations: (filter: string) => serializedForSpace(space, () => scanOnce(filter)),
    close: onClose,
  });
  RECORDS_SCANNER_BRAND.set(scanner, space);
  return scanner;
}

/**
 * The SEALED records scanner's credential grant on the RECORDS stream (SPEC 13.9): exactly the ONE
 * literal enumeration consumer's lifecycle (CREATE/INFO/NEXT/DELETE pinned to
 * {@link RECORDS_SCANNER_CONSUMER_NAME}, the CREATE filter confined to the `oblig.` subtree) + the
 * stream shape read + the scoped inbox. This is the ONLY profile that holds `CONSUMER.CREATE` on
 * `KV_cotal_records_<space>` for obligation enumeration; {@link openRecordsScanner} opens it for the
 * trusted process and it is NEVER registered as an external/mintable profile. The bucket is DERIVED
 * from the validated space and the name is the module constant, so no caller-supplied token forms a
 * privileged subject.
 */
export function recordsScannerGrants(space: string, connId: string): { publish: string[]; subscribe: string[] } {
  const bucket = recordsBucket(space);
  const stream = recordsKvStreamName(space);
  const inbox = assertInboxConnId(connId);
  return {
    publish: [
      "$JS.API.INFO",
      `$JS.API.STREAM.INFO.${stream}`,
      `$JS.API.CONSUMER.CREATE.${stream}.${RECORDS_SCANNER_CONSUMER_NAME}.$KV.${bucket}.oblig.>`,
      `$JS.API.CONSUMER.INFO.${stream}.${RECORDS_SCANNER_CONSUMER_NAME}`,
      `$JS.API.CONSUMER.MSG.NEXT.${stream}.${RECORDS_SCANNER_CONSUMER_NAME}`,
      `$JS.API.CONSUMER.DELETE.${stream}.${RECORDS_SCANNER_CONSUMER_NAME}`,
    ],
    subscribe: [`_INBOX_${inbox}.>`],
  };
}
