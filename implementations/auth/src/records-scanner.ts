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
 * THE SEAL is the auth scanner's, verbatim: {@link openRecordsScannerCandidate} opens a DEDICATED, minimal
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
 * pull/LastPerSubject shape, full bind-verify, and fresh-zero drain are the auth scanner's (one
 * {@link drainLiteralConsumer} for both scanners), and the injected scanner is BRANDED to its exact
 * space ({@link assertRecordsScannerSpace}) so a hand-assembled or foreign-space scanner can never
 * silently empty a drain.
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
import { jetstream, jetstreamManager, type JetStreamClient, type JetStreamManager } from "@nats-io/jetstream";
import type { NatsConnection } from "@nats-io/transport-node";
import { EpEnvelopeError, RECORD_KINDS, assertInboxConnId, assertPrincipalOwnerToken, parseGoalIndexEntry, parseRecordKey, recordsBucket, recordsKvStreamName, type GoalIndexEntry, type PlaneConnTuple } from "@cotal-ai/core";
import { openAuthorityClient, type AuthorityClient } from "./authority-client.js";
import { drainLiteralConsumer, type LiteralConsumerProbe } from "./literal-consumer.js";
import { guardedScan, type ScanGuard } from "./plane-claim.js";
import { serializedFor } from "./serialized.js";

/** The ONE literal consumer name every obligation scan over the records stream reuses (the grant
 *  pins exactly this token; separate from the auth-ledger scanner's — fact-5, one name per stream).
 *  Scans over it serialize on the MODULE-LEVEL per-space chain below, never a per-instance lock. */
const RECORDS_SCANNER_CONSUMER_NAME = "cotal-records-scan";
const MANAGER_GOAL_INDEX_SCANNER_CONSUMER_NAME = "cotal-manager-goalidx-scan";

/** fact-5 ENFORCED (panel HIGH): the serialization critical section for a space's literal consumer
 *  name lives at MODULE level, keyed by space, so two branded same-space instances share one chain
 *  and can never interleave pre-clean/create/fetch/delete on that name (a per-instance lock cannot
 *  see a sibling instance). */
const SPACE_SCAN_CHAINS = new Map<string, Promise<unknown>>();

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
  /** Fixed `goalidx.manager.>` host scan. No caller filter or raw row leaves this operation, and
   * only entries owned by the authenticated remote manager owner are returned. */
  scanManagerGoalIndex(owner: string): Promise<GoalIndexEntry[]>;
  /** Tear down the owned credential+connection. */
  close(): Promise<void>;
}

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
    throw new EpEnvelopeError("failed-precondition", "the injected records scanner was not built by openRecordsScannerCandidate/makeRecordsScannerOverConnection; a hand-assembled scanner never authorizes an enumeration (SPEC 13.12)");
  if (bonded !== space)
    throw new EpEnvelopeError("failed-precondition", `the injected records scanner is bonded to space ${JSON.stringify(bonded)}, not ${JSON.stringify(space)}; a foreign-space scanner would enumerate the wrong (or an empty) subtree and let a drain declare quiescence over live obligations (SPEC 13.1/13.12)`);
}

/**
 * Open the sealed records-obligation scanner over the space's records stream: a DEDICATED
 * self-minted connection carrying ONLY {@link recordsScannerGrants}. The returned object exposes
 * only the closed op; the connection, credential, and raw scan are never handed out.
 */
export interface RecordsScannerCandidate {
  /** The connection's claim-pinnable broker identity (#29 HIGH 3, SPEC 13.13). */
  tuple: PlaneConnTuple;
  /** Resolves when the non-reconnecting connection is permanently gone (the fencing signal). */
  gone: Promise<void>;
  /** WINNER-ONLY, once: build the branded sealed scanner, its scan wrapped in the plane guard. */
  activate(guard: ScanGuard): RecordsScanner;
  close(): Promise<void>;
}

