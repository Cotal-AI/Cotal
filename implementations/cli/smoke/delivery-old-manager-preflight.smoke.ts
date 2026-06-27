/**
 * delivery old-manager cutover preflight smoke (blocker 7 + the cutover invariant). Before the delivery
 * daemon binds, any OLD Plane-3-hosting manager must be stopped — else it double-binds the fanout/reader
 * durables against the new daemon. A this-build (non-hosting) manager writes a pid-bound
 * `.cotal/manager.delivery-aware` marker; the preflight stops a live `manager.pid` that has NO matching
 * marker (an old hosting manager) and LEAVES a marked one running. The marker check is fail-closed:
 * missing/mismatch/unparseable ⇒ NOT delivery-aware. No broker needed — this is pid/file logic.
 *
 * Run: pnpm smoke:delivery-old-manager
 */
import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { managerUp, managerHasDeliveryMarker } from "../src/lib/manager-proc.js";
import { stopOldHostingManagerIfPresent } from "../src/lib/delivery-proc.js";

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const alive = (pid: number): boolean => { try { process.kill(pid, 0); return true; } catch { return false; } };
const fakeManager = () => spawn(process.execPath, ["-e", "setInterval(()=>{}, 1000)"], { stdio: "ignore" });
let pass = 0, fail = 0;
const check = (name: string, cond: boolean) => { if (cond) { pass++; console.log(`  ✓ ${name}`); } else { fail++; console.log(`  ✗ FAIL: ${name}`); } };

const root = mkdtempSync(join(tmpdir(), "cotal-preflight-"));
mkdirSync(join(root, ".cotal"), { recursive: true });
const origCwd = process.cwd();
process.chdir(root); // findCotalRoot()/cotalPath() resolve `.cotal/` from cwd
const pidPath = join(root, ".cotal", "manager.pid");
const markerPath = join(root, ".cotal", "manager.delivery-aware");
const children: ReturnType<typeof spawn>[] = [];

try {
  // 1. A live manager.pid with NO marker = an old hosting manager → the preflight stops it.
  const m1 = fakeManager(); children.push(m1);
  writeFileSync(pidPath, String(m1.pid));
  await wait(100);
  check("live manager.pid with NO marker → not delivery-aware", managerUp() === true && managerHasDeliveryMarker() === false);
  stopOldHostingManagerIfPresent();
  await wait(400);
  check("preflight STOPS an unmarked (old hosting) manager + clears its pid", !alive(m1.pid!) && !existsSync(pidPath));

  // 2. A live manager.pid WITH a pid-matching marker = this-build, non-hosting → left running.
  const m2 = fakeManager(); children.push(m2);
  writeFileSync(pidPath, String(m2.pid));
  writeFileSync(markerPath, String(m2.pid));
  await wait(100);
  check("live manager.pid WITH a matching marker → delivery-aware", managerHasDeliveryMarker() === true);
  stopOldHostingManagerIfPresent();
  await wait(300);
  check("preflight LEAVES a delivery-aware manager running", alive(m2.pid!) === true && existsSync(pidPath));

  // 3. Marker pid MISMATCH (stale marker from a crashed older process) → fail-closed (not aware).
  writeFileSync(markerPath, String((m2.pid ?? 0) + 1));
  check("marker pid mismatch → NOT delivery-aware (fail-closed)", managerHasDeliveryMarker() === false);

  console.log(`\nDELIVERY-OLD-MANAGER-PREFLIGHT SMOKE ${fail === 0 ? "OK ✅" : "FAILED ❌"}  (${pass} passed, ${fail} failed)`);
  if (fail) process.exitCode = 1;
} catch (e) {
  fail++;
  console.error("  ✗ scenario threw:", (e as Error).message);
  process.exitCode = 1;
} finally {
  process.chdir(origCwd);
  for (const c of children) { try { c.kill("SIGKILL"); } catch { /* gone */ } }
  // Best-effort: Windows holds killed children's handles briefly past kill, so a bare rmSync races
  // into EPERM — retry, and never let cleanup fail a scenario whose assertions passed. No-op on POSIX.
  try { rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 200 }); } catch { /* OS-temp dir */ }
}
