/**
 * Repair: check this computer's background service and fix what can be fixed from here, in order.
 *
 * `planRepair` reads and changes nothing. It returns each step with what it found and what it would
 * change, plus a digest of the plan. `applyRepair` takes that digest and refuses `PLAN_CHANGED` when
 * the computer does not match it, so a person always approves what runs and nothing else.
 *
 * A step needs consent when it stops something the person may be using: moving the background
 * service from another Cotal installation, which stops every agent it runs, and starting a
 * service the person stopped. Every other step is safe to run without asking.
 *
 * Moving the service keeps every record in the daemon home: sign-in, this computer's identity and
 * each space's service records. Only the native registration changes (see `applyMove`).
 */
import { createHash } from "node:crypto";
import { lstatSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { CommandFailure } from "@cotal-ai/workspace";
import type { DaemonPaths, PeerPid, PeerUid } from "./endpoint.js";
import { EndpointRefusal } from "./endpoint.js";
import { managerViaDaemon, queryDaemon } from "./client.js";
import { answeringAt, applyInstall, applyMove, installationOwner, installedDaemonIdentity, preflightInstalledDaemon, restartInstalled, startInstalled } from "./install.js";
import { unitReceiptFile } from "./install-receipt.js";
import { desktopAppRequest } from "./desktop-app-routing.js";
import type { AgentAppResult } from "./desktop-agent-apps.js";
import type { DaemonStatus, HostedManager } from "./protocol.js";
import { withAppMutation } from "./agent-app-admission.js";

/** Which Cotal copy runs the background service. Only its kind is public, never its path. */
export type ServiceOwner = ReturnType<typeof installationOwner>;

export type RepairStepName = "service-owner" | "service-running" | "agent-apps" | "spaces" | "stale-registration" | "account";
export const REPAIR_CONSENTS = ["takeover", "start-stopped", "remove-old-registration"] as const;
export type RepairConsent = (typeof REPAIR_CONSENTS)[number];
export type RepairOutcome = "ok" | "fix" | "needs-you" | "cannot" | "unchecked";

export interface RepairStep {
  readonly step: RepairStepName;
  readonly outcome: RepairOutcome;
  /** What the step found, in plain words. */
  readonly found: string;
  /** What applying the plan would change. Present only when `outcome` is "fix". */
  readonly change?: string;
  /** A fix that stops something the person may be using or removes a registration. Apply must name it in `consent`. */
  readonly consent?: RepairConsent;
  /** The space a per-space step acts on. */
  readonly space?: string;
  /** Agents the change stops, by space, name and agent app. */
  readonly agents?: readonly { readonly space: string; readonly name: string; readonly application: string }[];
  /** The agents could not be read, so `agents` may be incomplete: any agent the service runs stops. */
  readonly agentsUnknown?: true;
  /** The spaces the spaces step starts. It starts these and no others. */
  readonly spaces?: readonly string[];
  /** The one thing in the app that fixes a "cannot" step. */
  readonly action?: "update" | "reinstall";
  /** A stale-registration step for a space the person disconnected: it stays disconnected. */
  readonly disconnected?: true;
  readonly owner?: ServiceOwner;
}

/** A step as applied: what changed, or why it stopped. */
export type AppliedStep = RepairStep & {
  readonly changed?: string;
  /** The step did not finish, in plain words. Steps after it did not run. */
  readonly failed?: string;
  /** What the service said, for Details. */
  readonly detail?: string;
};

export interface RepairPlan {
  readonly digest: string;
  readonly steps: readonly RepairStep[];
}

export interface RepairResult {
  readonly steps: readonly AppliedStep[];
  readonly repaired: boolean;
  /** What a new check finds still needs fixing, when it could be read. */
  readonly remaining?: readonly RepairStep[];
}

export interface RepairOptions {
  readonly paths: DaemonPaths;
  readonly daemonHome: string | undefined;
  readonly version: string;
  readonly peerUid?: PeerUid;
  readonly peerPid?: PeerPid;
  readonly report?: (line: string) => void;
}

const APPLICATIONS: Record<string, string> = { claude: "Claude Code", codex: "Codex", hermes: "Hermes", jcode: "Jcode", opencode: "OpenCode", pi: "pi" };

/** What planning reads. `planFrom` turns it into steps without reading anything else. */
export interface RepairProbe {
  readonly status: DaemonStatus | undefined;
  /** A service may be running but its status could not be read, so the agents it runs are unknown. */
  readonly statusUnknown: boolean;
  readonly service:
    | { readonly kind: "none" }
    | { readonly kind: "this" }
    | { readonly kind: "other"; readonly installed: string; readonly entry: string; readonly version?: string }
    /** The service record could not be verified, so nothing about it can be changed safely. */
    | { readonly kind: "unverified" };
}

async function readStatus(opts: RepairOptions): Promise<{ readonly status?: DaemonStatus; readonly unknown: boolean }> {
  try {
    const reply = await queryDaemon({ paths: opts.paths, peerUid: opts.peerUid, peerPid: opts.peerPid });
    return reply.ok ? { status: reply.result, unknown: false } : { unknown: true };
  } catch (error) {
    if (error instanceof EndpointRefusal && error.code === "NOT_RUNNING") return { unknown: false };
    if (error instanceof EndpointRefusal && error.code === "PEER_NOT_LOCK_OWNER") return { unknown: true };
    throw error;
  }
}

/** The version an installation's `package.json` names, beside its `dist/cotal.js`. */
function packageVersion(entry: string): string | undefined {
  try {
    const version = (JSON.parse(readFileSync(join(dirname(dirname(entry)), "package.json"), "utf8")) as { version?: unknown }).version;
    return typeof version === "string" ? version : undefined;
  } catch { return undefined; }
}

/** A refusal while reading the service record becomes a plan that says so, never a thrown error the
 *  window would answer with the same Repair. Anything else is not a refusal and still throws. */
export function probeFailure(error: unknown): RepairProbe | undefined {
  const code = (error as { code?: unknown } | undefined)?.code;
  return code === "CONFLICT" || code === "TARGET_NOT_FOUND" ? { status: undefined, statusUnknown: true, service: { kind: "unverified" } } : undefined;
}

/** Read this computer for planning. Changes nothing. */
export async function probeRepair(opts: RepairOptions): Promise<RepairProbe> {
  try { return await readProbe(opts); }
  catch (error) { const probe = probeFailure(error); if (probe) return probe; throw error; }
}

async function readProbe(opts: RepairOptions): Promise<RepairProbe> {
  const { status, unknown } = await readStatus(opts);
  if (!preflightInstalledDaemon(opts.paths, opts.daemonHome)) return { status, statusUnknown: unknown, service: { kind: "none" } };
  const identity = installedDaemonIdentity(opts.paths, opts.daemonHome);
  if (identity.same) return { status, statusUnknown: unknown, service: { kind: "this" } };
  return { status, statusUnknown: unknown, service: { kind: "other", installed: identity.installed, entry: identity.installedEntry, version: status?.version ?? packageVersion(identity.installedEntry) } };
}

/** Order two release versions; undefined when either is not one. A prerelease sorts before its release. */
export function compareVersions(a: string, b: string): number | undefined {
  const parse = (value: string) => /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+.*)?$/.exec(value);
  const left = parse(a), right = parse(b);
  if (!left || !right) return undefined;
  for (let i = 1; i <= 3; i++) if (Number(left[i]) !== Number(right[i])) return Number(left[i]) - Number(right[i]);
  if (!left[4] || !right[4]) return left[4] ? -1 : right[4] ? 1 : 0;
  const l = left[4].split("."), r = right[4].split(".");
  for (let i = 0; i < Math.max(l.length, r.length); i++) {
    if (l[i] === undefined || r[i] === undefined) return l[i] === undefined ? -1 : 1;
    if (l[i] === r[i]) continue;
    const ln = /^\d+$/.test(l[i]!), rn = /^\d+$/.test(r[i]!);
    if (ln && rn) return Number(l[i]) - Number(r[i]);
    return ln ? -1 : rn ? 1 : l[i]! < r[i]! ? -1 : 1;
  }
  return 0;
}

