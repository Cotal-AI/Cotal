/**
 * `cotal daemon`: the local machine daemon's control surface, composed in this binary rather than
 * in an `implementations/*` package so it can later wire `@cotal-ai/auth` and `@cotal-ai/manager`
 * without one implementation importing another (AGENTS.md, repository map).
 *
 * This slice serves a local, authenticated endpoint for status, sign-in, a connection check and a
 * registration request, and installs itself as a systemd user service. It starts no Manager and
 * serves no command on its service. Linux
 * only. Sign-in runs inside the
 * daemon through stock `establishIdpSession`, so the session lands in the machine-home Cotal
 * directory where `cotal login` keeps it, and no token ever crosses the local endpoint. The
 * connection check (`connect.ts`) reads the space's public account identity and keeps the daemon's
 * own per-space identity, never a Manager's. The registration request (`register.ts`) sends one stock
 * `register` for that identity and reports the space's answer; approval stays with the space owner. The
 * service connection (`service.ts`) connects that approved identity as a stock service through the stock
 * renewal source and reports it connected only once the broker and the space's ready both accept it. A
 * connection it reached records that intent, so a restarted daemon connects those spaces again.
 * `install` (`install.ts`) runs it as a systemd user service that starts at login, restarts on its
 * own and survives logout through linger. `setup` (`setup.ts`) is those steps plus sign-in,
 * registration and connection in one command, for a machine with no browser on it. A killed daemon comes back by itself: its lifetime lock
 * is kernel-held, so the restart knows its predecessor is gone and removes the exact socket that
 * predecessor published (`lifetime.ts`). `state: "ready"` means the local control listener is bound
 * and verified; it says nothing about any mesh or Cloud connection.
 */
import { readFileSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import { registry, type Command, type FlagSpec, type ParsedArgs } from "@cotal-ai/core";
import { CommandFailure, homeCotalDir, jsonFlag, plainFlag, presentationOf, renderReport, spaceFlag, writeResult, type Report } from "@cotal-ai/workspace";
import { peerCredentials } from "@cotal-ai/seat";
import { normalizeIdpUrl } from "@cotal-ai/auth";
import type { Socket } from "node:net";
import { EndpointRefusal, checkDir, daemonPaths, daemonPathsFor, type DaemonPaths, type EndpointProblemCode } from "./endpoint.js";
import { serveDaemon } from "./server.js";
import { connectCheckViaDaemon, loginViaDaemon, queryDaemon, registerViaDaemon, serviceViaDaemon } from "./client.js";
import { applyInstall, applyUninstall, planInstall, planUninstall } from "./install.js";
import { runSetup } from "./setup.js";
import type { ConnectCheckResult, DaemonStatus, LoginResult, RegisterResult, ServiceConnectionResult } from "./protocol.js";

export const daemonFlags = [
  jsonFlag,
  plainFlag,
  { name: "idp", type: "string", value: "<auth base URL>", description: "login: the provider's auth base URL, e.g. <origin>/api/auth" },
  { name: "client-id", type: "string", value: "<id>", description: "login: the OAuth device-flow client id" },
  { name: "daemon-home", type: "string", value: "<abs dir>", description: "run or reach the daemon whose state lives in this directory (absolute, yours, mode 0700, not the Cotal home): its own sign-in, identity and registration, its own socket and lifetime lock. Without it, the default daemon" },
  { name: "dry-run", type: "boolean", description: "install, uninstall: report the unit it would write or remove, and change nothing" },
  { name: "yes", type: "boolean", short: "y", description: "uninstall: confirm in a script" },
  { name: "wait", type: "string", value: "<seconds>", description: "setup: how long to wait for the space owner's approval (default 900, 0 reports what it reached)" },
  spaceFlag,
] as const satisfies readonly FlagSpec[];

/** This binary's own version: the nearest package.json above this module (bin/ in a source run). */
export function binVersion(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 4; i++) {
    try {
      const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as { name?: string; version?: string };
      if (pkg.name === "cotal-ai" && typeof pkg.version === "string") return pkg.version;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    }
    dir = dirname(dir);
  }
  throw new Error("cannot determine the cotal-ai version: no cotal-ai package.json above the daemon module");
}

