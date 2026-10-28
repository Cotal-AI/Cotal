/**
 * `cotal daemon setup`: connect a headless machine to a space with one command.
 *
 * It does what an operator would otherwise do by hand, in order: install the daemon as a user
 * service and wait for it to answer, sign it in by device code when it is not signed in already,
 * ask the space to register it, and connect it once the space owner approves. There is no local
 * browser anywhere on that path; the sign-in prints an approval link and code for the operator to
 * open elsewhere.
 *
 * Every step is a no-op when it is already done, so running this again after an interruption
 * continues rather than starting over or refusing. That matters because the approval in the middle
 * belongs to a person who may take a while.
 *
 * It composes the existing commands and adds no new authority. Pausing, renaming and disconnecting
 * stay separate commands; this one does not absorb them.
 */
import { CommandFailure } from "@cotal-ai/workspace";
import type { DaemonPaths } from "./endpoint.js";
import { EndpointRefusal } from "./endpoint.js";
import { connectCheckViaDaemon, loginViaDaemon, queryDaemon, registerViaDaemon, serviceViaDaemon } from "./client.js";
import type { PeerPid, PeerUid } from "./endpoint.js";
import type { LoginPrompt, ServiceConnectionState } from "./protocol.js";
import { applyInstall, planUninstall } from "./install.js";

/** How each step ended, in the order they ran. A reader sees what this did and what it skipped. */
export interface SetupStep {
  readonly step: "install" | "sign-in" | "register" | "connect";
  readonly outcome: string;
  readonly detail: string;
}

export interface SetupResult {
  readonly space: string;
  readonly state: ServiceConnectionState;
  readonly steps: readonly SetupStep[];
  readonly instanceId?: string;
  readonly unit?: string;
}

export interface SetupOptions {
  readonly paths: DaemonPaths;
  readonly daemonHome: string | undefined;
  readonly space: string;
  readonly idp?: string;
  readonly clientId?: string;
  readonly peerUid: PeerUid;
  readonly peerPid: PeerPid;
  /** Seconds to wait for the space owner's approval. 0 reports what it reached and stops. */
  readonly waitSeconds: number;
  /** Progress for a terminal, one line per step. */
  readonly report: (line: string) => void;
  /** The device-code prompt, shown the way `cotal daemon login` shows it. */
  readonly onPrompt: (prompt: LoginPrompt) => void;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Wait for the daemon to answer its endpoint after a start, so the steps below reach a live one. */
async function waitForDaemon(opts: SetupOptions, seconds: number): Promise<void> {
  const deadline = Date.now() + seconds * 1000;
  let last: unknown;
  for (;;) {
    try {
      const reply = await queryDaemon({ paths: opts.paths, peerUid: opts.peerUid, peerPid: opts.peerPid });
      if (reply.ok) return;
      last = reply.error;
    } catch (e) {
      // NOT_RUNNING and PEER_NOT_LOCK_OWNER are both "not up yet" while a unit is starting.
      if (!(e instanceof EndpointRefusal) || (e.code !== "NOT_RUNNING" && e.code !== "PEER_NOT_LOCK_OWNER")) throw e;
      last = e.message;
    }
    if (Date.now() >= deadline) {
      throw new CommandFailure("failed", "DEPENDENCY_UNAVAILABLE", `the daemon did not answer ${opts.paths.socket} within ${seconds}s of being started; nothing was registered`, {
        remedy: "read its unit with systemctl --user status, then run this again",
        ...(typeof last === "string" ? { native: { code: "NOT_ANSWERING" } } : {}),
      });
    }
    await sleep(250);
  }
}

/** Whether a daemon answers this endpoint right now. Any refusal means no. */
async function daemonAnswers(opts: SetupOptions): Promise<boolean> {
  try {
    const reply = await queryDaemon({ paths: opts.paths, peerUid: opts.peerUid, peerPid: opts.peerPid });
    return reply.ok;
  } catch { return false; }
}

/** Install the user service unless it is already installed, then wait for the daemon to answer. */
async function ensureInstalled(opts: SetupOptions, steps: SetupStep[]): Promise<string | undefined> {
  let unit: string | undefined;
  let outcome: string, detail: string;
  try {
    // A recorded, unchanged unit means this is already installed; `planUninstall` is the exact
    // same check `uninstall` makes, so the two can never disagree about what is installed.
    const existing = planUninstall(opts.paths);
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
        remedy: "stop that daemon and run this again, or keep it and run `cotal daemon register` and `cotal daemon service-connect` by hand",
        native: { code: "RUNNING_WITHOUT_UNIT" },
      });
    }
    const installed = applyInstall(opts.paths, opts.daemonHome);
    unit = installed.unit;
    outcome = "installed";
    detail = `${installed.unit} installed, ${installed.lingerAlready ? "linger was already enabled" : "linger enabled"}, restart ${installed.restart}, started by ${installed.wantedBy}`;
  }
  steps.push({ step: "install", outcome, detail });
  opts.report(`service: ${detail}`);
  await waitForDaemon(opts, 60);
  opts.report(`service: the daemon answers at ${opts.paths.socket}`);
  return unit;
}

