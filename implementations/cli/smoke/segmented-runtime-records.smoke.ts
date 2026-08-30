/**
 * TWO SPACES, ONE ROOT: the capability the per-space runtime namespace exists for. Real child
 * processes, real records on disk, the shipped CLI read/stop paths. No broker.
 *
 * Before this change `manager.pid`, `manager.log`, `manager.delivery-aware`, `delivery.pid` and
 * `delivery.log` were root-scoped constants, so a workspace root hosted ONE deliver and ONE
 * supervise BY FILENAME. Booting a second space in the same root overwrote the first space's
 * record: `status` then reported the wrong process, and `down` stopped the wrong process and
 * orphaned the other. `packages/workspace/smoke/segmented-runtime-namespace.smoke.ts` pins the
 * naming seam; this pins that the CLI's own readers and stoppers ADDRESS the right process through
 * it, which a path-shape assertion cannot show.
 *
 * The records here are placed with the shipped `canonicalLocalProcessPath` — the same expansion the
 * start paths write through — so no spelling is restated. The processes behind them are real: each
 * carries the `supervise` argv token, so the manager's attribution reads them as ours the way it
 * reads a real daemon.
 *
 * Run: pnpm smoke:segmented-runtime-records
 */
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  canonicalLocalProcessPath, DELIVERY_PIDFILE, MANAGER_DELIVERY_AWARE_MARKER, MANAGER_PIDFILE,
} from "@cotal-ai/workspace";
import { deliveryLiveness, deliveryUp, stopDelivery } from "../src/lib/delivery-proc.js";
import { managerHasDeliveryMarker, managerLiveness, managerUp, stopManager } from "../src/lib/manager-proc.js";

const ALPHA = "segrec-alpha", BETA = "segrec-beta";
const root = mkdtempSync(join(tmpdir(), "cotal-segrec-"));
mkdirSync(join(root, ".cotal"), { recursive: true });
const cwd = process.cwd();
// Every helper under test resolves the root by walking up from cwd, so the fixture root must BE the
// cwd. Restored in the finally below.
process.chdir(root);

