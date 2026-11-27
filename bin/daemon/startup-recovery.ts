/**
 * Startup update-recovery detection and post-start systemd recovery verification.
 *
 * When an interrupted update leaves a restorable `update-recovery.json` record and a native
 * `daemon serve` starts, `serve()` runs `recoverInterruptedUpdate(..., true)` before opening
 * `daemon.sock` or calling `systemd-notify --ready`. That recovery spawns a bound `cotal update`
 * reconcile child, then throws so the native supervisor restarts the restored binary.
 *
 * Two rules keep that recovery deadlock-free without weakening ordinary update or service-start
 * guarantees:
 *
 *  1. The reconcile child skips `waitForInstalledGeneration` only when its parent is a verified
 *     native `daemon serve` actively restoring that exact transaction. Waiting inside `daemon serve`
 *     before `daemon.sock` exists cannot succeed; foreground `cotal daemon serve` and `cotal update`
 *     children keep the wait.
 *
 *  2. `systemctl --user start` derives its call timeout from the unit's `TimeoutStartSec` plus a
 *     5-second margin. When `systemctl --user start` exits non-zero only because startup recovery
 *     intentionally exited after restoring the previous CLI, the caller waits up to `TimeoutStartSec`
 *     for `Restart=always` to bring up the restored daemon, gated on exact before/after proof on
 *     `<home>/update-recovery.json`.
 */
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join, win32 } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import {
  CommandFailure,
  homeCotalDir,
  readLocalRecordSource,
  readUpdateRecovery,
  recoveryDisposition,
  recoveryOwner,
  recoveryProcessStartToken,
  withSuspendedUpdateClosureAccess,
  type UpdateRecovery,
} from "@cotal-ai/workspace";
import { queryDaemon } from "./client.js";
import { DAEMON_PROTOCOL_VERSION, daemonUserServiceEnv, EndpointRefusal, type DaemonPaths } from "./endpoint.js";
import { nativeRun } from "./install-native-run.js";
import type { NativeRun } from "./install.js";
import { processBirth, readLifetimeRecord } from "./lifetime.js";

/** `TimeoutStartSec` in the rendered systemd user unit, and the post-recovery readiness bound. */
export const DAEMON_SYSTEMD_START_TIMEOUT_SEC = 60;
/** Margin above `TimeoutStartSec` so `systemctl --user start` returns its own exit status rather than `ETIMEDOUT`. */
export const DAEMON_SYSTEMD_START_CALL_MARGIN_SEC = 5;
/** Call timeout passed to `systemctl --user start` for the daemon unit. */
export const DAEMON_SYSTEMD_START_TIMEOUT_MS =
  (DAEMON_SYSTEMD_START_TIMEOUT_SEC + DAEMON_SYSTEMD_START_CALL_MARGIN_SEC) * 1000;
/** Maximum wait for `Restart=always` to bring up the restored daemon after proven startup recovery. */
export const DAEMON_SYSTEMD_RECOVERY_WAIT_MS = DAEMON_SYSTEMD_START_TIMEOUT_SEC * 1000;
/** Sockets whose service just completed startup update-recovery to a restored CLI version. */
const startupRecoveredSockets = new Set<string>();

/** Mark a daemon socket as having completed startup update-recovery during a native service start. */
export function markDaemonStartupRecovered(socket: string): void {
  startupRecoveredSockets.add(socket);
}

/** Consume any startup-recovery marker for `socket` before checking `opts.version`. */
export function consumeDaemonStartupRecovered(socket: string): boolean {
  return startupRecoveredSockets.delete(socket);
}

