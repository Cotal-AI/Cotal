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
import { assessDeliveryHealth, fact, renderHealth, type DeliveryHealth, type HealthProbes, type HealthRefusal } from "../src/health.js";

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
  // NAMED, not counted. This previously asserted `new Set(…).size === 5` and called it "all five
  // distinct conditions are actually reachable" — but the set it measured was
  // {SERVING, no-responder, lease-stale, no-lease, refused}: it COUNTED `SERVING`, which is not a
  // refusal condition at all, and never constructed `unreachable`. A size check cannot notice that
  // it is counting the wrong five. Assert the names, and state plainly which arm is unconstructed.
  const seen = new Set(verdicts.map(refusalOf));
  check("the four constructed refusal conditions are each reachable BY NAME",
    ["no-responder", "lease-stale", "no-lease", "refused"].every((c) => seen.has(c)));
  check("and the serving arm is reachable, counted separately from the refusals", seen.has("SERVING"));
  // NOT MEASURED — `unreachable`. No seam in this suite produces a broker dial failure, so that arm
  // has no producer and is not exercised here.
  //
  // This used to be a `check(!seen.has("unreachable"))` and that was wrong: it added a PASSING cell
  // for proving a declared refusal has no producer. It would have stayed green forever while the arm
  // stayed dead, and gone RED on the day someone finally implemented it — a known coverage gap
  // wearing a checkmark, and a green whose meaning inverts. Documentation belongs in a comment; only
  // desired behaviour belongs in a cell. Closing it needs a real wrapper that constructs
  // `unreachable` from an actual broker-dial failure — a hand-built fixture would test the renderer,
  // not reachability.
  console.log("  · NOT MEASURED: `unreachable` has no producer in this suite (documented, not asserted)");
}

// ---- CLOCK SKEW: the age that could not be established. C1-C5, predicted in .lane/clamp-predictions.md
// ---- BEFORE the fix. `evidenceAt` is a FOREIGN clock, so it can run ahead of ours.
{
  const now = 1_000_000;
  const SKEW = 5_000;
  // A lease whose writer stamped it 5s in the FUTURE relative to our observation.
  const skewed: HealthProbes = {
    readLease: async () => ({ holder: "d", since: now + SKEW, ready: true }),
    probe: answers,
    now: clockAt(now),
  };
  const h = await assessDeliveryHealth(0, TTL, DEADLINE, skewed);
  const arm = refusalArm(h, "clock-fault");

  // ---- FACT LEVEL: what `fact()` builds from two disagreeing clocks. Driven directly, because the
  // ---- clock-fault refusal carries a skew rather than a HealthFact, so these are not reachable
  // ---- through the verdict and would otherwise go untested.
  const skewedFact = fact(123, "lease-kv", now + SKEW, now);
  // C1 — the whole point: the old clamp reported 0 here, and 0 is what a live round-trip produces.
  //
  // The FIRST version of this cell used `arm?.…` and the mutation run caught it PASSING under the
  // restored clamp: the arm was absent, and `undefined !== 0` is true, so it passed VACUOUSLY on the
  // exact input it was written to catch. `?.` on an absent arm fails safe for a crash and fails OPEN
  // for a claim. Driving `fact()` directly removes the optional entirely.
  check("CLOCK-SKEW: evidence stamped in the future does not render as age 0", skewedFact.ageMs !== 0);
  // C2 — it must say the age could not be established, not pick a number.
  check("CLOCK-SKEW: the fact reports that its age could not be established", skewedFact.ageMs === null);
  // C3 — carry HOW FAR ahead, so the reader can act on it.
  check("CLOCK-SKEW: the fact carries the measured skew, so a reader can see how far ahead",
    skewedFact.clockSkewMs === SKEW);

  // ---- VERDICT LEVEL ----
  // C4 — the half that matters: it must not sail through the TTL gate.
  check("CLOCK-SKEW: a lease whose writer clock is ahead REFUSES rather than passing the TTL gate",
    h.serving === false);
  // The condition itself must be TRUE, not merely a refusal with a truthful detail attached. This
  // previously read `clock-fault` under a `lease-stale` discriminator: the detail told the truth
  // while the machine-readable condition lied, and every consumer switching on `condition` got the
  // lie. `lease-stale` asserts the age is KNOWN to exceed the TTL; this asserts age is NOT KNOWABLE.
  check("CLOCK-SKEW: the machine-readable condition is clock-fault, NOT lease-stale",
    refusalOf(h) === "clock-fault");
  check("CLOCK-SKEW: the refusal carries the measured skew on the arm itself", arm?.skewMs === SKEW);
  check("CLOCK-SKEW: and its detail names the direction of the fault",
    /FUTURE/.test(arm?.detail ?? "") && /age/.test(arm?.detail ?? ""));

  // ---- RENDER LEVEL: the cell whose absence let 35/35 pass over broken operator output ----
  // `ageMs: number | null` does NOT force a consumer to narrow — TypeScript interpolates `null` into
  // a template string silently, and `renderHealth` did exactly that, printing "heartbeat is nullms
  // old" to an operator while every assertion above it passed. A type that permits the unsafe
  // spelling is not a guard. Assert on what the operator actually SEES.
  const rendered = renderHealth(h);
  check("CLOCK-SKEW RENDER: the operator line contains no raw null", !/null/i.test(rendered));
  check("CLOCK-SKEW RENDER: it names clock-fault and refuses",
    /clock-fault/.test(rendered) && rendered.startsWith("CANNOT ESTABLISH HEALTH"));

  // C5 — INVERSE CONTROL. Same lease, sane clock. If this also refused, the arms could not differ
  // and C4 would prove nothing. This is the cell that makes the block meaningful.
  const sane: HealthProbes = {
    readLease: async () => ({ holder: "d", since: now, ready: true }),
    probe: answers,
    now: clockAt(now),
  };
  const ok = await assessDeliveryHealth(0, TTL, DEADLINE, sane);
  check("CLOCK-SKEW inverse control: the same lease with a sane clock is SERVING — the skew is what decided it",
    ok.serving === true);
}

console.log(`\nDELIVERY-HEALTH SMOKE ${fail === 0 ? "OK ✅" : "FAILED ❌"}  (${pass} passed, ${fail} failed)`);
if (fail) process.exitCode = 1;
