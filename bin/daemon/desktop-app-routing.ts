import { randomUUID } from "node:crypto";
import type { Socket } from "node:net";
import { CommandFailure } from "@cotal-ai/workspace";
import { agentApps, agentAppRequest, type AgentAppRequest, type AgentAppResult, type AppManagement } from "./desktop-agent-apps.js";
import { openVerified, type QueryOptions } from "./client.js";
import { DAEMON_PROTOCOL_VERSION, EndpointRefusal, ensureStateDir, MAX_LINE_BYTES } from "./endpoint.js";
import { installedDaemonIdentity, installedDaemonIsStopped, nativeDaemonIsAbsent, preflightInstalledDaemon } from "./install.js";
import { excludeLifetime } from "./lifetime.js";
import { encode, type DaemonResponse } from "./protocol.js";
import { withAppMutation } from "./agent-app-admission.js";

type Target = Pick<QueryOptions, "paths" | "peerUid" | "peerPid"> & { readonly home?: string; readonly version: string };
type Route = { management: "service"; socket: Socket } | { management: "local"; release(): void } | { management: "other-copy" | "checking" };

/** A lost socket alone is never permission to run the operation in this process. */
async function route(target: Target): Promise<Route> {
  const { paths, home } = target;
  let installed: boolean;
  try {
    installed = preflightInstalledDaemon(paths, home);
    if (installed && !installedDaemonIdentity(paths, home).same) return { management: "other-copy" };
  } catch { return { management: "checking" }; }
  try {
    const socket = await openVerified({ ...target, timeoutMs: 3000 });
    if (installed) return { management: "service", socket };
    socket.destroy();
    return { management: "checking" };
  } catch (error) {
    if (!(error instanceof EndpointRefusal) || error.code !== "NOT_RUNNING") return { management: "checking" };
  }
  try {
    ensureStateDir(paths);
    const held = excludeLifetime(paths.lock);
    try {
      // An existing unrecorded job or unverifiable native observation cannot enable mutations.
      if (!preflightInstalledDaemon(paths, home)) {
        if (!nativeDaemonIsAbsent(paths, home)) { held.release(); return { management: "checking" }; }
      } else if (!installedDaemonIdentity(paths, home).same) {
        held.release(); return { management: "other-copy" };
      } else if (!installedDaemonIsStopped(paths, home)) {
        held.release(); return { management: "checking" };
      }
      return { management: "local", release: held.release };
    } catch (error) { held.release(); throw error; }
  } catch { return { management: "checking" }; }
}

function exchange(socket: Socket, req: AgentAppRequest, appVersion: string, progress: (line: string) => void): Promise<AgentAppResult> {
  return new Promise((resolve, reject) => {
    const id = randomUUID();
    const finish = (error?: Error, result?: AgentAppResult) => {
      clearTimeout(timeout);
      socket.destroy();
      if (error) reject(error); else resolve(result!);
    };
    const lost = () => finish(new CommandFailure("unknown", "OPERATION_UNKNOWN", "The background service did not confirm the result. Check the app’s status before trying again."));
    const timeout = setTimeout(lost, req.op === "agent-apps" ? 90_000 : 1050_000);
    let pending = "";
    socket.setEncoding("utf8").on("data", (chunk: string) => {
      pending += chunk;
      for (let eol = pending.indexOf("\n"); eol >= 0; eol = pending.indexOf("\n")) {
        const line = pending.slice(0, eol);
        pending = pending.slice(eol + 1);
        if (Buffer.byteLength(line) + 1 > MAX_LINE_BYTES) return lost();
        let frame: DaemonResponse;
        try { frame = JSON.parse(line) as DaemonResponse; } catch { return lost(); }
        if (!frame || frame.v !== DAEMON_PROTOCOL_VERSION || frame.id !== id) return lost();
        if (frame.ok === false) {
          if (!frame.error || typeof frame.error.code !== "string") return lost();
          return finish(frame.error.code === "LIFECYCLE_BLOCKED" || frame.error.code === "UNKNOWN_OP" || frame.error.code === "CONFLICT"
            ? new CommandFailure("refused", "LIFECYCLE_BLOCKED", "The background service could not be confirmed. Nothing was changed.", { native: { code: "APP_OWNER_CHECKING" } })
            : new CommandFailure("failed", "OPERATION_FAILED", "The agent app operation could not finish."));
        }
        if (frame.ok !== true) return lost();
        if ("event" in frame) {
          if (frame.event !== "agent-app-progress" || typeof frame.line !== "string") return lost();
          progress(frame.line);
        } else if (frame.result && typeof frame.result === "object" && (req.op === "agent-apps" ? "apps" in frame.result : "app" in frame.result)) return finish(undefined, frame.result as AgentAppResult);
        else return lost();
      }
      if (Buffer.byteLength(pending) >= MAX_LINE_BYTES) lost();
    });
    socket.once("error", lost);
    socket.once("end", lost);
    socket.once("close", lost);
    socket.write(encode({ v: DAEMON_PROTOCOL_VERSION, id, appVersion, ...req }));
  });
}

export async function desktopAppRequest(target: Target, req: AgentAppRequest, progress: (line: string) => void): Promise<AgentAppResult> {
  // Mutations on the service acquire admission inside the service, not on both sides of the IPC.
  const selected = await route(target);
  if (selected.management === "service") {
    if (req.op !== "agent-apps") return exchange(selected.socket, req, target.version, progress);
    try { return await exchange(selected.socket, req, target.version, progress); }
    catch { return { apps: await agentApps(), management: "checking" }; }
  }
  const management: AppManagement = selected.management;
  if (req.op === "agent-apps") {
    if (selected.management === "local") selected.release();
    return { apps: await agentApps(), management };
  }
  if (selected.management !== "local") {
    throw new CommandFailure("refused", "LIFECYCLE_BLOCKED", "The background service could not be confirmed. Nothing was changed.", { native: { code: management === "other-copy" ? "APP_OTHER_COPY" : "APP_OWNER_CHECKING" } });
  }
  // The lifetime proof is held until the operation settles, so a new service cannot start and run
  // the same operation even if it was launched outside the Desktop setup flow.
  try { return await withAppMutation(target.paths, () => agentAppRequest(req, "local", progress)); }
  finally { selected.release(); }
}
