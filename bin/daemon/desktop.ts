/** The desktop shell's bounded stdio adapter. It holds no login session or broker credentials. */
import { closeSync, constants, fstatSync, openSync, readSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { defaultComputerName } from "./computer-name.js";
import { computerName } from "./name-validation.js";
import { arch, platform, release, totalmem } from "node:os";
import type { Readable, Writable } from "node:stream";
import { CommandFailure, readLocalRecordSource, readUpdateSettings, setUpdateSetting } from "@cotal-ai/workspace";
import { normalizeIdpUrl } from "@cotal-ai/auth";
import { daemonConnectionLost, loginViaDaemon, updateViaDaemon, openVerified, queryDaemon, readLine, type QueryOptions } from "./client.js";
import { DAEMON_PROTOCOL_VERSION, MAX_LINE_BYTES, EndpointRefusal, daemonUserServiceEnv } from "./endpoint.js";
import { applyInstall, applyUninstall, installedDaemonIdentity, planUninstall, preflightInstalledDaemon, startInstalled, stopInstalled } from "./install.js";
import { nativeRun } from "./install-native-run.js";
import { launchAgentService } from "./install-darwin.js";
import { scheduledTaskService } from "./install-win32.js";
import { readReceipt } from "./install-receipt.js";
import { nativeDaemonLog, previousNativeDaemonLog } from "./native-log.js";
import { encode, isAgentLifecycleUid, isDaemonSpaceName, type AgentRowRequest, type DaemonResponse } from "./protocol.js";
import { runSetup } from "./setup.js";
import { discoverDesktopApplicationPath } from "./desktop-path.js";
import { assertDesktopSetupComplete } from "./desktop-setup.js";
import { agentAppRequest, type AgentAppRequest } from "./desktop-agent-apps.js";

export type DesktopRequest =
  | AgentRowRequest
  | { readonly op: "update-policy"; readonly auto?: boolean }
  | { readonly op: "update-settings"; readonly auto?: boolean; readonly notify?: boolean }
  | { readonly op: "update-check" }
  | { readonly op: "update-release"; readonly version: string }
  | { [K in "about" | "status" | "status-watch" | "install" | "log" | "remove-service" | "start"]: { readonly op: K } }["about" | "status" | "status-watch" | "install" | "log" | "remove-service" | "start"]
  | { readonly op: "stop"; readonly confirm?: boolean; readonly agents?: readonly string[] }
  | { readonly op: "space-recover"; readonly space: string; readonly candidate: string; readonly holder: string }
  | { readonly op: "space-intent"; readonly space: string; readonly enabled: boolean }
  | { readonly op: "name"; readonly name?: string }
  | { readonly op: "spaces"; readonly refresh?: boolean }
  | { readonly op: "login"; readonly idp: string }
  | { readonly op: "logout"; readonly idp: string }
  | { readonly op: "setup"; readonly space: string; readonly idp: string }
  | { readonly op: "connect-check" | "register" | "service-connect" | "service-disconnect" | "service-status"; readonly space: string }
  | AgentAppRequest;

/** No renderer-supplied command, path, credentials or arbitrary arguments cross this boundary. */
export function parseDesktopRequest(value: unknown): DesktopRequest {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("request must be an object");
  const o = value as Record<string, unknown>;
  if (o.op === "agent-stop" || o.op === "agent-terminal") {
    if (Object.keys(o).some(key => !["op", "space", "lifecycleUid"].includes(key)) || !isDaemonSpaceName(o.space) || !isAgentLifecycleUid(o.lifecycleUid)) throw new Error("invalid local agent selection");
    return { op: o.op, space: o.space, lifecycleUid: o.lifecycleUid };
  }
  const simple = ["about", "status", "status-watch", "install", "log", "remove-service", "update-check", "start"].includes(String(o.op));
  const scoped = ["connect-check", "register", "service-connect", "service-disconnect", "service-status"].includes(String(o.op));
  const fields = o.op === "stop" ? ["op", "confirm", "agents"] : o.op === "update-policy" ? ["op", "auto"] : o.op === "update-release" ? ["op", "version"] : o.op === "update-settings" ? ["op", "auto", "notify"] : o.op === "name" ? ["op", "name"] : o.op === "space-recover" ? ["op", "space", "candidate", "holder"] : o.op === "space-intent" ? ["op", "space", "enabled"] : simple ? ["op"] : scoped ? ["op", "space"] : o.op === "setup" ? ["op", "space", "idp"] : (o.op === "login" || o.op === "logout") ? ["op", "idp"] : o.op === "spaces" || o.op === "agent-apps" ? ["op", "refresh"] : o.op === "agent-app-install" || o.op === "agent-app-sign-in" ? ["op", "name"] : [];
  if (!fields.length || Object.keys(o).some((key) => !fields.includes(key))) throw new Error("unknown operation or field");
  if (o.op === "update-policy") {
    if (o.auto !== undefined && typeof o.auto !== "boolean") throw new Error("invalid update preference");
    return { op: "update-policy", ...(o.auto !== undefined ? { auto: o.auto } : {}) };
  }
  if (o.op === "update-release") {
    if (typeof o.version !== "string" || !/^\d+\.\d+\.\d+$/.test(o.version)) throw new Error("invalid release version");
    return { op: "update-release", version: o.version };
  }
  if (o.op === "update-settings") {
    if ([o.auto, o.notify].some(value => value !== undefined && typeof value !== "boolean")) throw new Error("invalid update setting");
    return { op: "update-settings", ...(o.auto !== undefined ? { auto: o.auto as boolean } : {}), ...(o.notify !== undefined ? { notify: o.notify as boolean } : {}) };
  }
  if (o.op === "space-recover") {
    if (!isDaemonSpaceName(o.space) || typeof o.candidate !== "string" || !/^[0-9a-f]{64}$/.test(o.candidate) || typeof o.holder !== "string" || o.holder.length > 2048) throw new Error("invalid custody recovery");
    return { op: "space-recover", space: o.space, candidate: o.candidate, holder: normalizeIdpUrl(o.holder) };
  }
  if (o.op === "space-intent") {
    if (!isDaemonSpaceName(o.space) || typeof o.enabled !== "boolean") throw new Error("invalid space intent");
    return { op: "space-intent", space: o.space, enabled: o.enabled };
  }
  if (o.op === "name") return { op: "name", ...(o.name !== undefined ? { name: computerName(o.name) } : {}) };
  if (o.op === "agent-apps") {
    if (o.refresh !== undefined && typeof o.refresh !== "boolean") throw new Error("invalid refresh");
    return { op: "agent-apps", ...(o.refresh ? { refresh: true } : {}) };
  }
  if (o.op === "agent-app-install" || o.op === "agent-app-sign-in") {
    if (typeof o.name !== "string" || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(o.name)) throw new Error("invalid application name");
    return { op: o.op, name: o.name };
  }
  if (o.op === "stop") {
    if (o.confirm !== undefined && o.confirm !== true) throw new Error("invalid stop confirmation");
    if (o.agents !== undefined && (!Array.isArray(o.agents) || o.agents.some((name) => typeof name !== "string" || name.length === 0 || name.length > 256))) throw new Error("invalid stop agent list");
    return { op: "stop", ...(o.confirm === true ? { confirm: true } : {}), ...(o.agents !== undefined ? { agents: o.agents as string[] } : {}) };
  }
  if (simple) return { op: o.op as "about" | "status" | "status-watch" | "install" | "log" | "remove-service" | "update-check" | "start" };
  if (scoped) {
    if (!isDaemonSpaceName(o.space)) throw new Error("invalid space");
    return { op: o.op as "connect-check" | "register" | "service-connect" | "service-disconnect" | "service-status", space: o.space };
  }
  if (o.op === "spaces") {
    if (o.refresh !== undefined && typeof o.refresh !== "boolean") throw new Error("invalid refresh");
    return { op: "spaces", ...(o.refresh !== undefined ? { refresh: o.refresh } : {}) };
  }
  if (typeof o.idp !== "string" || o.idp.length > 2048) throw new Error("invalid provider");
  if (o.op === "setup") {
    if (!isDaemonSpaceName(o.space)) throw new Error("invalid space");
    return { op: "setup", space: o.space, idp: normalizeIdpUrl(o.idp) };
  }
  return { op: o.op as "login" | "logout", idp: normalizeIdpUrl(o.idp) };
}

export async function readDesktopRequest(input: Readable): Promise<DesktopRequest> {
  let bytes = Buffer.alloc(0);
  const timer = setTimeout(() => input.destroy(new Error("request timed out")), 10_000);
  try {
    for await (const chunk of input) {
      bytes = Buffer.concat([bytes, Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)]);
      if (bytes.length > MAX_LINE_BYTES) throw new Error("request too large");
      const newline = bytes.indexOf(10);
      if (newline < 0) continue;
      if (bytes.subarray(newline + 1).toString().trim()) throw new Error("only one request is accepted");
      return parseDesktopRequest(JSON.parse(bytes.subarray(0, newline).toString("utf8")));
    }
    throw new Error("incomplete request");
  } finally { clearTimeout(timer); }
}

