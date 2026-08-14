/**
 * Isolates the failing cell of `smoke:delivery-health-live`:
 *   check("daemon-gone: the daemon process is really gone", !groupAlive(created.daemon) && daemonExited)
 *
 * HYPOTHESIS: the two conjuncts are read at different moments in the group's death. `awaitExit`
 * resolves when the GROUP LEADER emits "exit"; `groupAlive` then asks about the whole GROUP. The
 * leader's own descendants are reparented and reaped a few ms later, and a zombie is still a group
 * member that `kill(-pgid, 0)` answers for. So the check can read "still alive" immediately after a
 * successful SIGKILL — a FLAKE, not a real survivor.
 *
 * REFUTATION CONDITION, registered before running: if `daemonExited` is ever false, or if
 * `groupAlive` stays true past ~1s, the hypothesis is WRONG and the cause is a genuine survivor
 * rather than a reaping race. Either of those refutes me and I must not ship the poll-based fix.
 *
 * No broker, no creds, no network. A 3-level detached tree is enough to reproduce the shape.
 */
import { spawn } from "node:child_process";

const groupAlive = (pid?: number): boolean => {
  if (!pid) return false;
  try { process.kill(-pid, 0); return true; } catch { return false; }
};

const ROUNDS = Number(process.argv[2] ?? 12);
let sawRace = 0, sawExitedFalse = 0, sawSurvivorPast1s = 0;

for (let i = 0; i < ROUNDS; i++) {
  // pnpm -> sh -> sleep, mirroring the real (pnpm -> tsx -> node) tree. detached => group leader.
  const child = spawn("sh", ["-c", "sh -c 'exec sleep 300'"], { stdio: "ignore", detached: true });
  const pid = child.pid!;
  let exited = false;
  child.on("exit", () => { exited = true; });

  // let the whole tree materialise
  await new Promise((r) => setTimeout(r, 250));
  if (!groupAlive(pid)) { console.log(`round ${i}: SETUP FAILED — group never came up`); continue; }

  try { process.kill(-pid, "SIGKILL"); } catch { /* gone */ }

  // exactly what awaitExit does: resolve on the LEADER's exit event
  await new Promise<void>((r) => { child.once("exit", () => r()); setTimeout(() => r(), 5000); });

  const t0 = process.hrtime.bigint();
  const aliveAtCheck = groupAlive(pid);          // <-- the instant the real suite reads it
  if (!exited) sawExitedFalse++;

  let clearedAfterMs = 0;
  if (aliveAtCheck) {
    sawRace++;
    while (groupAlive(pid) && clearedAfterMs < 3000) {
      await new Promise((r) => setTimeout(r, 5));
      clearedAfterMs = Number(process.hrtime.bigint() - t0) / 1e6;
    }
    if (clearedAfterMs >= 1000) sawSurvivorPast1s++;
  }

  console.log(
    `round ${i}: groupAlive_at_check=${aliveAtCheck} daemonExited=${exited} ` +
    `cell_would_be=${!aliveAtCheck && exited ? "PASS" : "FAIL"}` +
    (aliveAtCheck ? ` cleared_after=${clearedAfterMs.toFixed(1)}ms` : ""),
  );
}

console.log(`\nrounds=${ROUNDS} raced=${sawRace} daemonExited_false=${sawExitedFalse} survivor_past_1s=${sawSurvivorPast1s}`);
console.log(
  sawRace > 0 && sawExitedFalse === 0 && sawSurvivorPast1s === 0
    ? "HYPOTHESIS HELD: a reaping race, not a survivor. The cell is flaky by construction."
    : "HYPOTHESIS REFUTED on its registered conditions — do NOT ship the poll fix on this evidence.",
);
