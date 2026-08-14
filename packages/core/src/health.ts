/**
 * Delivery-plane health — an AFFIRMATIVE liveness surface.
 *
 * The delivery daemon once went down and nothing noticed for three hours: messages were accepted,
 * senders were told they had been sent, and the only evidence it was dead was the absence of
 * something nobody was watching for. This module exists so an operator can ask "is delivery
 * actually working right now" and get an answer that is either affirmative or a NAMED refusal.
 *
 * Three rules, each of which an existing surface breaks today:
 *
 * 1. **Liveness is AFFIRMATIVE.** It is a message the daemon produced in response to THIS question,
 *    after this question was asked. Explicitly NOT: that a process exists (a wedged daemon has a
 *    pid), that the broker is reachable (`isReachable` proves the broker, never the daemon), or
 *    that the lease reads `ready:true`. That last one is the subtle one — `ready` is set once after
 *    the responder binds and then re-asserted by every lease renew WITHOUT re-checking that the
 *    responder still answers, so it is a liveness proxy for the renew timer, not for the responder.
 *    A dead daemon is bounded by the bucket TTL; a daemon wedged while its timer still fires is
 *    bounded by nothing at all.
 *
 * 2. **A refusal is never a pass.** When health cannot be established the surface names WHICH
 *    condition failed ({@link HealthRefusal}). There is no "unknown" and no bare `undefined` — a
 *    reader must not be able to mistake a failed read for a healthy one. The union is shaped so
 *    that treating a refusal as healthy is hard to write rather than the default: the facts live
 *    only on the `serving: true` arm and cannot be reached without narrowing.
 *
 * 3. **Every fact carries its SOURCE and its AGE** ({@link HealthFact}). A health view that renders
 *    a stale answer as a current one reproduces the exact defect it exists to catch.
 */

/** Where a reported fact came from. The distinction is load-bearing: only `responder-roundtrip` is
 *  affirmative evidence that DELIVERY is serving. `lease-kv` is a record written in the past by a
 *  process that may no longer exist, and `broker-dial` says nothing about the daemon at all. */
export type HealthSource = "responder-roundtrip" | "lease-kv" | "broker-dial";

/** A reported fact plus its provenance. Never a bare value.
 *
 *  `observedAt` is when THIS observation was made; `ageMs` is how old the underlying EVIDENCE was
 *  at that moment. The two differ exactly where it matters: a responder round-trip has an age of
 *  ~0 because the daemon answered just now, while a lease read can be arbitrarily old evidence
 *  observed a moment ago. Collapsing them is how a cache gets rendered as a current reading. */
export interface HealthFact<T> {
  value: T;
  source: HealthSource;
  observedAt: number;
  /** How old the EVIDENCE was at `observedAt`, or `null` when that cannot be established.
   *
   *  `null` rather than a number, deliberately, so every consumer must narrow before comparing.
   *  A numeric sentinel would be silently comparable — and the comparison at the TTL gate below is
   *  precisely where a sentinel would be read as "fresh". */
  ageMs: number | null;
  /** Set only when `evidenceAt` is AFTER `observedAt`: the evidence clock runs ahead of ours by
   *  this many ms, so no age can be computed from the two. Carried so a reader can see HOW FAR
   *  ahead rather than merely that something was wrong. */
  clockSkewMs?: number;
}

/** Build a fact whose evidence was produced `evidenceAt` (epoch ms) and observed at `observedAt`.
 *
 *  A record stamped in the FUTURE is a clock fault, and this function REFUSES to age it rather than
 *  clamping it to 0. The clamp that used to live here was the lane's own disease in the lane's own
 *  envelope: `evidenceAt` comes from a FOREIGN clock (the daemon writes it into the lease; we read
 *  it), so a writer running ahead made the subtraction negative, and `Math.max(0, …)` reported
 *  `ageMs: 0` — **which is exactly what a live responder round-trip produces**
 *  (`fact(answered - started, "responder-roundtrip", answered, answered)` below). Arbitrarily stale
 *  evidence became indistinguishable from an answer that arrived just now.
 *
 *  It was not merely cosmetic: the TTL gate compares `ageMs > ttlMs`, so a clamped 0 sailed through
 *  the staleness check that the age exists to drive. The defensive clamp WAS the bug — a degraded
 *  input that did not degrade the claim. */
