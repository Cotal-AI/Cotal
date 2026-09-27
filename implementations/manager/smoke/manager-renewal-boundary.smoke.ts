/**
 * Cotal #457: the manager credential-renewal schedule lands inside `[renewAt, exp)`.
 *
 * At the parent commit the manager schedules `renewDaemonCreds` every TTL/2, so on a 24h
 * credential the ticks land at 12h (`healthy`, no-op) and 24h (`expired`, already refused),
 * missing the 75% -> 100% renewal window entirely and letting the connection be refused at
 * expiry. `inspectCredHealth` (packages/core/src/provision.ts) enters `near-expiry` at 75% of
 * iat-to-exp lifetime, so the window width is TTL/4 and any interval greater than TTL/4 can miss
 * it for the right phase.
 *
 * WHAT THIS CELL GRADES, against a REAL JWT broker + a REAL signed credential (never the live
 * mesh on :4222):
 *   1. FIX APPLIED: with `credRenewIntervalMs(TTL)` driving the schedule, one tick lands inside
 *      `[renewAt, exp)`, the credential is reminted, and the connection survives past nominal
 *      expiry. `BOUNDARY_RESULT=SURVIVED`.
 *   2. MUTANT: reverting the interval to TTL/2 in the probe (bypassing the fixed helper) reddens
 *      this cell with `BOUNDARY_RESULT=FAILED`. Proves the cell tests the schedule, not something
 *      adjacent. The mutant lives in the probe, not on disk, so a green cell requires the SHIPPED
 *      helper to still be correct AND the mutant path to still fail.
 *
 * COTAL_HOME is scrubbed; the probe boots its own broker on an OS-assigned free loopback port
 * and kills only that process, per {@link bootBroker}. Compressed-ratio: TTL=20s preserves the
 * production 86400 / TTL/2 = 43200 = 2:1 ratio (24h class) so the whole boundary fits in ~30s.
 *
 * Run: pnpm smoke:manager-renewal-boundary
 */
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const PROBE = join(HERE, "_probe-457-renewal-boundary.ts");

type Verdict = "SURVIVED" | "FAILED" | "RECOVERED" | "DEAD" | "UNKNOWN";
interface ProbeResult { rc: number; stdout: string; verdict: Verdict; }

// Every mode prints exactly one verdict line whose prefix names the signal it grades:
// BOUNDARY_RESULT (--control/--mutant, --phase variants) or CLOSE_RESULT (--close variants).
const VERDICT_PREFIXES = ["BOUNDARY_RESULT=", "CLOSE_RESULT="];

async function runProbe(flags: readonly string[] = []): Promise<ProbeResult> {
  return await new Promise((resolve, reject) => {
    const args = ["tsx", PROBE, ...flags];
    // The probe boots its own broker and mints its own creds; nothing from an ambient seat may reach it.
    // suite-ambient-env grades this shape: strip COTAL_ from the copy before the copy is spread.
    const env: NodeJS.ProcessEnv = { ...process.env };
    for (const k of Object.keys(env)) if (k.startsWith("COTAL_")) delete env[k];
    env.TMPDIR = process.env.TMPDIR ?? "/var/tmp";
    const child = spawn("pnpm", args, { stdio: ["ignore", "pipe", "pipe"], env });
    let stdout = ""; let stderr = "";
    child.stdout.on("data", (b) => { stdout += b.toString(); });
    child.stderr.on("data", (b) => { stderr += b.toString(); });
    child.on("error", reject);
    child.on("exit", (rc) => {
      const line = stdout.split("\n").find((l) => VERDICT_PREFIXES.some((p) => l.startsWith(p)));
      const raw = line?.split("=")[1];
      const verdict: Verdict = raw === "SURVIVED" || raw === "FAILED" || raw === "RECOVERED" || raw === "DEAD" ? raw : "UNKNOWN";
      if (verdict === "UNKNOWN") console.error(`  probe stderr: ${stderr}`);
      resolve({ rc: rc ?? -1, stdout, verdict });
    });
  });
}

