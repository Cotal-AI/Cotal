/**
 * #29 HIGH 3 pidfile-belt smoke: the auth-service launcher's EXCLUSIVE pid-slot claim
 * ({@link claimAuthPidSlot}) — the cheap HOST-LAYER belt under the broker-visible plane claim.
 * Proves the check-then-spawn race is gone: the claim is published ATOMICALLY and PRE-POPULATED
 * (pid written to a temp inode, then `link(2)` as the slot — no create/write window a sibling
 * could misread), a live holder is yielded to, a provably dead holder's stale slot is reclaimed
 * exactly once, an EMPTY slot (impossible to produce under the protocol; a pre-protocol crash
 * shape) is reclaimed once rather than wedging forever, and GARBLED content is NEVER stolen.
 * Broker-free.
 *
 * Run: pnpm smoke:auth-pidfile
 */
import { spawn } from "node:child_process";
import { closeSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { claimAuthPidSlot } from "../src/lib/auth-proc.js";

let pass = 0, fail = 0;
const check = (name: string, cond: boolean, extra?: unknown) => { if (cond) { pass++; console.log(`  ✓ ${name}`); } else { fail++; console.log(`  ✗ FAIL: ${name}`, extra ?? ""); } };

// A throwaway cotal root: cotalPath resolves from cwd, so chdir into it.
const tmp = mkdtempSync(join(tmpdir(), "cotal-pidbelt-"));
mkdirSync(join(tmp, ".cotal"), { recursive: true });
const prevCwd = process.cwd();
process.chdir(tmp);
const SPACE = "pidbelt";
const PID_FILE = join(tmp, ".cotal", `auth-service.${Buffer.from(SPACE, "utf8").toString("hex")}.pid`); // the injective hex space key (see workspace spaceKey)

/** A pid that provably belonged to a real, now-dead process. */
async function deadPid(): Promise<number> {
  const child = spawn(process.execPath, ["-e", ""], { stdio: "ignore" });
  await new Promise<void>((r) => child.once("exit", () => r()));
  return child.pid ?? 1;
}

try {
  // 1. Virgin claim wins, and the claim is ATTRIBUTABLE from the first instant: the published slot
  //    already carries the launcher's pid (atomic pre-populated link, never an empty window).
  const slot1 = claimAuthPidSlot(SPACE);
  check("a virgin claim wins the slot (atomic link publish)", slot1 !== undefined && "fd" in slot1);
  check("the published slot carries the launcher's pid IMMEDIATELY (never an empty window)", readFileSync(PID_FILE, "utf8") === String(process.pid));
  check("no temp claim inode lingers after the publish", readdirSync(join(tmp, ".cotal")).length === 1);
  if (slot1 !== undefined && "fd" in slot1) closeSync(slot1.fd);

  // 2. A LIVE holder is yielded to, never stolen.
  const slot2 = claimAuthPidSlot(SPACE);
  check("a live holder keeps the slot (yield with its pid, no steal)", slot2 !== undefined && "livePid" in slot2 && slot2.livePid === process.pid);
  check("the live holder's file is untouched", readFileSync(PID_FILE, "utf8") === String(process.pid));

  // 3. A provably DEAD holder's stale file is reclaimed (exactly the crash-recovery path).
  writeFileSync(PID_FILE, String(await deadPid()));
  const slot3 = claimAuthPidSlot(SPACE);
  check("a dead holder's stale file is reclaimed (remove + exclusive re-create)", slot3 !== undefined && "fd" in slot3);
  check("the reclaimed slot names the new claimant at once", readFileSync(PID_FILE, "utf8") === String(process.pid));
  if (slot3 !== undefined && "fd" in slot3) closeSync(slot3.fd);
  rmSync(PID_FILE);

  // 4. An EMPTY slot is impossible to PUBLISH under the atomic pre-populated protocol, so one on
  //    disk is a pre-protocol/foreign crash shape: reclaimed ONCE, never a permanent wedge.
  writeFileSync(PID_FILE, "");
  const slot4 = claimAuthPidSlot(SPACE);
  check("an EMPTY slot (pre-protocol crash shape) is reclaimed once, not wedged forever", slot4 !== undefined && "fd" in slot4);
  check("the reclaimed empty slot names the new claimant", readFileSync(PID_FILE, "utf8") === String(process.pid));
  if (slot4 !== undefined && "fd" in slot4) closeSync(slot4.fd);
  rmSync(PID_FILE);

  // 5. GARBLED content cannot be attributed to any process: yield, never steal.
  writeFileSync(PID_FILE, "not-a-pid");
  const slot5 = claimAuthPidSlot(SPACE);
  check("garbled content is never stolen (yield, fail-safe)", slot5 === undefined);
  check("the unattributable file survives the yield", existsSync(PID_FILE) && readFileSync(PID_FILE, "utf8") === "not-a-pid");
} finally {
  process.chdir(prevCwd);
  rmSync(tmp, { recursive: true, force: true });
}

console.log(fail === 0 ? `\nAUTH-PIDFILE SMOKE OK ✅  (${pass} passed, ${fail} failed)` : `\nAUTH-PIDFILE SMOKE FAILED ❌  (${pass} passed, ${fail} failed)`);
if (fail > 0) process.exit(1);
