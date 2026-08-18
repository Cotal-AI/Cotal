/**
 * The dry run: does the plan describe the run that would actually happen?
 *
 * The failure mode a dry run has to be tested against is not "the report is wrong", it is "the
 * report is plausible". A reporter that reads the source separately from the interpreter drifts
 * quietly, and every individual line of its output still looks right. So the central test here
 * (section 4) does not check the report against a hand-written expectation. It runs the SAME
 * program for real and checks the plan against the run: same effects, same order, same keys.
 *
 * The second thing worth stating: a dry run of a program whose script does not cover it must FAIL,
 * not report a shorter plan. A report that quietly describes half a program is worse than no report,
 * because it is the half that ran.
 */
import { dryRun, renderReport } from "../src/dryrun.js";
import { run } from "../src/interpret.js";
import { SimHandler } from "../src/sim.js";

let pass = 0;
const ok = (name: string, cond: boolean, extra?: unknown) => {
  if (!cond) throw new Error(`FAIL: ${name}${extra !== undefined ? ` - ${JSON.stringify(extra)}` : ""}`);
  pass++;
  console.log(`  ok ${name}`);
};

const PROGRAM = `
const team = channel("feat-auth");
const planner = await spawn("planner", { worktree: "wt-1", join: [team],
                                         permits: { turns: 40, spend: "5usd" } });
const builder = await spawn("builder", { worktree: "wt-1", join: [team], role: "impl" });

await turn(planner, { name: "draft-plan" });

const approval = await checkpoint("approve-plan", "Approve the plan?",
                                  { timeout: "10m", onExpiry: "proceed" });
if (approval.status === "resolved") {
  await turn(builder, { name: "build" });
}
await sleep("2h", { name: "cool-off" });
`;

const SCRIPT = {
  turns: { "draft-plan": { status: "done", at: 0 }, build: { status: "done", at: 0 } },
  checkpoints: { "approve-plan": { status: "resolved", value: true, by: "sim" } },
} as const;

/**
 * What PROGRAM does under SCRIPT: spawn, spawn, turn, checkpoint, turn, sleep. Four kinds.
 *
 * Stated here rather than inline because two sections below compare one derived list against
 * another, and a comparison between two lists that shrink together is true when both are empty. The
 * number is what stops those comparisons from passing over a run that did nothing.
 */
const EFFECTS = 6;
const KINDS = 4;

// ---- 1) the report answers the questions a dry run exists to answer -----------------------------

const realStart = Date.now();
const report = await dryRun(PROGRAM, SCRIPT);
const realMs = Date.now() - realStart;

{
  ok("it lists the agents that would be spawned", report.agents.length === 2, report.agents.map((a) => a.persona));
  const planner = report.agents.find((a) => a.persona === "planner");
  ok("with the permits they would hold", JSON.stringify(planner?.permits) === '{"turns":40,"spend":"5usd"}', planner?.permits);
  ok("and the worktree they would bind", planner?.worktree === "wt-1", planner?.worktree);
  ok("and the channels they would join", JSON.stringify(planner?.joins) === '["feat-auth"]', planner?.joins);

  // The point of the feature: a run that stops for a person at 3am is a fact worth having first.
  ok("it lists the checkpoints a person would face", report.checkpoints.length === 1, report.checkpoints);
  const cp = report.checkpoints[0];
  ok("with the prompt they would be shown", cp?.prompt === "Approve the plan?", cp?.prompt);
  ok("and what happens if nobody answers", cp?.timeout === "10m" && cp?.onExpiry === "proceed", cp);
}

// ---- 2) simulated time is reported, not silently skipped ----------------------------------------

{
  // Instant sleeps are the point of simulation, but the elapsed time must still be REPORTED, or a
  // program that waits two hours reads as free. 2h sleep plus turns at the 5m default.
  ok("a two hour sleep costs two hours of simulated time", report.elapsedMs >= 7_200_000, report.elapsedMs);
  // This asserted the literal `true` and measured nothing. Wall time is the claim, so take it.
  ok("and the whole run took under a second of REAL time", realMs < 1_000, realMs);
  ok("the rendered report states the duration in human units", renderReport(report).includes("2.2h of simulated time"), renderReport(report).split("\n")[0]);
}

// ---- 3) an unscripted effect fails the dry run rather than shortening the plan -------------------

