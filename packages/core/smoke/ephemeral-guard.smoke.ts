/**
 * THE AMBIENT-BROKER GUARD ITSELF — the module that stands between every smoke on this box and the
 * production broker, and which until now had NO cells of its own.
 *
 * WHY IT EXISTS. `_ephemeral-only.ts` was imported by four suites and tested by none. It is the one
 * piece of code whose failure mode is "a smoke provisions credentials, revokes rows and evicts
 * connections against the live mesh", and its correctness rested entirely on reading it. That is
 * the same posture as a security property asserted in a comment: true when written, unfalsifiable
 * afterwards.
 *
 * WHAT ORDERED IT. `smoke:ci` had FOUR implementations of one ambient-broker policy — this shared
 * module (two functions), a hand-rolled scrub loop in `retire-reply-bind`, and a hand-rolled
 * denylist in `gate-reconcile-auth` that REFUSED rather than scrubbing. The fourth stopped the gate
 * dead in the environment every mesh-connected agent inherits. Consolidating them exposed that two
 * environment keys (`NATS_URL`, `COTAL_BROKER`) and one whole detection mechanism (the value scan)
 * existed ONLY in the hand-rolled copies, so the tidy-up would have narrowed coverage while every
 * suite stayed green.
 *
 * THE PROPERTY E7/E8 EXIST TO HOLD, and it is the reason this file is not one combined cell:
 * **the scrub and the assert are not interchangeable and neither can cover for the other.**
 *   - `scrubAmbientBrokerEnv()` removes inherited coordinates from this process and every CHILD.
 *     It cannot judge a URL a caller passes explicitly.
 *   - `assertEphemeralBroker(url)` judges a URL it is handed. **It never reads the environment**,
 *     so it is structurally blind to what a child process inherits.
 * A single cell exercising both would pass with either one deleted. E7 dies only without the scrub;
 * E8 dies only without the assert.
 *
 * Run: pnpm smoke:ephemeral-guard   (hermetic — no broker, no network)
 */
import { execFileSync } from "node:child_process";
import {
  assertEphemeralBroker,
  assertNoLiveBrokerInEnv,
  scrubAmbientBrokerEnv,
} from "./_ephemeral-only.js";