/** Read a live parent process's argument tokens, or `undefined` when unavailable. */
export function readParentArgv(ppid: number, platform: NodeJS.Platform = process.platform): string[] | undefined {
  if (!Number.isSafeInteger(ppid) || ppid <= 0) return undefined;
  if (platform === "linux") {
    try {
      const raw = readFileSync(`/proc/${ppid}/cmdline`, "utf8");
      const tokens = raw.split("\0");
      if (tokens.at(-1) === "") tokens.pop();
      return tokens.length ? tokens : undefined;
    } catch {
      return undefined;
    }
  }
  if (platform === "darwin") {
    const res = spawnSync("/bin/ps", ["-p", String(ppid), "-o", "command="], {
      encoding: "utf8",
      timeout: 5_000,
      maxBuffer: 64 * 1024,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    if (res.error || res.status !== 0) return undefined;
    const line = res.stdout.trim();
    return line ? line.split(/\s+/) : undefined;
  }
  if (platform === "win32") {
    const root = process.env.SystemRoot ?? "C:\\Windows";
    const ps = join(root, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
    const script =
      `$ErrorActionPreference = 'Stop'; [Console]::OutputEncoding = [Text.Encoding]::UTF8; ` +
      `$p = Get-CimInstance Win32_Process -Filter 'ProcessId = ${ppid}' -Property CommandLine; ` +
      `if ($null -ne $p -and $null -ne $p.CommandLine) { [Console]::Out.Write($p.CommandLine) }`;
    const res = spawnSync(ps, ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")], {
      encoding: "utf8",
      timeout: 10_000,
      maxBuffer: 256 * 1024,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    if (res.error || res.status !== 0) return undefined;
    const line = res.stdout.trim();
    if (!line) return undefined;
    return [...line.matchAll(/"([^"]*)"|([^\s"]+)/g)].map((match) => match[1] ?? match[2]!);
  }
  return undefined;
}

/** Whether `argv` belongs to a `daemon serve` (or Windows packaged `--daemon` / `daemon-native`) host, never `update`. */
export function isDaemonServeArgv(argv: readonly string[] | undefined, platform: NodeJS.Platform = process.platform): boolean {
  if (!argv || argv.length === 0) return false;
  for (let i = 0; i < argv.length - 1; i++) {
    if (argv[i] === "daemon" && argv[i + 1] === "serve") {
      return !argv.slice(0, i).includes("update");
    }
  }
  if (platform === "win32") {
    const exe = win32.basename(argv[0]!).toLowerCase();
    if (exe === "cotal-desktop.exe" && argv[1] === "--daemon") return true;
    if (argv.some((token) => /^daemon-native\.[cm]?[jt]s$/i.test(win32.basename(token)))) return true;
  }
  return false;
}

export interface StartupRecoveryParentDeps {
  readonly env?: NodeJS.ProcessEnv;
  readonly ppid?: number;
  readonly platform?: NodeJS.Platform;
  readonly readRecovery?: () => UpdateRecovery | undefined;
  readonly ownerStart?: (pid: number) => string | undefined;
  readonly parentArgv?: (pid: number) => readonly string[] | undefined;
}

/**
 * True only when this bound reconcile child's parent is a native `daemon serve` running startup
 * update recovery (`COTAL_DAEMON_NATIVE_SERVICE === "1"`, `phase === "restoring"`, live `owner`
 * matching `process.ppid` and its start token, and parent argv proving `daemon serve`).
 */
export function nativeStartupUpdateRecoveryParent(
  beforeWriteRecovery?: UpdateRecovery,
  deps: StartupRecoveryParentDeps = {},
): boolean {
  const env = deps.env ?? process.env;
  const ppid = deps.ppid ?? process.ppid;
  const platform = deps.platform ?? process.platform;
  if (env.COTAL_DAEMON_NATIVE_SERVICE !== "1") return false;
  if (!Number.isSafeInteger(ppid) || ppid <= 0 || env.COTAL_UPDATE_PARENT !== String(ppid)) return false;
  let record = beforeWriteRecovery;
  if (!record) {
    try { record = (deps.readRecovery ?? readUpdateRecovery)(); }
    catch { return false; }
  }
  if (!record || record.phase !== "restoring") return false;
  const owner = recoveryOwner(record);
  if (!owner || owner.pid !== ppid) return false;
  if (env.COTAL_UPDATE_CLOSURE_NONCE !== undefined && owner.nonce !== env.COTAL_UPDATE_CLOSURE_NONCE) return false;
  let liveStart: string | undefined;
  try { liveStart = (deps.ownerStart ?? recoveryProcessStartToken)(ppid); }
  catch { return false; }
  if (liveStart === undefined) return false;
  if (owner.start !== "" ? liveStart !== owner.start : platform !== "win32") return false;
  if (env.COTAL_UPDATE_CLOSURE_START !== undefined && env.COTAL_UPDATE_CLOSURE_START !== "" && owner.start !== env.COTAL_UPDATE_CLOSURE_START) return false;
  const argv = (deps.parentArgv ?? ((pid: number) => readParentArgv(pid, platform)))(ppid);
  return isDaemonServeArgv(argv, platform);
}

