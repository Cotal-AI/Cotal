/**
 * Startup update-recovery and `systemctl --user start` recovery proofs:
 *
 *  Cell 1: Shared systemd start constants (`DAEMON_SYSTEMD_START_TIMEOUT_SEC === 60`,
 *          `DAEMON_SYSTEMD_START_TIMEOUT_MS === 65_000`, `DAEMON_SYSTEMD_RECOVERY_WAIT_MS === 60_000`)
 *          and `renderDaemonUnit` `TimeoutStartSec=60`.
 *  Cell 2: `nativeStartupUpdateRecoveryParent` and `startupRecoveryChildEnv` predicate matrix:
 *          Linux-only (`darwin` and `win32` always keep `main` behaviour); accepts native Linux
 *          `daemon serve` only when `COTAL_DAEMON_NATIVE_SERVICE === "1"`, `phase === "restoring"`,
 *          and live `owner` matches `ppid` + start token; rejects foreground `daemon serve`,
 *          `cotal update` parent argv, non-`restoring` phases, and dead/reused PIDs.
 *  Cell 3: Built-CLI reconcile child with live native `daemon serve` parent in `restoring` phase skips
 *          `waitForInstalledGeneration` and exits 0 promptly, even with a recorded same-install unit and
 *          no answering `daemon.sock`.
 *  Cell 4: Built-CLI reconcile child with live foreground `cotal daemon serve` parent keeps the wait.
 *  Cell 5: Built-CLI reconcile child with live `cotal update` parent (even with `COTAL_DAEMON_NATIVE_SERVICE=1`
 *          inherited) keeps the wait.
 *  Cell 6: `startSystemdDaemonUnit` passes derived `65_000` ms timeout to `systemctl --user start`,
 *          suspends both `.update-closure.lock` and `service-repair.lock` across `systemctl start` AND
 *          the post-start recovery wait, requires the reply's `version === previous` (rejecting wrong
 *          versions), and returns `{ recoveredVersion: previous }`.
 *  Cell 7: Refusal surface preservation across both styles:
 *          - `"unit-control"` (`startInstalled` / `startEnabledInstalled`) preserves exact
 *            `submitSystemdUnitControl` `OPERATION_UNKNOWN` message, `target: { unit, operation: "start" }`,
 *            `remedy: undefined`, and exit code `3` on non-zero exit AND on timeout/signal.
 *          - `"daemon-restart"` (`restartInstalled`) preserves exact `OPERATION_UNKNOWN` message,
 *            `target: { unit }`, and remedy on non-zero exit across all 6 missing-proof cases, plus
 *            wrong-version timeout.
 *  Cell 8: Bounded, announced lock re-acquisition and failure handling (`claimSuspendableDaemonClosure`
 *          and `claimSuspendableServiceRepairLock`): re-acquires pass `recover = false` and bound
 *          `waitMs` to the remaining recovery budget, announce contended waits on stderr, convert
 *          timeout into a clean `DEPENDENCY_UNAVAILABLE` `CommandFailure` with remedy, and keep outer
 *          `release()` a safe no-op that never throws `TypeError` or masks an earlier failure.
 *  Cell 9: Built-CLI `cotal daemon start --json` end-to-end:
 *          (a) Startup recovery exit (`status !== 0` + `"null\n"` tombstone) followed by `Restart=always`
 *              spawning a real `daemon serve` succeeds with non-enumerable `recoveredVersion` (unchanged
 *              JSON result keys).
 *          (b) Non-recovery `systemctl start` failure preserves `main`'s exact JSON envelope and exit `3`.
 *  Cell 10: Built-CLI `cotal daemon setup --json` PATH-refresh (`restartInstalled`) + version-pin proofs:
 *          (a) PATH-refresh restart taking ~35s (exceeding the old 30s `nativeRun` timeout) + startup
 *              recovery to `previous` version (`"0.182.1"` while CLI is `version`) rewrites unit `PATH`,
 *              suspends `.update-closure.lock` and `service-repair.lock` across both `systemctl start` and
 *              the recovery wait, pins `waitForDaemon` to `"0.182.1"`, and exits `0`.
 *          (b) Version-mismatch restart (`ensureInstalledUnderClosure`) with startup recovery reports
 *              `restarted through its recorded service to load Cotal 0.182.1` (the restored `previous`
 *              version actually loaded, never the interrupted target version).
 *          (c) `refreshServiceForApplication` (desktop agent-app install path) pins post-recovery
 *              `waitForDaemon` to `recoveredVersion`.
 *  Cell 11: Interrupted upgrade from a published-shape previous release (`0.183.1` without
 *           `nativeStartupUpdateRecoveryParent` or `skipStartupRecoveryWait`) to current head:
 *           starting native `daemon serve` from head restores `0.183.1` onto disk and spawns the
 *           restored `0.183.1` reconcile child with `startupRecoveryChildEnv` (`XDG_RUNTIME_DIR="/dev/null"`
 *           in the child copy while parent `process.env.XDG_RUNTIME_DIR` stays untouched), so the
 *           unmodified `0.183.1` child exits `0` promptly without self-waiting 120s in
 *           `waitForInstalledDaemonGeneration` and `update-recovery.json` clears to `"null\n"`.
 */
import { createHash } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import {
  clearUpdateRecovery,
  CommandFailure,
  exitCode,
  inspectLock,
  processStartToken,
  readUpdateRecovery,
  SEEDED_EXTENSIONS,
  writeUpdateRecovery,
  type UpdateRecovery,
} from "@cotal-ai/workspace";
import { createSuite, killAndAwaitExit, skipSuite } from "@cotal-ai/smoke-kit";
import { queryDaemon } from "../daemon/client.js";
import { DAEMON_PROTOCOL_VERSION, daemonPaths } from "../daemon/endpoint.js";
import { renderDaemonUnit, type NativeResult, type NativeRun } from "../daemon/install.js";
import { processBirth } from "../daemon/lifetime.js";
import { serveDaemon } from "../daemon/server.js";
import {
  claimSuspendableDaemonClosure,
  claimSuspendableServiceRepairLock,
  DAEMON_SYSTEMD_RECOVERY_BUDGET_MS,
  DAEMON_SYSTEMD_RECOVERY_WAIT_MS,
  DAEMON_SYSTEMD_START_CALL_MARGIN_SEC,
  DAEMON_SYSTEMD_START_TIMEOUT_MS,
  DAEMON_SYSTEMD_START_TIMEOUT_SEC,
  isDaemonServeArgv,
  nativeStartupUpdateRecoveryParent,
  readParentArgv,
  startSystemdDaemonUnit,
  startupRecoveryChildEnv,
} from "../daemon/startup-recovery.js";

for (const key of Object.keys(process.env)) {
  if (key.startsWith("COTAL_")) delete process.env[key];
}

if (process.platform !== "linux") skipSuite("daemon-startup-recovery: Linux only");

const { check, finish } = createSuite();
const repo = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const cli = join(repo, "bin/dist/cotal.js");
const version = (JSON.parse(readFileSync(join(repo, "bin/package.json"), "utf8")) as { version: string }).version;
const root = realpathSync(mkdtempSync(join(tmpdir(), "dsr-")));

function cleanBaseEnv(directory: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...Object.fromEntries(
      Object.entries(process.env).filter(
        ([key]) => !key.startsWith("COTAL_") && !["NODE_OPTIONS", "NODE_PATH"].includes(key),
      ),
    ),
    USER: process.env.USER || "runner",
    LOGNAME: process.env.LOGNAME || process.env.USER || "runner",
    HOME: join(directory, "home"),
    COTAL_HOME: join(directory, "home", ".cotal"),
    XDG_CONFIG_HOME: join(directory, "config"),
    XDG_RUNTIME_DIR: join(directory, "run"),
    XDG_CACHE_HOME: join(directory, "cache"),
    XDG_DATA_HOME: join(directory, "data"),
    XDG_STATE_HOME: join(directory, "state"),
    TMPDIR: join(directory, "tmp"),
    DO_NOT_TRACK: "1",
    COTAL_TELEMETRY: "off",
    NO_COLOR: "1",
  };
  for (const key of [
    "HOME",
    "COTAL_HOME",
    "XDG_CONFIG_HOME",
    "XDG_RUNTIME_DIR",
    "XDG_CACHE_HOME",
    "XDG_DATA_HOME",
    "XDG_STATE_HOME",
    "TMPDIR",
  ] as const) {
    mkdirSync(env[key]!, { recursive: true, mode: 0o700 });
  }
  return env;
}

function writeSeedState(configDir: string, ver: string): void {
  const seed = join(configDir, "cotal", "seed");
  mkdirSync(seed, { recursive: true, mode: 0o700 });
  const names = Object.keys(SEEDED_EXTENSIONS);
  for (const file of ["authority.json", "authority.bak.json"]) {
    writeFileSync(join(seed, file), JSON.stringify({ everSeeded: names }), { mode: 0o600 });
  }
  writeFileSync(join(seed, "witness.json"), JSON.stringify({ initialized: true, firstGeneration: ver }), { mode: 0o600 });
  writeFileSync(join(seed, "stamp.json"), JSON.stringify({ generation: ver }), { mode: 0o600 });
}

