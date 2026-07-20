/**
 * The PLANE CLAIM (#29 HIGH 3, SPEC 13.13): cross-process single-owner exclusion for the two
 * SEALED scanners' literal-consumer critical sections.
 *
 * THE HARM THIS CLOSES: two same-space auth processes each hold a records/ledger scanner over the
 * SAME literal consumer name. The module-level serialization chains are process-local, so the two
 * planes interleave pre-clean/create/fetch/delete, one returns a PARTIAL enumeration, a drain
 * declares quiescence over undrained obligations, and the retirement frontiers close over live
 * work. Seal-class.
 *
 * THE MECHANISM (the panel's FINAL scanner-bound shape; security ruling + fact's safety pin):
 *  - ONE exact, never-deleted auth-KV key (`plane`) holds the claim row: the two ownership-bearing
 *    sealed-scanner connection tuples `(serverId, cid, userNkey)` + `state: held|released` +
 *    a per-open random `claimId` + a monotonically increasing `generation`. The BARRIER identity
 *    is deliberately NOT in the row: barrier liveness is irrelevant to the literal consumers and
 *    could only falsely block a reclaim.
 *  - OPEN ORDER: both candidate scanner connections open FIRST (non-reconnecting, so the tuples
 *    are stable and disappearance is final), stay INERT (no branded `scan*` capability exists or
 *    escapes), then the claim is taken by broker-atomic create/revision-CAS. Only the WINNER
 *    activates the branded scanners; a loser closes both candidates immediately. The brief
 *    dual connected-credential window is accepted inside the signing-seed residual; there is no
 *    dual SCAN authority because the operation capability does not exist before the CAS win.
 *  - RECLAIM of a `held` row is LIVENESS-ONLY, adjudicated by the delivery daemon's read-only
 *    CONNZ oracle over the delivery-admin rail (auth holds NO $SYS, the D5 rail split): both
 *    claimed tuples must be conclusively ABSENT under a COMPLETE sweep. Any live, unknown,
 *    incomplete, malformed, or foreign-echo answer REFUSES (at most one plane; dual-refuse is
 *    safe, dual-proceed is not). There is NO TTL, NO heartbeat, and NO "did the last sealed scan
 *    finish" bit: a mid-scan crash drops the non-reconnecting connections, a complete sweep
 *    proves them gone, and the successor's fail-closed pre-clean makes its full re-scan safe
 *    (the critic's inverted-lockout wedge cannot occur).
 *  - HOLDING: the guard re-validates the claim (held + this claimId + this generation) BEFORE and
 *    AFTER every sealed scan; a lost/changed claim refuses the enumeration or discards its
 *    result. A mid-life scanner disconnect is a FENCING event: the composition fences the guard,
 *    closes the sibling, and the plane stops scanning rather than half-running.
 *  - CLEAN CLOSE: scan-capable clients close FIRST, then the row CASes `held → released` (a crash
 *    leaves `held`, which the next open reclaims via the oracle), then the barrier closes.
 *
 * OPERATOR FACES (ux co-requirement — THREE distinct states, never collapsed):
 *  1. live peer      → a real double-launch: stop the other auth process.
 *  2. UNKNOWN        → fail-safe refusal on an inconclusive observation: wait/retry, check the
 *                      delivery daemon and the broker link. NEVER "stop the other process".
 *  3. mid-life death → this plane fenced itself deliberately; restart it (the successor may
 *                      briefly land on state 2).
 */
import { Kvm, type KV } from "@nats-io/kv";
import type { NatsConnection } from "@nats-io/transport-node";
import {
  CotalEndpoint,
  EpEnvelopeError,
  epAuthBucket,
  isCasLoss,
  isPlaneConnTuple,
  mintCreds,
  newIdentity,
  parsePlaneLivenessResult,
  type PlaneConnTuple,
  type PlaneLivenessQuery,
  type PlaneLivenessResult,
  type SpaceAuth,
} from "@cotal-ai/core";

/** The ONE exact claim key (`$KV.cotal_auth_<space>.plane`) — the bucket is already space-scoped;
 *  the barrier grant carries exactly this key, never `plane.>`. */
export const PLANE_CLAIM_KEY = "plane";

/** The claim row (closed schema, v1). Never deleted; `released` is the clean-close terminal a
 *  successor CASes over without an oracle round. */