const peerUid = (sock: Socket): number => peerCredentials(sock).uid;
const peerPid = (sock: Socket): number => peerCredentials(sock).pid;

/** The daemon this invocation targets: the default one, or the one whose state lives in an explicit
 *  `--daemon-home`. The home must already exist as a real 0700 directory owned by this uid, and may
 *  not be the Cotal home itself; nothing is created, repaired or migrated. Mesh lookup always stays
 *  the shared Cotal home's registry. */
interface Target { readonly paths: DaemonPaths; readonly home?: string }
function target(args: ParsedArgs): Target {
  const raw = (args.values as { "daemon-home"?: string })["daemon-home"];
  if (raw === undefined) return { paths: daemonPaths() };
  if (!raw || !isAbsolute(raw)) throw new CommandFailure("refused", "USAGE_INVALID", "--daemon-home needs an absolute directory path");
  checkDir(raw);
  const home = realpathSync(raw);
  let cotalHome: string | undefined;
  try { cotalHome = realpathSync(homeCotalDir()); } catch (e) { if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e; }
  if (home === cotalHome) throw new CommandFailure("refused", "USAGE_INVALID", "--daemon-home cannot be the Cotal home; name a separate directory for this daemon's state");
  return { paths: daemonPathsFor(home), home };
}
function resolveTarget(args: ParsedArgs): Target {
  try { return target(args); }
  catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") throw new CommandFailure("refused", "TARGET_NOT_FOUND", "the --daemon-home directory does not exist; create it with mode 0700 first");
    throw asFailure(e);
  }
}

const REFUSAL: Record<EndpointProblemCode, { code: "UNSUPPORTED" | "TARGET_UNAVAILABLE" | "CONFLICT" | "PERMISSION_DENIED"; remedy?: string }> = {
  UNSUPPORTED_PLATFORM: { code: "UNSUPPORTED" },
  NO_RUNTIME_DIR: { code: "TARGET_UNAVAILABLE", remedy: "run from a logged-in session with a per-user runtime directory (systemd-logind sets XDG_RUNTIME_DIR)" },
  NOT_RUNNING: { code: "TARGET_UNAVAILABLE", remedy: "start it with `cotal daemon serve`" },
  ALREADY_RUNNING: { code: "CONFLICT", remedy: "run `cotal daemon status`: if it answers, a daemon is already running. If it refuses NOT_RUNNING, a previous daemon exited without cleanup and the entry is stale; confirm no `cotal daemon serve` process is running, then remove the socket path named above by hand and start again. The daemon never removes it for you" },
  DIR_NOT_DIRECTORY: { code: "PERMISSION_DENIED", remedy: "inspect the path; nothing was changed" },
  DIR_SYMLINK: { code: "PERMISSION_DENIED", remedy: "inspect the path; nothing was changed" },
  DIR_WRONG_OWNER: { code: "PERMISSION_DENIED", remedy: "inspect the path; nothing was changed" },
  DIR_WRONG_MODE: { code: "PERMISSION_DENIED", remedy: "inspect the directory; the daemon never changes the mode of an existing directory" },
  SOCKET_NOT_SOCKET: { code: "PERMISSION_DENIED", remedy: "inspect the path; nothing was removed" },
  SOCKET_WRONG_OWNER: { code: "PERMISSION_DENIED", remedy: "inspect the path; nothing was removed" },
  SOCKET_WRONG_MODE: { code: "PERMISSION_DENIED", remedy: "inspect the socket; nothing was sent" },
  PEER_UID_MISMATCH: { code: "PERMISSION_DENIED", remedy: "another user's process holds the daemon endpoint; nothing was sent" },
  PEER_NOT_LOCK_OWNER: { code: "PERMISSION_DENIED", remedy: "the process at this daemon home's socket is not the daemon holding its lock; nothing was sent" },
  LOCK_HELD: { code: "CONFLICT", remedy: "a daemon already holds this lifetime lock; run `cotal daemon status`, with the same --daemon-home when you passed one" },
};

