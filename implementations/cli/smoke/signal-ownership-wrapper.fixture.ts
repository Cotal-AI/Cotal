/**
 * WRAPPER FIXTURE for the signal-ownership cell in `delivery-boot-honesty.smoke.ts`.
 *
 * WHY A SEPARATE PROCESS. The defect this grades is that a KILLED wrapper reparents its children,
 * and a suite cannot kill itself and then assert about the aftermath — the assertion would die with
 * it. So the cell spawns THIS file, learns the grandchild's pid, kills this process, and counts
 * survivors from outside. A cell that only exercised the happy path would prove nothing here: the
 * `finally` below is correct on the normal path and is exactly what never runs under a signal.
 *
 * THIS FILE MIRRORS THE SUITES' OWN SHAPE deliberately — spawn a long-lived child, take ownership,
 * release in `finally` — so the mutation that reverts the ownership line here is the same edit that
 * reverts it in `delivery-boot-honesty.smoke.ts` and `delivery-responder-visibility.smoke.ts`.
 */
import { spawn } from "node:child_process";
import { teardownOnSignal } from "@cotal-ai/smoke-kit";

// A stand-in for the broker/holder: a child that will NEVER exit on its own, so a survivor is
// unambiguous evidence that nothing tore it down rather than a race with its own lifetime.
const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });

// THE LINE UNDER TEST. Removing it leaves only the `finally`, which a signal never runs.
const release = teardownOnSignal(child);

process.stdout.write(`CHILD_PID ${child.pid}\n`);

// Hold the process open the way a suite mid-run does. Only a signal ends this.
const keepalive = setInterval(() => {}, 1_000);
try {
  await new Promise<void>(() => {});
} finally {
  clearInterval(keepalive);
  release();
  try { child.kill("SIGKILL"); } catch { /* already gone */ }
}
