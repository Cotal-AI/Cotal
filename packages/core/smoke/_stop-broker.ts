/**
 * Stop a smoke's broker and PROVE it stopped before deleting its scratch directory.
 *
 * `kill()` followed immediately by `rmSync()` stops nothing. `rm -rf` does not kill — it orphans the
 * process with a deleted cwd, and nats-server then recreates its JetStream store underneath, so a
 * directory reappears for a mesh that was "cleaned up". This exact order is on this lane's record as
 * the mechanism behind two contaminated measurements.
 *
 * The scratch dir is also the only attribution that exists: it holds the pidfiles that say WHOSE a
 * stray process is. So a teardown that tidies up after a leak it just detected destroys the evidence
 * of the leak. Hence the shape below, and it is deliberate that the failing path deletes nothing:
 *
 *   stop -> prove the stop -> scan for survivors -> if any: SIGKILL, PRESERVE the scratch, FAIL the
 *   run -> delete only after proving zero survivors.
 *
 * Two things are proven separately on purpose. `once(proc, "exit")` says the parent observed the
 * child exit; `process.kill(pid, 0)` asks the kernel whether the pid is gone. The first can be
 * missed, and neither is a substitute for the sweep: a broker this suite never recorded (a fork, a
 * respawn) is invisible to both.
 *
 * The sweep matches on `/proc/<pid>/comm` EXACTLY — a substring match over full command lines reaches
 * other lanes' brokers on this shared box, and every one of them is somebody else's evidence. It then
 * requires the scratch path in the process's own ARGV. Note that it cannot use `/proc/<pid>/cwd`, the
 * form this shape was contributed in: these brokers inherit the runner's cwd and take their scratch
 * as an argument (`-sd`, or a `-c` config inside it), so a cwd match here would never fire at all.
 */
import { once } from "node:events";
import type { ChildProcess } from "node:child_process";
import { readFileSync, readdirSync, rmSync } from "node:fs";

/** Every process still holding `sd`, named the way a reader can act on. */
function survivorsHolding(sd: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync("/proc")) {
    if (!/^\d+$/.test(entry)) continue;
    try {
      // EXACT name. `comm` is the binary, never the persona text or args of some other agent.
      if (readFileSync(`/proc/${entry}/comm`, "utf8").trim() !== "nats-server") continue;
      const argv = readFileSync(`/proc/${entry}/cmdline`, "utf8").split("\0").join(" ");
      if (!argv.includes(sd)) continue;
      found.push(`pid ${entry}: ${argv.trim()}`);
    } catch {
      // The pid exited between readdir and read. Not a survivor by definition.
    }
  }
  return found;
}

/**
 * Returns the survivors it had to kill. EMPTY means the stop was proven and `sd` was removed;
 * non-empty means `sd` was PRESERVED for attribution and the caller must fail the run.
 */
export async function stopBrokerAndClean(
  proc: ChildProcess,
  sd: string,
  deadlineMs = 5000,
): Promise<string[]> {
  const pid = proc.pid;

  if (pid !== undefined) {
    proc.kill("SIGKILL");
    if (proc.exitCode === null && proc.signalCode === null) {
      // Bounded: a never-firing exit must not hang the suite, it must be REPORTED as a survivor.
      await Promise.race([once(proc, "exit"), new Promise((r) => setTimeout(r, deadlineMs))]);
    }
    // Ask the kernel rather than trusting the event. ESRCH is the only answer that means dead.
    const until = Date.now() + deadlineMs;
    for (;;) {
      try {
        process.kill(pid, 0);
      } catch {
        break;
      }
      if (Date.now() >= until) break;
      await new Promise((r) => setTimeout(r, 50));
    }
  }

  const survivors = survivorsHolding(sd);
  if (survivors.length > 0) {
    for (const s of survivors) {
      const p = Number(s.slice(4, s.indexOf(":")));
      try {
        process.kill(p, "SIGKILL");
      } catch {
        // Already gone, or not ours to kill. Either way it stays on the report.
      }
    }
    // PRESERVED, deliberately. These pidfiles are the only way to attribute what leaked.
    return survivors;
  }

  rmSync(sd, { recursive: true, force: true });
  return [];
}
