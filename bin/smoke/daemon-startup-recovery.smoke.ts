/**
 * Startup update-recovery and `systemctl --user start` recovery proofs (`Cotal#10819` Part 2):
 *
 *  Cell 1: Shared systemd start constants: `DAEMON_SYSTEMD_START_TIMEOUT_SEC === 60`,
 *          `DAEMON_SYSTEMD_START_TIMEOUT_MS === 65_000`, `DAEMON_SYSTEMD_RECOVERY_WAIT_MS === 60_000`,
 *          and `renderDaemonUnit` embeds `TimeoutStartSec=60` from that constant.
 *  Cell 2: `nativeStartupUpdateRecoveryParent` predicate matrix: accepts native `daemon serve` (and
 *          win32 `daemon-native` / `cotal-desktop.exe --daemon`) only when `COTAL_DAEMON_NATIVE_SERVICE === "1"`,
 *          `phase === "restoring"`, live `owner` matches `ppid` + start token; rejects missing native
 *          marker, `cotal update` parent argv, mismatched owner/start/nonce, non-`restoring` phases, and
 *          dead/unreadable parents.
 *  Cell 3: Built-CLI reconcile child with live native `daemon serve` parent in `restoring` phase skips
 *          `waitForInstalledGeneration` and exits 0 promptly, even with a recorded same-install unit and
 *          no answering `daemon.sock`.
 *  Cell 4: Built-CLI reconcile child with live foreground `cotal daemon serve` parent (no
 *          `COTAL_DAEMON_NATIVE_SERVICE`) still runs `waitForInstalledGeneration` (does NOT skip).
 *  Cell 5: Built-CLI reconcile child with live `cotal update` parent (even with
 *          `COTAL_DAEMON_NATIVE_SERVICE=1` inherited) still runs `waitForInstalledGeneration` (does NOT skip).
 *  Cell 6: `startSystemdDaemonUnit` passes derived `65_000` ms timeout to `systemctl --user start`,
 *          suspends any caller closure claim so startup recovery can acquire `.update-closure.lock`,
 *          and succeeds on non-zero `systemctl start` when pre-start restorable proof (`replacing` or
 *          `verified-ready` + valid snapshot + dead owner) and post-start raw `null` tombstone hold and
 *          a fresh `MainPID` answers `daemon.sock` with `readUpdateRecovery() === undefined`.
 *  Cell 7: `startSystemdDaemonUnit` refuses immediately with the exact unretried message
 *          `the native daemon start did not confirm completion (<detail>); it was not retried` when
 *          pre-start proof is absent (no recovery file, live owner, `paused` phase, or missing snapshot)
 *          or when post-start `update-recovery.json` is not the raw `null` tombstone.
 *  Cell 8: Built-CLI `cotal daemon start` end-to-end with fake `systemctl` simulating startup recovery
 *          exit (`status !== 0`, writing `"null\n"` tombstone) followed by `Restart=always` spawning a
 *          real `daemon serve` on a fresh `MainPID`.
 */
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import {
  claimUpdateClosureAccess,
  clearUpdateRecovery,
  CommandFailure,
  inspectLock,
  processStartToken,
  readUpdateRecovery,
  SEEDED_EXTENSIONS,
  writeUpdateRecovery,
  type UpdateRecovery,
} from "@cotal-ai/workspace";
import { createSuite, killAndAwaitExit, skipSuite } from "@cotal-ai/smoke-kit";
import { queryDaemon } from "../daemon/client.js";
import { daemonPaths } from "../daemon/endpoint.js";
import { renderDaemonUnit, type NativeResult, type NativeRun } from "../daemon/install.js";
import { processBirth } from "../daemon/lifetime.js";
import { serveDaemon } from "../daemon/server.js";
import {
  DAEMON_SYSTEMD_RECOVERY_WAIT_MS,
  DAEMON_SYSTEMD_START_CALL_MARGIN_SEC,
  DAEMON_SYSTEMD_START_TIMEOUT_MS,
  DAEMON_SYSTEMD_START_TIMEOUT_SEC,
  isDaemonServeArgv,
  nativeStartupUpdateRecoveryParent,
  readParentArgv,
  startSystemdDaemonUnit,
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
    const savedArgv1 = process.argv[1];
    const savedExecArgv = process.execArgv;
    let rendered: ReturnType<typeof renderDaemonUnit>;
    try {
      process.argv[1] = cli;
      process.execArgv = [];
      rendered = renderDaemonUnit(join(root, "unit-check"), undefined);
    } finally {
      process.argv[1] = savedArgv1;
      process.execArgv = savedExecArgv;
    }
    check(
      "renderDaemonUnit writes TimeoutStartSec=60 from shared constant",
      rendered.bytes.includes(`\nTimeoutStartSec=${DAEMON_SYSTEMD_START_TIMEOUT_SEC}\n`),
    );
  }

  // ---- Cell 2: nativeStartupUpdateRecoveryParent predicate matrix ----
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
      "accepts native Windows daemon-native.js restoring parent",
      nativeStartupUpdateRecoveryParent(baseRecord, {
        env: baseEnv,
        ppid: 4242,
        platform: "win32",
        ownerStart: () => "98765",
        parentArgv: () => ["C:\\Program Files\\nodejs\\node.exe", "C:\\cotal\\dist\\daemon-native.js", "daemon", "serve"],
      }),
    );
    check(
      "accepts native Windows cotal-desktop.exe --daemon restoring parent",
      nativeStartupUpdateRecoveryParent(baseRecord, {
        env: baseEnv,
        ppid: 4242,
        platform: "win32",
        ownerStart: () => "98765",
        parentArgv: () => ["C:\\Users\\u\\AppData\\Local\\Cotal\\cotal-desktop.exe", "--daemon"],
      }),
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
  }

  // ---- Helper to test built-CLI reconcile child behavior under a controlled live parent ----
  async function runBoundReconcileUnderParent(opts: {
    label: string;
    parentArgvTail: string[];
    nativeMarker: boolean;
    killWhenWaiting: boolean;
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

    // Fake systemctl: reports UnitFileState=disabled when polled by posixGenerationLifecycle so any
    // entered waitForInstalledDaemonGeneration prints its wait banner and returns immediately without
    // trying to start a real service. Wait — if UnitFileState=disabled, posixGenerationLifecycle
    // prints "service is disabled; not started" and returns false! That proves whether
    // waitForInstalledDaemonGeneration ran WITHOUT hanging for 120s!
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
      killWhenWaiting: false,
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
      killWhenWaiting: false,
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
      killWhenWaiting: false,
    });
    check("cotal update parent child exits 0", res.code === 0, res);
    check(
      "cotal update parent child still runs waitForInstalledDaemonGeneration even with native marker",
      res.output.includes("waiting up to 120s for Cotal") &&
        res.output.includes("cotal-daemon.service: service is disabled; not started"),
      res.output,
    );
  }

  // ---- Cell 6: startSystemdDaemonUnit derived 65_000ms timeout, closure suspension, and proof-gated recovery wait ----
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

    // Write restorable update-recovery.json with a dead owner PID
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

    // Claim outer closure lock (simulating `cotal daemon setup` holding claimUpdateClosureAccess)
    const releaseCallerClosure = claimUpdateClosureAccess(true);
    let closureFreeDuringStart = false;
    let startCallTimeoutMs: number | undefined;
    let currentMainPid = 0;
    let recoveredDaemon: Awaited<ReturnType<typeof serveDaemon>> | undefined;

    try {
      const fakeRun: NativeRun = (_file, args, _runEnv, timeoutMs): NativeResult => {
        if (args.includes("start")) {
          startCallTimeoutMs = timeoutMs;
          closureFreeDuringStart = inspectLock(join(env.COTAL_HOME!, ".update-closure.lock")).state === "absent";
          // Simulate native startup recovery clearing update-recovery.json to raw `null` tombstone
          // and exiting non-zero so `systemctl start` returns status 1, followed asynchronously by
          // systemd `Restart=always` bringing up the restored daemon.
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
          }, 80);
          return {
            status: 1,
            stdout: "",
            detail: "Job for cotal-daemon.service failed because the control process exited with error code.",
          };
        }
        if (args.includes("show")) {
          return {
            status: 0,
            stdout: `ActiveState=${currentMainPid > 0 ? "active" : "activating"}\nMainPID=${currentMainPid}\n`,
            detail: "",
          };
        }
        return { status: 0, stdout: "", detail: "" };
      };

      const recovered = await startSystemdDaemonUnit(paths, undefined, "cotal-daemon.service", {
        run: fakeRun,
        serviceEnv: env,
        homeDir: env.COTAL_HOME!,
        lookupOwner: () => undefined,
        waitMs: 10_000,
        pollMs: 50,
        birth: processBirth,
      });

      check("startSystemdDaemonUnit passes derived 65_000 ms timeout to systemctl start", startCallTimeoutMs === 65_000, startCallTimeoutMs);
      check("startSystemdDaemonUnit suspends caller update-closure lock during systemctl start", closureFreeDuringStart);
      check(
        "caller update-closure lock is reacquired before startSystemdDaemonUnit returns",
        inspectLock(join(env.COTAL_HOME!, ".update-closure.lock")).state === "active",
      );
      check("startSystemdDaemonUnit resolves true when proof-gated recovery completes", recovered === true);
      check("readUpdateRecovery() is undefined after recovery", readUpdateRecovery() === undefined);
      const reply = await queryDaemon({ paths, timeoutMs: 2_000 });
      check("restored daemon answers daemon.sock at previous version", reply.ok && reply.result.version === "0.182.1", reply);
    } finally {
      releaseCallerClosure();
      await recoveredDaemon?.close();
      if (savedCotalHome === undefined) delete process.env.COTAL_HOME;
      else process.env.COTAL_HOME = savedCotalHome;
      if (savedXdgConfig === undefined) delete process.env.XDG_CONFIG_HOME;
      else process.env.XDG_CONFIG_HOME = savedXdgConfig;
      if (savedXdgRuntime === undefined) delete process.env.XDG_RUNTIME_DIR;
      else process.env.XDG_RUNTIME_DIR = savedXdgRuntime;
    }
  }

  // ---- Cell 7: startSystemdDaemonUnit preserves exact refusal when proof is absent ----
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
    const expectedMessage = `the native daemon start did not confirm completion (${detail}); it was not retried`;

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
            serviceEnv: env,
            homeDir: env.COTAL_HOME!,
            lookupOwner: cell.lookupOwner ?? (() => undefined),
            waitMs: 500,
            pollMs: 50,
          });
        } catch (error) {
          caught = error;
        }
        check(
          `refusal (${cell.name}): preserves exact CommandFailure and message without polling`,
          caught instanceof CommandFailure &&
            caught.outcome === "unknown" &&
            caught.code === "OPERATION_UNKNOWN" &&
            caught.message === expectedMessage &&
            showPollsAfterStart === 0,
          { caught, showPollsAfterStart },
        );
      }
    } finally {
      if (savedCotalHome === undefined) delete process.env.COTAL_HOME;
      else process.env.COTAL_HOME = savedCotalHome;
      if (savedXdgConfig === undefined) delete process.env.XDG_CONFIG_HOME;
      else process.env.XDG_CONFIG_HOME = savedXdgConfig;
      if (savedXdgRuntime === undefined) delete process.env.XDG_RUNTIME_DIR;
      else process.env.XDG_RUNTIME_DIR = savedXdgRuntime;
    }
  }

  // ---- Cell 8: Built-CLI `cotal daemon start` end-to-end with fake systemctl startup recovery ----
  {
    const dir = join(root, "cell8-cli-start");
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const env = cleanBaseEnv(dir);
    const nativeBin = join(dir, "native");
    mkdirSync(nativeBin, { mode: 0o700 });
    env.PATH = `${nativeBin}:/usr/local/bin:/usr/bin:/bin`;
    env.COTAL_SKIP_CONNECTOR_SEED = "1";
    env.COTAL_NO_UPDATE_CHECK = "1";

    const paths = daemonPaths(env, env.COTAL_HOME!);
    mkdirSync(paths.state, { recursive: true, mode: 0o700 });
    const snapshot = join(env.XDG_CONFIG_HOME!, "cotal", ".update-snapshot-cell8");
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
        owner: { pid: 2_147_483_645, start: "dead-token", nonce: "dead-cell8" },
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

    let replacement: ReturnType<typeof spawn> | undefined;
    let mainPid = 0;
    let startCalls = 0;
    let serviceRepairLockFreeDuringStart = false;
    const control = createServer((req, res) => {
      if (req.url === "/start") {
        startCalls++;
        serviceRepairLockFreeDuringStart = inspectLock(join(paths.state, "service-repair.lock")).state === "absent";
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
      const exitCode = await new Promise<number | null>((resolve) => startCmd.once("close", resolve));
      check("built-CLI daemon start succeeds after proven startup recovery restart", exitCode === 0, {
        exitCode,
        stdout,
        stderr,
      });
      check("systemctl start was invoked exactly once (never retried)", startCalls === 1, startCalls);
      check("service-repair.lock is suspended during systemctl start when pre-start proof holds", serviceRepairLockFreeDuringStart);
      const answered = await queryDaemon({ paths, timeoutMs: 2_000 });
      check(
        "replacement daemon is live and answering at daemon.sock",
        answered.ok && answered.result.pid === mainPid,
        answered,
      );
    } finally {
      if (replacement) {
        const deadline = Date.now() + 10_000;
        while (!existsSync(paths.socket) && replacement.exitCode === null && Date.now() < deadline) {
          await delay(25);
        }
        await killAndAwaitExit(replacement, "SIGTERM");
      }
      await new Promise<void>((resolve) => control.close(() => resolve()));
    }
  }
} finally {
  rmSync(root, { recursive: true, force: true });
}

finish();
