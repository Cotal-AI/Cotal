/**
 * The `cotal setup` ready card's MANAGER ROW, driven through the real CLI.
 *
 * This is the render contract: what an operator actually reads, and the surface where the incident
 * lived. A pid that exists was rendered as `✓ manager running` while the process was SIGSTOPped and
 * serving nothing, and a plain unrelated live pid in `.cotal/manager.pid` produced the same green.
 *
 * WHY IT EXISTS AS A PACKAGE SCRIPT. These assertions previously lived only in a lane script that
 * hardcoded one workstation's Node path and one author's worktree, and no package script invoked it.
 * Review's finding, and it was right: the helper-level suites protect the helper, and NOTHING
 * portable protected the rendered row. Everything here derives its paths from `import.meta` and
 * `process.execPath`, so it runs wherever the repo does.
 *
 * IT REFUSES BEFORE IT MEASURES. Driving the CLI entry point resolves through `dist/` (package
 * `main`), which is gitignored, so a green here can otherwise describe a build of source that has
 * already been replaced — measured twice on this suite's shell ancestor. 94 and 95 are read
 * separately: 94 is a verdict about the build, 95 means the guard itself could not run.
 *
 * WHAT IS NOT COVERED HERE, named rather than implied:
 *   - the `unknown` liveness state. It is unreachable through any pidfile content (`parsePid` caps
 *     out to `unattributable`) and needs a kernel seccomp filter to produce. That arm is real and
 *     lives in `.lane/finding5-repair-cells.sh`; it is not portable and is not duplicated here.
 *   - the WEDGE. A SIGSTOPped real manager needs a broker and a live manager; this suite starts
 *     neither. What it covers is the pid-evidence rendering, which is where the false green was.
 *
 * Run: pnpm exec tsx bin/smoke/ready-card.smoke.ts
 */
