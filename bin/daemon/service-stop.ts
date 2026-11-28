/**
 * Stop and start of the recorded background service. A stop turns automatic start off and then
 * stops. A start turns it back on. The marker records that the person stopped it, and only a start
 * that was proven clears it.
 */
import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { acquireLockAsync, writeSecretFile } from "@cotal-ai/core";
import { submitSystemdUnitControl, submitSystemdUnitRegistration } from "@cotal-ai/cli";
import { CommandFailure } from "@cotal-ai/workspace";
import { daemonUserServiceEnv, EndpointRefusal, type DaemonPaths } from "./endpoint.js";
import { openVerified } from "./client.js";
import { processBirth, readLifetimeRecord } from "./lifetime.js";
import { nativeRun } from "./install-native-run.js";
import { scheduledTaskService } from "./install-win32.js";
import { assertDesktopSetupComplete } from "./desktop-setup.js";
import { recordedUnit, requestInstalledDaemon, restartWindowsInstalled, type NativeService, type UninstallPlan } from "./install.js";

/** Start only the recorded, unchanged service. This does not restart an already-running daemon.
 *  `resume` turns automatic start back on. `cotal daemon start`, setup and the app's Start pass it,
 *  so a service the person stopped starts again and stays set to start on its own. */
export async function startInstalled(paths: DaemonPaths, daemonHome: string | undefined, expectedVersion?: string, report?: (detail: string) => void, resume = false, probe?: { service?: NativeService; windowsFailure?: unknown | (() => unknown); enabled?: () => boolean; setEnabled?: (enabled: boolean) => void }): Promise<UninstallPlan> {
  const lock = process.platform === "darwin" || process.platform === "linux" ? await acquireLockAsync(join(paths.state, "service-repair.lock")) : undefined;
  try {
  assertDesktopSetupComplete();
  if (process.platform === "win32" || probe?.windowsFailure !== undefined || probe?.enabled) {
    try {
      const failure = typeof probe?.windowsFailure === "function" ? probe.windowsFailure() : probe?.windowsFailure;
      if (failure !== undefined) throw failure;
      const started = await restartWindowsInstalled(paths, daemonHome, expectedVersion, report, true, undefined, resume);
      if (resume) clearPersonStop(paths);
      return started;
    } catch (error) {
      // A start that was not proven ends one way: disabled, the marker kept, exit 3. The marker stays because nothing started.
      let disabled = false;
      const disable = (): void => {
        if (probe?.setEnabled) { probe.setEnabled(false); disabled = true; return; }
        const current = recordedUnit(paths, daemonHome);
        scheduledTaskService(nativeRun).prepareStop(current.receipt);
        disabled = true;
      };
      try { disable(); }
      catch { try { disable(); } catch { disabled = false; } }
      const message = error instanceof CommandFailure ? error.message : error instanceof Error ? error.message : String(error);
      const carried = error instanceof CommandFailure ? error.cause : undefined;
      const settled = carried === "disabled" || carried === "enabled" ? carried === "disabled" : disabled;
      const ended = settled
        ? `Nothing was started. ${message} Automatic start is off. Run \`cotal daemon start\` again.`
        : `${message} Automatic start is on, and it could not be turned off. Run \`cotal daemon stop\` to turn it off, or \`cotal daemon start\` to start it.`;
      const remedy = settled ? "run `cotal daemon start` again" : "run `cotal daemon stop` to turn it off, or `cotal daemon start` to start it";
      if (error instanceof CommandFailure) throw new CommandFailure("unknown", "OPERATION_UNKNOWN", ended, { remedy, native: error.native, cause: error });
      throw new CommandFailure("unknown", "OPERATION_UNKNOWN", ended, { remedy, cause: error });
    }
  }
  const recorded = recordedUnit(paths, daemonHome);
  const { receipt, plan } = recorded;
  const service = probe?.service ?? recorded.service;
  let automaticOn = false;
  if (!service && resume && process.platform === "linux") {
    const read = nativeRun("systemctl", ["--user", "--no-ask-password", "--no-pager", "show", plan.unit, "--property=UnitFileState", "--value"], daemonUserServiceEnv());
    if (read.status !== 0) throw new CommandFailure("refused", "TARGET_UNAVAILABLE", `systemctl --user show ${plan.unit} did not confirm UnitFileState (${read.detail}); nothing was started`);
    const state = read.stdout.trim();
    if (state === "disabled") submitSystemdUnitRegistration("enable", plan.unit);
    else if (state !== "enabled" && state !== "static") throw new CommandFailure("refused", "TARGET_UNAVAILABLE", `the recorded service ${plan.unit} is ${state || "unreadable"}; automatic start was not changed and it was not started`);
    automaticOn = true;
  }
  try {
    if (service) service.start(receipt, resume);
    else submitSystemdUnitControl("start", plan.unit);
    if (service && resume) {
      try { automaticOn = service.isEnabled?.(receipt) === true; }
      catch (error) {
        // The start returned, so automatic start was turned on. A failed re-read must not leave the stop marker on a running service.
        clearPersonStop(paths);
        throw new CommandFailure("refused", "TARGET_UNAVAILABLE", "the service started, but automatic start could not be read", { cause: error });
      }
    }
    if (service && resume && !automaticOn) throw new CommandFailure("unknown", "OPERATION_UNKNOWN", "the service started, but automatic start was not confirmed on", { remedy: "run `cotal daemon start` again" });
  } catch (error) {
    if (error instanceof CommandFailure && error.message === "the service started, but automatic start could not be read") throw error;
    if (resume && personStopped(paths)) {
      try {
        if (service) await service.stop(receipt);
        else submitSystemdUnitRegistration("disable", plan.unit);
        automaticOn = false;
      } catch { automaticOn = true; }
    } else if (service && resume && service.isEnabled) {
      try { automaticOn = service.isEnabled(receipt) === true; } catch { automaticOn = false; }
    }
    if (automaticOn) clearPersonStop(paths);
    if (!automaticOn && resume && personStopped(paths) && error instanceof CommandFailure) {
      throw new CommandFailure(error.outcome, error.code, `${error.message} Automatic start is off. Run \`cotal daemon start\` again.`, { remedy: "run `cotal daemon start` again", native: error.native, cause: error });
    }
    throw resumeStartFailed(error, automaticOn);
  }
  if (resume) clearPersonStop(paths);
  return plan;
  } finally { lock?.release(); }
}

