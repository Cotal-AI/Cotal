import { dirname } from "node:path";
import { claimGlobalNpmUpdateLock, claimUpdateClosureAccess, CommandFailure, deferredUpdateActivation, recordUpdateActivation, type UpdateAdmission } from "@cotal-ai/workspace";
import { observeExecutionVersion } from "../cotal.js";
import { managerViaDaemon, queryDaemon } from "./client.js";
import { daemonPaths } from "./endpoint.js";
import { readExecutionPreinstall } from "./execution-preinstall.js";
import { daemonServeArgv, restartInstalled } from "./install.js";
import { waitForInstalledDaemonGeneration } from "./update-generation.js";
import { assertUpdateDaemon } from "./update-lifetime.js";

export const declinedAgentStop = "running agents were not stopped; save their work and run `cotal update --self --stop-agents` to activate";

type ConsentStop = Extract<UpdateAdmission, { disposition: "consent-stop" }>;

/** Retry a daemon activation that a completed update left pending, without reinstalling packages. */
export async function activateDeferredUpdate(entry: string, version: string, flags: Record<string, unknown>, stopAgents: (plan: ConsentStop) => Promise<void>): Promise<boolean> {
  const installation = dirname(dirname(entry));
  const refusal = (reason: string) => new CommandFailure("refused", "LIFECYCLE_BLOCKED", `machine daemon activation is still pending: ${reason}`, {
    remedy: "run `cotal daemon status` and resolve the reported problem, then retry `cotal update --self`",
  });
  const waiting = () => console.log(`machine daemon activation is still waiting: ${declinedAgentStop}`);
  try {
    if (!deferredUpdateActivation(entry, version)) return false;
    const releaseGlobal = claimGlobalNpmUpdateLock(dirname(installation), { waitMs: 10 * 60_000, renew: true });
    try {
      const release = claimUpdateClosureAccess();
      let paths: ReturnType<typeof daemonPaths> | undefined;
      let attempted = false;
      try {
        if (observeExecutionVersion(installation) !== version) throw refusal("the installed release changed during the update");
        if (!deferredUpdateActivation(entry, version)) return true;
        paths = daemonPaths();
        const status = await queryDaemon({ paths });
        if (!status.ok) throw refusal(status.error.message);
        if (status.result.version === version) {
          recordUpdateActivation(entry, version);
          return true;
        }
        const { admission, daemon } = await readExecutionPreinstall({ v: 1, nonce: "", installedEntry: entry, daemonArgv: daemonServeArgv(undefined), flags });
        if (admission.disposition === "deferred") throw refusal(admission.reason);
        if (!daemon || daemon.pid !== status.result.pid) throw refusal("the running daemon changed before activation");
        if (admission.disposition === "consent-stop" && flags["stop-agents"] !== true) {
          waiting();
          return true;
        }
        assertUpdateDaemon(daemon, paths);
        if (admission.disposition === "consent-stop") await stopAgents(admission);
        assertUpdateDaemon(daemon, paths);
        try {
          attempted = true;
          await managerViaDaemon({ paths }, { op: "managers-prepare-restart" });
        } catch (error) {
          if (flags["stop-agents"] !== true && error instanceof CommandFailure && error.native?.code === "SEATS_ACTIVE") {
            await managerViaDaemon({ paths }, { op: "managers-abort-restart" }).catch(() => {});
            waiting();
            return true;
          }
          throw error;
        }
        assertUpdateDaemon(daemon, paths);
        await restartInstalled(paths, undefined, false, version);
      } catch (error) {
        if (attempted && paths) await managerViaDaemon({ paths }, { op: "managers-abort-restart" }).catch(() => {});
        throw error;
      } finally { release(); }
      // A new hosted Manager can need the closure barrier to finish startup.
      await waitForInstalledDaemonGeneration(version, { installed: () => true, quiet: true });
      const releaseAfterRestart = claimUpdateClosureAccess();
      try {
        if (observeExecutionVersion(installation) !== version) throw refusal("the installed release changed during activation");
        recordUpdateActivation(entry, version);
      } finally { releaseAfterRestart(); }
      console.log(`machine daemon: activated installed Cotal ${version}`);
      return true;
    } finally { releaseGlobal(); }
  } catch (error) {
    if (error instanceof CommandFailure) throw error;
    throw refusal(error instanceof Error ? error.message : String(error));
  }
}
