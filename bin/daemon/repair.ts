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
import { lstatSync } from "node:fs";
import { CommandFailure } from "@cotal-ai/workspace";
import type { DaemonPaths, PeerPid, PeerUid } from "./endpoint.js";
import { EndpointRefusal } from "./endpoint.js";
import { managerViaDaemon, queryDaemon } from "./client.js";
import { applyInstall, applyMove, installedDaemonIdentity, preflightInstalledDaemon, restartInstalled, startInstalled } from "./install.js";
import { unitReceiptFile } from "./install-receipt.js";
import { refreshServiceForApplication, type InstallOptions } from "./setup.js";
import type { DaemonStatus, HostedManager } from "./protocol.js";
import { serviceOwner, type ServiceOwner } from "./service-owner.js";
import { withAppMutation } from "./agent-app-admission.js";

export { serviceOwner, type ServiceOwner };

export type RepairStepName = "service-owner" | "service-running" | "agent-apps" | "spaces" | "stale-registration";
export const REPAIR_CONSENTS = ["takeover", "start-stopped", "remove-old-registration"] as const;
export type RepairConsent = (typeof REPAIR_CONSENTS)[number];
export type RepairOutcome = "ok" | "fix" | "needs-you" | "cannot";

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
  readonly owner?: ServiceOwner;
}

export interface RepairPlan {
  readonly digest: string;
  readonly steps: readonly RepairStep[];
}