interface DesktopBridgeOptions extends Pick<QueryOptions, "peerUid" | "peerPid"> {
  readonly version: string;
  /** Resolve only for a valid request that needs the daemon, inside the framed error boundary. */
  readonly resolveTarget: () => { readonly paths: QueryOptions["paths"]; readonly home?: string };
  readonly input?: Readable;
  readonly output?: Writable;
}

/** The check the install operation makes before it starts a recorded service. Any refusal reads as not installed. */
function serviceInstalled(target: ReturnType<DesktopBridgeOptions["resolveTarget"]>): boolean {
  try { planUninstall(target.paths, target.home); return true; }
  catch { return false; }
}

/** True when automatic start is off, which is what `cotal daemon stop` leaves behind. An unreadable state is not treated as intentional. */
function intentionalStop(target: ReturnType<DesktopBridgeOptions["resolveTarget"]>): boolean {
  const receipt = readReceipt(target.paths);
  if (!receipt) return false;
  try {
    if (process.platform === "linux") {
      if ((receipt.mechanism ?? "systemd-user") !== "systemd-user" || !/^cotal-daemon(?:-[a-f0-9]{16})?\.service$/.test(receipt.unit)) return false;
      const read = nativeRun("systemctl", ["--user", "--no-ask-password", "--no-pager", "show", receipt.unit, "--property=UnitFileState", "--value"], daemonUserServiceEnv());
      return read.status === 0 && (read.stdout.trim() === "disabled" || read.stdout.trim() === "static");
    }
    if (process.platform === "darwin") return receipt.mechanism === "launchd-agent" && !launchAgentService(nativeRun).isEnabled(receipt);
    if (process.platform === "win32") return receipt.mechanism === "scheduled-task" && !scheduledTaskService(nativeRun).isEnabled(receipt);
  } catch { return false; }
  return false;
}

