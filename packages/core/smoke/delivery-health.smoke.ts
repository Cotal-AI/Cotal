/**
 * delivery-health assessment smoke — the refusal grammar.
 *
 * Drives {@link assessDeliveryHealth} through every state the incident produced, with the lease and
 * the responder as independent seams so states a live daemon would never hold on purpose can be
 * constructed exactly: a fresh heartbeat beside a responder that answers nothing is the wedged
 * daemon, and it is the state this whole lane exists to catch.
 *
 * Every refusal is asserted as THAT refusal — equality on the named condition, never merely
 * "not serving" — and every one carries an INVERSE CONTROL: the same call with the single
 * responsible input flipped must produce a different, named outcome. A cell that only shows a
 * refusal happening cannot tell you the refusal was caused by what you think.
 *
 * This suite does NOT start a broker and does NOT prove anything about the real daemon; it proves
 * the verdict logic. The live construction (SIGKILL / SIGSTOP against an ephemeral broker) is the
 * companion smoke and is what makes D1/D2 measured rather than argued.
 *
 * Run: pnpm smoke:delivery-health   (no broker, no network)
 */
import { assessDeliveryHealth, renderHealth, type DeliveryHealth, type HealthProbes, type HealthRefusal } from "../src/health.js";

let pass = 0, fail = 0;
const check = (name: string, cond: boolean): void => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ FAIL: ${name}`); }
};

const TTL = 30_000;
const DEADLINE = 2_000;

/** A clock that advances only when told to, so age assertions are exact rather than timing-dependent. */
function clockAt(t: number): () => number {
  return () => t;
}

const answers: HealthProbes["probe"] = async () => { /* the daemon answered */ };
const neverAnswers: HealthProbes["probe"] = async (ms) => { throw new Error(`timeout after ${ms}ms`); };

const refusalOf = (h: DeliveryHealth): string => (h.serving ? "SERVING" : h.refusal.condition);

/** Narrow to an arm, returning `undefined` rather than gating a block.
 *
 *  Written this way deliberately. The first draft guarded its detail assertions with
 *  `if (!h.serving && h.refusal.condition === "…") { … }`, and two mutation runs showed those cells
 *  SILENTLY VANISHING instead of failing when the mutant changed the arm — 27 cells became 21
 *  passed and 3 failed, with 3 simply gone. A cell that disappears under mutation is a vacuous
 *  pass wearing the costume of a skip. Checks written against these helpers EVALUATE to false
 *  instead. */
const servingArm = (h: DeliveryHealth): Extract<DeliveryHealth, { serving: true }> | undefined =>
  h.serving ? h : undefined;
const refusalArm = <C extends HealthRefusal["condition"]>(
  h: DeliveryHealth,
  c: C,
): Extract<HealthRefusal, { condition: C }> | undefined =>
  !h.serving && h.refusal.condition === c ? (h.refusal as Extract<HealthRefusal, { condition: C }>) : undefined;

console.log("\ndelivery-health assessment\n");

// ---- serving: the affirmative path -------------------------------------------------------------
{
  const now = 1_000_000;
  const h = await assessDeliveryHealth(0, TTL, DEADLINE, {
    readLease: async () => ({ holder: "daemon-A", since: now - 4_000, ready: true }),
    probe: answers,
    now: clockAt(now),
  });
  check("a fresh lease AND a responder that answers is SERVING", h.serving === true);
  const s = servingArm(h);
  check("serving carries the daemon incarnation from the lease holder", s?.incarnation.value === "daemon-A");
  check("the heartbeat fact reports its real age (4000ms), not zero", s?.lastHeartbeat.ageMs === 4_000);
  check("the heartbeat fact names its source as lease-kv, not the round-trip", s?.lastHeartbeat.source === "lease-kv");
  check("the affirmative fact names its source as responder-roundtrip", s?.respondedIn.source === "responder-roundtrip");
  check("the affirmative fact's own age is 0 — the daemon answered just now", s?.respondedIn.ageMs === 0);
}

// ---- no-responder: THE INCIDENT. Fresh lease, nothing answers ----------------------------------
{
  const now = 1_000_000;
  const wedged: HealthProbes = {
    // A heartbeat 1s old: the renew timer is FIRING. This is the residue a wedged daemon leaves.
    readLease: async () => ({ holder: "daemon-A", since: now - 1_000, ready: true }),
    probe: neverAnswers,
    now: clockAt(now),
  };
  const h = await assessDeliveryHealth(0, TTL, DEADLINE, wedged);
  check("WEDGED: a ready, freshly-renewed lease with no responder REFUSES", h.serving === false);
  check("WEDGED: the refusal is named no-responder specifically", refusalOf(h) === "no-responder");
  const w = refusalArm(h, "no-responder");
  check("WEDGED: the refusal carries the deadline it waited", w?.deadlineMs === DEADLINE);
  check("WEDGED: the refusal still reports the fresh heartbeat (1000ms) — the two facts disagree, and that IS the finding",
    w?.lastHeartbeat?.ageMs === 1_000);
  check("WEDGED: the detail names that the lease claimed ready", w !== undefined && /ready:true/.test(w.detail));
  // INVERSE CONTROL: flip ONLY the responder. Same lease, same clock.
  const control = await assessDeliveryHealth(0, TTL, DEADLINE, { ...wedged, probe: answers });
  check("WEDGED inverse control: the identical lease WITH a responder is SERVING — the responder is what decided it",
    control.serving === true);
}

// ---- lease-stale: the heartbeat outlived its TTL -----------------------------------------------
{
  const now = 1_000_000;
  const stale: HealthProbes = {
    readLease: async () => ({ holder: "daemon-A", since: now - (TTL + 1), ready: true }),
    probe: answers, // a responder WOULD answer; staleness must be decided before that matters
    now: clockAt(now),
  };
  const h = await assessDeliveryHealth(0, TTL, DEADLINE, stale);
  check("STALE: a heartbeat older than the TTL REFUSES", h.serving === false);
  check("STALE: the refusal is named lease-stale specifically", refusalOf(h) === "lease-stale");
  check("STALE: the refusal carries the measured age, not just the fact of staleness",
    refusalArm(h, "lease-stale")?.lastHeartbeat.ageMs === TTL + 1);
  // INVERSE CONTROL: move the heartbeat one ms inside the TTL. Nothing else changes.
  const fresh = await assessDeliveryHealth(0, TTL, DEADLINE, {
    ...stale,
    readLease: async () => ({ holder: "daemon-A", since: now - TTL, ready: true }),
  });
  check("STALE inverse control: exactly at the TTL boundary it is SERVING — age is what decided it",
    fresh.serving === true);
}

// ---- no-lease: no holder record at all ---------------------------------------------------------
{
  const now = 1_000_000;
  const h = await assessDeliveryHealth(0, TTL, DEADLINE, {
    readLease: async () => undefined,
    probe: answers,
    now: clockAt(now),
  });
  check("NO-LEASE: an absent holder record REFUSES", h.serving === false);
  check("NO-LEASE: the refusal is named no-lease specifically", refusalOf(h) === "no-lease");
  // INVERSE CONTROL: supply a record, change nothing else.
  const withLease = await assessDeliveryHealth(0, TTL, DEADLINE, {
    readLease: async () => ({ holder: "daemon-A", since: now, ready: true }),
    probe: answers,
    now: clockAt(now),
  });
  check("NO-LEASE inverse control: the same call WITH a record is SERVING", withLease.serving === true);
}

// ---- refused: the read itself could not complete -----------------------------------------------
// The regression this cell exists for: a THROWN read used to become `undefined`, which renders
// identically to "not applicable here". A denial is not an absence.
{
  const now = 1_000_000;
  const h = await assessDeliveryHealth(0, TTL, DEADLINE, {
    readLease: async () => { throw new Error("no grant for the delivery bucket"); },
    probe: answers,
    now: clockAt(now),
  });
  check("REFUSED: a read that throws REFUSES", h.serving === false);
  check("REFUSED: the refusal is named refused specifically", refusalOf(h) === "refused");
  check("REFUSED: it is NOT the no-lease refusal — a denial must never render as an absence",
    refusalOf(h) !== "no-lease");
  const r = refusalArm(h, "refused");
  check("REFUSED: the refusal names which read failed and why",
    r !== undefined && /delivery lease shard 0/.test(r.read) && /no grant/.test(r.detail));
}

// ---- the type-level property: no verdict is ever undefined or a bare boolean -------------------
{
  const now = 1_000_000;
  const states: { label: string; probes: HealthProbes }[] = [
    { label: "serving", probes: { readLease: async () => ({ holder: "d", since: now, ready: true }), probe: answers, now: clockAt(now) } },
    { label: "no-responder", probes: { readLease: async () => ({ holder: "d", since: now, ready: true }), probe: neverAnswers, now: clockAt(now) } },
    { label: "lease-stale", probes: { readLease: async () => ({ holder: "d", since: 0, ready: true }), probe: answers, now: clockAt(now) } },
    { label: "no-lease", probes: { readLease: async () => undefined, probe: answers, now: clockAt(now) } },
    { label: "refused", probes: { readLease: async () => { throw new Error("denied"); }, probe: answers, now: clockAt(now) } },
  ];
  const verdicts = await Promise.all(states.map((s) => assessDeliveryHealth(0, TTL, DEADLINE, s.probes)));
  // `.every` over an empty set passes vacuously, so assert the set is populated FIRST.
  check("the state matrix is populated (guards the vacuous-every trap)", verdicts.length === 5);
  check("no verdict is undefined", verdicts.every((v) => v !== undefined));
  check("every rendering names its condition and none reads as a bare unknown",
    verdicts.every((v) => {
      const s = renderHealth(v);
      return s.length > 0 && !/unknown/i.test(s) && (v.serving ? s.startsWith("serving") : s.startsWith("CANNOT ESTABLISH HEALTH"));
    }));
  check("all five distinct conditions are actually reachable",
    new Set(verdicts.map(refusalOf)).size === 5);
}

console.log(`\nDELIVERY-HEALTH SMOKE ${fail === 0 ? "OK ✅" : "FAILED ❌"}  (${pass} passed, ${fail} failed)`);
if (fail) process.exitCode = 1;
