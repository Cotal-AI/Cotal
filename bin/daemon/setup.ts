import { ensureHostedManager, hostingPrerequisite } from "./hosting.js";
/**
 * `cotal daemon setup`: connect a headless machine to a space with one command.
 *
 * It installs the daemon as a user service, discovers the space using the daemon-held sign-in,
 * signs in by device code when needed, and waits for the stock Manager to answer status. Machine
 * service registration is reported separately. The service-only opt-out waits for owner approval.
 * Sign-in prints an approval link and code for the operator to open elsewhere.
 *
 * Every step is a no-op when it is already done, so running this again after an interruption
 * continues rather than starting over or refusing. That matters because the approval in the middle
 * belongs to a person who may take a while.
 *
 * It composes the existing commands and adds no new authority. Pausing, renaming and disconnecting
 * stay separate commands; this one does not absorb them.
 */
import { codeSpan, CommandFailure, keptCatalogCredentials, resolveOnPath } from "@cotal-ai/workspace";
import { normalizeIdpUrl } from "@cotal-ai/auth";
import type { DaemonPaths } from "./endpoint.js";
import { EndpointRefusal } from "./endpoint.js";
import { loginFromCli } from "./cli-login.js";
import { connectCheckViaDaemon, managerViaDaemon, queryDaemon, registerViaDaemon, serviceViaDaemon } from "./client.js";
import { exchangeDesktopRequest } from "./desktop.js";
import type { PeerPid, PeerUid } from "./endpoint.js";
import type { HostedManager, LoginPrompt, LoginResult, RegisterResult, ServiceConnectionState } from "./protocol.js";
import { applyInstall, installedDaemonIdentity, planUninstall, planInstalledPathRefresh, startInstalled, restartInstalled } from "./install.js";
import { fromRegister } from "./service.js";
import { DAEMON_PROTOCOL_VERSION } from "./endpoint.js";
import { daemonCommandCopy } from "./guidance.js";

/** How each step ended, in the order they ran. A reader sees what this did and what it skipped. */
export interface SetupStep {
  readonly step: "install" | "discover" | "sign-in" | "manager" | "applications" | "register" | "connect";
  readonly outcome: string;
  readonly detail: string;
  readonly applications?: readonly string[];
}

export interface SetupResult {
  readonly launchReady?: boolean;
  readonly space: string;
  readonly state: ServiceConnectionState;
  readonly steps: readonly SetupStep[];
  readonly instanceId?: string;
  readonly unit?: string;
  readonly manager?: HostedManager;
  readonly registration?: RegisterResult;
}

interface InstallOptions {
  readonly noManager?: boolean;
  readonly space?: string;
  readonly version?: string;
  readonly paths: DaemonPaths;
  readonly daemonHome: string | undefined;
  readonly peerUid?: PeerUid;
  readonly peerPid?: PeerPid;
  readonly report: (line: string, progress?: SetupStep) => void;
}