try {
  // ---- Cell 1: Shared TimeoutStartSec=60 and derived 65_000 / 60_000 ms constants ----
  {
    check("TimeoutStartSec constant is 60s", DAEMON_SYSTEMD_START_TIMEOUT_SEC === 60);
    check("start call margin is 5s", DAEMON_SYSTEMD_START_CALL_MARGIN_SEC === 5);
    check("derived systemctl start call timeout is 65_000 ms", DAEMON_SYSTEMD_START_TIMEOUT_MS === 65_000);
    check("derived post-start recovery wait is 60_000 ms", DAEMON_SYSTEMD_RECOVERY_WAIT_MS === 60_000);
    check("derived total recovery budget is 125_000 ms", DAEMON_SYSTEMD_RECOVERY_BUDGET_MS === 125_000);
    const savedArgv1 = process.argv[1];
    const savedExecArgv = process.execArgv;
    const savedPath = process.env.PATH;
    let rendered: ReturnType<typeof renderDaemonUnit>;
    try {
      process.argv[1] = cli;
      process.execArgv = [];
      process.env.PATH = (savedPath ?? "/usr/local/bin:/usr/bin:/bin")
        .split(":")
        .filter((entry) => isAbsolute(entry))
        .join(":");
      rendered = renderDaemonUnit(join(root, "unit-check"), undefined);
    } finally {
      process.argv[1] = savedArgv1;
      process.execArgv = savedExecArgv;
      if (savedPath === undefined) delete process.env.PATH;
      else process.env.PATH = savedPath;
    }
    check(
      "renderDaemonUnit writes TimeoutStartSec=60 from shared constant",
      rendered.bytes.includes(`\nTimeoutStartSec=${DAEMON_SYSTEMD_START_TIMEOUT_SEC}\n`),
    );
  }

  // ---- Cell 2: nativeStartupUpdateRecoveryParent predicate matrix (Linux-only) ----
  {
    const baseRecord: UpdateRecovery = {
      v: 1,
      previous: "0.182.1",
      target: "0.183.1",
      installed: "0.182.1",
      phase: "restoring",
      owner: { pid: 4242, start: "98765", nonce: "nonce-1" },
      snapshot: join(root, "snap"),
      reason: "interrupted update",
      recordedAt: new Date().toISOString(),
    };
    const baseEnv: NodeJS.ProcessEnv = {
      COTAL_DAEMON_NATIVE_SERVICE: "1",
      COTAL_UPDATE_PARENT: "4242",
      COTAL_UPDATE_CLOSURE_NONCE: "nonce-1",
      COTAL_UPDATE_CLOSURE_START: "98765",
    };

    check(
      "accepts native Linux daemon serve restoring parent",
      nativeStartupUpdateRecoveryParent(baseRecord, {
        env: baseEnv,
        ppid: 4242,
        platform: "linux",
        ownerStart: () => "98765",
        parentArgv: () => ["/usr/bin/node", "/opt/cotal/dist/cotal.js", "daemon", "serve"],
      }),
    );
    check(
      "rejects macOS (darwin) so non-Linux platforms keep main behaviour",
      !nativeStartupUpdateRecoveryParent(baseRecord, {
        env: baseEnv,
        ppid: 4242,
        platform: "darwin",
        ownerStart: () => "98765",
        parentArgv: () => ["/usr/local/bin/node", "/opt/cotal/dist/cotal.js", "daemon", "serve"],
      }) &&
        readParentArgv(process.pid, "darwin") === undefined &&
        !isDaemonServeArgv(["/usr/local/bin/node", "/opt/cotal/dist/cotal.js", "daemon", "serve"], "darwin"),
    );
    check(
      "rejects Windows (win32) so non-Linux platforms keep main behaviour",
      !nativeStartupUpdateRecoveryParent(baseRecord, {
        env: baseEnv,
        ppid: 4242,
        platform: "win32",
        ownerStart: () => "98765",
        parentArgv: () => ["C:\\Program Files\\nodejs\\node.exe", "C:\\cotal\\dist\\daemon-native.js", "daemon", "serve"],
      }) &&
        readParentArgv(process.pid, "win32") === undefined &&
        !isDaemonServeArgv(["C:\\Users\\u\\AppData\\Local\\Cotal\\cotal-desktop.exe", "--daemon"], "win32"),
    );
    check(
      "rejects foreground daemon serve without COTAL_DAEMON_NATIVE_SERVICE=1",
      !nativeStartupUpdateRecoveryParent(baseRecord, {
        env: { ...baseEnv, COTAL_DAEMON_NATIVE_SERVICE: undefined },
        ppid: 4242,
        platform: "linux",
        ownerStart: () => "98765",
        parentArgv: () => ["/usr/bin/node", "/opt/cotal/dist/cotal.js", "daemon", "serve"],
      }),
    );
    check(
      "rejects cotal update --self parent even when COTAL_DAEMON_NATIVE_SERVICE=1 is set",
      !nativeStartupUpdateRecoveryParent(baseRecord, {
        env: baseEnv,
        ppid: 4242,
        platform: "linux",
        ownerStart: () => "98765",
        parentArgv: () => ["/usr/bin/node", "/opt/cotal/dist/cotal.js", "update", "--self"],
      }),
    );
    check(
      "rejects update argv mentioning daemon serve after update token",
      !isDaemonServeArgv(["/usr/bin/node", "/opt/cotal/dist/cotal.js", "update", "daemon", "serve"], "linux"),
    );
    for (const phase of ["replacing", "verified-ready", "paused"] as const) {
      check(
        `rejects non-restoring phase ${phase}`,
        !nativeStartupUpdateRecoveryParent(
          { ...baseRecord, phase },
          {
            env: baseEnv,
            ppid: 4242,
            platform: "linux",
            ownerStart: () => "98765",
            parentArgv: () => ["/usr/bin/node", "/opt/cotal/dist/cotal.js", "daemon", "serve"],
          },
        ),
      );
    }
    check(
      "rejects owner start token mismatch (PID reuse)",
      !nativeStartupUpdateRecoveryParent(baseRecord, {
        env: baseEnv,
        ppid: 4242,
        platform: "linux",
        ownerStart: () => "11111",
        parentArgv: () => ["/usr/bin/node", "/opt/cotal/dist/cotal.js", "daemon", "serve"],
      }),
    );
    check(
      "rejects dead or unreadable parent start token",
      !nativeStartupUpdateRecoveryParent(baseRecord, {
        env: baseEnv,
        ppid: 4242,
        platform: "linux",
        ownerStart: () => undefined,
        parentArgv: () => ["/usr/bin/node", "/opt/cotal/dist/cotal.js", "daemon", "serve"],
      }),
    );
    check(
      "readParentArgv reads live Linux /proc/<pid>/cmdline tokens",
      Array.isArray(readParentArgv(process.pid, "linux")) && readParentArgv(process.pid, "linux")!.length >= 2,
    );
    const parentOrig: NodeJS.ProcessEnv = { COTAL_DAEMON_NATIVE_SERVICE: "1", XDG_RUNTIME_DIR: "/run/user/1000" };
    const nativeChildEnv = startupRecoveryChildEnv(parentOrig, "linux");
    check(
      "startupRecoveryChildEnv sets XDG_RUNTIME_DIR=/dev/null on native Linux copy without mutating parent env",
      nativeChildEnv.XDG_RUNTIME_DIR === "/dev/null" && parentOrig.XDG_RUNTIME_DIR === "/run/user/1000",
    );
    check(
      "startupRecoveryChildEnv leaves foreground Linux and non-Linux env unchanged",
      startupRecoveryChildEnv({ XDG_RUNTIME_DIR: "/run/user/1000" }, "linux").XDG_RUNTIME_DIR === "/run/user/1000" &&
        startupRecoveryChildEnv(parentOrig, "darwin").XDG_RUNTIME_DIR === "/run/user/1000" &&
        startupRecoveryChildEnv(parentOrig, "win32").XDG_RUNTIME_DIR === "/run/user/1000",
    );
  }

  // ---- Helper to test built-CLI reconcile child behavior under a controlled live parent ----
  async function runBoundReconcileUnderParent(opts: {
    label: string;
    parentArgvTail: string[];
    nativeMarker: boolean;
  }): Promise<{ code: number | null; signal: NodeJS.Signals | null; output: string; elapsedMs: number }> {
    const dir = join(root, opts.label);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const env = cleanBaseEnv(dir);
    writeSeedState(env.XDG_CONFIG_HOME!, version);
    const nativeBin = join(dir, "native");
    mkdirSync(nativeBin, { mode: 0o700 });
    env.PATH = `${nativeBin}:/usr/local/bin:/usr/bin:/bin`;

    const paths = daemonPaths(env, env.COTAL_HOME!);
    mkdirSync(paths.state, { recursive: true, mode: 0o700 });
    const unitDir = join(env.XDG_CONFIG_HOME!, "systemd", "user");
    mkdirSync(unitDir, { recursive: true, mode: 0o700 });
    const unitPath = join(unitDir, "cotal-daemon.service");
    const unitBytes = [
      "[Unit]",
      "Description=Cotal machine daemon",
      "",
      "[Service]",
      "Type=notify",
      "NotifyAccess=all",
      "TimeoutStartSec=60",
      `Environment=PATH="${env.PATH}"`,
      "Environment=COTAL_DAEMON_NATIVE_SERVICE=1",
      `ExecStart="${process.execPath}" "${cli}" "daemon" "serve"`,
      "Restart=always",
      "",
    ].join("\n");
    writeFileSync(unitPath, unitBytes, { mode: 0o600 });
    writeFileSync(
      join(paths.state, "service-unit.json"),
      JSON.stringify({
        v: 1,
        mechanism: "systemd-user",
        unit: "cotal-daemon.service",
        unitPath,
        unitSha256: createHash("sha256").update(unitBytes).digest("hex"),
        installedAt: new Date().toISOString(),
      }),
      { mode: 0o600 },
    );

    writeFileSync(
      join(nativeBin, "systemctl"),
      `#!${process.execPath}
const args = process.argv.slice(2);
if (args.join(" ") === "--user show-environment") {
  console.log(${JSON.stringify(`XDG_CONFIG_HOME=${env.XDG_CONFIG_HOME}`)});
  process.exit(0);
}
if (args.some(a => a.includes("UnitFileState"))) {
  console.log("disabled");
  process.exit(0);
}
process.exit(0);
`,
      { mode: 0o700 },
    );

    const workspaceHref = new URL("../../packages/workspace/dist/index.js", import.meta.url).href;
    const parentDriver = join(dir, "parent-driver.mjs");
    writeFileSync(
      parentDriver,
      `import { spawn } from "node:child_process";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
const { claimUpdateClosureAccess, updateClosureChildEnv, updateClosureOwner, writeUpdateRecovery } = await import(${JSON.stringify(workspaceHref)});
const snapshot = join(process.env.XDG_CONFIG_HOME, "cotal", ".update-snapshot-cell");
mkdirSync(snapshot, { recursive: true, mode: 0o700 });
const release = claimUpdateClosureAccess();
writeUpdateRecovery({
  previous: ${JSON.stringify(version)},
  target: ${JSON.stringify(version)},
  installed: ${JSON.stringify(version)},
  phase: "restoring",
  reason: "interrupted update test",
  owner: updateClosureOwner(),
  preparedRestart: false,
  snapshot,
});
const childEnv = {
  ...updateClosureChildEnv(process.env),
  COTAL_UPDATE_TARGET_VERSION: ${JSON.stringify(version)},
  COTAL_UPDATE_PARENT: String(process.pid),
  COTAL_ALLOW_CHECKOUT_SEED: "1",
  COTAL_SKIP_CONNECTOR_SEED: "1",
};
const child = spawn(${JSON.stringify(process.execPath)}, [${JSON.stringify(cli)}, "update"], {
  cwd: ${JSON.stringify(dir)},
  env: childEnv,
  stdio: ["ignore", "pipe", "pipe"],
  timeout: 30_000,
  killSignal: "SIGKILL",
});
child.stdout.on("data", chunk => process.stdout.write(chunk));
child.stderr.on("data", chunk => process.stderr.write(chunk));
const code = await new Promise(resolve => child.once("close", resolve));
release();
process.exit(code ?? 1);
`,
      { mode: 0o600 },
    );

    const parentEnv: NodeJS.ProcessEnv = {
      ...env,
      ...(opts.nativeMarker ? { COTAL_DAEMON_NATIVE_SERVICE: "1" } : {}),
    };
    const started = Date.now();
    const parent = spawn(process.execPath, [parentDriver, ...opts.parentArgvTail], {
      cwd: dir,
      env: parentEnv,
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 35_000,
      killSignal: "SIGKILL",
    });
    let output = "";
    parent.stdout.on("data", (chunk) => {
      output += String(chunk);
    });
    parent.stderr.on("data", (chunk) => {
      output += String(chunk);
    });
    const exited = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) =>
      parent.once("close", (code, signal) => resolve({ code, signal })),
    );
    return { ...exited, output, elapsedMs: Date.now() - started };
  }

  // ---- Cell 3: Built-CLI reconcile child under native `daemon serve` parent skips wait ----
  {
    const res = await runBoundReconcileUnderParent({
      label: "cell3-native-serve",
      parentArgvTail: ["daemon", "serve"],
      nativeMarker: true,
    });
    check("native daemon serve startup-recovery child exits 0", res.code === 0, res);
    check(
      "native daemon serve startup-recovery child skips waitForInstalledDaemonGeneration",
      !res.output.includes("waiting up to 120s for Cotal") &&
        !res.output.includes("cotal-daemon.service: service is disabled"),
      res.output,
    );
  }

  // ---- Cell 4: Built-CLI reconcile child under foreground `daemon serve` parent keeps wait ----
  {
    const res = await runBoundReconcileUnderParent({
      label: "cell4-foreground-serve",
      parentArgvTail: ["daemon", "serve"],
      nativeMarker: false,
    });
    check("foreground daemon serve child exits 0", res.code === 0, res);
    check(
      "foreground daemon serve child still runs waitForInstalledDaemonGeneration",
      res.output.includes("waiting up to 120s for Cotal") &&
        res.output.includes("cotal-daemon.service: service is disabled; not started"),
      res.output,
    );
  }

  // ---- Cell 5: Built-CLI reconcile child under `cotal update` parent (even with native marker) keeps wait ----
  {
    const res = await runBoundReconcileUnderParent({
      label: "cell5-update-parent",
      parentArgvTail: ["update", "--self"],
      nativeMarker: true,
    });
    check("cotal update parent child exits 0", res.code === 0, res);
    check(
      "cotal update parent child still runs waitForInstalledDaemonGeneration even with native marker",
      res.output.includes("waiting up to 120s for Cotal") &&
        res.output.includes("cotal-daemon.service: service is disabled; not started"),
      res.output,
    );
  }

  // ---- Cell 6: startSystemdDaemonUnit derived 65_000ms timeout, lock suspension across start + wait, and previous-version pin ----
  {
    const dir = join(root, "cell6-start-recovery");
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const env = cleanBaseEnv(dir);
    const savedCotalHome = process.env.COTAL_HOME;
    const savedXdgConfig = process.env.XDG_CONFIG_HOME;
    const savedXdgRuntime = process.env.XDG_RUNTIME_DIR;
    process.env.COTAL_HOME = env.COTAL_HOME;
    process.env.XDG_CONFIG_HOME = env.XDG_CONFIG_HOME;
    process.env.XDG_RUNTIME_DIR = env.XDG_RUNTIME_DIR;

    const paths = daemonPaths(env, env.COTAL_HOME!);
    mkdirSync(paths.state, { recursive: true, mode: 0o700 });
    const snapshot = join(env.XDG_CONFIG_HOME!, "cotal", ".update-snapshot-cell6");
    mkdirSync(snapshot, { recursive: true, mode: 0o700 });

    writeUpdateRecovery({
      previous: "0.182.1",
      target: version,
      installed: version,
      phase: "verified-ready",
      reason: "global replacement in progress",
      owner: { pid: 2_147_483_646, start: "dead-owner-token", nonce: "dead-nonce" },
      preparedRestart: false,
      snapshot,
    });

    const callerClosure = claimSuspendableDaemonClosure();
    const serviceRepairLockPath = join(paths.state, "service-repair.lock");
    const serviceLock = await claimSuspendableServiceRepairLock(serviceRepairLockPath, true);
    let closureFreeDuringStart = false;
    let serviceLockFreeDuringStart = false;
    let closureFreeDuringWaitPoll = false;
    let serviceLockFreeDuringWaitPoll = false;
    let startCallTimeoutMs: number | undefined;
    let currentMainPid = 0;
    let started = false;
    let recoveredDaemon: Awaited<ReturnType<typeof serveDaemon>> | undefined;

    try {
      const fakeRun: NativeRun = (_file, args, _runEnv, timeoutMs): NativeResult => {
        if (args.includes("start")) {
          started = true;
          startCallTimeoutMs = timeoutMs;
          closureFreeDuringStart = inspectLock(join(env.COTAL_HOME!, ".update-closure.lock")).state === "absent";
          serviceLockFreeDuringStart = inspectLock(serviceRepairLockPath).state === "absent";
          clearUpdateRecovery();
          setTimeout(() => {
            void serveDaemon({
              paths,
              version: "0.182.1",
              sessionDir: paths.state,
            }).then((srv) => {
              recoveredDaemon = srv;
              currentMainPid = process.pid;
            });
          }, 90);
          return {
            status: 1,
            stdout: "",
            detail: "Job for cotal-daemon.service failed because the control process exited with error code.",
          };
        }
        if (args.includes("show")) {
          if (started) {
            closureFreeDuringWaitPoll = inspectLock(join(env.COTAL_HOME!, ".update-closure.lock")).state === "absent";
            serviceLockFreeDuringWaitPoll = inspectLock(serviceRepairLockPath).state === "absent";
          }
          return {
            status: 0,
            stdout: `ActiveState=${currentMainPid > 0 ? "active" : "activating"}\nMainPID=${currentMainPid}\n`,
            detail: "",
          };
        }
        return { status: 0, stdout: "", detail: "" };
      };

      const outcome = await startSystemdDaemonUnit(paths, undefined, "cotal-daemon.service", {
        run: fakeRun,
        refusalStyle: "daemon-restart",
        serviceEnv: env,
        homeDir: env.COTAL_HOME!,
        lookupOwner: () => undefined,
        suspendServiceLock: serviceLock.suspend,
        waitMs: 10_000,
        pollMs: 40,
        birth: processBirth,
      });

      check("startSystemdDaemonUnit passes derived 65_000 ms timeout to systemctl start", startCallTimeoutMs === 65_000, startCallTimeoutMs);
      check("suspends .update-closure.lock during systemctl start", closureFreeDuringStart);
      check("suspends service-repair.lock during systemctl start", serviceLockFreeDuringStart);
      check("keeps .update-closure.lock suspended across the post-start recovery wait loop", closureFreeDuringWaitPoll);
      check("keeps service-repair.lock suspended across the post-start recovery wait loop", serviceLockFreeDuringWaitPoll);
      check(
        "reacquires both .update-closure.lock and service-repair.lock before returning",
        inspectLock(join(env.COTAL_HOME!, ".update-closure.lock")).state === "active" &&
          inspectLock(serviceRepairLockPath).state === "active",
      );
      check("returns recoveredVersion === previous ('0.182.1')", outcome.recoveredVersion === "0.182.1", outcome);
      check("readUpdateRecovery() is undefined after recovery", readUpdateRecovery() === undefined);
      const reply = await queryDaemon({ paths, timeoutMs: 2_000 });
      check("restored daemon answers daemon.sock at previous version", reply.ok && reply.result.version === "0.182.1", reply);
    } finally {
      serviceLock.release();
      callerClosure.release();
      await recoveredDaemon?.close();
      if (savedCotalHome === undefined) delete process.env.COTAL_HOME;
      else process.env.COTAL_HOME = savedCotalHome;
      if (savedXdgConfig === undefined) delete process.env.XDG_CONFIG_HOME;
      else process.env.XDG_CONFIG_HOME = savedXdgConfig;
      if (savedXdgRuntime === undefined) delete process.env.XDG_RUNTIME_DIR;
      else process.env.XDG_RUNTIME_DIR = savedXdgRuntime;
    }
  }

  // ---- Cell 7: Refusal surface preservation across unit-control and daemon-restart styles + wrong-version rejection ----
  {
    const dir = join(root, "cell7-refusals");
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const env = cleanBaseEnv(dir);
    const savedCotalHome = process.env.COTAL_HOME;
    const savedXdgConfig = process.env.XDG_CONFIG_HOME;
    const savedXdgRuntime = process.env.XDG_RUNTIME_DIR;
    process.env.COTAL_HOME = env.COTAL_HOME;
    process.env.XDG_CONFIG_HOME = env.XDG_CONFIG_HOME;
    process.env.XDG_RUNTIME_DIR = env.XDG_RUNTIME_DIR;

    const paths = daemonPaths(env, env.COTAL_HOME!);
    mkdirSync(paths.state, { recursive: true, mode: 0o700 });
    const snapshot = join(env.XDG_CONFIG_HOME!, "cotal", ".update-snapshot-cell7");
    mkdirSync(snapshot, { recursive: true, mode: 0o700 });
    const detail = "owned native start denied";
    const expectedRestartMessage = `the native daemon start did not confirm completion (${detail}); it was not retried`;
    const expectedControlMessage = "the native start request did not confirm completion; it was not retried";

    try {
      const cases: Array<{
        name: string;
        setup: () => void;
        onStart?: () => void;
        lookupOwner?: (pid: number) => string | undefined;
      }> = [
        {
          name: "no update-recovery.json before start",
          setup: () => {
            rmSync(join(env.COTAL_HOME!, "update-recovery.json"), { force: true });
          },
        },
        {
          name: "raw null tombstone already present before start",
          setup: () => {
            clearUpdateRecovery();
          },
        },
        {
          name: "paused phase before start",
          setup: () => {
            writeUpdateRecovery({
              previous: "0.182.1",
              target: version,
              installed: version,
              phase: "paused",
              reason: "paused",
              owner: { pid: 999999, start: "dead", nonce: "n1" },
              snapshot,
            });
          },
          onStart: () => clearUpdateRecovery(),
        },
        {
          name: "live active owner before start",
          setup: () => {
            writeUpdateRecovery({
              previous: "0.182.1",
              target: version,
              installed: version,
              phase: "replacing",
              reason: "active updater",
              owner: { pid: process.pid, start: processStartToken(process.pid)!, nonce: "n2" },
              snapshot,
            });
          },
          onStart: () => clearUpdateRecovery(),
          lookupOwner: (pid) => processStartToken(pid),
        },
        {
          name: "restorable before start, but post-start record is paused instead of null tombstone",
          setup: () => {
            writeUpdateRecovery({
              previous: "0.182.1",
              target: version,
              installed: version,
              phase: "replacing",
              reason: "interrupted",
              owner: { pid: 999998, start: "dead", nonce: "n3" },
              snapshot,
            });
          },
          onStart: () => {
            writeUpdateRecovery({
              previous: "0.182.1",
              target: version,
              installed: version,
              phase: "paused",
              reason: "interrupted update restore failed",
              owner: { pid: 999998, start: "dead", nonce: "n3" },
              snapshot,
            });
          },
        },
        {
          name: "restorable before start, but update-recovery.json was unlinked instead of null tombstone",
          setup: () => {
            writeUpdateRecovery({
              previous: "0.182.1",
              target: version,
              installed: version,
              phase: "verified-ready",
              reason: "interrupted",
              owner: { pid: 999997, start: "dead", nonce: "n4" },
              snapshot,
            });
          },
          onStart: () => {
            rmSync(join(env.COTAL_HOME!, "update-recovery.json"), { force: true });
          },
        },
      ];

      for (const cell of cases) {
        for (const style of ["daemon-restart", "unit-control"] as const) {
          cell.setup();
          let showPollsAfterStart = 0;
          let started = false;
          const fakeRun: NativeRun = (_file, args): NativeResult => {
            if (args.includes("start")) {
              started = true;
              cell.onStart?.();
              return { status: 1, stdout: "", detail };
            }
            if (started && args.includes("show")) showPollsAfterStart++;
            return { status: 0, stdout: "ActiveState=inactive\nMainPID=0\n", detail: "" };
          };
          let caught: unknown;
          try {
            await startSystemdDaemonUnit(paths, undefined, "cotal-daemon.service", {
              run: fakeRun,
              refusalStyle: style,
              serviceEnv: env,
              homeDir: env.COTAL_HOME!,
              lookupOwner: cell.lookupOwner ?? (() => undefined),
              waitMs: 400,
              pollMs: 40,
            });
          } catch (error) {
            caught = error;
          }
          if (style === "daemon-restart") {
            check(
              `daemon-restart refusal (${cell.name}): preserves exact message, target, remedy, exit 3 without polling`,
              caught instanceof CommandFailure &&
                caught.outcome === "unknown" &&
                caught.code === "OPERATION_UNKNOWN" &&
                exitCode(caught.outcome, caught.code) === 3 &&
                caught.message === expectedRestartMessage &&
                JSON.stringify(caught.target) === JSON.stringify({ unit: "cotal-daemon.service" }) &&
                caught.remedy === "correct the native service error, then run `cotal daemon start`" &&
                showPollsAfterStart === 0,
              { caught, showPollsAfterStart },
            );
          } else {
            check(
              `unit-control refusal (${cell.name}): preserves exact submitSystemdUnitControl message, target {unit,operation}, no remedy, exit 3`,
              caught instanceof CommandFailure &&
                caught.outcome === "unknown" &&
                caught.code === "OPERATION_UNKNOWN" &&
                exitCode(caught.outcome, caught.code) === 3 &&
                caught.message === expectedControlMessage &&
                JSON.stringify(caught.target) === JSON.stringify({ unit: "cotal-daemon.service", operation: "start" }) &&
                caught.remedy === undefined &&
                showPollsAfterStart === 0,
              { caught, showPollsAfterStart },
            );
          }
        }
      }

      // Timeout/signal under unit-control still maps to OPERATION_UNKNOWN exit 3 (never exit 2)
      rmSync(join(env.COTAL_HOME!, "update-recovery.json"), { force: true });
      let timeoutCaught: unknown;
      try {
        await startSystemdDaemonUnit(paths, undefined, "cotal-daemon.service", {
          run: () => {
            throw new CommandFailure("refused", "DEPENDENCY_UNAVAILABLE", "systemctl timed out after 65 s", {
              native: { code: "ETIMEDOUT" },
            });
          },
          refusalStyle: "unit-control",
          serviceEnv: env,
          homeDir: env.COTAL_HOME!,
        });
      } catch (error) {
        timeoutCaught = error;
      }
      check(
        "unit-control timeout preserves OPERATION_UNKNOWN exit 3 (never changes exit status to 2)",
        timeoutCaught instanceof CommandFailure &&
          timeoutCaught.outcome === "unknown" &&
          timeoutCaught.code === "OPERATION_UNKNOWN" &&
          exitCode(timeoutCaught.outcome, timeoutCaught.code) === 3 &&
          timeoutCaught.message === expectedControlMessage &&
          JSON.stringify(timeoutCaught.target) === JSON.stringify({ unit: "cotal-daemon.service", operation: "start" }) &&
          timeoutCaught.remedy === undefined,
        timeoutCaught,
      );

      // Wrong-version daemon after proven tombstone is rejected (never accepted)
      writeUpdateRecovery({
        previous: "0.182.1",
        target: version,
        installed: version,
        phase: "verified-ready",
        reason: "interrupted",
        owner: { pid: 999996, start: "dead", nonce: "n5" },
        snapshot,
      });
      let wrongDaemon: Awaited<ReturnType<typeof serveDaemon>> | undefined;
      let wrongPid = 0;
      let wrongCaught: unknown;
      try {
        await startSystemdDaemonUnit(paths, undefined, "cotal-daemon.service", {
          run: (_file, args) => {
            if (args.includes("start")) {
              clearUpdateRecovery();
              setTimeout(() => {
                void serveDaemon({ paths, version: "0.999.0", sessionDir: paths.state }).then((srv) => {
                  wrongDaemon = srv;
                  wrongPid = process.pid;
                });
              }, 20);
              return { status: 1, stdout: "", detail };
            }
            return { status: 0, stdout: `ActiveState=${wrongPid > 0 ? "active" : "activating"}\nMainPID=${wrongPid}\n`, detail: "" };
          },
          refusalStyle: "daemon-restart",
          serviceEnv: env,
          homeDir: env.COTAL_HOME!,
          lookupOwner: () => undefined,
          waitMs: 350,
          pollMs: 40,
          birth: processBirth,
        });
      } catch (error) {
        wrongCaught = error;
      } finally {
        await wrongDaemon?.close();
      }
      check(
        "startSystemdDaemonUnit rejects a post-recovery daemon answering at a version other than record.previous",
        wrongCaught instanceof CommandFailure &&
          wrongCaught.outcome === "unknown" &&
          wrongCaught.code === "OPERATION_UNKNOWN",
        wrongCaught,
      );
    } finally {
      if (savedCotalHome === undefined) delete process.env.COTAL_HOME;
      else process.env.COTAL_HOME = savedCotalHome;
      if (savedXdgConfig === undefined) delete process.env.XDG_CONFIG_HOME;
      else process.env.XDG_CONFIG_HOME = savedXdgConfig;
      if (savedXdgRuntime === undefined) delete process.env.XDG_RUNTIME_DIR;
      else process.env.XDG_RUNTIME_DIR = savedXdgRuntime;
    }
  }

  // ---- Cell 8: Bounded, announced lock re-acquisition and failure handling ----
  {
    // (a) Closure re-acquire enforces remaining budget via bounded inspection before claim(true), and converts failure into clean CommandFailure refusal
    const closureCallArgs: Array<boolean | undefined> = [];
    const closureScopeA = claimSuspendableDaemonClosure({
      env: {},
      lockFile: "/nonexistent/closure.lock",
      inspect: () => ({ state: "absent" }),
      readRecovery: () => undefined,
      claim: (recover) => {
        closureCallArgs.push(recover);
        if (closureCallArgs.length > 1) throw new Error("closure writer pid 77777 did not finish within 1 seconds");
        return () => {};
      },
    });
    let reacquireErrA: unknown;
    try {
      await closureScopeA.suspend(async () => "ok", () => 1_250);
    } catch (error) {
      reacquireErrA = error;
    } finally {
      closureScopeA.release();
    }
    check(
      "closure re-acquire inspects bounded budget and re-claims with recover=true",
      closureCallArgs.length === 2 && closureCallArgs[0] === undefined && closureCallArgs[1] === true,
      closureCallArgs,
    );
    check(
      "closure re-acquire failure after inner success throws DEPENDENCY_UNAVAILABLE refusal with remedy and safe release()",
      reacquireErrA instanceof CommandFailure &&
        reacquireErrA.outcome === "refused" &&
        reacquireErrA.code === "DEPENDENCY_UNAVAILABLE" &&
        reacquireErrA.message.includes("could not reacquire the Cotal update closure lock") &&
        typeof reacquireErrA.remedy === "string" &&
        reacquireErrA.remedy.length > 0,
      reacquireErrA,
    );

    // (b) Closure re-acquire fails after inner fn() threw -> original refusal is preserved and scope.release() never throws TypeError
    let closureClaimsB = 0;
    const primaryFailure = new CommandFailure("unknown", "OPERATION_UNKNOWN", "primary start failure");
    const closureScopeB = claimSuspendableDaemonClosure({
      env: {},
      lockFile: "/nonexistent/closure.lock",
      inspect: () => ({ state: "absent" }),
      readRecovery: () => undefined,
      claim: () => {
        closureClaimsB++;
        if (closureClaimsB > 1) throw new Error("closure lock wedged");
        return () => {};
      },
    });
    let caughtB: unknown;
    let releaseThrewB = false;
    try {
      try {
        await closureScopeB.suspend(async () => {
          throw primaryFailure;
        }, () => 500);
      } finally {
        try {
          closureScopeB.release();
        } catch {
          releaseThrewB = true;
        }
      }
    } catch (error) {
      caughtB = error;
    }
    check(
      "closure re-acquire failure after inner throw preserves primary refusal without TypeError on release()",
      caughtB === primaryFailure && !releaseThrewB,
      { caughtB, releaseThrewB },
    );

    // (c) Real contended .update-closure.lock re-acquire announces wait on stderr and enforces short remaining budget instead of blocking 300s
    const dir8c = join(root, "cell8c-contended-closure");
    mkdirSync(dir8c, { recursive: true, mode: 0o700 });
    const savedCotalHome8 = process.env.COTAL_HOME;
    process.env.COTAL_HOME = dir8c;
    const origConsoleError = console.error;
    const announcedLines: string[] = [];
    console.error = (...args: unknown[]) => {
      announcedLines.push(args.map(String).join(" "));
    };
    let foreignChild: ReturnType<typeof spawn> | undefined;
    try {
      const realScope = claimSuspendableDaemonClosure();
      let contendedErr: unknown;
      const contendedStart = Date.now();
      try {
        await realScope.suspend(
          async () => {
            // Spawn a separate process holding .update-closure.lock for >1.5s while suspended
            const workspaceHref = new URL("../../packages/workspace/dist/index.js", import.meta.url).href;
            foreignChild = spawn(
              process.execPath,
              [
                "--input-type=module",
                "-e",
                `const { acquireLock } = await import(${JSON.stringify(workspaceHref)});
                 const lock = acquireLock(${JSON.stringify(join(dir8c, ".update-closure.lock"))}, { waitMs: 1000 });
                 process.stdout.write("HELD\\n");
                 setTimeout(() => { lock.release(); process.exit(0); }, 4000);`,
              ],
              {
                cwd: dir8c,
                env: { ...process.env, COTAL_HOME: dir8c },
                stdio: ["ignore", "pipe", "pipe"],
                timeout: 10_000,
                killSignal: "SIGKILL",
              },
            );
            await new Promise<void>((resolve, reject) => {
              foreignChild!.once("error", reject);
              foreignChild!.stdout!.on("data", (chunk) => {
                if (String(chunk).includes("HELD")) resolve();
              });
            });
            return "ok";
          },
          () => 1_250,
        );
      } catch (error) {
        contendedErr = error;
      } finally {
        realScope.release();
      }
      const contendedElapsed = Date.now() - contendedStart;
      check(
        "contended .update-closure.lock re-acquire announces writer wait on stderr and fails within remaining budget (<4s, never 300s)",
        contendedErr instanceof CommandFailure &&
          contendedErr.code === "DEPENDENCY_UNAVAILABLE" &&
          contendedElapsed >= 1_000 &&
          contendedElapsed < 4_000 &&
          announcedLines.some((line) => line.includes("waiting for another cotal command")),
        { contendedErr, contendedElapsed, announcedLines },
      );
    } finally {
      console.error = origConsoleError;
      if (foreignChild) await killAndAwaitExit(foreignChild, "SIGKILL");
      if (savedCotalHome8 === undefined) delete process.env.COTAL_HOME;
      else process.env.COTAL_HOME = savedCotalHome8;
    }

    // (d) Contended service-repair.lock re-acquire announces wait, respects remaining budget, and converts timeout into clean CommandFailure refusal
    const serviceLockFile = join(root, "contended-service-repair.lock");
    const serviceAnnouncements: string[] = [];
    let foreignServiceChild: ReturnType<typeof spawn> | undefined;
    try {
      const serviceScope = await claimSuspendableServiceRepairLock(serviceLockFile, true, {
        onWait: () => {
          serviceAnnouncements.push("waiting for another daemon service operation to finish");
        },
      });
      let serviceReacquireErr: unknown;
      const serviceStart = Date.now();
      try {
        await serviceScope.suspend(
          async () => {
            const workspaceHref = new URL("../../packages/workspace/dist/index.js", import.meta.url).href;
            foreignServiceChild = spawn(
              process.execPath,
              [
                "--input-type=module",
                "-e",
                `const { acquireLock } = await import(${JSON.stringify(workspaceHref)});
                 const lock = acquireLock(${JSON.stringify(serviceLockFile)}, { waitMs: 1000 });
                 process.stdout.write("HELD\\n");
                 setTimeout(() => { lock.release(); process.exit(0); }, 4000);`,
              ],
              {
                cwd: root,
                env: process.env,
                stdio: ["ignore", "pipe", "pipe"],
                timeout: 10_000,
                killSignal: "SIGKILL",
              },
            );
            await new Promise<void>((resolve, reject) => {
              foreignServiceChild!.once("error", reject);
              foreignServiceChild!.stdout!.on("data", (chunk) => {
                if (String(chunk).includes("HELD")) resolve();
              });
            });
            return "ok";
          },
          () => 450,
        );
      } catch (error) {
        serviceReacquireErr = error;
      } finally {
        serviceScope.release();
      }
      const serviceElapsed = Date.now() - serviceStart;
      check(
        "service-repair.lock re-acquire announces wait, bounds waitMs to remaining budget (<3s, never 300s), and throws DEPENDENCY_UNAVAILABLE with remedy",
        serviceReacquireErr instanceof CommandFailure &&
          serviceReacquireErr.outcome === "refused" &&
          serviceReacquireErr.code === "DEPENDENCY_UNAVAILABLE" &&
          serviceReacquireErr.message.includes("could not reacquire the daemon service lock") &&
          typeof serviceReacquireErr.remedy === "string" &&
          serviceReacquireErr.remedy.length > 0 &&
          serviceAnnouncements.length === 1 &&
          serviceElapsed < 3_000,
        { serviceReacquireErr, serviceElapsed, serviceAnnouncements },
      );
    } finally {
      if (foreignServiceChild) await killAndAwaitExit(foreignServiceChild, "SIGKILL");
      rmSync(serviceLockFile, { force: true });
    }
  }

  // ---- Cell 9: Built-CLI `cotal daemon start --json` recovery + exact refusal JSON shape ----
  {
    const dir = join(root, "cell9-cli-start");
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const env = cleanBaseEnv(dir);
    const nativeBin = join(dir, "native");
    mkdirSync(nativeBin, { mode: 0o700 });
    env.PATH = `${nativeBin}:/usr/local/bin:/usr/bin:/bin`;
    env.COTAL_SKIP_CONNECTOR_SEED = "1";
    env.COTAL_NO_UPDATE_CHECK = "1";

    const paths = daemonPaths(env, env.COTAL_HOME!);
    mkdirSync(paths.state, { recursive: true, mode: 0o700 });
    const snapshot = join(env.XDG_CONFIG_HOME!, "cotal", ".update-snapshot-cell9");
    mkdirSync(snapshot, { recursive: true, mode: 0o700 });

    const savedCotalHome = process.env.COTAL_HOME;
    const savedXdgConfig = process.env.XDG_CONFIG_HOME;
    process.env.COTAL_HOME = env.COTAL_HOME;
    process.env.XDG_CONFIG_HOME = env.XDG_CONFIG_HOME;
    try {
      writeUpdateRecovery({
        previous: version,
        target: version,
        installed: version,
        phase: "replacing",
        reason: "global replacement in progress",
        owner: { pid: 2_147_483_645, start: "dead-token", nonce: "dead-cell9" },
        snapshot,
      });
    } finally {
      if (savedCotalHome === undefined) delete process.env.COTAL_HOME;
      else process.env.COTAL_HOME = savedCotalHome;
      if (savedXdgConfig === undefined) delete process.env.XDG_CONFIG_HOME;
      else process.env.XDG_CONFIG_HOME = savedXdgConfig;
    }

    const unitDir = join(env.XDG_CONFIG_HOME!, "systemd", "user");
    mkdirSync(unitDir, { recursive: true, mode: 0o700 });
    const unitPath = join(unitDir, "cotal-daemon.service");
    const unitBytes = [
      "[Unit]",
      "Description=Cotal machine daemon",
      "",
      "[Service]",
      "Type=notify",
      "NotifyAccess=all",
      "TimeoutStartSec=60",
      `Environment=PATH="${env.PATH}"`,
      "Environment=COTAL_DAEMON_NATIVE_SERVICE=1",
      `ExecStart="${process.execPath}" "${cli}" "daemon" "serve"`,
      "Restart=always",
      "",
    ].join("\n");
    writeFileSync(unitPath, unitBytes, { mode: 0o600 });
    const installedAt = new Date().toISOString();
    writeFileSync(
      join(paths.state, "service-unit.json"),
      JSON.stringify({
        v: 1,
        mechanism: "systemd-user",
        unit: "cotal-daemon.service",
        unitPath,
        unitSha256: createHash("sha256").update(unitBytes).digest("hex"),
        installedAt,
      }),
      { mode: 0o600 },
    );

    let replacement: ReturnType<typeof spawn> | undefined;
    let mainPid = 0;
    let startCalls = 0;
    let serviceRepairLockFreeDuringStart = false;
    let mode: "recover" | "fail" = "recover";
    const control = createServer((req, res) => {
      if (req.url === "/start") {
        startCalls++;
        serviceRepairLockFreeDuringStart = inspectLock(join(paths.state, "service-repair.lock")).state === "absent";
        if (mode === "recover") {
          writeFileSync(join(env.COTAL_HOME!, "update-recovery.json"), "null\n", { mode: 0o600 });
          setTimeout(() => {
            replacement = spawn(process.execPath, [cli, "daemon", "serve"], {
              cwd: dir,
              env,
              stdio: "ignore",
              timeout: 30_000,
              killSignal: "SIGKILL",
            });
            mainPid = replacement.pid ?? 0;
          }, 100);
        }
        res.writeHead(500).end("Job for cotal-daemon.service failed because the control process exited with error code.");
        return;
      }
      if (req.url === "/show") {
        const active = mainPid > 0 ? "active" : "activating";
        res.end(`ActiveState=${active}\nMainPID=${mainPid}\n`);
        return;
      }
      res.end("ok");
    });
    await new Promise<void>((resolve) => control.listen(0, "127.0.0.1", resolve));
    const port = (control.address() as AddressInfo).port;

    writeFileSync(
      join(nativeBin, "systemctl"),
      `#!${process.execPath}
const args = process.argv.slice(2);
if (args.join(" ") === "--user show-environment") {
  console.log(${JSON.stringify(`XDG_CONFIG_HOME=${env.XDG_CONFIG_HOME}`)});
  process.exit(0);
}
if (args.includes("show") && args.includes("cotal-daemon.service")) {
  fetch("http://127.0.0.1:${port}/show").then(r => r.text()).then(t => { process.stdout.write(t); process.exit(0); }).catch(() => process.exit(99));
} else if (args.includes("start")) {
  fetch("http://127.0.0.1:${port}/start").then(async r => {
    const text = await r.text();
    if (!r.ok) { process.stderr.write(text + "\\n"); process.exit(1); }
    process.exit(0);
  }).catch(() => process.exit(99));
} else {
  process.exit(0);
}
`,
      { mode: 0o700 },
    );

    try {
      const startCmd = spawn(process.execPath, [cli, "daemon", "start", "--json"], {
        cwd: dir,
        env,
        stdio: ["ignore", "pipe", "pipe"],
        timeout: 30_000,
        killSignal: "SIGKILL",
      });
      let stdout = "";
      let stderr = "";
      startCmd.stdout.on("data", (b) => {
        stdout += String(b);
      });
      startCmd.stderr.on("data", (b) => {
        stderr += String(b);
      });
      const code1 = await new Promise<number | null>((resolve) => startCmd.once("close", resolve));
      check("built-CLI daemon start succeeds after proven startup recovery restart", code1 === 0, {
        code1,
        stdout,
        stderr,
      });
      const doc1 = JSON.parse(stdout) as { result: Record<string, unknown> };
      check(
        "daemon start --json result keeps exact main keys without adding recoveredVersion to JSON",
        JSON.stringify(Object.keys(doc1.result).sort()) ===
          JSON.stringify(["installedAt", "mechanism", "unit", "unitPath"].sort()),
        doc1.result,
      );
      check("systemctl start was invoked once (never retried)", startCalls === 1, startCalls);
      check("service-repair.lock is suspended during systemctl start when pre-start proof holds", serviceRepairLockFreeDuringStart);
      const answered = await queryDaemon({ paths, timeoutMs: 2_000 });
      check("replacement daemon is live and answering at daemon.sock", answered.ok && answered.result.pid === mainPid, answered);

      if (replacement) {
        await killAndAwaitExit(replacement, "SIGTERM");
        replacement = undefined;
        mainPid = 0;
      }

      // Now verify non-recovery failure keeps main's exact JSON shape and exit 3
      mode = "fail";
      rmSync(join(env.COTAL_HOME!, "update-recovery.json"), { force: true });
      const failCmd = spawn(process.execPath, [cli, "daemon", "start", "--json"], {
        cwd: dir,
        env,
        stdio: ["ignore", "pipe", "pipe"],
        timeout: 30_000,
        killSignal: "SIGKILL",
      });
      let failOut = "";
      failCmd.stdout.on("data", (b) => {
        failOut += String(b);
      });
      const code2 = await new Promise<number | null>((resolve) => failCmd.once("close", resolve));
      const doc2 = JSON.parse(failOut) as {
        outcome: string;
        target: unknown;
        error?: { code: string; message: string; remedy?: string };
      };
      check(
        "built-CLI daemon start --json failure keeps main's exact exit 3, message, target {unit, operation:'start'}, and no remedy",
        code2 === 3 &&
          doc2.outcome === "unknown" &&
          JSON.stringify(doc2.target) === JSON.stringify({ unit: "cotal-daemon.service", operation: "start" }) &&
          doc2.error?.code === "OPERATION_UNKNOWN" &&
          doc2.error?.message === "the native start request did not confirm completion; it was not retried" &&
          doc2.error?.remedy === undefined,
        { code2, doc2 },
      );
    } finally {
      if (replacement) {
        await killAndAwaitExit(replacement, "SIGTERM");
      }
      await new Promise<void>((resolve) => control.close(() => resolve()));
    }
  }

  // ---- Cell 10: Built-CLI `cotal daemon setup --json` PATH-refresh (>30s start + recovery to previous), version-mismatch restart truthful report, and refreshServiceForApplication ----
  {
    const idpServer = createServer((_req, res) => {
      res.writeHead(404).end("{}");
    });
    await new Promise<void>((resolve) => idpServer.listen(0, "127.0.0.1", resolve));
    const idp = `http://127.0.0.1:${(idpServer.address() as AddressInfo).port}/api/auth`;

    async function runSetupRecoveryScenario(opts: {
      name: string;
      mode: "path-refresh-32s" | "version-mismatch" | "version-mismatch-then-path-refresh" | "desktop-app-refresh";
    }): Promise<void> {
      const dir = join(root, opts.name);
      const home = join(dir, "home");
      const cotalHome = join(dir, "cotal");
      const config = join(dir, "config");
      const runtime = join(dir, "rt");
      const native = join(dir, "native");
      const extraBin = join(dir, "extra-bin");
      const scratch = join(dir, "tmp");
      for (const p of [home, cotalHome, config, runtime, native, extraBin, scratch]) {
        mkdirSync(p, { recursive: true, mode: 0o700 });
      }
      writeFileSync(join(extraBin, "claude"), "#!/bin/sh\nexit 0\n", { mode: 0o700 });
      const basePath = [...new Set([native, ...(process.env.PATH ?? "").split(":").filter(isAbsolute)])].join(":");
      const env: NodeJS.ProcessEnv = {
        PATH: `${extraBin}:${basePath}`,
        HOME: home,
        USER: "smoke",
        LOGNAME: "smoke",
        XDG_CONFIG_HOME: config,
        XDG_DATA_HOME: join(dir, "data"),
        XDG_STATE_HOME: join(dir, "state"),
        XDG_CACHE_HOME: join(dir, "cache"),
        XDG_RUNTIME_DIR: runtime,
        TMPDIR: scratch,
        COTAL_HOME: cotalHome,
        COTAL_ALLOW_CHECKOUT_SEED: "1",
        COTAL_SKIP_CONNECTOR_SEED: "1",
        COTAL_NO_UPDATE_CHECK: "1",
        COTAL_TELEMETRY: "off",
        DO_NOT_TRACK: "1",
        NO_COLOR: "1",
      };

      const paths = daemonPaths(env, cotalHome);
      mkdirSync(paths.state, { recursive: true, mode: 0o700 });
      mkdirSync(paths.dir!, { recursive: true, mode: 0o700 });

      const unit = "cotal-daemon.service";
      const unitPath = join(config, "systemd", "user", unit);
      mkdirSync(dirname(unitPath), { recursive: true, mode: 0o700 });
      const initialUnit = [
        "[Unit]",
        "Description=Cotal machine daemon",
        "",
        "[Service]",
        "Type=notify",
        "NotifyAccess=all",
        "TimeoutStartSec=60",
        `Environment=PATH="${basePath}"`,
        "Environment=COTAL_DAEMON_NATIVE_SERVICE=1",
        `ExecStart="${process.execPath}" "${cli}" "daemon" "serve"`,
        "Restart=always",
        "RestartSec=2",
        "TimeoutStopSec=90",
        "KillMode=mixed",
        "",
        "[Install]",
        "WantedBy=default.target",
        "",
      ].join("\n");
      writeFileSync(unitPath, initialUnit, { mode: 0o600 });
      writeFileSync(
        join(paths.state, "service-unit.json"),
        `${JSON.stringify({
          v: 1,
          mechanism: "systemd-user",
          unit,
          unitPath,
          unitSha256: createHash("sha256").update(initialUnit).digest("hex"),
          installedAt: new Date().toISOString(),
        })}\n`,
        { mode: 0o600 },
      );

      // Write restorable interrupted-update record whose `previous` is "0.182.1" while CLI is `version`
      const snapshot = join(config, "cotal", `.update-snapshot-${opts.name}`);
      mkdirSync(snapshot, { recursive: true, mode: 0o700 });
      const savedCotalHome = process.env.COTAL_HOME;
      const savedXdgConfig = process.env.XDG_CONFIG_HOME;
      process.env.COTAL_HOME = cotalHome;
      process.env.XDG_CONFIG_HOME = config;
      try {
        writeUpdateRecovery({
          previous: "0.182.1",
          target: version,
          installed: version,
          phase: "verified-ready",
          reason: "global replacement in progress",
          owner: { pid: 2_147_483_644, start: "dead-setup-owner", nonce: `nonce-${opts.name}` },
          preparedRestart: false,
          snapshot,
        });
      } finally {
        if (savedCotalHome === undefined) delete process.env.COTAL_HOME;
        else process.env.COTAL_HOME = savedCotalHome;
        if (savedXdgConfig === undefined) delete process.env.XDG_CONFIG_HOME;
        else process.env.XDG_CONFIG_HOME = savedXdgConfig;
      }

      // Helper script that holds lifetime + serves fake daemon socket in a real child process so MainPID changes across restart!
      const fakeDaemonScript = join(dir, "fake-daemon.mjs");
      const lifetimeHref = new URL("../dist/daemon/lifetime.js", import.meta.url).href;
      writeFileSync(
        fakeDaemonScript,
        `import { chmodSync, rmSync } from "node:fs";
import { createServer } from "node:net";
const { generationOf, holdLifetime } = await import(${JSON.stringify(lifetimeHref)});
const [socketPath, lockPath, servedVersion, idpUrl, needsClaudeOnPath] = process.argv.slice(2);
rmSync(socketPath, { force: true });
const lifetime = holdLifetime(lockPath);
const server = createServer(peer => {
  peer.setEncoding("utf8");
  let buf = "";
  peer.on("data", chunk => {
    buf += chunk;
    for (let nl; (nl = buf.indexOf("\\n")) !== -1;) {
      const req = JSON.parse(buf.slice(0, nl));
      buf = buf.slice(nl + 1);
      if (req.op === "spaces") {
        peer.write(JSON.stringify({ v: ${DAEMON_PROTOCOL_VERSION}, id: req.id, ok: true, result: { spaces: [], signedInProviders: [idpUrl], failedProviders: [], refresh: "ok" } }) + "\\n");
        continue;
      }
      const connectors = needsClaudeOnPath === "1"
        ? [{ agent: "claude", state: "unavailable", reason: "claude harness needs claude on PATH" }]
        : [{ agent: "claude", state: "available" }];
      const managers = [{ space: "alpha", state: "answering", instanceId: "mgr_1", connectors }];
      const account = {
        idpUrl,
        sub: "user_1",
        label: "smoke@example.test",
        computer: "smoke-host",
        machineId: "11111111-1111-4111-8111-111111111111",
        mode: "account",
        hostSupport: "supported",
        lastRegistration: new Date().toISOString(),
        spaces: [{ space: "alpha", desired: true, observed: "answering" }],
      };
      peer.write(JSON.stringify({
        v: ${DAEMON_PROTOCOL_VERSION},
        id: req.id,
        ok: true,
        result: {
          state: "ready",
          version: servedVersion,
          protocol: ${DAEMON_PROTOCOL_VERSION},
          pid: process.pid,
          managers,
          account: { ...account, accounts: [account] },
        },
      }) + "\\n");
    }
  });
});
await new Promise(resolve => server.listen(socketPath, resolve));
chmodSync(socketPath, 0o600);
lifetime.publishing(generationOf(socketPath));
console.log("READY");
const stop = () => { server.close(() => { lifetime.release(); rmSync(socketPath, { force: true }); process.exit(0); }); };
process.once("SIGTERM", stop);
process.once("SIGINT", stop);
`,
        { mode: 0o600 },
      );

      async function spawnFakeDaemon(servedVer: string, needsClaude: boolean): Promise<ReturnType<typeof spawn>> {
        const child = spawn(
          process.execPath,
          [fakeDaemonScript, paths.socket, paths.lock, servedVer, idp, needsClaude ? "1" : "0"],
          { cwd: dir, env, stdio: ["ignore", "pipe", "pipe"], timeout: 60_000, killSignal: "SIGKILL" },
        );
        await new Promise<void>((resolve, reject) => {
          let out = "";
          let err = "";
          child.stdout!.on("data", (c) => {
            out += String(c);
            if (out.includes("READY")) resolve();
          });
          child.stderr!.on("data", (c) => {
            err += String(c);
          });
          child.once("exit", (code) => reject(new Error(`fake daemon exited early (${code}): ${err}`)));
        });
        return child;
      }

      // For PATH-refresh and desktop-app-refresh: initial daemon runs `version` (so ensureInstalled does not restart it; refreshApplications restarts it!).
      // For version-mismatch modes: initial daemon runs `"0.181.0"` (so ensureInstalledUnderClosure restarts it!).
      const initialVer =
        opts.mode === "version-mismatch" || opts.mode === "version-mismatch-then-path-refresh" ? "0.181.0" : version;
      let activeDaemon: ReturnType<typeof spawn> | undefined = await spawnFakeDaemon(initialVer, opts.mode === "path-refresh-32s");
      let mainPid = activeDaemon.pid!;
      let closureFreeDuringStart = false;
      let serviceLockFreeDuringStart = false;
      let startCalls = 0;

      const control = createServer(async (req, res) => {
        if (req.url === "/stop") {
          if (activeDaemon) {
            await killAndAwaitExit(activeDaemon, "SIGTERM");
            activeDaemon = undefined;
            mainPid = 0;
          }
          res.end("ok");
          return;
        }
        if (req.url === "/start") {
          startCalls++;
          if (startCalls === 1) {
            closureFreeDuringStart = inspectLock(join(cotalHome, ".update-closure.lock")).state === "absent";
            serviceLockFreeDuringStart = inspectLock(join(paths.state, "service-repair.lock")).state === "absent";
            if (opts.mode === "path-refresh-32s") {
              // Exceeds main's old 30_000 ms nativeRun timeout, proving restartInstalled uses 65_000 ms!
              await delay(31_500);
            }
            writeFileSync(join(cotalHome, "update-recovery.json"), "null\n", { mode: 0o600 });
            const needsPathRefresh = opts.mode === "version-mismatch-then-path-refresh";
            setTimeout(() => {
              void spawnFakeDaemon("0.182.1", needsPathRefresh).then((d) => {
                activeDaemon = d;
                mainPid = d.pid!;
              });
            }, 80);
            res.writeHead(500).end("Job for cotal-daemon.service failed because the control process exited with error code.");
            return;
          }
          // Subsequent normal start after update-recovery.json is already cleared (e.g. follow-on PATH refresh in the same setup run)
          activeDaemon = await spawnFakeDaemon("0.182.1", false);
          mainPid = activeDaemon.pid!;
          res.end("ok");
          return;
        }
        if (req.url === "/show") {
          res.end(`ActiveState=${mainPid > 0 ? "active" : "activating"}\nMainPID=${mainPid}\n`);
          return;
        }
        res.end("ok");
      });
      await new Promise<void>((resolve) => control.listen(0, "127.0.0.1", resolve));
      const controlPort = (control.address() as AddressInfo).port;

      writeFileSync(
        join(native, "systemctl"),
        `#!${process.execPath}
const args = process.argv.slice(2);
if (args.join(" ") === "--user show-environment") {
  console.log(${JSON.stringify(`XDG_CONFIG_HOME=${config}`)});
  process.exit(0);
}
if (args.includes("show") && args.includes("cotal-daemon.service")) {
  fetch("http://127.0.0.1:${controlPort}/show").then(r => r.text()).then(t => { process.stdout.write(t); process.exit(0); }).catch(() => process.exit(99));
} else {
  const op = args.includes("daemon-reload") ? "daemon-reload" : args.at(-2);
  fetch("http://127.0.0.1:${controlPort}/" + op).then(async r => {
    const t = await r.text();
    if (!r.ok) { process.stderr.write(t + "\\n"); process.exit(1); }
    process.exit(0);
  }).catch(() => process.exit(99));
}
`,
        { mode: 0o700 },
      );

      try {
        if (opts.mode === "desktop-app-refresh") {
          const setupDistHref = new URL("../dist/daemon/setup.js", import.meta.url).href;
          const desktopPathHref = new URL("../dist/daemon/desktop-path.js", import.meta.url).href;
          const driver = join(dir, "run-app-refresh.mjs");
          writeFileSync(
            driver,
            `process.argv[1] = ${JSON.stringify(cli)};
process.execArgv = [];
const { refreshServiceForApplication } = await import(${JSON.stringify(setupDistHref)});
const { serviceApplicationPath } = await import(${JSON.stringify(desktopPathHref)});
const lines = [];
const result = await refreshServiceForApplication(
  {
    paths: ${JSON.stringify(paths)},
    daemonHome: undefined,
    version: ${JSON.stringify(version)},
    report: line => lines.push(line),
  },
  [${JSON.stringify(extraBin)}],
  {
    path: serviceApplicationPath(${JSON.stringify(`${extraBin}:${basePath}`)}, "linux", ${JSON.stringify(env.HOME!)}),
    assertOwner() {},
  },
);
console.log(JSON.stringify({ result, lines }));
`,
            { mode: 0o600 },
          );
          const appChild = spawn(process.execPath, [driver], {
            cwd: dir,
            env,
            stdio: ["ignore", "pipe", "pipe"],
            timeout: 30_000,
            killSignal: "SIGKILL",
          });
          let appOut = "";
          let appErr = "";
          appChild.stdout.on("data", (c) => {
            appOut += String(c);
          });
          appChild.stderr.on("data", (c) => {
            appErr += String(c);
          });
          const appCode = await new Promise<number | null>((resolve) => appChild.once("close", resolve));
          const parsed = appCode === 0 ? (JSON.parse(appOut) as { result: boolean; lines: string[] }) : undefined;
          check(
            "refreshServiceForApplication pins waitForDaemon to recoveredVersion ('0.182.1') and returns true",
            appCode === 0 &&
              parsed?.result === true &&
              closureFreeDuringStart &&
              serviceLockFreeDuringStart &&
              readFileSync(unitPath, "utf8").includes(`Environment=PATH="${extraBin}:${basePath}:`),
            { appCode, appOut, appErr, parsed, closureFreeDuringStart, serviceLockFreeDuringStart },
          );
          return;
        }

        const child = spawn(process.execPath, [cli, "daemon", "setup", "--json"], {
          cwd: dir,
          env,
          stdio: ["ignore", "pipe", "pipe"],
          timeout: 75_000,
          killSignal: "SIGKILL",
        });
        let stdout = "";
        let stderr = "";
        child.stdout.on("data", (c) => {
          stdout += String(c);
        });
        child.stderr.on("data", (c) => {
          stderr += String(c);
        });
        const code = await new Promise<number | null>((resolve) => child.once("close", resolve));

        if (opts.mode === "path-refresh-32s") {
          check(
            "PATH-refresh restart taking >30s + startup recovery to 0.182.1 exits 0 and rewrites unit PATH",
            code === 0 &&
              closureFreeDuringStart &&
              serviceLockFreeDuringStart &&
              stderr.includes(`service: updating ${unit} pinned PATH`) &&
              stderr.includes(`service: restarted ${unit} with the updated PATH`) &&
              readFileSync(unitPath, "utf8").includes(`Environment=PATH="${extraBin}:${basePath}:`),
            { code, stdout, stderr, closureFreeDuringStart, serviceLockFreeStart: serviceLockFreeDuringStart },
          );
        } else if (opts.mode === "version-mismatch-then-path-refresh") {
          check(
            "version-mismatch recovery followed by PATH-refresh restart in the same setup run waits for restored 0.182.1 and exits 0",
            code === 0 &&
              startCalls === 2 &&
              stderr.includes(`service: ${unit} restarted through its recorded service to load Cotal 0.182.1`) &&
              stderr.includes(`service: updating ${unit} pinned PATH`) &&
              stderr.includes(`service: restarted ${unit} with the updated PATH`) &&
              readFileSync(unitPath, "utf8").includes(`Environment=PATH="${extraBin}:${basePath}:`),
            { code, startCalls, stderr },
          );
        } else {
          const doc = JSON.parse(stdout) as { result: { steps: Array<{ step: string; outcome: string; detail: string }> } };
          check(
            "version-mismatch restart with startup recovery reports the restored previous version (0.182.1), never the unloaded CLI version",
            code === 0 &&
              stderr.includes(`service: ${unit} restarted through its recorded service to load Cotal 0.182.1`) &&
              !stderr.includes(`load Cotal ${version}`) &&
              doc.result.steps.some(
                (s) =>
                  s.step === "install" &&
                  s.detail === `${unit} restarted through its recorded service to load Cotal 0.182.1`,
              ),
            { code, stderr, steps: doc.result.steps },
          );
        }
      } finally {
        if (activeDaemon) {
          await killAndAwaitExit(activeDaemon, "SIGTERM");
        }
        await new Promise<void>((resolve) => control.close(() => resolve()));
        if (existsSync(paths.socket)) rmSync(paths.socket, { force: true });
      }
    }

    try {
      await runSetupRecoveryScenario({ name: "cell10a-path-refresh-32s", mode: "path-refresh-32s" });
      await runSetupRecoveryScenario({ name: "cell10b-version-mismatch", mode: "version-mismatch" });
      await runSetupRecoveryScenario({
        name: "c10d-vm-path",
        mode: "version-mismatch-then-path-refresh",
      });
      await runSetupRecoveryScenario({ name: "cell10c-desktop-app-refresh", mode: "desktop-app-refresh" });
    } finally {
      await new Promise<void>((resolve) => idpServer.close(() => resolve()));
    }
  }

  // ---- Cell 11: Interrupted upgrade from published-shape 0.183.1 (without skipStartupRecoveryWait) to head ----
  {
    const dir = join(root, "cell11-published-to-head");
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const env = cleanBaseEnv(dir);
    const prefix = join(dir, "prefix");
    const cache = join(dir, "npm-cache");
    const native = join(dir, "native");
    for (const d of [prefix, cache, native]) mkdirSync(d, { recursive: true, mode: 0o700 });

    const baselineVersion = "0.183.1";
    const headVersion = "0.999.0";
    const fixtureDir = join(dir, "upgrade-fixture");
    const built = spawnSync(
      process.execPath,
      [join(repo, "bin/smoke/build-daemon-upgrade-fixture.mjs"), fixtureDir, "--workspace-source"],
      { cwd: repo, encoding: "utf8", maxBuffer: 64 * 1024 * 1024, timeout: 300_000, killSignal: "SIGKILL" },
    );
    check(
      "upgrade fixture built offline",
      built.status === 0,
      { status: built.status, signal: built.signal, error: built.error?.message },
    );

    const reversionTree = (treeDir: string, ver: string): void => {
      const rootPkg = JSON.parse(readFileSync(join(treeDir, "package.json"), "utf8")) as {
        version: string;
        dependencies?: Record<string, string>;
      };
      rootPkg.version = ver;
      for (const k of Object.keys(rootPkg.dependencies ?? {})) {
        if (k.startsWith("@cotal-ai/")) rootPkg.dependencies![k] = ver;
      }
      writeFileSync(join(treeDir, "package.json"), `${JSON.stringify(rootPkg, null, 2)}\n`);
      for (const entry of readdirSync(join(treeDir, "seeded-connectors"), { withFileTypes: true })) {
        const p = join(treeDir, "seeded-connectors", entry.name, "package.json");
        if (entry.isDirectory() && existsSync(p)) {
          const c = JSON.parse(readFileSync(p, "utf8")) as { version: string };
          c.version = ver;
          writeFileSync(p, `${JSON.stringify(c, null, 2)}\n`);
        }
      }
      const walkFirstParty = (nm: string): void => {
        const scopeDir = join(nm, "@cotal-ai");
        if (!existsSync(scopeDir)) return;
        for (const entry of readdirSync(scopeDir, { withFileTypes: true })) {
          if (!entry.isDirectory()) continue;
          const pkgRoot = join(scopeDir, entry.name);
          const mf = join(pkgRoot, "package.json");
          if (existsSync(mf)) {
            const m = JSON.parse(readFileSync(mf, "utf8")) as Record<string, unknown>;
            m.version = ver;
            for (const field of ["dependencies", "optionalDependencies", "peerDependencies"]) {
              const deps = m[field] as Record<string, string> | undefined;
              for (const k of Object.keys(deps ?? {})) {
                if (k.startsWith("@cotal-ai/")) deps![k] = ver;
              }
            }
            writeFileSync(mf, `${JSON.stringify(m, null, 2)}\n`);
          }
          if (existsSync(join(pkgRoot, "node_modules"))) walkFirstParty(join(pkgRoot, "node_modules"));
        }
      };
      walkFirstParty(join(treeDir, "node_modules"));
    };

    // Baseline 0.183.1 tree: strip nativeStartupUpdateRecoveryParent / skipStartupRecoveryWait so its reconcile
    // child has published cotal-ai@0.183.1's exact waitForInstalledGeneration behaviour.
    const baseTree = join(fixtureDir, "hoisted-fix2-0.151.2");
    reversionTree(baseTree, baselineVersion);
    const baseUpdateEntryPath = join(baseTree, "dist/daemon/update-entry.js");
    const strippedBaseUpdateEntry = readFileSync(baseUpdateEntryPath, "utf8")
      .replace(/import\s*\{\s*nativeStartupUpdateRecoveryParent\s*\}\s*from\s*["']\.\/startup-recovery\.js["'];\r?\n/, "")
      .replace(
        "const recoveryAdmission = readUpdateRecovery(), skipStartupRecoveryWait = nativeStartupUpdateRecoveryParent(recoveryAdmission);",
        "const recoveryAdmission = readUpdateRecovery();",
      )
      .replace(/\s*if\s*\(skipStartupRecoveryWait\)\s*return;\r?\n/, "\n");
    writeFileSync(baseUpdateEntryPath, strippedBaseUpdateEntry);
    check(
      "baseline 0.183.1 update-entry has neither nativeStartupUpdateRecoveryParent nor skipStartupRecoveryWait",
      !strippedBaseUpdateEntry.includes("nativeStartupUpdateRecoveryParent") &&
        !strippedBaseUpdateEntry.includes("skipStartupRecoveryWait"),
    );

    const headTree = join(fixtureDir, "hoisted-fix2-0.151.3");
    reversionTree(headTree, headVersion);

    Object.assign(env, {
      PATH: `${native}:${join(prefix, "bin")}:${process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin"}`,
      npm_config_prefix: prefix,
      npm_config_cache: cache,
      npm_config_update_notifier: "false",
      npm_config_audit: "false",
      npm_config_fund: "false",
      COTAL_SKIP_CONNECTOR_SEED: "1",
    });
    writeSeedState(env.XDG_CONFIG_HOME!, baselineVersion);

    // Materialize baseline 0.183.1 into global prefix layout (<prefix>/lib/node_modules/cotal-ai + <prefix>/bin/cotal)
    mkdirSync(join(prefix, "lib/node_modules"), { recursive: true, mode: 0o755 });
    mkdirSync(join(prefix, "bin"), { recursive: true, mode: 0o755 });
    const cpBase = spawnSync("cp", ["-a", baseTree, join(prefix, "lib/node_modules/cotal-ai")], {
      cwd: dir,
      encoding: "utf8",
      timeout: 60_000,
      killSignal: "SIGKILL",
    });
    check("initial global placement of 0.183.1 succeeded", cpBase.status === 0, cpBase.stderr || cpBase.stdout);
    symlinkSync("../lib/node_modules/cotal-ai/dist/cotal.js", join(prefix, "bin/cotal"));
    chmodSync(join(prefix, "lib/node_modules/cotal-ai/dist/cotal.js"), 0o755);

    const installedRoot = realpathSync(join(prefix, "lib/node_modules/cotal-ai"));
    const installedEntry = join(installedRoot, "dist/cotal.js");
    const paths = daemonPaths(env, env.COTAL_HOME!);
    mkdirSync(paths.state, { recursive: true, mode: 0o700 });
    const unitDir = join(env.XDG_CONFIG_HOME!, "systemd", "user");
    mkdirSync(unitDir, { recursive: true, mode: 0o700 });
    const unitPath = join(unitDir, "cotal-daemon.service");
    const unitBytes = [
      "[Unit]",
      "Description=Cotal machine daemon",
      "",
      "[Service]",
      "Type=notify",
      "NotifyAccess=all",
      "TimeoutStartSec=60",
      `Environment=PATH="${env.PATH}"`,
      "Environment=COTAL_DAEMON_NATIVE_SERVICE=1",
      `ExecStart="${process.execPath}" "${installedEntry}" "daemon" "serve"`,
      "Restart=always",
      "",
    ].join("\n");
    writeFileSync(unitPath, unitBytes, { mode: 0o600 });
    writeFileSync(
      join(paths.state, "service-unit.json"),
      `${JSON.stringify({
        v: 1,
        mechanism: "systemd-user",
        unit: "cotal-daemon.service",
        unitPath,
        unitSha256: createHash("sha256").update(unitBytes).digest("hex"),
        installedAt: new Date().toISOString(),
      })}\n`,
      { mode: 0o600 },
    );

    // Fake systemctl that stays enabled and answers show-environment; if the 0.183.1 child ever reached
    // waitForInstalledDaemonGeneration with a reachable runtime dir, it would call `systemctl start` and
    // block 120s waiting for daemon.sock!
    const childStartCallsFile = join(dir, "child-systemctl-starts.log");
    writeFileSync(
      join(native, "systemctl"),
      `#!${process.execPath}
const fs = require("node:fs");
const args = process.argv.slice(2);
if (args.join(" ") === "--user show-environment") {
  console.log(${JSON.stringify(`XDG_CONFIG_HOME=${env.XDG_CONFIG_HOME}`)});
  process.exit(0);
}
if (args.some(a => a.includes("UnitFileState"))) {
  console.log("enabled");
  process.exit(0);
}
if (args.includes("start")) {
  fs.appendFileSync(${JSON.stringify(childStartCallsFile)}, args.join(" ") + "\\n");
  process.exit(0);
}
process.exit(0);
`,
      { mode: 0o700 },
    );

    // Stage and publish headTree as the active generation over installed 0.183.1, leaving an interrupted
    // `phase: "replacing"` update-recovery.json with a real closure snapshot owned by a dead process.
    const interruptStageScript = join(dir, "stage-interrupt.mjs");
    const execTxHref = new URL("../dist/execution-transaction.js", import.meta.url).href;
    const snapshotHref = new URL("../../implementations/cli/dist/lib/update-snapshot.js", import.meta.url).href;
    const workspaceHref = new URL("../../packages/workspace/dist/index.js", import.meta.url).href;
    writeFileSync(
      interruptStageScript,
      `const { journalExecutionTransaction, publishExecutionTransaction, retainExecutionGeneration } = await import(${JSON.stringify(execTxHref)});
const { snapshotUpdateClosure } = await import(${JSON.stringify(snapshotHref)});
const { claimUpdateClosureAccess, updateClosureOwner, writeUpdateRecovery } = await import(${JSON.stringify(workspaceHref)});
const release = claimUpdateClosureAccess();
const snapshot = snapshotUpdateClosure();
const generation = retainExecutionGeneration(${JSON.stringify(installedRoot)}, ${JSON.stringify(headTree)});
const journal = journalExecutionTransaction(${JSON.stringify(installedRoot)}, generation, ${JSON.stringify(installedEntry)});
writeUpdateRecovery({
  previous: ${JSON.stringify(baselineVersion)},
  target: ${JSON.stringify(headVersion)},
  installed: ${JSON.stringify(baselineVersion)},
  phase: "replacing",
  reason: "staged execution replacement in progress",
  owner: updateClosureOwner(),
  preparedRestart: false,
  execution: journal,
  snapshot: snapshot.path,
});
publishExecutionTransaction(${JSON.stringify(installedRoot)}, journal);
release();
process.exit(0);
`,
      { mode: 0o600 },
    );
    const stageRun = spawnSync(process.execPath, [interruptStageScript], {
      cwd: dir,
      env,
      encoding: "utf8",
      timeout: 120_000,
      killSignal: "SIGKILL",
    });
    check("staged 0.183.1 -> head interruption prepared cleanly", stageRun.status === 0, stageRun.stderr || stageRun.stdout);

    // Confirm active execution is now headVersion before native daemon serve starts
    const verBefore = spawnSync(process.execPath, [installedEntry, "--version"], {
      cwd: dir,
      env,
      encoding: "utf8",
      timeout: 15_000,
      killSignal: "SIGKILL",
    });
    check(
      "installed entry reports headVersion before native daemon serve startup recovery",
      verBefore.status === 0 && verBefore.stdout.split(/\r?\n/, 1)[0] === `cotal-ai ${headVersion}`,
      verBefore.stdout + verBefore.stderr,
    );

    // Now start native `daemon serve` (which boots headVersion's code via selectExecutionProgram, restores 0.183.1,
    // and spawns the restored 0.183.1 reconcile child BEFORE daemon.sock exists). Without startupRecoveryChildEnv,
    // the 0.183.1 reconcile child would self-wait 120s and time out!
    const recoveryStarted = Date.now();
    const serveChild = spawn(process.execPath, [installedEntry, "daemon", "serve"], {
      cwd: dir,
      env: { ...env, COTAL_DAEMON_NATIVE_SERVICE: "1" },
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 45_000,
      killSignal: "SIGKILL",
    });
    let serveOut = "";
    serveChild.stdout.on("data", (chunk) => {
      serveOut += String(chunk);
    });
    serveChild.stderr.on("data", (chunk) => {
      serveOut += String(chunk);
    });
    const serveClosed = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) =>
      serveChild.once("close", (code, signal) => resolve({ code, signal })),
    );
    const recoveryElapsed = Date.now() - recoveryStarted;

    check(
      "native daemon serve restores published-shape 0.183.1 and exits promptly (<35s, no 120s child self-wait)",
      serveClosed.signal === null &&
        serveClosed.code !== 0 &&
        recoveryElapsed < 35_000 &&
        serveOut.includes(`Restored cotal-ai@${baselineVersion} after an interrupted update.`) &&
        serveOut.includes("interrupted update restored the previous installation; restart the daemon with the restored CLI") &&
        !serveOut.includes("waiting up to 120s for Cotal"),
      { serveClosed, recoveryElapsed, serveOut },
    );
    check(
      "restored 0.183.1 reconcile child did not invoke systemctl start during startup recovery",
      !existsSync(childStartCallsFile),
      existsSync(childStartCallsFile) ? readFileSync(childStartCallsFile, "utf8") : "",
    );
    check(
      "update-recovery.json holds exact null tombstone after published->head startup recovery",
      readFileSync(join(env.COTAL_HOME!, "update-recovery.json"), "utf8").trim() === "null",
    );
    const verAfter = spawnSync(process.execPath, [installedEntry, "--version"], {
      cwd: dir,
      env,
      encoding: "utf8",
      timeout: 15_000,
      killSignal: "SIGKILL",
    });
    check(
      "installed entry reports restored 0.183.1 after startup recovery",
      verAfter.status === 0 && verAfter.stdout.split(/\r?\n/, 1)[0] === `cotal-ai ${baselineVersion}`,
      verAfter.stdout + verAfter.stderr,
    );
  }
} finally {
  rmSync(root, { recursive: true, force: true });
}

finish();
