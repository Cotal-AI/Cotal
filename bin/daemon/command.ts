/**
 * `cotal daemon`: the local machine daemon's control surface, composed in this binary rather than
 * in an `implementations/*` package so it can later wire `@cotal-ai/auth` and `@cotal-ai/manager`
 * without one implementation importing another (AGENTS.md, repository map).
 *
 * This serves a local authenticated endpoint for status, sign-in, connection checks and registration.
 * The daemon hosts a stock Manager per requested space in a separate child process, and
 * serves its registered machine-status command. Sign-in runs inside the
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
import { CommandFailure, codeSpan, homeCotalDir, keptCatalogCredentials, jsonFlag, plainFlag, presentationOf, recordOperationContext, renderReport, writeResult, type Report } from "@cotal-ai/workspace";
import { openLoginBrowser, isDiscoveryName, resolveDiscoveryLogin } from "@cotal-ai/workspace";
import { chooseAccountChoice, IdpConfigurationError, normalizeIdpUrl } from "@cotal-ai/auth";
import { EndpointRefusal, defaultPeerUid, defaultPeerPid, checkDir, daemonPaths, daemonPathsFor, type DaemonPaths, type EndpointProblemCode } from "./endpoint.js";
import { serveDaemon } from "./server.js";
import { loginFromCli } from "./cli-login.js";
import { connectCheckViaDaemon, managerViaDaemon, queryDaemon, registerViaDaemon, serviceViaDaemon } from "./client.js";
import { admitWindowsNativeDaemon, applyInstall, applyUninstall, observeDaemonOwnedService, type DaemonOwnershipObservation, planInstall, planUninstall, startInstalled } from "./install.js";
import { exchangeDesktopRequest, runDesktopBridge } from "./desktop.js";
import { runAccountSetup, runSetup } from "./setup.js";
import { daemonCommandCopy } from "./guidance.js";
import { forgetHostedManagerIntents } from "./manager.js";
import { automaticUpdates } from "./auto-update.js";
import { watchDaemonGeneration } from "./generation.js";
import { SPACE_PATTERN } from "./protocol.js";
import { nativeDaemonLog } from "./native-log.js";
import type { ConnectCheckResult, DaemonStatus, RegisterResult, ServiceConnectionResult } from "./protocol.js";

export const daemonFlags = [
  jsonFlag,
  plainFlag,
  { name: "cloud", type: "boolean", description: "sign in to Cotal Cloud" },
  { name: "no-browser", type: "boolean", description: "print approval instructions without opening a browser" },
  { name: "idp", type: "string", value: "<auth URL or name>", description: "the provider's auth base URL or issuer-authorized discovery hostname" },
  { name: "client-id", type: "string", value: "<id>", description: "the OAuth device-flow client id" },
  { name: "daemon-home", type: "string", value: "<abs dir>", completion: "files", description: "run or reach the daemon whose state lives in this directory (absolute, yours, mode 0700, not the Cotal home): its own sign-in, identity and registration, its own socket and lifetime lock. Without it, run or reach the default daemon, whose state lives in the Cotal home." },
  { name: "refresh", type: "boolean", description: "spaces: refresh catalogs through the daemon-held sign-in" },
  { name: "dry-run", type: "boolean", description: "install, uninstall: report the unit it would write or remove, and change nothing" },
  { name: "yes", type: "boolean", short: "y", description: "uninstall: confirm in a script" },
  { name: "wait", type: "string", value: "<seconds>", description: "setup --no-manager only: how long to wait for machine approval (default 900, 0 reports what it reached)" },
  { name: "no-manager", type: "boolean", description: "setup: connect only the machine service without hosting a Manager" },
  { name: "space", short: "s", type: "string", value: "<s>", description: "target space (required except for status, where it selects one hosted Manager)" },
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

const peerUid = defaultPeerUid;
const peerPid = defaultPeerPid;

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
  NO_RUNTIME_DIR: { code: "TARGET_UNAVAILABLE", remedy: "run as the intended operating-system user with its private runtime directory available" },
  NOT_RUNNING: { code: "TARGET_UNAVAILABLE", remedy: "start it with `cotal daemon serve`" },
  ALREADY_RUNNING: { code: "CONFLICT", remedy: "run `cotal daemon status` for the same daemon home; inspect the conflicting endpoint with your operating system before changing it. No foreign endpoint was removed" },
  DIR_NOT_DIRECTORY: { code: "PERMISSION_DENIED", remedy: "inspect the path; nothing was changed" },
  DIR_SYMLINK: { code: "PERMISSION_DENIED", remedy: "inspect the path; nothing was changed" },
  DIR_WRONG_OWNER: { code: "PERMISSION_DENIED", remedy: "inspect the path; nothing was changed" },
  DIR_WRONG_MODE: { code: "PERMISSION_DENIED", remedy: "inspect the directory; the daemon never changes the mode of an existing directory" },
  SOCKET_NOT_SOCKET: { code: "PERMISSION_DENIED", remedy: "inspect the path; nothing was removed" },
  SOCKET_WRONG_OWNER: { code: "PERMISSION_DENIED", remedy: "inspect the path; nothing was removed" },
  SOCKET_WRONG_MODE: { code: "PERMISSION_DENIED", remedy: "inspect the endpoint owner and protection with your operating system; its permissions differ from the daemon contract and were not repaired" },
  PEER_UID_MISMATCH: { code: "PERMISSION_DENIED", remedy: "another user's process holds the daemon endpoint; nothing was sent" },
  PEER_NOT_LOCK_OWNER: { code: "PERMISSION_DENIED", remedy: "inspect the conflicting listener with your operating system. For the default daemon use its COTAL_HOME. For an explicit --daemon-home use the same directory as the intended daemon. No process was stopped" },
  LOCK_HELD: { code: "CONFLICT", remedy: "a daemon already holds this lifetime lock; run `cotal daemon status`, with the same --daemon-home when you passed one" },
};

function asFailure(e: unknown): unknown {
  if (e instanceof IdpConfigurationError) return new CommandFailure("refused", "USAGE_INVALID", e.message, { remedy: "correct COTAL_IDP_TIMEOUT_MS in the daemon environment before starting it again" });
  if (!(e instanceof EndpointRefusal)) return e;
  const r = REFUSAL[e.code];
  const remedy = e.remedy ?? r.remedy;
  return new CommandFailure("refused", r.code, e.message, { ...(remedy ? { remedy } : {}), native: { code: e.code } });
}

function capacityText(total: number, free: number): string {
  const gib = (value: number) => (value / 1024 ** 3).toFixed(1);
  const used = total === 0 ? 0 : 100 * (total - free) / total;
  return `${gib(free)} GiB free / ${gib(total)} GiB total (${used.toFixed(1)}% used)`;
}
function uptimeText(seconds: number): string {
  return `${Math.floor(seconds / 86400)} days ${Math.floor(seconds % 86400 / 3600)} hours`;
}
function statusView(s: DaemonStatus): Report {
  return { sections: [{ title: "Daemon", blocks: [{ kind: "fields", rows: [["State", s.state], ["Version", s.version], ["Protocol", String(s.protocol)], ["PID", String(s.pid)], ["Started", s.startedAt], ["Uptime", `${Math.round(s.uptimeMs / 1000)}s`]] }, ...(s.computerNameWarning ? [{ kind: "lines" as const, lines: [s.computerNameWarning] }] : []), ...(s.generation ? [{ kind: "lines" as const, lines: [`Installed ${s.generation.installed}, running ${s.generation.running}, ${s.generation.waiting}`] }] : [])] },
    ...(s.vitals ? [{ title: "Computer vitals", blocks: [{ kind: "fields" as const, rows: [["Sampled", s.vitals.sampledAt], ["CPU", `${s.vitals.cpu.logicalCount} logical, ${s.vitals.cpu.utilisationPercent.toFixed(1)}% over ${s.vitals.cpu.intervalMs}ms`], ...(s.vitals.cpu.load1 !== undefined ? [["Load (1/5/15m)", `${s.vitals.cpu.load1} / ${s.vitals.cpu.load5} / ${s.vitals.cpu.load15}`]] : []), ["Memory", capacityText(s.vitals.memory.totalBytes, s.vitals.memory.availableBytes)], ["System uptime", uptimeText(s.vitals.uptimeSeconds)], ...s.vitals.filesystems.map(fs => [fs.mount, capacityText(fs.totalBytes, fs.freeBytes)])] as [string, string][] }] }] : []),
    ...(s.vitalsError ? [{ title: "Computer vitals error", blocks: [{ kind: "lines" as const, lines: [s.vitalsError] }] }] : []),
    ...(s.update ? [{ title: "Updates", blocks: [{ kind: "fields" as const, rows: [["Current", s.update.current], ["Latest seen", s.update.latest ?? "unknown"], ["Last check", s.update.lastCheck ?? "not checked"], ["Automatic updates", s.update.automatic ? "on" : "off"], ["Last result", s.update.lastResult], ["Failures", String(s.update.failures)], ["Next attempt", s.update.nextAttempt ?? "none"]] as [string, string][] }] }] : []),
    ...(s.account ? (s.account.accounts?.length ? s.account.accounts : [s.account]).map(account => ({ title: `Account computer${account.machineId ? `: ${account.machineId}` : ""}`, blocks: [{ kind: "fields" as const, rows: [["Computer", account.machineId ?? "not registered"], ["Mode", account.mode], ["Host support", account.hostSupport], ["Last registration", account.lastRegistration ?? "none"], ["Desired revision", String(account.desiredRevision ?? "unknown")], ...(account.message ? [["Next", account.message]] : []), ...(account.spaces.some(space => space.lastRefusal === "no available application") ? [["Next", `Install an agent application, then run \`cotal daemon setup${(s.account?.accounts?.length ?? 0) > 1 && account.idpUrl ? ` --idp ${account.idpUrl}` : ""}\` again in a terminal that finds it.`]] : []), ...account.spaces.map((space) => [space.space, `${space.desired ? "desired" : "connected here, not in the account's list"}: ${space.observed}${space.lastRefusal ? ` (${space.lastRefusal})` : ""}${space.machineService === "approval-pending" ? "; machine status service waits for the space owner's approval" : space.machineService ? `; machine status service ${space.machineService}` : ""}`])] as [string, string][] }] })) : []),
    ...(s.agents ?? []).map(inventory => ({ title: `Agents: ${inventory.space}`, blocks: inventory.state === "unreadable"
      ? [{ kind: "lines" as const, lines: [inventory.message] }]
      : inventory.agents.length ? inventory.agents.map(agent => ({ kind: "fields" as const, rows: [["Name", agent.name], ["Application", agent.application], ["Model", agent.model ?? "not pinned"], ["Space", inventory.space], ["Folder", agent.cwd], ["Started", agent.startedAt], ["State", agent.state]] as [string, string][] }))
        : [{ kind: "lines" as const, lines: ["No agents running. Start agents from the dashboard."] }] })),
    ...(s.managers ?? []).map((manager) => ({ title: `Manager: ${manager.space}`, blocks: [{ kind: "fields" as const, rows: [["Last observed state", manager.state], ["Observed at", manager.observedAt ?? "not yet probed"], ["Instance", manager.instanceId ?? "not registered"], ["PID", String(manager.pid ?? "none")], ["Restarts", String(manager.restarts)], ...(manager.registrationCleanup ? [["Registration cleanup", manager.registrationCleanup]] : []), ...(manager.lastStop ? [["Last stop", manager.lastStop]] : []), ...(manager.lastExit ? [["Last exit", manager.lastExit]] : []), ...(manager.logError ? [["Log error", manager.logError]] : []), ...(manager.lastRefusal || manager.reason ? [["Last refusal", manager.lastRefusal ?? manager.reason!]] : []), ...(manager.next ? [["Next", manager.next]] : [])] as [string, string][] }] })),
  ] };
}

async function status(args: ParsedArgs): Promise<void> {
  const presentation = presentationOf(args.values);
  const { paths, home } = resolveTarget(args);
  let reply;
  try {
    reply = await queryDaemon({ paths, peerUid, peerPid });
  } catch (e) {
    if (process.platform === "win32" && e instanceof EndpointRefusal && e.code === "NOT_RUNNING") {
      throw new CommandFailure("refused", "TARGET_UNAVAILABLE", e.message, {
        remedy: `start the owned task with ${daemonCommandCopy("start", home)}; read ${nativeDaemonLog(paths.state)} for its last launch output, and inspect the task's state and last result in Task Scheduler if no log was created`,
        native: { code: e.code },
      });
    }
    throw asFailure(e);
  }
  if (!reply.ok) throw new CommandFailure("failed", "OPERATION_FAILED", `the daemon refused the status request: ${reply.error.code} ${reply.error.message}`);
  const space = (args.values as { space?: string }).space;
  const result = space ? { ...reply.result, agents: reply.result.agents?.filter(row => row.space === space), managers: [await managerViaDaemon({ paths, peerUid, peerPid }, { op: "manager-status", space }) as import("./protocol.js").HostedManager] } : reply.result;
  writeResult(presentation, { command: "daemon status", target: space ? { space } : null, result }, statusView);
}

/** Select the provider before approval or native setup effects. */
async function daemonAccountChoice(args: ParsedArgs) {
  if (args.values.cloud && args.values.idp !== undefined) throw new CommandFailure("refused", "USAGE_INVALID", "--cloud and --idp cannot be combined");
  const idp = args.values.idp;
  if (typeof idp === "string" && isDiscoveryName(idp)) {
    const discoveryPins = await resolveDiscoveryLogin(idp);
    return { url: discoveryPins.url, discoveryPins };
  }
  return chooseAccountChoice({ ...args, positionals: [] }, "login");
}

