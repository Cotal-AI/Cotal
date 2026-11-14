export type AppUpdatePhase = "unconfigured" | "idle" | "checking" | "current" | "available" | "downloading" | "ready" | "preparing" | "failed";
export interface AppUpdate {
  phase: AppUpdatePhase;
  version?: string;
  checkedAt?: number;
  downloaded?: number;
  total?: number;
  reason?: string;
}

/** Only native manifest results supply a candidate. Registry availability cannot authorize installation. */
export function appUpdateSummary(state: AppUpdate, automatic: boolean): string {
  switch (state.phase) {
    case "unconfigured": return state.reason ?? "This build cannot update itself. Use the installer to update Cotal.";
    case "idle": return "Updates have not been checked yet.";
    case "checking": return "Checking for desktop updates…";
    case "current": return automatic ? "You are up to date." : "Automatic updates are off. You are up to date.";
    case "available": return `Version ${state.version} is available.${automatic ? "" : " Automatic updates are off."}`;
    case "downloading": return `Downloading Cotal ${state.version}${state.total ? ` (${Math.min(100, Math.floor((state.downloaded ?? 0) / state.total * 100))}%)` : ""}…`;
    case "ready": return `Cotal ${state.version} is downloaded and verified. Waiting to install safely.`;
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