/** Evidence captured before `systemctl --user start` that startup recovery will run and exit. */
export interface PreStartRestorableProof {
  readonly recoveryPath: string;
  readonly priorMainPid: number;
  readonly priorLifetime: ReturnType<typeof readLifetimeRecord>;
}

function parseSystemdMainPid(run: NativeRun, unit: string, env: NodeJS.ProcessEnv): { activeState: string; mainPid: number } | undefined {
  let res;
  try {
    res = run("systemctl", ["--user", "--no-ask-password", "--no-pager", "show", unit, "--property=ActiveState", "--property=MainPID"], env, 5_000);
  } catch {
    return undefined;
  }
  if (res.status !== 0) return undefined;
  let activeState = "";
  let mainPid = -1;
  for (const line of res.stdout.split("\n")) {
    if (line.startsWith("ActiveState=")) activeState = line.slice("ActiveState=".length).trim();
    else if (line.startsWith("MainPID=")) {
      const raw = line.slice("MainPID=".length).trim();
      if (/^(?:0|[1-9][0-9]*)$/.test(raw) && Number.isSafeInteger(Number(raw))) mainPid = Number(raw);
    }
  }
  return activeState && mainPid >= 0 ? { activeState, mainPid } : undefined;
}

/**
 * Inspect `<home>/update-recovery.json` before `systemctl --user start` to establish whether a
 * restorable interrupted update (`replacing` or `verified-ready`, valid local snapshot, dead owner)
 * is pending for the default machine daemon. Any ambiguity returns `undefined`.
 */
export function capturePreStartRestorableProof(
  paths: Pick<DaemonPaths, "lock">,
  daemonHome: string | undefined,
  unit: string,
  opts: {
    readonly homeDir?: string;
    readonly run?: NativeRun;
    readonly serviceEnv?: NodeJS.ProcessEnv;
    readonly lookupOwner?: (pid: number) => string | undefined;
  } = {},
): PreStartRestorableProof | undefined {
  if (daemonHome !== undefined) return undefined;
  const home = opts.homeDir ?? homeCotalDir();
  const recoveryPath = join(home, "update-recovery.json");
  let raw: Buffer | undefined;
  try { raw = readLocalRecordSource(recoveryPath, 64 * 1024, true); }
  catch { return undefined; }
  if (!raw) return undefined;
  let parsed: unknown;
  try { parsed = JSON.parse(raw.toString("utf8")); }
  catch { return undefined; }
  if (!parsed || typeof parsed !== "object") return undefined;
  const candidate = parsed as UpdateRecovery;
  if (candidate.v !== 1 || (candidate.phase !== "replacing" && candidate.phase !== "verified-ready")) return undefined;
  if (typeof candidate.snapshot !== "string" || !candidate.snapshot) return undefined;
  if (!recoveryOwner(candidate)) return undefined;
  const disposition = recoveryDisposition(candidate, Date.now(), opts.lookupOwner ?? recoveryProcessStartToken);
  if (disposition.action !== "restore") return undefined;
  const run = opts.run ?? nativeRun;
  const env = opts.serviceEnv ?? daemonUserServiceEnv();
  const shown = parseSystemdMainPid(run, unit, env);
  return {
    recoveryPath,
    priorMainPid: shown?.mainPid ?? 0,
    priorLifetime: readLifetimeRecord(paths.lock),
  };
}

/** Check whether `<home>/update-recovery.json` now holds the exact raw `null` tombstone `clearUpdateRecovery()` writes. */
export function hasPostStartClearedTombstone(recoveryPath: string): boolean {
  let raw: Buffer | undefined;
  try { raw = readLocalRecordSource(recoveryPath, 64 * 1024, true); }
  catch { return false; }
  if (!raw) return false;
  try { return JSON.parse(raw.toString("utf8")) === null; }
  catch { return false; }
}

