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

interface ProbeResult { rc: number; stdout: string; verdict: "SURVIVED" | "FAILED" | "UNKNOWN"; }

async function runProbe(flag?: "--mutant" | "--control"): Promise<ProbeResult> {
  return await new Promise((resolve, reject) => {
    const args = ["tsx", PROBE];
    if (flag) args.push(flag);
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
      const line = stdout.split("\n").find((l) => l.startsWith("BOUNDARY_RESULT="));
      const verdict = line?.endsWith("SURVIVED") ? "SURVIVED" : line?.endsWith("FAILED") ? "FAILED" : "UNKNOWN";
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
console.log("[cell 1/2] schedule under credRenewIntervalMs(TTL): must SURVIVE the boundary");
const fixed = await runProbe();
check("BOUNDARY_RESULT=SURVIVED with the shipped schedule", fixed.verdict === "SURVIVED",
  { rc: fixed.rc, tail: fixed.stdout.split("\n").slice(-6).join(" | ") });
check("probe exited 0 when the schedule holds", fixed.rc === 0, { rc: fixed.rc });

// Cell 2: the mutant (interval = TTL/2) reddens the same probe. Proves this cell tests the
// schedule and not e.g. the broker's grace period.
console.log("[cell 2/2] --mutant reverts interval to TTL/2: must FAIL the boundary");
const mutant = await runProbe("--mutant");
check("BOUNDARY_RESULT=FAILED with interval=TTL/2 (the parent's schedule)", mutant.verdict === "FAILED",
  { rc: mutant.rc, tail: mutant.stdout.split("\n").slice(-6).join(" | ") });
check("mutant probe exited non-zero when the schedule misses the window", mutant.rc !== 0, { rc: mutant.rc });

console.log(`\n== #457 renewal-boundary: ${pass} pass, ${fail} fail ==`);
if (fail > 0) process.exit(1);
process.exit(0);