let pass = 0, fail = 0;
const check = (name: string, cond: boolean, extra?: unknown) => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ FAIL: ${name}`, extra ?? ""); }
};

/**
 * Assert a call throws, and say WHAT it threw when it does not.
 *
 * A refusal cell must assert the refusal happened for the reason claimed: `assertEphemeralBroker`
 * has three distinct throw paths (live host, non-loopback, fail-closed-on-empty) and a cell that
 * only checks "it threw" passes when the wrong guard fires. `needle` pins which one.
 */
const throws = (name: string, fn: () => void, needle: string) => {
  try {
    fn();
    check(name, false, "did NOT throw");
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    check(name, msg.includes(needle), { expected: needle, got: msg });
  }
};

const LIVE = "nats://broker.cotal.ai:4222";

console.log("E1 — the scrub removes every ambient key AND reports what it cleared");
{
  const KEYS = ["COTAL_SERVERS", "COTAL_SERVER", "COTAL_CREDS", "COTAL_SPACE", "NATS_URL", "COTAL_BROKER"];
  for (const k of KEYS) process.env[k] = LIVE;
  const cleared = scrubAmbientBrokerEnv();
  check("E1: all six ambient keys are gone from the environment",
    KEYS.every((k) => process.env[k] === undefined), KEYS.filter((k) => process.env[k] !== undefined));
  // The RETURN VALUE is load-bearing: callers log it so an operator learns their environment was
  // changed under them. A scrub that cleared silently would be indistinguishable from one that ran
  // too late, which is exactly the case E7 exists to catch.
  check("E1: ...and the scrub REPORTS all six, rather than clearing silently",
    KEYS.every((k) => cleared.includes(k)) && cleared.length === KEYS.length, cleared);
  // NATS_URL and COTAL_BROKER named explicitly: they existed only in a hand-rolled denylist before
  // the consolidation, and this is the cell that would have caught their loss.
  check("E1: NATS_URL and COTAL_BROKER are covered (they were nearly dropped in consolidation)",
    cleared.includes("NATS_URL") && cleared.includes("COTAL_BROKER"), cleared);
}

console.log("E2/E3/E4/E5 — the assert refuses, and each cell pins WHICH refusal");
throws("E2: the live broker host is refused by name", () => assertEphemeralBroker(LIVE), "LIVE broker");
// DNS is case-insensitive and a trailing root dot resolves identically, so both forms reach the same
// host. Without these the denylist is an exact-string match wearing a hostname check.
throws("E3: an UPPERCASE live host is refused (DNS is case-insensitive)",
  () => assertEphemeralBroker("nats://BROKER.COTAL.AI:4222"), "LIVE broker");
throws("E3: the FQDN trailing-dot form is refused (broker.cotal.ai. is the same host)",
  () => assertEphemeralBroker("nats://broker.cotal.ai.:4222"), "LIVE broker");
throws("E4: a non-loopback host NOT on the denylist is still refused",
  () => assertEphemeralBroker("nats://10.0.0.7:4222"), "not a loopback");
// FAIL CLOSED. `process.env.COTAL_SERVERS ?? ""` produces exactly this value once the scrub has run,
// so an empty target is the shape a caller reaches for by accident, not a rare one.
throws("E5: an EMPTY target fails closed rather than vacuously allowing",
  () => assertEphemeralBroker(""), "no broker target");
throws("E5: a whitespace-only target fails closed too",
  () => assertEphemeralBroker("   "), "no broker target");

console.log("E6 — the POSITIVE CONTROL, without which every refusal above is vacuous");
{
  // An assert that threw on everything would pass E2-E5 and be useless. This is the cell that says
  // the function can say yes.
  for (const ok of ["nats://127.0.0.1:4222", "nats://localhost:4222", "nats://[::1]:4222"]) {
    let threw: unknown;
    try { assertEphemeralBroker(ok); } catch (e) { threw = e; }
    check(`E6-CONTROL: ${ok} is ACCEPTED`, threw === undefined, threw);
  }
}

console.log("E7 — THE ORDERING DISCRIMINATOR: the scrub protects a CHILD process");
{
  // THE HAZARD IS A CHILD, NOT THIS PROCESS. A spawned `cotal` binary resolves its target from the
  // environment it inherits, so asserting on `process.env` in-process would still pass if the scrub
  // ran after the first spawn. This measures what a child actually receives.
  //
  // `assertEphemeralBroker` CANNOT make this cell pass: it never reads the environment. So E7 is
  // red if and only if the scrub is gone.
  process.env.COTAL_SERVERS = LIVE;
  process.env.NATS_URL = LIVE;
  scrubAmbientBrokerEnv();
  const seen = execFileSync(
    process.execPath,
    ["-e", "process.stdout.write(JSON.stringify({s:process.env.COTAL_SERVERS??null,n:process.env.NATS_URL??null}))"],
    { encoding: "utf8" },
  );
  const child = JSON.parse(seen) as { s: string | null; n: string | null };
  check("E7: a child process inherits NO live coordinates after the scrub",
    child.s === null && child.n === null, child);

  // POSITIVE CONTROL FOR E7. Without it, `child.s === null` is also what you get from a child that
  // never reads its environment, a spawn that failed, or a JSON shape that changed — the cell would
  // be asserting over nothing. This proves the channel carries a value when one is there.
  process.env.COTAL_SERVERS = "nats://127.0.0.1:4222";
  const ctl = JSON.parse(execFileSync(
    process.execPath,
    ["-e", "process.stdout.write(JSON.stringify({s:process.env.COTAL_SERVERS??null}))"],
    { encoding: "utf8" },
  )) as { s: string | null };
  check("E7-CONTROL: the same child DOES see COTAL_SERVERS when it is set (so E7 measures something)",
    ctl.s === "nats://127.0.0.1:4222", ctl);
  scrubAmbientBrokerEnv();
}

console.log("E8 — the MIRROR: the assert catches an explicit live URL the scrub cannot see");
{
  // The scrub cannot make this cell pass: the URL is passed as an argument and was never in the
  // environment. So E8 is red if and only if the assert is gone. E7 and E8 together are what make
  // "scrub THEN assert" a tested ordering rather than a convention.
  let threw: unknown;
  try { assertEphemeralBroker(LIVE); } catch (e) { threw = e; }
  check("E8: a live URL passed explicitly still throws, with a clean environment",
    threw instanceof Error && threw.message.includes("LIVE broker"), threw);
}

console.log("E9 — the value scan catches a variable no key list knows about");
{
  // The mechanism carried by exactly one hand-rolled line before consolidation. A key list only
  // deletes names somebody thought of; this is the arm that survives a client adding a new one.
  process.env.SOME_UNRELATED_TOOL_URL = LIVE;
  let threw: unknown;
  try { assertNoLiveBrokerInEnv(); } catch (e) { threw = e; }
  check("E9: an UNKNOWN env var naming the live broker is refused by the value scan",
    threw instanceof Error && threw.message.includes("LIVE broker"), threw);
  delete process.env.SOME_UNRELATED_TOOL_URL;

  // POSITIVE CONTROL: it must not refuse a clean environment, or every suite calling it is dead.
  let clean: unknown;
  try { assertNoLiveBrokerInEnv(); } catch (e) { clean = e; }
  check("E9-CONTROL: a clean environment passes the value scan", clean === undefined, clean);
}

console.log(`\nephemeral-guard: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