function asFailure(e: unknown): unknown {
  if (!(e instanceof EndpointRefusal)) return e;
  const r = REFUSAL[e.code];
  return new CommandFailure("refused", r.code, e.message, { ...(r.remedy ? { remedy: r.remedy } : {}), native: { code: e.code } });
}

function statusView(s: DaemonStatus): Report {
  return { sections: [{ title: "Daemon", blocks: [{ kind: "fields", rows: [["State", s.state], ["Version", s.version], ["Protocol", String(s.protocol)], ["PID", String(s.pid)], ["Started", s.startedAt], ["Uptime", `${Math.round(s.uptimeMs / 1000)}s`]] }] }] };
}

async function status(args: ParsedArgs): Promise<void> {
  const presentation = presentationOf(args.values);
  const { paths } = resolveTarget(args);
  let reply;
  try {
    reply = await queryDaemon({ paths, peerUid, peerPid });
  } catch (e) {
    throw asFailure(e);
  }
  if (!reply.ok) throw new CommandFailure("failed", "OPERATION_FAILED", `the daemon refused the status request: ${reply.error.code} ${reply.error.message}`);
  writeResult(presentation, { command: "daemon status", target: null, result: reply.result }, statusView);
}

/** Sign in through the running daemon. The daemon talks to the IdP and keeps the session; this
 *  process only shows the approval prompt and the result, and never sees a token. Ctrl-C asks the
 *  daemon to cancel the attempt and waits for its answer. */
async function login(args: ParsedArgs): Promise<void> {
  const presentation = presentationOf(args.values);
  const values = args.values as { idp?: string; "client-id"?: string };
  if (typeof values.idp !== "string") throw new CommandFailure("refused", "USAGE_INVALID", "cotal daemon login needs --idp <auth base URL>");
  let idp: string;
  try { idp = normalizeIdpUrl(values.idp); }
  catch { throw new CommandFailure("refused", "USAGE_INVALID", "use an HTTPS provider auth URL, or an HTTP loopback IP URL, without embedded credentials, a query or a fragment"); }
  if (values["client-id"] !== undefined && !values["client-id"].trim()) throw new CommandFailure("refused", "USAGE_INVALID", "--client-id cannot be empty");
  const { paths } = resolveTarget(args);
  const abort = new AbortController();
  const onSignal = () => abort.abort();
  process.once("SIGINT", onSignal);
  let reply;
  try {
    reply = await loginViaDaemon({
      paths, peerUid, peerPid, idp, signal: abort.signal,
      ...(values["client-id"] !== undefined ? { clientId: values["client-id"] } : {}),
      onPrompt: (p) => {
        process.stderr.write(`${renderReport({ sections: [{ title: "Approve sign-in", blocks: [
          { kind: "fields", rows: [["Provider", idp], ["Open", p.verificationUriComplete], ["Or open", p.verificationUri], ["Approval code", p.userCode], ["Expires", p.expiresAt]] },
          { kind: "lines", lines: [{ text: "Waiting for the provider's approval. The daemon keeps the session. Ctrl-C cancels this sign-in on this machine. Do not share the approval link or code.", tone: "hint" }] },
        ] }] }, presentation === "plain" ? "plain" : "rich", process.stderr)}\n`);
      },
    });
  } catch (e) {
    throw asFailure(e);
  } finally {
    process.off("SIGINT", onSignal);
  }
  if (!reply.ok) {
    if (reply.code === "LOGIN_IN_PROGRESS") throw new CommandFailure("refused", "CONFLICT", reply.message, { native: { code: reply.code } });
    if (reply.code === "ABANDONED") throw new CommandFailure("refused", "USAGE_INVALID", reply.message, { native: { code: reply.code } });
    throw new CommandFailure("failed", "OPERATION_FAILED", `the daemon refused the sign-in: ${reply.code} ${reply.message}`, { native: { code: reply.code } });
  }
  const r: LoginResult = reply.result;
  if (r.outcome === "cancelled") throw new CommandFailure("refused", "USAGE_INVALID", "the sign-in was cancelled on this machine; nothing was saved and nothing was revoked at the provider", { native: { code: "CANCELLED" } });
  if (r.outcome === "failed") {
    const native = { native: { code: r.reason.toUpperCase() } };
    // Denied, expired and unreachable end before stock writes anything: refusals at the provider's
    // boundary. Any other failure can come after stock saved the session, so it claims nothing about
    // what was saved; `cotal daemon login` again replaces whatever is there.
    if (r.reason === "unreachable") throw new CommandFailure("refused", "DEPENDENCY_UNAVAILABLE", `${r.message}; no session was saved`, native);
    if (r.reason === "denied" || r.reason === "expired") throw new CommandFailure("refused", "PERMISSION_DENIED", `${r.message}; no session was saved`, native);
    throw new CommandFailure("failed", "OPERATION_FAILED", `${r.message}; a session may have been saved before the failure, so sign in again`, native);
  }
  writeResult(presentation, { command: "daemon login", target: { idp }, result: { attempt: reply.attempt, ...r } }, () => ({ sections: [
    { title: "Signed in", blocks: [{ kind: "fields", rows: [["Account", r.label || r.sub], ["Subject", r.sub], ["Provider", r.idp]] }, { kind: "lines", lines: [{ text: "The daemon holds this session in the machine's Cotal home. No session token is printed. Each space's grants decide access separately.", tone: "hint" }] }] },
  ] }));
}