/** The service's agents cannot be listed: its status or one of its agent rows could not be read. */
function agentsUnknown(probe: RepairProbe): boolean {
  if (probe.statusUnknown) return true;
  if (!probe.status) return false;
  return !probe.status.agents || probe.status.agents.some(row => row.state !== "read");
}

function runningAgents(status: DaemonStatus | undefined): NonNullable<RepairStep["agents"]> {
  return (status?.agents ?? []).flatMap(row => row.state === "read"
    ? row.agents.filter(agent => agent.state === "running").map(agent => ({ space: row.space, name: agent.name, application: APPLICATIONS[agent.application] ?? agent.application }))
    : []);
}

/** The service step: is the background service installed by this installation? */
function ownerStep(probe: RepairProbe, version: string): RepairStep {
  const { status, service } = probe;
  if (service.kind === "unverified") return { step: "service-owner", outcome: "cannot", action: "reinstall", found: "Cotal can't confirm the background service on this computer is the one it set up, so Repair won't change it. Download Cotal and install it again to replace the service." };
  if (service.kind === "none") {
    // Started by hand or by a container, with no unit to stop: nothing here can stop it safely.
    if (status) return { step: "service-owner", outcome: "cannot", found: "A background service is running that Cotal did not set up, so Repair can't change it. Restart this computer to stop it, then choose Repair." };
    return { step: "service-owner", outcome: "fix", found: "The background service is not set up.", change: "Set up the background service." };
  }
  if (service.kind === "this") return { step: "service-owner", outcome: "ok", found: "This copy of Cotal runs the background service." };
  const owner = installationOwner(service.entry);
  // A move never replaces a newer service with this older app, nor one whose version it can't tell.
  const order = service.version === undefined ? undefined : compareVersions(service.version, version);
  if (order === undefined) return { step: "service-owner", outcome: "cannot", owner, action: "update", found: "Cotal can't tell which version the other copy is, so it won't replace it with this one. Update this app, then repair again." };
  if (order > 0)
    return { step: "service-owner", outcome: "cannot", owner, action: "update", found: "A newer copy of Cotal runs the background service. Update this app, then repair again." };
  const agents = runningAgents(status);
  const unknown = agentsUnknown(probe);
  return {
    step: "service-owner", outcome: "fix", consent: "takeover", owner, agents, ...(unknown ? { agentsUnknown: true as const } : {}),
    found: owner.kind === "app" ? "Another copy of the Cotal app runs the background service." : "A command-line install of Cotal runs the background service.",
    change: unknown ? "Use this app for the background service. Any agents it runs stop."
      : agents.length ? `Use this app for the background service. ${agents.length === 1 ? "1 agent stops" : `${agents.length} agents stop`}.` : "Use this app for the background service.",
  };
}