export interface PlaneClaimRow {
  v: 1;
  /** Monotonically increasing across every successful HELD write (create=1) — a successor's CAS
   *  target and the guard's staleness check. */
  generation: number;
  /** Per-open random id: the holder's identity for the guard (a successor necessarily writes a
   *  different one). */
  claimId: string;
  state: "held" | "released";
  /** The two ownership-bearing sealed-scanner connection identities (the auth-ledger scan and the
   *  records-obligation scan). The barrier is deliberately absent. */
  ledger: PlaneConnTuple;
  records: PlaneConnTuple;
  openedAt: string;
}

/** The liveness oracle seam: the production implementation rides the delivery-admin rail
 *  ({@link makeDeliveryAdminPlaneOracle}); smokes inject deterministic verdicts. Every failure
 *  mode maps to `unknown` (never throws) — an oracle that cannot answer must block takeover. */
export type PlaneLivenessOracle = (query: PlaneLivenessQuery) => Promise<PlaneLivenessResult>;

/** The scan guard the WINNER threads into its branded scanners: claim re-validation around every
 *  sealed scan + the mid-life fencing switch. */
export interface ScanGuard {
  /** Throws unless the claim is currently held by THIS open (state held, same claimId, same
   *  generation) — called by the sealed scanners BEFORE (refuse to enumerate) and AFTER (discard
   *  the enumeration) every scan, inside the serialized critical section. */
  assertHeld(when: "before" | "after"): Promise<void>;
}

/** The winner's hold on the plane. */
export interface PlaneClaimHold {
  claimId: string;
  generation: number;
  guard: ScanGuard;
  /** Fence the guard permanently (the mid-life scanner-death path): every subsequent assertHeld
   *  throws `reason`. First fence wins. */
  fence(reason: string): void;
  /** Clean close: CAS `held → released` (call ONLY after the scanner clients are closed). A row
   *  no longer held by this claimId is logged loud and left alone (a successor already owns it). */
  release(): Promise<void>;
}

const enc = new TextEncoder();
const dec = new TextDecoder();

/** Closed parse of a claim row. Returns undefined on ANY structural violation — the caller turns
 *  that into a loud corruption refusal (an unparseable exclusion row must never be reasoned over). */
export function parsePlaneClaimRow(bytes: Uint8Array): PlaneClaimRow | undefined {
  let raw: unknown;
  try {
    raw = JSON.parse(dec.decode(bytes));
  } catch {
    return undefined;
  }
  if (raw === null || typeof raw !== "object") return undefined;
  for (const k of Object.keys(raw)) if (!["v", "generation", "claimId", "state", "ledger", "records", "openedAt"].includes(k)) return undefined; // closed v1 schema
  const r = raw as Partial<PlaneClaimRow>;
  if (r.v !== 1) return undefined;
  if (typeof r.generation !== "number" || !Number.isSafeInteger(r.generation) || r.generation < 1) return undefined;
  if (typeof r.claimId !== "string" || r.claimId.length === 0 || r.claimId.length > 128) return undefined;
  if (r.state !== "held" && r.state !== "released") return undefined;
  if (!isPlaneConnTuple(r.ledger) || !isPlaneConnTuple(r.records)) return undefined;
  if (typeof r.openedAt !== "string" || r.openedAt.length === 0 || r.openedAt.length > 64) return undefined;
  return { v: 1, generation: r.generation, claimId: r.claimId, state: r.state, ledger: r.ledger, records: r.records, openedAt: r.openedAt };
}

const sameTuple = (a: PlaneConnTuple, b: PlaneConnTuple): boolean =>
  a.serverId === b.serverId && a.cid === b.cid && a.userNkey === b.userNkey;

/** UX STATE 1 — a real double-launch: the prior plane's scanner connection(s) are LIVE. */
const livePeerCopy = (space: string, row: PlaneClaimRow, r: PlaneLivenessResult): string => {
  const live = [
    ...(r.ledger.state === "live" ? [`auth-ledger scan conn ${row.ledger.cid} on server ${row.ledger.serverId}`] : []),
    ...(r.records.state === "live" ? [`records scan conn ${row.records.cid} on server ${row.records.serverId}`] : []),
  ].join(" and ");
  return `another auth plane already owns space "${space}": its ${live} is LIVE on the broker (claim held since ${row.openedAt}). Two auth planes over one space would split the sealed scanners' critical sections and could retire an agent over undrained work, so this open REFUSES (fail-closed). NEXT: stop the other auth service process for this space (\`cotal down\` stops the one \`cotal up\` started), then start this one.`;
};

/** UX STATE 2 — fail-safe refusal on an INCONCLUSIVE observation. This is the common
 *  crash/sleep/restart path; it must NEVER say "stop the other process" (the operator already
 *  did — pointing them at a ghost is the manager-lease-loss ghost-chase class). */