/** Ask the running daemon whether it could register with a space. The daemon reads the space's
 *  public account identity and nothing else; no registration, credential or authority results. */
async function connectCheckCommand(args: ParsedArgs): Promise<void> {
  const presentation = presentationOf(args.values);
  const space = (args.values as { space?: string }).space;
  if (typeof space !== "string" || !space) throw new CommandFailure("refused", "USAGE_INVALID", "cotal daemon connect-check needs --space <s>");
  const { paths } = resolveTarget(args);
  let reply;
  try {
    reply = await connectCheckViaDaemon({ paths, peerUid, peerPid, space });
  } catch (e) {
    throw asFailure(e);
  }
  if (!reply.ok) throw new CommandFailure("refused", "USAGE_INVALID", `the daemon refused the connect check: ${reply.code} ${reply.message}`, { native: { code: reply.code } });
  const r: ConnectCheckResult = reply.result;
  const native = { native: { code: r.outcome.toUpperCase().replaceAll("-", "_") } };
  if (r.outcome === "not-registered") throw new CommandFailure("refused", "TARGET_NOT_FOUND", r.message, native);
  if (r.outcome === "not-user-auth" || r.outcome === "unsupported-by-space") throw new CommandFailure("refused", "UNSUPPORTED", r.message, native);
  if (r.outcome === "not-signed-in") throw new CommandFailure("refused", "AUTH_REQUIRED", r.message, native);
  if (r.outcome === "unreachable") throw new CommandFailure("refused", "DEPENDENCY_UNAVAILABLE", r.message, native);
  if (r.outcome === "account-mismatch") throw new CommandFailure("refused", "CONFLICT", r.message, native);
  if (r.outcome !== "ready-to-register") throw new CommandFailure("refused", "DEPENDENCY_UNAVAILABLE", r.message, native);
  writeResult(presentation, { command: "daemon connect-check", target: { space }, result: r }, () => ({ sections: [
    { title: "Ready to register", blocks: [
      { kind: "fields", rows: [["Space", r.space], ["Service", r.endpoint], ["Instance", r.instanceId], ["Account", r.accountPublicKey]] },
      { kind: "lines", lines: [{ text: "Nothing was registered. The space owner must approve this daemon before it can connect.", tone: "hint" }] },
    ] },
  ] }));
}

/** Ask the running daemon to submit its own service registration for a space. The space owner's
 *  approval and the operator's name binding happen elsewhere; this never activates or serves. */