/** Sign in by device code, but only when the space says this machine is not signed in. */
async function ensureSignedIn(opts: SetupOptions, steps: SetupStep[]): Promise<void> {
  const check = await connectCheckViaDaemon({ paths: opts.paths, peerUid: opts.peerUid, peerPid: opts.peerPid, space: opts.space });
  if (!check.ok) throw new CommandFailure("refused", "USAGE_INVALID", `the daemon refused the connection check: ${check.code} ${check.message}`, { native: { code: check.code } });
  if (check.result.outcome !== "not-signed-in") {
    // Only `not-signed-in` is a statement about the sign-in. Every other answer, `ready-to-register`
    // or a refusal the register step will report in full, is recorded as what the check actually
    // said rather than as a sign-in this never verified.
    const signedIn = check.result.outcome === "ready-to-register";
    steps.push({ step: "sign-in", outcome: signedIn ? "already-signed-in" : "not-needed-here", detail: `the connection check answered ${check.result.outcome}` });
    opts.report(signedIn
      ? "sign-in: already signed in; no approval was needed"
      : `sign-in: skipped; the connection check answered ${check.result.outcome}`);
    return;
  }
  if (opts.idp === undefined) {
    throw new CommandFailure("refused", "AUTH_REQUIRED", "this machine is not signed in to the space's provider, so this needs --idp <auth base URL> to sign in by device code; nothing was registered", {
      remedy: "run it again with --idp <auth base URL>",
      native: { code: "NOT_SIGNED_IN" },
    });
  }
  opts.report("sign-in: approve this machine on another device");
  const reply = await loginViaDaemon({
    paths: opts.paths, peerUid: opts.peerUid, peerPid: opts.peerPid, idp: opts.idp,
    ...(opts.clientId !== undefined ? { clientId: opts.clientId } : {}),
    onPrompt: opts.onPrompt,
  });
  if (!reply.ok) throw new CommandFailure("failed", "OPERATION_FAILED", `the daemon refused the sign-in: ${reply.code} ${reply.message}`, { native: { code: reply.code } });
  const r = reply.result;
  if (r.outcome === "cancelled") throw new CommandFailure("refused", "USAGE_INVALID", "the sign-in was cancelled on this machine; nothing was saved and nothing was registered", { native: { code: "CANCELLED" } });
  if (r.outcome === "failed") {
    const native = { native: { code: r.reason.toUpperCase() } };
    if (r.reason === "unreachable") throw new CommandFailure("refused", "DEPENDENCY_UNAVAILABLE", `${r.message}; no session was saved and nothing was registered`, native);
    if (r.reason === "denied" || r.reason === "expired") throw new CommandFailure("refused", "PERMISSION_DENIED", `${r.message}; no session was saved and nothing was registered`, native);
    throw new CommandFailure("failed", "OPERATION_FAILED", `${r.message}; a session may have been saved before the failure, so run this again`, native);
  }
  steps.push({ step: "sign-in", outcome: "signed-in", detail: `signed in as ${r.label || r.sub}` });
  opts.report(`sign-in: signed in as ${r.label || r.sub}`);
}

