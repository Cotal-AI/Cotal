/** Stopping one recorded local process: the stop `cotal down` runs for every component, and the
 *  one every manager and delivery teardown shares through `stopManager` and `stopDelivery`. */
import { closeSync, existsSync, linkSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import {
  identityLegacyWarning, identityRefusal, identityUncertaintyRefusal, localProcessPath, parsePid, probeLiveness,
  readPidfile, readProcessCommand, removePidPair, stopReservationPath, verifyIdentityPin,
  type LocalProcess, type LocalProcessContext,
} from "@cotal-ai/workspace";
import { c } from "../ui.js";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export function processRecorded(component: LocalProcess, context: LocalProcessContext): boolean {
  return existsSync(localProcessPath(component.pidFile, context)) || (component.artifacts ?? []).map((artifact) => localProcessPath(artifact, context)).some(existsSync);
}

export interface StopLocalProcessOptions {
  /** Runs while this caller holds the `.stopping` reservation, after exact target verification and
   * immediately before SIGTERM. Throwing aborts without signalling and preserves the pid record. */
  beforeSignal?: (attempt: {
    target: { pid: number; token: string } | { pid: number; token?: undefined };
    stopper: { pid: number; marker: string };
  }) => void;
  /** Runs, still under the reservation, when a stop that entered `beforeSignal` ends without a
   * confirmed stop. It undoes what `beforeSignal` published: done after the reservation is released,
   * the undo could remove what the next stop to take the reservation published. */
  afterFailedSignal?: () => void;
  /** Whether a live process's command line is this component's. Consulted only for a record with no
   *  identity pin, where the command line is the only evidence of what the pid now runs. */
  owns?: (command: string) => boolean;
}

/** Take a stop reservation at `marker` for this process, refusing while another live stop holds it.
 *  The caller removes `marker` when its stop is over. */
function reserveStop(name: string, marker: string): void {
  let markerFd: number | undefined;
  for (;;) {
    // ATOMIC publish (the pid-slot pattern): fill a private temp inode with our pid FIRST, then
    // `link(2)` it as the marker - a no-overwrite atomic op. A contender therefore never observes an
    // empty marker mid-publish; the old `openSync(marker,"wx")` then `writeFileSync` left exactly
    // that window, and a reader in it saw owner=undefined and reclaimed a LIVE owner's reservation
    // (mutual exclusion defeated). The published name and the held fd both keep the inode alive.
    const temp = `${marker}.${process.pid}.${randomBytes(4).toString("hex")}`;
    try {
      markerFd = openSync(temp, "wx", 0o600);
      writeFileSync(markerFd, String(process.pid));
      linkSync(temp, marker); // EEXIST here = the marker is already held
      rmSync(temp, { force: true });
      break;
    } catch (e) {
      if (markerFd !== undefined) {
        closeSync(markerFd);
        markerFd = undefined;
      }
      try { rmSync(temp, { force: true }); } catch { /* never created, or already gone */ }
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
      let owner: number | undefined;
      try {
        owner = parsePid(readFileSync(marker, "utf8"));
      } catch (readErr) {
        if ((readErr as NodeJS.ErrnoException).code === "ENOENT") continue; // holder released between publish-refusal and read
        throw readErr;
      }
      // The atomic publish above is what closes the race: a LIVE `down` holding the marker always
      // wrote its own POSITIVE pid into it (no empty/partial window), so a live holder is always a
      // valid pid that is alive/EPERM/unknown - and THOSE we never reclaim (that is the mutual
      // exclusion). An UNATTRIBUTABLE marker (empty / 0 / negative / garbled) therefore cannot
      // represent a live holder; it is a stale or crashed reservation, and reclaiming it is both safe
      // and required so a crashed `down` never wedges the next one. So: reclaim an unattributable
      // owner or a valid pid PROVEN dead (ESRCH); refuse only a valid pid that is alive or whose
      // liveness we cannot confirm.
      if (owner !== undefined && probeLiveness(owner) !== "dead")
        throw new Error(`${name} is already being stopped by another process (pid ${owner})`);
      rmSync(marker, { force: true });
    }
  }
  closeSync(markerFd);
}

/** Stop one recorded process and await its actual exit before the next dependency is stopped. */
export async function stopLocalProcess(
  component: LocalProcess,
  context: LocalProcessContext,
  options: StopLocalProcessOptions = {},
): Promise<boolean> {
  const pidPath = localProcessPath(component.pidFile, context);
  const found = processRecorded(component, context);
  const rawPid = readPidfile(pidPath);
  if (rawPid === undefined) return found;

  if (rawPid.startsWith("removing:")) {
    const owner = parsePid(rawPid.slice("removing:".length));
    throw new Error(
      owner && probeLiveness(owner) === "alive"
        ? `${component.name} extension removal is in progress (pid ${owner})`
        : `${component.name} has a stale extension-removal reservation at ${pidPath} - remove that file and retry`,
    );
  }
  const pid = parsePid(rawPid);
  const marker = stopReservationPath(pidPath);
  reserveStop(component.name, marker);

  let stopped = false;
  let authorized = false;
  try {
    if (pid === undefined) {
      // An EMPTY pidfile is a pre-protocol husk (no process behind it) and is safe to clear. Any
      // OTHER unattributable content (garbled, fractional, out-of-range - anything `parsePid`
      // rejects) may still front a LIVE process we cannot identify or signal; removing it would
      // orphan that process while reporting a clean stop (the signer-orphan this slice must not do).
      // Refuse loud and preserve it.
      if (rawPid === "") {
        console.log(c.dim(`${component.label} had an empty pidfile.`));
        stopped = true; // husk cleared in `finally`
        return true;
      }
      throw new Error(
        `${component.label} has an unattributable pidfile at ${pidPath} (${JSON.stringify(rawPid)}) - it may still front a running process; refusing to remove it or report a clean stop. Stop that process and remove the file manually.`,
      );
    }
    // Attribution before the pin (#1528): it also catches a reused pid behind a legacy record, which
    // the pin would let through to the signal. A command that cannot be read proves nothing.
    if (component.isOwnCommand) {
      const command = readProcessCommand(pid);
      if (command.kind === "command" && !component.isOwnCommand(command.command)) {
        console.error(`! recorded ${component.label} pid ${pid} is alive but is running \`${command.command}\`, which is not a ${component.label} - not signalling it; removing the stale record instead.`);
        stopped = true;
        return true;
      }
    }
    // #969 OPEN-VERIFY-TERMINATE: identity before signal, the same rule the auth helper applies. This
    // is the path every manager and delivery stop takes, and the one `cotal down` uses for the BROKER,
    // the web dashboard and every extension component, so all of them share one identity rule.
    const identity = verifyIdentityPin(pidPath);
    if (identity.kind === "mismatch") throw identityRefusal(component.label, pidPath, identity.record, identity.liveToken);
    if (identity.kind === "legacy" && options.owns) {
      // A readable command that is not this component's means the record outlived its process and
      // the pid was reused. Signalling it would kill an unrelated process; the stale record goes.
      const cmd = readProcessCommand(pid);
      if (cmd.kind === "command" && !options.owns(cmd.command)) {
        console.error(`! ${component.label} pid ${pid} is alive but is running \`${cmd.command}\`, which is not the ${component.label} - not signalling it; removing the stale record instead.`);
        stopped = true;
        return true;
      }
    }
    if (identity.kind === "legacy") console.error(identityLegacyWarning(component.label, pidPath));
    else if (identity.kind !== "match" && identity.kind !== "gone") throw identityUncertaintyRefusal(component.label, pidPath, identity);
    // The beforeSignal hook authorizes an action against a LIVE exact process. A pinned record whose
    // process is already ESRCH-gone needs no spare capability or destructive intent because no signal
    // will be sent. Clear that stale record directly, preserving the hook's documented placement
    // immediately before SIGTERM and avoiding a false "identity is not pinned" refusal on cleanup.
    if (identity.kind === "gone") {
      console.log(c.dim(`${component.label} (pid ${pid}) was not running.`));
      stopped = true;
      return true;
    }
    authorized = true;
    options.beforeSignal?.({
      target: identity.kind === "match" ? identity.record : { pid },
      stopper: { pid: process.pid, marker },
    });
    try {
      process.kill(pid, "SIGTERM");
    } catch (e) {
      // ONLY an ESRCH proves the process is already gone (safe to clear). EPERM (exists, another
      // user's) or any other errno (EIO, argument errors, unknown) means we could NOT confirm death
      // - reporting it stopped and removing its record would orphan a live process. Fail loud, keep
      // the record. A two-state "not alive => gone" is exactly the bug: `unknown` is not `dead`.
      if ((e as NodeJS.ErrnoException).code === "ESRCH") {
        console.log(c.dim(`${component.label} (pid ${pid}) was not running.`));
        stopped = true;
        return true;
      }
      throw new Error(`could not signal ${component.label} (pid ${pid}) (${(e as NodeJS.ErrnoException).code ?? "unknown error"}) - refusing to report it stopped or remove its record; stop it manually`);
    }
    // Wait for CONFIRMED death (ESRCH), escalating to SIGKILL; `unknown`/`alive` both keep us
    // waiting, and if death is never confirmed the record is preserved (never deleted on a guess).
    const graceDeadline = Date.now() + 15_000;
    while (probeLiveness(pid) !== "dead" && Date.now() < graceDeadline) await sleep(100);
    if (probeLiveness(pid) !== "dead") {
      try { process.kill(pid, "SIGKILL"); } catch { /* raced to exit */ }
      const hardDeadline = Date.now() + 3_000;
      while (probeLiveness(pid) !== "dead" && Date.now() < hardDeadline) await sleep(100);
    }
    if (probeLiveness(pid) !== "dead")
      throw new Error(`${component.label} (pid ${pid}) did not exit, or its death could not be confirmed; its pidfile was preserved`);
    stopped = true;
    console.log(c.green(`✓ stopped ${component.label} (pid ${pid})`));
    return true;
  } finally {
    // Remove the pidfile ONLY when we confirmed a clean stop: `stopped` is set exclusively on an
    // ESRCH-proven death (already-gone, or a confirmed exit). Every other exit from the try above is
    // a throw that must PRESERVE the record - an unattributable pidfile, a process we could not
    // signal, or a death we could not confirm (`unknown`). The old `|| !isAlive(pid)` clause treated
    // `unknown` as gone and deleted a live process's record; it is gone.
    // The pin goes with the pidfile (#969), and only while the pidfile still names the stopped pid: a
    // publish that committed a successor meanwhile is left whole (#1238).
    if (stopped) removePidPair(pidPath, rawPid);
    else if (authorized) options.afterFailedSignal?.();
    rmSync(marker, { force: true });
  }
}
