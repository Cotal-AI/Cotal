/**
 * THE SOAK'S POSITIVE CONTROL, GRADED WITHOUT A RACE (#459).
 *
 * The control is the cell the other eleven depend on: it proves the survivor instrument can see a
 * live agent, so that "no agent processes survive" means something. It could pass or fail on
 * timing, which made every green behind it weaker evidence than it looked.
 *
 * The fix is a wait on a named event; this suite is what makes that wait provable. The live soak
 * cannot grade it — a race has no deterministic red through the real path, and reaching for one
 * would just be the flake in a different costume. So the probe is injected and the clock is fake,
 * and every branch is exercised on purpose.
 *
 * WHAT THIS DOES AND DOES NOT COVER, stated so it is not over-read. It grades `waitUntilVisible`
 * and the fact that the soak CALLS it. It does not spawn a herdr agent, does not exercise the
 * pane, and does not prove `ourProcs()` matches a real process — that is the live soak's job and
 * it needs a herdr binary. Cell 5 is a structural assertion for exactly that reason, and it is
 * explained where it sits.
 *
 * Run: pnpm smoke:herdr:probe
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { waitUntilVisible, visibilityDetail, soakNonce, agentTag, type VisibilityOutcome } from "./probe.js";
import { execFileSync, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";

let pass = 0, fail = 0;
const check = (name: string, cond: boolean, extra?: unknown) => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ FAIL: ${name}`, extra !== undefined ? JSON.stringify(extra) : ""); }
};

/** A fake clock. Time moves ONLY when the wait sleeps, so these cells are instant and identical on
 *  every machine — the whole point, given what is being fixed. */
function fakeClock(): { now: () => number; sleep: (ms: number) => Promise<void>; elapsed: () => number } {
  let t = 0;
  return { now: () => t, sleep: async (ms: number) => { t += ms; }, elapsed: () => t };
}

/** A probe that returns 0 for the first `n` calls and then 1 — the real shape: the payload does not
 *  exist yet, then it does. */
const visibleAfter = (n: number): (() => number) => {
  let calls = 0;
  return () => (++calls > n ? 1 : 0);
};

console.log("\n── herdr positive-control probe ────────────────\n");

// ---- 1. THE DEFECT: A SINGLE SAMPLE IS NOT AN ANSWER -----------------------------------------
// Measured against the real launcher, the payload was visible 0 times out of 6 at spawn-return and
// appeared 70-155ms later. So the case that matters is "not yet, then yes" — and the ONLY thing
// that distinguishes a wait from the old sample is that this case comes back `seen`.
console.log("1. a process that becomes visible LATE is still seen");
{
  const c = fakeClock();
  const out = await waitUntilVisible(visibleAfter(3), { deadlineMs: 5_000, intervalMs: 50, now: c.now, sleep: c.sleep });
  check("it is SEEN, not missed", out.kind === "seen", out);
  check("...on the try that actually saw it, not the first", out.kind === "seen" && out.tries === 4, out);
  check("...and it reports when, so a slow appearance is visible in the log rather than silent",
    out.kind === "seen" && out.elapsedMs === 150, out);
  // The old implementation, exactly: one sample. Stated as a cell so the regression has a name.
  const single = visibleAfter(3);
  check("...whereas a SINGLE sample at that instant reports absent — the defect, in one line",
    single() === 0);
}

// ---- 2. IT CANNOT PASS WHILE THE PAYLOAD IS ABSENT --------------------------------------------
// The first of the two directions required of this fix. A wait that gave up quietly, or returned
// something a caller could read as success, would be the widened window in a different costume.
console.log("\n2. an absent payload can NEVER be reported as seen");
{
  const c = fakeClock();
  const out = await waitUntilVisible(() => 0, { deadlineMs: 1_000, intervalMs: 100, now: c.now, sleep: c.sleep });
  check("the deadline is a FAILURE outcome, never a pass", out.kind === "deadline", out);
  check("...it sampled repeatedly rather than once", out.kind === "deadline" && out.tries > 1, out);
  check("...and it stops at the deadline instead of running forever", c.elapsed() <= 1_000 + 100, c.elapsed());
  check("...and says what it last measured, so the red carries its own evidence",
    out.kind === "deadline" && out.lastCount === 0, out);
}

