/** The desktop shell's bounded stdio adapter. It holds no login session or broker credentials. */
import { randomUUID } from "node:crypto";
import { defaultComputerName } from "./computer-name.js";
import { computerName } from "./name-validation.js";
import { arch, platform, release, totalmem } from "node:os";
import type { Readable, Writable } from "node:stream";
import { CommandFailure } from "@cotal-ai/workspace";
import { normalizeIdpUrl } from "@cotal-ai/auth";
import { loginViaDaemon, updateViaDaemon, openVerified, queryDaemon, readLine, type QueryOptions } from "./client.js";
import { DAEMON_PROTOCOL_VERSION, MAX_LINE_BYTES, EndpointRefusal } from "./endpoint.js";
import { applyInstall, planUninstall, startInstalled } from "./install.js";
import { encode, isDaemonSpaceName, type DaemonResponse } from "./protocol.js";
import { runSetup } from "./setup.js";
import { desktopApplicationPath } from "./desktop-path.js";

export type DesktopRequest =
  | { readonly op: "update-settings"; readonly auto?: boolean; readonly notify?: boolean }
  | { readonly op: "update-check" }
  | { readonly op: "update-release"; readonly version: string }
  | { [K in "about" | "status" | "install"]: { readonly op: K } }["about" | "status" | "install"]
  | { readonly op: "space-intent"; readonly space: string; readonly enabled: boolean }
  | { readonly op: "name"; readonly name?: string }
  | { readonly op: "spaces"; readonly refresh?: boolean }
  | { readonly op: "login"; readonly idp: string }
  | { readonly op: "setup"; readonly space: string; readonly idp: string }
  | { readonly op: "connect-check" | "register" | "service-connect" | "service-disconnect" | "service-status"; readonly space: string };