let pass = 0, fail = 0;
const check = (name: string, cond: boolean, extra?: unknown) => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ FAIL: ${name}`, extra ?? ""); }
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const children: ChildProcess[] = [];
/** A real, signalable process whose argv carries the `supervise` token the manager attributes on. */
function daemon(): ChildProcess {
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1 << 30)", "supervise"], { stdio: "ignore" });
  children.push(child);
  return child;
}
const record = (template: string, space: string) => canonicalLocalProcessPath(template, { root, space });
/** Place a record where the START PATH would write it, through the start path's own expansion. */
function place(template: string, space: string, pid: number): string {
  const path = record(template, space);
  writeFileSync(path, String(pid));
  return path;
}
const alive = (pid: number): boolean => { try { process.kill(pid, 0); return true; } catch { return false; } };
async function waitDead(pid: number): Promise<void> {
  for (let i = 0; i < 100 && alive(pid); i++) await sleep(50);
}

try {
  console.log("1) two managers, one root: each space reads its own process");
  const a = daemon(), b = daemon();
  const aPid = a.pid!, bPid = b.pid!;
  place(MANAGER_PIDFILE, ALPHA, aPid);
  place(MANAGER_PIDFILE, BETA, bPid);
  check("both spaces' manager records coexist (the old namespace could hold only one)",
    existsSync(record(MANAGER_PIDFILE, ALPHA)) && existsSync(record(MANAGER_PIDFILE, BETA)));
  // Coexistence alone is satisfied by ONE file read twice, which is the old behaviour. This is the
  // cell that separates them: each record has to hold its own space's manager.
  check("...and each holds its OWN space's manager pid, which one shared file cannot",
    readFileSync(record(MANAGER_PIDFILE, ALPHA), "utf8") === String(aPid)
      && readFileSync(record(MANAGER_PIDFILE, BETA), "utf8") === String(bPid),
    { aPid, bPid });
  check("alpha reads its own manager as alive", managerUp(ALPHA) && managerLiveness(undefined, undefined, ALPHA) === "alive");
  check("beta reads its own manager as alive", managerUp(BETA) && managerLiveness(undefined, undefined, BETA) === "alive");

  console.log("\n2) the delivery-aware marker is per-space too");
  place(MANAGER_DELIVERY_AWARE_MARKER, ALPHA, aPid);
  check("alpha's marker is bound to alpha's live manager", managerHasDeliveryMarker(ALPHA));
  check("...and beta, which has no marker, is not delivery-aware by proximity", !managerHasDeliveryMarker(BETA));
  // The old shared name made this specific mis-pairing possible: one marker holding alpha's pid,
  // read as beta's answer. It cannot be produced now, so assert the pairing rather than the name.
  place(MANAGER_DELIVERY_AWARE_MARKER, BETA, aPid);
  check("a marker holding ANOTHER space's pid does not make this space delivery-aware", !managerHasDeliveryMarker(BETA));

  console.log("\n3) stopping one space's manager leaves the other's running and recorded");
  const stopped = await stopManager(undefined, undefined, undefined, ALPHA);
  await waitDead(aPid);
  check("stopManager(alpha) reports a stop", stopped === "stopped", stopped);
  check("...and alpha's process is dead", !alive(aPid));
  check("...and beta's manager is UNTOUCHED — the defect this change fixes", alive(bPid) && managerUp(BETA));
  check("...and alpha's records are gone", !existsSync(record(MANAGER_PIDFILE, ALPHA)) && !existsSync(record(MANAGER_DELIVERY_AWARE_MARKER, ALPHA)));
  check("...and beta's record is still on disk", existsSync(record(MANAGER_PIDFILE, BETA)));

  console.log("\n4) the same holds for the delivery daemon");
  const d1 = daemon(), d2 = daemon();
  const d1Pid = d1.pid!, d2Pid = d2.pid!;
  place(DELIVERY_PIDFILE, ALPHA, d1Pid);
  place(DELIVERY_PIDFILE, BETA, d2Pid);
  check("both spaces' delivery records coexist", deliveryUp(ALPHA) && deliveryUp(BETA));
  await stopDelivery(undefined, undefined, ALPHA);
  await waitDead(d1Pid);
  check("stopDelivery(alpha) stops alpha's daemon", !alive(d1Pid) && deliveryLiveness(undefined, ALPHA) === "absent");
  check("...and beta's daemon survives with its record intact", alive(d2Pid) && deliveryUp(BETA));

  console.log("\n5) a pre-segmentation root still upgrades without orphaning its daemon");
  // Exactly the state an existing single-space mesh is in when the new build first runs: the record
  // is at the ROOT of `.cotal/` under the old name, and nothing has been written per-space yet.
  const legacy = daemon();
  const legacyPid = legacy.pid!;
  writeFileSync(join(root, ".cotal", "manager.pid"), String(legacyPid));
  check("the CLI still FINDS the pre-upgrade manager", managerUp(ALPHA), managerLiveness(undefined, undefined, ALPHA));
  const legacyStop = await stopManager(undefined, undefined, undefined, ALPHA);
  await waitDead(legacyPid);
  check("...and still STOPS it, rather than leaving it orphaned", legacyStop === "stopped" && !alive(legacyPid), legacyStop);
  check("...and removes the pre-upgrade record it acted on", !existsSync(join(root, ".cotal", "manager.pid")));

  console.log("\n6) canonical AND pre-upgrade both present is refused, not guessed");
  const twin = daemon();
  writeFileSync(join(root, ".cotal", "manager.pid"), String(twin.pid!));
  place(MANAGER_PIDFILE, ALPHA, twin.pid!);
  try {
    managerUp(ALPHA);
    check("both records present throws rather than picking one (did not throw)", false);
  } catch (e) {
    check("both records present throws rather than picking one", /ambiguous/.test((e as Error).message), (e as Error).message);
  }
} finally {
  process.chdir(cwd);
  for (const child of children) if (child.pid && alive(child.pid)) { try { process.kill(child.pid, "SIGKILL"); } catch { /* gone */ } }
  rmSync(root, { recursive: true, force: true });
}

console.log(`\n${fail === 0 ? "✓" : "✗"} segmented-runtime-records: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