/** The person stopped the service. A disabled unit on its own is not this: a restart can disable one too. */
function personStopFile(paths: Pick<DaemonPaths, "state">): string {
  return join(paths.state, "service-stopped-by-you");
}

export function personStopped(paths: Pick<DaemonPaths, "state">): boolean {
  return existsSync(personStopFile(paths));
}

function markPersonStop(paths: Pick<DaemonPaths, "state">): void {
  writeSecretFile(personStopFile(paths), "stopped\n");
}

export function clearPersonStop(paths: Pick<DaemonPaths, "state">): void {
  rmSync(personStopFile(paths), { force: true });
}

/** A resume whose enable already landed. The marker is gone, so the failure has to say automatic start is back on. */
function resumeStartFailed(error: unknown, automaticOn = true): unknown {
  if (!automaticOn || !(error instanceof CommandFailure)) return error;
  return new CommandFailure(error.outcome, error.code, `${error.message} Automatic start is on again, and the service did not start. Run \`cotal daemon start\` again.`, { remedy: error.remedy, native: error.native, cause: error });
}

/** Ask the running daemon to stop, then wait until its process has exited. A service that is not running needs nothing. */
async function requestDaemonStop(paths: DaemonPaths): Promise<void> {
  const before = readLifetimeRecord(paths.lock);
  let socket: Awaited<ReturnType<typeof openVerified>> | undefined;
  try { socket = await openVerified({ paths, timeoutMs: 5000 }); }
  catch (error) {
    if (error instanceof EndpointRefusal && error.code === "NOT_RUNNING") return;
    throw new CommandFailure("unknown", "OPERATION_UNKNOWN", "the background service could not be asked to exit, so it was not stopped", { native: { code: "STOP_NOT_SENT" }, cause: error });
  }
  const owner = readLifetimeRecord(paths.lock);
  if (!owner?.start || before?.pid !== owner.pid || before.start !== owner.start) {
    socket.destroy();
    throw new CommandFailure("refused", "CONFLICT", "the daemon changed while its stop was prepared, so it was not stopped", { native: { code: "STOP_NOT_SENT" } });
  }
  socket.on("error", () => {});
  try { await requestInstalledDaemon(socket, "daemon-stop"); }
  catch (error) { if (processBirth(owner.pid) === owner.start) { socket.destroy(); throw new CommandFailure("unknown", "OPERATION_UNKNOWN", "the background service could not be asked to exit, so it was not stopped", { native: { code: "STOP_NOT_SENT" }, cause: error }); } }
  if (processBirth(owner.pid) === owner.start) {
    try { await requestInstalledDaemon(socket, "daemon-stop", true); }
    catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      const ended = error instanceof Error && error.message === "daemon closed the connection without a reply";
      if (code !== "EPIPE" && code !== "ECONNRESET" && !ended && processBirth(owner.pid) === owner.start) { socket.destroy(); throw new CommandFailure("unknown", "OPERATION_UNKNOWN", "the daemon accepted the stop but the commit failed; automatic start is already off. Run `cotal daemon stop` again.", { cause: error }); }
    }
  }
  socket.destroy();
  const deadline = Date.now() + 130_000;
  for (;;) {
    if (processBirth(owner.pid) !== owner.start) {
      try { const probe = await openVerified({ paths, timeoutMs: 1000 }); probe.destroy(); }
      catch (error) { if (error instanceof EndpointRefusal && error.code === "NOT_RUNNING") return; }
    }
    if (Date.now() >= deadline) throw new CommandFailure("unknown", "OPERATION_UNKNOWN", "the daemon did not exit after its stop was committed; automatic start is already off. Run `cotal daemon stop` again.");
    await delay(100);
  }
}

