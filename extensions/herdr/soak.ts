/**
 * Endurance soak for @cotal-ai/herdr.
 * Run from the repo root: pnpm smoke:herdr:soak   (cycles: COTAL_HERDR_SOAK_CYCLES, default 25)
 *
 * The smoke proves each operation is correct once. This proves the runtime does not ACCUMULATE:
 * a manager that runs for weeks does thousands of spawn/stop cycles, and a per-cycle leak of a
 * pane, a workspace, a launcher dir, a file descriptor, or a process is invisible in a
 * single-shot test and fatal in production.
 *
 * Every assertion is a delta against a baseline captured before the loop, so a pre-existing
 * stray on the machine cannot make this pass or fail spuriously.
 */
import * as herdr from "./src/driver.js";
import { HerdrRuntime } from "./src/runtime.js";
import { waitUntilVisible, visibilityDetail } from "./probe.js";
import { execFileSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { tmpdir } from "node:os";

const SESSION = "cotal-herdr-soak";
const CYCLES = Number(process.env.COTAL_HERDR_SOAK_CYCLES ?? 25);

/** The agent payload is `sleep <SOAK_NONCE>`, and the nonce is what survivor-counting matches.
 *
 *  It has to be something that genuinely appears in a spawned process's command line. The earlier
 *  version matched the AGENT NAME (`cotal-herdr-soak-agent`), which appears in no command line at
 *  all — the real processes are `sleep 120` and the launcher `node …/cotal-herdr-launch-X/launch.mjs`. So the
 *  survivor count was structurally incapable of ever being nonzero: a guaranteed-green check that
 *  measured nothing. The nonce keeps the count scoped to THIS run, so a neighbouring lane's agents
 *  on a shared machine still cannot be charged to it. */
const SOAK_NONCE = `12${process.pid % 1000}`;
const AGENT_TAG = `sleep ${SOAK_NONCE}`;

let passed = 0;
let failed = 0;
function ok(label: string, val: unknown, detail = "") {
  if (val) {
    console.log(`  ✓ ${label}`);
    passed++;
  } else {
    console.error(`  ✗ FAIL: ${label}${detail ? ` — ${detail}` : ""}`);
    failed++;
  }
}

let cleaned = false;
function cleanup() {
  if (cleaned) return;
  cleaned = true;
  try {
    herdr.stopSession(SESSION);
  } catch {
    /* not running */
  }
  try {
    execFileSync("herdr", ["session", "delete", SESSION], { stdio: "ignore" });
  } catch {
    /* already gone */
  }
}
process.on("exit", cleanup);
for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => {
    cleanup();
    process.exit(130);
  });
}
process.on("uncaughtException", (err) => {
  console.error("\n✗ UNCAUGHT:", err);
  cleanup();
  process.exit(1);
});

if (!herdr.available()) {
  const found = herdr.versionText();
  console.log(
    `• herdr soak SKIPPED — needs herdr >= ${herdr.MIN_HERDR.join(".")}` +
      (found ? ` (found "${found}")` : " (herdr not on PATH)"),
  );
  console.log("  NOTE: this suite proves nothing when skipped.");
  process.exit(0);
}

const launcherDirs = (): number => readdirSync(tmpdir()).filter((e) => e.startsWith("cotal-herdr-launch-")).length;
const srvDirs = (): number => readdirSync(tmpdir()).filter((e) => e.startsWith("cotal-herdr-srv-")).length;
const panes = (): number => (herdr.run(SESSION, ["pane", "list"]).panes as unknown[]).length;
const workspaces = (): number => (herdr.run(SESSION, ["workspace", "list"]).workspaces as unknown[]).length;
const tabs = (): number => (herdr.run(SESSION, ["tab", "list"]).tabs as unknown[]).length;
/** Processes whose command line names OUR agents — never a bare `sleep` match, which would count
 *  other lanes' work on a shared machine.
 *
 *  Deliberately NOT `pgrep -f <needle>`: that puts the needle into the checker's own command line,
 *  and on Linux pgrep then matches the `sh -c` running it, so the count never reaches zero and the
 *  soak reds forever on a runtime that leaks nothing. `ps` is invoked with no pattern in argv and
 *  the matching happens here, where nothing the check itself runs can satisfy it. */
const ourProcs = (): number =>
  execFileSync("ps", ["-eo", "args="], { encoding: "utf8" })
    .split("\n")
    .filter((l) => l.includes(AGENT_TAG)).length;

cleanup();
cleaned = false;

console.log(`\n── herdr soak: ${CYCLES} spawn/stop cycles ─────────\n`);

herdr.ensureServer(SESSION);
const runtime = new HerdrRuntime(SESSION);

// Baseline AFTER the server is up, so the server's own scratch is not counted as a leak.
const base = {
  panes: panes(),
  workspaces: workspaces(),
  tabs: tabs(),
  launchers: launcherDirs(),
  srv: srvDirs(),
};
console.log(`  baseline: panes=${base.panes} workspaces=${base.workspaces} tabs=${base.tabs} launcherDirs=${base.launchers}\n`);