// ---- 3. IT CANNOT FAIL WHILE THE PAYLOAD IS PRESENT -------------------------------------------
// The second required direction. A control that can redden with the agent right there is exactly
// the flake this replaces, so the already-visible case must be immediate and unconditional.
console.log("\n3. a present payload can NEVER be reported as absent");
{
  const c = fakeClock();
  const out = await waitUntilVisible(() => 2, { deadlineMs: 5_000, intervalMs: 50, now: c.now, sleep: c.sleep });
  check("it is seen on the FIRST sample", out.kind === "seen" && out.tries === 1, out);
  check("...with no wait at all", c.elapsed() === 0, c.elapsed());
  check("...and reports the count it actually saw", out.kind === "seen" && out.count === 2, out);
  // A zero deadline must still take one reading: a wait that can report on a measurement it never
  // took is the vacuous-green shape, and it would report `deadline` with the payload right there.
  const c0 = fakeClock();
  const out0 = await waitUntilVisible(() => 1, { deadlineMs: 0, intervalMs: 50, now: c0.now, sleep: c0.sleep });
  check("...even at a zero deadline, one sample is always taken", out0.kind === "seen", out0);
}

// ---- 4. "SAW NOTHING" AND "COULD NOT LOOK" ARE DIFFERENT FACTS --------------------------------
// A failing `ps` is not an absent process, and the repairs are unrelated. Collapsing them sends
// whoever reads the red at 3am hunting a process that was never actually looked for.
console.log("\n4. an instrument that cannot run says so, instead of reporting absence");
{
  const c = fakeClock();
  const out = await waitUntilVisible(() => { throw new Error("ps: command not found"); },
    { deadlineMs: 500, intervalMs: 100, now: c.now, sleep: c.sleep });
  check("it is UNAVAILABLE, not deadline", out.kind === "unavailable", out);
  check("...and carries the instrument's own error, which names the repair",
    out.kind === "unavailable" && /command not found/.test(out.error), out);
  check("...and the two reds do not read alike",
    /could not take a single reading/.test(visibilityDetail(out))
    && /never saw it/.test(visibilityDetail({ kind: "deadline", lastCount: 0, tries: 3, elapsedMs: 9 })));
  // A THROW THAT RECOVERS IS NOT AN UNAVAILABLE INSTRUMENT. Forking can fail transiently on a
  // loaded runner — the exact condition that produced this issue — so one bad reading must not
  // condemn the run. What decides `unavailable` is that NO attempt ever produced a reading.
  const c2 = fakeClock();
  let n = 0;
  const flaky = () => { if (++n <= 2) throw new Error("EAGAIN"); return 1; };
  const rec = await waitUntilVisible(flaky, { deadlineMs: 5_000, intervalMs: 10, now: c2.now, sleep: c2.sleep });
  check("...a transient failure that later reads successfully is SEEN, not condemned",
    rec.kind === "seen" && rec.tries === 3, rec);
}