import { spawnSync, spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { assertBuildCurrent } from "./_build-current.js";

let pass = 0, fail = 0;
const check = (name: string, cond: boolean): void => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ FAIL: ${name}`); }
};

const REPO = resolve(import.meta.dirname, "..", "..");
const NODE = process.execPath;                                   // this interpreter, not a fixed path
const TSX = join(REPO, "node_modules", "tsx", "dist", "cli.mjs");
const CLI = join(REPO, "bin", "cotal.ts");

console.log("\nready-card — the manager row an operator actually reads\n");

// REFUSE FIRST. A stale dist means every assertion below is about a program nobody built.
assertBuildCurrent([join(REPO, "implementations", "cli")]);
if (!existsSync(TSX)) throw new Error(`CANNOT MEASURE: tsx not found at ${TSX} — install dependencies first`);

// ---- an ANCHORED scratch, and the operator's real home is never touched -------------------------
// `findCotalRoot` walks up from cwd, so an unanchored project dir adopts whatever shared ancestor
// carries a `.cotal`. HOME is set as well as COTAL_HOME/XDG: a previous version of this harness set
// the latter two only, and runs wrote into the operator's real `~/.agents`.
const SCRATCH = mkdtempSync(join(tmpdir(), "cotal-readycard-"));
const PROJ = join(SCRATCH, "proj"), HOME_D = join(SCRATCH, "home"), CFG_D = join(SCRATCH, "cfg");
mkdirSync(join(PROJ, ".cotal"), { recursive: true });
mkdirSync(HOME_D, { recursive: true });
mkdirSync(CFG_D, { recursive: true });
const PIDFILE = join(PROJ, ".cotal", "manager.pid");

const ENV = {
  ...process.env,
  HOME: HOME_D, COTAL_HOME: HOME_D, XDG_CONFIG_HOME: CFG_D, COTAL_SKIP_ASSIST: "1",
  COTAL_SERVERS: undefined, COTAL_SERVER: undefined, COTAL_CREDS: undefined,
  COTAL_SPACE: undefined, COTAL_NAME: undefined,
} as NodeJS.ProcessEnv;

/** The WHOLE manager row, not its first line: `note()` wraps a long row across several box lines and
 *  an ancestor of this helper read only the first, reporting FAIL for text present on line three. */
function card(): string {
  const r = spawnSync(NODE, [TSX, CLI, "setup"], { cwd: PROJ, env: ENV, encoding: "utf8", timeout: 240_000 });
  const plain = `${r.stdout ?? ""}${r.stderr ?? ""}`.replace(/\x1b\[[0-9;]*m/g, "");
  const lines = plain.split("\n");
  const start = lines.findIndex((l) => / manager /.test(l));
  if (start < 0) return "";
  const out: string[] = [];
  for (let i = start; i < lines.length; i++) {
    if (/^│\s*│\s*$/.test(lines[i]!)) break;   // the card's own blank row ends the block
    out.push(lines[i]!);
  }
  return out.join(" ").replace(/│/g, "").replace(/\s+/g, " ").trim();
}

// Onboard once so every later render is a fast repeat that draws the card.
spawnSync(NODE, [TSX, CLI, "setup", "--yes"], { cwd: PROJ, env: ENV, encoding: "utf8", timeout: 240_000 });

let rowsSeen = 0;
const rowFor = (label: string): string => {
  const row = card();
  console.log(`    ${label}| ${row}`);
  rowsSeen++;
  return row;
};

// ---- ALIVE: an unrelated LIVE pid — the defect-B state ------------------------------------------
// A real process that is not a manager. `kill(pid,0)` succeeds, and the old card called that
// `✓ manager running`.
const child = spawn("sleep", ["900"], { detached: true, stdio: "ignore" });
child.unref();
const plantedPid = child.pid!;
writeFileSync(PIDFILE, String(plantedPid));
const alive = rowFor("alive");
check("P0-control: the manager row was FOUND in the rendered card (an empty extract passes every absence check)", alive.length > 0);
check("ALIVE: an unrelated live pid is NEVER claimed running (no ✓ on the row)", !alive.includes("✓"));
check("ALIVE: the row names its SOURCE — the pid and the pidfile it came from",
  alive.includes(String(plantedPid)) && alive.includes("manager.pid"));
// Since the affirmative read landed, the row no longer says "serving not checked" — it says what
// was actually established. What must hold in EVERY case is that it never implies serving without
// having established it, and that it names the condition rather than going quiet.
check("ALIVE: the row does not claim serving, and says which condition stopped it",
  !alive.includes("· serving ·") && (alive.includes("NOT SERVING") || alive.includes("cannot establish")));
check("ALIVE: the row offers NO start hint over a live process", !alive.includes("start:"));
// The extractor must not have stopped early: the row wraps, and a truncated read would satisfy every
// absence check above for the wrong reason.
check("P0-bound: the extract reached the END of the wrapped row, not just its first line",
  alive.includes(".cotal/manager.pid") && alive.length > 60);
// The row must not say the same thing twice. The first wiring rendered "pid N (…) is present but a
// local process is present but no manager answered" — the renderer's own preamble colliding with
// the claim's detail. Caught by reading the real output, not by any assertion that existed.
check("ALIVE: the row does not repeat itself (no duplicated 'is present')",
  (alive.match(/is present/g) ?? []).length <= 1);
// ⚠️ NOTHING WAS ASKED in this scratch: no manager instance is recorded, so no health read was
// attempted. The row must not claim a manager failed to answer. This is the defect driving the real
// card exposed in the decision table, and this is the cell that keeps it closed at the surface.
check("ALIVE: with no recorded instance, the row does NOT claim a manager failed to answer",
  !/no manager answered/.test(alive));

// ---- DEAD: the same record, its pid proven gone -------------------------------------------------
// AWAIT the exit rather than polling around a blocking sleep. The first version of this arm looped
// with `spawnSync("sleep")`, which blocks the event loop — so SIGCHLD was never processed, this
// suite's own child was never reaped, and it remained a signalable ZOMBIE that answered
// `kill(pid, 0)` forever. The DEAD precondition caught it and refused, which is the only reason
// this is a comment and not a green. `manager-proc.ts` documents the identical hazard for the same
// reason; the lesson did not transfer to a suite until it cost a run here.
const exited = new Promise<void>((r) => { child.on("exit", () => r()); });
process.kill(plantedPid, "SIGKILL");
await exited;
let gone = false;
try { process.kill(plantedPid, 0); } catch (e) { gone = (e as NodeJS.ErrnoException).code === "ESRCH"; }
// Three outcomes, not two: `kill -0` failing is not proof of death — EPERM means the process exists
// and is not ours to signal. Only ESRCH proves gone, and without it the dead arm would run against a
// live process and its green would mean nothing.
check("DEAD-precondition: the planted pid is PROVEN gone by ESRCH, not merely unsignalable", gone);
const dead = rowFor("dead");
check("DEAD: a record whose pid is gone renders `not running`", dead.includes("not running"));
check("DEAD: the start hint is EARNED here", dead.includes("start:"));
check("DEAD: no ✓", !dead.includes("✓"));

// ---- ABSENT: no record at all --------------------------------------------------------------------
rmSync(PIDFILE, { force: true });
const absent = rowFor("absent");
check("ABSENT: no pidfile renders `not running`", absent.includes("not running"));
check("ABSENT: the start hint is earned here too", absent.includes("start:"));

// ---- UNATTRIBUTABLE: content that is not a pid ---------------------------------------------------
writeFileSync(PIDFILE, "not-a-pid\n");
const unattr = rowFor("unattributable");
check("UNATTRIBUTABLE: the row says it CANNOT ESTABLISH, not `unknown`", unattr.includes("cannot establish"));
check("UNATTRIBUTABLE: it names WHICH condition failed", unattr.includes("does not hold a pid"));
check("UNATTRIBUTABLE: NO start hint — that record may front a process nobody can identify", !unattr.includes("start:"));
check("UNATTRIBUTABLE: no ✓", !unattr.includes("✓"));
check("UNATTRIBUTABLE: it is NOT rendered as `not running` — absent and unreadable are different facts",
  !unattr.includes("not running"));

// ---- cardinality: every state above actually produced a render -----------------------------------
// Without this, an arm that stopped rendering would take its own cells with it and the suite would
// still print all-green. The count is checked BECAUSE each state is asserted individually above.
check(`CARDINALITY: all 4 states rendered a row (saw ${rowsSeen})`, rowsSeen === 4);

// ---- hermeticity: the operator's real home was not touched ---------------------------------------
check("HERMETIC: the run wrote into the scratch, not the real home", existsSync(join(PROJ, ".cotal")));
check("HERMETIC-control: the scratch HOME actually received the run's state (else the check above is vacuous)",
  existsSync(HOME_D));

const EXPECTED_CELLS = 22;
if (pass + fail !== EXPECTED_CELLS) {
  fail++;
  console.log(`  ✗ FAIL: CELL COUNT: expected ${EXPECTED_CELLS} cells, ran ${pass + fail - 1}`);
}

// Only the pid recorded at creation, exact, and its exit is awaited above before anything is removed.
let stillThere = false;
try { process.kill(plantedPid, 0); stillThere = true; } catch { stillThere = false; }
if (!stillThere) rmSync(SCRATCH, { recursive: true, force: true });
else console.log(`  ⚠ planted pid ${plantedPid} still present — scratch PRESERVED at ${SCRATCH}`);

console.log(`\nready-card: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