/** Ask the space to register this daemon. Replaying an existing request is the same call. */
async function requestRegistration(opts: SetupOptions, steps: SetupStep[]): Promise<void> {
  const reply = await registerViaDaemon({ paths: opts.paths, peerUid: opts.peerUid, peerPid: opts.peerPid, space: opts.space });
  if (!reply.ok) throw new CommandFailure("refused", "USAGE_INVALID", `the daemon refused the registration request: ${reply.code} ${reply.message}`, { native: { code: reply.code } });
  const r = reply.result;
  const native = { native: { code: (r.outcome === "refused" && "reason" in r ? r.reason : r.outcome).toUpperCase().replaceAll("-", "_") } };
  if (r.outcome === "not-registered") throw new CommandFailure("refused", "TARGET_NOT_FOUND", r.message, native);
  if (r.outcome === "not-user-auth" || r.outcome === "unsupported-by-space") throw new CommandFailure("refused", "UNSUPPORTED", r.message, native);
  if (r.outcome === "not-signed-in") throw new CommandFailure("refused", "AUTH_REQUIRED", r.message, native);
  if (r.outcome === "unreachable") throw new CommandFailure("refused", "DEPENDENCY_UNAVAILABLE", r.message, native);
  if (r.outcome === "account-mismatch" || r.outcome === "conflict") throw new CommandFailure("refused", "CONFLICT", r.message, native);
  if (r.outcome === "refused") throw new CommandFailure("refused", "reason" in r ? "PERMISSION_DENIED" : "DEPENDENCY_UNAVAILABLE", r.message, native);
  if (r.outcome !== "approval-required" && r.outcome !== "pending" && r.outcome !== "registered") throw new CommandFailure("unknown", "OPERATION_UNKNOWN", r.message, native);
  steps.push({ step: "register", outcome: r.outcome, detail: `${r.endpoint} instance ${r.instanceId}, request ${r.requestId}` });
  opts.report(`register: ${r.outcome}, service ${r.endpoint}, instance ${r.instanceId}`);
}

/** States that will not become `connected` however long anyone waits. */
const TERMINAL = new Set<ServiceConnectionState>(["refused", "ended", "conflict", "unsupported", "not-registered", "not-requested", "not-signed-in"]);

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
      return { state: r.state, ...(r.instanceId ? { instanceId: r.instanceId } : {}), message: r.message };
    }
    if (!announced) {
      announced = true;
      opts.report(r.state === "approval-pending"
        ? `connect: waiting up to ${opts.waitSeconds}s for the space owner to approve this machine`
        : `connect: ${r.state}; retrying for up to ${opts.waitSeconds}s`);
    }
    await sleep(Math.min(5000, Math.max(0, deadline - Date.now())));
  }
}

/** Run the whole path. Only a connected machine is a success; every other end is a refusal. */
export async function runSetup(opts: SetupOptions): Promise<SetupResult> {
  const steps: SetupStep[] = [];
  const unit = await ensureInstalled(opts, steps);
  await ensureSignedIn(opts, steps);
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
        ? `ask the space owner to approve this machine, then run \`cotal daemon setup --space ${opts.space}\` again`
        : `read \`cotal daemon service-status --space ${opts.space}\`, then run \`cotal daemon setup --space ${opts.space}\` again`,
      native, target,
    });
  }
  // A state that cannot improve is a refusal, carrying the space's own reason.
  const code = end.state === "not-requested" || end.state === "not-registered" ? "TARGET_NOT_FOUND"
    : end.state === "unsupported" ? "UNSUPPORTED"
    : end.state === "not-signed-in" ? "AUTH_REQUIRED"
    : end.state === "conflict" ? "CONFLICT"
    : "PERMISSION_DENIED";
  throw new CommandFailure("refused", code, `${end.message}. The daemon is installed and running, and nothing is connected`, {
    remedy: `read \`cotal daemon service-status --space ${opts.space}\``,
    native, target,
  });
}
