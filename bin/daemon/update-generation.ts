/** A replacement updater observes activation. The daemon remains the sole automatic restart owner. */
import { existsSync } from "node:fs";
import { CommandFailure, homeCotalDir } from "@cotal-ai/workspace";
import { queryDaemon } from "./client.js";
import { daemonPaths, EndpointRefusal, type DaemonPaths } from "./endpoint.js";
import { installedDaemonIdentity, unitReceiptFile } from "./install.js";
import { daemonManagerIntentFile } from "./manager.js";

/** Test hooks: the installed-service check, the daemon query and the wait bound. */
export interface GenerationWaitProbe {
  readonly installed?: () => boolean;
  readonly query?: typeof queryDaemon;
  readonly timeoutMs?: number;
  readonly lifecycle?: (paths: DaemonPaths, deadline: number) => Promise<{
    poll(remainingMs: number): Promise<void>;
    close(): void;
  }>;
}

export async function waitForInstalledDaemonGeneration(version: string, probe: GenerationWaitProbe = {}): Promise<void> {
  let paths;
  try { paths = daemonPaths(); }
  catch (error) {
    if (error instanceof EndpointRefusal && error.code === "NO_RUNTIME_DIR") return;
    throw error;
  }
  // Foreground daemons and another installation keep their existing update behavior.
  if (!(probe.installed ? probe.installed() : existsSync(unitReceiptFile(paths)) && installedDaemonIdentity(paths).same)) return;
  const query = probe.query ?? queryDaemon;
  const bound = probe.timeoutMs ?? 120_000;
  console.log(`machine daemon: waiting up to ${Math.round(bound / 1000)}s for Cotal ${version} and its hosted Managers before the continuity check`);
  const deadline = Date.now() + bound;
  let waiting = "the recorded daemon has not answered";
  const lifecycle = await probe.lifecycle?.(paths, deadline);
  try {
  for (;;) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new CommandFailure("refused", "LIFECYCLE_BLOCKED", `installed Cotal ${version} did not become ready within ${Math.round(bound / 1000)}s: ${waiting}; connector reconciliation was not started by this update. Read \`cotal daemon status\` and the recorded daemon user service, restore the daemon and its hosted Managers, then run \`cotal update\` again`, {
      remedy: "read \`cotal daemon status\` and the recorded daemon user service, restore the daemon and its hosted Managers, then run \`cotal update\` again",
    });
    await lifecycle?.poll(remaining);
    if (Date.now() >= deadline) continue;
    try {
      const reply = await query({ paths, timeoutMs: Math.min(20_000, Math.max(1, deadline - Date.now())) });
      // A daemon that cannot complete status while it stops or starts its hosted Managers is still
      // restarting. Its reason is kept for the deadline, and the wait goes on.
      if (!reply.ok) waiting = `the daemon could not answer status: ${reply.error.code} ${reply.error.message}`;
      else if (reply.result.version !== version) {
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
  } finally { lifecycle?.close(); }
}