/** A step that could not be checked yet, because an earlier one must be fixed first. Not fine, not broken. */
const unchecked = (step: RepairStepName, found: string): RepairStep => ({ step, outcome: "unchecked", found });

function runningStep(status: DaemonStatus | undefined, version: string, owner: RepairStep): RepairStep {
  if (owner.outcome !== "ok") return unchecked("service-running", "Not checked yet: the background service must be set up first.");
  // The person may have stopped it, so starting it asks first.
  if (!status) return { step: "service-running", outcome: "fix", consent: "start-stopped", found: "The background service is not running.", change: "Start the background service." };
  if (status.version !== version) return { step: "service-running", outcome: "fix", found: "The background service runs a different version than this app.", change: "Restart the background service when no agent is running." };
  return { step: "service-running", outcome: "ok", found: "The background service is running." };
}

function appsStep(status: DaemonStatus | undefined): RepairStep {
  const missing = (status?.managers ?? []).filter(manager => manager.state === "answering" && !manager.connectors?.some(connector => connector.state === "available"));
  if (!status) return unchecked("agent-apps", "Not checked yet: the background service must be running first.");
  if (missing.length) return { step: "agent-apps", outcome: "fix", found: "The background service has not found your agent apps.", change: "Let the background service find your agent apps." };
  return { step: "agent-apps", outcome: "ok", found: "The background service finds your agent apps." };
}

/** A refused space this computer still means to host, with no registration removal waiting. A space the
 *  person disconnected keeps a refusal from disconnect; starting it would host it again. */
const restartable = (manager: HostedManager): boolean =>
  manager.state === "refused" && manager.hostingIntent === true && manager.registrationCleanup === undefined && !staleCleanup(manager);

function spacesStep(status: DaemonStatus | undefined): RepairStep {
  const refused = (status?.managers ?? []).filter(restartable);
  if (!status) return unchecked("spaces", "Not checked yet: the background service must be running first.");
  if (refused.length) return { step: "spaces", outcome: "fix", spaces: refused.map(manager => manager.space), found: `${refused.length === 1 ? "1 space has" : `${refused.length} spaces have`} stopped on this computer.`, change: "Start those spaces again." };
  return { step: "spaces", outcome: "ok", found: "Every space on this computer is running." };
}