const unknownCopy = (space: string, row: PlaneClaimRow, cause: string, railDown: boolean): string =>
  `cannot confirm the previous auth plane for space "${space}" has fully disconnected (${cause}; claim held since ${row.openedAt}). This refusal is FAIL-SAFE, not a failure: taking over while the prior plane might still be scanning would risk a partial enumeration. NEXT: ${railDown
    ? "the delivery daemon (the connection-liveness oracle) is not answering. Start it, then restart this auth service: after a whole-stack crash, run `cotal up` once more after it finishes (it brings the delivery daemon up after this service, so the first run cannot adjudicate a stale claim)."
    : "retry once the prior plane's connections time out on the broker (seconds, not minutes); if it persists, check this host's link to the broker."} Do NOT delete the plane claim by hand.`;

/** UX STATE 3 — mid-life scanner death: this plane fenced itself DELIBERATELY. */
export const scannerDeathCopy = (space: string, role: "auth-ledger" | "records"): string =>
  `this auth plane lost its sealed ${role} scanner connection for space "${space}" and STOPPED scanning to avoid a partial enumeration (deliberate, fail-safe: the connection is non-reconnecting because the plane claim pins its exact identity). Nothing is lost: barriers refuse instead of running over a half-scan. NEXT: restart the auth service; the successor may briefly refuse while the broker confirms the dropped connections cleared, then takes over.`;

/** A CAS loss during open: a sibling open won the row between our read and our write. */
const concurrentCopy = (space: string): string =>
  `another auth plane claimed space "${space}" concurrently during this open (the claim CAS lost). Exactly one plane may own the sealed scanners. NEXT: if you started two auth services for this space, stop one; if this was a crash-recovery race, the other process now owns the plane and this one is not needed.`;

const corruptCopy = (space: string): string =>
  `the plane claim row for space "${space}" is not a valid v1 claim (garbled bytes or a foreign write). The claim is the cross-process single-plane exclusion, so an unparseable row is never reasoned over or overwritten automatically (fail-closed). NEXT: this needs operator repair - inspect \`$KV.${epAuthBucket(space)}.${PLANE_CLAIM_KEY}\` and restore or remove it deliberately (SPEC 13.13).`;

/**
 * Acquire the plane claim for `space` over the BARRIER connection (the only profile holding the
 * exact `plane` write). Called with the two candidate scanner tuples AFTER those connections are
 * open and BEFORE any branded scanner exists. Returns the winner's hold, or throws one of the
 * three operator-legible refusals. Every path is broker-atomic: create-only on a virgin key,
 * revision-CAS everywhere else.
 */
