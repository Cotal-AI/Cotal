/**
 * LIVE PROBE (F-d1): `cotal up --restore` must reach its listener-bind boundary, and its re-entry
 * must complete, while the process holds the root maintenance lock.
 *
 * The other half of the corner the P2 lock hand-off opened, and the more severe half. `up --restore`
 * re-enters `up()` for the commit pass, and since P2 that re-entry always holds `startupLock`. The
 * restore-side journal writers in lib/restore.ts took no lock parameter and self-acquired, so they
 * refused against a lock this same process already owned: the lock is not reentrant, and it cannot
 * stale-reap its way out because the recorded owner is alive — it is us. The FIRST of them to fire
 * is `bindPreparedRestoreListener`, so the restore died before any of the later seams, and the
 * command did not run at all.
 *
 * The sibling probe (up-adopt-resume-lock:live) covers the adopt paths. Neither covers the other:
 * that one enters through a resume with no artifact and would stay green through this break.
 *
 * Driven through the REAL command, as a subprocess, against a REAL broker:
 *
 *  1. CONTROL - reach an interrupted restore: boot, cut with state preserved, take a registry
 *     artifact. Without all three the restore below has nothing to restore FROM, and a red would be
 *     the fixture failing rather than the subject.
 *  2. SUBJECT A - the first `up --restore` reaches the listener-bind boundary (exit 86). This is the
 *     regression itself: it exited 1 on a maintenance-lock refusal, which is asserted against BY
 *     NAME, because a bare non-zero check would report this finding for an unrelated failure.
 *  3. CONTROL - that pass left `commit-intent` with a bound listener still ALIVE, the precondition
 *     for the re-entry to take the resume branch rather than start over.
 *  4. SUBJECT B - the restore re-entry completes (exit 0) under that same inherited lock.
 *
 * Sandboxes COTAL_HOME under a scratch base with proven-clean `.cotal` ancestry; kills only its own
 * children. Needs `nats-server` on PATH.
 * Run: pnpm smoke:up-restore-reentry:live
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer, type AddressInfo } from "node:net";
import { join, resolve as resolvePath } from "node:path";
import { makeScratch, assertScratchHeld } from "../../../bin/smoke/_scratch.js";

const freePort = (): Promise<number> =>
  new Promise((res, rej) => {
    const s = createServer();
    s.on("error", rej);
    s.listen(0, "127.0.0.1", () => {
      const p = (s.address() as AddressInfo).port;
      s.close(() => res(p));
    });
  });

const scratch = makeScratch("cotal-up-restore-reentry-");
const home = mkdtempSync(join(scratch, "home-"));
const root = mkdtempSync(join(scratch, "root-"));
process.env.COTAL_HOME = home;

const WT = resolvePath(import.meta.dirname, "..", "..", "..");
const CLI = join(WT, "bin", "cotal.ts");
const TSX = join(WT, "node_modules", ".bin", "tsx");
const journalPath = join(root, ".cotal", "maintenance", "v1", "journal.json");
const artifact = join(root, "registry-backup");

let pass = 0;
const ok = (name: string, cond: boolean, extra?: unknown) => {
  if (!cond) throw new Error(`FAIL: ${name}${extra !== undefined ? ` - ${JSON.stringify(extra)}` : ""}`);
  pass++;
  console.log(`  ✓ ${name}`);
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const baseEnv = { ...process.env, COTAL_HOME: home };

/** Blocking `cotal <args>`, the way an operator runs it. */
function runSync(args: string[], extraEnv: Record<string, string> = {}) {
  return spawnSync(TSX, [CLI, ...args], {
    cwd: root,
    env: { ...baseEnv, ...extraEnv },
    encoding: "utf8",
    timeout: 240_000,
  });
}

const tail = (r: { stdout?: string; stderr?: string }) => `${r.stdout ?? ""}${r.stderr ?? ""}`;

type Journal = { state?: string; listenerProof?: { processOwner?: { pid?: number } } };
const journal = (): Journal =>
  existsSync(journalPath) ? (JSON.parse(readFileSync(journalPath, "utf8")) as Journal) : {};

const alive = (pid: number | undefined): boolean => {
  if (!Number.isInteger(pid) || (pid ?? 0) <= 0) return false;
  try { process.kill(pid as number, 0); return true; } catch { return false; }
};

try {
  mkdirSync(join(root, ".cotal"), { recursive: true });
  assertScratchHeld(root, "up restore re-entry fixture");

  const port = await freePort();
  const server = `nats://127.0.0.1:${port}`;
  const space = "restore_alpha";

  console.log("1) CONTROL: a preserved mesh and an artifact to restore from");
  const first = runSync(["up", "--detach", "--open", "--server", server, "--space", space]);
  ok("the ordinary boot exited 0", first.status === 0, tail(first).slice(-1200));
  const cut = runSync(["down", "--preserve-state"]);
  ok("the cut exited 0", cut.status === 0, tail(cut).slice(-1200));
  const made = runSync(["backup", "create", artifact, "--only", "registry"]);
  ok("the registry backup exited 0", made.status === 0, tail(made).slice(-1200));

  console.log("\n2) SUBJECT A: the first `up --restore` reaches the listener-bind boundary");
  const restore = runSync(
    ["up", "--restore", artifact, "--detach", "--server", server, "--space", space],
    { COTAL_SMOKE_EXIT_AFTER_RESTORE_LISTENER_BIND: "1" },
  );
  const restoreLog = tail(restore);
  ok("the restore did not fail on a maintenance-lock refusal",
    !/held by a live owner|recovery is already in progress|maintenance lock/i.test(restoreLog),
    { status: restore.status, log: restoreLog.slice(-2000) });
  ok("the restore stopped at the listener-bind boundary (exit 86)", restore.status === 86,
    { status: restore.status, log: restoreLog.slice(-2000) });

  await sleep(1500);
  console.log("\n3) CONTROL: it left commit intent with a LIVE bound listener");
  const intent = journal();
  ok("the journal is `commit-intent`", intent.state === "commit-intent", intent.state);
  const boundPid = intent.listenerProof?.processOwner?.pid;
  ok("…and its bound listener is ALIVE (the re-entry precondition)", alive(boundPid), { boundPid });

  console.log("\n4) SUBJECT B: the restore RE-ENTRY completes under the inherited lock");
  const recovered = runSync(["up", "--detach", "--server", server, "--space", space]);
  const log = tail(recovered);
  ok("the re-entry did not fail on a maintenance-lock refusal",
    !/held by a live owner|recovery is already in progress|maintenance lock/i.test(log),
    { status: recovered.status, log: log.slice(-2000) });
  ok("the restore re-entry exited 0", recovered.status === 0, { status: recovered.status, log: log.slice(-2000) });

  runSync(["down"]);
  console.log(`\nUP RESTORE RE-ENTRY SMOKE OK ✅  (${pass} passed)`);
} catch (e) {
  console.error("  ✗ FAIL:", (e as Error).message);
  process.exitCode = 1;
} finally {
  try { runSync(["down"]); } catch { /* best effort */ }
  await sleep(500);
  for (const name of ["nats.pid", "manager.pid", "delivery.pid"]) {
    const p = join(root, ".cotal", name);
    if (!existsSync(p)) continue;
    const pid = Number.parseInt(readFileSync(p, "utf8").trim(), 10);
    if (Number.isInteger(pid) && pid > 0) try { process.kill(pid, "SIGKILL"); } catch { /* already gone */ }
  }
  rmSync(scratch, { recursive: true, force: true });
}
