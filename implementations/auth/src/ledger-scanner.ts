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
 *  - the composition OWNS ITS AUTHORITY: {@link openAuthLedgerScanner} opens a DEDICATED, minimal
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
 *  - pre-clean is FAIL-CLOSED: it accepts only a confirmed delete or a proved not-found, then
 *    creates; any other error (timeout/permission/leader) fails the scan. Final cleanup is
 *    unconditional; a leaked orphan is collected by the bounded inactivity and pre-cleaned next run.
 *  - completeness is FAIL-CLOSED: the drain re-reads `num_pending` and stops only at a proved zero
 *    (never a stale initial count); an under-delivering fetch throws.
 */
import { AckPolicy, DeliverPolicy, jetstream, jetstreamManager, type JetStreamClient, type JetStreamManager } from "@nats-io/jetstream";
import type { NatsConnection } from "@nats-io/transport-node";
import { EpEnvelopeError, assertInboxConnId, assertLifecycleToken, epAuthBucket } from "@cotal-ai/core";
import { openAuthorityClient, type AuthorityClient } from "./authority-client.js";

/** The ONE literal consumer name every scan over the auth stream reuses under the serialization
 *  lock (the grant pins exactly this token; two instances with the same name would have independent
 *  locks and could delete each other's read, so there is ONE scanner instance per stream). */
const SCANNER_CONSUMER_NAME = "cotal-ledger-scan";
/** Bounded inactivity (ns): a leaked orphan (a run that crashed before its unconditional delete)
 *  is broker-collected within this window, and the next run's pre-clean removes it by name. */
const INACTIVE_THRESHOLD_NS = 30_000_000_000;
/** A guard on the drain: under a frozen gate no new family writes occur, so a LastPerSubject
 *  consumer settles to zero pending quickly; a scan that never settles fails closed rather than
 *  spinning. */
const MAX_DRAIN_ROUNDS = 4096;

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
  /** Tear down the owned credential+connection. */
  close(): Promise<void>;
}

const isConsumerNotFound = (e: unknown): boolean => {
  const err = e as { code?: unknown; api_error?: { err_code?: unknown }; message?: unknown };
  return err?.code === 404 || err?.api_error?.err_code === 10014 ||
    (typeof err?.message === "string" && /consumer not found/i.test(err.message));
};

/**
 * Open the sealed auth-ledger scanner over the space's auth stream: a DEDICATED self-minted
 * connection carrying ONLY {@link authorityScannerGrants}. The returned object exposes only the
 * closed ops; the connection, credential, and raw scan are never handed out.
 */
export async function openAuthLedgerScanner(opts: {
  server: string;
  space: string;
  dataAccount: { pub: string; signingSeed: string };
  log: (line: string) => void;
}): Promise<AuthLedgerScanner> {
  const client: AuthorityClient = await openAuthorityClient({
    server: opts.server, space: opts.space, dataAccount: opts.dataAccount, label: `cotal:auth-scan:${opts.space}`,
    grants: (id) => authorityScannerGrants(opts.space, id), log: opts.log,
  });
  return buildScanner(client.nc, opts.space, () => client.close());
}

/**
 * TEST/SMOKE-ONLY: build the sealed scanner over an EXISTING connection. A plain-auth test broker
 * has no data-account signing seed to self-mint a JWT, so the JWT-owning {@link openAuthLedgerScanner}
 * (the PRODUCTION seam, which owns a dedicated credential+connection) does not apply. This factory's
 * `close()` does NOT close the caller's connection (the harness owns it); it is never a production
 * composition path and is never registered as a mintable profile.
 */
export function makeLedgerScannerOverConnection(nc: NatsConnection, space: string, probe?: ScannerProbe): AuthLedgerScanner {
  return buildScanner(nc, space, async () => { /* the harness owns nc */ }, probe);
}

/** SMOKE-ONLY probe (precedent: AuthorityClient.probeRenewal). `afterCreate` fires ONCE, after the
 *  consumer is created + bind-verified but BEFORE the drain, so a test can force the history=1
 *  race: overwrite a subject `active→revoked` (evicting the pre-scan revision) inside the create→
 *  drain window and prove the fence-free scan still returns that subject's CURRENT last. Production
 *  compositions never set it. */
export interface ScannerProbe {
  afterCreate?: () => Promise<void>;
}