export async function acquirePlaneClaim(opts: {
  nc: NatsConnection;
  space: string;
  ledger: PlaneConnTuple;
  records: PlaneConnTuple;
  oracle: PlaneLivenessOracle;
  log: (line: string) => void;
}): Promise<PlaneClaimHold> {
  const { space, log } = opts;
  const kv: KV = await new Kvm(opts.nc).open(epAuthBucket(space));
  const claimId = newIdentity().id; // a fresh nkey pub: random, printable, collision-free
  const myRow = (generation: number): PlaneClaimRow => ({
    v: 1, generation, claimId, state: "held", ledger: opts.ledger, records: opts.records, openedAt: new Date().toISOString(),
  });
  const write = (row: PlaneClaimRow): Uint8Array => enc.encode(JSON.stringify(row));

  let generation: number | undefined;
  // One retry loop: a lost create/CAS re-reads once and re-decides; a second loss is the
  // concurrent refusal (never spin on a contended exclusion key).
  for (let attempt = 0; attempt < 2 && generation === undefined; attempt++) {
    const entry = await kv.get(PLANE_CLAIM_KEY);
    if (entry === null) {
      try {
        await kv.create(PLANE_CLAIM_KEY, write(myRow(1)));
        generation = 1;
      } catch (e) {
        if (!isCasLoss(e)) throw e; // a denied/undeliverable write is a config error, never "contention"
        continue; // a sibling created first - re-read and adjudicate its row
      }
      break;
    }
    const row = parsePlaneClaimRow(entry.value);
    if (row === undefined) throw new EpEnvelopeError("failed-precondition", corruptCopy(space));
    if (row.state === "released") {
      try {
        await kv.update(PLANE_CLAIM_KEY, write(myRow(row.generation + 1)), entry.revision);
        generation = row.generation + 1;
      } catch (e) {
        if (!isCasLoss(e)) throw e;
        continue; // a sibling claimed the released row first
      }
      break;
    }
    // A held row: adjudicate the PRIOR holder's scanner liveness (never our own tuples).
    const verdictRaw = await opts.oracle({ ledger: row.ledger, records: row.records });
    // Foreign/garbled echo never authorizes: the reply must describe exactly the queried tuples.
    const verdict: PlaneLivenessResult =
      sameTuple(verdictRaw.ledger.tuple, row.ledger) && sameTuple(verdictRaw.records.tuple, row.records)
        ? verdictRaw
        : { ledger: { tuple: row.ledger, state: "unknown" }, records: { tuple: row.records, state: "unknown" }, sweepComplete: false, note: "the liveness oracle echoed a FOREIGN query - treated as unknown" };
    if (verdict.ledger.state === "live" || verdict.records.state === "live")
      throw new EpEnvelopeError("failed-precondition", livePeerCopy(space, row, verdict));
    if (!verdict.sweepComplete || verdict.ledger.state === "unknown" || verdict.records.state === "unknown") {
      const cause = verdict.note ?? "the connection-liveness sweep was inconclusive";
      throw new EpEnvelopeError("unavailable", unknownCopy(space, row, cause, /daemon|rail|unreachable|refused|responder/i.test(cause)));
    }
    // Both conclusively gone under a complete sweep: reclaim by revision-CAS.
    try {
      await kv.update(PLANE_CLAIM_KEY, write(myRow(row.generation + 1)), entry.revision);
      generation = row.generation + 1;
      log(`plane-claim: reclaimed space "${space}" from a dead plane (claim ${row.claimId} held since ${row.openedAt}; both scanner connections verified gone under a complete sweep)`);
    } catch (e) {
      if (!isCasLoss(e)) throw e;
      continue; // a sibling reclaimed first
    }
  }
  if (generation === undefined) throw new EpEnvelopeError("failed-precondition", concurrentCopy(space));
  const gen = generation;
  log(`plane-claim: space "${space}" held (claimId ${claimId}, generation ${gen})`);

  let fencedReason: string | undefined;
  let released = false;
  const assertHeld = async (when: "before" | "after"): Promise<void> => {
    if (fencedReason !== undefined) throw new EpEnvelopeError("failed-precondition", fencedReason);
    if (released) throw new EpEnvelopeError("failed-precondition", `the plane claim for space "${space}" was released by this process; a sealed scan can no longer run under it`);
    const entry = await kv.get(PLANE_CLAIM_KEY);
    const row = entry === null ? undefined : parsePlaneClaimRow(entry.value);
    // Held by THIS open = state + claimId + generation + BOTH pinned scanner tuples (a row rewrite
    // preserving id and generation but swapping a tuple is a lost claim, never "still ours").
    if (row === undefined || row.state !== "held" || row.claimId !== claimId || row.generation !== gen ||
        !sameTuple(row.ledger, opts.ledger) || !sameTuple(row.records, opts.records)) {
      const what = when === "before" ? "refusing to enumerate" : "DISCARDING this enumeration";
      throw new EpEnvelopeError("failed-precondition",
        `the plane claim for space "${space}" is no longer held by this process (${row === undefined ? "row missing or unparseable" : row.state !== "held" || row.claimId !== claimId || row.generation !== gen ? `now ${row.state} under claim ${row.claimId} generation ${row.generation}` : "the row's scanner tuples no longer match this plane's connections"}, expected held under ${claimId} generation ${gen}); ${what} - a successor plane may own the sealed scanners (SPEC 13.13, fail-closed)`);
    }
  };
  return {
    claimId,
    generation: gen,
    guard: { assertHeld },
    fence: (reason: string) => {
      if (fencedReason === undefined) fencedReason = reason;
    },
    release: async () => {
      if (released) return;
      released = true;
      try {
        const entry = await kv.get(PLANE_CLAIM_KEY);
        const row = entry === null ? undefined : parsePlaneClaimRow(entry.value);
        // Release ownership = the FULL held invariant (state + claimId + generation + both tuples),
        // exactly what assertHeld checks.
        if (entry === null || row === undefined || row.state !== "held" || row.claimId !== claimId || row.generation !== gen ||
            !sameTuple(row.ledger, opts.ledger) || !sameTuple(row.records, opts.records)) {
          log(`plane-claim: NOT releasing space "${space}" - the row is ${row === undefined ? "missing/unparseable" : row.state !== "held" || row.claimId !== claimId || row.generation !== gen ? `${row.state} under claim ${row.claimId} generation ${row.generation}` : "held under this claimId but with FOREIGN scanner tuples"}, not held by this process (a successor may own it)`);
          return;
        }
        await kv.update(PLANE_CLAIM_KEY, enc.encode(JSON.stringify({ ...row, state: "released" } satisfies PlaneClaimRow)), entry.revision);
        log(`plane-claim: released space "${space}" (generation ${row.generation})`);
      } catch (e) {
        // A failed release is NOT an error state: the row stays held and the next open reclaims
        // through the oracle exactly like a crash. Loud, never throwing out of a close path.
        log(`plane-claim: release for space "${space}" failed (${e instanceof Error ? e.message : String(e)}) - the row stays held; the next open reclaims it once these connections drop (fail-safe)`);
      }
    },
  };
}

