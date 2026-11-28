/**
 * Startup update-recovery detection and post-start systemd recovery verification.
 *
 * When an interrupted update leaves a restorable `update-recovery.json` record and a native
 * `daemon serve` starts on Linux, `serve()` runs `recoverInterruptedUpdate(..., true)` before
 * opening `daemon.sock` or calling `systemd-notify --ready`. That recovery restores the previous
 * release onto disk, spawns a bound `cotal update` reconcile child from that restored release,
 * then throws so the native supervisor restarts the restored binary.
 *
 * Two rules keep that recovery deadlock-free across both older published releases and current
 * builds without weakening ordinary update or service-start guarantees:
 *
 *  1. On Linux, `daemon serve` passes `startupRecoveryChildEnv(process.env)` as the startup
 *     recovery runtime's `env` (omitting `XDG_RUNTIME_DIR` on `COTAL_DAEMON_NATIVE_SERVICE=1`
 *     before `daemon.sock` is bound, so restored published reconcile children whose `daemonPaths()`
 *     falls back to `/run/user/<uid>` see an empty non-directory marker and return cleanly from
 *     `waitForInstalledDaemonGeneration` via `NO_RUNTIME_DIR`), and current reconcile children
 *     additionally skip `waitForInstalledGeneration` directly when `nativeStartupUpdateRecoveryParent`
 *     confirms the live native `daemon serve` restoring parent. Foreground `cotal daemon serve`,
 *     `cotal update` children, and macOS and Windows keep the wait.
 *
 *  2. `systemctl --user start` for an installed daemon uses a 65-second call timeout derived from
 *     the unit's `TimeoutStartSec=60` plus a 5-second margin. When `systemctl --user start` fails
 *     only because startup recovery intentionally exited after restoring the previous CLI, the
 *     caller waits up to `TimeoutStartSec` for `Restart=always` to bring up the restored daemon at
 *     that exact `previous` version, gated on before/after proof on `<home>/update-recovery.json`.
 */
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import {
  acquireLockAsync,
  claimUpdateClosureAccess,
  CommandFailure,
  homeCotalDir,
  readLocalRecordSource,
  readUpdateRecovery,
  recoveryDisposition,
  recoveryOwner,
  recoveryProcessStartToken,
  type AcquireOptions,
  type HeldLock,
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
/** Total recovery budget (`systemctl start` + post-start `Restart=always` readiness + lock re-acquire). */
export const DAEMON_SYSTEMD_RECOVERY_BUDGET_MS =
  DAEMON_SYSTEMD_START_TIMEOUT_MS + DAEMON_SYSTEMD_RECOVERY_WAIT_MS;

export interface DaemonClosureScope {
  suspend<T>(fn: () => Promise<T>, remainingBudgetMs?: () => number): Promise<T>;
  release(): void;
}

export interface DaemonClosureScopeDeps {
  readonly claim?: typeof claimUpdateClosureAccess;
  readonly env?: NodeJS.ProcessEnv;
  readonly defaultReacquireWaitMs?: number;
}

/**
 * Claim `.update-closure.lock` for a `bin/daemon/` caller (`setup.ts`) so `startSystemdDaemonUnit`
 * can suspend that single claim during proven startup recovery without exposing a public workspace
 * symbol or risking a double-release if re-acquisition fails. Re-acquisition uses `claim(false, budget)`
 * so contended waits announce on stderr like `main` and stay bounded by the remaining recovery budget.
 */
let activeDaemonClosureScope: DaemonClosureScope | undefined;

export function claimSuspendableDaemonClosure(deps: DaemonClosureScopeDeps = {}): DaemonClosureScope {
  const claim = deps.claim ?? claimUpdateClosureAccess;
  const env = deps.env ?? process.env;
  const fallbackWaitMs = deps.defaultReacquireWaitMs ?? DAEMON_SYSTEMD_RECOVERY_WAIT_MS;
  let releaseUnderlying: (() => void) | undefined = claim();
  const previousScope = activeDaemonClosureScope;
  const scope: DaemonClosureScope = {
    async suspend<T>(fn: () => Promise<T>, remainingBudgetMs?: () => number): Promise<T> {
      if (!releaseUnderlying || env.COTAL_UPDATE_CLOSURE_TRANSACTION === "1") return await fn();
      const drop = releaseUnderlying;
      releaseUnderlying = undefined;
      drop();
      let failed = false;
      try {
        return await fn();
      } catch (error) {
        failed = true;
        throw error;
      } finally {
        const waitMs = Math.max(0, remainingBudgetMs ? remainingBudgetMs() : fallbackWaitMs);
        try {
          releaseUnderlying = claim(false, waitMs);
        } catch (reacquireError) {
          if (!failed) {
            const detail = reacquireError instanceof Error ? reacquireError.message : String(reacquireError);
            throw new CommandFailure(
              "refused",
              "DEPENDENCY_UNAVAILABLE",
              `could not reacquire the Cotal update closure lock after native daemon recovery (${detail})`,
              { remedy: "wait for any active Cotal update to finish, inspect `cotal daemon status`, and run the command again" },
            );
          }
        }
      }
    },
    release(): void {
      if (activeDaemonClosureScope === scope) activeDaemonClosureScope = previousScope;
      const drop = releaseUnderlying;
      releaseUnderlying = undefined;
      drop?.();
    },
  };
  activeDaemonClosureScope = scope;
  return scope;
}

export interface SuspendServiceLockDeps {
  readonly acquire?: (path: string, opts?: AcquireOptions) => Promise<HeldLock>;
  readonly defaultReacquireWaitMs?: number;
  readonly onWait?: () => void;
}

/**
 * Acquire `service-repair.lock` with a `suspend` helper that releases the lock around a proven
 * recovery wait, announces contended re-acquires, bounds re-acquisition to the remaining recovery
 * budget, and converts any re-acquisition timeout into a clean `CommandFailure` refusal.
 */
export async function claimSuspendableServiceRepairLock(
  lockPath: string,
  enabled = process.platform === "darwin" || process.platform === "linux",
  deps: SuspendServiceLockDeps = {},
): Promise<{ suspend<T>(fn: () => Promise<T>, remainingBudgetMs?: () => number): Promise<T>; release(): void }> {
  const acquire = deps.acquire ?? acquireLockAsync;
  const fallbackWaitMs = deps.defaultReacquireWaitMs ?? DAEMON_SYSTEMD_RECOVERY_WAIT_MS;
  const onWait = deps.onWait ?? (() => {
    console.error("waiting for another daemon service operation to finish");
  });
  let lock: HeldLock | undefined = enabled ? await acquire(lockPath) : undefined;
  return {
    async suspend<T>(fn: () => Promise<T>, remainingBudgetMs?: () => number): Promise<T> {
      if (!lock) return await fn();
      const drop = lock;
      lock = undefined;
      drop.release();
      let failed = false;
      try {
        return await fn();
      } catch (error) {
        failed = true;
        throw error;
      } finally {
        const waitMs = Math.max(0, remainingBudgetMs ? remainingBudgetMs() : fallbackWaitMs);
        try {
          lock = await acquire(lockPath, {
            label: "the daemon service lock",
            waitMs,
            onWait,
          });
        } catch (reacquireError) {
          if (!failed) {
            const detail = reacquireError instanceof Error ? reacquireError.message : String(reacquireError);
            throw new CommandFailure(
              "refused",
              "DEPENDENCY_UNAVAILABLE",
              `could not reacquire the daemon service lock after native daemon recovery (${detail})`,
              { remedy: "inspect `cotal daemon status` and retry once the other daemon service operation finishes" },
            );
          }
        }
      }
    },
    release(): void {
      const drop = lock;
      lock = undefined;
      drop?.release();
    },
  };
}

/**
 * Environment passed to `recoverInterruptedUpdate(..., true)` inside `daemon serve` before
 * `daemon.sock` is bound. On native Linux `daemon serve` (`COTAL_DAEMON_NATIVE_SERVICE === "1"`),
 * setting `XDG_RUNTIME_DIR: "/dev/null"` in the child copy (never mutating `process.env`) makes
 * unmodified older published reconcile children (`cotal-ai@0.183.1` and earlier) receive
 * `EndpointRefusal("NO_RUNTIME_DIR")` in `daemonPaths()` instead of falling back to `/run/user/<uid>`,
 * so `reportRunningManager` falls back to local/retained Manager continuity and
 * `waitForInstalledDaemonGeneration` returns immediately instead of waiting 120s for a socket the
 * parent has not opened yet. Foreground `daemon serve` and non-Linux platforms keep `env` unchanged.
 */
export function startupRecoveryChildEnv(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): NodeJS.ProcessEnv {
  if (platform !== "linux" || env.COTAL_DAEMON_NATIVE_SERVICE !== "1") return env;
  return { ...env, XDG_RUNTIME_DIR: "/dev/null" };
}

/** Read a live Linux parent process's argument tokens from `/proc/<ppid>/cmdline`, or `undefined`. */
export function readParentArgv(ppid: number, platform: NodeJS.Platform = process.platform): string[] | undefined {
  if (platform !== "linux" || !Number.isSafeInteger(ppid) || ppid <= 0) return undefined;
  try {
    const raw = readFileSync(`/proc/${ppid}/cmdline`, "utf8");
    const tokens = raw.split("\0");
    if (tokens.at(-1) === "") tokens.pop();
    return tokens.length ? tokens : undefined;
  } catch {
    return undefined;
  }
}

/** Whether Linux `argv` belongs to a `daemon serve` host, never `update`. */
export function isDaemonServeArgv(argv: readonly string[] | undefined, platform: NodeJS.Platform = process.platform): boolean {
  if (platform !== "linux" || !argv || argv.length === 0) return false;
  for (let i = 0; i < argv.length - 1; i++) {
    if (argv[i] === "daemon" && argv[i + 1] === "serve") {
      return !argv.slice(0, i).includes("update");
    }
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
 * True on Linux only when this bound reconcile child's parent is a native `daemon serve` running
 * startup update recovery (`COTAL_DAEMON_NATIVE_SERVICE === "1"`, `phase === "restoring"`, live
 * `owner` matching `process.ppid` and its start token, and parent argv proving `daemon serve`).
 */
export function nativeStartupUpdateRecoveryParent(
  beforeWriteRecovery?: UpdateRecovery,
  deps: StartupRecoveryParentDeps = {},
): boolean {
  const platform = deps.platform ?? process.platform;
  if (platform !== "linux") return false;
  const env = deps.env ?? process.env;
  const ppid = deps.ppid ?? process.ppid;
  if (env.COTAL_DAEMON_NATIVE_SERVICE !== "1") return false;
  if (!Number.isSafeInteger(ppid) || ppid <= 0 || env.COTAL_UPDATE_PARENT !== String(ppid)) return false;
  let record = beforeWriteRecovery;
  if (!record) {
    try { record = (deps.readRecovery ?? readUpdateRecovery)(); }
    catch { return false; }
  }
  if (!record || record.phase !== "restoring") return false;
  const owner = recoveryOwner(record);
  if (!owner || owner.pid !== ppid || !owner.start) return false;
  if (env.COTAL_UPDATE_CLOSURE_NONCE !== undefined && owner.nonce !== env.COTAL_UPDATE_CLOSURE_NONCE) return false;
  let liveStart: string | undefined;
  try { liveStart = (deps.ownerStart ?? recoveryProcessStartToken)(ppid); }
  catch { return false; }
  if (liveStart === undefined || liveStart !== owner.start) return false;
  if (env.COTAL_UPDATE_CLOSURE_START !== undefined && env.COTAL_UPDATE_CLOSURE_START !== "" && owner.start !== env.COTAL_UPDATE_CLOSURE_START) return false;
  const argv = (deps.parentArgv ?? ((pid: number) => readParentArgv(pid, platform)))(ppid);
  return isDaemonServeArgv(argv, platform);
}

/** Evidence captured before `systemctl --user start` that startup recovery will run and exit. */
export interface PreStartRestorableProof {
  readonly recoveryPath: string;
  readonly previousVersion: string;
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
  if (typeof candidate.previous !== "string" || !candidate.previous) return undefined;
  if (typeof candidate.snapshot !== "string" || !candidate.snapshot) return undefined;
  if (!recoveryOwner(candidate)) return undefined;
  const disposition = recoveryDisposition(candidate, Date.now(), opts.lookupOwner ?? recoveryProcessStartToken);
  if (disposition.action !== "restore") return undefined;
  const run = opts.run ?? nativeRun;
  const env = opts.serviceEnv ?? daemonUserServiceEnv();
  const shown = parseSystemdMainPid(run, unit, env);
  return {
    recoveryPath,
    previousVersion: candidate.previous,
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

export type SystemdStartRefusalStyle = "unit-control" | "daemon-restart";

export interface SystemdStartupRecoveryWaitDeps {
  readonly run?: NativeRun;
  readonly serviceEnv?: NodeJS.ProcessEnv;
  readonly refusalStyle?: SystemdStartRefusalStyle;
  readonly waitMs?: number;
  readonly pollMs?: number;
  readonly query?: typeof queryDaemon;
  readonly readRecovery?: () => UpdateRecovery | undefined;
  readonly birth?: typeof processBirth;
}

function unconfirmedStartFailure(style: SystemdStartRefusalStyle, unit: string, detail?: string): CommandFailure {
  if (style === "unit-control") {
    return new CommandFailure(
      "unknown",
      "OPERATION_UNKNOWN",
      "the native start request did not confirm completion; it was not retried",
      { target: { unit, operation: "start" } },
    );
  }
  return new CommandFailure(
    "unknown",
    "OPERATION_UNKNOWN",
    `the native daemon start did not confirm completion (${detail ?? ""}); it was not retried`,
    { target: { unit }, remedy: "correct the native service error, then run `cotal daemon start`" },
  );
}

function invokeControlStart(unit: string, env: NodeJS.ProcessEnv, timeoutMs: number): { status: number | null; detail: string; failed: boolean } {
  const result = spawnSync("systemctl", ["--user", "--no-ask-password", "--no-pager", "start", unit], {
    env,
    encoding: "utf8",
    timeout: timeoutMs,
    maxBuffer: 32 * 1024,
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.error || result.signal || result.status !== 0) {
    return { status: result.status, detail: "", failed: true };
  }
  return { status: 0, detail: "", failed: false };
}

/**
 * Run `systemctl --user start <unit>` with the derived 65s call timeout.
 *
 * - `refusalStyle === "unit-control"` (default for `startInstalled` and `startEnabledInstalled`)
 *   preserves `submitSystemdUnitControl("start", unit)`'s exact `OPERATION_UNKNOWN` message,
 *   `target: { unit, operation: "start" }`, and exit code `3` on every failure, including timeouts
 *   and signals.
 * - `refusalStyle === "daemon-restart"` (`restartInstalled`) preserves `nativeRun`'s
 *   `DEPENDENCY_UNAVAILABLE` timeout/signal refusal and `restartInstalled`'s `OPERATION_UNKNOWN`
 *   non-zero status refusal.
 *
 * When pre-start restorable proof holds, both `.update-closure.lock` (if held via
 * `claimSuspendableDaemonClosure`) and `service-repair.lock` (if passed via `suspendServiceLock`)
 * are suspended across `systemctl --user start` AND the post-start recovery wait so neither lock is
 * held across the up-to-60s wait. On proven recovery, returns `{ recoveredVersion: previous }`.
 */
export async function startSystemdDaemonUnit(
  paths: DaemonPaths,
  daemonHome: string | undefined,
  unit: string,
  deps: SystemdStartupRecoveryWaitDeps & {
    readonly homeDir?: string;
    readonly lookupOwner?: (pid: number) => string | undefined;
    readonly suspendServiceLock?: <T>(fn: () => Promise<T>, remainingBudgetMs?: () => number) => Promise<T>;
  } = {},
): Promise<{ readonly recoveredVersion?: string }> {
  const style = deps.refusalStyle ?? "unit-control";
  const inspectRun = deps.run ?? nativeRun;
  const env = deps.serviceEnv ?? daemonUserServiceEnv();
  const preProof = capturePreStartRestorableProof(paths, daemonHome, unit, {
    homeDir: deps.homeDir,
    run: inspectRun,
    serviceEnv: env,
    lookupOwner: deps.lookupOwner,
  });

  const waitMs = deps.waitMs ?? DAEMON_SYSTEMD_RECOVERY_WAIT_MS;
  const budgetDeadline = Date.now() + DAEMON_SYSTEMD_START_TIMEOUT_MS + waitMs;
  const remainingBudgetMs = () => Math.max(0, budgetDeadline - Date.now());

  const runStartAndWait = async (): Promise<{ readonly recoveredVersion?: string }> => {
    let startFailed = false;
    let startDetail = "";
    if (style === "unit-control" && !deps.run) {
      const outcome = invokeControlStart(unit, env, DAEMON_SYSTEMD_START_TIMEOUT_MS);
      startFailed = outcome.failed;
      startDetail = outcome.detail;
    } else if (style === "unit-control") {
      try {
        const outcome = deps.run!("systemctl", ["--user", "--no-ask-password", "--no-pager", "start", unit], env, DAEMON_SYSTEMD_START_TIMEOUT_MS);
        startFailed = outcome.status !== 0;
        startDetail = outcome.detail;
      } catch {
        throw unconfirmedStartFailure("unit-control", unit);
      }
    } else {
      const outcome = inspectRun("systemctl", ["--user", "--no-ask-password", "--no-pager", "start", unit], env, DAEMON_SYSTEMD_START_TIMEOUT_MS);
      startFailed = outcome.status !== 0;
      startDetail = outcome.detail;
    }

    if (!startFailed) return {};
    const unconfirmed = () => unconfirmedStartFailure(style, unit, startDetail);
    if (!preProof || !hasPostStartClearedTombstone(preProof.recoveryPath)) throw unconfirmed();

    const pollMs = deps.pollMs ?? 200;
    const query = deps.query ?? queryDaemon;
    const readRec = deps.readRecovery ?? readUpdateRecovery;
    const birth = deps.birth ?? processBirth;
    const deadline = Math.min(budgetDeadline, Date.now() + waitMs);
    for (;;) {
      try {
        if (readRec() === undefined && hasPostStartClearedTombstone(preProof.recoveryPath)) {
          const shown = parseSystemdMainPid(inspectRun, unit, env);
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
                reply.result.version === preProof.previousVersion &&
                reply.result.protocol === DAEMON_PROTOCOL_VERSION &&
                birth(shown.mainPid) === lifetime!.start &&
                readRec() === undefined
              ) {
                return { recoveredVersion: preProof.previousVersion };
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
  };

  if (!preProof) return await runStartAndWait();
  const suspendClosure = <T>(fn: () => Promise<T>): Promise<T> =>
    activeDaemonClosureScope ? activeDaemonClosureScope.suspend(fn, remainingBudgetMs) : fn();
  return await (deps.suspendServiceLock
    ? deps.suspendServiceLock(() => suspendClosure(runStartAndWait), remainingBudgetMs)
    : suspendClosure(runStartAndWait));
}
