/**
 * #29 HIGH 3 pidfile-belt smoke: the auth-service launcher's EXCLUSIVE pid-slot claim
 * ({@link claimAuthPidSlot}) — the cheap HOST-LAYER belt under the broker-visible plane claim.
 * Proves the check-then-spawn race is gone: the slot is an O_EXCL create BEFORE any spawn, a live
 * holder is yielded to, a provably dead holder's stale file is reclaimed exactly once, and an
 * unreadable/fresh file (a sibling launcher between its exclusive create and its pid write) is
 * NEVER stolen. Broker-free.
 *
 * Run: pnpm smoke:auth-pidfile
 */
import { spawn } from "node:child_process";
import { closeSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
const PID_FILE = join(tmp, ".cotal", `auth-service.${SPACE}.pid`);

/** A pid that provably belonged to a real, now-dead process. */
async function deadPid(): Promise<number> {
  const child = spawn(process.execPath, ["-e", ""], { stdio: "ignore" });
  await new Promise<void>((r) => child.once("exit", () => r()));
  return child.pid ?? 1;
}

try {
  // 1. Virgin claim wins and owns the slot.
  const slot1 = claimAuthPidSlot(SPACE);
  check("a virgin claim wins the slot (exclusive create)", slot1 !== undefined && "fd" in slot1);
  if (slot1 !== undefined && "fd" in slot1) {
    writeFileSync(slot1.fd, String(process.pid));
    closeSync(slot1.fd);
  }

  // 2. A LIVE holder is yielded to, never stolen.
  const slot2 = claimAuthPidSlot(SPACE);
  check("a live holder keeps the slot (yield with its pid, no steal)", slot2 !== undefined && "livePid" in slot2 && slot2.livePid === process.pid);
  check("the live holder's file is untouched", readFileSync(PID_FILE, "utf8") === String(process.pid));

  // 3. A provably DEAD holder's stale file is reclaimed (exactly the crash-recovery path).
  writeFileSync(PID_FILE, String(await deadPid()));
  const slot3 = claimAuthPidSlot(SPACE);
  check("a dead holder's stale file is reclaimed (remove + exclusive re-create)", slot3 !== undefined && "fd" in slot3);
  if (slot3 !== undefined && "fd" in slot3) closeSync(slot3.fd); // crashed-before-write shape: the file stays EMPTY

  // 4. An EMPTY/unreadable file (a sibling mid-claim, or a claimer that crashed before its pid
  //    write) is NEVER stolen: the claim yields and leaves the file alone.
  const slot4 = claimAuthPidSlot(SPACE);
  check("an unreadable fresh file is never stolen (yield, fail-safe)", slot4 === undefined);
  check("the contested file survives the yield", existsSync(PID_FILE));
} finally {
  process.chdir(prevCwd);
  rmSync(tmp, { recursive: true, force: true });
}

console.log(fail === 0 ? `\nAUTH-PIDFILE SMOKE OK ✅  (${pass} passed, ${fail} failed)` : `\nAUTH-PIDFILE SMOKE FAILED ❌  (${pass} passed, ${fail} failed)`);
if (fail > 0) process.exit(1);