async function registerCommand(args: ParsedArgs): Promise<void> {
  const presentation = presentationOf(args.values);
  const space = (args.values as { space?: string }).space;
  if (typeof space !== "string" || !space) throw new CommandFailure("refused", "USAGE_INVALID", "cotal daemon register needs --space <s>");
  const { paths } = resolveTarget(args);
  let reply;
  try {
    reply = await registerViaDaemon({ paths, peerUid, peerPid, space });
  } catch (e) {
    throw asFailure(e);
  }
  if (!reply.ok) throw new CommandFailure("refused", "USAGE_INVALID", `the daemon refused the registration request: ${reply.code} ${reply.message}`, { native: { code: reply.code } });
  const r: RegisterResult = reply.result;
  const native = { native: { code: (r.outcome === "refused" && "reason" in r ? r.reason : r.outcome).toUpperCase().replaceAll("-", "_") } };
  if (r.outcome === "not-registered") throw new CommandFailure("refused", "TARGET_NOT_FOUND", r.message, native);
  if (r.outcome === "not-user-auth" || r.outcome === "unsupported-by-space") throw new CommandFailure("refused", "UNSUPPORTED", r.message, native);
  if (r.outcome === "not-signed-in") throw new CommandFailure("refused", "AUTH_REQUIRED", r.message, native);
  if (r.outcome === "unreachable") throw new CommandFailure("refused", "DEPENDENCY_UNAVAILABLE", r.message, native);
  if (r.outcome === "account-mismatch" || r.outcome === "conflict") throw new CommandFailure("refused", "CONFLICT", r.message, native);
  // Only a refusal carrying the space's stock reason is a denial; one without is the daemon's own failure.
  if (r.outcome === "refused") throw new CommandFailure("refused", "reason" in r ? "PERMISSION_DENIED" : "DEPENDENCY_UNAVAILABLE", r.message, native);
  if (r.outcome !== "approval-required" && r.outcome !== "pending" && r.outcome !== "registered") throw new CommandFailure("unknown", "OPERATION_UNKNOWN", r.message, native);
  const title = r.outcome === "approval-required" ? "Waiting for the space owner" : r.outcome === "pending" ? "Registration in progress" : "Registered, not connected";
  writeResult(presentation, { command: "daemon register", target: { space }, result: r }, () => ({ sections: [
    { title, blocks: [
      { kind: "fields", rows: [["Space", r.space], ["Service", r.endpoint], ["Instance", r.instanceId], ["Request", r.requestId]] },
      { kind: "lines", lines: [{ text: r.message, tone: "hint" }] },
    ] },
  ] }));
}

/** Connect, disconnect or read the daemon's own service connection to a space. Only `connected` (and
 *  `disconnected` for a disconnect) exits 0; every other state is a refusal naming why. */
async function serviceCommand(args: ParsedArgs, op: "service-connect" | "service-disconnect" | "service-status"): Promise<void> {
  const presentation = presentationOf(args.values);
  const space = (args.values as { space?: string }).space;
  if (typeof space !== "string" || !space) throw new CommandFailure("refused", "USAGE_INVALID", `cotal daemon ${op} needs --space <s>`);
  const { paths } = resolveTarget(args);
  let reply;
  try {
    reply = await serviceViaDaemon({ paths, peerUid, peerPid, space, op });
  } catch (e) {
    throw asFailure(e);
  }
  if (!reply.ok) throw new CommandFailure("refused", "USAGE_INVALID", `the daemon refused the service request: ${reply.code} ${reply.message}`, { native: { code: reply.code } });
  const r: ServiceConnectionResult = reply.result;
  const native = { native: { code: (r.state === "ended" && r.reason ? r.reason : r.state).toUpperCase().replaceAll("-", "_") } };
  const ok = r.state === "connected" || (op === "service-disconnect" && r.state === "disconnected");
  if (!ok) {
    const code = r.state === "not-requested" || r.state === "not-registered" ? "TARGET_NOT_FOUND"
      : r.state === "unsupported" ? "UNSUPPORTED"
      : r.state === "not-signed-in" ? "AUTH_REQUIRED"
      : r.state === "refused" || r.state === "ended" ? "PERMISSION_DENIED"
      : r.state === "conflict" ? "CONFLICT"
      : r.state === "approval-pending" || r.state === "connecting" ? "LIFECYCLE_BLOCKED"
      : r.state === "disconnected" ? "TARGET_UNAVAILABLE"
      : "DEPENDENCY_UNAVAILABLE";
    throw new CommandFailure("refused", code, r.message, native);
  }
  writeResult(presentation, { command: `daemon ${op}`, target: { space }, result: r }, () => ({ sections: [
    { title: r.state === "connected" ? "Connected" : "Disconnected", blocks: [
      { kind: "fields", rows: [["Space", r.space], ...(r.instanceId ? [["Instance", r.instanceId] as [string, string]] : [])] },
      { kind: "lines", lines: [{ text: r.message, tone: "hint" }] },
    ] },
  ] }));
}

