/**
 * Regression for #1332: `up --detach` may warn about the systemd unit that launched it, but must
 * never reject startup or infer a unit without INVOCATION_ID.
 */
import {
  DETACHED_SUPERVISION_DOC_SECTION,
  detachedSystemdSupervisionWarning,
  type SystemctlRunner,
} from "../src/lib/systemd-supervision.js";

let pass = 0;
const check = (name: string, condition: boolean, extra?: unknown) => {
  if (!condition) throw new Error(`FAIL: ${name}${extra === undefined ? "" : ` — ${JSON.stringify(extra)}`}`);
  pass++;
  console.log(`  ✓ ${name}`);
};

const calls: readonly string[][] = [];
const never: SystemctlRunner = (args) => {
  (calls as string[][]).push([...args]);
  throw new Error("systemctl must not run without INVOCATION_ID");
};
check("a non-systemd launch is silent", detachedSystemdSupervisionWarning({}, never) === undefined);
check("a non-systemd launch does no probing", calls.length === 0, calls);

const records = [
  "Type=oneshot\nRemainAfterExit=yes\nId=cotal-mesh.service\nInvocationID=target",
  "Type=simple\nRemainAfterExit=no\nId=unrelated.service\nInvocationID=other",
].join("\n\n");
const matching: SystemctlRunner = () => ({ status: 0, stdout: records });
const warning = detachedSystemdSupervisionWarning({ INVOCATION_ID: "target" }, matching);
check("oneshot RemainAfterExit is detected by invocation", warning !== undefined, warning);
check("warning names the systemd unit", warning?.includes("cotal-mesh.service") === true, warning);
check("warning explains the launcher boundary", warning?.includes("monitors only this launcher") === true, warning);
check("warning names the operator guide section", warning?.includes(DETACHED_SUPERVISION_DOC_SECTION) === true, warning);
check(
  "a different invocation does not inherit another unit's warning",
  detachedSystemdSupervisionWarning({ INVOCATION_ID: "missing" }, matching) === undefined,
);

const remainBeforeType: SystemctlRunner = () => ({
  status: 0,
  stdout: "RemainAfterExit=yes\nInvocationID=target\nId=reordered.service\nType=oneshot\n",
});
check(
  "property order does not affect detection",
  detachedSystemdSupervisionWarning({ INVOCATION_ID: "target" }, remainBeforeType)?.includes("reordered.service") === true,
);

const longRunning: SystemctlRunner = () => ({
  status: 0,
  stdout: "Type=simple\nRemainAfterExit=no\nId=cotal-mesh.service\nInvocationID=target\n",
});
check(
  "a long-running service shape is silent",
  detachedSystemdSupervisionWarning({ INVOCATION_ID: "target" }, longRunning) === undefined,
);

const longRunningWithRemain: SystemctlRunner = () => ({
  status: 0,
  stdout: "Type=simple\nRemainAfterExit=yes\nId=cotal-mesh.service\nInvocationID=target\n",
});
check(
  "RemainAfterExit does not warn for a long-running service type",
  detachedSystemdSupervisionWarning({ INVOCATION_ID: "target" }, longRunningWithRemain) === undefined,
);

const oneshotWithoutRemain: SystemctlRunner = () => ({
  status: 0,
  stdout: "Type=oneshot\nRemainAfterExit=no\nId=cotal-mesh.service\nInvocationID=target\n",
});
check(
  "oneshot without RemainAfterExit is silent",
  detachedSystemdSupervisionWarning({ INVOCATION_ID: "target" }, oneshotWithoutRemain) === undefined,
);

let attempts = 0;
const userFallback: SystemctlRunner = (args) => {
  attempts++;
  return args.includes("--user")
    ? { status: 0, stdout: "Type=oneshot\nRemainAfterExit=yes\nId=cotal-user.service\nInvocationID=target\n" }
    : { status: 1, stdout: "" };
};
check(
  "user-service properties are checked after the system manager",
  detachedSystemdSupervisionWarning({ INVOCATION_ID: "target" }, userFallback)?.includes("cotal-user.service") === true,
);
check("system and user scopes are bounded", attempts === 2, attempts);

const unavailable: SystemctlRunner = () => ({ status: null, error: new Error("ENOENT") });
check(
  "an unavailable systemctl is silent",
  detachedSystemdSupervisionWarning({ INVOCATION_ID: "target" }, unavailable) === undefined,
);

console.log(`PASS systemd supervision warning smoke (${pass} checks)`);
