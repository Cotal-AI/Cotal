/**
 * stopDelivery teardown smoke: a creds-delete failure must NOT leave the delivery daemon alive.
 * The pid kill + pidfile cleanup run in `finally` regardless, and the delete error still
 * propagates to the caller (logged there, never silently swallowed). The delete failure is forced
 * deterministically by making `.cotal/delivery.creds` a NON-EMPTY DIRECTORY — `rmSync` without
 * `recursive` throws on it, cross-platform. Pure process/filesystem, no broker.
 *
 * Run: pnpm smoke:delivery-teardown
 */
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stopDelivery } from "../src/lib/delivery-proc.js";

let pass = 0, fail = 0;
const check = (name: string, cond: boolean) => { if (cond) { pass++; console.log(`  ✓ ${name}`); } else { fail++; console.log(`  ✗ FAIL: ${name}`); } };
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

const sandbox = mkdtempSync(join(tmpdir(), "cotal-teardown-"));
const cotal = join(sandbox, ".cotal");
mkdirSync(join(cotal, "delivery.creds"), { recursive: true }); // the un-deletable "creds"
writeFileSync(join(cotal, "delivery.creds", "block"), "x");

// A live stand-in daemon the teardown must still kill.
const victim = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
let victimExited = false;
victim.on("exit", () => { victimExited = true; });
writeFileSync(join(cotal, "delivery.pid"), String(victim.pid));

const prevCwd = process.cwd();
process.chdir(sandbox); // stopDelivery resolves .cotal by walking up from cwd
let deleteError: Error | undefined;
try {
  await stopDelivery();
} catch (e) {
  deleteError = e as Error;
} finally {
  process.chdir(prevCwd); // chdir out BEFORE cleanup (Windows: EBUSY removing the cwd)
}

check("the creds-delete failure propagates (loud, not swallowed)", deleteError !== undefined);
for (let i = 0; i < 20 && !victimExited; i++) await wait(100);
check("the daemon is still killed when the delete fails (finally)", victimExited);
check("the pidfile is still cleaned up", !existsSync(join(cotal, "delivery.pid")));

try { if (!victimExited) victim.kill("SIGKILL"); } catch { /* gone */ }
rmSync(sandbox, { recursive: true, force: true });

console.log(`\nDELIVERY-TEARDOWN SMOKE ${fail === 0 ? "OK ✅" : "FAILED ❌"}  (${pass} passed, ${fail} failed)`);
if (fail) process.exitCode = 1;
