/**
 * AN INTERRUPTED PROBE MUST NOT EXIT 0 (issue #1591).
 *
 * `reconnect-effect.smoke.ts` gates on `res.status === 0` under the message "the probe did not
 * run". Four `BaseException` handlers in the probe caught `KeyboardInterrupt` and none re-raised
 * it, so one SIGINT was absorbed: the probe kept running, graded the affected properties False,
 * and exited 0. The suite then read a cut-off measurement as a completed run whose product rows
 * happened to fail, which points a reader at the reconnect path instead of at the abort.
 *
 * This suite sends one SIGINT to the real probe and grades the child's ACTUAL exit. The exit must
 * come from the `exit` event, never from `child.killed` (which only means `kill()` was called) and
 * never from a timeout constant: an earlier version of this file printed "-999" from its own
 * `setTimeout` and read that as a pass while the probe was still alive.
 *
 * Run: pnpm smoke:hermes-probe-interrupt
 */
import { strict as nodeAssert } from "node:assert";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

let cells = 0;
const assert = new Proxy(nodeAssert, {
  get(target, prop, receiver) {
    const value = Reflect.get(target, prop, receiver);
    if (typeof value !== "function") return value;
    return (...args: unknown[]) => {
      cells += 1;
      return (value as (...a: unknown[]) => unknown).apply(target, args);
    };
  },
}) as typeof nodeAssert;

const EXPECTED_CELLS = 5;

if (process.platform === "win32") {
  console.log("✓ probe-interrupt smoke skipped on Windows (the Hermes connector is Unix-only)");
  console.log("COTAL_SMOKE_SENTINEL cells=1 passed=1 failed=0");
  process.exit(0);
}

const pkgDir = fileURLToPath(new URL("..", import.meta.url));
const probe = fileURLToPath(new URL("./reconnect-effect.probe.py", import.meta.url));

const python = ["python3", "python"].find((bin) => spawnSync(bin, ["-c", ""], { stdio: "ignore" }).status === 0);
assert.ok(python, "no python3/python on PATH: the interrupt behaviour cannot be verified");

// The signal is sent after the scenario is under way, so it lands inside the guarded region rather
// than during interpreter start-up.
const SIGNAL_AFTER_MS = 1_000;
// A budget, not an outcome. If it fires the child is killed with SIGKILL and the exit event still
// reports the real disposition, which is asserted below to be the interrupt and not the kill.
const REAP_BUDGET_MS = 120_000;

const child = spawn(python!, [probe, `${pkgDir}plugin`, "subject"], { stdio: ["ignore", "pipe", "pipe"] });
let stdout = "";
let stderr = "";
child.stdout.on("data", (d) => { stdout += d; });
child.stderr.on("data", (d) => { stderr += d; });

const started = Date.now();
const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
  child.on("exit", (code, signal) => resolve({ code, signal }));
});

await new Promise((r) => setTimeout(r, SIGNAL_AFTER_MS));
child.kill("SIGINT");

const overdue = setTimeout(() => child.kill("SIGKILL"), REAP_BUDGET_MS);
const { code, signal } = await exited;
clearTimeout(overdue);
const elapsed = Date.now() - started;

console.log(`probe exited code=${code} signal=${signal} ${elapsed}ms after start, ${elapsed - SIGNAL_AFTER_MS}ms after SIGINT`);

// A SIGKILL exit means the budget above reaped a probe that outlived the interrupt, so name it
// before grading the code: that is the defect, not a clean instrument row.
assert.notEqual(
  signal,
  "SIGKILL",
  `the probe ignored SIGINT for ${REAP_BUDGET_MS}ms and had to be killed:\n${stdout}\n${stderr}`,
);

// THE DEFECT: interrupted, yet reports the clean exit the gate reads as "the probe ran".
assert.notEqual(
  code,
  0,
  `the probe swallowed SIGINT and exited 0, so an aborted run grades as a completed one:\n${stdout}\n${stderr}`,
);

// Python reports an unhandled KeyboardInterrupt as death by SIGINT when the default disposition is
// restored, and as status 1 when the interpreter converts it during shutdown. Either says the
// interrupt reached the top; anything else says something other than the abort ended the probe.
assert.ok(
  signal === "SIGINT" || code === 130 || code === 1,
  `the probe ended on something other than the interrupt (code=${code} signal=${signal}):\n${stdout}\n${stderr}`,
);

// The rows the interrupt cut off must not be published as graded product failures.
const rows = stdout.split("\n").filter((l) => /^[A-Z_]+ (True|False)$/.test(l));
assert.equal(
  rows.filter((l) => l.endsWith(" False")).length,
  0,
  `the interrupted probe still graded properties as failures, which attributes the abort to the product:\n${rows.join("\n")}`,
);

if (cells !== EXPECTED_CELLS) {
  console.error(`expected ${EXPECTED_CELLS} assertion cells, ran ${cells}`);
  process.exit(1);
}
console.log(`✓ an interrupted probe fails the gate instead of reporting a clean run`);
console.log(`COTAL_SMOKE_SENTINEL cells=${cells} passed=${cells} failed=0`);