let pass = 0, fail = 0;
const check = (name: string, cond: boolean, extra?: unknown) => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ FAIL: ${name}`, extra === undefined ? "" : extra); }
};

console.log("== #457 renewal-boundary cell ==");

// Cell 1: the shipped schedule survives the boundary.
console.log("[cell 1/8] schedule under credRenewIntervalMs(TTL): must SURVIVE the boundary");
const fixed = await runProbe();
check("BOUNDARY_RESULT=SURVIVED with the shipped schedule", fixed.verdict === "SURVIVED",
  { rc: fixed.rc, tail: fixed.stdout.split("\n").slice(-6).join(" | ") });
check("probe exited 0 when the schedule holds", fixed.rc === 0, { rc: fixed.rc });

// Cell 2: the mutant (interval = TTL/2) reddens the same probe. Proves this cell tests the
// schedule and not e.g. the broker's grace period.
console.log("[cell 2/8] --mutant reverts interval to TTL/2: must FAIL the boundary");
const mutant = await runProbe(["--mutant"]);
check("BOUNDARY_RESULT=FAILED with interval=TTL/2 (the parent's schedule)", mutant.verdict === "FAILED",
  { rc: mutant.rc, tail: mutant.stdout.split("\n").slice(-6).join(" | ") });
check("mutant probe exited non-zero when the schedule misses the window", mutant.rc !== 0, { rc: mutant.rc });

// Cell 3: phase offset. The shipped renewAt schedule renews inside the window and reconnect()
// carries the new credential, independent of a decoy interval running with the parent's buggy phase.
console.log("[cell 3/8] --phase: renewAt schedule must SURVIVE despite a decoy TTL/2 interval");
const phase = await runProbe(["--phase"]);
check("phase offset: the shipped renewAt schedule renews inside the window and reconnect() carries the new credential",
  phase.verdict === "SURVIVED", { rc: phase.rc, tail: phase.stdout.split("\n").slice(-6).join(" | ") });
check("phase probe exited 0", phase.rc === 0, { rc: phase.rc });

// Cell 4: phase offset mutant (interval-only). Strips the renewAt timeout, keeps only the decoy
// interval -- reproduces the parent bug's phase sensitivity.
console.log("[cell 4/8] --phase --mutant: interval-only (no renewAt timeout) must FAIL");
const phaseMutant = await runProbe(["--phase", "--mutant"]);
check("phase offset mutant: interval-only misses the window",
  phaseMutant.verdict === "FAILED", { rc: phaseMutant.rc, tail: phaseMutant.stdout.split("\n").slice(-6).join(" | ") });
check("phase mutant probe exited non-zero", phaseMutant.rc !== 0, { rc: phaseMutant.rc });

// Cell 5: phase offset mutant (no push). renewAt re-mints but skips nc.reconnect(): the fresh
// JWT lands on disk but the live connection still presents the stale one and dies at the old exp.
console.log("[cell 5/8] --phase --mutant-no-push: renewAt re-mints but never pushes, must FAIL");
const phaseNoPush = await runProbe(["--phase", "--mutant-no-push"]);
check("phase offset mutant: a renewal that is not pushed dies at the old exp",
  phaseNoPush.verdict === "FAILED", { rc: phaseNoPush.rc, tail: phaseNoPush.stdout.split("\n").slice(-6).join(" | ") });
check("phase no-push probe exited non-zero", phaseNoPush.rc !== 0, { rc: phaseNoPush.rc });

// Cell 6: auth-expired close. The bounded recovery re-dials with a fresh credential after the
// broker refuses reconnects on an expired credential.
console.log("[cell 6/8] --close: bounded recovery must RECOVER from an auth-expired close");
const close = await runProbe(["--close"]);
check("auth-expired close: the bounded recovery re-dials with a fresh credential",
  close.verdict === "RECOVERED", { rc: close.rc, tail: close.stdout.split("\n").slice(-8).join(" | ") });
check("close probe exited 0", close.rc === 0, { rc: close.rc });

// Cell 7: auth-expired close mutant. A log-only handler (the parent's shape) never re-dials.
console.log("[cell 7/8] --close --mutant: log-only handler must stay DEAD");
const closeMutant = await runProbe(["--close", "--mutant"]);
check("auth-expired close mutant: a log-only handler stays dead",
  closeMutant.verdict === "DEAD", { rc: closeMutant.rc, tail: closeMutant.stdout.split("\n").slice(-6).join(" | ") });
check("close mutant probe exited non-zero", closeMutant.rc !== 0, { rc: closeMutant.rc });

// Cell 8: transport-drop control, checked inside the (non-mutant) --close run above: closed()
// must not resolve and the connection must survive a broker restart on the same port.
console.log("[cell 8/8] transport drop control (from the --close run above)");
check("transport drop: closed() does not resolve and the connection survives a broker restart",
  close.stdout.includes("TRANSPORT_DROP_RESULT=SURVIVED"),
  { tail: close.stdout.split("\n").filter((l) => l.startsWith("TRANSPORT_DROP_RESULT")).join(" | ") });

console.log(`\n== #457 renewal-boundary: ${pass} pass, ${fail} fail ==`);
if (fail > 0) process.exit(1);
process.exit(0);