/** Disconnect's refusal when the cleanup record names an older instance than the current one. */
const staleCleanup = (manager: HostedManager): boolean => /Manager cleanup identity differs from its recorded instance/.test(`${manager.reason ?? ""} ${manager.lastRefusal ?? ""}`);

/** One step per space with an old registration of this computer's agent host left in it. */
function staleCleanupSteps(status: DaemonStatus | undefined): RepairStep[] {
  return (status?.managers ?? []).filter(staleCleanup).map(manager => ({
    step: "stale-registration", outcome: "fix", consent: "remove-old-registration", space: manager.space,
    found: `An old copy of this computer's agent host is still registered in ${manager.space}.`,
    ...(manager.hostingIntent === true
      ? { change: "Remove the old registration and start the agent host again." }
      : { change: "Remove the old registration. This space stays disconnected from this computer.", disconnected: true as const }),
  }));
}

/** Each signed-in account that needs the person to sign in again. A short Cloud outage (`cloud.state` retrying)
 *  is not one: the service retries by itself, so Repair leaves it alone. A removed computer or an expired
 *  sign-in needs the person to sign in again, which Repair cannot do for them. */
export function accountSteps(status: DaemonStatus | undefined): RepairStep[] {
  const account = status?.account;
  const accounts = account?.accounts ?? (account ? [account] : []);
  return accounts.filter(item => item.mode === "sign-in-required").map(item => {
    const removed = (item as { reason?: unknown }).reason === "computer-removed";
    let host = "your account";
    try { if (item.idpUrl) host = new URL(item.idpUrl).host; } catch { /* keep the generic name */ }
    // Name the provider when it is known, the host otherwise.
    if (host === "cotal.cloud" || host === "cloud.cotal.ai") host = "Cotal Cloud";
    return {
      step: "account", outcome: "needs-you", space: item.idpUrl,
      found: removed ? "This computer was removed from your account. Sign in to add it back." : `Sign in to ${host} again to keep using this computer from your spaces.`,
    } satisfies RepairStep;
  });
}

function digestOf(steps: readonly RepairStep[]): string {
  return createHash("sha256").update(JSON.stringify(steps.map(({ step, outcome, consent, owner, agents, agentsUnknown, space, spaces, disconnected }) => ({ step, outcome, consent, owner, agents, agentsUnknown, space, spaces, disconnected })))).digest("hex");
}

/** The plan for what `probeRepair` read, for `version`, this installation's version. */
export function planFrom(probe: RepairProbe, version: string): RepairPlan {
  const { status } = probe;
  const owner = ownerStep(probe, version);
  const steps = [owner, runningStep(status, version, owner), appsStep(status), spacesStep(status), ...staleCleanupSteps(status), ...accountSteps(status)];
  return { digest: digestOf(steps), steps };
}

/** Read this computer and say what Repair would do. Changes nothing. */
export async function planRepair(opts: RepairOptions): Promise<RepairPlan> {
  return planFrom(await probeRepair(opts), opts.version);
}

/** Why a step did not finish, in words the window can show, and what the person can do next. */
export function failedCopy(error: unknown): string {
  const code = (error as { native?: { code?: unknown } } | undefined)?.native?.code;
  if (code === "MOVE_ROLLED_BACK") return "This app's service didn't start, so the other copy of Cotal runs the background service again. The agents it ran stopped and don't start again by themselves. Keep using the other copy for now, and update this app before trying again.";
  if (code === "MOVE_RESTORE_FAILED") return "This app's service didn't start, and the other copy's service didn't start again either, so no background service runs on this computer. Choose Repair to set up this app's service.";
  if (code === "MOVE_UNCONFIRMED") return "Repair could not confirm the other copy's service stopped. Choose Repair again to check this computer.";
  if (code === "SPACE_NOT_STARTED") return "A space's agent host didn't start. Details shows what it said. If it names a permission, ask the space owner.";
  if (code === "CLEANUP_UNFINISHED") return (error as Error).message;
  if ((error as { code?: unknown } | undefined)?.code === "LIFECYCLE_BLOCKED") return "Another change is running on this computer. Wait for it to finish, then choose Repair again.";
  return "Repair could not finish this step. Details shows what the background service said.";
}