export function fact<T>(value: T, source: HealthSource, evidenceAt: number, observedAt: number): HealthFact<T> {
  const delta = observedAt - evidenceAt;
  if (delta < 0) return { value, source, observedAt, ageMs: null, clockSkewMs: -delta };
  return { value, source, observedAt, ageMs: delta };
}

/** WHY health could not be established. Each arm names the condition that failed and carries the
 *  evidence a reader needs to act, so a refusal is diagnostic rather than a shrug.
 *
 *  `lastHeartbeat` rides `no-responder` deliberately: "the lease says a daemon was alive 4s ago but
 *  nothing answers" and "nothing answers and there is no record at all" are different operational
 *  situations, and the second is not more severe than the first — it is a different fault. */
export type HealthRefusal =
  /** The broker itself could not be dialled. Says nothing about the daemon. */
  | { condition: "unreachable"; server: string; detail: string }
  /** No lease record for this shard: no daemon has claimed it, or a crashed holder's key expired. */
  | { condition: "no-lease"; shard: number; detail: string }
  /** A holder record exists but its heartbeat is older than the TTL that should have refreshed it. */
  | { condition: "lease-stale"; shard: number; lastHeartbeat: HealthFact<number>; detail: string }
  /** The lease claims a ready daemon, but the affirmative round-trip did not complete in time.
   *  THE INCIDENT'S SIGNATURE: a present-but-wedged daemon lands here, and lands here forever. */
  | { condition: "no-responder"; shard: number; deadlineMs: number; lastHeartbeat?: HealthFact<number>; detail: string }
  /** The read itself was denied — no grant, or a bucket this credential cannot open. Distinct from
   *  "nothing is there": a permission fault must never render as an absence. */
  | { condition: "refused"; read: string; detail: string };

/** The health verdict. A discriminated union rather than a boolean or an optional, so that the
 *  facts are unreachable without first narrowing on `serving === true`. There is no third state:
 *  anything that is not affirmative is a named refusal. */
export type DeliveryHealth =
  | {
      serving: true;
      /** The daemon's own identity, from the lease holder record. */
      incarnation: HealthFact<string>;
      /** Affirmative proof: the daemon answered this probe. Age ~0 by construction. */
      respondedIn: HealthFact<number>;
      /** Last lease heartbeat, exposed under a TRUTHFUL name with its age. The underlying record
       *  field is called `since` and is documented as "held since", but it is re-stamped on every
       *  renew, so it is last-heartbeat and not an uptime. Consumers of THIS surface get the honest
       *  label even while the wire field keeps its misleading one. */
      lastHeartbeat: HealthFact<number>;
    }
  | { serving: false; refusal: HealthRefusal };

/** One-line operator rendering. Every branch names its condition and every fact shows its age, so
 *  no rendering of this type can read as "fine" when it is not. */
export function renderHealth(h: DeliveryHealth): string {
  if (h.serving)
    return `serving — daemon ${h.incarnation.value}, answered in ${h.respondedIn.value}ms, last heartbeat ${h.lastHeartbeat.ageMs}ms ago (source: ${h.lastHeartbeat.source})`;
  const r = h.refusal;
  switch (r.condition) {
    case "unreachable":
      return `CANNOT ESTABLISH HEALTH — unreachable: ${r.server} (${r.detail})`;
    case "no-lease":
      return `CANNOT ESTABLISH HEALTH — no-lease: shard ${r.shard} has no holder record (${r.detail})`;
    case "lease-stale":
      return `CANNOT ESTABLISH HEALTH — lease-stale: shard ${r.shard} heartbeat is ${r.lastHeartbeat.ageMs}ms old (${r.detail})`;
    case "no-responder":
      return `CANNOT ESTABLISH HEALTH — no-responder: shard ${r.shard} did not answer within ${r.deadlineMs}ms${
        r.lastHeartbeat ? `, though its lease heartbeat is only ${r.lastHeartbeat.ageMs}ms old` : ""
      } (${r.detail})`;
    case "refused":
      return `CANNOT ESTABLISH HEALTH — refused: ${r.read} (${r.detail})`;
  }
}

/** The lease record this module reads, structurally. Declared here rather than imported so the
 *  health surface states exactly which fields it depends on. */
interface LeaseRecord {
  holder: string;
  since: number;
  ready: boolean;
}