/** Install or remove the daemon's systemd user service. Both forms report the exact unit. */
async function unitCommand(args: ParsedArgs, op: "install" | "uninstall"): Promise<void> {
  const presentation = presentationOf(args.values);
  const values = args.values as { "dry-run"?: boolean; yes?: boolean };
  const { paths, home } = resolveTarget(args);
  if (op === "install") {
    const dry = values["dry-run"] === true;
    const r = dry ? { ...planInstall(paths, home), state: "would-install" as const } : applyInstall(paths, home);
    writeResult(presentation, { command: "daemon install", target: { unit: r.unit }, result: r }, () => ({ sections: [
      { title: dry ? "Would install" : "Installed", blocks: [
        { kind: "fields", rows: [["Unit", r.unit], ["Path", r.unitPath], ["Digest", r.sha256], ["User", r.user], ["Linger", r.lingerAlready ? "already enabled" : dry ? "would be enabled" : "enabled by this install"], ["Restart", r.restart], ["Started by", r.wantedBy], ...(r.daemonHome ? [["Daemon home", r.daemonHome] as [string, string]] : [])] },
        { kind: "lines", lines: [{ text: dry
          ? "Nothing was written, enabled or started."
          : "It starts at login, restarts on its own, and keeps running after you log out. Read it with `cotal daemon status`, and remove it with `cotal daemon uninstall`.", tone: "hint" }] },
      ] },
    ] }));
    return;
  }
  const dry = values["dry-run"] === true;
  if (!dry && values.yes !== true && !process.stdout.isTTY) throw new CommandFailure("refused", "USAGE_INVALID", "cotal daemon uninstall needs --yes outside a terminal; nothing was removed");
  const r = dry ? { ...planUninstall(paths), state: "would-remove" as const } : applyUninstall(paths);
  writeResult(presentation, { command: "daemon uninstall", target: { unit: r.unit }, result: r }, () => ({ sections: [
    { title: dry ? "Would remove" : "Removed", blocks: [
      { kind: "fields", rows: [["Unit", r.unit], ["Path", r.unitPath], ["Installed", r.installedAt]] },
      { kind: "lines", lines: [{ text: dry
        ? "Nothing was stopped, disabled or removed."
        : "The daemon is stopped and will not start at login. Linger is left enabled, because other user services may rely on it.", tone: "hint" }] },
    ] },
  ] }));
}