function buildScanner(nc: NatsConnection, space: string, onClose: () => Promise<void>, probe?: ScannerProbe): AuthLedgerScanner {
  const bucket = epAuthBucket(space);
  const stream = `KV_${bucket}`;
  const keyPrefixLen = `$KV.${bucket}.`.length;
  let jsmP: Promise<JetStreamManager> | undefined;
  let jsRef: JetStreamClient | undefined;
  const jsmOf = (): Promise<JetStreamManager> => (jsmP ??= jetstreamManager(nc));
  const jsOf = (): JetStreamClient => (jsRef ??= jetstream(nc));

  // Serialize every scan over the shared literal consumer name: a promise chain is the critical
  // section, so a second caller waits rather than colliding on create/fetch/delete.
  let tail: Promise<unknown> = Promise.resolve();
  const serialized = <T>(fn: () => Promise<T>): Promise<T> => {
    const run = tail.then(fn, fn);
    tail = run.then(() => undefined, () => undefined);
    return run;
  };

  // The RAW scan — MODULE-PRIVATE (a closure over the owned connection): no caller ever supplies
  // `prefix`; the closed ops below force it from a validated id.
  const scanOnce = async (prefix: string): Promise<RawScanEntry[]> => {
    const jsm = await jsmOf();
    const js = jsOf();
    const filterBase = `$KV.${bucket}.${prefix}`; // every returned subject MUST start with this
    const filter = `${filterBase}>`;

    // 1. FAIL-CLOSED pre-clean: remove any leftover of the literal name from a crashed prior run.
    // Accept ONLY a confirmed delete or a proved not-found; a timeout/permission/leader error fails
    // the scan (a surviving stale consumer with an outstanding pull could otherwise advance AckNone
    // deliveries and make this run silently omit rows).
    try {
      await jsm.consumers.delete(stream, SCANNER_CONSUMER_NAME);
    } catch (e) {
      if (!isConsumerNotFound(e))
        throw new EpEnvelopeError("unavailable", `the sealed scanner could not prove its literal consumer absent on ${stream} before create (pre-clean fails closed, SPEC 13.9): ${(e as Error)?.message ?? String(e)}`);
    }

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

      // 4. Drain to a RE-PROVED zero. `num_pending` is re-read each round (never a stale initial
      // count): a LastPerSubject consumer over a frozen family settles to zero, so a proved-zero
      // read is the completeness fence. Last-write-wins by concrete subject, monotonic in seq.
      const latest = new Map<string, { data: Uint8Array; seq: number; op: string | undefined }>();
      const consumer = await js.consumers.get(stream, SCANNER_CONSUMER_NAME);
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
          const prev = latest.get(m.subject);
          if (prev === undefined || m.seq > prev.seq)
            latest.set(m.subject, { data: m.data, seq: m.seq, op: m.headers?.get("KV-Operation") || undefined });
        }
        if (got < want)
          throw new EpEnvelopeError("unavailable", `the sealed scanner under ${prefix} under-delivered (${got}/${want}); a partial read never proceeds (SPEC 13.1)`);
      }
      const out: RawScanEntry[] = [];
      for (const [subject, v] of latest) out.push({ key: subject.slice(keyPrefixLen), data: v.data, seq: v.seq, op: v.op });
      return out;
    } finally {
      // 5. Unconditional cleanup (a leaked orphan is collected by the bounded inactivity).
      try { await jsm.consumers.delete(stream, SCANNER_CONSUMER_NAME); } catch { /* orphan collected by inactivity */ }
    }
  };

  return {
    scanCredentialFamily: (lifecycleUid) =>
      serialized(() => scanOnce(`cred.${assertLifecycleToken(lifecycleUid)}.`)),
    scanBysrc: (issuerKeyId, id) =>
      serialized(() => scanOnce(`bysrc.${assertSegment(issuerKeyId, "issuerKeyId")}.${assertSegment(id, "handle id")}.`)),
    scanStageFamily: () => serialized(() => scanOnce("stage.")),
    close: onClose,
  };
}

/**
 * The SEALED SCANNER's credential grant on the AUTH stream (SPEC 13.9): exactly the ONE literal
 * enumeration consumer's lifecycle (CREATE/INFO/NEXT/DELETE pinned to {@link SCANNER_CONSUMER_NAME})
 * + the stream shape read + the scoped inbox. This is the ONLY profile that holds `CONSUMER.CREATE`
 * on `KV_cotal_auth_<space>`; {@link openAuthLedgerScanner} opens it for the trusted process and it
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