/** No renderer-supplied command, path, credentials or arbitrary arguments cross this boundary. */
export function parseDesktopRequest(value: unknown): DesktopRequest {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("request must be an object");
  const o = value as Record<string, unknown>;
  const simple = ["about", "status", "install", "update-check"].includes(String(o.op));
  const scoped = ["connect-check", "register", "service-connect", "service-disconnect", "service-status"].includes(String(o.op));
  const fields = o.op === "update-release" ? ["op", "version"] : o.op === "update-settings" ? ["op", "auto", "notify"] : o.op === "name" ? ["op", "name"] : o.op === "space-intent" ? ["op", "space", "enabled"] : simple ? ["op"] : scoped ? ["op", "space"] : o.op === "setup" ? ["op", "space", "idp"] : o.op === "login" ? ["op", "idp"] : o.op === "spaces" ? ["op", "refresh"] : [];
  if (!fields.length || Object.keys(o).some((key) => !fields.includes(key))) throw new Error("unknown operation or field");
  if (o.op === "update-release") {
    if (typeof o.version !== "string" || !/^\d+\.\d+\.\d+$/.test(o.version)) throw new Error("invalid release version");
    return { op: "update-release", version: o.version };
  }
  if (o.op === "update-settings") {
    if ([o.auto, o.notify].some(value => value !== undefined && typeof value !== "boolean")) throw new Error("invalid update setting");
    return { op: "update-settings", ...(o.auto !== undefined ? { auto: o.auto as boolean } : {}), ...(o.notify !== undefined ? { notify: o.notify as boolean } : {}) };
  }
  if (o.op === "space-intent") {
    if (!isDaemonSpaceName(o.space) || typeof o.enabled !== "boolean") throw new Error("invalid space intent");
    return { op: "space-intent", space: o.space, enabled: o.enabled };
  }
  if (o.op === "name") return { op: "name", ...(o.name !== undefined ? { name: computerName(o.name) } : {}) };
  if (simple) return { op: o.op as "about" | "status" | "install" | "update-check" };
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
  return { op: "login", idp: normalizeIdpUrl(o.idp) };
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

export interface DesktopBridgeOptions extends Pick<QueryOptions, "peerUid" | "peerPid"> {
  readonly version: string;
  /** Resolve only for a valid request that needs the daemon, inside the framed error boundary. */
  readonly resolveTarget: () => { readonly paths: QueryOptions["paths"]; readonly home?: string };
  readonly input?: Readable;
  readonly output?: Writable;
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
  try {
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
    const { paths, home } = opts.resolveTarget();
    const client = { paths, peerUid: opts.peerUid, peerPid: opts.peerPid };
    if (req.op === "install" || req.op === "setup") process.env.PATH = await desktopApplicationPath();
    if (req.op === "setup") {
      const result = await runSetup({ ...client, daemonHome: home, space: req.space, idp: req.idp, version: opts.version, waitSeconds: 0,
        report: (line, progress) => emit({ v: 1, event: "setup-progress", line, progress }),
        onPrompt: (prompt) => emit({ v: 1, event: "login-prompt", prompt }),
      });
      emit({ v: 1, event: "result", ok: true, result });
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
        emit({ v: 1, event: "result", ok: true, result: { installed: true, status: answering.result } });
        return;
      }
      if (existing) await startInstalled(paths, home, opts.version, detail => emit({ v: 1, event: "setup-progress", line: `service: ${detail}`, progress: { step: "install", outcome: "running", detail } }));
      else applyInstall(paths, home);
      const deadline = Date.now() + 15_000;
      for (;;) {
        try {
          const status = await queryDaemon(client);
          if (!status.ok) throw new Error("daemon refused status");
          if (status.result.version !== opts.version) throw new Error("daemon version mismatch");
          emit({ v: 1, event: "result", ok: true, result: { installed: true, status: status.result } });
          return;
        } catch (e) {
          if (!(e instanceof EndpointRefusal) || !["NOT_RUNNING", "PEER_NOT_LOCK_OWNER"].includes(e.code)) throw e;
          if (Date.now() >= deadline) throw new CommandFailure("refused", "DEPENDENCY_UNAVAILABLE", "the installed daemon did not answer within 15 seconds of being started", { native: { code: "NOT_ANSWERING" } });
        }
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
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
    const code = e instanceof EndpointRefusal || e instanceof CommandFailure ? e.code : "OPERATION_FAILED";
    const message = e instanceof CommandFailure && (req.op === "setup" || (req.op === "install" && e.native?.code !== "NOT_ANSWERING")) ? e.message
      : code === "NOT_RUNNING" ? "The daemon is not running. Install its background service first."
      : e instanceof CommandFailure && e.code === "DEPENDENCY_UNAVAILABLE" && e.native?.code === "NOT_ANSWERING" ? "The background service was installed and a start was requested, but the daemon did not answer within 15 seconds. Use \`cotal daemon status\` for diagnostics."
      : code === "NO_RUNTIME_DIR" ? "The daemon runtime path is unavailable or too long. On Linux, check XDG_RUNTIME_DIR for the intended operating-system user."
      : code === "UNSUPPORTED_PLATFORM" ? "This platform does not have the required native daemon support."
      : code === "PEER_UID_MISMATCH" || code === "PEER_NOT_LOCK_OWNER" ? "The local daemon identity could not be verified. The requested change was not sent."
      : "The operation could not be completed. Use the matching `cotal daemon` command for diagnostics; no success is assumed.";
    emit({ v: 1, event: "result", ok: false, error: { code, message,
      ...(e instanceof CommandFailure && (req.op === "setup" || req.op === "install") ? { remedy: e.remedy, native: e.native } : {}),
    } });
  }
}

/** Shared by the app adapter and the ordinary daemon CLI commands. */
export async function exchangeDesktopRequest(
  opts: Pick<QueryOptions, "paths" | "peerUid" | "peerPid">,
  request: Exclude<Extract<DesktopRequest, { readonly op: "name" } | { readonly op: "update-settings" } | { readonly op: "update-check" } | { readonly op: "spaces" } | { readonly space: string }>, { readonly op: "setup" }>,
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