{
  let caught: unknown;
  try {
    // The checkpoint is scripted; the second turn is not.
    await dryRun(PROGRAM, { turns: { "draft-plan": { status: "done", at: 0 } }, checkpoints: SCRIPT.checkpoints });
  } catch (e) {
    caught = e;
  }
  // Asserted on the REASON, not the class: the interpreter wraps a handler fault into an
  // EffectError on its way out of performEffect, so `instanceof SimUnscriptedError` fails here even
  // though the simulator raised exactly that. The code is what survives the seam and what a caller
  // can act on.
  ok("an unscripted effect throws", (caught as { code?: string })?.code === "L6001", String(caught).slice(0, 80));
  // A report that stopped early and said so is useful. One that quietly described half a program
  // would be worse than no report, because the half it described is the half that already ran.
  ok("it does NOT return a shorter plan", caught !== undefined);
}

// ---- 4) the plan is the run: checked against a real execution, not against an expectation --------

/**
 * This is the test that matters. Everything above could pass while the reporter drifts from the
 * interpreter, because every line of a drifted report still looks plausible. So run the same
 * program for real and compare the plan to what happened, key by key.
 */
{
  const real = await run(PROGRAM, { runId: "dry-run", handler: new SimHandler(SCRIPT) });
  const realKeys = real.journal
    .entries()
    .map((e) => `${e.scope}/${e.kind}${e.name === "" ? "" : `:${e.name}`}#${e.occurrence}`);
  const planKeys = report.effects.map((e) => e.step);

  // The floor and the two comparisons below catch DIFFERENT failures, and neither replaces the
  // other. Empty `report.effects` alone and the comparisons go red at `{plan: 0, real: 6}` while the
  // floor passes: that is reporter drift, the failure named at the top of this section, and the
  // comparisons are the right instrument for it. Stop the run journalling and BOTH sides fall to
  // zero together — `0 === 0` and `"[]" === "[]"` are true, and the comparisons see nothing at all.
  // That second one is the floor's, and `report.agents` / `report.checkpoints` do not cover it: they
  // are pinned above but built from the recorder's own arrays rather than from the journal.
  const realKinds = new Set(real.journal.entries().map((e) => e.kind));
  ok(
    "the real run journalled every effect the program has, across all of its kinds",
    realKeys.length === EFFECTS && realKinds.size === KINDS,
    { keys: realKeys, kinds: [...realKinds] },
  );

  ok("the plan has an entry for every effect the real run performed", planKeys.length === realKeys.length, {
    plan: planKeys.length,
    real: realKeys.length,
  });
  ok("in the same order, with the same journal keys", JSON.stringify(planKeys) === JSON.stringify(realKeys), {
    plan: planKeys,
    real: realKeys,
  });
  ok("and the same step count", report.steps === real.steps, { plan: report.steps, real: real.steps });
}

// ---- 5) a branch not taken is not in the plan ----------------------------------------------------

{
  // The plan is what WOULD run under this script, not every path in the program. Change the
  // checkpoint answer and the build must disappear, or the report is describing the source rather
  // than the run.
  const declined = await dryRun(PROGRAM, {
    turns: SCRIPT.turns,
    // NOT `{ status: "resolved", value: false }`, which is what this test said first: the program
    // branches on `status`, so a declining ANSWER still takes the branch. The setup has to produce
    // the condition the assertion is about, or the assertion grades a run that never happened.
    checkpoints: { "approve-plan": { status: "expired", by: "sim" } },
  });
  const names = declined.effects.map((e) => e.name);
  ok("a branch the script does not take is absent from the plan", !names.includes("build"), names);
  ok("and the taken branch is still there", names.includes("draft-plan"), names);
  // Which is exactly what makes the unused-script line load-bearing rather than decorative.
  ok("the unreached script entry is reported, not hidden", declined.unusedScript.includes("turns.build"), declined.unusedScript);
  ok("and the rendered report surfaces it", renderReport(declined).includes("never reached"), true);
}

// ---- 6) the recorder is a wrapper, so it works over a handler that is not the simulator ----------

{
  // The report is built by wrapping whatever handler is in use, not by teaching the simulator to
  // describe itself. That is what makes "the run I dry-ran is the run I got" checkable later
  // against the production handler rather than promised now. Prove the seam is real: the recorder
  // must not require a SimHandler.
  const { RecordingHandler } = await import("../src/dryrun.js");
  const inner = new SimHandler(SCRIPT);
  const rec = new RecordingHandler(inner);
  ok("the recorder delegates the clock rather than owning one", rec.now() === inner.now());
  const r = await run(PROGRAM, { runId: "dry-run", handler: rec });
  // Same identity, same reason, and floored here rather than left to section 4: a floor one section
  // away is an ordering someone can change, and a comment saying so is a claim rather than a term.
  ok("a run through the recorder behaves identically",
    r.journal.entries().length === report.effects.length && report.effects.length === EFFECTS, {
    through: r.journal.entries().length,
    plan: report.effects.length,
  });
  ok("and the recorder captured the spawns", rec.spawns.length === 2, rec.spawns.length);
}

console.log(`dryrun.smoke: ${pass} checks passed`);