/** Read only a startup refusal line written during this install attempt, never an earlier launch's log. */
function attemptStartupRefusal(state: string, attemptStartedAt: number): string | undefined {
  let bytes: Buffer | undefined;
  try { bytes = readLocalRecordSource(nativeDaemonLog(state), 64 * 1024 + 128, true); }
  catch { return undefined; }
  if (!bytes) return undefined;
  const lines = bytes.toString("utf8")
    .replace(/\u001b\[[0-9;]*[A-Za-z]/g, "")
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, "")
    .replace(/eyJ[A-Za-z0-9_.-]*/g, "<redacted>")
    .split(/\r?\n/);
  let launchIndex = -1;
  for (let i = 0; i < lines.length; i++) {
    const match = /^daemon service launch (\S+)$/.exec(lines[i]!);
    if (!match) continue;
    const launchedAt = Date.parse(match[1]!);
    launchIndex = Number.isFinite(launchedAt) && launchedAt >= attemptStartedAt ? i : -1;
  }
  if (launchIndex < 0) return undefined;
  let refusal: string | undefined;
  for (let i = launchIndex + 1; i < lines.length; i++) {
    const line = lines[i]!;
    if (!line.startsWith("daemon startup refused:")) continue;
    const reason = line.slice("daemon startup refused:".length).trim().slice(0, 500);
    if (reason) refusal = reason;
  }
  return refusal;
}