/** Connect a headless machine with one command: install, sign in, register, connect. */
async function setupCommand(args: ParsedArgs): Promise<void> {
  const presentation = presentationOf(args.values);
  const values = args.values as { space?: string; idp?: string; "client-id"?: string; wait?: string };
  const space = values.space;
  if (typeof space !== "string" || !space) throw new CommandFailure("refused", "USAGE_INVALID", "cotal daemon setup needs --space <s>");
  let idp: string | undefined;
  if (values.idp !== undefined) {
    try { idp = normalizeIdpUrl(values.idp); }
    catch { throw new CommandFailure("refused", "USAGE_INVALID", "use an HTTPS provider auth URL, or an HTTP loopback IP URL, without embedded credentials, a query or a fragment"); }
  }
  if (values["client-id"] !== undefined && !values["client-id"].trim()) throw new CommandFailure("refused", "USAGE_INVALID", "--client-id cannot be empty");
  const waitSeconds = values.wait === undefined ? 900 : Number(values.wait);
  if (!Number.isInteger(waitSeconds) || waitSeconds < 0 || waitSeconds > 86400) throw new CommandFailure("refused", "USAGE_INVALID", "--wait takes whole seconds from 0 to 86400");
  const { paths, home } = resolveTarget(args);
  const plain = presentation === "plain";
  // Progress goes to stderr so a --json caller still reads one document on stdout.
  const report = (line: string) => { if (presentation !== "json") process.stderr.write(`${line}\n`); };
  let r;
  try {
    r = await runSetup({
      paths, daemonHome: home, space, peerUid, peerPid, waitSeconds, report,
      ...(idp !== undefined ? { idp } : {}),
      ...(values["client-id"] !== undefined ? { clientId: values["client-id"] } : {}),
      onPrompt: (p) => {
        process.stderr.write(`${renderReport({ sections: [{ title: "Approve this machine", blocks: [
          { kind: "fields", rows: [["Provider", idp!], ["Open", p.verificationUriComplete], ["Or open", p.verificationUri], ["Approval code", p.userCode], ["Expires", p.expiresAt]] },
          { kind: "lines", lines: [{ text: "Open that link on any device with a browser. This machine needs none. Do not share the approval link or code.", tone: "hint" }] },
        ] }] }, plain ? "plain" : "rich", process.stderr)}\n`);
      },
    });
  } catch (e) {
    throw asFailure(e);
  }
  writeResult(presentation, { command: "daemon setup", target: { space }, result: r }, () => ({ sections: [
    { title: "Connected", blocks: [
      { kind: "fields", rows: [["Space", r.space], ...(r.instanceId ? [["Instance", r.instanceId] as [string, string]] : []), ...(r.unit ? [["Unit", r.unit] as [string, string]] : [])] },
      { kind: "lines", lines: [
        ...r.steps.map((s) => ({ text: `${s.step}: ${s.outcome}`, tone: "hint" as const })),
        { text: "The daemon runs as a user service, restarts on its own and reconnects after a restart. Read it with `cotal daemon service-status`, and close the connection with `cotal daemon service-disconnect`.", tone: "hint" as const },
      ] },
    ] },
  ] }));
}

async function serve(args: ParsedArgs): Promise<void> {
  const { paths, home } = resolveTarget(args);
  let running;
  try {
    running = await serveDaemon({ paths, version: binVersion(), peerUid, log: (l) => process.stderr.write(`${l}\n`), ...(home !== undefined ? { sessionDir: home } : {}) });
  } catch (e) {
    throw asFailure(e);
  }
  process.stdout.write(`daemon ready at ${running.paths.socket}\n`);
  await new Promise<void>((resolve) => {
    const stop = () => void running.close().then(resolve, resolve);
    process.once("SIGTERM", stop);
    process.once("SIGINT", stop);
  });
}

async function run(args: ParsedArgs): Promise<void> {
  const [mode, ...rest] = args.positionals;
  if (rest.length) throw new CommandFailure("refused", "USAGE_INVALID", `cotal daemon ${mode} takes no positionals`);
  if (mode === "status") return status(args);
  if (mode === "serve") return serve(args);
  if (mode === "login") return login(args);
  if (mode === "connect-check") return connectCheckCommand(args);
  if (mode === "register") return registerCommand(args);
  if (mode === "service-connect" || mode === "service-disconnect" || mode === "service-status") return serviceCommand(args, mode);
  if (mode === "install" || mode === "uninstall") return unitCommand(args, mode);
  if (mode === "setup") return setupCommand(args);
  throw new CommandFailure("refused", "USAGE_INVALID", mode === undefined ? "cotal daemon needs a mode: setup, status, serve, install, uninstall, login, connect-check, register, service-connect, service-disconnect or service-status" : `unknown daemon mode ${JSON.stringify(mode)}`, { remedy: "cotal daemon status" });
}