export async function openRecordsScannerCandidate(opts: {
  server: string;
  space: string;
  dataAccount: { pub: string; signingSeed: string };
  onConnection?: import("./authority-client.js").AuthorityClientOpts["onConnection"];
  log: (line: string) => void;
  /** SMOKE-ONLY scanner observation hooks. Production leaves this absent. */
  probe?: RecordsScannerProbe;
}): Promise<RecordsScannerCandidate> {
  const client: AuthorityClient = await openAuthorityClient({
    server: opts.server, space: opts.space, dataAccount: opts.dataAccount, label: `cotal:records-scan:${opts.space}`,
    onConnection: opts.onConnection,
    grants: (id) => recordsScannerGrants(opts.space, id), log: opts.log, planeCandidate: true,
  });
  if (client.tuple === undefined || client.gone === undefined)
    throw new EpEnvelopeError("internal", "a plane-candidate authority client carries a tuple and a gone signal by contract (SPEC 13.13)");
  let activated = false;
  let closed = false;
  return {
    tuple: client.tuple,
    gone: client.gone,
    activate: (guard: ScanGuard): RecordsScanner => {
      if (closed) throw new EpEnvelopeError("failed-precondition", "this records scanner candidate is closed (a losing plane open never activates)");
      if (activated) throw new EpEnvelopeError("failed-precondition", "this records scanner candidate is already activated (one branded scanner per candidate)");
      activated = true;
      return buildScanner(client.nc, opts.space, () => client.close(), opts.probe, guard);
    },
    close: async () => {
      closed = true;
      await client.close();
    },
  };
}

/**
 * TEST/SMOKE-ONLY: build the sealed records scanner over an EXISTING connection. A plain-auth test
 * broker has no data-account signing seed to self-mint a JWT, so the JWT-owning
 * {@link openRecordsScannerCandidate} (the PRODUCTION seam) does not apply. This factory's `close()` does
 * NOT close the caller's connection (the harness owns it); it is never a production composition path
 * and is never registered as a mintable profile.
 */
export function makeRecordsScannerOverConnection(nc: NatsConnection, space: string, probe?: RecordsScannerProbe, guard?: ScanGuard): RecordsScanner {
  return buildScanner(nc, space, async () => { /* the harness owns nc */ }, probe, guard);
}

/** SMOKE-ONLY probes into the shared drain. Never set in production. `afterCreate` and
 *  `afterFirstFetch` ({@link LiteralConsumerProbe}) fire on the obligation scan; the goal-index pair
 *  fires at the same two points of the manager goal-index scan. */
export interface RecordsScannerProbe extends LiteralConsumerProbe {
  afterManagerGoalIndexCreate?: () => Promise<void>;
  afterManagerGoalIndexFirstFetch?: () => Promise<void>;
}

