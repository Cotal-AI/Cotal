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
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readdirSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
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

// ---- the hermeticity instrument, armed BEFORE the first run --------------------------------------
// ⚠️ AN EARLIER VERSION OF THIS SUITE WAS VACUOUS HERE AND REVIEW PROVED IT: it created `PROJ/.cotal`
// and `HOME_D` itself, then "established" hermeticity by checking those same pre-created paths still
// existed. Existence proved by the setup code, not by the run. Review redirected the child's `HOME`
// to an external decoy — setup wrote `.agents` into the operator-visible decoy — and the suite stayed
// entirely green. That is precisely the regression that once wrote into a real `~/.agents`.
//
// What replaces it: a fingerprint over the marker paths a `setup` run actually creates, taken before
// and after. `HOME` and `COTAL_HOME` are witnessed SEPARATELY because they are separate redirections
// — `.agents` follows HOME, `onboarded.json` follows COTAL_HOME, and a mutant that moves one leaves
// the other's witness green.
const HOME_MARKERS = [".agents", ".claude", "claude-plugin", "agent-skills.json", "onboarded.json"] as const;

/** The subset the CLI itself writes under HOME — and the ONLY set the operator-home invariance may
 *  walk recursively.
 *
 *  MEASURED, not assumed: walking all of `HOME_MARKERS` recursively against a real home on this box
 *  reported 18 changed entries during one suite run, and every one of them was another tool's —
 *  `.claude/projects/*.jsonl` transcripts from concurrently running sessions and `.claude/backups/`
 *  rotations. `cotal` writes none of those; a grep of the CLI source for HOME-rooted targets yields
 *  `.agents`, `claude-plugin`/`.claude-plugin`, `agent-skills.json`, `onboarded.json` and no
 *  `.claude` path at all.
 *
 *  So including `.claude` would make this cell red for reasons unrelated to the code under test, on
 *  any machine where a Claude session is live. A cell that reddens for unrelated reasons is not
 *  strictness — it trains its reader to ignore a red, which costs exactly what a false green costs.
 *
 *  RESIDUAL LIMIT, named rather than implied: a regression that wrote into `~/.claude/projects` or
 *  `~/.claude/backups` specifically would not be caught by this cell. Those are not paths the CLI
 *  has any code to write, and the scratch-home witnesses below still cover `.claude` in a quiet
 *  directory where churn cannot occur. */
const COTAL_WRITE_MARKERS = [".agents", "claude-plugin", ".claude-plugin", "agent-skills.json", "onboarded.json"] as const;

/** Presence AND mtime, RECURSIVELY over each marker tree.
 *
 *  The previous form stat'd only the five top-level marker paths. Review reproduced the hole: with
 *  `.agents/skills` already present, a child writing `.agents/skills/team-topology/SKILL.md` does
 *  not change `.agents`'s own mtime, so the comparator returned an identical string and the whole
 *  suite stayed green while a run wrote HOME-rooted state outside the scratch. Proving a comparator
 *  can see a top-level creation does NOT prove it can see a protected descendant write — that is
 *  the shape of a sound argument without its substance, and the cells below now drive both.
 *
 *  Bounded, and the bound THROWS rather than truncating: a fingerprint that silently covered part
 *  of a tree would report "unchanged" for a region it never read, which is this lane's own defect. */
const FINGERPRINT_MAX_ENTRIES = 50_000;
function homeFingerprint(dir: string, markers: readonly string[] = HOME_MARKERS): string {
  const parts: string[] = [];
  let seen = 0;
  const walk = (abs: string, rel: string): void => {
    let s;
    try { s = statSync(abs); } catch { parts.push(`${rel}:absent`); return; }
    if (++seen > FINGERPRINT_MAX_ENTRIES) {
      throw new Error(`CANNOT MEASURE: more than ${FINGERPRINT_MAX_ENTRIES} entries under the marker paths of ${dir} — a partial fingerprint would report "unchanged" for a region it never read`);
    }
    if (s.isDirectory()) {
      parts.push(`${rel}/:${s.mtimeMs}`);
      for (const e of readdirSync(abs).sort()) walk(join(abs, e), `${rel}/${e}`);
    } else {
      parts.push(`${rel}:${s.mtimeMs}:${s.size}`);
    }
  };
  for (const m of markers) walk(join(dir, m), m);
  return createHash("sha256").update(parts.join("|")).digest("hex");
}