const daemonCommand: Command = {
  kind: "command",
  name: "daemon",
  group: "Manager",
  summary: "the local machine daemon (Linux): connect this machine to a space with one command, install it as a user service, serve its control endpoint, read its status, sign it in, check and request its own registration with a space, and connect it as its own service",
  positionals: "<setup|status|serve|install|uninstall|login|connect-check|register|service-connect|service-disconnect|service-status>",
  flags: daemonFlags,
  subcommands: [
    { name: "setup", summary: "connect this machine to a space with one command: install the user service, sign in by device code without a local browser, register, and connect once the space owner approves", examples: [{ command: "cotal daemon setup --space <space> --idp <url>", note: "connect a headless machine" }, { command: "cotal daemon setup --space <space> --wait 0", note: "report what it reached without waiting for approval" }], flagNames: ["space", "idp", "client-id", "wait", "daemon-home", "json", "plain"], outputs: ["json", "plain"], prepareMeshTarget: false },
    { name: "status", summary: "ask the running daemon for its status over the local endpoint", examples: [{ command: "cotal daemon status", note: "ask the running daemon for its status" }, { command: "cotal daemon status --json", note: "the same as one JSON document" }], flagNames: ["daemon-home", "json", "plain"], outputs: ["json", "plain"], reads: true, prepareMeshTarget: false },
    { name: "serve", summary: "run the daemon in the foreground and serve its local endpoint (refusals honor --json)", examples: [{ command: "cotal daemon serve", note: "run the machine daemon in this terminal" }], flagNames: ["daemon-home", "json", "plain"], outputs: ["json", "plain"], prepareMeshTarget: false },
    { name: "install", summary: "install the daemon as a systemd user service that starts at login, restarts on its own and survives logout", examples: [{ command: "cotal daemon install", note: "run it as a persistent user service" }, { command: "cotal daemon install --dry-run", note: "show the unit it would write" }], flagNames: ["daemon-home", "dry-run", "json", "plain"], outputs: ["json", "plain"], prepareMeshTarget: false },
    { name: "uninstall", summary: "stop the daemon's user service, disable autostart and remove its unit", examples: [{ command: "cotal daemon uninstall", note: "remove its login unit" }], flagNames: ["daemon-home", "yes", "dry-run", "json", "plain"], outputs: ["json", "plain"], prepareMeshTarget: false },
    { name: "login", summary: "sign the running daemon in to a provider with device approval; the daemon keeps the session", examples: [{ command: "cotal daemon login --idp <url>", note: "sign the daemon in with device approval" }], flagNames: ["idp", "client-id", "daemon-home", "json", "plain"], outputs: ["json", "plain"], prepareMeshTarget: false },
    { name: "connect-check", summary: "ask the running daemon whether it could register with a space as its own service; registers nothing", examples: [{ command: "cotal daemon connect-check --space <space>", note: "check whether it could register" }], flagNames: ["space", "daemon-home", "json", "plain"], outputs: ["json", "plain"], reads: true, prepareMeshTarget: false },
    { name: "register", summary: "ask the running daemon to request its own service registration with a space; the space owner must approve it, and it does not connect", examples: [{ command: "cotal daemon register --space <space>", note: "ask a space to approve it as a service" }], flagNames: ["space", "daemon-home", "json", "plain"], outputs: ["json", "plain"], prepareMeshTarget: false },
    { name: "service-connect", summary: "connect the running daemon to a space as its own approved service; succeeds only when the broker accepts the connection and the space accepts it as ready", examples: [{ command: "cotal daemon service-connect --space <space>", note: "connect it to a space" }], flagNames: ["space", "daemon-home", "json", "plain"], outputs: ["json", "plain"], prepareMeshTarget: false },
    { name: "service-disconnect", summary: "close the running daemon's service connection to a space", examples: [{ command: "cotal daemon service-disconnect --space <space>", note: "close its service connection to a space" }], flagNames: ["space", "daemon-home", "json", "plain"], outputs: ["json", "plain"], prepareMeshTarget: false },
    { name: "service-status", summary: "read the running daemon's service connection to a space, without contacting it", examples: [{ command: "cotal daemon service-status --space <space>", note: "read the state of that connection" }], flagNames: ["space", "daemon-home", "json", "plain"], outputs: ["json", "plain"], reads: true, prepareMeshTarget: false },
  ],
  prepareMeshTarget: false,
  examples: [{ command: "cotal daemon setup --space <space> --idp <url>", note: "connect a headless machine to a space" }, { command: "cotal daemon install", note: "run the machine daemon as a persistent user service" }, { command: "cotal daemon status", note: "ask the running daemon for its status" }],
  run,
};

registry.register(daemonCommand);