function buildScanner(nc: NatsConnection, space: string, onClose: () => Promise<void>, probe?: RecordsScannerProbe, guard?: ScanGuard): RecordsScanner {
  const bucket = recordsBucket(space);
  const stream = recordsKvStreamName(space);
  const keyPrefixLen = `$KV.${bucket}.`.length;
  let jsmP: Promise<JetStreamManager> | undefined;
  let jsRef: JetStreamClient | undefined;
  const jsmOf = (): Promise<JetStreamManager> => (jsmP ??= jetstreamManager(nc));
  const jsOf = (): JetStreamClient => (jsRef ??= jetstream(nc));

  const scanOnce = async (rawFilter: string): Promise<RawRecordsEntry[]> => {
    const filter = `$KV.${bucket}.${assertObligFilter(rawFilter)}`;
    const latest = await drainLiteralConsumer(await jsmOf(), jsOf(), { stream, name: RECORDS_SCANNER_CONSUMER_NAME, filter, label: "records scanner", probe });
    const out: RawRecordsEntry[] = [];
    for (const [subject, v] of latest) out.push({ key: subject.slice(keyPrefixLen), data: v.data, seq: v.seq, op: v.op });
    return out;
  };

  const scanManagerGoalIndexOnce = async (owner: string): Promise<GoalIndexEntry[]> => {
    // A human manager's derived `u_…` owner, or the platform control manager's `p_…` owner (SPEC 13.1).
    const expectedOwner = assertPrincipalOwnerToken(owner, { allowPlatform: true });
    const rawFilter = `goalidx.manager.${expectedOwner}.>`;
    const latest = await drainLiteralConsumer(await jsmOf(), jsOf(), {
      stream, name: MANAGER_GOAL_INDEX_SCANNER_CONSUMER_NAME, filter: `$KV.${bucket}.${rawFilter}`, label: "manager goal-index scanner",
      probe: { afterCreate: probe?.afterManagerGoalIndexCreate, afterFirstFetch: probe?.afterManagerGoalIndexFirstFetch },
    });
    const out: GoalIndexEntry[] = [];
    for (const [subject, row] of latest) {
      const key = subject.slice(keyPrefixLen);
      if (row.op !== undefined)
        throw new EpEnvelopeError("failed-precondition", `manager goal-index entry ${key} carries a ${row.op} marker; a deletion is never a live index row`);
      let raw: unknown;
      try { raw = JSON.parse(new TextDecoder().decode(row.data)); }
      catch (e) { throw new EpEnvelopeError("internal", `manager goal-index entry ${key} does not decode as JSON: ${(e as Error).message}`); }
      const parsed = parseGoalIndexEntry(raw, key);
      const parsedKey = parseRecordKey(key);
      if (parsedKey?.def !== RECORD_KINDS.goalidx || parsedKey.part !== "atomic")
        throw new EpEnvelopeError("internal", `manager goal-index scanner received ${key}, which is not an atomic goalidx key`);
      const bodyQualifiers = [parsed.endpoint, parsed.owner, parsed.actor, parsed.uid, parsed.goalId];
      if (JSON.stringify(parsedKey.qualifiers) !== JSON.stringify(bodyQualifiers))
        throw new EpEnvelopeError("internal", `manager goal-index entry body qualifiers ${JSON.stringify(bodyQualifiers)} do not match key ${key}`);
      if (parsed.endpoint !== "manager")
        throw new EpEnvelopeError("internal", `manager goal-index scanner returned endpoint ${parsed.endpoint}`);
      if (parsed.owner !== expectedOwner)
        throw new EpEnvelopeError("internal", `manager goal-index scanner delivered foreign owner ${parsed.owner} outside ${expectedOwner}`);
      out.push(parsed);
    }
    return out;
  };

  // FROZEN before branding (capability integrity): the brand keys this exact reference, and the
  // freeze guarantees its ops are still the module's when an install seam asserts the brand — a
  // post-brand method swap throws (strict mode) instead of surviving as a silent-empty scanner.
  const scanner: RecordsScanner = Object.freeze({
    scanObligations: (filter: string) => serializedFor(SPACE_SCAN_CHAINS, space, () => guardedScan(guard, () => scanOnce(filter))),
    scanManagerGoalIndex: (owner: string) => serializedFor(SPACE_SCAN_CHAINS, space, () => guardedScan(guard, () => scanManagerGoalIndexOnce(owner))),
    close: onClose,
  });
  RECORDS_SCANNER_BRAND.set(scanner, space);
  return scanner;
}

/**
 * The SEALED records scanner's credential grant on the RECORDS stream (SPEC 13.9): exactly two
 * literal consumers' lifecycles. CREATE/INFO/NEXT/DELETE are pinned to
 * {@link RECORDS_SCANNER_CONSUMER_NAME} for the `oblig.` subtree and to
 * {@link MANAGER_GOAL_INDEX_SCANNER_CONSUMER_NAME} for the manager `goalidx` subtree, plus the stream
 * shape read and scoped inbox. This is the ONLY profile that holds `CONSUMER.CREATE` on
 * `KV_cotal_records_<space>` for either enumeration. {@link openRecordsScannerCandidate} opens it for
 * the trusted process and it is NEVER registered as an external/mintable profile. The bucket is
 * DERIVED from the validated space and both names are module constants, so no caller-supplied token
 * forms a privileged subject.
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
      `$JS.API.CONSUMER.CREATE.${stream}.${MANAGER_GOAL_INDEX_SCANNER_CONSUMER_NAME}.$KV.${bucket}.goalidx.manager.>`,
      `$JS.API.CONSUMER.INFO.${stream}.${MANAGER_GOAL_INDEX_SCANNER_CONSUMER_NAME}`,
      `$JS.API.CONSUMER.MSG.NEXT.${stream}.${MANAGER_GOAL_INDEX_SCANNER_CONSUMER_NAME}`,
      `$JS.API.CONSUMER.DELETE.${stream}.${MANAGER_GOAL_INDEX_SCANNER_CONSUMER_NAME}`,
    ],
    subscribe: [`_INBOX_${inbox}.>`],
  };
}
