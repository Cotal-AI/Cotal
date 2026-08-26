import {
  assertWindowsDetachAllowed,
  assertDetachedChildExitObservable,
  windowsDetachedChild,
  WINDOWS_JOB_REFUSAL,
} from "../../implementations/cli/src/lib/detached-spawn.js";

let failures = 0;
function check(label: string, condition: boolean, extra?: unknown): void {
  console.log(`${condition ? "✓" : "✗"} ${label}${condition ? "" : ` — ${String(extra)}`}`);
  if (!condition) failures++;
}

check("Windows process outside a job detaches without breakaway", assertWindowsDetachAllowed({ inJob: false, breakawayAllowed: false }) === false);
check("Windows job with breakaway permission requests CREATE_BREAKAWAY_FROM_JOB", assertWindowsDetachAllowed({ inJob: true, breakawayAllowed: true }) === true);
try {
  assertWindowsDetachAllowed({ inJob: true, breakawayAllowed: false });
  check("Windows job without breakaway permission refuses detached up and names --foreground", false, "did not throw");
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  check(
    "Windows job without breakaway permission refuses detached up and names --foreground",
    message === WINDOWS_JOB_REFUSAL && message.includes("--foreground") && message.includes("cannot host a detached stack"),
    message,
  );
}

const signals: Array<{ pid: number; signal?: NodeJS.Signals | number }> = [];
const child = windowsDetachedChild(4242, (pid, signal) => {
  signals.push({ pid, signal });
  return true;
});
check(
  "Windows detached child kill forwards the exact pid and signal",
  child.kill("SIGTERM") === true && signals.length === 1 && signals[0]?.pid === 4242 && signals[0]?.signal === "SIGTERM",
  JSON.stringify(signals),
);
check(
  "Windows detached child is active under the same null-state guard as a real child",
  child.exitCode === null && child.signalCode === null && !(child.exitCode !== null || child.signalCode !== null),
  JSON.stringify({ exitCode: child.exitCode, signalCode: child.signalCode }),
);
try {
  assertDetachedChildExitObservable(child);
  check("Windows detached child exit observation fails loud instead of pretending it exited", false, "did not throw");
} catch (error) {
  check(
    "Windows detached child exit observation fails loud instead of pretending it exited",
    error instanceof Error && error.message === "detached child process 4242 cannot have its exit observed",
    error,
  );
}

console.log(`\nWINDOWS DETACHED SPAWN SMOKE ${failures === 0 ? "OK ✅" : "FAILED ❌"}`);
process.exit(failures === 0 ? 0 : 1);