/** Read a bounded tail without requiring an active writer to stop appending. */
function serviceLogTail(file: string): { text: string; truncated: boolean } {
  let fd: number;
  try { fd = openSync(file, constants.O_RDONLY | (process.platform === "win32" ? 0 : constants.O_NOFOLLOW | constants.O_NONBLOCK)); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { text: "", truncated: false };
    throw error;
  }
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || process.platform !== "win32" && (stat.uid !== process.getuid!() || (stat.mode & 0o077) !== 0)) throw new Error("The background service log is not a private regular file.");
    const start = Math.max(0, stat.size - 8192);
    const bytes = Buffer.alloc(Math.min(8192, stat.size));
    let length = 0;
    while (length < bytes.length) { const count = readSync(fd, bytes, length, bytes.length - length, start + length); if (!count) break; length += count; }
    const text = bytes.subarray(0, length).toString("utf8")
      .replace(/\u001b\[[0-9;]*[A-Za-z]/g, "")
      .replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, "")
      .replace(/eyJ[A-Za-z0-9_.-]*/g, "<redacted>");
    return { text, truncated: start > 0 };
  } finally { closeSync(fd); }
}

/** Show the bounded tails of the previous and current service launches. */
function readServiceLogTail(state: string): { text: string; truncated: boolean } {
  let previous = { text: "", truncated: false };
  if (process.platform !== "darwin") {
    try { previous = serviceLogTail(previousNativeDaemonLog(state)); } catch { /* Unreadable history must not block the current log. */ }
  }
  const current = serviceLogTail(nativeDaemonLog(state));
  const text = previous.text ? `Previous launch:\n${previous.text}${current.text ? `\n\nCurrent launch:\n${current.text}` : ""}` : current.text;
  return { text, truncated: previous.truncated || current.truncated };
}

/**
 * Only the app's uninstaller sends remove-service; the window's requests never include it. It removes
 * the service this installation registered and keeps one another installation registered here.
 */
async function removeDesktopService(paths: QueryOptions["paths"], home: string | undefined) {
  if (!preflightInstalledDaemon(paths, home)) return { state: "absent" };
  const identity = installedDaemonIdentity(paths, home);
  if (!identity.same) return { state: "kept", installed: identity.installed };
  const removed = await applyUninstall(paths, home);
  return { state: removed.state, unit: removed.unit };
}

/** Names of agents the daemon reports as running, plus a space whose Manager is still launching. Undefined when that list cannot be read. */
async function runningAgentNames(paths: QueryOptions["paths"], opts: Pick<DesktopBridgeOptions, "peerUid" | "peerPid">): Promise<string[] | undefined> {
  let reply;
  try { reply = await queryDaemon({ paths, peerUid: opts.peerUid, peerPid: opts.peerPid }); }
  catch (error) {
    if (error instanceof EndpointRefusal && error.code === "NOT_RUNNING") return [];
    return undefined;
  }
  if (!reply.ok) return undefined;
  const names: string[] = [];
  for (const manager of reply.result.managers ?? []) if (manager.state === "starting") names.push(manager.space);
  for (const inventory of reply.result.agents ?? []) {
    if (inventory.state !== "read") return undefined;
    for (const agent of inventory.agents) if (agent.state === "running") names.push(agent.name);
  }
  return names;
}

/**
 * One request each way for the app. `stop` turns automatic start off and then stops the recorded
 * service. While agents are running, or a Manager is still launching, it names them and changes
 * nothing unless `confirm` is true and names that same list. A name that joined after the preview
 * is named again and is not stopped. `start` turns automatic start back on and starts it. Neither
 * removes the installation.
 */
async function servicePower(req: Extract<DesktopRequest, { op: "stop" | "start" }>, paths: QueryOptions["paths"], home: string | undefined, opts: Pick<DesktopBridgeOptions, "peerUid" | "peerPid">) {
  if (req.op === "start") {
    const started = await startInstalled(paths, home, undefined, undefined, true);
    return { state: "start-requested", unit: started.unit };
  }
  const agents = await runningAgentNames(paths, opts);
  if (agents === undefined) throw new CommandFailure("refused", "TARGET_UNAVAILABLE", "the running agents could not be read, so the background service was not stopped");
  if (agents.length) {
    const named = req.agents;
    const same = named !== undefined && named.length === agents.length && named.every((name, index) => name === agents[index]);
    if (req.confirm !== true || !same) return { state: "needs-confirm", agents };
  }
  const stopped = await stopInstalled(paths, home);
  return { state: "stopped", unit: stopped.unit, agents };
}

