/**
 * #29 HIGH 3 pidfile-belt smoke: the auth-service launcher's EXCLUSIVE pid-slot claim
 * ({@link claimAuthPidSlot}) — the cheap HOST-LAYER belt under the broker-visible plane claim.
 * Proves the check-then-spawn race is gone: the claim is published ATOMICALLY and PRE-POPULATED
 * (pid written to a temp inode, then `link(2)` as the slot — no create/write window a sibling
 * could misread), a live holder is yielded to, a provably dead holder's stale slot is reclaimed
 * exactly once, an EMPTY slot (impossible to produce under the protocol; a pre-protocol crash
 * shape) is reclaimed once rather than wedging forever, and GARBLED content is NEVER stolen.
 * It also proves a start the re-exec guard refuses (#1629) touches no pid record at all.
 * Broker-free.
 *
 * Run: pnpm smoke:auth-pidfile
 */
import { spawn } from "node:child_process";
import { closeSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AuthPrepared } from "@cotal-ai/core";
import { authServiceUp, claimAuthPidSlot, ensureAuthService, stopAuthService } from "../src/lib/auth-proc.js";

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
  rmSync(PID_FILE);

  // 6. #1629: a start this process may not make touches no pid record. This suite is not the cotal
  //    entry, so `selfArgv` refuses to re-exec it. The claim publishes a slot that already names the
  //    launcher (cell 1), so a refusal that came after the claim left a record naming this live
  //    process: a retry read it as a running service and started nothing, and teardown signalled
  //    this pid. The reclaim of a dead pre-hex record is pidfile work too, and waits for the same check.
  const LEGACY_FILE = join(tmp, ".cotal", `auth-service.${encodeURIComponent(SPACE)}.pid`);
  writeFileSync(LEGACY_FILE, String(await deadPid()));
  let readyCalls = 0;
  const prepared: AuthPrepared = {
    extraAccounts: [],
    publicAuth: {},
    service: { command: "auth-service", ready: async () => { readyCalls++; return {}; } },
  };
  const start = async (): Promise<string> => {
    try {
      await ensureAuthService({ space: SPACE, server: "nats://127.0.0.1:1", stateDir: tmp, prepared });
      return "ensureAuthService returned";
    } catch (e) {
      return (e as Error).message;
    }
  };
  const REFUSAL = /^refusing to re-exec this process as `cotal`/;
  const first = await start();
  check("a start from an entry that is not cotal is REFUSED by the re-exec guard", REFUSAL.test(first), first);
  check("the refused start published no pid slot", !existsSync(PID_FILE), existsSync(PID_FILE) ? readFileSync(PID_FILE, "utf8") : "");
  check("so the space does not read as running an auth service", !authServiceUp(SPACE));
  check("the refused start left the dead pre-hex record where it was", existsSync(LEGACY_FILE));
  const retry = await start();
  check("a retry is refused the same way, not satisfied by a record that names this process", REFUSAL.test(retry), retry);
  check("the provider is never asked to report ready for a service nobody started", readyCalls === 0, readyCalls);
  const signalled: number[] = [];
  const quiet = console.error;
  console.error = () => {}; // the pre-hex record carries no identity pin, which teardown warns about
  try {
    await stopAuthService(SPACE, () => "dead", (pid) => { signalled.push(pid); });
  } finally {
    console.error = quiet;
  }
  check("teardown never signals this launcher's own pid", !signalled.includes(process.pid), signalled);
  // CONTROL: the reads above do see a slot this process holds, so their "nothing here" is observed.
  const held = claimAuthPidSlot(SPACE);
  check("CONTROL: a slot this process does claim reads as a running auth service",
    held !== undefined && "fd" in held && authServiceUp(SPACE));
  if (held !== undefined && "fd" in held) closeSync(held.fd);
} finally {
  process.chdir(prevCwd);
  rmSync(tmp, { recursive: true, force: true });
}

console.log(fail === 0 ? `\nAUTH-PIDFILE SMOKE OK ✅  (${pass} passed, ${fail} failed)` : `\nAUTH-PIDFILE SMOKE FAILED ❌  (${pass} passed, ${fail} failed)`);
if (fail > 0) process.exit(1);
