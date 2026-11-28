import { randomUUID } from "node:crypto";
import type { Socket } from "node:net";
import { CommandFailure, isCommandFailure } from "@cotal-ai/workspace";
import { agentApps, agentAppRequest, type AgentAppRequest, type AgentAppResult, type AppManagement, type ServiceAppResult } from "./desktop-agent-apps.js";
import { ClosedPeerRefusal, EmptyLifetimeRefusal, openVerified, type QueryOptions } from "./client.js";
import { DAEMON_PROTOCOL_VERSION, EndpointRefusal, ensureStateDir, MAX_LINE_BYTES } from "./endpoint.js";
import { installationOwner, installedDaemonIdentity, installedDaemonActivity, nativeDaemonPresence, preflightInstalledDaemon } from "./install.js";
import { excludeLifetime, processBirth, readLifetimeRecord } from "./lifetime.js";
import { encode, type DaemonResponse } from "./protocol.js";
import { withAppMutation } from "./agent-app-admission.js";
import { discoverDesktopApplicationPath, serviceApplicationPath } from "./desktop-path.js";

type Target = Pick<QueryOptions, "paths" | "peerUid" | "peerPid"> & { readonly home?: string; readonly version: string };
type BlockedManagement = Exclude<AppManagement, "service" | "local">;
type Generation = { readonly pid: number; readonly start: string; readonly receiptKey: string };
type ServiceRoute = { management: "service"; socket: Socket; generation: Generation };
type ServiceOwner = NonNullable<AgentAppResult["serviceOwner"]>;
type Route = ServiceRoute | { management: "local" | BlockedManagement; serviceOwner?: ServiceOwner };

const refusals = {
  "version-conflict": ["APP_VERSION_CONFLICT", "The app and the background service are different versions."],
  "older-service": ["APP_OLDER_SERVICE", "This background service is too old to manage agent apps here."],
  foreground: ["APP_FOREGROUND", "Cotal is running without an installed background service."],
  "unrecorded-service": ["APP_UNRECORDED_SERVICE", "This copy of Cotal can't verify the background service."],
  "no-user-services": ["APP_NO_USER_SERVICES", "Cotal can't reach this Linux session's user services."],
  "other-copy": ["APP_OTHER_COPY", "Another copy of Cotal owns the background service."],
  checking: ["APP_OWNER_CHECKING", "The background service is still changing. Nothing was changed."],
} as const satisfies Record<BlockedManagement, readonly [string, string]>;

class AppOwnerRefusal extends CommandFailure {
  constructor(readonly management: BlockedManagement, readonly serviceOwner?: ServiceOwner) {
    const [code, message] = refusals[management];
    super("refused", "LIFECYCLE_BLOCKED", message, { native: { code, ...(serviceOwner ? { detail: { owner: serviceOwner } } : {}) } });
  }
}

function nativeRefusal(error: unknown): BlockedManagement {
  return process.platform === "linux" && isCommandFailure(error) && error.code === "DEPENDENCY_UNAVAILABLE"
    ? "no-user-services" : "unrecorded-service";
}

/** A lost socket alone is never permission to run the operation in this process. */
async function route(target: Target): Promise<Route> {
  const { paths, home } = target;
  let receiptKey: string | undefined;
  try {
    if (preflightInstalledDaemon(paths, home)) {
      const identity = installedDaemonIdentity(paths, home);
      if (!identity.same) return { management: "other-copy", serviceOwner: installationOwner(identity.installedEntry) };
      receiptKey = identity.receiptKey;
    }
  } catch (error) { return { management: nativeRefusal(error) }; }
  try {
    const before = readLifetimeRecord(paths.lock);
    const socket = await openVerified({ ...target, timeoutMs: 3000 });
    if (receiptKey !== undefined) {
      const after = readLifetimeRecord(paths.lock);
      if (before?.start && before.pid === after?.pid && before.start === after.start)
        return { management: "service", socket, generation: { pid: before.pid, start: before.start, receiptKey } };
      socket.destroy();
      return { management: "checking" };
    }
    socket.destroy();
    return { management: "foreground" };
  } catch (error) {
    if (error instanceof ClosedPeerRefusal || error instanceof EmptyLifetimeRefusal
      || (error instanceof Error && "code" in error && error.code === "ETIMEDOUT")) return { management: "checking" };
    if (!(error instanceof EndpointRefusal) || error.code !== "NOT_RUNNING") return { management: "unrecorded-service" };
  }
  try {
    ensureStateDir(paths);
    const held = excludeLifetime(paths.lock);
    try {
      // An existing unrecorded job or unverifiable native observation cannot enable mutations.
      if (!preflightInstalledDaemon(paths, home)) {
        const presence = nativeDaemonPresence(paths, home);
        if (presence !== "absent") return { management: presence === "unavailable" ? "no-user-services" : "unrecorded-service" };
      } else {
        const identity = installedDaemonIdentity(paths, home);
        if (!identity.same) return { management: "other-copy", serviceOwner: installationOwner(identity.installedEntry) };
        const activity = installedDaemonActivity(paths, home);
        if (activity !== "stopped") return { management: activity === "transition" ? "checking"
          : activity === "unavailable" ? "no-user-services" : "unrecorded-service" };
      }
      return { management: "local" };
    } finally { held.release(); }
  } catch (error) {
    return { management: error instanceof EndpointRefusal && error.code === "LOCK_HELD" ? "checking" : nativeRefusal(error) };
  }
}

