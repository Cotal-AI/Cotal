import type { ChildProcess } from "node:child_process";
import {
  assertWindowsDetachAllowed,
  assertDetachedChildExitObservable,
  windowsDetachedChild,
  WINDOWS_JOB_REFUSAL,
} from "../../implementations/cli/src/lib/detached-spawn.js";
import {
  rethrowNotReadyListenerFailureForTest,
  rethrowPostStartListenerFailureForTest,
  rethrowUnboundListenerFailureForTest,
} from "../../implementations/cli/src/commands/up.js";

let failures = 0;
function check(label: string, condition: boolean, extra?: unknown): void {
  console.log(`${condition ? "✓" : "✗"} ${label}${condition ? "" : ` — ${String(extra)}`}`);
  if (!condition) failures++;
}

check("C01 Windows process outside a job detaches without breakaway", assertWindowsDetachAllowed({ inJob: false, breakawayAllowed: false }) === false);
check("C02 Windows job with breakaway permission requests CREATE_BREAKAWAY_FROM_JOB", assertWindowsDetachAllowed({ inJob: true, breakawayAllowed: true }) === true);
try {
  assertWindowsDetachAllowed({ inJob: true, breakawayAllowed: false });
  check("C03 Windows job without breakaway permission refuses detached up and names --foreground", false, "did not throw");
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  check(
    "C03 Windows job without breakaway permission refuses detached up and names --foreground",
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
  "C04 Windows detached child kill forwards the exact pid and signal",
  child.kill("SIGTERM") === true && signals.length === 1 && signals[0]?.pid === 4242 && signals[0]?.signal === "SIGTERM",
  JSON.stringify(signals),
);
const goneSignals: Array<{ pid: number; signal?: NodeJS.Signals | number }> = [];
const gone = Object.assign(new Error("gone"), { code: "ESRCH" });
const goneChild = windowsDetachedChild(4343, (pid, signal) => {
  goneSignals.push({ pid, signal });
  throw gone;
});
let goneResult: boolean | undefined;
let goneError: unknown;
try { goneResult = goneChild.kill("SIGTERM"); }
catch (error) { goneError = error; }
check(
  "C05 Windows detached child reports an already-gone pid as false after attempting the exact signal",
  goneError === undefined && goneResult === false && goneSignals.length === 1 && goneSignals[0]?.pid === 4343 && goneSignals[0]?.signal === "SIGTERM",
  JSON.stringify({ goneResult, goneError: String(goneError), goneSignals }),
);
check(
  "C06 Windows detached child is active under the same null-state guard as a real child",
  child.exitCode === null && child.signalCode === null && !(child.exitCode !== null || child.signalCode !== null),
  JSON.stringify({ exitCode: child.exitCode, signalCode: child.signalCode }),
);
try {
  assertDetachedChildExitObservable(child);
  check("C07 Windows detached child exit observation fails loud instead of pretending it exited", false, "did not throw");
} catch (error) {
  check(
    "C07 Windows detached child exit observation fails loud instead of pretending it exited",
    error instanceof Error && error.message === "detached child process 4242 cannot have its exit observed",
    error,
  );
}

const signalFailure = Object.assign(new Error("not permitted"), { code: "EPERM" });
const failingChild = windowsDetachedChild(4444, () => { throw signalFailure; });
const bindFailure = new Error("bind failed");
let removedPid: number | undefined;
let bindCaught: unknown;
try {
  await rethrowUnboundListenerFailureForTest(
    failingChild,
    bindFailure,
    undefined,
    (pid) => { removedPid = pid; },
  );
} catch (error) {
  bindCaught = error;
}
check(
  "C08 an unbound-listener non-ESRCH teardown failure keeps the pidfile",
  removedPid === undefined,
  removedPid,
);
check(
  "C09 an unbound-listener teardown failure preserves the primary error and attaches the cleanup failure",
  bindCaught === bindFailure && bindFailure.cause === signalFailure,
  bindCaught,
);

const unboundGoneFailure = new Error("bind failed after exit");
let unboundGonePidRemoved: number | undefined;
let unboundGoneCaught: unknown;
try {
  await rethrowUnboundListenerFailureForTest(
    goneChild,
    unboundGoneFailure,
    undefined,
    (pid) => { unboundGonePidRemoved = pid; },
  );
} catch (error) {
  unboundGoneCaught = error;
}
check(
  "C10 an unbound-listener ESRCH result removes the stale pidfile and preserves the bind error",
  unboundGonePidRemoved === 4343 && unboundGoneCaught === unboundGoneFailure && unboundGoneFailure.cause === undefined,
  { unboundGonePidRemoved, unboundGoneCaught },
);

const readinessFailure = new Error("nats-server did not become reachable - see log");
let notReadyPidRemoved = false;
let readinessCaught: unknown;
try {
  await rethrowNotReadyListenerFailureForTest(failingChild, readinessFailure, () => { notReadyPidRemoved = true; });
} catch (error) {
  readinessCaught = error;
}
check(
  "C11 a not-ready non-ESRCH kill failure keeps the bound-listener pidfile",
  !notReadyPidRemoved,
  notReadyPidRemoved,
);
check(
  "C12 a not-ready kill failure preserves the readiness error and attaches the signal failure",
  readinessCaught === readinessFailure && readinessFailure.cause === signalFailure,
  readinessCaught,
);

const readinessGoneFailure = new Error("nats-server exited before readiness");
let notReadyGonePidRemoved = false;
let readinessGoneCaught: unknown;
try {
  await rethrowNotReadyListenerFailureForTest(goneChild, readinessGoneFailure, () => { notReadyGonePidRemoved = true; });
} catch (error) {
  readinessGoneCaught = error;
}
check(
  "C13 a not-ready ESRCH result removes the stale pidfile and preserves the readiness error",
  notReadyGonePidRemoved && readinessGoneCaught === readinessGoneFailure && readinessGoneFailure.cause === undefined,
  { notReadyGonePidRemoved, readinessGoneCaught },
);

const postStartFailure = new Error("postStart failed");
const postStartSignalFailure = Object.assign(new Error("not permitted"), { code: "EPERM" });
const postStartChild = { pid: 4545, kill() { throw postStartSignalFailure; } } as unknown as ChildProcess;
let postStartPidRemoved = false;
let postStartCaught: unknown;
try {
  await rethrowPostStartListenerFailureForTest(postStartChild, postStartFailure, () => { postStartPidRemoved = true; });
} catch (error) {
  postStartCaught = error;
}
check(
  "C14 a postStart non-ESRCH signal failure keeps the pidfile",
  !postStartPidRemoved,
  postStartPidRemoved,
);
check(
  "C15 a postStart signal failure preserves the postStart error and attaches the signal failure",
  postStartCaught === postStartFailure && postStartFailure.cause === postStartSignalFailure,
  postStartCaught,
);

const postStartGoneFailure = new Error("postStart failed after exit");
const postStartGoneChild = { pid: 4646, kill() { return false; } } as unknown as ChildProcess;
let gonePidRemoved = false;
let postStartGoneCaught: unknown;
try {
  await rethrowPostStartListenerFailureForTest(postStartGoneChild, postStartGoneFailure, () => { gonePidRemoved = true; });
} catch (error) {
  postStartGoneCaught = error;
}
check(
  "C16 a postStart ESRCH result removes the stale pidfile and preserves the postStart error",
  gonePidRemoved && postStartGoneCaught === postStartGoneFailure && postStartGoneFailure.cause === undefined,
  { gonePidRemoved, postStartGoneCaught },
);

console.log(`\nWINDOWS DETACHED SPAWN SMOKE ${failures === 0 ? "OK ✅" : "FAILED ❌"}`);
process.exit(failures === 0 ? 0 : 1);