const started = Date.now();
let slowestCycleMs = 0;
/** Time spent inside cycle 1's positive control, subtracted from that cycle so the per-cycle
 *  slowdown assertion measures the runtime rather than this suite's own instrument. */
let controlMs = 0;
for (let i = 1; i <= CYCLES; i++) {
  const cycleStart = Date.now();
  const name = `cotal-herdr-soak-agent-${i}`;
  const handle = runtime.spawn(name, { command: "sleep", args: [SOAK_NONCE], env: { CYCLE: String(i) } }, "/tmp");
  if (handle.status() !== "running") {
    ok(`cycle ${i}: agent came up`, false, `status=${handle.status()}`);
    break;
  }
  // Positive control, once: prove the survivor instrument can SEE a live agent before the run
  // ends by trusting it to report none. Without this, an instrument that matches nothing reports
  // a clean "no agent processes survive" forever — which is exactly what the previous one did.
  //
  // WAITS for the payload to become visible rather than sampling once. `spawn` returning means the
  // pane is running the LAUNCHER; the payload it spawns is what carries the nonce, and it appears
  // 70-155ms later (measured against the real launcher). A single sample here was green only
  // because `herdr agent start` is usually slower than that — a margin owned by another subsystem,
  // which disappears under load. See probe.ts for why a longer sleep would keep the defect.
  if (i === 1) {
    const controlStart = Date.now();
    const control = await waitUntilVisible(ourProcs, { deadlineMs: 5_000, intervalMs: 50 });
    ok("positive control: the survivor instrument can see a LIVE agent", control.kind === "seen", visibilityDetail(control));
    // Not charged to the cycle: the slowdown assertion below compares cycle times, and a control
    // that waited would show up there as a per-cycle regression it is not.
    controlMs = Date.now() - controlStart;
  }
  handle.stop({ graceful: false });
  await handle.waitForExit!();
  const cycleMs = Date.now() - cycleStart - controlMs;
  controlMs = 0;
  slowestCycleMs = Math.max(slowestCycleMs, cycleMs);
  if (i % 5 === 0 || i === CYCLES)
    console.log(`  cycle ${i}/${CYCLES}  panes=${panes()} workspaces=${workspaces()} launcherDirs=${launcherDirs()}  (${cycleMs}ms)`);
}
const elapsed = Date.now() - started;

console.log(`\n── accumulation checks (deltas vs baseline) ────\n`);

ok(`${CYCLES} cycles completed`, true);
ok("no panes accumulated", panes() === base.panes, `${panes()} vs baseline ${base.panes}`);
ok("no workspaces accumulated", workspaces() === base.workspaces, `${workspaces()} vs baseline ${base.workspaces}`);
ok("no tabs accumulated", tabs() === base.tabs, `${tabs()} vs baseline ${base.tabs}`);
ok("no launcher dirs accumulated", launcherDirs() === base.launchers, `${launcherDirs()} vs baseline ${base.launchers}`);
ok("no server scratch dirs accumulated", srvDirs() === base.srv, `${srvDirs()} vs baseline ${base.srv}`);
// Sampled over a bounded window, not once: the kills are asynchronous, so an instant read can
// catch a process that has been signalled but not yet reaped.
let noSurvivors = false;
let survivors = -1;
for (let i = 0; i < 40 && !noSurvivors; i++) {
  survivors = ourProcs();
  noSurvivors = survivors === 0;
  if (!noSurvivors) await new Promise((r) => setTimeout(r, 50));
}
// Bind the deciding sample: `ourProcs()` in the detail would be a SECOND ps sweep at a later
// instant, so a red could report a count that is not the count that failed — and during a race
// those two legitimately disagree, sending the reader after a contradiction that does not exist.
ok("no agent processes survive", noSurvivors, `${survivors} still running`);
ok("the session server is still healthy after the churn", herdr.serverRunning(SESSION));
// A per-cycle leak usually shows up as monotonically rising latency long before it shows up as a
// count, so the slowest cycle is asserted against a generous multiple of the mean.
const mean = elapsed / CYCLES;
ok(
  `no runaway per-cycle slowdown (mean ${Math.round(mean)}ms, slowest ${slowestCycleMs}ms)`,
  slowestCycleMs < Math.max(mean * 6, 4_000),
  `slowest ${slowestCycleMs}ms vs mean ${Math.round(mean)}ms`,
);

// Re-provisioning must be stable after churn: ensureServer is called on every spawn.
for (let i = 0; i < 20; i++) herdr.ensureServer(SESSION);
ok("ensureServer stays idempotent after churn", herdr.serverRunning(SESSION));
ok("repeated ensureServer leaves no scratch behind", srvDirs() === base.srv, `${srvDirs()} vs baseline ${base.srv}`);

console.log(`\n────────────────────────────────────────────────`);
console.log(`\n${passed} passed, ${failed} failed  (${CYCLES} cycles in ${Math.round(elapsed / 1000)}s)\n`);

cleanup();
if (failed > 0) process.exit(1);
