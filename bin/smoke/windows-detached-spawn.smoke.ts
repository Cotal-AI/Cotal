import { assertWindowsDetachAllowed, WINDOWS_JOB_REFUSAL } from "../../implementations/cli/src/lib/detached-spawn.js";

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

console.log(`\nWINDOWS DETACHED SPAWN SMOKE ${failures === 0 ? "OK ✅" : "FAILED ❌"}`);
process.exit(failures === 0 ? 0 : 1);
