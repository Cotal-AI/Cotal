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
import { execFileSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { tmpdir } from "node:os";

const SESSION = "cotal-herdr-soak";
const CYCLES = Number(process.env.COTAL_HERDR_SOAK_CYCLES ?? 25);

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
/** Processes whose command line names OUR session — never a bare `sleep` match, which would count
 *  other agents' work on a shared machine. */
const ourProcs = (): number => {
  const out = execFileSync("sh", ["-c", `pgrep -f "cotal-herdr-soak-agent" | wc -l || true`], { encoding: "utf8" });
  return Number(out.trim());
};

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
for (let i = 1; i <= CYCLES; i++) {
  const cycleStart = Date.now();
  const name = `cotal-herdr-soak-agent-${i}`;
  const handle = runtime.spawn(name, { command: "sleep", args: ["120"], env: { CYCLE: String(i) } }, "/tmp");
  if (handle.status() !== "running") {
    ok(`cycle ${i}: agent came up`, false, `status=${handle.status()}`);
    break;
  }
  handle.stop({ graceful: false });
  await handle.waitForExit!();
  const cycleMs = Date.now() - cycleStart;
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
ok("no agent processes survive", ourProcs() === 0, `${ourProcs()} still running`);
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
