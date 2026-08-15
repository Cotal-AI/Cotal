/**
 * The delivery daemon's supervision guard. IT OBSERVES AND REPORTS. It never starts, stops, or
 * restarts anything.
 *
 * WHY IT EXISTS: the delivery daemon went down and nothing noticed for three hours. Messages were
 * accepted, senders were told they had been sent, and there were zero log entries for the affected
 * peers. Measured on this tree at `550e5acf`: `startDeliveryDetached`
 * (`implementations/cli/src/lib/delivery-proc.ts:98`) spawns with `detached: true` and calls
 * `child.unref()` (:122) — an explicit release, with no exit handler and no restart path — while the
 * manager registers an exit handler for every agent node it spawns (`runtime/pty.ts:90`,
 * `session/bridge.ts:108`). The daemon was the one child nobody watched.
 *
 * WHY REPORT-ONLY, and it is a ruling rather than a shortcut: a watchdog that can start processes is
 * a new failure mode with a new blast radius, and the daemon already fail-closes on "a live lease
 * already exists for shard N — another delivery daemon is running" (`delivery.ts:197`). A restarter
 * racing that check produces a double-launch. A watchdog that can only speak is bounded by
 * construction. Escalation can be added once something has been noticed and nobody acted.
 *
 * WHAT IT REFUSES TO BE BUILT ON: `deliveryUp()` / `deliveryLiveness()` / a pidfile / a lease inside
 * its TTL. Every one of those is satisfied by a SIGSTOPped daemon that answers nothing — measured
 * live against a real daemon, where the pid exists, the lease reads `ready: true`, the heartbeat is
 * inside the TTL, and only the round-trip catches it. A guard built on those would pass a wedged
 * daemon forever. Liveness here is always {@link assessDeliveryHealth}'s affirmative round-trip.
 *
 * THE PART THAT IS ABOUT THE GUARD ITSELF, and it is the whole reason this module is not just a
 * loop around `assessDeliveryHealth`: **a guard that only speaks when something is wrong is
 * indistinguishable from a guard that has died.** That is the incident one level up — silence read
 * as health. So every report carries the guard's OWN last-observation time and age, and a guard that
 * has not observed recently enough REFUSES BY NAME rather than reporting the last thing it happened
 * to see. A stale answer rendered as a current one is the exact defect this lane exists to catch.
 */
import { type DeliveryHealth, renderHealth } from "@cotal-ai/core";

/** One completed check. `observedAt` is the GUARD'S OWN clock at the moment the check completed —
 *  not a timestamp read out of any record — so the age derived from it is a same-clock duration and
 *  carries no foreign-clock skew. */
export interface GuardObservation {
  health: DeliveryHealth;
  observedAt: number;
}

/** What the guard is willing to say. There is no bare `unknown` and no boolean: a reader takes
 *  "unknown" for "fine", and a boolean cannot distinguish "the daemon is down" from "I cannot tell
 *  you whether the daemon is down". Those are different facts and an operator acts on them
 *  differently, so they are different shapes here. */
export type GuardReport =
  /** The guard has never completed a check. NOT healthy, NOT unknown — a named condition. This is
   *  the state a freshly-started guard is in, and the state a guard that has never worked stays in. */
  | { reporting: false; condition: "no-observation"; detail: string }
  /** A check completed, but too long ago to speak for the present. The last reading is carried so an
   *  operator can see WHAT it was and HOW OLD it is — but it is deliberately not presented as
   *  current, because rendering a stale answer as a current one is the defect this exists to catch. */
  | {
      reporting: false;
      condition: "guard-stale";
      last: GuardObservation;
      ageMs: number;
      maxAgeMs: number;
      detail: string;
    }
  /** The guard's own clock moved backwards relative to its last observation, so no duration between
   *  them is meaningful.
   *
   *  Its own condition, and NOT clamped to zero. That clamp is not hypothetical: this lane already
   *  shipped `Math.max(0, observedAt - evidenceAt)` in `health.ts`, which reported `ageMs: 0` — the
   *  value a live round-trip produces — for arbitrarily stale evidence, defeating the staleness gate
   *  outright. Refusing to compute an age is honest; computing a wrong one that happens to look
   *  fresh is the failure. */
  | { reporting: false; condition: "guard-clock-fault"; last: GuardObservation; skewMs: number; detail: string }
  /** A reading current enough to speak for now. `health` still carries its own verdict: a CURRENT
   *  reading of a DEAD daemon is a current reading, and it reports `serving: false` with a named
   *  refusal. `reporting: true` means "this is what I see right now", never "everything is fine". */
  | { reporting: true; health: DeliveryHealth; observedAt: number; ageMs: number };