export interface SetupOptions extends InstallOptions {
  readonly space: string;
  readonly idp?: string;
  readonly clientId?: string;
  readonly discoveryPins?: { url: string; issuer: string; audience: string };
  /** Seconds to wait for the space owner's approval. 0 reports what it reached and stops. */
  readonly waitSeconds: number;
  /** Progress for a terminal, one line per step. */
  readonly report: (line: string, progress?: SetupStep) => void;
  /** The device-code prompt, shown the way `cotal daemon login` shows it. */
  readonly onPrompt: (prompt: LoginPrompt) => void;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Wait for the daemon to answer its endpoint after a start, so the steps below reach a live one. */
async function waitForDaemon(opts: InstallOptions, seconds: number): Promise<void> {
  const deadline = Date.now() + seconds * 1000;
  let last: unknown;
  for (;;) {
    try {
      const reply = await queryDaemon({ paths: opts.paths, peerUid: opts.peerUid, peerPid: opts.peerPid });
      if (reply.ok && (!opts.version || reply.result.version === opts.version) && reply.result.protocol === DAEMON_PROTOCOL_VERSION) return;
      last = reply.ok ? `the daemon still runs Cotal ${reply.result.version}` : reply.error;
    } catch (e) {
      // NOT_RUNNING and PEER_NOT_LOCK_OWNER are both "not up yet" while a unit is starting.
      if (!(e instanceof EndpointRefusal) || (e.code !== "NOT_RUNNING" && e.code !== "PEER_NOT_LOCK_OWNER")) throw e;
      last = e.message;
    }
    if (Date.now() >= deadline) {
      throw new CommandFailure("refused", "DEPENDENCY_UNAVAILABLE", `the daemon did not answer ${opts.paths.socket} within ${seconds}s of being started; nothing was registered`, {
        remedy: "read its unit with systemctl --user status, then run this again",
        ...(typeof last === "string" ? { native: { code: "NOT_ANSWERING" } } : {}),
      });
    }
    await sleep(250);
  }
}

/** Whether a daemon answers this endpoint right now. Any refusal means no. */
async function daemonAnswers(opts: InstallOptions): Promise<boolean> {
  try {
    const reply = await queryDaemon({ paths: opts.paths, peerUid: opts.peerUid, peerPid: opts.peerPid });
    return reply.ok;
  } catch { return false; }
}

function restartProgress(opts: InstallOptions): (detail: string) => void {
  return detail => opts.report(`service: ${detail}`, { step: "install", outcome: "running", detail });
}

/** Install the user service unless it is already installed, then wait for the daemon to answer. */
async function ensureInstalled(opts: InstallOptions, steps: SetupStep[]): Promise<string | undefined> {
  let unit: string | undefined;
  let outcome: string, detail: string;
  try {
    // A recorded, unchanged unit means this is already installed; `planUninstall` is the exact
    // same check `uninstall` makes, so the two can never disagree about what is installed.
    const existing = planUninstall(opts.paths, opts.daemonHome);
    unit = existing.unit;
    outcome = "already-installed";
    detail = `${existing.unit} is already installed; it was left as it is`;
  } catch {
    // Nothing is recorded, so this would install. A daemon that is already answering was started
    // some other way, by hand or by a container entrypoint, and installing now would start a
    // second one that the lifetime lock refuses. Say so instead of leaving a unit that cannot run,
    // and do not quietly use the running daemon either, because it is not a persistent service.
    if (await daemonAnswers(opts)) {
      throw new CommandFailure("refused", "CONFLICT", `a daemon already answers ${opts.paths.socket} and no installed unit is recorded for it, so this would install a second one that its lifetime lock refuses; nothing was installed`, {
        remedy: opts.space ? `stop that daemon and run this again, or keep it and run ${codeSpan(daemonCommandCopy("register", opts.daemonHome, [["--space", opts.space]]))} and ${codeSpan(daemonCommandCopy("service-connect", opts.daemonHome, [["--space", opts.space]]))} by hand` : "stop that daemon and run this again to install its persistent service",
        native: { code: "RUNNING_WITHOUT_UNIT" },
      });
    }
    const installed = applyInstall(opts.paths, opts.daemonHome);
    unit = installed.unit;
    outcome = "installed";
    detail = `${installed.unit} installed${installed.mechanism === "systemd-user" ? `, ${installed.lingerAlready ? "linger was already enabled" : "linger enabled"}` : ""}, restart ${installed.restart}, started by ${installed.wantedBy}`;
  }
  if (outcome === "already-installed" && !(await daemonAnswers(opts))) {
    // A start failure is not evidence that no installation was recorded.
    await startInstalled(opts.paths, opts.daemonHome, opts.version, restartProgress(opts));
    detail = `${unit} is already installed; its owned service received a start request`;
  } else if (outcome === "already-installed" && opts.version) {
    const reply = await queryDaemon(opts);
    if (reply.ok) {
      const installation = installedDaemonIdentity(opts.paths, opts.daemonHome);
      if (!installation.same) {
        const remedy = `run setup from ${installation.installed}, or run ${codeSpan(daemonCommandCopy("uninstall", opts.daemonHome))} then setup from ${installation.current}`;
        if (reply.result.protocol !== DAEMON_PROTOCOL_VERSION) throw new CommandFailure("refused", "CONFLICT", `the daemon at ${installation.installed} runs Cotal ${reply.result.version}, while this CLI is ${installation.current}; its protocol is incompatible and it was not restarted`, { remedy });
        if (!opts.noManager && opts.space) {
          try { await managerViaDaemon(opts, { op: "manager-status", space: opts.space }); }
          catch { throw new CommandFailure("refused", "CONFLICT", `the daemon at ${installation.installed} runs Cotal ${reply.result.version}, while this CLI is ${installation.current}; it does not answer the hosting operations and was not restarted`, { remedy }); }
        }
        detail = `${unit} at ${installation.installed} runs compatible Cotal ${reply.result.version}; it was left running`;
        steps.push({ step: "install", outcome, detail });
        opts.report(`service: ${detail}`, steps.at(-1));
        return unit;
      }
      if (reply.result.version !== opts.version || reply.result.protocol !== DAEMON_PROTOCOL_VERSION) {
        const hosted = (reply.result.managers ?? []).some((manager) => manager.state !== "stopped");
        if (hosted) await managerViaDaemon(opts, { op: "managers-prepare-restart" });
        try { await restartInstalled(opts.paths, opts.daemonHome, false, opts.version, restartProgress(opts)); }
        catch (error) {
          if (hosted && process.platform !== "win32") {
            try { await managerViaDaemon(opts, { op: "managers-abort-restart" }); }
            catch { /* The native restart failure remains the primary outcome. */ }
          }
          throw error;
        }
        detail = `${unit} restarted through its recorded service to load Cotal ${opts.version}`;
      }
    }
  }
  steps.push({ step: "install", outcome, detail });
  opts.report(`service: ${detail}`, steps.at(-1));
  await waitForDaemon(opts, 60);
  opts.report(`service: the daemon answers at ${opts.paths.socket}`, { step: "install", outcome: "ready", detail: `the daemon answers at ${opts.paths.socket}` });
  return unit;
}

function hasNewApplications(manager: HostedManager): boolean {
  return manager.connectors?.some(connector => connector.state !== "available"
    && (/ harness needs (.+) on PATH/.exec(connector.reason ?? "")?.[1]?.split(", ") ?? [])
      .some(binary => resolveOnPath(binary) !== undefined)) ?? false;
}

async function refreshApplications(opts: InstallOptions, steps: SetupStep[]): Promise<boolean> {
  const installation = installedDaemonIdentity(opts.paths, opts.daemonHome);
  if (!installation.same) throw new CommandFailure("refused", "CONFLICT", `the daemon at ${installation.installed} cannot refresh applications from this installation`, { remedy: `run setup from ${installation.installed}` });
  const refresh = planInstalledPathRefresh(opts.paths, opts.daemonHome);
  if (!refresh && process.platform !== "win32") return false;
  opts.report("service: waiting for hosted Managers to confirm readiness and an idle restart fence; readiness observation waits up to 15s", { step: "manager", outcome: "running", detail: "waiting for hosted Managers to confirm readiness and an idle restart fence" });
  try { await managerViaDaemon(opts, { op: "managers-prepare-restart" }); }
  catch (error) {
    if (error instanceof CommandFailure && error.native?.code === "SEATS_ACTIVE") throw new CommandFailure("refused", "LIFECYCLE_BLOCKED", `${error.message}. The new application will become available after the seats stop and setup runs again. No service was changed or restarted`, { native: error.native, remedy: error.remedy });
    throw error;
  }
  try {
    refresh?.();
    await restartInstalled(opts.paths, opts.daemonHome, true, opts.version, restartProgress(opts));
  } catch (error) {
    try { if (process.platform !== "win32") await managerViaDaemon(opts, { op: "managers-abort-restart" }); }
    catch { /* Preserve the installation or native service failure. */ }
    throw error;
  }
  const detail = process.platform === "win32" ? "restarted the service to read the current user PATH" : "refreshed the pinned PATH from this invocation, keeping existing directories";
  steps.push({ step: "install", outcome: "path-refreshed", detail });
  opts.report(`service: ${detail}`, steps.at(-1));
  await waitForDaemon(opts, 60);
  return true;
}

/** A sign-in that replaced an account but could not delete some of that account's discovered-space
 *  credential files stops setup as partial. The session is already switched, so a rerun continues. */
function credentialsRemoved(r: LoginResult): void {
  if (r.outcome !== "signed-in" || !r.credentialsKept?.length) return;
  const { message, remedy } = keptCatalogCredentials(r.credentialsKept);
  throw new CommandFailure("partial", "OPERATION_PARTIAL", message, { remedy: `${remedy}, then run this setup again` });
}

/** Connect this computer to an account without changing any space intent. */
export async function runAccountSetup(opts: Omit<SetupOptions, "space" | "waitSeconds"> & { idp: string; existingSignInOnly?: boolean }) {
  const steps: SetupStep[] = [];
  const unit = await ensureInstalled(opts, steps);
  const beforeRefresh = await queryDaemon(opts);
  if (!beforeRefresh.ok) throw new CommandFailure("refused", "DEPENDENCY_UNAVAILABLE", beforeRefresh.error.message);
  if (beforeRefresh.result.managers?.some(hasNewApplications)) await refreshApplications(opts, steps);
  const discovery = await exchangeDesktopRequest(opts, { op: "spaces", refresh: true });
  const signedIn = discovery.ok && !("event" in discovery) && "signedInProviders" in discovery.result
    && discovery.result.signedInProviders?.includes(opts.idp);
  if (!signedIn || opts.discoveryPins) {
    if (opts.existingSignInOnly) throw new CommandFailure("refused", "AUTH_REQUIRED", "The daemon is not signed in; pass --idp <url> to connect an account");
    const signed = await loginFromCli(opts);
    if (!signed.ok) throw new CommandFailure("refused", "AUTH_REQUIRED", signed.message, { native: { code: signed.code } });
    if (signed.result.outcome === "failed") throw new CommandFailure("refused", "AUTH_REQUIRED", signed.result.message);
    credentialsRemoved(signed.result);
    steps.push({ step: "sign-in", outcome: "signed-in", detail: `signed in as ${signed.result.label || signed.result.sub}` });
  } else steps.push({ step: "sign-in", outcome: "already-signed-in", detail: "already signed in; no approval was needed" });
  opts.report(`sign-in: ${steps.at(-1)!.detail}`, steps.at(-1));
  const deadline = Date.now() + 60_000;
  for (;;) {
    const status = await queryDaemon(opts);
    const registration = status.ok ? (status.result.account?.accounts ?? [status.result.account]).find(item => item?.idpUrl === opts.idp) : undefined;
    if (registration?.hostSupport === "unsupported") throw new CommandFailure("refused", "UNSUPPORTED", "this provider does not support account computers; use setup --space <s>");
    if (registration?.mode === "sign-in-required") throw new CommandFailure("refused", "AUTH_REQUIRED", "sign in again to register this computer");
    if (registration?.lastRegistration && registration.hostSupport === "supported") {
      steps.push({ step: "register", outcome: "registered", detail: "this computer is registered with the account" });
      if (!registration.machineId || !registration.sub || !registration.computer) throw new CommandFailure("refused", "DEPENDENCY_UNAVAILABLE", "the daemon did not return this computer's account identity");
      return { account: registration.sub, label: registration.label, computer: registration.computer, machineId: registration.machineId, spaces: registration.spaces.filter(space => space.desired).map(space => space.space).sort(), steps, ...(unit ? { unit } : {}) };
    }
    if (Date.now() >= deadline) throw new CommandFailure("refused", "DEPENDENCY_UNAVAILABLE", "the account did not confirm this computer's registration within 60 seconds; run setup again");
    await sleep(250);
  }
}

/** Sign in when needed. Keep a failed prerequisite for the independent Manager's service report. */
async function ensureSignedIn(opts: SetupOptions, steps: SetupStep[]): Promise<RegisterResult | undefined> {
  const check = await connectCheckViaDaemon({ paths: opts.paths, peerUid: opts.peerUid, peerPid: opts.peerPid, space: opts.space });
  if (!check.ok) throw new CommandFailure("refused", "USAGE_INVALID", `the daemon refused the connection check: ${check.code} ${check.message}`, { native: { code: check.code } });
  if (check.result.outcome === "credential-expired") {
    throw new CommandFailure("refused", "LIFECYCLE_BLOCKED", check.result.message, { native: { code: "CREDENTIAL_EXPIRED" } });
  }
  if (check.result.outcome === "unreachable" || check.result.outcome === "refused") {
    throw new CommandFailure("refused", "DEPENDENCY_UNAVAILABLE", check.result.message, { native: { code: check.result.outcome.toUpperCase() } });
  }
  if (check.result.outcome !== "not-signed-in") {
    const prerequisite = check.result.outcome === "ready-to-register" ? undefined : check.result;
    // Service-only setup cannot proceed past a failed check. Use the registration refusal
    // mapping without sending a registration request or claiming a successful sign-in.
    if (prerequisite && opts.noManager) registrationResult(opts, steps, prerequisite);
    // These outcomes occur only after connect-check has validated the daemon's provider session.
    const signedIn = hostingPrerequisite(check.result.outcome);
    steps.push({ step: "sign-in", outcome: signedIn ? "already-signed-in" : "not-needed-here", detail: `the connection check answered ${check.result.outcome}` });
    opts.report(signedIn
      ? "sign-in: already signed in; no approval was needed"
      : `sign-in: skipped; the connection check answered ${check.result.outcome}`, steps.at(-1));
    return prerequisite;
  }
  if (opts.idp === undefined) {
    throw new CommandFailure("refused", "AUTH_REQUIRED", "this machine is not signed in to the space's provider; nothing was registered", {
      remedy: check.result.remedy,
      native: { code: "NOT_SIGNED_IN" },
    });
  }
  const listed = await exchangeDesktopRequest(opts, { op: "spaces" });
  const provider = listed.ok && !("event" in listed) && "spaces" in listed.result
    ? listed.result.spaces.find((entry) => entry.space === opts.space)?.idp : undefined;
  if (provider === undefined) {
    throw new CommandFailure("refused", "DEPENDENCY_UNAVAILABLE", "the daemon did not identify the space's sign-in provider; no sign-in was started and nothing was registered");
  }
  if (normalizeIdpUrl(opts.idp) !== normalizeIdpUrl(provider)) {
    throw new CommandFailure("refused", "USAGE_INVALID", "--idp does not match the space's pinned sign-in provider; no sign-in was started and nothing was registered", {
      remedy: `run ${codeSpan(daemonCommandCopy("setup", opts.daemonHome, [["--space", opts.space], ["--idp", provider], ...(opts.noManager ? ["--no-manager" as const] : [])]))}`,
      native: { code: "IDP_MISMATCH" },
    });
  }
  opts.report("sign-in: approve this machine on another device", { step: "sign-in", outcome: "running", detail: "approve this machine on another device" });
  const reply = await loginFromCli({
    paths: opts.paths, peerUid: opts.peerUid, peerPid: opts.peerPid, idp: opts.idp,
    discoveryPins: opts.discoveryPins,
    ...(opts.clientId !== undefined ? { clientId: opts.clientId } : {}),
    onPrompt: opts.onPrompt,
  });
  if (!reply.ok) throw new CommandFailure("failed", "OPERATION_FAILED", `the daemon refused the sign-in: ${reply.code} ${reply.message}`, { native: { code: reply.code } });
  const r = reply.result;
  if (r.outcome === "failed") {
    if (r.reason === "local-state-error") throw new CommandFailure("refused", "DEPENDENCY_UNAVAILABLE", r.message, { native: { code: r.reason.toUpperCase() }, remedy: r.remedy });
    const native = { native: { code: r.reason.toUpperCase().replaceAll("-", "_") } };
    if (r.reason === "unreachable" || r.reason === "authorization-refused") throw new CommandFailure("refused", "DEPENDENCY_UNAVAILABLE", `${r.message}; no session was saved and nothing was registered`, native);
    if (r.reason === "denied" || r.reason === "expired") throw new CommandFailure("refused", "PERMISSION_DENIED", `${r.message}; no session was saved and nothing was registered`, native);
    throw new CommandFailure("failed", "OPERATION_FAILED", `${r.message}; a session may have been saved before the failure, so run this again`, native);
  }
  credentialsRemoved(r);
  steps.push({ step: "sign-in", outcome: "signed-in", detail: `signed in as ${r.label || r.sub}` });
  opts.report(`sign-in: signed in as ${r.label || r.sub}`, steps.at(-1));
}

/** Ask the space to register this daemon. Replaying an existing request is the same call. */
async function requestRegistration(opts: SetupOptions, steps: SetupStep[]): Promise<RegisterResult> {
  const reply = await registerViaDaemon({ paths: opts.paths, peerUid: opts.peerUid, peerPid: opts.peerPid, space: opts.space });
  if (!reply.ok) throw new CommandFailure("refused", "USAGE_INVALID", `the daemon refused the registration request: ${reply.code} ${reply.message}`, { native: { code: reply.code } });
  return registrationResult(opts, steps, reply.result);
}

/** Report one registration result, including a prerequisite that prevented any request. */
function registrationResult(opts: SetupOptions, steps: SetupStep[], r: RegisterResult): RegisterResult {
  if (!opts.noManager) {
    steps.push({ step: "register", outcome: r.outcome, detail: r.message });
    opts.report(`register: ${r.outcome}; ${r.message}`, steps.at(-1));
    return r;
  }
  const native = { native: { code: (r.outcome === "refused" && "reason" in r ? r.reason : r.outcome).toUpperCase().replaceAll("-", "_") }, ...("remedy" in r ? { remedy: r.remedy } : {}) };
  if (r.outcome === "not-registered") throw new CommandFailure("refused", "TARGET_NOT_FOUND", r.message, native);
  if (r.outcome === "not-user-auth" || r.outcome === "unsupported-by-space") throw new CommandFailure("refused", "UNSUPPORTED", r.message, native);
  if (r.outcome === "not-signed-in") throw new CommandFailure("refused", "AUTH_REQUIRED", r.message, native);
  if (r.outcome === "credential-expired") throw new CommandFailure("refused", "LIFECYCLE_BLOCKED", r.message, native);
  if (r.outcome === "unreachable") throw new CommandFailure("refused", "DEPENDENCY_UNAVAILABLE", r.message, native);
  if (r.outcome === "account-mismatch" || r.outcome === "conflict" || r.outcome === "local-state-error") throw new CommandFailure("refused", "CONFLICT", r.message, native);
  if (r.outcome === "refused") throw new CommandFailure("refused", "reason" in r ? "PERMISSION_DENIED" : "DEPENDENCY_UNAVAILABLE", r.message, native);
  if (r.outcome !== "approval-required" && r.outcome !== "pending" && r.outcome !== "registered") throw new CommandFailure("unknown", "OPERATION_UNKNOWN", r.message, native);
  steps.push({ step: "register", outcome: r.outcome, detail: `${r.endpoint} instance ${r.instanceId}, request ${r.requestId}` });
  opts.report(`register: ${r.outcome}, service ${r.endpoint}, instance ${r.instanceId}`, steps.at(-1));
  return r;
}

/** States that will not become `connected` however long anyone waits. */
const TERMINAL = new Set<ServiceConnectionState>(["refused", "ended", "account-mismatch", "conflict", "unsupported", "not-registered", "not-requested", "not-signed-in", "local-state-error", "credential-expired"]);

/**
 * Connect, retrying while the space is still waiting for its owner. Only an answer that cannot
 * improve stops the wait early; a space that is unreachable is retried, because an operator who
 * walked away to approve this should not come back to a failure caused by a blip.
 */
async function connectWhenApproved(opts: SetupOptions, steps: SetupStep[]): Promise<{ state: ServiceConnectionState; instanceId?: string; message: string }> {
  const deadline = Date.now() + opts.waitSeconds * 1000;
  let announced = false;
  for (;;) {
    const reply = await serviceViaDaemon({ paths: opts.paths, peerUid: opts.peerUid, peerPid: opts.peerPid, space: opts.space, op: "service-connect" });
    if (!reply.ok) throw new CommandFailure("refused", "USAGE_INVALID", `the daemon refused the service request: ${reply.code} ${reply.message}`, { native: { code: reply.code } });
    const r = reply.result;
    if (r.state === "connected" || TERMINAL.has(r.state) || Date.now() >= deadline) {
      steps.push({ step: "connect", outcome: r.state, detail: r.message });
      opts.report(`connect: ${r.state}; ${r.message}`, steps.at(-1));
      return { state: r.state, ...(r.instanceId ? { instanceId: r.instanceId } : {}), message: r.message };
    }
    if (!announced) {
      announced = true;
      opts.report(r.state === "approval-pending"
        ? `connect: waiting up to ${opts.waitSeconds}s for the space owner to approve this machine`
        : `connect: ${r.state}; retrying for up to ${opts.waitSeconds}s`, { step: "connect", outcome: "waiting", detail: r.message });
    }
    await sleep(Math.min(5000, Math.max(0, deadline - Date.now())));
  }
}

/** Run setup through an answering Manager, or a connected machine service with the opt-out. */
export async function runSetup(opts: SetupOptions): Promise<SetupResult> {
  const steps: SetupStep[] = [];
  let discoveredSignIn = false;
  const unit = await ensureInstalled(opts, steps);
  if (opts.discoveryPins) {
    const listed = await exchangeDesktopRequest(opts, { op: "spaces" });
    const provider = listed.ok && !("event" in listed) && "spaces" in listed.result
      ? listed.result.spaces.find(entry => entry.space === opts.space)?.idp : undefined;
    if (provider !== undefined && normalizeIdpUrl(provider) !== normalizeIdpUrl(opts.discoveryPins.url)) {
      throw new CommandFailure("refused", "USAGE_INVALID", "--idp does not match the space's pinned sign-in provider; no sign-in was started and nothing was registered", { native: { code: "IDP_MISMATCH" } });
    }
  }
  if (!opts.noManager) {
    let discovered = await exchangeDesktopRequest(opts, { op: "spaces", refresh: true });
    const hasSpace = () => discovered.ok && !("event" in discovered) && "spaces" in discovered.result && discovered.result.spaces.some((entry) => entry.space === opts.space);
    const signedInToProvider = () => discovered.ok && !("event" in discovered) && "signedInProviders" in discovered.result && discovered.result.signedInProviders?.includes(opts.idp ?? "");
    if (!hasSpace() && opts.idp && !signedInToProvider()) {
      opts.report("sign-in: approve this machine on another device", { step: "sign-in", outcome: "running", detail: "approve this machine on another device" });
      const signed = await loginFromCli({ ...opts, idp: opts.idp });
      if (!signed.ok) throw new CommandFailure("refused", "AUTH_REQUIRED", `the daemon refused discovery sign-in: ${signed.code} ${signed.message}`, { native: { code: signed.code }, remedy: `run ${codeSpan(daemonCommandCopy("login", opts.daemonHome, [["--idp", opts.idp]]))}` });
      if (signed.result.outcome === "failed") {
        const failed = signed.result;
        if (failed.reason === "local-state-error") throw new CommandFailure("refused", "DEPENDENCY_UNAVAILABLE", failed.message, { native: { code: failed.reason.toUpperCase() }, remedy: failed.remedy });
        throw new CommandFailure("refused", failed.reason === "unreachable" || failed.reason === "authorization-refused" ? "DEPENDENCY_UNAVAILABLE" : "PERMISSION_DENIED", failed.message, { native: { code: failed.reason.toUpperCase().replaceAll("-", "_") }, remedy: `run ${codeSpan(daemonCommandCopy("login", opts.daemonHome, [["--idp", opts.idp]]))}` });
      }
      credentialsRemoved(signed.result);
      steps.push({ step: "sign-in", outcome: "signed-in", detail: `signed in as ${signed.result.label || signed.result.sub}` });
      opts.report(`sign-in: signed in as ${signed.result.label || signed.result.sub}`, steps.at(-1));
      discoveredSignIn = true;
      discovered = await exchangeDesktopRequest(opts, { op: "spaces", refresh: true });
    }
    if (!hasSpace()) {
      const refreshFailed = !discovered.ok || ("result" in discovered && "refresh" in discovered.result && ["failed", "partial"].includes(discovered.result.refresh));
      throw new CommandFailure("refused", refreshFailed ? "DEPENDENCY_UNAVAILABLE" : "TARGET_NOT_FOUND", refreshFailed ? "the daemon could not refresh its signed-in space catalogs" : "this space was not found in the daemon's signed-in catalogs", { remedy: `run ${codeSpan(daemonCommandCopy("setup", opts.daemonHome, [["--space", opts.space], ...(opts.idp ? [["--idp", opts.idp] as const] : [])]))}${opts.idp ? "" : " with --idp <auth base URL>"}; ask the space owner to grant this account access` });
    }
    steps.push({ step: "discover", outcome: "registered", detail: "the daemon discovered the requested space" });
    opts.report("discover: the requested space is registered on this machine", steps.at(-1));
  }
  if (opts.noManager) {
    const status = await queryDaemon(opts);
    if (!status.ok) throw new CommandFailure("refused", "DEPENDENCY_UNAVAILABLE", "the daemon could not check whether an account manages this computer");
    const accounts = status.result.account?.accounts ?? (status.result.account ? [status.result.account] : []);
    if (accounts.some(account => account.hostSupport === "unknown")) {
      throw new CommandFailure("refused", "DEPENDENCY_UNAVAILABLE", "the account host has not confirmed whether it manages this computer; check daemon status and retry before using --no-manager");
    }
    if (accounts.some(account => account.hostSupport === "supported")) {
      throw new CommandFailure("refused", "UNSUPPORTED", "an account manages this computer's spaces from the dashboard; --no-manager applies only to per-space hosts", {
        remedy: "manage this computer's spaces from the account dashboard, or use --no-manager on a per-space host",
      });
    }
  }
  const prerequisite = discoveredSignIn ? undefined : await ensureSignedIn(opts, steps);
  if (!opts.noManager) {
    opts.report("connect: checking this computer and turning on the space", { step: "connect", outcome: "running", detail: "Checking this computer and turning on the space." });
    const intent = await exchangeDesktopRequest(opts, { op: "space-intent", space: opts.space, enabled: true });
    if (!intent.ok) throw new CommandFailure("refused", "DEPENDENCY_UNAVAILABLE", intent.error.message);
    opts.report("connect: starting the agent host", { step: "connect", outcome: "running", detail: "Starting the agent host." });
    let manager = await ensureHostedManager(opts.space, {
      refresh: async space => await managerViaDaemon(opts, { op: "manager-status", space }) as HostedManager,
      start: async space => await managerViaDaemon(opts, { op: "manager-start", space }) as HostedManager,
    });
    const inspectedExisting = manager.state === "answering";
    let refreshed = false;
    const newlyResolvable = hasNewApplications(manager);
    if (newlyResolvable) refreshed = await refreshApplications(opts, steps);
    if (inspectedExisting || refreshed) manager = await managerViaDaemon(opts, { op: "manager-start", space: opts.space }) as HostedManager;
    steps.push({ step: "manager", outcome: manager.state, detail: manager.reason ?? manager.instanceId ?? manager.state });
    opts.report(`manager: ${manager.state}${manager.instanceId ? `, instance ${manager.instanceId}` : ""}`, steps.at(-1));
    if (manager.state !== "answering") throw new CommandFailure("refused", "LIFECYCLE_BLOCKED", manager.reason ?? "the hosted Manager is not answering yet", { remedy: manager.next ?? `read ${codeSpan(daemonCommandCopy("status", opts.daemonHome, [["--space", opts.space]]))}`, native: { code: manager.state.toUpperCase() } });
    const available = manager.connectors?.filter(connector => connector.state === "available") ?? [];
    const names: Record<string, string> = { claude: "Claude Code", codex: "Codex", hermes: "Hermes", jcode: "Jcode", opencode: "OpenCode", pi: "pi" };
    const applications = [...new Set((manager.connectors ?? []).flatMap(connector => {
      if (names[connector.agent]) return [names[connector.agent]!];
      const missing = / harness needs (.+) on PATH/.exec(connector.reason ?? "");
      return missing ? missing[1]!.split(", ") : connector.agent === "(inventory)" ? [] : [connector.agent];
    }))];
    opts.report(`connectors: ${available.length} available`, { step: "applications", outcome: available.length ? "available" : "unavailable", detail: `${available.length} available`, applications: applications.length ? applications : Object.values(names) });
    if (!available.length) {
      throw new CommandFailure("refused", "DEPENDENCY_UNAVAILABLE", "no available connector in the hosted Manager's environment", { remedy: `install ${applications.length ? applications.join(" or ") : "Claude Code, Codex, Hermes, Jcode, OpenCode or pi"} and make sure the application runs in this terminal, then run the same setup command again`, native: { code: "NO_AVAILABLE_CONNECTOR" } });
    }
    const registration = prerequisite ? registrationResult(opts, steps, prerequisite) : await requestRegistration(opts, steps);
    // A pending registration has no service credential yet. Report it without polling its owner.
    let state: ServiceConnectionState = fromRegister(registration);
    let message = registration.message;
    if (registration.outcome === "registered") {
      const connected = await serviceViaDaemon({ ...opts, op: "service-connect" });
      state = connected.ok ? connected.result.state : "unavailable";
      message = connected.ok ? connected.result.message : connected.message;
    }
    steps.push({ step: "connect", outcome: state, detail: message });
    opts.report(`connect: machine service ${state}; Manager launch-readiness is independent`, steps.at(-1));
    return { space: opts.space, launchReady: true, state, manager, registration, ...("instanceId" in registration ? { instanceId: registration.instanceId } : {}), steps, ...(unit ? { unit } : {}) };
  }
  await requestRegistration(opts, steps);
  const end = await connectWhenApproved(opts, steps);
  const result: SetupResult = { space: opts.space, state: end.state, steps, ...(end.instanceId ? { instanceId: end.instanceId } : {}), ...(unit ? { unit } : {}) };
  if (end.state === "connected") return result;
  const native = { code: end.state.toUpperCase().replaceAll("-", "_") };
  const target = { space: opts.space, ...(unit ? { unit } : {}) };
  // A state that is simply not there yet is a partial: the service is installed and the
  // registration is sent, so say what is already done and let a rerun continue from here.
  if (!TERMINAL.has(end.state)) {
    throw new CommandFailure("partial", "OPERATION_PARTIAL", `${end.message}. The daemon is installed and running, and its registration request is sent`, {
      remedy: end.state === "approval-pending"
        ? `ask the space owner to approve this machine, then run ${codeSpan(daemonCommandCopy("setup", opts.daemonHome, [["--space", opts.space], "--no-manager"]))} again`
        : `read ${codeSpan(daemonCommandCopy("service-status", opts.daemonHome, [["--space", opts.space]]))}, then run ${codeSpan(daemonCommandCopy("setup", opts.daemonHome, [["--space", opts.space], "--no-manager"]))} again`,
      native, target,
    });
  }
  // A state that cannot improve is a refusal, carrying the space's own reason.
  const code = end.state === "not-requested" || end.state === "not-registered" ? "TARGET_NOT_FOUND"
    : end.state === "unsupported" ? "UNSUPPORTED"
    : end.state === "not-signed-in" ? "AUTH_REQUIRED"
    : end.state === "credential-expired" ? "LIFECYCLE_BLOCKED"
    : end.state === "account-mismatch" || end.state === "conflict" || end.state === "local-state-error" ? "CONFLICT"
    : "PERMISSION_DENIED";
  throw new CommandFailure("refused", code, `${end.message}. The daemon is installed and running, and nothing is connected`, {
    remedy: `read ${codeSpan(daemonCommandCopy("service-status", opts.daemonHome, [["--space", opts.space]]))}`,
    native, target,
  });
}
