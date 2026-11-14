import { agentInventory } from "./agents";
import { launchReady } from "./model";

export type AppUpdatePhase = "unconfigured" | "idle" | "checking" | "current" | "available" | "downloading" | "ready" | "preparing" | "failed" | "installing";
export interface AppUpdate {
  phase: AppUpdatePhase;
  version?: string;
  checkedAt?: number;
  downloaded?: number;
  total?: number;
  reason?: string;
}

export interface AppUpdateReceipt {
  schema: 1;
  from: string;
  target: string;
  phase: "installing" | "installed" | "failed";
  reopen: boolean;
  reason?: string;
}

/** Installed app bytes alone do not prove that the service has activated the target. */
export function appliedUpdateSummary(receipt: AppUpdateReceipt | undefined, appVersion: string | undefined, status: Record<string, unknown> | undefined): string | undefined {
  if (!receipt) return undefined;
  if (receipt.phase === "failed") return `Desktop update failed: ${receipt.reason ?? "Installation did not complete"}. Run the installer or try again.`;
  if (appVersion !== receipt.target) return `Cotal ${receipt.target} has not been confirmed. Run the installer or check again.`;
  const generation = status?.generation as { waiting?: string; reason?: string } | undefined;
  if (generation?.waiting) return `Cotal ${receipt.target} is installed. Background service activation is waiting: ${generation.waiting}`;
  if (generation?.reason) return `Cotal ${receipt.target} is installed. Background service activation is unavailable: ${generation.reason}`;
  if (!status || status.state !== "ready" || status.version !== receipt.target) return `Cotal ${receipt.target} is installed. Waiting for the background service at this version.`;
  const inventory = agentInventory(status);
  if (!inventory.available || inventory.unreadable.length) return `Cotal ${receipt.target} is installed. Waiting for readable agent inventory.`;
  if (inventory.agents.some(agent => !Array.isArray(status.managers) || !status.managers.some(manager => manager?.space === agent.space && launchReady(manager)))) return `Cotal ${receipt.target} is installed. Waiting for its agent Managers to be ready.`;
  if (!Array.isArray(status.managers) || !status.managers.every(launchReady)) return `Cotal ${receipt.target} is installed. Waiting for agent applications to be ready.`;
  return `Updated to Cotal ${receipt.target}.`;
}

/** Only native manifest results supply a candidate. Registry availability cannot authorize installation. */
export function appUpdateSummary(state: AppUpdate, automatic: boolean): string {
  switch (state.phase) {
    case "unconfigured": return state.reason ?? "This build cannot update itself. Use the installer to update Cotal.";
    case "idle": return "Updates have not been checked yet.";
    case "checking": return "Checking for desktop updates…";
    case "current": return automatic ? "You are up to date." : "Automatic updates are off. You are up to date.";
    case "installing": return `Installing Cotal ${state.version} and restarting…`;
    case "available": return `Version ${state.version} is available.${automatic ? " Restart to update, or close the window to update automatically." : " Automatic updates are off."}`;
    case "downloading": return `Downloading Cotal ${state.version}${state.total ? ` (${Math.min(100, Math.floor((state.downloaded ?? 0) / state.total * 100))}%)` : ""}…`;
    case "ready": return `Cotal ${state.version} is downloaded and verified.${state.reason ? ` ${state.reason}` : " Restart to update, or close the window to update automatically."}`;
    case "preparing": return "The newest release is still being prepared.";
    case "failed": return `Desktop update failed: ${state.reason ?? "Unknown failure"}. It will retry at the next check.`;
  }
}

/** A publication gap retains the previous candidate without adding a new main-view notice. */
export function appUpdateNotice(state: AppUpdate, dismissed?: string): string | undefined {
  return state.version && state.version !== dismissed && ["available", "downloading", "ready", "preparing", "failed"].includes(state.phase) ? state.version : undefined;
}

export function renderAppUpdate(node: HTMLElement, state: AppUpdate, automatic: boolean): void {
  const message = appUpdateSummary(state, automatic);
  if (node.textContent !== message) node.textContent = message;
  node.dataset.updateState = state.phase;
}