/** Decide what the guard may honestly say, given its last observation and the present moment.
 *
 *  Pure, and every input is a parameter: the whole point is that this can be driven against states
 *  no live system would sit still for — a guard that never ran, a guard whose last look is hours
 *  old, a clock that went backwards — without a broker, a daemon, or a timer. */
export function guardReport(
  last: GuardObservation | undefined,
  now: number,
  maxAgeMs: number,
): GuardReport {
  if (!last)
    return {
      reporting: false,
      condition: "no-observation",
      detail:
        "the guard has not completed a single check — this is not a statement about the daemon, and must never be read as one",
    };

  const ageMs = now - last.observedAt;
  if (ageMs < 0)
    return {
      reporting: false,
      condition: "guard-clock-fault",
      last,
      skewMs: -ageMs,
      detail: `the last observation is stamped ${-ageMs}ms in the future of the current clock, so its age cannot be established`,
    };

  if (ageMs > maxAgeMs)
    return {
      reporting: false,
      condition: "guard-stale",
      last,
      ageMs,
      maxAgeMs,
      detail: `the guard's last check completed ${ageMs}ms ago, beyond its ${maxAgeMs}ms freshness bound — the guard itself may not be running`,
    };

  return { reporting: true, health: last.health, observedAt: last.observedAt, ageMs };
}

/** Render an age for an operator, with the same discipline as the health surface: an age that could
 *  not be established SAYS so rather than interpolating. Kept local rather than imported because
 *  `health.ts` keeps its copy module-private; duplicating four tokens is cheaper than widening that
 *  module's surface for a helper. */
const renderAge = (a: number | null): string => (a === null ? "an age that could not be established" : `${a}ms`);

/** One-line operator rendering. EVERY branch either names the condition that failed or states the
 *  age of what it is reporting. No branch can read as "fine" when health was not established, and
 *  no branch renders a stale reading as a current one. */
export function renderGuard(r: GuardReport): string {
  if (r.reporting) return `[observed ${renderAge(r.ageMs)} ago] ${renderHealth(r.health)}`;
  switch (r.condition) {
    case "no-observation":
      return `DELIVERY HEALTH NOT ESTABLISHED — no-observation: ${r.detail}`;
    case "guard-stale":
      return (
        `DELIVERY HEALTH NOT ESTABLISHED — guard-stale: last check completed ${renderAge(r.ageMs)} ago, ` +
        `beyond the ${r.maxAgeMs}ms bound. The reading it held is NOT current and is shown only for context: ` +
        `${renderHealth(r.last.health)}`
      );
    case "guard-clock-fault":
      return (
        `DELIVERY HEALTH NOT ESTABLISHED — guard-clock-fault: the last observation is stamped ${r.skewMs}ms ` +
        `after the current clock, so its age cannot be established (${r.detail})`
      );
  }
}

/** What the guard needs from the world to take one observation. Both are seams so the guard can be
 *  driven against constructed states, and so the check itself is whatever the caller wires in —
 *  which must be an affirmative round-trip, never a pid or a lease read. */
export interface GuardSeams {
  check: () => Promise<DeliveryHealth>;
  now: () => number;
}

/** Take exactly one observation.
 *
 *  A check that THROWS still produces an observation — a `refused` one — rather than leaving the
 *  guard with no record of having looked. The distinction matters: "I looked and could not complete
 *  the read" and "I never looked" are different facts, and collapsing the first into the second
 *  would let a guard whose every check is erroring look identical to one that has just started.
 *  `observedAt` is stamped AFTER the check resolves, so the age is measured from when the answer was
 *  actually in hand and never from when the attempt began. */
export async function observeOnce(seams: GuardSeams): Promise<GuardObservation> {
  let health: DeliveryHealth;
  try {
    health = await seams.check();
  } catch (e) {
    health = {
      serving: false,
      refusal: {
        condition: "refused",
        read: "delivery health check",
        detail: (e as Error).message,
      },
    };
  }
  return { health, observedAt: seams.now() };
}
