/**
 * Regression for #1332 and the persisted foreground `up` caller: background `up` that is the main
 * process of a systemd service names that unit and the `--foreground` remedy. It never rejects
 * startup, never changes its mode and never infers a unit without a matching invocation and main PID.
 *
 * Run: pnpm smoke:systemd-supervision
 */
import { registry, type Command } from "@cotal-ai/core";
import { createSuite } from "@cotal-ai/smoke-kit";
import {
  DETACHED_SUPERVISION_DOC_SECTION,
  detachedSystemdSupervisionWarning,
  upSystemdSupervisionWarning,
  type SystemctlRunner,
} from "../src/lib/systemd-supervision.js";
import { upCommand } from "../src/commands/up.js";
import "../src/index.js"; // self-register the CLI commands for the registration cell

const { check, finish } = createSuite();
const PID = 4242;
const ID = "0123456789abcdef0123456789abcdef";
const OTHER = "fedcba9876543210fedcba9876543210";
const unit = (fields: Record<string, string>): SystemctlRunner => () => ({
  status: 0,
  stdout: Object.entries(fields).map(([key, value]) => `${key}=${value}`).join("\n"),
});
const counting = (runner: SystemctlRunner) => {
  let calls = 0;
  return { runner: ((args) => { calls++; return runner(args); }) as SystemctlRunner, calls: () => calls };
};

const never: SystemctlRunner = () => { throw new Error("systemctl must not run here"); };
check("a non-systemd launch is silent and probes nothing", detachedSystemdSupervisionWarning({}, never, PID) === undefined);

const simple = unit({ Type: "simple", RemainAfterExit: "no", Id: "cotal-mesh.service", InvocationID: ID, MainPID: String(PID) });
const warning = detachedSystemdSupervisionWarning({ INVOCATION_ID: ID }, simple, PID);
check("a Type=simple unit whose main process is background up warns", warning !== undefined, warning);
check("the warning names the systemd unit", warning?.includes("cotal-mesh.service") === true, warning);
check("the warning names the --foreground remedy", warning?.includes("cotal up --foreground") === true, warning);
check("the warning names the operator guide section", warning?.includes(DETACHED_SUPERVISION_DOC_SECTION) === true, warning);

const oneshot = unit({ Type: "oneshot", RemainAfterExit: "yes", Id: "cotal-mesh.service", InvocationID: ID, MainPID: String(PID) });
check("a oneshot RemainAfterExit unit names its shape",
  detachedSystemdSupervisionWarning({ INVOCATION_ID: ID }, oneshot, PID)?.includes("Type=oneshot with RemainAfterExit=yes") === true);

const reordered = unit({ MainPID: String(PID), InvocationID: ID, Id: "reordered.service", Type: "simple" });
check("property order does not affect detection",
  detachedSystemdSupervisionWarning({ INVOCATION_ID: ID }, reordered, PID)?.includes("reordered.service") === true);

const twoUnits: SystemctlRunner = () => ({ status: 0, stdout: [
  `Type=simple\nId=cotal-mesh.service\nInvocationID=${ID}\nMainPID=${PID}`,
  `Type=simple\nId=unrelated.service\nInvocationID=${OTHER}\nMainPID=1`,
].join("\n\n") });
check("a different invocation does not inherit another unit's warning",
  detachedSystemdSupervisionWarning({ INVOCATION_ID: "0".repeat(32) }, twoUnits, PID) === undefined);

check("an inherited invocation whose main process is another PID is silent",
  detachedSystemdSupervisionWarning({ INVOCATION_ID: ID }, simple, PID + 1) === undefined);

const malformed = counting(simple);
check("a malformed invocation ID is silent and probes nothing",
  detachedSystemdSupervisionWarning({ INVOCATION_ID: "target" }, malformed.runner, PID) === undefined && malformed.calls() === 0, malformed.calls());

check("a scope is not a service unit",
  detachedSystemdSupervisionWarning({ INVOCATION_ID: ID }, unit({ Type: "simple", Id: "session-1.scope", InvocationID: ID, MainPID: String(PID) }), PID) === undefined);

let attempts = 0;
const userFallback: SystemctlRunner = (args) => {
  attempts++;
  return args.includes("--user")
    ? { status: 0, stdout: `Type=simple\nId=cotal-user.service\nInvocationID=${ID}\nMainPID=${PID}\n` }
    : { status: 1, stdout: "" };
};
check("user-service properties are checked after the system manager",
  detachedSystemdSupervisionWarning({ INVOCATION_ID: ID }, userFallback, PID)?.includes("cotal-user.service") === true);
check("system and user scopes are bounded", attempts === 2, attempts);

const unavailable: SystemctlRunner = () => ({ status: null, error: new Error("ENOENT") });
check("an unavailable systemctl is silent", detachedSystemdSupervisionWarning({ INVOCATION_ID: ID }, unavailable, PID) === undefined);

// The public `up` entry: every background run warns; foreground, dry run and manifest boot do not.
const env = { INVOCATION_ID: ID };
check("background up warns", upSystemdSupervisionWarning({}, env, simple, PID)?.includes("cotal-mesh.service") === true);
check("up --detach warns", upSystemdSupervisionWarning({ detach: true }, env, simple, PID) !== undefined);
const foreground = counting(simple);
check("foreground up is silent and probes nothing",
  upSystemdSupervisionWarning({ foreground: true }, env, foreground.runner, PID) === undefined && foreground.calls() === 0, foreground.calls());
check("a dry run is silent", upSystemdSupervisionWarning({ "dry-run": true }, env, simple, PID) === undefined);
check("manifest up, which has no foreground form, is silent", upSystemdSupervisionWarning({ file: "cotal.yaml" }, env, simple, PID) === undefined);
check("the registered up command is the public entry that warns", registry.resolve<Command>("command", "up").run === upCommand);

finish();