/** The comparator's OWN sensitivity, driven on a throwaway tree — never on anyone's real home.
 *  An invariance cell is only worth its green if the comparator would have moved; these two cells
 *  establish that it moves for a DESCENDANT write, and that the old top-level-only form did not. */
{
  const probe = mkdtempSync(join(tmpdir(), "cotal-fingerprint-probe-"));
  const deep = join(probe, ".agents", "skills", "team-topology");
  mkdirSync(deep, { recursive: true });          // the marker dir ALREADY EXISTS, as in the real hole
  const before = homeFingerprint(probe, COTAL_WRITE_MARKERS);
  const beforeTopOnly = COTAL_WRITE_MARKERS.map((m) => {
    try { return `${m}:${statSync(join(probe, m)).mtimeMs}`; } catch { return `${m}:absent`; }
  }).join("|");
  writeFileSync(join(deep, "SKILL.md"), "planted descendant write");
  const afterTopOnly = COTAL_WRITE_MARKERS.map((m) => {
    try { return `${m}:${statSync(join(probe, m)).mtimeMs}`; } catch { return `${m}:absent`; }
  }).join("|");
  check("COMPARATOR: the fingerprint SEES a write to a descendant of an already-existing marker dir",
    homeFingerprint(probe, COTAL_WRITE_MARKERS) !== before);
  check("COMPARATOR-control: the old top-level-only form does NOT see it (so the repair is non-equivalent)",
    afterTopOnly === beforeTopOnly);
  rmSync(probe, { recursive: true, force: true });
}
const REAL_HOME = process.env.HOME;
if (REAL_HOME === undefined || REAL_HOME === "") throw new Error("CANNOT MEASURE: no HOME in this environment — the protected path cannot be identified, so its invariance cannot be asserted");
if (REAL_HOME === HOME_D) throw new Error(`CANNOT MEASURE: the scratch HOME is the real HOME (${REAL_HOME})`);
const realHomeBefore = homeFingerprint(REAL_HOME, COTAL_WRITE_MARKERS);
const scratchHomeBefore = homeFingerprint(HOME_D);
// The witnesses must not pre-date the run, or every assertion below is satisfied by this suite's own
// mkdir. This is the cell whose absence made the old pair vacuous.
check("HERMETIC-precondition: the scratch HOME is EMPTY before any run (a pre-created witness proves nothing)",
  readdirSync(HOME_D).length === 0);

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
// This interpreter, not POSIX `sleep`. Review's finding, and it was right: a suite that calls itself
// portable and is replayed on Windows cannot depend on an executable the repo never guarantees — the
// dependency reproduces as ENOENT, and "Git-for-Windows happens to ship sleep.exe" is environment
// leakage, not a repo-level fact. A Node child is the same live unrelated pid with no such dependency.
// NOT unref'd, and that is deliberate: an unref'd handle lets the event loop drain while the child is
// still alive, and the `exit` await below then never settles — measured, on the first run after this
// swap ("unsettled top-level await", 9 cells reached of 26). Keeping it referenced also guarantees the
// suite cannot finish while its own planted process is still running.
const child = spawn(NODE, ["-e", "setInterval(() => {}, 1000);"], { detached: true, stdio: "ignore" });
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

// ---- hermeticity: witnessed on BOTH sides, positive and negative ----------------------------------
// The HOME-rooted witness is the one review's decoy mutant moved. `.agents` follows `HOME` and only a
// run creates it — this suite asserted the directory was empty before anything ran.
check("HERMETIC: the run's HOME-rooted state landed in the SCRATCH home (.agents, created by the run)",
  existsSync(join(HOME_D, ".agents")));
check("HERMETIC: the run's COTAL_HOME-rooted state landed there too (onboarded.json — a separate redirection)",
  existsSync(join(HOME_D, "onboarded.json")));
// The protected path, asserted directly rather than by proxy.
check("HERMETIC: the OPERATOR's real home is byte-for-byte unchanged across every run above",
  homeFingerprint(REAL_HOME, COTAL_WRITE_MARKERS) === realHomeBefore);
// ⚠️ The inverse. Without it, the cell above passes for a fingerprint function that can see nothing —
// which is exactly how the pair it replaced failed. Same comparator, a directory that DID change.
check("HERMETIC-control: the same comparator DOES report a change for the scratch home (else invariance is vacuous)",
  homeFingerprint(HOME_D) !== scratchHomeBefore);
check("HERMETIC: the project state landed in the scratch project root", existsSync(join(PROJ, ".cotal")));

const EXPECTED_CELLS = 28;
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