/** Sign in through the daemon, which retains the session. Cancellation waits for its answer. */
async function login(args: ParsedArgs): Promise<void> {
  const presentation = presentationOf(args.values);
  const values = args.values as { idp?: string; "client-id"?: string };
  const chosen = await daemonAccountChoice(args);
  if (chosen === undefined) return;
  let idp: string;
  try { idp = normalizeIdpUrl(chosen.url); }
  catch { throw new CommandFailure("refused", "USAGE_INVALID", "use an HTTPS provider auth URL, or an HTTP loopback IP URL, without embedded credentials, a query or a fragment"); }
  recordOperationContext({ target: { idp } });
  if (values["client-id"] !== undefined && !values["client-id"].trim()) throw new CommandFailure("refused", "USAGE_INVALID", "--client-id cannot be empty");
  const { paths } = resolveTarget(args);
  let reply;
  try {
    reply = await loginFromCli({
      paths, peerUid, peerPid, idp, discoveryPins: chosen.discoveryPins,
      ...(values["client-id"] !== undefined ? { clientId: values["client-id"] } : {}),
      onPrompt: (p) => {
        process.stderr.write(`${renderReport({ sections: [{ title: "Approve sign-in", blocks: [
          { kind: "fields", rows: [["Provider", idp], ["Open", p.verificationUriComplete], ["Or open", p.verificationUri], ["Approval code", p.userCode], ["Expires", p.expiresAt]] },
          { kind: "lines", lines: [{ text: "Waiting for the provider's approval. The daemon keeps the session. Ctrl-C cancels this sign-in on this machine. Do not share the approval link or code.", tone: "hint" }] },
        ] }] }, presentation === "plain" ? "plain" : "rich", process.stderr)}\n`);
        openLoginBrowser(p.verificationUriComplete, args.values);
      },
    });
  } catch (e) {
    throw asFailure(e);
  }
  if (!reply.ok) {
    if (reply.code === "LOGIN_IN_PROGRESS") throw new CommandFailure("refused", "CONFLICT", reply.message, { native: { code: reply.code } });
    throw new CommandFailure("failed", "OPERATION_FAILED", `the daemon refused the sign-in: ${reply.code} ${reply.message}`, { native: { code: reply.code } });
  }
  const r = reply.result;
  if (r.outcome === "failed") {
    if (r.reason === "local-state-error") throw new CommandFailure("refused", "DEPENDENCY_UNAVAILABLE", r.message, { native: { code: r.reason.toUpperCase() }, remedy: r.remedy });
    const native = { native: { code: r.reason.toUpperCase().replaceAll("-", "_") } };
    // Typed provider refusals end before stock writes anything, at the provider's
    // boundary. Any other failure can come after stock saved the session, so it claims nothing about
    // what was saved; `cotal daemon login` again replaces whatever is there.
    if (r.reason === "unreachable" || r.reason === "authorization-refused") throw new CommandFailure("refused", "DEPENDENCY_UNAVAILABLE", `${r.message}; no session was saved`, native);
    if (r.reason === "denied" || r.reason === "expired") throw new CommandFailure("refused", "PERMISSION_DENIED", `${r.message}; no session was saved`, native);
    throw new CommandFailure("failed", "OPERATION_FAILED", `${r.message}; a session may have been saved before the failure, so sign in again`, native);
  }
  // The switch is done; a credential file it could not delete leaves the run partial.
  const partial = r.credentialsKept?.length ? keptCatalogCredentials(r.credentialsKept) : undefined;
  writeResult(presentation, { command: "daemon login", target: { idp }, result: { attempt: reply.attempt, ...r }, ...(partial ? { partial } : {}) }, () => ({ sections: [
    { title: "Signed in", blocks: [{ kind: "fields", rows: [["Account", r.label || r.sub], ["Subject", r.sub], ["Provider", r.idp]] }, { kind: "lines", lines: [...(r.previousSub ? [`Replaced account: ${r.previousSub}`] : []), { text: "The daemon holds this session in the machine's Cotal home. No session token is printed. Each space's grants decide access separately.", tone: "hint" }] }] },
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
  const native = { native: { code: r.outcome.toUpperCase().replaceAll("-", "_") }, ...("remedy" in r ? { remedy: r.remedy } : {}) };
  if (r.outcome === "not-registered") throw new CommandFailure("refused", "TARGET_NOT_FOUND", r.message, native);
  if (r.outcome === "not-user-auth" || r.outcome === "unsupported-by-space") throw new CommandFailure("refused", "UNSUPPORTED", r.message, native);
  if (r.outcome === "not-signed-in") throw new CommandFailure("refused", "AUTH_REQUIRED", r.message, native);
  if (r.outcome === "credential-expired") throw new CommandFailure("refused", "LIFECYCLE_BLOCKED", r.message, native);
  if (r.outcome === "unreachable") throw new CommandFailure("refused", "DEPENDENCY_UNAVAILABLE", r.message, native);
  if (r.outcome === "account-mismatch" || r.outcome === "local-state-error") throw new CommandFailure("refused", "CONFLICT", r.message, native);
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
  const native = { native: { code: (r.outcome === "refused" && "reason" in r ? r.reason : r.outcome).toUpperCase().replaceAll("-", "_") }, ...("remedy" in r ? { remedy: r.remedy } : {}) };
  if (r.outcome === "not-registered") throw new CommandFailure("refused", "TARGET_NOT_FOUND", r.message, native);
  if (r.outcome === "not-user-auth" || r.outcome === "unsupported-by-space") throw new CommandFailure("refused", "UNSUPPORTED", r.message, native);
  if (r.outcome === "not-signed-in") throw new CommandFailure("refused", "AUTH_REQUIRED", r.message, native);
  if (r.outcome === "credential-expired") throw new CommandFailure("refused", "LIFECYCLE_BLOCKED", r.message, native);
  if (r.outcome === "unreachable") throw new CommandFailure("refused", "DEPENDENCY_UNAVAILABLE", r.message, native);
  if (r.outcome === "account-mismatch" || r.outcome === "conflict" || r.outcome === "local-state-error") throw new CommandFailure("refused", "CONFLICT", r.message, native);
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
  const ok = op === "service-status" && r.manager && r.manager.state !== "stopped"
    ? r.manager.state === "answering"
    : r.state === "connected" || (op === "service-disconnect" && r.state === "disconnected");
  if (!ok) {
    const code = r.state === "not-requested" || r.state === "not-registered" ? "TARGET_NOT_FOUND"
      : r.state === "unsupported" ? "UNSUPPORTED"
      : r.state === "not-signed-in" ? "AUTH_REQUIRED"
      : r.state === "refused" || r.state === "ended" || r.state === "credential-not-yet-valid" ? "PERMISSION_DENIED"
      : r.state === "account-mismatch" || r.state === "conflict" || r.state === "local-state-error" ? "CONFLICT"
      : r.state === "approval-pending" || r.state === "connecting" || r.state === "credential-expired" ? "LIFECYCLE_BLOCKED"
      : r.state === "disconnected" ? "TARGET_UNAVAILABLE"
      : "DEPENDENCY_UNAVAILABLE";
    const remedy = r.remedy ?? r.manager?.next;
    throw new CommandFailure("refused", code, `${r.message}${r.manager ? `; Manager ${r.manager.state}${r.manager.reason ? `: ${r.manager.reason}` : ""}` : ""}`, { ...native, ...(remedy ? { remedy } : {}) });
  }
  writeResult(presentation, { command: `daemon ${op}`, target: { space }, result: r }, () => ({ sections: [
    { title: "Machine service and Manager", blocks: [
      { kind: "fields", rows: [["Space", r.space], ["Machine service", r.state], ...(r.instanceId ? [["Instance", r.instanceId] as [string, string]] : []), ...(r.manager ? [["Manager", r.manager.state], ["Manager instance", r.manager.instanceId ?? "none"], ...(r.manager.reason ? [["Refusal", r.manager.reason]] : []), ...(r.manager.next ? [["Next", r.manager.next]] : [])] as [string, string][] : [])] },
      { kind: "lines", lines: [{ text: r.message, tone: "hint" }] },
    ] },
  ] }));
}

/** Install or remove the daemon's platform user service. Both forms report the exact unit. */
async function unitCommand(args: ParsedArgs, op: "install" | "uninstall"): Promise<void> {
  const presentation = presentationOf(args.values);
  const values = args.values as { "dry-run"?: boolean; yes?: boolean };
  const { paths, home } = resolveTarget(args);
  if (op === "install") {
    const dry = values["dry-run"] === true;
    const r = dry ? { ...planInstall(paths, home), state: "would-install" as const } : applyInstall(paths, home);
    writeResult(presentation, { command: "daemon install", target: { unit: r.unit }, result: r }, () => ({ sections: [
      { title: dry ? "Would install" : "Installed", blocks: [
        { kind: "fields", rows: [["Unit", r.unit], ["Path", r.unitPath], ["Digest", r.sha256], ["User", r.user], ...(r.mechanism === "systemd-user" ? [["Linger", r.lingerAlready ? "already enabled" : dry ? "would be enabled" : "enabled by this install"] as [string, string]] : []), ["Restart", r.restart], ["Started by", r.wantedBy], ...(r.daemonHome ? [["Daemon home", r.daemonHome] as [string, string]] : [])] },
        { kind: "lines", lines: [{ text: dry
          ? "Nothing was written, enabled or started."
          : `${r.mechanism === "systemd-user" ? "It starts at login, restarts on its own, and keeps running after you log out." : "It starts at login and recovers after an exit while you are signed in."} Read it with ${codeSpan(daemonCommandCopy("status", home))}, and remove it with ${codeSpan(daemonCommandCopy("uninstall", home))}.`, tone: "hint" }] },
      ] },
    ] }));
    return;
  }
  const dry = values["dry-run"] === true;
  if (!dry && values.yes !== true && !process.stdout.isTTY) throw new CommandFailure("refused", "USAGE_INVALID", "cotal daemon uninstall needs --yes outside a terminal; nothing was removed");
  if (!dry) {
    planUninstall(paths, home);
  }
  const r = dry ? { ...planUninstall(paths, home), state: "would-remove" as const } : await applyUninstall(paths, home);
  if (!dry) forgetHostedManagerIntents(home ?? homeCotalDir());
  writeResult(presentation, { command: "daemon uninstall", target: { unit: r.unit }, result: r }, () => ({ sections: [
    { title: dry ? "Would remove" : "Removed", blocks: [
      { kind: "fields", rows: [["Unit", r.unit], ["Path", r.unitPath], ["Installed", r.installedAt]] },
      { kind: "lines", lines: [{ text: dry
        ? "Nothing was stopped, disabled or removed."
        : r.mechanism === "systemd-user" ? "The daemon is stopped and will not start at login. Linger is left enabled, because other user services may rely on it." : "The owned daemon job is stopped and will not start at login. Other user services were not changed.", tone: "hint" },
        ...("removedServiceRecords" in r ? [{ text: `Removed local service credentials and identity records: ${r.removedServiceRecords.length ? r.removedServiceRecords.join(", ") : "none remained"}. Remote records may remain; remove the computer in the dashboard to revoke its authority.`, tone: "hint" as const }] : [])] },
    ] },
  ] }));
}

/** Connect a headless machine with one command: install, sign in, register, connect. */
async function setupCommand(args: ParsedArgs): Promise<void> {
  const { claimUpdateClosureAccess } = await import("@cotal-ai/workspace");
  const release = claimUpdateClosureAccess();
  try { await setupUnderClosure(args); }
  finally { release(); }
}

async function setupUnderClosure(args: ParsedArgs): Promise<void> {
  const presentation = presentationOf(args.values);
  const values = args.values as { space?: string; idp?: string; "client-id"?: string; wait?: string; "no-manager"?: boolean };
  const space = values.space;
  if (!space && (values["no-manager"] || values.wait !== undefined)) throw new CommandFailure("refused", "USAGE_INVALID", "--no-manager and --wait require --space <s>");
  if (space && !SPACE_PATTERN.test(space)) throw new CommandFailure("refused", "USAGE_INVALID", "space must be 1-64 characters of [A-Za-z0-9_-]", { native: { code: "BAD_FIELD" } });
  if (args.values.cloud && values.idp !== undefined) throw new CommandFailure("refused", "USAGE_INVALID", "--cloud and --idp cannot be combined");
  let choice = values.idp !== undefined || args.values.cloud === true ? await daemonAccountChoice(args) : undefined;
  let idp = choice?.url;
  if (values["client-id"] !== undefined && !values["client-id"].trim()) throw new CommandFailure("refused", "USAGE_INVALID", "--client-id cannot be empty");
  const waitSeconds = values.wait === undefined ? 900 : Number(values.wait);
  if (!Number.isInteger(waitSeconds) || waitSeconds < 0 || waitSeconds > 86400) throw new CommandFailure("refused", "USAGE_INVALID", "--wait takes whole seconds from 0 to 86400");
  if (values.wait !== undefined && values["no-manager"] !== true) throw new CommandFailure("refused", "USAGE_INVALID", "--wait requires --no-manager; Manager setup never waits for machine approval");
  const { paths, home } = resolveTarget(args);
  let newSignIn = values.idp !== undefined || args.values.cloud === true;
  if (!space && !idp) {
    let installed = true;
    try { planUninstall(paths, home); } catch { installed = false; }
    if (!installed) {
      choice = await daemonAccountChoice(args);
      idp = choice?.url;
      if (idp === undefined) return;
      newSignIn = true;
    }
  }
  const plain = presentation === "plain";
  // Progress goes to stderr so a --json caller still reads one document on stdout.
  const report = (line: string) => { process.stderr.write(`${line}\n`); };
  if (!space) {
    if (!idp) {
      try { planUninstall(paths, home); }
      catch { throw new CommandFailure("refused", "USAGE_INVALID", "No daemon is installed; pass --idp <url> to connect an account"); }
      let discovery;
      try { discovery = await exchangeDesktopRequest({ paths, peerUid, peerPid }, { op: "spaces", refresh: true }); }
      catch { throw new CommandFailure("refused", "AUTH_REQUIRED", "The daemon cannot report its sign-in; pass --idp <url> to connect an account"); }
      if (!discovery.ok || "event" in discovery || !("signedInProviders" in discovery.result)) throw new CommandFailure("refused", "AUTH_REQUIRED", "The daemon cannot report its sign-in; pass --idp <url> to connect an account");
      const providers = discovery.result.signedInProviders ?? [];
      if (!providers.length) throw new CommandFailure("refused", "AUTH_REQUIRED", "The daemon is not signed in; pass --idp <url> to connect an account");
      if (providers.length !== 1) throw new CommandFailure("refused", "USAGE_INVALID", `The daemon is signed in to several providers (${providers.join(", ")}); pass --idp <url> to choose one`);
      idp = providers[0]!;
    }
    const r = await runAccountSetup({ paths, daemonHome: home, peerUid, peerPid, report, version: binVersion(), idp: idp!, discoveryPins: choice?.discoveryPins, existingSignInOnly: !newSignIn,
      ...(values["client-id"] !== undefined ? { clientId: values["client-id"] } : {}),
      onPrompt: p => { process.stderr.write(`Approve this machine\nOpen: ${p.verificationUriComplete}\nApproval code: ${p.userCode}\n`); openLoginBrowser(p.verificationUriComplete, args.values); },
    });
    writeResult(presentation, { command: "daemon setup", target: { idp: idp! }, result: r }, () => ({ sections: [
      { title: "Connected to your account", blocks: [{ kind: "fields", rows: [["Account", r.label || "Signed in"], ["Computer", r.computer]] },
        { kind: "lines", lines: [r.spaces.length ? `Spaces using this computer: ${r.spaces.join(", ")}` : "Turn on the spaces that can use this computer in the dashboard."] }] },
    ] }));
    return;
  }
  let r;
  try {
    r = await runSetup({
      paths, daemonHome: home, space, peerUid, peerPid, waitSeconds, report, version: binVersion(), noManager: values["no-manager"] === true,
      ...(idp !== undefined ? { idp } : {}),
      discoveryPins: choice?.discoveryPins,
      ...(values["client-id"] !== undefined ? { clientId: values["client-id"] } : {}),
      onPrompt: (p) => {
        process.stderr.write(`${renderReport({ sections: [{ title: "Approve this machine", blocks: [
          { kind: "fields", rows: [["Provider", idp!], ["Open", p.verificationUriComplete], ["Or open", p.verificationUri], ["Approval code", p.userCode], ["Expires", p.expiresAt]] },
          { kind: "lines", lines: [{ text: "Open that link on any device with a browser. This machine needs none. Do not share the approval link or code.", tone: "hint" }] },
        ] }] }, plain ? "plain" : "rich", process.stderr)}\n`);
        openLoginBrowser(p.verificationUriComplete, args.values);
      },
    });
  } catch (e) {
    throw asFailure(e);
  }
  writeResult(presentation, { command: "daemon setup", target: { space }, result: r }, () => ({ sections: [
    { title: r.manager?.state === "answering" ? "Ready to launch" : "Connected", blocks: [
      { kind: "fields", rows: [["Space", r.space], ...(r.manager?.instanceId ? [["Manager instance", r.manager.instanceId] as [string, string]] : []), ...(r.instanceId ? [["Instance", r.instanceId] as [string, string]] : []), ...(r.unit ? [["Unit", r.unit] as [string, string]] : [])] },
      { kind: "lines", lines: [
        ...r.steps.map((s) => ({ text: `${s.step}: ${s.outcome}`, tone: "hint" as const })),
        ...(r.manager ? [{ text: `Agents can now be launched on this computer from space ${r.space} through Manager instance ${r.manager.instanceId}.`, tone: "hint" as const }, { text: `Machine service: ${r.state}.`, tone: "hint" as const }] : []),
        { text: `The daemon runs as a user service, restarts on its own and reconnects after a restart. Read it with ${codeSpan(daemonCommandCopy("service-status", home, [["--space", space]]))}, and close the connection with ${codeSpan(daemonCommandCopy("service-disconnect", home, [["--space", space]]))}.`, tone: "hint" as const },
      ] },
    ] },
  ] }));
}

async function serve(args: ParsedArgs): Promise<void> {
  const { recoverInterruptedUpdate } = await import("@cotal-ai/cli/update");
  // Unusable abandoned records retire under the updater lock. Unknown owners remain paused
  // without blocking startup. A valid snapshot whose restoration failed still waits for repair.
  let automaticCustodyPaused = false;
  if (process.platform === "win32") {
    const { cleanWindowsUpdate } = await import("./update-windows.js");
    const disposition = cleanWindowsUpdate();
    automaticCustodyPaused = disposition === "paused" || disposition === "pending";
  }
  if (!automaticCustodyPaused && await recoverInterruptedUpdate(undefined, true)) throw new Error("interrupted update restored the previous installation; restart the daemon with the restored CLI");
  const { paths, home } = resolveTarget(args);
  let running;
  let updates: ReturnType<typeof automaticUpdates> | undefined;
  let owned = false;
  let provenance = new AbortController();
  const loggedReasons = new Set<string>();
  const observe = async (): Promise<DaemonOwnershipObservation> => {
    const result = await observeDaemonOwnedService(paths, home, provenance.signal).catch(() => ({ state: "unknown", reason: "worker-failed" } as const));
    if (result.state === "owned") owned = true;
    if (!loggedReasons.has(result.reason)) {
      loggedReasons.add(result.reason);
      process.stderr.write(`daemon: native ownership ${result.state}: ${result.reason}\n`);
    }
    return result;
  };
  let stopObservation: Promise<DaemonOwnershipObservation> | undefined;
  const stopAllowed = (): Promise<DaemonOwnershipObservation> => {
    if (owned) return Promise.resolve({ state: "owned", reason: "verified" });
    // Replace any unfinished startup check, rather than stacking two 65-second waits.
    if (!stopObservation) {
      provenance.abort();
      provenance = new AbortController();
      stopObservation = observe().finally(() => { stopObservation = undefined; });
    }
    return stopObservation;
  };
  try {
    running = await serveDaemon({ paths, updateCheck: async () => { if (!updates) throw new Error("Update controller is starting."); return updates.check(); }, updateStatus: () => updates?.status() ?? { current: binVersion(), automatic: false, failures: 0, lastResult: "starting" }, version: binVersion(), peerUid, stopAllowed,
      ...(process.platform === "win32" && process.env.COTAL_DAEMON_NATIVE_SERVICE === "1" ? { admit: () => admitWindowsNativeDaemon(paths, home) } : {}),
      log: (l) => process.stderr.write(`${l}\n`), ...(home !== undefined ? { sessionDir: home } : {}) });
  } catch (e) {
    if (process.env.COTAL_DAEMON_NATIVE_SERVICE === "1") process.stderr.write(`daemon startup refused: ${e instanceof Error ? e.message : String(e)}\n`);
    throw asFailure(e);
  }
  updates = automaticUpdates({ version: binVersion(), eligible: () => home === undefined && owned, prepare: async () => { const seats = await running.generationSeats(); if (seats.some(row => row.seats > 0)) throw new Error("running agents remain"); }, abort: async () => {}, report: line => process.stderr.write(`${line}\n`) });
  process.stdout.write(`daemon ready at ${running.paths.socket}\n`);
  const ownership = observe();
  await new Promise<void>((resolve, reject) => {
    let closed = false;
    let stopWatching = () => {};
    void ownership.then(observation => {
      if (closed) return;
      const verified = observation.state === "owned";
      stopWatching = watchDaemonGeneration(binVersion(), async (version) => {
        if (!verified) throw new Error("no verified native launch marker; automatic activation is unavailable; use the installed CLI to restart this daemon");
        // The service restart stops every process of this service, the daemon's own update included.
        if (updates?.updating()) throw new Error("this daemon's update is still finishing");
        planUninstall(paths, home);
        const seats = await running.generationSeats();
        const occupied = seats.filter((row) => row.seats > 0);
        if (occupied.length) throw new Error(`waiting for ${occupied.reduce((sum, row) => sum + row.seats, 0)} seat(s) on ${occupied.map((row) => row.space).join(", ")}`);
        await running.prepareGenerationRestart();
        // The new daemon reconciles before it launches any Manager. The old generation never
        // mutates the shared connector store or reopens admission over a partial replacement.
        process.stderr.write(`daemon: installed CLI ${version} validated; stopping owned children for native service restart\n`);
        stopWatching();
        await updates?.close();
        await running.close();
        resolve();
      }, (line) => process.stderr.write(`${line}\n`), (version, reason) => running.generationPending(version, reason), verified);
    });
    const stop = () => { closed = true; provenance.abort(); stopWatching(); void updates!.close().then(() => running.close()).then(resolve, reject); };
    void running.stopped.then(stop, reject);
    process.once("SIGTERM", stop);
    process.once("SIGINT", stop);
  });
}

async function run(args: ParsedArgs): Promise<void> {
  const [mode, ...rest] = args.positionals;
  const subcommand = daemonCommand.subcommands?.find((command) => command.name === mode);
  if (subcommand) recordOperationContext({ command: `${daemonCommand.name} ${subcommand.name}` });
  if (rest.length && (mode !== "name" || rest.length > 1)) throw new CommandFailure("refused", "USAGE_INVALID", `cotal daemon ${mode} takes no positionals`);
  if (subcommand) {
    for (const name of Object.keys(args.values)) {
      if (!subcommand.flagNames?.includes(name)) throw new CommandFailure("refused", "USAGE_INVALID", `--${name} does not belong to \`cotal daemon ${mode}\``, { remedy: `run \`cotal help daemon ${mode}\`` });
    }
    const space = args.values.space;
    if (subcommand.flagNames?.includes("space") && typeof space === "string" && space.trim()) recordOperationContext({ target: { space } });
  }
  if (mode === "desktop") {
    return runDesktopBridge({ resolveTarget: () => target(args), version: binVersion(), peerUid, peerPid });
  }
  if (mode === "name") {
    const { paths } = resolveTarget(args);
    let reply;
    try { reply = await exchangeDesktopRequest({ paths, peerUid, peerPid }, { op: "name", ...(rest[0] !== undefined ? { name: rest[0] } : {}) }); }
    catch (error) { throw asFailure(error); }
    if (!reply.ok) throw new CommandFailure("refused", "USAGE_INVALID", reply.error.message);
    if ("event" in reply || !("computer" in reply.result) || typeof reply.result.computer !== "string") throw new CommandFailure("failed", "OPERATION_FAILED", "the daemon returned no computer name");
    const result = { computer: reply.result.computer };
    writeResult(presentationOf(args.values), { command: "daemon name", target: null, result }, () => ({ sections: [{ title: "Computer", blocks: [{ kind: "lines", lines: [result.computer] }] }] }));
    return;
  }
  if (mode === "spaces") {
    const { paths } = resolveTarget(args);
    let reply;
    try { reply = await exchangeDesktopRequest({ paths, peerUid, peerPid }, { op: "spaces", refresh: args.values.refresh === true }); }
    catch (error) { throw asFailure(error); }
    if (!reply.ok) {
      if (reply.error.code === "DEPENDENCY_UNAVAILABLE") throw new CommandFailure("refused", "DEPENDENCY_UNAVAILABLE", reply.error.message, { remedy: reply.error.remedy, native: { code: reply.error.code } });
      throw new CommandFailure("failed", "OPERATION_FAILED", "the daemon could not read its spaces", { native: { code: reply.error.code } });
    }
    if ("event" in reply || !("kind" in reply.result) || reply.result.kind !== "spaces") throw new CommandFailure("failed", "OPERATION_FAILED", "the daemon returned an unsupported space response");
    const result = reply.result;
    writeResult(presentationOf(args.values), { command: "daemon spaces", target: null, result,
      ...(result.refresh === "not-signed-in"
        ? { failure: new CommandFailure("refused", "AUTH_REQUIRED", "No provider is signed in; no catalog refresh was attempted", { remedy: "run `cotal daemon login --idp <url>` before refreshing catalogs" }) }
        : result.refresh === "failed" || result.refresh === "partial" || result.unreadable > 0 ? { partial: { message: "Some catalogs or registrations could not be read or applied", remedy: "inspect the recorded conflicts before retrying the refresh" } } : {}),
    }, () => ({ sections: [{ title: "Spaces", blocks: [
      { kind: "fields", rows: result.spaces.map((space): [string, string] => [space.space, `${space.label} (${space.mode})`]) },
      { kind: "fields", rows: [["Catalog refresh", result.refresh], ["Unreadable", String(result.unreadable)], ["Name conflicts", String(result.collisions)]] },
    ] }] }));
    return;
  }
  if (mode === "start") {
    const { paths, home } = resolveTarget(args);
    const result = await startInstalled(paths, home);
    writeResult(presentationOf(args.values), { command: "daemon start", target: { unit: result.unit }, result }, () => ({ sections: [
      { title: "Start requested", blocks: [{ kind: "lines", lines: [{ text: "The owned service received the start request. Check `cotal daemon status` for readiness; no connection is assumed.", tone: "hint" }] }] },
    ] }));
    return;
  }
  if (mode === "status") return status(args);
  if (mode === "serve") return serve(args);
  if (mode === "login") return login(args);
  if (mode === "connect-check") return connectCheckCommand(args);
  if (mode === "register") return registerCommand(args);
  if (mode === "service-connect" || mode === "service-disconnect" || mode === "service-status") return serviceCommand(args, mode);
  if (mode === "install" || mode === "uninstall") return unitCommand(args, mode);
  if (mode === "setup") return setupCommand(args);
  throw new CommandFailure("refused", "USAGE_INVALID", mode === undefined ? `cotal daemon needs a mode: ${daemonCommand.subcommands!.map((command) => command.name).join(", ")}` : `unknown daemon mode ${JSON.stringify(mode)}`, { remedy: "run `cotal help daemon`" });
}

const daemonCommand: Command = {
  kind: "command",
  name: "daemon",
  group: "Manager",
  summary: "connect this computer to an account, manage its persistent daemon, or host a space's Manager",
  positionals: "<name|setup|start|status|serve|install|uninstall|login|spaces|connect-check|register|service-connect|service-disconnect|service-status|desktop>",
  flags: daemonFlags,
  subcommands: [
    { name: "name", usage: "cotal daemon name [<name>] [--daemon-home <dir>] [--json|--plain]", summary: "read or change this computer's saved name", examples: [{ command: "cotal daemon name", note: "print the saved computer name" }], flagNames: ["daemon-home", "json", "plain"], outputs: ["json", "plain"], prepareMeshTarget: false },
    { name: "spaces", usage: "cotal daemon spaces [--refresh] [--daemon-home <dir>] [--json|--plain]", examples: [{ command: "cotal daemon spaces", note: "list registered spaces" }, { command: "cotal daemon spaces --refresh", note: "refresh catalogs before listing spaces" }], summary: "list registered spaces; optionally refresh catalogs using the daemon-held sign-in", flagNames: ["refresh", "daemon-home", "json", "plain"], outputs: ["json", "plain"], prepareMeshTarget: false },
    { name: "start", usage: "cotal daemon start [--daemon-home <dir>] [--json|--plain]", examples: [{ command: "cotal daemon start", note: "start the recorded daemon service" }], summary: "start the unchanged, recorded daemon service without restarting a running instance", flagNames: ["daemon-home", "json", "plain"], outputs: ["json", "plain"], prepareMeshTarget: false },
    { name: "desktop", usage: "cotal daemon desktop [--daemon-home <dir>]", examples: [{ command: "cotal daemon desktop < request.json", note: "serve one desktop request from a file" }], summary: "serve one bounded JSON request from the desktop app on stdin; credentials remain in the daemon", flagNames: ["daemon-home"], prepareMeshTarget: false },
    { name: "setup", usage: "cotal daemon setup [--cloud | --idp <url>] [--no-browser] [--space <s>] [--client-id <id>] [--no-manager [--wait <seconds>]] [--daemon-home <dir>] [--json|--plain]", summary: "connect this computer to an account, or rerun using its sole signed-in provider; with --space, host its Manager (--no-manager and --wait require --space)", examples: [{ command: "cotal daemon setup", note: "refresh apps using the sole signed-in provider" }, { command: "cotal daemon setup --idp <url>", note: "connect your account, then enable spaces in the dashboard" }, { command: "cotal daemon setup --space <space> --no-manager --wait 0", note: "report machine-service approval without hosting a Manager" }], flagNames: ["space", "cloud", "no-browser", "idp", "client-id", "wait", "no-manager", "daemon-home", "json", "plain"], outputs: ["json", "plain"], prepareMeshTarget: false },
    { name: "status", usage: "cotal daemon status [--space <s>] [--daemon-home <dir>] [--json|--plain]", summary: "ask the running daemon for its status and hosted Managers over the local endpoint", examples: [{ command: "cotal daemon status", note: "ask the running daemon for its status" }, { command: "cotal daemon status --json", note: "the same as one JSON document" }], flagNames: ["space", "daemon-home", "json", "plain"], outputs: ["json", "plain"], reads: true, prepareMeshTarget: false },
    { name: "serve", usage: "cotal daemon serve [--daemon-home <dir>] [--json|--plain]", summary: "run the daemon in the foreground and serve its local endpoint (refusals honor --json)", examples: [{ command: "cotal daemon serve", note: "run the machine daemon in this terminal" }], flagNames: ["daemon-home", "json", "plain"], outputs: ["json", "plain"], prepareMeshTarget: false },
    { name: "install", usage: "cotal daemon install [--daemon-home <dir>] [--dry-run] [--json|--plain]", summary: "install the daemon as this platform's user service; Linux also enables linger", examples: [{ command: "cotal daemon install", note: "run it as a persistent user service" }, { command: "cotal daemon install --dry-run", note: "show the unit it would write" }], flagNames: ["daemon-home", "dry-run", "json", "plain"], outputs: ["json", "plain"], prepareMeshTarget: false },
    { name: "uninstall", usage: "cotal daemon uninstall [--daemon-home <dir>] [--yes|--dry-run] [--json|--plain]", summary: "stop the daemon's user service, disable autostart and remove its unit", examples: [{ command: "cotal daemon uninstall", note: "remove its login unit" }], flagNames: ["daemon-home", "yes", "dry-run", "json", "plain"], outputs: ["json", "plain"], prepareMeshTarget: false },
    { name: "login", usage: "cotal daemon login [--cloud | --idp <auth base URL>] [--no-browser] [--client-id <id>] [--daemon-home <dir>] [--json|--plain]", summary: "sign the running daemon in to a provider with device approval; the daemon keeps the session", examples: [{ command: "cotal daemon login --idp <url>", note: "sign the daemon in with device approval" }], flagNames: ["cloud", "no-browser", "idp", "client-id", "daemon-home", "json", "plain"], outputs: ["json", "plain"], prepareMeshTarget: false },
    { name: "connect-check", usage: "cotal daemon connect-check --space <s> [--daemon-home <dir>] [--json|--plain]", summary: "ask the running daemon whether it could register with a space as its own service; registers nothing", examples: [{ command: "cotal daemon connect-check --space <space>", note: "check whether it could register" }], flagNames: ["space", "daemon-home", "json", "plain"], outputs: ["json", "plain"], reads: true, prepareMeshTarget: false },
    { name: "register", usage: "cotal daemon register --space <s> [--daemon-home <dir>] [--json|--plain]", summary: "ask the running daemon to request its own service registration with a space; the space owner must approve it, and it does not connect", examples: [{ command: "cotal daemon register --space <space>", note: "ask a space to approve it as a service" }], flagNames: ["space", "daemon-home", "json", "plain"], outputs: ["json", "plain"], prepareMeshTarget: false },
    { name: "service-connect", usage: "cotal daemon service-connect --space <s> [--daemon-home <dir>] [--json|--plain]", summary: "connect the running daemon to a space as its own approved service; succeeds only when the broker accepts the connection and the space accepts it as ready", examples: [{ command: "cotal daemon service-connect --space <space>", note: "connect it to a space" }], flagNames: ["space", "daemon-home", "json", "plain"], outputs: ["json", "plain"], prepareMeshTarget: false },
    { name: "service-disconnect", usage: "cotal daemon service-disconnect --space <s> [--daemon-home <dir>] [--json|--plain]", summary: "close the running daemon's service connection to a space", examples: [{ command: "cotal daemon service-disconnect --space <space>", note: "close its service connection to a space" }], flagNames: ["space", "daemon-home", "json", "plain"], outputs: ["json", "plain"], prepareMeshTarget: false },
    { name: "service-status", usage: "cotal daemon service-status --space <s> [--daemon-home <dir>] [--json|--plain]", summary: "read the running daemon's service connection to a space, without contacting it", examples: [{ command: "cotal daemon service-status --space <space>", note: "read the state of that connection" }], flagNames: ["space", "daemon-home", "json", "plain"], outputs: ["json", "plain"], reads: true, prepareMeshTarget: false },
  ],
  prepareMeshTarget: false,
  examples: [{ command: "cotal daemon setup --idp <url>", note: "connect this computer to your account" }, { command: "cotal daemon install", note: "run the machine daemon as a persistent user service" }, { command: "cotal daemon status", note: "ask the running daemon for its status" }],
  run,
};

registry.register(daemonCommand);
