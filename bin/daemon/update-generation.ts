/** A replacement updater observes activation. The daemon remains the sole automatic restart owner. */
import { existsSync } from "node:fs";
import { CommandFailure, homeCotalDir } from "@cotal-ai/workspace";
import { queryDaemon } from "./client.js";
import { daemonPaths, EndpointRefusal } from "./endpoint.js";
import { installedDaemonIdentity, unitReceiptFile } from "./install.js";
import { daemonManagerIntentFile } from "./manager.js";

export async function waitForInstalledDaemonGeneration(version: string): Promise<void> {
  let paths;
  try { paths = daemonPaths(); }
  catch (error) {
    if (error instanceof EndpointRefusal && error.code === "NO_RUNTIME_DIR") return;
    throw error;
  }
  // Foreground daemons and another installation keep their existing update behavior.
  if (!existsSync(unitReceiptFile(paths)) || !installedDaemonIdentity(paths).same) return;
  console.log(`machine daemon: waiting up to 120s for Cotal ${version} and its hosted Managers before the continuity check`);
  const deadline = Date.now() + 120_000;
  let waiting = "the recorded daemon has not answered";
  for (;;) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new CommandFailure("refused", "LIFECYCLE_BLOCKED", `installed Cotal ${version} did not become ready within 120s: ${waiting}; connector reconciliation was not started by this update. Read cotal daemon status and the recorded daemon user service, restore the daemon and its hosted Managers, then run cotal update again`, {
      remedy: "read cotal daemon status and the recorded daemon user service, restore the daemon and its hosted Managers, then run cotal update again",
    });
    try {
      const reply = await queryDaemon({ paths, timeoutMs: Math.min(20_000, Math.max(1, remaining)) });
      if (!reply.ok) throw new Error(`machine daemon custody is unreadable: ${reply.error.code} ${reply.error.message}`);
      if (reply.result.version !== version) {
        waiting = `daemon PID ${reply.result.pid} still runs Cotal ${reply.result.version}${reply.result.generation ? ` (${reply.result.generation.waiting})` : ""}`;
      } else {
        const pending = (reply.result.managers ?? []).filter(manager =>
          (manager.pid !== undefined || existsSync(daemonManagerIntentFile(manager.space, homeCotalDir()))) && manager.state !== "answering");
        if (!pending.length) return;
        waiting = pending.map(manager => `hosted Manager ${manager.space}: ${manager.state}${manager.reason ? ` (${manager.reason})` : ""}`).join("; ");
      }
    } catch (error) {
      // Authentication and ownership failures are refusals, not evidence of a restarting service.
      if (error instanceof EndpointRefusal) {
        if (error.code !== "NOT_RUNNING" && error.code !== "PEER_NOT_LOCK_OWNER") throw error;
      } else {
        const transient = error instanceof Error && ([
          "daemon closed the connection without a reply", "timed out waiting for the daemon's reply",
        ].includes(error.message) || ["ECONNRESET", "EPIPE"].includes((error as NodeJS.ErrnoException).code ?? "") || error.message.startsWith("timed out connecting to "));
        if (!transient) throw error;
      }
      // Retain the last generation/Manager observation so an endpoint gap does not erase it.
    }
    await new Promise(resolve => setTimeout(resolve, Math.min(250, Math.max(0, deadline - Date.now()))));
  }
}