// ---- 5. THE SOAK ACTUALLY CALLS IT ------------------------------------------------------------
// Cells 1-4 grade the function. NONE of them fails if the soak keeps its old inline sample and
// this file sits unused beside it — extracting the wait creates a seam, and an unasserted seam is
// how a fix ships without taking effect.
//
// This is a SOURCE assertion, which is a weaker instrument than a behavioural one, and it is used
// here only because the behavioural version is unavailable: importing soak.ts runs the soak, and
// the soak needs a herdr binary. It is written to fail on the thing that would actually go wrong —
// someone reinstating a bare sample — rather than on formatting.
console.log("\n5. the soak's control is wired to the wait (the seam, asserted)");
{
  const src = readFileSync(join(import.meta.dirname, "soak.ts"), "utf8");
  const control = src.slice(src.indexOf("positive control:"));
  check("soak.ts imports the wait", /import \{[^}]*waitUntilVisible[^}]*\} from "\.\/probe\.js"/.test(src));
  check("...and its positive control is decided BY the wait", /waitUntilVisible\(\s*ourProcs/.test(src));
  check("...and no longer decides that control on a bare sample",
    !/ok\(\s*"positive control[^)]*ourProcs\(\)\s*>=/.test(src));
  check("...and the control's evidence line is the outcome's, not a second measurement",
    control.length > 0 && /visibilityDetail\(control\)/.test(src));
  // The same double-measure defect the control had, on the negative direction: `ourProcs()` in a
  // detail string is a SECOND ps sweep at a later instant, so a red can report a count that is not
  // the count that failed — and during a race those two legitimately disagree.
  check("...and the survivor red reports the sample that decided it, not a fresh sweep",
    !/still running`\s*\)/.test(src) || /\$\{survivors\} still running/.test(src));
}

// ================================================================================================
// SECOND FINDING, INDEPENDENT OF THE FIRST: the nonce could match another run's payload.
// ================================================================================================
// Separate on purpose. Everything above is about WHEN the instrument looks; this is about WHAT it
// can see. They are the same instrument's correctness and they fail in the same run, but either
// could be right while the other is wrong, so they are judged apart.
//
// `12${process.pid % 1000}` gave 1000 values, and — sharper — variable width under an `includes`
// match. `pid % 1000 === 1` tags `sleep 121`; `pid % 1000 === 10` tags `sleep 1210`; the first is
// a substring of the second. Two-directional damage inside one run: a neighbour's live payload can
// pass this run's positive control, and a neighbour's surviving payload can fail its leak check.

console.log("\n6. the nonce cannot match another run's payload");
{
  const bits = () => randomBytes(8).readBigUInt64BE();
  const nonces = Array.from({ length: 200 }, () => soakNonce(bits));
  check("200 nonces are 200 distinct values",
    new Set(nonces).size === 200, { distinct: new Set(nonces).size });
  // The pid form is CONSTANT within a process, which is what made concurrent runs collide.
  const pidForm = Array.from({ length: 200 }, () => `12${process.pid % 1000}`);
  check("...whereas the pid-derived form yields exactly one value per process — the defect, named",
    new Set(pidForm).size === 1);
  // Fixed width is what kills the prefix case. Value-uniqueness alone would NOT: the old form had
  // 1000 distinct values and still let `sleep 121` match `sleep 1210`.
  const tags = nonces.map(agentTag);
  check("...every tag is the same length, so none can be a prefix of another",
    new Set(tags.map((t) => t.length)).size === 1, { widths: [...new Set(tags.map((t) => t.length))] });
  check("...and no tag is a substring of any other (the `includes` match is safe)",
    !tags.some((a, i) => tags.some((b, j) => i !== j && b.includes(a))));
  const oldA = agentTag(`12${1}`), oldB = agentTag(`12${10}`);
  check("...unlike the old form, where one run's tag matched another run's command line",
    oldB.includes(oldA), { oldA, oldB });
}

// ---- 7. AND THE NONCE IS STILL A PAYLOAD THAT ACTUALLY RUNS -----------------------------------
// A unique string that `sleep` REJECTS would be worse than the collision: the payload would exit
// instantly and the control would fail every time. This is the lesson from building the repro for
// this very issue — a non-numeric nonce made `sleep` exit with "invalid time interval", and the
// resulting clean 0-seen looked exactly like the finding being hunted. So prove the subject RAN
// rather than infer it from a count.
console.log("\n7. the nonce is a duration `sleep` accepts, proven by running it");
{
  const nonce = soakNonce(() => randomBytes(8).readBigUInt64BE());
  const child = spawn("sleep", [nonce], { stdio: "ignore", detached: true });
  child.unref();
  await new Promise((r) => setTimeout(r, 400));
  const alive = execFileSync("ps", ["-eo", "args="], { encoding: "utf8" })
    .split("\n").filter((l) => l.includes(agentTag(nonce))).length;
  check("the payload is alive 400ms later — the nonce was accepted, not rejected as a duration",
    alive >= 1, { alive, nonce, exited: child.exitCode });
  check("...and the FULL nonce survives onto argv, which is what the instrument matches",
    alive >= 1);
  try { process.kill(-child.pid!, "SIGKILL"); } catch { /* already gone */ }
  try { execFileSync("pkill", ["-f", agentTag(nonce)]); } catch { /* nothing left */ }
}

// ---- 8. THE SOAK USES IT (the second seam) ----------------------------------------------------
console.log("\n8. the soak's nonce comes from the shared definition, not a local pid expression");
{
  const src = readFileSync(join(import.meta.dirname, "soak.ts"), "utf8");
  check("soak.ts builds its nonce with soakNonce()", /SOAK_NONCE\s*=\s*soakNonce\(/.test(src));
  check("...and its tag with agentTag()", /AGENT_TAG\s*=\s*agentTag\(/.test(src));
  check("...and no longer derives either from process.pid",
    !/process\.pid\s*%/.test(src));
}

console.log(`\n${fail === 0 ? "PASS" : "FAIL"} — ${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);

// Keep the type import load-bearing: an outcome that loses a variant should not typecheck here.
export type { VisibilityOutcome };