/** Run one app operation through the stock local client. Closing the UI never stops the service. */
export async function runDesktopBridge(opts: DesktopBridgeOptions): Promise<void> {
  const output = opts.output ?? process.stdout;
  const emit = (frame: unknown) => output.write(`${JSON.stringify(frame)}\n`);
  let req: DesktopRequest;
  try { req = await readDesktopRequest(opts.input ?? process.stdin); }
  catch {
    emit({ v: 1, event: "result", ok: false, error: { code: "BAD_REQUEST", message: "The app request was incomplete, oversized or unsupported." } });
    return;
  }
  let target: ReturnType<DesktopBridgeOptions["resolveTarget"]> | undefined;
  let startedAt: number | undefined;
  let omittedRelativePathEntries: readonly string[] = [];
  try {
    if (req.op === "update-policy") {
      const settings = req.auto === undefined ? readUpdateSettings() : setUpdateSetting("auto", req.auto);
      emit({ v: 1, event: "result", ok: true, result: settings });
      return;
    }
    if (req.op === "about") {
      emit({ v: 1, event: "result", ok: true, result: { version: opts.version, machine: defaultComputerName(), platform: platform(), arch: arch(), release: release(), memoryBytes: totalmem() } });
      return;
    }
    if (req.op === "update-release") {
      const response = await fetch(`https://api.github.com/repos/Cotal-AI/Cotal/releases/tags/v${req.version}`, { headers: { Accept: "application/vnd.github+json", "User-Agent": "Cotal-desktop" }, signal: AbortSignal.timeout(5000), redirect: "error" });
      if (!response.ok) throw new Error("The release could not be read.");
      const length = Number(response.headers.get("content-length"));
      if (length > 256 * 1024) throw new Error("The release response is too large.");
      let body = "";
      if (!response.body) throw new Error("The release response is empty.");
      const decoder = new TextDecoder();
      const reader = response.body.getReader();
      try { for (;;) { const { done, value } = await reader.read(); if (done) break; body += decoder.decode(value, { stream: true }); if (body.length > 256 * 1024) throw new Error("The release response is too large."); } }
      finally { await reader.cancel(); }
      const release = JSON.parse(body);
      if (release.tag_name !== `v${req.version}` || !Array.isArray(release.assets)) throw new Error("The release response is unsupported.");
      const assets = release.assets.filter((asset: { name?: unknown; browser_download_url?: unknown }) => typeof asset.name === "string" && typeof asset.browser_download_url === "string").map((asset: { name: string; browser_download_url: string }) => ({ name: asset.name, url: asset.browser_download_url }));
      emit({ v: 1, event: "result", ok: true, result: { assets } }); return;
    }
    if (req.op === "status" || req.op === "status-watch" || req.op === "install" || req.op === "setup") assertDesktopSetupComplete();
    target = opts.resolveTarget();
    const { paths, home } = target;
    if (req.op === "log") { emit({ v: 1, event: "result", ok: true, result: readServiceLogTail(paths.state) }); return; }
    if (req.op === "agent-apps" || req.op === "agent-app-install" || req.op === "agent-app-sign-in") { emit({ v: 1, event: "result", ok: true, result: await agentAppRequest(req, { paths, daemonHome: home, peerUid: opts.peerUid, peerPid: opts.peerPid, version: opts.version }, emit) }); return; }
    if (req.op === "remove-service") { emit({ v: 1, event: "result", ok: true, result: await removeDesktopService(paths, home) }); return; }
    if (req.op === "stop" || req.op === "start") { emit({ v: 1, event: "result", ok: true, result: await servicePower(req, paths, home, opts) }); return; }
    const client = { paths, peerUid: opts.peerUid, peerPid: opts.peerPid };
    if (req.op === "install" || req.op === "setup") {
      const discovered = await discoverDesktopApplicationPath();
      process.env.PATH = discovered.path;
      omittedRelativePathEntries = discovered.omittedRelativeEntries;
      if (omittedRelativePathEntries.length) {
        const detail = `left out relative PATH entries: ${omittedRelativePathEntries.join(", ")}`;
        emit({ v: 1, event: "setup-progress", line: `service: ${detail}`, progress: { step: "install", outcome: "running", detail } });
      }
    }
    const omittedResult = omittedRelativePathEntries.length ? { omittedRelativePathEntries } : {};
    if (req.op === "setup") {
      startedAt = Date.now();
      const result = await runSetup({ ...client, daemonHome: home, space: req.space, idp: req.idp, version: opts.version, waitSeconds: 0, ...omittedResult,
        report: (line, progress) => emit({ v: 1, event: "setup-progress", line, progress }),
        onPrompt: (prompt) => emit({ v: 1, event: "login-prompt", prompt }),
      });
      emit({ v: 1, event: "result", ok: true, result: { ...result, ...omittedResult } });
      return;
    }
    if (req.op === "install") {
      let existing = false;
      try { planUninstall(paths, home); existing = true; }
      catch (e) { if (!(e instanceof CommandFailure) || e.code !== "TARGET_NOT_FOUND") throw e; }
      let answering: Awaited<ReturnType<typeof queryDaemon>> | undefined;
      try { answering = await queryDaemon(client); }
      catch (e) { if (!(e instanceof EndpointRefusal) || e.code !== "NOT_RUNNING") throw e; }
      if (answering !== undefined) {
        if (!existing) throw new CommandFailure("refused", "CONFLICT", "an unowned daemon is already running; no service was installed");
        if (!answering.ok || answering.result.version !== opts.version) throw new CommandFailure("refused", "CONFLICT", "the installed daemon does not match this app; no service was started");
        emit({ v: 1, event: "result", ok: true, result: { installed: true, status: answering.result, ...omittedResult } });
        return;
      }
      startedAt = Date.now();
      if (existing) await startInstalled(paths, home, opts.version, detail => emit({ v: 1, event: "setup-progress", line: `service: ${detail}`, progress: { step: "install", outcome: "running", detail } }));
      else applyInstall(paths, home, omittedRelativePathEntries);
      const deadline = Date.now() + 15_000;
      for (;;) {
        try {
          const status = await queryDaemon(client);
          if (!status.ok) throw new Error("daemon refused status");
          if (status.result.version !== opts.version) throw new Error("daemon version mismatch");
          emit({ v: 1, event: "result", ok: true, result: { installed: true, status: status.result, ...omittedResult } });
          return;
        } catch (e) {
          if (!(e instanceof EndpointRefusal) || !["NOT_RUNNING", "PEER_NOT_LOCK_OWNER"].includes(e.code)) throw e;
          if (Date.now() >= deadline) throw new CommandFailure("refused", "DEPENDENCY_UNAVAILABLE", "the installed daemon did not answer within 15 seconds of being started", { native: { code: "NOT_ANSWERING", detail: { waitSeconds: 15 } } });
        }
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
    }
    if (req.op === "status-watch") {
      const sock = await openVerified({ ...client, timeoutMs: 5000 });
      type WatchOutcome =
        | { readonly kind: "closed" }
        | { readonly kind: "unknown-op" }
        | { readonly kind: "refused"; readonly frame: Extract<DaemonResponse, { readonly ok: false }> }
        | { readonly kind: "version-mismatch"; readonly status: import("./protocol.js").DaemonStatus };
      let outcome: WatchOutcome;
      try {
        const id = randomUUID().replaceAll("-", "");
        outcome = await new Promise<WatchOutcome>((resolve, reject) => {
          let buf = "";
          let seenFirst = false;
          let settled = false;
          const finish = (err?: Error, value?: WatchOutcome) => {
            if (settled) return;
            settled = true;
            clearTimeout(initialTimer);
            sock.removeAllListeners("data");
            sock.removeAllListeners("end");
            sock.removeAllListeners("close");
            sock.removeAllListeners("error");
            if (err) reject(err);
            else resolve(value!);
          };
          const initialTimer = setTimeout(() => finish(new Error("timed out waiting for the daemon's reply")), 20_000);
          sock.setEncoding("utf8");
          sock.on("data", (chunk: string) => {
            buf += chunk;
            for (;;) {
              const nl = buf.indexOf("\n");
              if (nl === -1) {
                if (Buffer.byteLength(buf, "utf8") > MAX_LINE_BYTES) finish(new Error("daemon reply exceeds the line limit"));
                return;
              }
              const line = buf.slice(0, nl);
              buf = buf.slice(nl + 1);
              if (Buffer.byteLength(line, "utf8") + 1 > MAX_LINE_BYTES) {
                finish(new Error("daemon reply exceeds the line limit"));
                return;
              }
              let frame: DaemonResponse;
              try { frame = JSON.parse(line) as DaemonResponse; }
              catch (err) { finish(err as Error); return; }
              if (frame.v !== DAEMON_PROTOCOL_VERSION || frame.id !== id) {
                finish(new Error("mismatched daemon reply"));
                return;
              }
              if (!seenFirst) {
                seenFirst = true;
                clearTimeout(initialTimer);
                if (!frame.ok) {
                  if (frame.error.code === "UNKNOWN_OP") finish(undefined, { kind: "unknown-op" });
                  else finish(undefined, { kind: "refused", frame });
                  return;
                }
              }
              if (!frame.ok || !("event" in frame) || frame.event !== "status") {
                finish(new Error("mismatched daemon status-watch event"));
                return;
              }
              if (frame.result.version !== opts.version) {
                finish(undefined, { kind: "version-mismatch", status: frame.result });
                return;
              }
              emit({ v: 1, event: "status", ok: true, watchMode: "push", result: frame.result });
            }
          });
          sock.once("end", () => finish(seenFirst ? undefined : new Error("daemon closed the connection without a reply"), { kind: "closed" }));
          sock.once("close", () => finish(seenFirst ? undefined : new Error("daemon closed the connection without a reply"), { kind: "closed" }));
          sock.once("error", (err) => finish(err));
          sock.write(encode({ v: DAEMON_PROTOCOL_VERSION, id, op: "status-watch" }));
        });
      } finally {
        sock.destroy();
      }
      if (outcome.kind === "unknown-op") {
        let currentStatus: Awaited<ReturnType<typeof queryDaemon>> | undefined;
        try { currentStatus = await queryDaemon(client); } catch {}
        const daemonVersion = currentStatus?.ok ? currentStatus.result.version : undefined;
        emit({
          v: 1,
          event: "result",
          ok: false,
          error: {
            code: "VERSION_MISMATCH",
            message: "The running daemon and this app have different versions. Update them together before making changes.",
            native: {
              code: "UNKNOWN_OP",
              detail: {
                watchMode: "refused-unknown-op",
                appVersion: opts.version,
                ...(daemonVersion !== undefined ? { daemonVersion } : {}),
              },
            },
          },
          ...(currentStatus?.ok ? { result: { status: currentStatus.result } } : {}),
        });
        return;
      }
      if (outcome.kind === "refused") {
        emit({ ...outcome.frame, event: "result" });
        return;
      }
      if (outcome.kind === "version-mismatch") {
        emit({
          v: 1,
          event: "result",
          ok: false,
          error: {
            code: "VERSION_MISMATCH",
            message: "The running daemon and this app have different versions. Update them together before making changes.",
            native: {
              code: "VERSION_MISMATCH",
              detail: {
                watchMode: "version-mismatch",
                appVersion: opts.version,
                daemonVersion: outcome.status.version,
              },
            },
          },
          result: { status: outcome.status },
        });
        return;
      }
      emit({ v: 1, event: "result", ok: true, result: { closed: true, watchMode: "push" } });
      return;
    }
    const status = await queryDaemon(client);
    if (!status.ok) { emit({ ...status, event: "result" }); return; }
    if (req.op === "status") { emit({ ...status, event: "result" }); return; }
    if (req.op === "spaces" && !req.refresh && status.result.protocol === DAEMON_PROTOCOL_VERSION) {
      emit({ ...await exchangeDesktopRequest(client, req), event: "result" }); return;
    }
    if (status.result.version !== opts.version) {
      emit({ v: 1, event: "result", ok: false, error: { code: "VERSION_MISMATCH", message: "The running daemon and this app have different versions. Update them together before making changes." } });
      return;
    }
    if (req.op === "update-settings" || req.op === "update-check") {
      emit({ v: 1, event: "result", ok: true, result: await updateViaDaemon(client, req) }); return;
    }
    if (req.op === "login") {
      const result = await loginViaDaemon({ ...client, idp: req.idp, onPrompt: (prompt) => emit({ v: 1, event: "login-prompt", prompt }) });
      emit({ v: 1, event: "result", ...result });
      return;
    }
    const reply = await exchangeDesktopRequest(client, req);
    emit({ ...reply, event: "result" });
  } catch (e) {
    const code = e instanceof EndpointRefusal || e instanceof CommandFailure ? e.code : daemonConnectionLost(e) ? "DAEMON_LOST" : "OPERATION_FAILED";
    // The app tells a stopped service (offer Start service) from one not set up yet (sign-in sets it up).
    const stoppedService = code === "NOT_RUNNING" && target !== undefined && serviceInstalled(target);
    const stoppedByYou = stoppedService && (req.op === "status" || req.op === "status-watch") && target !== undefined && intentionalStop(target);
    const notAnswering = e instanceof CommandFailure && (req.op === "setup" || req.op === "install") && e.code === "DEPENDENCY_UNAVAILABLE" && e.native?.code === "NOT_ANSWERING";
    const refusal = notAnswering && target && startedAt !== undefined ? attemptStartupRefusal(target.paths.state, startedAt) : undefined;
    const rawWait = notAnswering && e.native?.detail && typeof e.native.detail === "object" ? (e.native.detail as { waitSeconds?: unknown }).waitSeconds : undefined;
    const waitSeconds = typeof rawWait === "number" && Number.isInteger(rawWait) && rawWait > 0 ? rawWait : undefined;
    const baseMessage = notAnswering ? `Cotal asked the background service on this computer to start, and it ${waitSeconds !== undefined ? `did not answer within ${waitSeconds} seconds.` : "has not answered."}${refusal ? ` It refused to start: ${refusal}` : ""}`
      : e instanceof CommandFailure && (e.code === "CONFLICT" || req.op === "setup" || req.op === "install" || req.op === "remove-service" || req.op.startsWith("agent-app")) ? e.message
      : code === "NOT_RUNNING" ? (stoppedByYou
        ? "You stopped the background service. Start it to run agents on this computer again."
        : stoppedService
        ? "The background service is installed but stopped. Choose Start service to start it."
        : "The daemon is not running. Install its background service first.")
      : code === "NO_RUNTIME_DIR" ? "The daemon runtime path is unavailable or too long. On Linux, check XDG_RUNTIME_DIR for the intended operating-system user."
      : code === "UNSUPPORTED_PLATFORM" ? "This platform does not have the required native daemon support."
      : code === "PEER_UID_MISMATCH" || code === "PEER_NOT_LOCK_OWNER" ? "The local daemon identity could not be verified. The requested change was not sent."
      : code === "DAEMON_LOST" ? "The background service stopped before this could finish, so it did not complete. Try again when the service is running."
      : "The operation could not be completed, and no success is assumed. Settings shows the background service log.";
    const message = (req.op === "setup" || req.op === "install") && omittedRelativePathEntries.length
      ? `${baseMessage}${baseMessage.endsWith(".") ? "" : "."} Left out relative PATH entries: ${omittedRelativePathEntries.join(", ")}.`
      : baseMessage;
    emit({ v: 1, event: "result", ok: false, error: { code, message, ...(stoppedService ? { detail: { installed: true, ...(stoppedByYou ? { stopped: "by-you" } : {}) } } : {}),
      ...(e instanceof CommandFailure && (req.op === "setup" || req.op === "install" || req.op.startsWith("agent-app")) ? { remedy: notAnswering ? "choose Check status." : e.remedy, native: e.native } : {}),
    } });
  }
}

/** Shared by the app adapter and the ordinary daemon CLI commands. */
export async function exchangeDesktopRequest(
  opts: Pick<QueryOptions, "paths" | "peerUid" | "peerPid">,
  request: Exclude<Extract<DesktopRequest, { readonly op: "name" } | { readonly op: "update-settings" } | { readonly op: "update-check" } | { readonly op: "spaces" } | { readonly op: "logout" } | { readonly space: string }>, { readonly op: "setup" }>,
): Promise<DaemonResponse> {
  const sock = await openVerified({ ...opts, timeoutMs: 5000 });
  try {
    const id = randomUUID().replaceAll("-", "");
    sock.write(encode({ v: DAEMON_PROTOCOL_VERSION, id, ...request }));
    // Service connection includes the same cold-readiness exchange as the ordinary CLI client.
    const reply = JSON.parse(await readLine(sock, 160_000)) as DaemonResponse;
    if (reply.v !== DAEMON_PROTOCOL_VERSION || reply.id !== id || "event" in reply) throw new Error("mismatched daemon reply");
    return reply;
  } finally { sock.destroy(); }
}