/** What {@link assessDeliveryHealth} needs from the world. Both halves are seams so the assessment
 *  logic can be driven against constructed states — including states no live daemon would produce.
 *
 *  `readLease` returns the record, or `undefined` for "no record"; it THROWS to signal a denied or
 *  impossible read, which becomes `refused` rather than being swallowed into an absence.
 *  `probe` performs the affirmative round-trip and resolves when the daemon answers; it rejects or
 *  never settles when it does not. */
export interface HealthProbes {
  readLease: () => Promise<LeaseRecord | undefined>;
  probe: (deadlineMs: number) => Promise<void>;
  now: () => number;
}

/** Assess delivery health for a shard. Order matters and encodes the design:
 *
 *  The lease is read FIRST but is never sufficient — it can only produce refusals or supply the
 *  age/identity facts that decorate an affirmative answer. The verdict itself always waits on the
 *  round-trip. That is what makes a wedged daemon fail here rather than pass: it holds a fresh
 *  lease and answers nothing. */
export async function assessDeliveryHealth(
  shard: number,
  ttlMs: number,
  deadlineMs: number,
  probes: HealthProbes,
): Promise<DeliveryHealth> {
  let lease: LeaseRecord | undefined;
  try {
    lease = await probes.readLease();
  } catch (e) {
    // A read that could not complete is a NAMED refusal. It is never `undefined`, because an
    // absence renders as "nothing to report here" and a denial is not an absence.
    return {
      serving: false,
      refusal: { condition: "refused", read: `delivery lease shard ${shard}`, detail: (e as Error).message },
    };
  }

  const seen = probes.now();
  if (!lease)
    return {
      serving: false,
      refusal: {
        condition: "no-lease",
        shard,
        detail: "no holder record — no daemon has claimed this shard, or a crashed holder's key expired",
      },
    };

  const heartbeat = fact(lease.since, "lease-kv", lease.since, seen);
  // `ageMs === null` FIRST, and it refuses. An age that could not be established must never reach
  // the `> ttlMs` comparison: the old clamp made a forward-skewed clock read as 0, which passes the
  // TTL gate and lets a lease of ANY age render as fresh. Narrowing is enforced by the type.
  //
  // PROVISIONAL ARM PLACEMENT, flagged rather than decided: a clock fault is not the same fact as
  // "the heartbeat is older than the TTL", and collapsing two conditions into one name is exactly
  // what this union is not supposed to do. It rides `lease-stale` only because a blocking review
  // finding against the union's closure is open and unruled, and inventing a sixth arm underneath
  // that review would pre-empt it. The `detail` therefore names the ACTUAL condition, so no reader
  // is told the wrong thing even while the arm is provisional.
  if (heartbeat.ageMs === null)
    return {
      serving: false,
      refusal: {
        condition: "lease-stale",
        shard,
        lastHeartbeat: heartbeat,
        detail:
          `CLOCK FAULT: the lease heartbeat is stamped ${heartbeat.clockSkewMs}ms in the FUTURE, so its ` +
          `age cannot be established and it cannot be shown to be within the ${ttlMs}ms TTL. ` +
          `Not treated as fresh: an age that could not be measured is a refusal, never a pass`,
      },
    };
  if (heartbeat.ageMs > ttlMs)
    return {
      serving: false,
      refusal: {
        condition: "lease-stale",
        shard,
        lastHeartbeat: heartbeat,
        detail: `heartbeat is older than the ${ttlMs}ms TTL that should have refreshed it`,
      },
    };

  // The affirmative half. Everything above is a record written in the past; only this establishes
  // that delivery is serving NOW. A timeout here is a refusal, never an inference of health.
  const started = probes.now();
  try {
    await probes.probe(deadlineMs);
  } catch (e) {
    return {
      serving: false,
      refusal: {
        condition: "no-responder",
        shard,
        deadlineMs,
        lastHeartbeat: heartbeat,
        detail: `the daemon did not answer within ${deadlineMs}ms though its lease claims ready:${lease.ready} — ${(e as Error).message}`,
      },
    };
  }
  const answered = probes.now();

  return {
    serving: true,
    incarnation: fact(lease.holder, "lease-kv", lease.since, answered),
    respondedIn: fact(answered - started, "responder-roundtrip", answered, answered),
    lastHeartbeat: fact(lease.since, "lease-kv", lease.since, answered),
  };
}