/** Run each fix step of an approved plan in order. A step that fails ends the run: it and the steps
 *  before it are returned as they are, and `onError` receives the failure. `gate` wraps each run of
 *  steps that change the service; a step `outside` the gate runs between those runs. */
export async function runSteps(steps: readonly RepairStep[], fix: (step: RepairStep) => Promise<string>, report?: (line: string) => void, onError?: (error: unknown) => void,
  gate: <T>(run: () => Promise<T>) => Promise<T> = run => run(), outside: (step: RepairStep) => boolean = () => false): Promise<AppliedStep[]> {
  const done: AppliedStep[] = [];
  let stopped = false;
  const one = async (step: RepairStep) => {
    if (stopped || step.outcome !== "fix") { done.push(step); return; }
    report?.(step.change!);
    try { done.push({ ...step, changed: await fix(step) }); }
    catch (error) {
      stopped = true;
      onError?.(error);
      done.push({ ...step, failed: failedCopy(error), detail: (error instanceof Error ? error.message : String(error)).slice(0, 1500) });
    }
  };
  for (let i = 0; i < steps.length;) {
    if (outside(steps[i]!)) { await one(steps[i++]!); continue; }
    let end = i;
    while (end < steps.length && !outside(steps[end]!)) end++;
    const run = steps.slice(i, end);
    const work = async () => { for (const step of run) await one(step); };
    // A gate refusal before any step ran is that run's first fix step failing; nothing changed.
    if (!stopped && run.some(step => step.outcome === "fix")) {
      try { await gate(work); }
      catch (error) {
        stopped = true; onError?.(error);
        const first = run.findIndex(step => step.outcome === "fix");
        run.forEach((step, index) => done.push(index === first ? { ...step, failed: failedCopy(error), detail: (error as Error).message.slice(0, 1500) } : step));
      }
    } else await work();
    i = end;
  }
  return done;
}

/** The spaces fix: start the spaces the plan named that still need it, and report each one's real result.
 *  A space that stays stopped fails the step, naming what the agent host said. */
export async function startSpaces(step: RepairStep, read: () => Promise<DaemonStatus | undefined>, start: (space: string) => Promise<HostedManager | DaemonStatus>): Promise<string> {
  const status = await read();
  const named = new Set(step.spaces ?? []);
  const started: string[] = [], stopped: { space: string; reason: string }[] = [];
  for (const manager of (status?.managers ?? []).filter(item => named.has(item.space) && restartable(item))) {
    const view = await start(manager.space) as HostedManager;
    if (view.state === "answering" || view.state === "starting") started.push(manager.space);
    else stopped.push({ space: manager.space, reason: view.reason ?? view.lastRefusal ?? "it did not answer" });
  }
  const list = (items: readonly string[]) => new Intl.ListFormat("en", { type: "conjunction" }).format(items);
  const done = started.length ? `${list(started)} ${started.length === 1 ? "was" : "were"} started again.` : "";
  if (!stopped.length) return done || "Nothing needed to start.";
  const failure = new CommandFailure("refused", "DEPENDENCY_UNAVAILABLE", `${done ? `${done} ` : ""}${list(stopped.map(item => item.space))} did not start: ${stopped.map(item => item.reason).join("; ")}`.slice(0, 1500), { native: { code: "SPACE_NOT_STARTED", detail: { spaces: stopped.map(item => item.space) } } });
  throw failure;
}

