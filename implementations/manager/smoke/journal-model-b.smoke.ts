/**
 * The two Model-B behaviours the journal flip must remove, pinned at today's shape — and the one
 * mechanism it must NOT remove, pinned so that deleting it fails loudly.
 *
 * Same form as `journal-declaration.smoke.ts` and for the same mechanical reason: an expected-red
 * cell would make `mutation-proof` refuse this file's baseline (exit 4 on an already-red suite),
 * disabling mutation grading for every other cell in it. These pass today and die when the flip
 * lands.
 *
 * THESE ARE SOURCE-LEVEL CLAIMS, AND A SOURCE-LEVEL CLAIM IS ONLY AS WIDE AS THE TEXT IT READS.
 * The handler wiring and the boot sweep both live inside a class body with no exported seam, so
 * there is nothing to call and nothing to observe from outside. Reading the source is the honest
 * instrument here, and its limit is real: it sees `manager.ts` and nothing else, so a second wiring
 * of the same behaviour in another file would pass every cell below. The anchor cell exists so the
 * span is checked rather than assumed — if the text this file greps for stops existing, that is a
 * failure, not a silent pass over an empty string.
 *
 * Run: pnpm smoke:journal-model-b
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

let ok = 0, fail = 0;
const c = (label: string, cond: boolean, detail?: unknown): void => {
  if (cond) { ok++; console.log(`  ✓ ${label}`); }
  else { fail++; console.log(`  ✗ FAIL: ${label}`, detail ?? ""); }
};
const pending = (what: string): void => console.log(`  ⏳ PENDING (blocked on the A1/A2/A6 merges): ${what}`);

const SRC = join(dirname(fileURLToPath(import.meta.url)), "..", "src", "manager.ts");
const src = readFileSync(SRC, "utf8");
const count = (needle: string): number => src.split(needle).length - 1;

console.log("\n── the span this suite reads, asserted rather than assumed ──");
// Every cell below is a count over this text. A file that moved, or an anchor that was renamed,
// would make the counts trivially zero and several claims vacuously true.
c("manager.ts is readable and is the file carrying the serve wiring",
  src.length > 10_000 && count("private async reconcileGoalIndex") === 1 && count("serveSpawnGoal") > 0,
  { bytes: src.length });

console.log("\n── WRONG-TODAY (1/2): both action commands are served by the Model-B goal path ──");
// `serveSpawnGoal` is the Model-B chokepoint: goalId = request id, acceptance on the reply rail.
// J2 deletes it and routes both commands through the journal rail instead.
c("WRONG-TODAY: `spawn` is wired through serveSpawnGoal",
  count("spawn: (ctx) => this.serveGated(ctx, () => this.serveSpawnGoal(") === 1);
c("WRONG-TODAY: `launch` is wired through the SAME serveSpawnGoal chokepoint",
  count("launch: (ctx) => this.serveGated(ctx, () => this.serveSpawnGoal(") === 1);
// The count is the point: it pins TWO and only two. A third action command wired the same way
// later would be a third thing the flip has to move, and a per-name cell would not notice it.
c("WRONG-TODAY: EXACTLY two commands route through it — a third would be a third thing to move",
  count("this.serveSpawnGoal(") === 2, { sites: count("this.serveSpawnGoal(") });
c("WRONG-TODAY: the chokepoint itself still exists",
  count("private async serveSpawnGoal(") === 1);
pending("both commands accept through the journal rail (submission → decision fact → goal bind) and serveSpawnGoal is DELETED");

console.log("\n── WRONG-TODAY (2/2): the reconcile index is written and filtered by the Model-B accept path ──");
c("WRONG-TODAY: the manager's own serve path writes the goalidx row (`recordGoalIndex`)",
  count("await recordGoalIndex(") === 1);
c("WRONG-TODAY: the boot sweep skips goals via `goalAcceptances`, an IN-MEMORY map that same path fills",
  count("this.goalAcceptances.has(ref.goalId)") === 1 && count("this.goalAcceptances.set(") === 1);
pending("the CANONICALIZER writes goalidx create-only BEFORE the bind (step 4a), so the index no longer depends on a live manager's memory");

console.log("\n── THE MECHANISM THAT MUST LIVE — read this before deleting anything ──");
// SPEC:2239 REQUIRES a provisioner sweep over `goalidx`. J2 replaces the IMPLEMENTATION and never
// the MECHANISM. Three orphan classes exist that the effects durable structurally cannot see — the
// worst being a crash after `goalidx` and before the bind, where no decision message will ever
// exist, so the occupancy row leaks FOREVER if the sweep is gone.
// SCOPED TO THE SWEEP'S OWN BODY, not to the file. My first version of this cell asserted that
// `"provisioner"` appeared exactly once in `manager.ts`; it appears six times, all legitimate, and
// the cell failed on a claim that was simply false rather than on the property it names. Slicing
// the method body ties the credential to THIS sweep, which is what the assertion was always about.
const sweepStart = src.indexOf("private async reconcileGoalIndex");
const sweepBody = sweepStart < 0 ? "" : src.slice(sweepStart, src.indexOf("\n  private ", sweepStart + 1));
c("the sweep body was located and is non-trivial (so the cell below reads something)",
  sweepBody.length > 500, { bytes: sweepBody.length });
c("the boot sweep EXISTS and enumerates goalidx over a scoped provisioner credential — "
  + "SPEC:2239 REQUIRES this mechanism; J2 replaces its IMPLEMENTATION and never the mechanism itself. "
  + "IF THIS CELL IS FAILING BECAUSE YOU DELETED THE SWEEP, THAT IS THE BUG, NOT THIS CELL. "
  + "A crash after goalidx and before the bind produces no decision message ever, so the effects "
  + "durable cannot see it and the row leaks forever with no sweep.",
  sweepBody.includes("listGoalIndex(")
  && sweepBody.includes('mintCreds(this.auth, newIdentity(), "provisioner")'),
  { hasList: sweepBody.includes("listGoalIndex("), hasProvisioner: sweepBody.includes('"provisioner"') });

console.log(`\nJOURNAL MODEL-B SMOKE ${fail === 0 ? "OK ✅" : "FAILED ❌"}  (${ok} passed, ${fail} failed)`);
if (fail > 0) process.exitCode = 1;