function replyFailure(code: string): CommandFailure {
  if (code === "CONFLICT") return new AppOwnerRefusal("version-conflict");
  if (["UNKNOWN_FIELD", "BAD_FIELD", "UNKNOWN_OP", "BAD_VERSION"].includes(code)) return new AppOwnerRefusal("older-service");
  if (code === "LIFECYCLE_BLOCKED") return new AppOwnerRefusal("unrecorded-service");
  return new CommandFailure("failed", "OPERATION_FAILED", "The agent app operation could not finish.");
}

function exchange(socket: Socket, req: AgentAppRequest, appVersion: string, progress: (line: string) => void): Promise<ServiceAppResult> {
  return new Promise((resolve, reject) => {
    const id = randomUUID();
    const finish = (error?: Error, result?: ServiceAppResult) => {
      clearTimeout(timeout);
      socket.destroy();
      if (error) reject(error); else resolve(result!);
    };
    const lost = () => finish(new CommandFailure("unknown", "OPERATION_UNKNOWN", "The background service did not confirm the result. Choose Check again before trying again."));
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
          return finish(replyFailure(frame.error.code));
        }
        if (frame.ok !== true) return lost();
        if ("event" in frame) {
          if (frame.event !== "agent-app-progress" || typeof frame.line !== "string") return lost();
          progress(frame.line);
        } else {
          const result = frame.result as ServiceAppResult;
          if (!result || typeof result !== "object") return lost();
          if (req.op !== "agent-apps") return "app" in result ? finish(undefined, result) : lost();
          if (!("apps" in result) || !Array.isArray(result.apps) || result.management !== "service") return lost();
          if (result.serviceAppPickup !== true) return finish(new AppOwnerRefusal("older-service"));
          if (result.serviceRefreshNeeded === true && (!Array.isArray(result.serviceAppDirs) || !result.serviceAppDirs.every(dir => typeof dir === "string"))) return lost();
          return finish(undefined, result);
        }
      }
      if (Buffer.byteLength(pending) >= MAX_LINE_BYTES) lost();
    });
    socket.once("error", lost);
    socket.once("end", lost);
    socket.once("close", lost);
    socket.write(encode({ v: DAEMON_PROTOCOL_VERSION, id, appVersion, ...req }));
  });
}

type Progress = (line: string) => void;

function publicResult(result: ServiceAppResult): AgentAppResult {
  if ("apps" in result) return { apps: result.apps, management: result.management };
  return { app: result.app, ...(result.pathAdded ? { pathAdded: result.pathAdded } : {}) };
}

function assertGeneration(target: Target, generation: Generation): void {
  const identity = installedDaemonIdentity(target.paths, target.home);
  if (!identity.same) throw new AppOwnerRefusal("other-copy", installationOwner(identity.installedEntry));
  if (identity.receiptKey !== generation.receiptKey) throw new AppOwnerRefusal("unrecorded-service");
  const owner = readLifetimeRecord(target.paths.lock);
  if (owner?.pid !== generation.pid || owner.start !== generation.start || processBirth(owner.pid) !== owner.start)
    throw new AppOwnerRefusal("checking");
}

async function serviceInventory(target: Target, refresh: boolean, expected?: Generation): Promise<{ result: ServiceAppResult; generation: Generation }> {
  const current = await route(target);
  if (current.management !== "service") throw new AppOwnerRefusal(current.management === "local" ? "checking" : current.management, current.serviceOwner);
  try {
    if (expected && (current.generation.pid !== expected.pid || current.generation.start !== expected.start || current.generation.receiptKey !== expected.receiptKey))
      throw new AppOwnerRefusal("checking");
    const result = await exchange(current.socket, { op: "agent-apps", ...(refresh ? { refresh: true } : {}) }, target.version, () => {});
    assertGeneration(target, current.generation);
    return { result, generation: current.generation };
  } finally { current.socket.destroy(); }
}