/** Run the plan the person approved. Refuses when the computer changed since that plan. */
export async function applyRepair(opts: RepairOptions & { readonly digest: string; readonly consent: readonly RepairConsent[]; readonly throwOnFailure?: boolean }): Promise<RepairResult> {
  const plan = await planRepair(opts);
  if (plan.digest !== opts.digest) throw new CommandFailure("refused", "CONFLICT", "this computer changed since Repair checked it; nothing was changed", { native: { code: "PLAN_CHANGED" } });
  const missing = plan.steps.find(step => step.outcome === "fix" && step.consent && !opts.consent.includes(step.consent));
  if (missing) throw new CommandFailure("refused", "LIFECYCLE_BLOCKED", "Repair needs your approval for this step; nothing was changed", { native: { code: "CONSENT_REQUIRED", detail: { step: missing.step } } });
  let failure: unknown;
  // The agent-app admission gate covers every step that changes the service, so no agent-app install,
  // sign-in or pickup runs across a set-up, start, restart, move or space start. The agent-apps step
  // goes through the agent-app routing, which takes the same gate itself, so it runs between them.
  const done = await runSteps(plan.steps, step => fix(opts, step), opts.report, error => { failure = error; },
    run => withAppMutation(opts.paths, run), step => step.step === "agent-apps");
  // The command line reports a failed step as its refusal; the window reads the partial result.
  if (failure !== undefined && opts.throwOnFailure) throw failure;
  let remaining: RepairStep[] | undefined;
  try { remaining = (await planRepair(opts)).steps.filter(step => step.outcome !== "ok"); } catch { remaining = undefined; }
  return { steps: done, repaired: failure === undefined && remaining?.length === 0, ...(remaining ? { remaining } : {}) };
}

/** What the agent-apps pickup answered, in plain words. A reply that does not confirm the service
 *  picked the apps up is a failed step; agents still running is waiting, not fixed. */
export function pickupOutcome(result: AgentAppResult): string {
  const refresh = result.serviceRefresh;
  if (refresh?.state === "refreshed") return "The background service looked for your agent apps again.";
  if (refresh?.state === "pending" && refresh.reason === "agents-running") return "The background service picks up your agent apps once the running agents finish.";
  throw new Error("the background service did not confirm it picked up your agent apps");
}

async function fix(opts: RepairOptions, step: RepairStep): Promise<string> {
  if (step.step === "service-owner" && step.consent === "takeover") {
    // The new service's startup never takes the admission gate, so waiting for it to answer cannot deadlock.
    const identity = installedDaemonIdentity(opts.paths, opts.daemonHome);
    const moved = await applyMove(opts.paths, opts.daemonHome, { from: identity.installed, version: opts.version }, line => opts.report?.(line));
    return `This app now runs the background service. ${moved.spaces.length === 1 ? "1 space was" : `${moved.spaces.length} spaces were`} kept.`;
  }
  if (step.step === "service-owner") {
    applyInstall(opts.paths, opts.daemonHome);
    return "The background service was set up.";
  }
  if (step.step === "service-running") {
    lstatSync(unitReceiptFile(opts.paths));
    const { status } = await readStatus(opts);
    if (!status) {
      await startInstalled(opts.paths, opts.daemonHome, opts.version, line => opts.report?.(line));
      await answeringAt(opts.paths, opts.version, 60_000);
      return "The background service was started.";
    }
    // An older service restarts only through the idle fence: running agents keep it waiting.
    const hosted = (status.managers ?? []).some(manager => manager.state !== "stopped");
    if (hosted) await managerViaDaemon(opts, { op: "managers-prepare-restart" });
    try { await restartInstalled(opts.paths, opts.daemonHome, false, opts.version, line => opts.report?.(line)); }
    catch (error) {
      if (hosted && process.platform !== "win32") await managerViaDaemon(opts, { op: "managers-abort-restart" }).catch(() => undefined);
      throw error;
    }
    return "The background service was restarted with this version.";
  }
  if (step.step === "agent-apps") {
    // The agent-app routing's pickup entry takes the agent-app admission itself, so no gate wraps it here.
    return pickupOutcome(await desktopAppRequest({ paths: opts.paths, home: opts.daemonHome, version: opts.version, peerUid: opts.peerUid, peerPid: opts.peerPid }, { op: "agent-apps", refresh: true }, line => opts.report?.(line)));
  }
  if (step.step === "stale-registration") {
    const result = await managerViaDaemon(opts, { op: "manager-repair-cleanup", space: step.space! }) as HostedManager & { repair?: { state?: unknown; message?: unknown; detail?: unknown } };
    // Removed, but the start or disconnect after it did not finish: a failed step in its own words.
    if (result.repair?.state === "removed-unfinished" && typeof result.repair.message === "string")
      throw Object.assign(new Error(result.repair.message), { native: { code: "CLEANUP_UNFINISHED", detail: { reason: result.repair.detail } } });
    return typeof result.repair?.message === "string" ? result.repair.message : "The space did not confirm removing the old registration, so Repair left it as it was.";
  }
  return startSpaces(step, async () => (await readStatus(opts)).status, space => managerViaDaemon(opts, { op: "manager-start", space }));
}