export interface SystemdStartupRecoveryWaitDeps {
  readonly run?: NativeRun;
  readonly serviceEnv?: NodeJS.ProcessEnv;
  readonly waitMs?: number;
  readonly pollMs?: number;
  readonly query?: typeof queryDaemon;
  readonly readRecovery?: () => UpdateRecovery | undefined;
  readonly birth?: typeof processBirth;
}

/**
 * Run `systemctl --user start <unit>` with the derived 65s call timeout. On non-zero exit, wait up
 * to 60s only when pre-start restorable proof and post-start raw `null` tombstone both hold;
 * succeed only when `MainPID` is a new live process, `daemon.sock` answers, and
 * `readUpdateRecovery() === undefined`. Otherwise throw the exact unretried refusal.
 */
export async function startSystemdDaemonUnit(
  paths: DaemonPaths,
  daemonHome: string | undefined,
  unit: string,
  deps: SystemdStartupRecoveryWaitDeps & {
    readonly homeDir?: string;
    readonly lookupOwner?: (pid: number) => string | undefined;
    readonly suspendServiceLock?: <T>(fn: () => Promise<T>) => Promise<T>;
  } = {},
): Promise<boolean> {
  const run = deps.run ?? nativeRun;
  const env = deps.serviceEnv ?? daemonUserServiceEnv();
  const preProof = capturePreStartRestorableProof(paths, daemonHome, unit, {
    homeDir: deps.homeDir,
    run,
    serviceEnv: env,
    lookupOwner: deps.lookupOwner,
  });
  const invokeStart = () => run("systemctl", ["--user", "--no-ask-password", "--no-pager", "start", unit], env, DAEMON_SYSTEMD_START_TIMEOUT_MS);
  const runSuspended = async () => withSuspendedUpdateClosureAccess(async () => invokeStart());
  const result = preProof
    ? await (deps.suspendServiceLock ? deps.suspendServiceLock(runSuspended) : runSuspended())
    : invokeStart();
  if (result.status === 0) return false;
  const unconfirmed = () =>
    new CommandFailure(
      "unknown",
      "OPERATION_UNKNOWN",
      `the native daemon start did not confirm completion (${result.detail}); it was not retried`,
      { target: { unit }, remedy: "correct the native service error, then run `cotal daemon start`" },
    );
  if (!preProof || !hasPostStartClearedTombstone(preProof.recoveryPath)) throw unconfirmed();
  const waitMs = deps.waitMs ?? DAEMON_SYSTEMD_RECOVERY_WAIT_MS;
  const pollMs = deps.pollMs ?? 200;
  const query = deps.query ?? queryDaemon;
  const readRec = deps.readRecovery ?? readUpdateRecovery;
  const birth = deps.birth ?? processBirth;
  const deadline = Date.now() + waitMs;
  for (;;) {
    try {
      if (readRec() === undefined && hasPostStartClearedTombstone(preProof.recoveryPath)) {
        const shown = parseSystemdMainPid(run, unit, env);
        if (shown && shown.activeState === "active" && shown.mainPid > 0 && shown.mainPid !== preProof.priorMainPid) {
          const lifetime = readLifetimeRecord(paths.lock);
          const freshLifetime =
            Boolean(lifetime?.start) &&
            lifetime!.pid === shown.mainPid &&
            birth(lifetime!.pid) === lifetime!.start &&
            !(preProof.priorLifetime?.pid === lifetime!.pid && preProof.priorLifetime?.start === lifetime!.start);
          if (freshLifetime) {
            const reply = await query({ paths, timeoutMs: Math.min(2_000, Math.max(250, deadline - Date.now())) });
            if (
              reply.ok &&
              reply.result.pid === shown.mainPid &&
              reply.result.protocol === DAEMON_PROTOCOL_VERSION &&
              birth(shown.mainPid) === lifetime!.start &&
              readRec() === undefined
            ) {
              markDaemonStartupRecovered(paths.socket);
              return true;
            }
          }
        }
      }
    } catch (error) {
      if (!(error instanceof EndpointRefusal && (error.code === "NOT_RUNNING" || error.code === "PEER_NOT_LOCK_OWNER"))) {
        if (Date.now() >= deadline) throw unconfirmed();
      }
    }
    if (Date.now() >= deadline) throw unconfirmed();
    await delay(Math.min(pollMs, Math.max(1, deadline - Date.now())));
  }
}