async function pickup(target: Target, inventory: Awaited<ReturnType<typeof serviceInventory>>, report: Progress): Promise<AgentAppResult["serviceRefresh"]> {
  const { result, generation } = inventory;
  if (result.serviceRefreshNeeded !== true) return undefined;
  try {
    const { path } = await discoverDesktopApplicationPath();
    const { refreshServiceForApplication } = await import("./setup.js");
    report("Refreshing the background service to pick up agent apps.");
    const refreshed = await refreshServiceForApplication({ ...target, daemonHome: target.home, report: () => {} }, result.serviceAppDirs ?? [], {
      path: process.platform === "win32" ? path : serviceApplicationPath(path),
      assertOwner: () => assertGeneration(target, generation),
    });
    if (refreshed && (await serviceInventory(target, true)).result.serviceRefreshNeeded !== true) return { state: "refreshed" };
  } catch (error) {
    if (isCommandFailure(error) && error.native?.code === "SEATS_ACTIVE") return { state: "pending", reason: "agents-running" };
    if (error instanceof AppOwnerRefusal && error.serviceOwner) throw error;
  }
  return { state: "pending", reason: "unconfirmed" };
}

async function listApps(target: Target, req: Extract<AgentAppRequest, { op: "agent-apps" }>, progress: Progress): Promise<AgentAppResult> {
  const current = await route(target);
  if (current.management !== "service") return { apps: await agentApps(), management: current.management, ...(current.serviceOwner ? { serviceOwner: current.serviceOwner } : {}) };
  const result = await exchange(current.socket, req, target.version, progress);
  if (!req.refresh) return publicResult(result);
  if (result.serviceRefreshNeeded !== true) return { ...publicResult(result), serviceRefresh: { state: "refreshed" } };
  // Acquire admission only if a verified daemon actually reports a pickup is needed.
  let serviceRefresh: AgentAppResult["serviceRefresh"];
  try {
    serviceRefresh = await withAppMutation(target.paths, async () =>
      (await pickup(target, await serviceInventory(target, true, current.generation), progress)) ?? { state: "refreshed" });
  } catch (error) {
    if (error instanceof AppOwnerRefusal && error.serviceOwner) throw error;
    serviceRefresh = { state: "pending", reason: "unconfirmed" };
  }
  return { ...publicResult(result), ...(serviceRefresh ? { serviceRefresh } : {}) };
}

async function installApp(target: Target, req: Extract<AgentAppRequest, { op: "agent-app-install" }>, progress: Progress): Promise<AgentAppResult> {
  // The installer runs in the bridge so admission survives the native service restart.
  return withAppMutation(target.paths, async () => {
    const selected = await route(target);
    if (selected.management === "service") {
      await exchange(selected.socket, { op: "agent-apps" }, target.version, () => {});
      assertGeneration(target, selected.generation);
    } else if (selected.management !== "local") throw new AppOwnerRefusal(selected.management, selected.serviceOwner);
    const result = publicResult(await agentAppRequest(req, selected.management, progress));
    try {
      const current = selected.management === "service" ? selected.generation : await startedService(target);
      if (!current) return result;
      const serviceRefresh = await pickup(target, await serviceInventory(target, true, current), progress);
      return { ...result, ...(serviceRefresh ? { serviceRefresh } : {}) };
    } catch (error) {
      return { ...result, serviceRefresh: { state: "pending", reason: "unconfirmed" },
        ...(error instanceof AppOwnerRefusal && error.serviceOwner ? { serviceOwner: error.serviceOwner } : {}) };
    }
  });
}

async function startedService(target: Target): Promise<Generation | undefined> {
  const current = await route(target);
  if (current.management === "other-copy") throw new AppOwnerRefusal(current.management, current.serviceOwner);
  if (current.management !== "service") return undefined;
  current.socket.destroy();
  return current.generation;
}

export async function desktopAppRequest(target: Target, req: AgentAppRequest, progress: Progress): Promise<AgentAppResult> {
  if (req.op === "agent-apps") {
    try { return await listApps(target, req, progress); }
    catch (error) {
      if (error instanceof AppOwnerRefusal) return { apps: await agentApps(), management: error.management, ...(error.serviceOwner ? { serviceOwner: error.serviceOwner } : {}) };
      throw error;
    }
  }
  if (req.op === "agent-app-install") return installApp(target, req, progress);
  const selected = await route(target);
  // Service sign-in acquires admission inside the service. Never replay it after a lost reply.
  if (selected.management === "service") {
    try {
      await serviceInventory(target, false, selected.generation);
      return publicResult(await exchange(selected.socket, req, target.version, progress));
    } finally { selected.socket.destroy(); }
  }
  if (selected.management !== "local") throw new AppOwnerRefusal(selected.management, selected.serviceOwner);
  return withAppMutation(target.paths, async () => {
    // Revalidate after admission. The app gate, not the lifetime lock, covers the maker process.
    const admitted = await route(target);
    if (admitted.management === "service") {
      admitted.socket.destroy();
      throw new AppOwnerRefusal("checking");
    }
    if (admitted.management !== "local") throw new AppOwnerRefusal(admitted.management, admitted.serviceOwner);
    return publicResult(await agentAppRequest(req, "local", progress));
  });
}