export interface RepairResult {
  readonly steps: readonly (RepairStep & { readonly changed?: string })[];
  readonly repaired: boolean;
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

async function readStatus(opts: RepairOptions): Promise<DaemonStatus | undefined> {
  try {
    const reply = await queryDaemon({ paths: opts.paths, peerUid: opts.peerUid, peerPid: opts.peerPid });
    return reply.ok ? reply.result : undefined;
  } catch (error) {
    if (error instanceof EndpointRefusal && (error.code === "NOT_RUNNING" || error.code === "PEER_NOT_LOCK_OWNER")) return undefined;
    throw error;
  }
}

function runningAgents(status: DaemonStatus | undefined): NonNullable<RepairStep["agents"]> {
  return (status?.agents ?? []).flatMap(row => row.state === "read"
    ? row.agents.filter(agent => agent.state === "running").map(agent => ({ space: row.space, name: agent.name, application: APPLICATIONS[agent.application] ?? agent.application }))
    : []);
}

/** The service step: is the background service installed by this installation? */
function ownerStep(opts: RepairOptions, status: DaemonStatus | undefined): RepairStep {
  if (!preflightInstalledDaemon(opts.paths, opts.daemonHome)) {
    if (status) return { step: "service-owner", outcome: "cannot", found: "A background service runs that Cotal did not install. Stop it, then repair again." };
    return { step: "service-owner", outcome: "fix", found: "The background service is not set up.", change: "Set up the background service." };
  }
  const identity = installedDaemonIdentity(opts.paths, opts.daemonHome);
  if (identity.same) return { step: "service-owner", outcome: "ok", found: "This copy of Cotal runs the background service." };
  const owner = serviceOwner(identity.installedEntry);
  const agents = runningAgents(status);
  return {
    step: "service-owner", outcome: "fix", consent: "takeover", owner, agents,
    found: owner.kind === "app" ? "Another copy of the Cotal app runs the background service." : "A command-line install of Cotal runs the background service.",
    change: agents.length ? `Use this app for the background service. ${agents.length === 1 ? "1 agent stops" : `${agents.length} agents stop`}.` : "Use this app for the background service.",
  };
}

function runningStep(opts: RepairOptions, status: DaemonStatus | undefined, owner: RepairStep): RepairStep {
  if (owner.outcome !== "ok") return { step: "service-running", outcome: "ok", found: "Checked after the service is set up." };
  if (!status) return { step: "service-running", outcome: "fix", found: "The background service is not running.", change: "Start the background service." };
  if (status.version !== opts.version) return { step: "service-running", outcome: "fix", found: "The background service runs an older version.", change: "Restart the background service when no agent is running." };
  return { step: "service-running", outcome: "ok", found: "The background service is running." };
}

function appsStep(status: DaemonStatus | undefined): RepairStep {
  const missing = (status?.managers ?? []).filter(manager => manager.state === "answering" && !manager.connectors?.some(connector => connector.state === "available"));
  if (!status) return { step: "agent-apps", outcome: "ok", found: "Checked after the service is running." };
  if (missing.length) return { step: "agent-apps", outcome: "fix", found: "The background service has not found your agent apps.", change: "Let the background service find your agent apps." };
  return { step: "agent-apps", outcome: "ok", found: "The background service finds your agent apps." };
}

function spacesStep(status: DaemonStatus | undefined): RepairStep {
  const refused = (status?.managers ?? []).filter(manager => manager.state === "refused" && !staleCleanup(manager));
  if (!status) return { step: "spaces", outcome: "ok", found: "Checked after the service is running." };
  if (refused.length) return { step: "spaces", outcome: "fix", found: `${refused.length === 1 ? "1 space has" : `${refused.length} spaces have`} stopped on this computer.`, change: "Start those spaces again." };
  return { step: "spaces", outcome: "ok", found: "Every space on this computer is running." };
}

/** Disconnect's refusal when the cleanup record names an older instance than the current one. */
const staleCleanup = (manager: HostedManager): boolean => /Manager cleanup identity differs from its recorded instance/.test(`${manager.reason ?? ""} ${manager.lastRefusal ?? ""}`);

/** One step per space with an old registration of this computer's agent host left in it. */
function staleCleanupSteps(status: DaemonStatus | undefined): RepairStep[] {
  return (status?.managers ?? []).filter(staleCleanup).map(manager => ({
    step: "stale-registration", outcome: "fix", consent: "remove-old-registration", space: manager.space,
    found: `An old copy of this computer's agent host is still registered in ${manager.space}.`,
    change: "Remove the old registration and start the agent host again.",
  }));
}

function digestOf(steps: readonly RepairStep[]): string {
  return createHash("sha256").update(JSON.stringify(steps.map(({ step, outcome, consent, owner, agents, space }) => ({ step, outcome, consent, owner, agents, space })))).digest("hex");
}

/** Read this computer and say what Repair would do. Changes nothing. */
export async function planRepair(opts: RepairOptions): Promise<RepairPlan> {
  const status = await readStatus(opts);
  const owner = ownerStep(opts, status);
  const steps = [owner, runningStep(opts, status, owner), appsStep(status), spacesStep(status), ...staleCleanupSteps(status)];
  return { digest: digestOf(steps), steps };
}

/** Run the plan the person approved. Refuses when the computer changed since that plan. */
export async function applyRepair(opts: RepairOptions & { readonly digest: string; readonly consent: readonly RepairConsent[] }): Promise<RepairResult> {
  const plan = await planRepair(opts);
  if (plan.digest !== opts.digest) throw new CommandFailure("refused", "CONFLICT", "this computer changed since Repair checked it; nothing was changed", { native: { code: "PLAN_CHANGED" } });
  const missing = plan.steps.find(step => step.outcome === "fix" && step.consent && !opts.consent.includes(step.consent));
  if (missing) throw new CommandFailure("refused", "LIFECYCLE_BLOCKED", "Repair needs your approval for this step; nothing was changed", { native: { code: "CONSENT_REQUIRED", detail: { step: missing.step } } });
  const done: (RepairStep & { changed?: string })[] = [];
  for (const step of plan.steps) {
    if (step.outcome !== "fix") { done.push(step); continue; }
    opts.report?.(step.change!);
    done.push({ ...step, changed: await fix(opts, step) });
  }
  const after = await planRepair(opts);
  return { steps: done, repaired: after.steps.every(step => step.outcome === "ok") };
}

async function fix(opts: RepairOptions, step: RepairStep): Promise<string> {
  const install: InstallOptions = { paths: opts.paths, daemonHome: opts.daemonHome, peerUid: opts.peerUid, peerPid: opts.peerPid, version: opts.version, report: line => opts.report?.(line) };
  if (step.step === "service-owner" && step.consent === "takeover") {
    // The same gate agent-app changes hold: no install or sign-in runs across the handoff.
    // The new service's startup never takes it, so waiting for it to answer cannot deadlock.
    return withAppMutation(opts.paths, async () => {
      const identity = installedDaemonIdentity(opts.paths, opts.daemonHome);
      const moved = await applyMove(opts.paths, opts.daemonHome, { from: identity.installed, version: opts.version }, line => opts.report?.(line));
      return `This app now runs the background service. ${moved.spaces.length === 1 ? "1 space was" : `${moved.spaces.length} spaces were`} kept.`;
    });
  }
  if (step.step === "service-owner") {
    applyInstall(opts.paths, opts.daemonHome);
    return "The background service was set up.";
  }
  if (step.step === "service-running") {
    lstatSync(unitReceiptFile(opts.paths));
    const status = await readStatus(opts);
    if (!status) {
      await startInstalled(opts.paths, opts.daemonHome, opts.version, line => opts.report?.(line));
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
    const outcome = await refreshServiceForApplication(install, []);
    return outcome === "refreshed" ? "The background service looked for your agent apps again." : "Nothing needed to change.";
  }
  if (step.step === "stale-registration") {
    const result = await managerViaDaemon(opts, { op: "manager-repair-cleanup", space: step.space! }) as HostedManager & { repair?: { message?: unknown } };
    return typeof result.repair?.message === "string" ? result.repair.message : "The space did not confirm removing the old registration, so Repair left it as it was.";
  }
  const status = await readStatus(opts);
  for (const manager of (status?.managers ?? []).filter(item => item.state === "refused")) await managerViaDaemon(opts, { op: "manager-start", space: manager.space });
  return "Those spaces were started again.";
}