/** The per-liveness-call credential's TTL (the barrier-evict precedent): one delivery-admin call
 *  runs in a 15s request budget; 60s bounds a copied credential to a minute. */
const ORACLE_CRED_TTL_SECONDS = 60;

/**
 * The PRODUCTION liveness oracle over the delivery daemon's `ctl.delivery-admin` rail (the
 * barrier-evict seam's twin: per-call connection, supervisor-profile credential minted with a
 * tight TTL from the seed the service already holds — the same named residual, #30 migrates it).
 * FAIL-CLOSED MAPPING: no daemon, a refusal, a garbled reply, or a foreign echo all return
 * `unknown` verdicts with an honest note — this seam never fabricates absence and never throws.
 */
export function makeDeliveryAdminPlaneOracle(opts: {
  space: string;
  server: string;
  dataAccount: { pub: string; signingSeed: string };
  log: (line: string) => void;
}): PlaneLivenessOracle {
  const auth: SpaceAuth = {
    space: opts.space,
    operator: { seed: "", jwt: "" },
    account: { pub: opts.dataAccount.pub, seed: "", jwt: "", signingSeed: opts.dataAccount.signingSeed, signingPub: "" },
    sys: { pub: "", jwt: "" },
  };
  const unknown = (query: PlaneLivenessQuery, note: string): PlaneLivenessResult => {
    opts.log(`plane-oracle: ${note}`);
    return { ledger: { tuple: query.ledger, state: "unknown" }, records: { tuple: query.records, state: "unknown" }, sweepComplete: false, note };
  };
  return async (query: PlaneLivenessQuery): Promise<PlaneLivenessResult> => {
    const id = newIdentity();
    let ep: CotalEndpoint | undefined;
    try {
      const creds = await mintCreds(auth, id, "supervisor", { expiresInSeconds: ORACLE_CRED_TTL_SECONDS });
      ep = new CotalEndpoint({
        space: opts.space,
        servers: opts.server,
        creds,
        card: { id: id.id, name: "auth-plane-oracle", kind: "endpoint" },
        channels: [],
        consume: false,
        watchChannels: false,
        watchPresence: false,
        registerPresence: false,
      });
      ep.on("error", () => {});
      await ep.start();
      const r = await ep.requestDeliveryAdmin("planeConnLiveness", { query }, 15_000);
      if (!r.ok) return unknown(query, `the delivery daemon refused the liveness query: ${r.error ?? "(no error copy)"}`);
      // CLOSED parse of the wire-crossing result: exact keys at every level, enum states, closed
      // tuples. Anything else is a garbled oracle and blocks takeover.
      const d = parsePlaneLivenessResult(r.data);
      if (d === undefined)
        return unknown(query, `the delivery daemon returned a garbled liveness result (${JSON.stringify(r.data ?? null)})`);
      if (!sameTuple(d.ledger.tuple, query.ledger) || !sameTuple(d.records.tuple, query.records))
        return unknown(query, "the delivery daemon echoed a FOREIGN liveness query; a result that does not verifiably describe this claim never authorizes");
      // An internally CONTRADICTORY answer never authorizes: `gone` is conclusive only under a
      // complete sweep (the eviction seam's truthium rule, applied to the read-only twin).
      if (!d.sweepComplete && (d.ledger.state === "gone" || d.records.state === "gone"))
        return unknown(query, `the delivery daemon claimed gone under an INCOMPLETE sweep (ledger=${d.ledger.state}, records=${d.records.state}); contradictory - treated as unknown`);
      return d;
    } catch (e) {
      return unknown(query, `the delivery-admin rail is unreachable (${e instanceof Error ? e.message : String(e)}); liveness is UNKNOWN and the claim is not reclaimed`);
    } finally {
      await ep?.stop().catch(() => {});
    }
  };
}