/** Turn off automatic start, then stop the recorded service. The unit, plist or task stays installed,
 *  and so do the sign-in and the spaces. `cotal daemon start` turns automatic start back on.
 *  `confirm` runs under the stop lock and returns the live list. A live list that differs from
 *  the one the person confirmed is not stopped. */
export async function stopInstalled(paths: DaemonPaths, daemonHome: string | undefined, expected: readonly string[] = [], confirm?: () => Promise<readonly string[] | undefined>, serviceOverride?: NativeService): Promise<UninstallPlan & { readonly agents: readonly string[] }> {
  const lock = await acquireLockAsync(join(paths.state, "service-repair.lock"));
  try {
    const agents = confirm ? await confirm() ?? undefined : expected;
    if (agents === undefined) throw new CommandFailure("refused", "TARGET_UNAVAILABLE", "the running agents could not be read again, so the background service was not stopped");
    const same = agents.length === expected.length && agents.every((name, index) => name === expected[index]);
    if (!same) throw new CommandFailure("refused", "CONFLICT", `the running agents changed to: ${agents.length ? agents.join(", ") : "none"}. Nothing was stopped`, { remedy: "run the stop again so it names the current agents", native: { code: "AGENTS_CHANGED", detail: { agents: [...agents] } } });
    const recorded = recordedUnit(paths, daemonHome);
    const { receipt, plan } = recorded;
    const service = serviceOverride ?? recorded.service;
    if (service?.prepareStop) await Promise.resolve(service.prepareStop(receipt));
    if (service?.prepareStop && service.finishStop) {
      try { await requestDaemonStop(paths); }
      catch (error) {
        const notSent = error instanceof CommandFailure && error.native?.code === "STOP_NOT_SENT";
        if (!notSent) throw error;
        if (!service.enable) throw error;
        try { service.enable(receipt); }
        catch (restore) { throw new CommandFailure("unknown", "OPERATION_UNKNOWN", "automatic start was turned off, and it could not be turned back on. The background service is still running. Run `cotal daemon stop` again.", { native: error.native, cause: restore, remedy: "run `cotal daemon stop` again" }); }
        throw new CommandFailure("unknown", "OPERATION_UNKNOWN", "the background service was not stopped. Automatic start is still on. Run `cotal daemon stop` again.", { native: error.native, cause: error, remedy: "run `cotal daemon stop` again" });
      }
    }
    if (service?.finishStop) await service.finishStop(receipt);
    else if (service) await service.stop(receipt);
    else {
      submitSystemdUnitRegistration("disable", plan.unit);
      const read = nativeRun("systemctl", ["--user", "--no-ask-password", "--no-pager", "show", plan.unit, "--property=UnitFileState", "--value"], daemonUserServiceEnv());
      if (read.status !== 0) throw new CommandFailure("unknown", "OPERATION_UNKNOWN", `systemctl --user show ${plan.unit} did not confirm UnitFileState after disable (${read.detail}); the service was not stopped`);
      const state = read.stdout.trim();
      if (state !== "disabled" && state !== "static") throw new CommandFailure("unknown", "OPERATION_UNKNOWN", `the recorded service ${plan.unit} did not confirm automatic start off (${state || "empty"}); it was not stopped`);
      try { submitSystemdUnitControl("stop", plan.unit); }
      catch (error) { throw new CommandFailure("unknown", "OPERATION_UNKNOWN", `automatic start is already off for ${plan.unit}, and the service did not stop. Start it again with \`cotal daemon start\` to turn automatic start back on.`, { cause: error }); }
    }
    markPersonStop(paths);
    return { ...plan, agents };
  } finally { lock?.release(); }
}
