import { renderAppUpdate, appUpdateNotice, appliedUpdateSummary, type AppUpdate, type AppUpdateReceipt } from "./app-update";
import { listen } from "@tauri-apps/api/event";
import { agentInventory, renderAgents, shownAgentName, type AgentAction, type LocalAgent } from "./agents";
import { AgentApps } from "./agent-apps";
import { SpaceConflicts } from "./space-conflicts";
import { computerName } from "./computer-name";
import { updateNotice, updatePolicy, updateSummary, newerVersion, releaseUrl, installerLink, lastChecked, accountHost, type UpdateStatus } from "./updates";
import { Channel, invoke, isTauri } from "@tauri-apps/api/core";
import { getCurrent, onOpenUrl } from "@tauri-apps/plugin-deep-link";
import { refreshPresence, setLoginPreference, startPresence } from "./presence";
import { canonicalProvider, activeComputerAccount, catalogRefreshNotice, keptCredentialsNotice, type ComputerAccount, approvalUrl, connectionView, refusalView, requireResult, onboardingLink, launchReady, machinesUrl, COTAL_CLOUD_IDP, isCotalCloudIdp, DaemonRefusal, initialSpace, computerSpaces, computerSpaceState, computerSummary, CONNECTION_COPY, networkState, surfaceState, spaceRowRefusal, shownSpaceLabel, shownSpaceKind, shownAccountLabel, type ComputerSpace, type AccountSpace, type EndorsedMigration, type Frame, type Request, type SurfaceState } from "./model";
import { icon, type Icon } from "./icons";
import { reportFirstPaint } from "./first-paint";
import "./style.css";
import "./components.css";

const el = <T extends HTMLElement>(id: string): T => {
  const node = document.getElementById(id);
  if (!node) throw new Error(`Missing element ${id}`);
  return node as T;
};
const text = (id: string, value: string) => {
  const node = el(id);
  if (node.textContent === value) return;
  node.textContent = value;
};
function setIcon(node: Element, name: Icon): void {
  if (node.getAttribute("data-icon") === name) return;
  node.setAttribute("data-icon", name); node.replaceChildren(icon(name));
}
setIcon(el("machine-icon"), "computer");
setIcon(el("loading-icon"), "spinner");
el("dashboard").append(icon("external"));
type Stage = "welcome" | "sign-in" | "connect" | "finished";
let savedComputerName = "This computer";
function renderComputerName(value: string): void {
  savedComputerName = value; text("machine-name", value); el("machine-name").title = value;
  text("settings-computer", value);
  el("connection-status").title = `${el("sidebar-status-word").textContent} · ${value}`;
}
function closeNameEditor(): void {
  el("computer-name-form").hidden = true;
  el("settings-computer").hidden = false; el("settings-name").hidden = false;
  el("settings-name").focus();
}
el("settings-name").addEventListener("click", () => {
  el("settings-computer").hidden = true; el("settings-name").hidden = true;
  el("computer-name-form").hidden = false; text("computer-name-error", "");
  el<HTMLInputElement>("computer-name-input").value = savedComputerName; el("computer-name-input").focus();
});
el("cancel-computer-name").addEventListener("click", closeNameEditor);
el("computer-name-form").addEventListener("keydown", event => { if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); closeNameEditor(); } });
el("computer-name-form").addEventListener("submit", event => {
  event.preventDefault();
  let name: string;
  try { name = computerName(el<HTMLInputElement>("computer-name-input").value); }
  catch (error) { text("computer-name-error", (error as Error).message); return; }
  void action(async () => {
    try { const result = await request({ op: "name", name }); renderComputerName(String(result.computer)); closeNameEditor(); }
    catch (error) { text("computer-name-error", (error as Error).message); }
  });
});
let initialized = false;
let retrySignIn = false;
let activeMove: { provider: string; migrateFrom: string } | undefined;
let recoveringConflictAccount = false;
let approvalExpires = 0;
let countdown: ReturnType<typeof setInterval> | undefined;
let stage: Stage = "welcome";
let ready = false;
let appVersion: string | undefined;
let settingsOpen = false;
let appsOpen = false;
let appsLoadedAt = 0;
let conflictsOpen = false;
let conflictsOpener: HTMLElement | undefined;
const spaceConflicts = new SpaceConflicts({
  openPanel: () => openConflicts(),
  confirm: message => window.confirm(message),
  moveAccount: migration => runEndorsedMove(migration),
  signInProvider: item => action(() => recoverConflictAccount(canonicalProvider(item.existingIdp!), item.space)),
  replaceSpace: async item => {
    const result = await request({ op: "space-conflict-resolve", space: item.space, idp: item.catalogIdp });
    applySpacesPayload(result, signedInProvider ?? item.catalogIdp);
    await refresh();
  },
  signOutProvider: async idp => {
    const result = await request({ op: "logout", idp });
    if (result.localLoginCleared !== true && result.localLogin !== "absent") throw new Error("Sign-out was not confirmed. Refresh and check before retrying.");
    signedOutProviders.add(canonicalProvider(idp));
    if (sameProvider(signedInProvider, idp)) signedInProvider = undefined;
    await spaces(true);
    await refresh();
  },
  changed: () => { showStage(stage); renderSettings(); },
});
let appsOwnerRetry: ReturnType<typeof setTimeout> | undefined;
const agentApps = new AgentApps({
  platform: () => appPlatform,
  announce: message => announce(message),
  openUrl: url => void invoke("open_browser", { url }).catch(refusal),
  changed: () => { appsLoadedAt = Date.now(); renderSettings(); },
});
let updateStatus: UpdateStatus | undefined;
let appUpdate: AppUpdate | undefined;
let autoUpdates: boolean | undefined;
let nextAppCheck = 0;
let appCheckRunning = false;
let appApplyRunning = false;
let nextAppApplyTick = 0;
let appliedUpdate: AppUpdateReceipt | undefined;
let serviceStatus: Record<string, unknown> | undefined;
let serviceAvailability: "stopped" | "not-set-up" | undefined;
let trayWord: SurfaceState["word"] | undefined;
function renderSurface(surface: SurfaceState): void {
  text("sidebar-status-word", surface.word);
  el("sidebar-status-dot").dataset.tone = surface.dot;
  el("connection-status").title = `${surface.word} · ${savedComputerName}`;
  if (!isTauri() || trayWord === surface.word) return;
  trayWord = surface.word;
  void invoke("set_connection_state", { connected: surface.word === "Connected", label: surface.word }).catch(() => {
    if (trayWord === surface.word) trayWord = undefined;
  });
}
function renderConnectionTitle(title: string, surface: SurfaceState): void {
  const node = el("connection-title");
  const titlePhrase: Partial<Record<SurfaceState["word"], string>> = {
    "Offline": "No internet connection", "Can't connect": "Can't reach", "Sign in required": "Sign in",
    "Service stopped": "stopped", "Disk full": "disk is full", "Repair needed": "needs a repair",
  };
  const phrase = title === surface.title ? (titlePhrase[surface.word] ?? surface.word).toLowerCase() : "";
  const rendered = `${title}:${phrase}`;
  if (node.dataset.rendered === rendered) return;
  node.dataset.rendered = rendered;
  const start = phrase ? title.toLowerCase().indexOf(phrase) : -1;
  if (start === -1) { node.textContent = title; return; }
  const mark = document.createElement("span"); mark.className = "status-highlight";
  mark.textContent = title.slice(start, start + phrase.length);
  node.replaceChildren(title.slice(0, start), mark, title.slice(start + phrase.length));
}
async function applyAppUpdate(explicit = false, tick = false): Promise<void> {
  if (tick && Date.now() < nextAppApplyTick) return;
  if (appApplyRunning || busy || loginActive || setupActive || !["darwin", "win32"].includes(appPlatform) || !autoUpdates || !appUpdate?.version) return;
  appApplyRunning = true;
  if (explicit) { appliedUpdate = undefined; renderSettings(); }
  try { appUpdate = await invoke<AppUpdate>("app_update_apply", { explicit }); }
  catch (error) { text("settings-message", error instanceof Error ? error.message : String(error)); }
  finally { if (!explicit) nextAppApplyTick = Date.now() + 600_000; appApplyRunning = false; renderSettings(); }
}
async function readAutoUpdates(): Promise<void> {
  const policy = await request({ op: "update-policy" });
  if (typeof policy.auto !== "boolean") throw new Error("The automatic update preference is unavailable.");
  autoUpdates = policy.auto;
}
function appUpdaterConfigured(): boolean { return appUpdate !== undefined && appUpdate.phase !== "unconfigured"; }
async function checkAppUpdates(manual = false): Promise<void> {
  if (appCheckRunning || (!manual && Date.now() < nextAppCheck)) return;
  appCheckRunning = true;
  nextAppCheck = Date.now() + 86_400_000;
  try {
    appUpdate = await invoke<AppUpdate>("app_update_check", { manual });
    if (appUpdate.phase === "current" && (appliedUpdate?.phase === "failed" || appliedUpdate?.target !== appVersion)) appliedUpdate = undefined;
    if (appUpdaterConfigured()) await readAutoUpdates();
    renderSettings();
    if (autoUpdates && appUpdate.phase === "available") await applyAppUpdate(false, !manual && appliedUpdate?.phase === "failed");
  } catch (error) {
    text("settings-message", error instanceof Error ? error.message : String(error));
    if (manual) throw error;
  } finally { appCheckRunning = false; renderSettings(); }
}
let daemonVersion = "Unavailable";
let appPlatform = "";
let appArch = "";
let releaseAssets: { name: string; url: string }[] = [];
let releaseVersion: string | undefined;
let releaseLoading: string | undefined;
let releaseFailed: string | undefined;
let installerMessage: string | undefined;
async function loadRelease(version: string): Promise<void> {
  if (releaseVersion === version || releaseLoading === version) return;
  releaseLoading = version;
  try { const result = await request({ op: "update-release", version }); releaseAssets = result.assets as { name: string; url: string }[]; releaseVersion = version; }
  catch (error) { releaseFailed = version; text("settings-message", error instanceof Error ? error.message : String(error)); }
  finally { releaseLoading = undefined; renderSettings(); }
}
function offeredVersion(): string | undefined {
  return appUpdaterConfigured() ? appUpdate?.version : updateStatus?.latest;
}
async function openInstaller(): Promise<void> {
  const version = offeredVersion();
  if (!version) return;
  try {
    if (releaseVersion !== version) {
      const result = await request({ op: "update-release", version });
      releaseAssets = result.assets as { name: string; url: string }[];
      releaseVersion = version;
    }
    const link = installerLink(version, appPlatform, appArch, releaseAssets);
    installerMessage = link.available ? "Install the downloaded version, then reopen Cotal." : "No installer for this platform is on this release. Opening its release page.";
    text("settings-last-check", installerMessage); announce(installerMessage);
    await invoke("open_browser", { url: link.url });
  } catch (error) { installerMessage = error instanceof Error ? error.message : String(error); text("settings-last-check", installerMessage); announce(installerMessage); notice("The release could not be checked. Try again.", true); }
}
let dismissedUpdate = localStorage.getItem("dismissed-update") ?? undefined;
let trayUpdate: string | undefined;
function renderSettings(): void {
  const configured = stage === "finished" && !setupActive;
  el("conflicts-panel").hidden = !conflictsOpen;
  el("settings-panel").hidden = !settingsOpen || appsOpen;
  el("apps-panel").hidden = !appsOpen;
  el("connection-view").hidden = settingsOpen || appsOpen || conflictsOpen;
  syncViewTabs();
  renderApps();
  renderConflicts();
  const latest = appVersion ? appUpdaterConfigured() ? appUpdateNotice(appUpdate!, dismissedUpdate) : updateNotice(updateStatus, appVersion, dismissedUpdate) : undefined;
  const nextTray = configured ? latest : undefined;
  if (isTauri() && nextTray !== trayUpdate) { trayUpdate = nextTray; void invoke("set_update_notice", { version: nextTray ?? null }).catch(error => notice(String(error), true)); }
  el("update-banner").hidden = !configured || settingsOpen || !latest;
  text("update-banner-copy", latest ? `Cotal ${latest} is available.` : "");
  text("settings-computer", savedComputerName);
  text("settings-versions", `App ${appVersion ?? "Unavailable"} · Service ${daemonVersion}`);
  const applied = appliedUpdateSummary(appliedUpdate, appVersion, serviceStatus);
  el("applied-update").hidden = !applied;
  text("applied-update", applied ?? "");
  const canRestart = ["darwin", "win32"].includes(appPlatform) && autoUpdates === true && appUpdate?.version && ["available", "ready", "failed"].includes(appUpdate.phase);
  el("restart-update").hidden = !canRestart;
  el<HTMLButtonElement>("restart-update").disabled = busy || loginActive || setupActive || appApplyRunning;
  if (appUpdaterConfigured()) renderAppUpdate(el("settings-update-summary"), appUpdate!, autoUpdates !== false);
  else {
    text("settings-update-summary", updateStatus ? updateSummary(updateStatus, appVersion ?? "") : appVersion ? `Version ${appVersion}` : "");
    delete el("settings-update-summary").dataset.updateState;
  }
  const checkedAt = appUpdaterConfigured() ? appUpdate?.checkedAt === undefined ? undefined : new Date(appUpdate.checkedAt).toISOString() : updateStatus?.lastCheck;
  text("settings-last-check", installerMessage ?? lastChecked(checkedAt));
  const policy = updatePolicy(updateStatus?.channel, appPlatform, appUpdaterConfigured());
  text("update-preference-label", policy.label);
  text("update-policy", appUpdate?.phase === "unconfigured" ? updateStatus?.channel === "npm" ? `${policy.description} This build updates through the installer.` : "Cotal tells you here when a new version is out. This build updates through the installer." : policy.description);
  el<HTMLInputElement>("update-preference").checked = appUpdaterConfigured() ? autoUpdates !== false : policy.label === "Install updates automatically" ? updateStatus?.automatic === true : updateStatus?.notify !== false;
  el<HTMLInputElement>("update-preference").disabled = busy || (appUpdaterConfigured() && autoUpdates === undefined);
  const offered = offeredVersion();
  const available = appVersion && newerVersion(offered, appVersion);
  if (available && offered && releaseVersion !== offered && releaseLoading !== offered && releaseFailed !== offered) void loadRelease(offered);
  const download = offered && releaseVersion === offered ? installerLink(offered, appPlatform, appArch, releaseAssets) : undefined;
  for (const id of ["update-download", "settings-download"]) { text(id, download?.label ?? "Checking release…"); el<HTMLButtonElement>(id).disabled = !download; }
  el("settings-download-row").hidden = !available;
  text("settings-download-copy", available ? `Version ${offered}. Installer availability is checked when opened.` : "");
  text("settings-account", [accountHost(accountProvider()), shownAccountLabel(computerAccount?.label, computerAccount?.sub)].filter(Boolean).join(" · "));
  renderAccountActions();
  el("settings-panel").classList.toggle("confirming-account", !!pendingAccountAction);
  el("settings-panel").classList.toggle("account-outcome-view", accountOutcomeOpen);
  el("account-outcome-back").hidden = !accountOutcomeOpen;
  el("account-outcome").hidden = !accountOutcomeOpen;
}
type AccountAction = { kind: "logout" | "disconnect"; provider: string; spaces: string[]; trigger: string };
let pendingAccountAction: AccountAction | undefined;
let accountOutcomeOpen = false;
const signedOutProviders = new Set<string>();
let signedInProviders: string[] = [];
let signedInProvidersKnown = false;
function accountProvider(): string | undefined {
  return signedInProvider ?? providers.get(selectedSpace()) ?? computerAccount?.idpUrl ?? (signedInProviders.length === 1 ? signedInProviders[0] : undefined);
}
function sameProvider(left: string | undefined, right: string | undefined): boolean {
  if (!left || !right) return false;
  try { return canonicalProvider(left) === canonicalProvider(right); } catch { return false; }
}
function disconnectSpaces(provider: string | undefined): string[] {
  if (!provider) return [];
  const names = new Set<string>();
  if (sameProvider(computerAccount?.idpUrl, provider)) for (const row of computerAccount?.spaces ?? []) {
    if (row.desired || (row.observed !== "removed on this computer" && row.observed !== "disconnected")) names.add(row.space);
  }
  for (const [space, state] of connections) if (sameProvider(providers.get(space), provider) && state !== "disconnected" && state !== "removed on this computer") names.add(space);
  return [...names];
}
function signedInAccountProvider(): string | undefined {
  const provider = accountProvider();
  if (!provider || [...signedOutProviders].some(item => sameProvider(item, provider))) return undefined;
  if (signedInProvidersKnown) return signedInProviders.some(item => sameProvider(item, provider)) ? provider : undefined;
  return sameProvider(signedInProvider, provider) || (sameProvider(computerAccount?.idpUrl, provider) && computerAccount?.mode === "account" && !!computerAccount.sub) ? provider : undefined;
}
function renderAccountActions(): void {
  const blocked = busy || loginActive || !!pendingAccountAction;
  const signedIn = !!signedInAccountProvider();
  const spaceCount = disconnectSpaces(accountProvider()).length;
  text("settings-spaces", signedIn ? (spaceCount ? `Signed in · ${spaceCount} ${spaceCount === 1 ? "space" : "spaces"}` : "Signed in") : "");
  el("settings-spaces").hidden = !signedIn;
  el<HTMLButtonElement>("settings-signout").disabled = blocked || !signedIn;
  el<HTMLButtonElement>("settings-disconnect").disabled = blocked || !spaceCount;
  for (const id of ["account-confirm", "account-cancel"]) el<HTMLButtonElement>(id).disabled = busy || loginActive;
  el("account-confirmation").hidden = !pendingAccountAction;
  el("account-confirmation").setAttribute("aria-busy", String(busy));
}
function closeAccountConfirmation(): void {
  if (busy) return;
  const trigger = pendingAccountAction?.trigger;
  pendingAccountAction = undefined; renderSettings();
  if (trigger && !el<HTMLButtonElement>(trigger).disabled) el(trigger).focus();
  else el("settings-title").focus();
}
function confirmAccountAction(kind: AccountAction["kind"]): void {
  if (busy || loginActive) return;
  const provider = kind === "logout" ? signedInAccountProvider() : accountProvider();
  if (!provider) return;
  const spaces = disconnectSpaces(provider);
  if (kind === "disconnect" && !spaces.length) return;
  text("account-outcome", ""); accountOutcomeOpen = false;
  pendingAccountAction = { kind, provider, spaces, trigger: kind === "logout" ? "settings-signout" : "settings-disconnect" };
  text("account-confirm-title", kind === "logout" ? `Sign out of ${accountHost(provider)}?` : `Disconnect this computer from ${accountHost(provider)}?`);
  text("account-confirm-copy", kind === "logout" ? "Existing connections keep running. Disconnect this computer first if you also want to stop its connections. Only this provider will be signed out." : "Stop the following spaces one by one. This does not remove this computer from the dashboard, uninstall the service, revoke provider authority or erase retained renewal records. Disconnect before signing out if you want both.");
  el("account-confirm-spaces").replaceChildren(...(kind === "disconnect" ? spaces : []).map(space => {
    const li = document.createElement("li"); const label = shownSpaceLabel(accountSpaces.get(space)?.label, space);
    li.textContent = label !== space ? `${label} (${space})` : space; return li;
  }));
  text("account-confirm", kind === "logout" ? "Sign out" : "Disconnect listed spaces");
  renderSettings(); el("account-cancel").focus();
}
async function runAccountAction(): Promise<void> {
  const target = pendingAccountAction;
  if (!target || busy || loginActive) return;
  busy = true; refreshGeneration++; buttons(); renderSettings();
  const outcomes: string[] = [];
  const spaceLabels = new Map(target.spaces.map(space => [space, shownSpaceLabel(accountSpaces.get(space)?.label, space)]));
  const spaceLabel = (space: string): string => spaceLabels.get(space) ?? space;
  const acknowledged = new Set<string>();
  let catalogRefreshed = false;
  try {
    if (target.kind === "logout") {
      try {
        const result = await request({ op: "logout", idp: target.provider });
        if (result.localLoginCleared !== true && result.localLogin !== "absent") throw new Error("Sign-out was not confirmed. Refresh and check before retrying.");
        signedOutProviders.add(canonicalProvider(target.provider));
        if (sameProvider(signedInProvider, target.provider)) signedInProvider = undefined;
        outcomes.push(result.localLogin === "absent" ? `No cached sign-in for ${accountHost(target.provider)}. Other server sessions were not revoked. Existing connections keep running.` : `Signed out of ${accountHost(target.provider)}. Existing connections keep running.`);
      } catch (error) { outcomes.push(`Sign-out: ${error instanceof Error ? error.message : String(error)}`); }
    } else {
      for (const space of target.spaces) {
        try {
          const result = await request({ op: "service-disconnect", space });
          if (result.state !== "disconnected" || launchReady(result.manager)) throw new Error(typeof result.message === "string" ? result.message : `Disconnect not confirmed (${typeof result.state === "string" ? result.state : "unknown status"}).`);
          acknowledged.add(space);
          outcomes.push(`${spaceLabel(space)}: service reports disconnected; checking current status.`);
        } catch (error) { outcomes.push(`${spaceLabel(space)}: ${error instanceof Error ? error.message : String(error)}`); }
        text("account-outcome", outcomes.join("\n"));
      }
    }
    try { await spaces(false); catalogRefreshed = true; } catch (error) { outcomes.push(`Space refresh: ${error instanceof Error ? error.message : String(error)}`); }
    await refresh();
    // Replace progress-only rows with the final observation, keeping operation errors.
    for (const space of acknowledged) {
      const index = outcomes.indexOf(`${spaceLabel(space)}: service reports disconnected; checking current status.`);
      if (index >= 0) outcomes.splice(index, 1);
    }
    if (target.kind === "disconnect" && ready) {
      for (const space of target.spaces) {
        const row = sameProvider(computerAccount?.idpUrl, target.provider) ? computerAccount?.spaces.find(item => item.space === space) : undefined;
        try {
          const service = await request({ op: "service-status", space });
          if (service.state !== "disconnected" || launchReady(service.manager) || observedReadySpaces.includes(space) || row?.desired || (row && row.observed !== "removed on this computer" && row.observed !== "disconnected")) {
            outcomes.push(`${spaceLabel(space)}: refreshed status does not confirm removal. Disconnect is incomplete.`);
          } else {
            connections.delete(space); instances.delete(space); applicationRefusals.delete(space);
            if (selectedSpace() === space) connection = { space, state: "disconnected" };
            if (acknowledged.has(space) && catalogRefreshed) outcomes.push(`${spaceLabel(space)}: disconnected, confirmed by refresh.`);
            else if (!catalogRefreshed) outcomes.push(`${spaceLabel(space)}: service is disconnected, but account refresh failed. Full removal is not confirmed.`);
            else outcomes.push(`${spaceLabel(space)}: currently disconnected, but the requested operation was not confirmed.`);
          }
        } catch (error) { outcomes.push(`${spaceLabel(space)}: refresh could not confirm removal. ${error instanceof Error ? error.message : String(error)}`); }
      }
    }
    if (!ready) {
      for (const space of acknowledged) outcomes.push(`${spaceLabel(space)}: service reported disconnected, but current removal status is unverified.`);
      outcomes.push("Current status could not be refreshed. Check the connection before retrying.");
    }
  } catch (error) {
    outcomes.push(`The operation could not be fully verified. ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    text("account-outcome", outcomes.join("\n")); accountOutcomeOpen = true;
    busy = false; refreshGeneration++; pendingAccountAction = undefined; buttons(); renderSettings(); el("account-outcome").focus();
  }
}
let upgradeNeeded = false;
let serviceUpdateWaiting = false;
let nextServiceUpdate = 0;
let busy = false;
let rowOperation: { space: string; label: string } | undefined;
let loginActive = false;
let setupActive = false;
let approval: string | undefined;
let requestedSpace: string | undefined;
let linked = false;
let customHost = false;
let editing = false;
let completedSetup = false;
let observedReadySpaces: string[] = [];
/** Why each space's hosted Manager is not answering, as the daemon reports it. */
const managerReasons = new Map<string, string>();
let poll: ReturnType<typeof setTimeout> | undefined;
let watchReconnect: ReturnType<typeof setTimeout> | undefined;
let windowHidden = false;
let tickRunning = false;
let lastTickAt = 0;
let watchActive = false;
let watchStarting = false;
let watchMode = "";
function setWatchMode(mode: string): void {
  watchMode = mode;
  document.documentElement.dataset.watchMode = mode;
}
let connection: { space: string; state: string } | undefined;
let refreshGeneration = 0;
const accountSpaces = new Map<string, AccountSpace>();
let signedInProvider: string | undefined;
let computerAccount: ComputerAccount | undefined;
const computerRows = new Map<string, ComputerSpace>();
const connections = new Map<string, string>();
let choosingSpace = false;
let addingSpace = false;
let selectionPending = false;
let listOpened = false;
const providers = new Map<string, string>();
const catalogIds = new Map<string, string>();
const instances = new Map<string, string>();
const applicationRefusals = new Set<string>();
let applications: readonly string[] = [];
const selectedSpace = () => el<HTMLSelectElement>("space").value;
const connected = () => !upgradeNeeded && connection?.space === selectedSpace() && connection?.state === "launch-ready";
const welcome = "Connect this computer to your Cotal account. People authorized in a connected space can launch applications as your operating-system user, with your applications’ sign-in and file permissions.";
const progressNames = ["Background service", "Sign-in", "Space", "Agent applications", "Ready"];
type ProgressState = "waiting" | "running" | "done" | "failed";
let problem: string | undefined;
let statusProblem = false;
let progress: ProgressState[] = progressNames.map(() => "waiting");
const progressDetails = ["Starting your background service.", "Checking your sign-in.", "Finding your account’s spaces.", "Checking installed agent applications.", "Verifying your connection."];
let lastView = "";
function announce(message: string): void { text("announcer", message); }

function notice(message: string, error = false): void {
  text("notice", message);
  el("notice-wrap").classList.toggle("expanded", Boolean(message));
  el("notice").setAttribute("aria-hidden", String(!message));
  el("notice").hidden = !message;
  el("notice").classList.toggle("error", error);
  if (message) announce(message);
}
let agentActionProblem = false;
let refusalSummary: string | undefined;
function clearDetails(): void {
  problem = undefined;
  refusalSummary = undefined;
  statusProblem = false;
  agentActionProblem = false;
  text("refusal-detail", ""); el("setup-lines").replaceChildren(); el("details").hidden = true;
  el<HTMLDetailsElement>("details").open = false;
}
function showRefusalDetail(error: unknown): void {
  const exact = error instanceof Error ? error.message : String(error);
  text("refusal-detail", error instanceof DaemonRefusal ? `${error.code}${error.native ? ` (${error.native})` : ""}\n${exact}` : exact);
  el("details").hidden = false;
  el<HTMLDetailsElement>("details").open = true;
}
/** `fromStatus` marks an error the background status check raised, which the next good check clears.
 *  Any other error stays until the person acts on it. */
function refusal(error: unknown, fromStatus = false): void {
  agentActionProblem = false;
  showRefusalDetail(error);
  problem = error instanceof DaemonRefusal ? error.native ?? error.code : "OPERATION_FAILED";
  refusalSummary = error instanceof DaemonRefusal && error.code === "MOVE_REFUSED"
    ? [error.message.split("\n")[0] ?? "", error.remedy].filter(Boolean).join(" ")
    : undefined;
  statusProblem = fromStatus;
  notice("", true);
  showStage(stage);
}
function renderProgress(): void {
  const list = el("setup-progress");
  progressNames.forEach((name, index) => {
    let li = list.children[index] as HTMLElement | undefined;
    if (!li) {
      li = document.createElement("li"); li.dataset.testid = `progress-${index}`;
      const mark = document.createElement("span"); mark.className = "progress-mark"; mark.setAttribute("aria-hidden", "true");
      const copy = document.createElement("span"); copy.className = "progress-copy";
      const label = document.createElement("span"); label.textContent = name;
      const detail = document.createElement("small"); detail.className = "progress-detail";
      copy.append(label, detail);
      const status = document.createElement("span"); status.className = "sr-only";
      li.append(mark, copy, status); list.append(li);
    }
    const detail = li.querySelector<HTMLElement>(".progress-detail")!;
    detail.textContent = progressDetails[index]; detail.hidden = progress[index] !== "running";
    if (li.dataset.state === progress[index]) return;
    li.dataset.state = progress[index];
    const mark = li.querySelector(".progress-mark")!;
    if (progress[index] === "waiting") { mark.removeAttribute("data-icon"); mark.textContent = String(index + 1); }
    else setIcon(mark, progress[index] === "done" ? "check" : progress[index] === "failed" ? "warning" : "spinner");
    li.querySelector(".sr-only")!.textContent = progress[index];
    if (progress[index] === "running") announce(progressDetails[index]);
  });
}
function setupProgress(frame: Frame): void {
  if (typeof frame.line === "string") {
    const line = document.createElement("li"); line.textContent = frame.line;
    el("setup-lines").append(line); el("details").hidden = false;
  }
  const p = frame.progress;
  if (!p) return;
  if (p.applications) applications = p.applications;
  const index = ({ install: 0, "sign-in": 1, discover: 2, manager: 3, applications: 3, register: 4, connect: 4 } as const)[p.step];
  if (index === undefined) return;
  progressDetails[index] = p.detail;
  // Metadata names the actual step. Later events never imply that earlier work succeeded.
  const running = ["running", "waiting", "approval-required", "pending"].includes(p.outcome);
  const failed = ["failed", "unavailable", "refused", "stopped", "restarting"].includes(p.outcome);
  const successes: Record<string, readonly string[]> = {
    install: ["installed", "already-installed", "path-refreshed", "ready"],
    "sign-in": ["already-signed-in", "signed-in"], discover: ["registered"], applications: ["available"],
  };
  progress[index] = failed ? "failed" : successes[p.step]?.includes(p.outcome) ? "done" : running || ["manager", "register", "connect"].includes(p.step) ? "running" : "waiting";
  renderProgress();
}
function showStage(next: Stage, focus = false): void {
  stage = next;
  renderSettings();
  const finished = next === "finished";
  const anyConnected = [...connections].some(([space, value]) => value === "launch-ready" && !computerRows.get(space)?.lastRefusal);
  const surface = surfaceState({
    rows: computerAccount ? computerSpaces(computerAccount) : [],
    anyConnected: !upgradeNeeded && anyConnected,
    signInRequired: computerAccount?.mode === "sign-in-required",
    service: !initialized || setupActive || loginActive ? undefined : serviceAvailability,
    starting: !initialized || setupActive || loginActive || !serviceStatus && !serviceAvailability,
    updating: !!serviceStatus?.generation,
    diskFull: serviceStatus?.diskFull === true,
    repairNeeded: !!serviceStatus?.recovery,
  });
  renderSurface(surface);
  const pending = !anyConnected && [...connections].find(([, value]) => value === "approval-pending");
  const signIn = next === "welcome" || next === "sign-in";
  el("sign-in-panel").hidden = !signIn;
  el("space-panel").hidden = !((next === "connect" || finished && addingSpace) && choosingSpace) || setupActive;
  el("connect-panel").hidden = !(next === "connect" || finished && addingSpace) || setupActive;
  el("connected-panel").hidden = !finished;
  el("setup-progress").hidden = (!setupActive && !progress.some(value => value !== "waiting")) || finished && !setupActive;
  document.querySelector(".app")!.classList.toggle("later-open", (finished || listOpened) && !completedSetup);
  document.querySelector(".connection-card")!.classList.toggle("has-refusal", el("notice").classList.contains("error"));
  el("link-context").hidden = !linked || next !== "welcome";
  el("refresh").hidden = signIn || busy || (finished && !pending);
  text("refresh", pending ? "Check approval" : "Refresh status");
  el("custom-host").hidden = !customHost || loginActive;
  el("login-actions").hidden = loginActive;
  el("service-explanation").hidden = loginActive;
  text("step-caption", finished ? "Ready for your next agent" : `Step ${["welcome", "sign-in", "connect", "finished"].indexOf(next) + 1} of 4`);
  el("step-caption").hidden = finished;
  if (finished && !problem && !agentActionProblem) el("details").hidden = true;
  let title: string, description: string;
  if (next === "welcome") { title = "Welcome to Cotal"; description = welcome; }
  else if (next === "sign-in") { title = loginActive ? approval ? "Approve sign-in in your browser" : "Preparing your sign-in" : "Sign in to Cotal"; description = "Approve this computer in your browser. We will continue here automatically."; }
  else if (finished && computerAccount?.hostSupport === "supported") { title = surface.title; description = surface.description; }
  else if (finished && pending) { title = "Waiting for owner approval"; description = `The owner of ${shownSpaceLabel(accountSpaces.get(pending[0])?.label, pending[0])} needs to approve this computer. It connects by itself once they do.`; }
  else if (finished) { title = surface.title; description = surface.description; }
  else if (setupActive) { title = "Connecting this computer"; description = "Keep this window open while we check your connection and agent applications."; }
  else if (connection?.space === selectedSpace() && connection.state !== "ready" && connection.state !== "disconnected") { const view = connectionView(connection.state); title = view.title; description = view.description; }
  else { title = "Ready to connect"; description = "You are signed in. Choose Connect when you are ready."; }
  const issue = problem ?? (!setupActive && applicationRefusals.has(selectedSpace()) ? "NO_AVAILABLE_CONNECTOR" : !setupActive && upgradeNeeded && !(finished && runningAgents() !== undefined) && (selectedSpace() || computerAccount?.hostSupport === "supported" || watchMode === "refused-unknown-op" || watchMode === "version-mismatch") ? "VERSION_MISMATCH" : undefined);
  const surfaceRecovery = surface.word === "Disk full" || surface.word === "Service stopped";
  const networkLoss = surface.title === CONNECTION_COPY.offline.title || surface.title === CONNECTION_COPY.unreachable.title;
  const recovery = surface.word === "Disk full" ? { title: surface.title, description: surface.description, action: "refresh", label: "Check again" }
    : surface.word === "Service stopped" ? { title: surface.title, description: surface.description, action: "start", label: "Start" }
    : issue && !networkLoss ? refusalView(issue, applications, refusalSummary) : undefined;
  if (recovery) {
    title = recovery.title;
    description = recovery.description;
  }
  el("recovery-panel").hidden = !recovery;
  el("setup-installer").hidden = surfaceRecovery || issue !== "SETUP_INTERRUPTED";
  el("recover-apps").hidden = surfaceRecovery || issue !== "NO_AVAILABLE_CONNECTOR";
  if (recovery) {
    for (const id of ["sign-in-panel", "space-panel", "connect-panel", "setup-progress", "connected-panel", "refresh"]) el(id).hidden = true;
    text("recover", recovery.label); el("recover").dataset.action = recovery.action;
    el("recover").hidden = recovery.action === "none";
    el<HTMLButtonElement>("recover").disabled = busy && issue !== "EXPIRED" || retrySignIn;
    if (retrySignIn) text("recover", "Getting a new code…");
    if (!retrySignIn && ["EXPIRED", "VERSION_MISMATCH"].includes(issue!) && !el("recover").querySelector(".icon-refresh")) el("recover").prepend(icon("refresh"));
    if (issue === "VERSION_MISMATCH") {
      text("refusal-detail", `App version ${appVersion ?? "unknown"} · background service ${daemonVersion === "Unavailable" ? "unknown" : daemonVersion}.`); el("details").hidden = false;
    }
  }
  if (!recovery && (next === "connect" || finished) && !setupActive && !loginActive) spaceConflicts.renderCallout(el("space-conflicts-callout"), busy);
  else el("space-conflicts-callout").hidden = true;
  document.querySelector(".connection-card")!.classList.toggle("has-refusal", Boolean(recovery) && issue !== "APPROVAL_PENDING");
  renderConnectionTitle(title, surface);
  const target = accountSpaces.get(selectedSpace());
  if (next === "connect" && !setupActive && !recovery) description = target ? `Connect this computer to ${target.kind === "personal" ? "your personal space, " : ""}${shownSpaceLabel(target.label, target.space)}. You can add it to other spaces afterwards.` : "Choose which space can use this computer.";
  text("connection-description", description);
  el("selected-space").hidden = !addingSpace;
  text("selected-space", target ? addingSpace ? `People authorized in ${shownSpaceLabel(target.label, target.space)} will be able to launch agent applications on this computer as you.` : `Connect this computer to ${target.kind === "personal" ? "your personal space, " : ""}${shownSpaceLabel(target.label, target.space)}. You can add it to other spaces afterwards.` : "Choose which space can use this computer.");
  el("connected-space").hidden = true;
  const formParent = addingSpace ? el("add-space-panel") : document.querySelector(".connection-card")!;
  if (el("space-panel").parentElement !== formParent) {
    if (addingSpace) formParent.append(el("space-panel"), el("connect-panel"));
    else el("setup-progress").before(el("space-panel"), el("connect-panel"));
  }
  const inventoryVisible = !addingSpace && (anyConnected || el("agent-list").children.length > 0);
  el("running-agents").hidden = !inventoryVisible;
  el("dashboard").hidden = addingSpace || !(anyConnected || computerAccount?.hostSupport === "supported");
  el("another-space").hidden = addingSpace;
  text("another-space", connections.size ? "Add to another space" : "Add a space");
  el("sign-in-again").hidden = addingSpace || computerAccount?.mode !== "sign-in-required";
  if (finished && computerAccount?.mode === "sign-in-required") {
    text("sign-in-again", "Sign in");
    el("connected-spaces").hidden = true;
  } else el("connected-spaces").hidden = false;
  el("retry-login").hidden = addingSpace;
  el("choose-space").hidden = true;
  el("sync").hidden = addingSpace;
  if (finished && computerAccount?.mode === "sign-in-required") {
    for (const id of ["retry-login", "sync", "another-space", "dashboard"]) el(id).hidden = true;
  }
  if (finished && computerAccount?.hostSupport === "supported") {
    const signInRequired = computerAccount.mode === "sign-in-required";
    el("spaces-heading").hidden = signInRequired || !anyConnected;
  } else el("spaces-heading").hidden = connections.size === 0;
  document.querySelector<HTMLElement>(".connected-spaces-scroll")!.hidden = connections.size === 0;
  el("dashboard-spaces-note").hidden = !finished || addingSpace || computerAccount?.hostSupport !== "supported" || computerAccount.mode === "sign-in-required" || computerSpaces(computerAccount).length === 0;
  document.querySelector(".connection-card")!.classList.toggle("adding-space", addingSpace);
  renderConnections();
  text("login", linked || customHost || next === "sign-in" ? "Continue in browser" : "Continue with Cotal Cloud");
  el("other-host").hidden = customHost || linked;
  el("cloud-host").hidden = !customHost || linked || loginActive;
  el("change-space").hidden = !addingSpace;
  el("journey").hidden = finished;
  const stages: Stage[] = ["welcome", "sign-in", "connect", "finished"];
  for (const item of document.querySelectorAll<HTMLElement>("#journey li")) {
    const index = stages.indexOf(item.dataset.stage as Stage), active = stages.indexOf(next);
    const done = index < active || finished;
    item.dataset.state = done ? "done" : index === active ? "current" : "upcoming";
    if (index === active) item.setAttribute("aria-current", "step"); else item.removeAttribute("aria-current");
    const marker = item.querySelector(".step-marker")!;
    if (done) setIcon(marker, "check");
    else if (marker.textContent !== String(index + 1)) { marker.removeAttribute("data-icon"); marker.textContent = String(index + 1); }
  }
  const view = `${next}:${title}:${loginActive}:${setupActive}:${issue ?? ""}`;
  if (view !== lastView) {
    const changed = lastView !== "";
    lastView = view;
    if (!appsOpen && !settingsOpen && (focus || changed && initialized)) el("connection-title").focus({ preventScroll: true });
    announce(title);
  }
  buttons();
}
function renderConnections(): void {
  const list = el("connected-spaces");
  text("spaces-heading", `Spaces using this computer (${connections.size})`);
  const migration = spaceConflicts.migration;
  const signature = JSON.stringify([...connections].map(([space, state]) => [space, state, accountSpaces.get(space), computerRows.get(space), managerReasons.get(space), migration, busy, rowOperation]));
  if (list.dataset.rows === signature) return;
  list.dataset.rows = signature;
  list.replaceChildren(...[...connections].map(([space, state]) => {
    const row = document.createElement("li"); row.dataset.testid = "connected-space-row"; row.dataset.space = space;
    const copy = document.createElement("span");
    const name = document.createElement("strong"); name.textContent = shownSpaceLabel(accountSpaces.get(space)?.label, space);
    const kind = document.createElement("span"); kind.className = "space-kind"; kind.textContent = shownSpaceKind(accountSpaces.get(space)?.kind);
    copy.append(name, kind);
    const accountRow = computerRows.get(space);
    const rowRefusal = accountRow && (accountRow.lastRefusal || accountRow.custodyRecovery) ? spaceRowRefusal(accountRow, migration) : undefined;
    const detail = document.createElement("small"); detail.className = "space-state";
    const dot = document.createElement("span"); dot.setAttribute("aria-hidden", "true");
    dot.className = `dot ${accountRow?.lastRefusal ? "error" : state === "launch-ready" ? "connected" : ""}`;
    const reason = accountRow && (accountRow.lastRefusal || accountRow.observed === "offline" || accountRow.observed === "unreachable") ? managerReasons.get(space) : undefined;
    const status = rowRefusal?.text ?? (accountRow ? computerSpaceState(accountRow, state === "launch-ready") : state === "approval-pending" ? "Waiting for owner approval" : "Connected");
    if (state === "approval-pending") detail.dataset.testid = "approval-pending";
    detail.append(dot, `${status}${reason ? `: ${reason}` : ""}`);
    const restore = accountRow?.observed === "removed on this computer";
    const recovery = accountRow?.custodyRecovery;
    const label = rowRefusal && rowRefusal.action !== "remove" ? rowRefusal.label : restore ? "Add" : "Remove";
    const forAria = rowRefusal && (rowRefusal.action === "recover" || rowRefusal.action === "move");
    const button = document.createElement("button"); button.type = "button"; button.className = "text-button"; button.textContent = label; button.disabled = busy || !!rowOperation; button.setAttribute("aria-label", forAria ? `${label} for ${name.textContent}` : `${label} ${name.textContent}`);
    button.addEventListener("click", () => {
      if (rowRefusal?.action === "move" && migration) {
        if (!window.confirm(`Move ${name.textContent} to the account you're signed in with?`)) return;
        void runEndorsedMove(migration);
        return;
      }
      if (rowRefusal?.action === "recover" && recovery) {
        if (!window.confirm(`Use the signed-in account for ${name.textContent} instead of ${recovery.holder}?`)) return;
        void rowAction(space, false, recovery);
        return;
      }
      void rowAction(space, restore);
    });
    if (rowOperation?.space === space) {
      row.setAttribute("aria-busy", "true");
      const waiting = document.createElement("small"); waiting.setAttribute("role", "status"); waiting.textContent = `${rowOperation.label}… Waiting for the background service.`; copy.append(waiting);
    }
    row.append(copy, detail, button); return row;
  }));
}
async function rowAction(space: string, restore: boolean, recovery?: { candidate: string; holder: string }): Promise<void> {
  if (busy || rowOperation) return;
  const operation = { space, label: `${recovery ? "Moving" : restore ? "Adding" : "Removing"} ${shownSpaceLabel(accountSpaces.get(space)?.label, space)}` };
  rowOperation = operation; refreshGeneration++; renderConnections();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      (async () => {
        if (recovery || restore) {
          await request(recovery ? { op: "space-recover", space, ...recovery } : { op: "space-intent", space, enabled: true });
          if (rowOperation !== operation) return;
          await refresh();
        } else await removeSpace(space, () => rowOperation === operation);
      })(),
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`${operation.label} did not finish within 15 seconds. The background service may still complete the request. Check this space’s status before trying again.`)), 15_000); }),
    ]);
  } catch (error) { refusal(error); }
  finally {
    if (timer) clearTimeout(timer);
    rowOperation = undefined; refreshGeneration++; renderConnections(); buttons();
  }
}
async function removeSpace(space: string, current: () => boolean = () => true): Promise<void> {
  const result = await request({ op: "service-disconnect", space });
  if (!current()) return;
  if (result.state === "unavailable" || result.state === "refused") throw new Error(String(result.message ?? "The space could not be removed. Try again."));
  if (computerAccount?.hostSupport === "supported") { await refresh(); return; }
  connections.delete(space); instances.delete(space); applicationRefusals.delete(space);
  if (space === selectedSpace()) connection = { space, state: "disconnected" };
  progress = progressNames.map(() => "waiting"); clearDetails(); notice("");
  listOpened = true; state(connection?.state ?? "ready"); showStage("finished");
}
function buttons(): void {
  renderAccountActions();
  el<HTMLButtonElement>("login").disabled = busy || loginActive || !isTauri();
  el<HTMLButtonElement>("other-host").disabled = busy;
  const offline = networkState(computerSummary(computerAccount ? computerSpaces(computerAccount) : [], false)) === "offline";
  el<HTMLButtonElement>("connect").disabled = busy || !ready || !selectedSpace() || connected() || selectionPending || addingSpace && connections.has(selectedSpace()) || offline;
  text("connect", addingSpace ? `Add to ${shownSpaceLabel(accountSpaces.get(selectedSpace())?.label, selectedSpace() || "space")}` : applicationRefusals.has(selectedSpace()) || el("notice").classList.contains("error") ? "Check again" : "Connect this computer");
  el<HTMLButtonElement>("disconnect").disabled = busy || !ready || !selectedSpace();
  el<HTMLButtonElement>("dashboard").disabled = busy || !(connected() || computerAccount?.hostSupport === "supported");
  el<HTMLButtonElement>("sync").disabled = busy || !ready;
  el<HTMLButtonElement>("choose-space").disabled = busy || !selectedSpace();
  const busyId = el("recovery-panel").hidden ? loginActive ? "login" : setupActive ? "connect" : "" : retrySignIn || !loginActive ? "recover" : "";
  for (const id of ["login", "connect", "recover", "sync", "refresh", "disconnect"]) {
    const button = el<HTMLButtonElement>(id);
    const running = busy && id === busyId;
    button.classList.toggle("busy", running); button.setAttribute("aria-busy", String(running));
    if (running && !button.querySelector(".icon-spinner")) { const spin = icon("spinner"); spin.classList.add("button-spinner"); button.prepend(spin); }
    if (!running) button.querySelectorAll(".button-spinner").forEach(spin => spin.remove());
  }
  for (const id of ["space", "change-space", "another-space", "sign-in-again", "retry-login", "refresh", "autostart", "conflicts-refresh"]) (el(id) as HTMLButtonElement).disabled = busy || spaceConflicts.busy;
}
function updateCountdown(): void {
  const remaining = Math.max(0, Math.ceil((approvalExpires - Date.now()) / 1000));
  text("approval-expiry", remaining ? `Expires in ${Math.floor(remaining / 60)}:${String(remaining % 60).padStart(2, "0")}` : "This code has expired.");
  el<HTMLButtonElement>("copy-code").disabled = remaining === 0;
  el<HTMLButtonElement>("open-approval").disabled = remaining === 0;
  if (!remaining && !recoveringConflictAccount && problem !== "EXPIRED") {
    problem = "EXPIRED";
    text("refusal-detail", "The approval code expired before sign-in was confirmed."); el("details").hidden = false;
    showStage("sign-in", true);
    if (countdown) clearInterval(countdown);
  }
}
el("copy-code").addEventListener("click", () => {
  void navigator.clipboard.writeText(el("approval-code").textContent ?? "").then(() => { text("copy-code", "Copied"); text("announcer", "Approval code copied."); }).catch(() => notice("The code could not be copied. Select the code and copy it manually.", true));
});
async function request(body: Request): Promise<Record<string, unknown>> {
  const events = new Channel<Frame>();
  events.onmessage = (frame) => {
    if (frame.event === "setup-progress") { setupProgress(frame); return; }
    if (frame.event !== "login-prompt" || !frame.prompt) return;
    try {
      approval = approvalUrl(frame.prompt.verificationUriComplete);
      text("approval-code", String(frame.prompt.userCode ?? ""));
      const expiry = new Date(String(frame.prompt.expiresAt ?? ""));
      approvalExpires = expiry.valueOf();
      if (!Number.isFinite(approvalExpires)) throw new Error("The approval code has no valid expiry.");
      updateCountdown();
      if (countdown) clearInterval(countdown);
      if (approvalExpires > Date.now()) countdown = setInterval(updateCountdown, 1000);
      el("copy-code").replaceChildren(icon("copy"), document.createTextNode(" Copy"));
      el("approval").hidden = false;
      notice("");
      if (loginActive) showStage("sign-in");
      if (approvalExpires > Date.now()) void invoke("open_browser", { url: approval }).catch(refusal);
    } catch (error) { refusal(error); }
  };
  const result = requireResult(await invoke<Frame>("daemon_request", { request: body, onEvent: events }));
  if (body.op === "status" || body.op === "setup") await refreshPresence(connected());
  return result;
}
function state(value: string, space = selectedSpace()): void {
  if (space !== selectedSpace()) return;
  connection = { space, state: value };
  if (value === "launch-ready" || value === "approval-pending") connections.set(space, value);
  else connections.delete(space);
  const verified = !upgradeNeeded && [...connections.values()].includes("launch-ready");
  if (connected()) problem = undefined;
  if (connected() && !editing) { listOpened = true; showStage("finished"); }
  else if ((value === "approval-pending" || listOpened) && !editing) { listOpened = true; showStage("finished"); }
  else if (stage === "finished" && !listOpened) showStage(selectedSpace() ? "connect" : "welcome");
  else showStage(stage);
  if (isTauri()) void refreshPresence(verified).catch(refusal);
}
const pendingAgentActions = new Map<string, AgentAction>();
function renderAgentRows(status: Record<string, unknown>): void {
  renderAgents(status, el("running-agents"), { pending: pendingAgentActions, act: (agent, op) => void actOnLocalAgent(agent, op) });
}
async function actOnLocalAgent(agent: LocalAgent, op: AgentAction): Promise<void> {
  if (!agent.lifecycleUid) return;
  const key = JSON.stringify([agent.space, agent.name, agent.lifecycleUid]);
  if (pendingAgentActions.has(key)) return;
  if (agentActionProblem) clearDetails();
  pendingAgentActions.set(key, op);
  if (serviceStatus) renderAgentRows(serviceStatus);
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const result = await Promise.race([
      request({ op, space: agent.space, lifecycleUid: agent.lifecycleUid }),
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(op === "agent-stop" ? "Stop did not finish within 30 seconds. Check whether the agent is still running before trying again." : "Opening the terminal did not finish within 30 seconds. Check your terminal before trying again.")), 30_000); }),
    ]);
    if (op === "agent-terminal") {
      if (result.started !== true) throw new Error("The app did not confirm that it opened the terminal.");
      notice(`Terminal opened for ${agent.name}.`);
    }
  } catch (error) {
    agentActionProblem = true;
    showRefusalDetail(error);
    notice("", true);
    showStage(stage);
  }
  finally {
    if (timer) clearTimeout(timer);
    pendingAgentActions.delete(key);
    if (serviceStatus) renderAgentRows(serviceStatus);
    if (op === "agent-stop") void refresh();
  }
}
async function applyStatus(status: Record<string, unknown>, current: () => boolean): Promise<void> {
  if (current()) serviceAvailability = undefined;
  await showStatus(status, current);
  if (current()) updateService();
}
/** Agents running on this computer, named as the agent list names them, or undefined when the
 *  service does not report them. */
function runningAgentNames(): string[] | undefined {
  try {
    const inventory = agentInventory(serviceStatus ?? {});
    return inventory.available && !inventory.unreadable.length ? inventory.agents.filter(agent => agent.state === "running").map(agent => `${shownAgentName(agent.name)} (${agent.application})`) : undefined;
  } catch { return undefined; }
}
function runningAgents(): number | undefined { return runningAgentNames()?.length; }
/** An updated app restarts the older background service into its own version, the daemon's idle
 *  restart, only while no agent runs on this computer. While agents run it waits and says so. */
function updateService(): void {
  const running = runningAgents();
  if (!upgradeNeeded || stage !== "finished" || running === undefined) {
    if (serviceUpdateWaiting) { serviceUpdateWaiting = false; notice(""); }
    return;
  }
  if (running > 0) { waitForAgents(runningAgentNames()!); return; }
  if (busy || setupActive || loginActive || Date.now() < nextServiceUpdate) return;
  serviceUpdateWaiting = false; notice("");
  el<HTMLButtonElement>("connect").click();
}
function waitForAgents(names: readonly string[], count = names.length): void {
  const shown = names.length > 3 ? [...names.slice(0, 3), `${names.length - 3} more`] : names;
  const list = shown.length ? `: ${new Intl.ListFormat("en", { type: "conjunction" }).format(shown)}` : "";
  const message = `An update for the background service is waiting for ${count === 1 ? "1 agent" : `${count} agents`} on this computer to finish${list}. It installs by itself when ${count === 1 ? "it ends" : "they end"}.`;
  // Announce a change, not every status check.
  if (!serviceUpdateWaiting || el("notice").textContent !== message || el("notice").hidden) notice(message);
  serviceUpdateWaiting = true;
}
async function showStatus(status: Record<string, unknown>, current: () => boolean): Promise<void> {
  if (!current()) return;
  selectionPending = false;
  serviceStatus = status;
  ready = status.state === "ready";
  daemonVersion = String(status.version);
  upgradeNeeded = appVersion !== undefined && status.version !== appVersion;
  if ((statusProblem && !upgradeNeeded) || (ready && (problem === "NOT_ANSWERING" || problem === "DAEMON_LOST" || (!upgradeNeeded && el("refusal-detail").textContent?.startsWith("App version "))))) clearDetails();
  renderAgentRows(status);
  if (isTauri()) {
    agentApps.observeRunningAgents(runningAgents());
    if (!agentApps.busy && Date.now() - appsLoadedAt > 30_000 && agentApps.apps === undefined) { appsLoadedAt = Date.now(); void agentApps.load(); }
  }
  updateStatus = status.update as UpdateStatus | undefined;
  renderSettings();
  if (typeof status.computer === "string") renderComputerName(status.computer);
  observedReadySpaces = Array.isArray(status.managers) ? status.managers.filter(launchReady).map(item => String(item.space)) : [];
  managerReasons.clear();
  if (Array.isArray(status.managers)) for (const item of status.managers) {
    if (typeof item.connection?.reason === "string") managerReasons.set(String(item.space), item.connection.reason);
    else if (item.state !== "answering" && typeof item.reason === "string") managerReasons.set(String(item.space), item.reason);
  }
  const space = selectedSpace();
  computerAccount = activeComputerAccount(status.account as ComputerAccount & { accounts?: ComputerAccount[] } | undefined, signedInProvider ?? providers.get(space));
  if (computerAccount?.hostSupport === "supported") {
    computerRows.clear(); connections.clear();
    for (const row of computerSpaces(computerAccount)) {
      computerRows.set(row.space, row);
      connections.set(row.space, !row.lastRefusal && row.observed === "connected" && observedReadySpaces.includes(row.space) ? "launch-ready" : row.observed);
    }
    const manager = Array.isArray(status.managers) ? status.managers.find(item => item.space === space) : undefined;
    if (launchReady(manager)) { instances.set(space, manager.instanceId); }
    else instances.delete(space);
    connection = { space, state: connections.get(space) ?? "ready" };
    if (computerAccount.mode === "account" || computerAccount.mode === "sign-in-required" || computerRows.size || listOpened) { listOpened = true; showStage("finished"); buttons(); return; }
  }
  for (const name of observedReadySpaces) connections.set(name, "launch-ready");
  for (const name of accountSpaces.keys()) {
    if (observedReadySpaces.includes(name) || name === space) continue;
    const service = await request({ op: "service-status", space: name });
    if (!current()) return;
    if (service.state === "approval-pending") connections.set(name, "approval-pending");
    else connections.delete(name);
  }
  if (connections.size && !editing && !linked) listOpened = true;
  if (upgradeNeeded) {
    state("ready", space);
    showStage(stage);
    buttons(); return;
  }
  if (space) {
    const manager = Array.isArray(status.managers) ? status.managers.find((item) => item.space === space) : undefined;
    if (launchReady(manager)) { instances.set(space, manager.instanceId); state("launch-ready", space); buttons(); return; }
    instances.delete(space);
    if (manager?.connection) {
      state("connected", space);
      refusal(new DaemonRefusal(manager.connection.state === "offline" ? "OFFLINE" : "SPACE_UNREACHABLE", String(manager.connection.reason)), true);
      buttons(); return;
    }
    const service = await request({ op: "service-status", space });
    if (!current()) return;
    state(applicationRefusals.has(space) ? "no-application" : String(service.state) === "connected" ? "ready" : String(service.state), space);
    // Manager next steps target the CLI. Details keeps the reason, not the terminal instructions.
    if (manager?.reason) refusal(new DaemonRefusal("DEPENDENCY_UNAVAILABLE", manager.reason));
  } else { state("ready", space); if (stage === "connect") showStage("connect"); }
  buttons();
}
/** Before the first sign-in no service is set up, which is not a problem; a stopped one is. */
function notSetUpYet(error: unknown): boolean {
  return !listOpened && error instanceof DaemonRefusal && error.code === "NOT_RUNNING" && error.detail?.installed !== true;
}
function observeMissingService(error: unknown): void {
  serviceAvailability = notSetUpYet(error) ? "not-set-up" : error instanceof DaemonRefusal && error.code === "NOT_RUNNING" && error.detail?.installed === true && error.detail?.stopped === "by-you" ? "stopped" : undefined;
}
function startStatusWatch(): void {
  if (!isTauri() || watchActive || watchStarting) return;
  watchStarting = true;
  const events = new Channel<Frame>();
  events.onmessage = (frame) => {
    if (frame.event !== "status" || !frame.result) return;
    watchStarting = false;
    watchActive = true;
    setWatchMode(typeof frame.watchMode === "string" ? frame.watchMode : "push");
    if (busy || rowOperation || selectionPending || appApplyRunning) return;
    lastTickAt = Date.now();
    const space = selectedSpace();
    const generation = ++refreshGeneration;
    const current = () => generation === refreshGeneration && space === selectedSpace();
    void applyStatus(frame.result, current).then(async () => {
      if (!current()) return;
      await refreshPresence(connected());
      void checkAppUpdates();
      if (appUpdate?.version && ["available", "ready"].includes(appUpdate.phase)) void applyAppUpdate(false, true);
    }).catch(error => refusal(error, true));
  };
  void invoke<Frame>("daemon_request", { request: { op: "status-watch" }, onEvent: events }).then((frame) => {
    watchStarting = false;
    watchActive = false;
    const result = requireResult(frame);
    if (initialized && result.closed === true && !upgradeNeeded) {
      if (watchReconnect) clearTimeout(watchReconnect);
      watchReconnect = setTimeout(() => {
        watchReconnect = undefined;
        if (!watchActive && !watchStarting && !tickRunning && !busy && !rowOperation && !appApplyRunning) void refresh();
      }, 1000);
    }
  }).catch(async (error) => {
    watchStarting = false;
    watchActive = false;
    if (error instanceof DaemonRefusal && error.code === "VERSION_MISMATCH") {
      const mode = typeof error.detail?.watchMode === "string" ? error.detail.watchMode : "version-mismatch";
      setWatchMode(mode);
      const statusObj = error.result?.status;
      if (statusObj && typeof statusObj === "object" && !Array.isArray(statusObj)) {
        const space = selectedSpace();
        const generation = ++refreshGeneration;
        await applyStatus(statusObj as Record<string, unknown>, () => generation === refreshGeneration && space === selectedSpace());
      } else {
        upgradeNeeded = true;
        if (typeof error.detail?.daemonVersion === "string") daemonVersion = error.detail.daemonVersion;
      }
      statusProblem = true;
      showStage(stage);
      buttons();
      return;
    }
    if (!busy && !loginActive && !setupActive) {
      observeMissingService(error);
      ready = false; serviceStatus = undefined; renderSettings(); state("unavailable");
      if (!(problem && !statusProblem)) {
        if (!(notSetUpYet(error) && (stage === "welcome" || stage === "sign-in"))) refusal(error, true);
      }
      if (listOpened) showStage("finished");
      buttons();
    }
  });
}
async function refresh(): Promise<void> {
  const space = selectedSpace();
  const generation = ++refreshGeneration;
  const current = () => generation === refreshGeneration && space === selectedSpace();
  try {
    const status = await request({ op: "status" });
    await applyStatus(status, current);
    if (!current()) return;
    if (initialized && ready && !upgradeNeeded && !watchActive && !watchStarting) startStatusWatch();
  } catch (error) {
    if (!current()) return;
    observeMissingService(error);
    selectionPending = false;
    ready = false; serviceStatus = undefined; renderSettings(); state("unavailable");
    // An error from an action stays until the person acts on it; a background check never replaces it.
    if (problem && !statusProblem) { buttons(); return; }
    if (!(notSetUpYet(error) && (stage === "welcome" || stage === "sign-in") && !loginActive)) refusal(error, true);
    if (listOpened) showStage("finished");
  }
  buttons();
}
function applySpacesPayload(result: Record<string, unknown>, activeProvider?: string, resetKept = false): void {
  signedInProvidersKnown = Array.isArray(result.signedInProviders);
  signedInProviders = Array.isArray(result.signedInProviders) ? result.signedInProviders.filter((item): item is string => typeof item === "string") : [];
  spaceConflicts.applySpacesResult(result, resetKept);
  const select = el<HTMLSelectElement>("space"); const previous = select.value;
  const connectedProviders = [...providers].filter(([space]) => connections.has(space));
  const retainedSpaces = [...accountSpaces].filter(([space]) => connections.has(space) || computerAccount?.spaces.some(row => row.space === space));
  select.replaceChildren(new Option("Choose a space", "")); providers.clear(); catalogIds.clear(); accountSpaces.clear();
  if (!Array.isArray(result.spaces)) throw new Error("The background service returned no space list.");
  for (const item of result.spaces) {
    if (!item || typeof item.space !== "string" || item.mode !== "user") continue;
    accountSpaces.set(item.space, { space: item.space, label: String(item.label ?? item.space), ...(typeof item.catalogId === "string" ? { catalogId: item.catalogId } : {}), ...(typeof item.kind === "string" ? { kind: item.kind } : {}), ...(typeof item.role === "string" ? { role: item.role } : {}) });
    select.add(new Option(shownSpaceLabel(typeof item.label === "string" ? item.label : undefined, item.space), item.space));
    if (typeof item.idp === "string") providers.set(item.space, item.idp);
    if (typeof item.catalogId === "string") catalogIds.set(item.space, item.catalogId);
  }
  for (const [space, entry] of retainedSpaces) if (!accountSpaces.has(space)) accountSpaces.set(space, { space, label: entry.label });
  for (const [space, provider] of connectedProviders) {
    if (!providers.has(space)) providers.set(space, provider);
    if (![...select.options].some(option => option.value === space)) select.add(new Option(shownSpaceLabel(accountSpaces.get(space)?.label, space), space));
  }
  const preferred = connections.has(previous) ? previous : initialSpace([...accountSpaces.values()], requestedSpace) ?? (accountSpaces.has(previous) ? previous : undefined) ?? observedReadySpaces.find(space => accountSpaces.has(space));
  if (preferred) select.value = preferred;
  choosingSpace = !preferred;
  const message = catalogRefreshNotice(result, activeProvider ?? providers.get(select.value));
  if (spaceConflicts.hasUnresolved && !result.failedProviders?.toString()) notice("");
  else if (message) notice(message);
  renderConnections();
  buttons();
}
async function spaces(refreshCatalog: boolean, resetKept = false): Promise<void> {
  const activeProvider = signedInProvider ?? providers.get(selectedSpace()) ?? computerAccount?.idpUrl;
  const result = await request({ op: "spaces", refresh: refreshCatalog });
  applySpacesPayload(result, activeProvider, resetKept);
}
async function action(fn: () => Promise<void>): Promise<void> {
  if (busy) return; busy = true; refreshGeneration++; buttons();
  try { await fn(); } catch (error) { refusal(error); }
  finally {
    refreshGeneration++; busy = false; showStage(stage);
    if (retrySignIn) {
      retrySignIn = false;
      if (activeMove) { const m = activeMove; void action(() => runSignInFlow(m.provider, m.migrateFrom)); }
      else { beginSignIn(); el<HTMLFormElement>("login-form").requestSubmit(); }
    }
  }
}
function nextAfterSignIn(): void {
  editing = false;
  connection = undefined;
  if (selectedSpace()) showStage("connect", true);
  else {
    showStage("connect", true);
    if (requestedSpace && !selectedSpace()) notice([el("notice-wrap").classList.contains("expanded") ? el("notice").textContent : "", "The requested space is not available to this account. Ask its owner for access, then refresh spaces."].filter(Boolean).join(" "));
    else if (!el<HTMLSelectElement>("space").options[1] && !spaceConflicts.hasUnresolved) { problem = "NO_SPACES"; showStage("connect", true); }
  }
}
async function runSignInFlow(provider: string, migrateFrom?: string): Promise<void> {
  activeMove = migrateFrom ? { provider, migrateFrom } : undefined;
  conflictsOpen = false;
  loginActive = true; editing = true; clearDetails(); notice(""); showStage("sign-in", true);
  try {
    if (!ready) { await startService(); await refresh(); if (!ready) throw new Error("The background service is not ready."); }
    const result = await request({ op: "login", idp: provider, ...(migrateFrom ? { migrateFrom } : {}) });
    problem = undefined; refusalSummary = undefined;
    if (result.outcome !== "signed-in") {
      const baseCode = String(result.reason ?? "refused").toUpperCase().replaceAll("-", "_");
      const code = migrateFrom && baseCode === "LOCAL_STATE_ERROR" ? "MOVE_REFUSED" : baseCode;
      const remedy = typeof result.remedy === "string" && !/[`]|\/|\\/.test(result.remedy) ? result.remedy : undefined;
      throw new DaemonRefusal(code, [String(result.message ?? "Sign-in was not completed."), remedy ? `Next: ${remedy}` : ""].filter(Boolean).join("\n"), undefined, remedy);
    }
    activeMove = undefined;
    signedInProvider = provider;
    for (const item of signedOutProviders) if (sameProvider(item, provider)) signedOutProviders.delete(item);
    if (migrateFrom) signedOutProviders.add(canonicalProvider(migrateFrom));
    notice(""); await spaces(true, true); await refresh();
    if (computerAccount?.hostSupport === "supported" && computerAccount.mode === "account") {
      editing = false; completedSetup = true; listOpened = true; showStage("finished");
    } else nextAfterSignIn();
    if (migrateFrom && !spaceConflicts.hasUnresolved) notice(`Moved your spaces to ${new URL(provider).host}.`);
    // The account switch stands; credential files of the previous account it could not delete are named.
    const kept = keptCredentialsNotice(result);
    if (kept) notice([el("notice-wrap").classList.contains("expanded") ? el("notice").textContent : "", kept].filter(Boolean).join(" "), true);
  } finally { loginActive = false; approval = undefined; if (countdown) clearInterval(countdown); el("approval").hidden = true; }
}
function runEndorsedMove(migration: EndorsedMigration): Promise<void> {
  return action(() => runSignInFlow(canonicalProvider(migration.toIdp), canonicalProvider(migration.fromIdp)));
}
async function recoverConflictAccount(idp: string, space: string): Promise<void> {
  const previousStage = stage;
  conflictsOpen = false;
  recoveringConflictAccount = loginActive = true;
  clearDetails(); notice(""); showStage("sign-in", true);
  try {
    const result = await request({ op: "login", idp, recoverSpace: space });
    if (result.outcome === "signed-in") {
      for (const item of signedOutProviders) if (sameProvider(item, idp)) signedOutProviders.delete(item);
      if (!signedInProviders.some(item => sameProvider(item, idp))) signedInProviders.push(idp);
      // A catalog refresh can remove unlisted rows. Read the move offer without applying a catalog.
      const observed = await request({ op: "spaces", refresh: false }).catch(() => ({}));
      spaceConflicts.accountRecoveryResult(idp, observed);
      spaceConflicts.recoveryMessage(`Signed in to ${new URL(idp).host}. The active provider and saved registrations did not change.`, false);
    } else if (result.outcome === "cancelled" || result.reason === "expired") {
      spaceConflicts.recoveryMessage("Sign-in was not completed. Nothing was changed. Try signing in again, or keep the existing registration.", true);
    } else {
      const message = typeof result.message === "string" ? result.message : "Sign-in was not completed.";
      const remedy = typeof result.remedy === "string" ? result.remedy : "Try signing in again, or keep the existing registration.";
      spaceConflicts.recoveryMessage(`${message} ${remedy}`, true);
    }
  } catch (error) {
    spaceConflicts.recoveryMessage(error instanceof Error ? error.message : String(error), true);
  } finally {
    recoveringConflictAccount = loginActive = false;
    approval = undefined;
    if (countdown) clearInterval(countdown);
    el("approval").hidden = true;
    showStage(previousStage);
    openConflicts();
  }
}
el<HTMLInputElement>("provider").value = COTAL_CLOUD_IDP;
el("other-host").addEventListener("click", () => { activeMove = undefined; customHost = true; el<HTMLInputElement>("provider").value = ""; showStage(stage); el("provider").focus(); });
el("cloud-host").addEventListener("click", () => { activeMove = undefined; customHost = false; el<HTMLInputElement>("provider").value = ""; showStage(stage); el("login").focus(); });
el("login-form").addEventListener("submit", (event) => {
  event.preventDefault();
  void action(() => runSignInFlow(canonicalProvider(el<HTMLInputElement>("provider").value.trim())));
});
el("recover").addEventListener("click", () => {
  if (el("recover").dataset.action === "none") return;
  if (busy) { if (problem === "EXPIRED" && !retrySignIn) { retrySignIn = true; showStage(stage); } return; }
  const recovery = el("recover").dataset.action;
  const reviewMove = problem === "MOVE_REFUSED";
  const keepNotAnswering = problem === "NOT_ANSWERING" && recovery === "refresh";
  if (!keepNotAnswering) { problem = undefined; refusalSummary = undefined; }
  notice("");
  if (recovery === "login") {
    if (activeMove) { const m = activeMove; void action(() => runSignInFlow(m.provider, m.migrateFrom)); }
    else { beginSignIn(); el<HTMLFormElement>("login-form").requestSubmit(); }
  }
  else if (recovery === "connect") el<HTMLButtonElement>("connect").click();
  else if (recovery === "spaces") {
    if (!reviewMove) { void action(async () => { await spaces(true); nextAfterSignIn(); }); return; }
    activeMove = undefined;
    void action(async () => {
      await spaces(true);
      await refresh();
      if (computerAccount?.hostSupport === "supported" && computerAccount.mode === "account") {
        editing = false; completedSetup = true; listOpened = true; showStage("finished");
      } else nextAfterSignIn();
      if (spaceConflicts.hasUnresolved) openConflicts();
    });
  }
  else if (recovery === "start") void action(async () => {
    clearDetails();
    await request({ op: "start" });
    await refresh();
  });
  else if (recovery === "install") void action(async () => {
    clearDetails();
    await startService();
    await refresh();
    if (!ready) throw new Error("The background service is not ready.");
    notice("");
  });
  else void action(async () => { if (!keepNotAnswering) clearDetails(); await refresh(); });
});
/** The install request's progress lines all say "running"; only its result ends them, so the list resets. */
async function startService(): Promise<void> {
  notice("Preparing the background service…");
  try { await request({ op: "install" }); }
  finally { progress = progressNames.map(() => "waiting"); renderProgress(); }
}
el("open-approval").addEventListener("click", () => { if (approval) void invoke("open_browser", { url: approval }).catch(refusal); });
function beginSignIn(): void {
  if (busy) return;
  editing = true;
  const provider = providers.get(selectedSpace()) ?? (!customHost && !linked ? computerAccount?.idpUrl : undefined);
  if (provider) el<HTMLInputElement>("provider").value = provider;
  customHost = !isCotalCloudIdp(el<HTMLInputElement>("provider").value);
  notice(""); clearDetails(); progress = progressNames.map(() => "waiting"); showStage("sign-in", true);
}
el("choose-space").addEventListener("click", () => {
  if (!busy && selectedSpace()) { choosingSpace = false; notice(""); connection = undefined; showStage(addingSpace ? "finished" : "connect", true); void refresh(); }
});
el("change-space").addEventListener("click", () => { if (!busy) { addingSpace = false; choosingSpace = false; editing = false; showStage("finished", true); } });
el("another-space").addEventListener("click", () => {
  if (busy) return;
  editing = true; addingSpace = true; choosingSpace = true;
  const select = el<HTMLSelectElement>("space");
  for (const option of select.options) { option.hidden = false; option.disabled = connections.has(option.value); }
  select.value = ""; connection = undefined;
  text("no-other-spaces", [...select.options].some(option => option.value && !option.disabled) ? "" : "Every space in this account is already connected.");
  notice(""); clearDetails(); progress = progressNames.map(() => "waiting"); showStage("finished", true); select.focus();
});
el("retry-login").addEventListener("click", beginSignIn);
el("sign-in-again").addEventListener("click", () => { beginSignIn(); if (computerAccount?.mode === "sign-in-required") el<HTMLFormElement>("login-form").requestSubmit(); });
el("connect").addEventListener("click", () => void action(async () => {
  if (connected() || selectionPending || addingSpace && connections.has(selectedSpace()) || !ready || !selectedSpace()) return;
  if (networkState(computerSummary(computerAccount ? computerSpaces(computerAccount) : [], false))) return;
  const space = selectedSpace(); const idp = providers.get(space) ?? el<HTMLInputElement>("provider").value.trim();
  setupActive = true; editing = false; applications = []; clearDetails(); notice("");
  progress = ["running", "waiting", "waiting", "waiting", "waiting"]; renderProgress(); showStage("connect", true);
  try {
    const result = await request({ op: "setup", space, idp });
    if (result.launchReady !== true || !launchReady(result.manager)) throw new Error("Setup did not confirm that this computer can launch agent applications.");
    applicationRefusals.delete(space); upgradeNeeded = false;
    instances.set(space, (result.manager as { instanceId: string }).instanceId);
    progress = progressNames.map(() => "done"); renderProgress();
    completedSetup = true; addingSpace = false; choosingSpace = false; listOpened = true;
    state("launch-ready", space); notice(""); showStage("finished", true);
  } catch (error) {
    const failed = progress.indexOf("failed");
    const active = progress.indexOf("running");
    if (failed < 0) progress[active < 0 ? 4 : active] = "failed"; renderProgress();
    if (upgradeNeeded && error instanceof DaemonRefusal && (error.native === "SEATS_ACTIVE" || error.code === "SEATS_ACTIVE")) {
      // An agent started after the last check. Keep waiting for it rather than taking over the window.
      nextServiceUpdate = Date.now() + 600_000;
      progress = progressNames.map(() => "waiting"); renderProgress();
      setupActive = false; state("launch-ready", space); showStage("finished");
      waitForAgents(runningAgentNames() ?? [], Math.max(1, Number(/holds (\d+) active seat/.exec(error.message)?.[1] ?? runningAgents() ?? 1)));
      return;
    }
    if (error instanceof DaemonRefusal && error.native === "NO_AVAILABLE_CONNECTOR") { applicationRefusals.add(space); state("no-application", space); }
    else if (error instanceof DaemonRefusal && (error.code === "APPROVAL_PENDING" || error.native === "APPROVAL_PENDING")) {
      addingSpace = false; choosingSpace = false; listOpened = true; problem = undefined; state("approval-pending", space); showStage("finished"); return;
    } else state("unavailable", space);
    throw error;
  } finally { setupActive = false; }
}));
el("disconnect").addEventListener("click", () => void action(async () => {
  const space = selectedSpace(); instances.delete(space);
  const result = await request({ op: "service-disconnect", space });
  await request({ op: "status" });
  applicationRefusals.delete(space); progress = progressNames.map(() => "waiting"); clearDetails();
  state(String(result.state), space); notice("");
}));
el("sync").addEventListener("click", () => void action(async () => { notice(""); await spaces(true); }));
el("refresh").addEventListener("click", () => void action(refresh));
el("space").addEventListener("change", () => {
  signedInProvider = undefined; connection = undefined; selectionPending = true;
  progress = progressNames.map(() => "waiting"); clearDetails(); notice(""); showStage(stage); buttons();
  void refresh();
});
function openDashboard(fromTray = false): void {
  const verified = (space: string) => !upgradeNeeded && connections.get(space) === "launch-ready" && !!instances.get(space) && !computerRows.get(space)?.lastRefusal;
  const selected = selectedSpace();
  const space = fromTray && !verified(selected) ? [...connections.keys()].find(name => verified(name) && providers.has(name) && catalogIds.has(name)) ?? selected : selected;
  const provider = providers.get(space) ?? (space === selected ? computerAccount?.idpUrl ?? el<HTMLInputElement>("provider").value.trim() : undefined);
  const spaceId = catalogIds.get(space), instanceId = instances.get(space);
  if (computerAccount?.hostSupport === "supported" && computerAccount.mode !== "sign-in-required" && provider) void invoke("open_browser", { url: new URL("/machines", approvalUrl(provider)).href }).catch(refusal);
  else if (verified(space) && spaceId && instanceId && provider) void invoke("open_browser", { url: machinesUrl(provider, spaceId, instanceId) }).catch(refusal);
  else { openSettings(); notice("The dashboard needs a verified connection and the space's saved address. Refresh spaces before trying again."); }
}
el("dashboard").addEventListener("click", () => openDashboard());
async function readServiceLog(): Promise<void> {
  const button = el<HTMLButtonElement>("refresh-log");
  if (button.disabled) return;
  button.disabled = true; text("service-log-status", "Reading recent output…");
  try {
    const result = await request({ op: "log" });
    if (typeof result.text !== "string") throw new Error("The background service log reply is unsupported.");
    text("service-log-text", result.text);
    text("service-log-status", !result.text ? "No background service log has been recorded." : result.truncated ? "Showing recent output. Older lines were omitted." : "Recent background service output.");
  } catch (error) {
    text("service-log-text", "");
    text("service-log-status", error instanceof Error ? error.message : String(error));
  } finally { button.disabled = false; }
}
el("refresh-log").addEventListener("click", () => void readServiceLog());
el("service-log").addEventListener("toggle", () => { if (el<HTMLDetailsElement>("service-log").open) void readServiceLog(); });
el("connection-status").addEventListener("click", () => {
  selectView("view-connection");
  if (!el("details").hidden) {
    el<HTMLDetailsElement>("details").open = true;
    el("details").querySelector<HTMLElement>("summary")!.focus();
  } else {
    const issue = computerAccount && computerSpaces(computerAccount).find(row => row.lastRefusal || !["connected", "approval-pending", "removed on this computer", "starting", "connecting", "not-requested"].includes(row.observed));
    const row = issue ? [...el("connected-spaces").querySelectorAll<HTMLElement>("li")].find(row => row.dataset.space === issue.space) : undefined;
    if (row) row.tabIndex = -1;
    (row ?? el("connection-title")).focus();
    (row ?? el("connection-title")).scrollIntoView({ block: "nearest" });
  }
});
function renderApps(): void {
  agentApps.renderPanel(el("app-list"), el("apps-message"), el<HTMLButtonElement>("apps-refresh"));
  const management = agentApps.management;
  el("apps-local").hidden = management !== "local" || stage === "finished";
  const ownerMessage = agentApps.ownerMessage;
  el("apps-owner").hidden = !ownerMessage;
  el("apps-owner").classList.toggle("warning", !!ownerMessage && agentApps.management === "other-copy");
  el("apps-fix-connection").hidden = !agentApps.showFixConnection;
  text("apps-owner", ownerMessage);
  if (appsOpen && agentApps.retryOwnerCheck) {
    appsOwnerRetry ??= setTimeout(() => { appsOwnerRetry = undefined; if (appsOpen && agentApps.retryOwnerCheck) void agentApps.load(); }, 5000);
  } else if (appsOwnerRetry !== undefined) { clearTimeout(appsOwnerRetry); appsOwnerRetry = undefined; }
}
function renderConflicts(): void {
  spaceConflicts.renderPanel(el("conflicts-migration"), el("conflict-list"), el("conflicts-message"), busy || loginActive);
}
function openConflicts(): void {
  if (loginActive || setupActive) return;
  conflictsOpener = document.activeElement instanceof HTMLElement ? document.activeElement : undefined;
  appsOpen = false; settingsOpen = false; conflictsOpen = true;
  renderSettings(); document.querySelector("main")!.scrollTop = 0; el("conflicts-title").focus({ preventScroll: true });
}
function closeConflicts(): void {
  conflictsOpen = false; showStage(stage);
  (conflictsOpener?.isConnected && conflictsOpener.getClientRects().length ? conflictsOpener : el("connection-title")).focus();
}
function openApps(): void {
  selectView("view-apps"); el("apps-title").focus({ preventScroll: true });
}
function openSettings(): void {
  selectView("view-settings"); el("settings-title").focus({ preventScroll: true });
}
const viewTabs = ["view-connection", "view-apps", "view-settings"] as const;
function syncViewTabs(): void {
  const current = appsOpen ? "view-apps" : settingsOpen ? "view-settings" : "view-connection";
  for (const id of viewTabs) {
    const tab = el(id);
    tab.setAttribute("aria-selected", String(id === current));
    tab.tabIndex = id === current ? 0 : -1;
  }
}
function selectView(id: typeof viewTabs[number]): void {
  const changed = conflictsOpen || appsOpen !== (id === "view-apps") || settingsOpen !== (id === "view-settings");
  conflictsOpen = false;
  appsOpen = id === "view-apps";
  settingsOpen = id === "view-settings";
  renderSettings();
  if (changed) document.querySelector("main")!.scrollTop = 0;
  if (appsOpen && !agentApps.busy) void agentApps.load();
  if (settingsOpen && appUpdaterConfigured()) void readAutoUpdates().then(renderSettings).catch(error => text("settings-message", error instanceof Error ? error.message : String(error)));
}
for (const [index, id] of viewTabs.entries()) {
  el(id).addEventListener("click", () => { selectView(id); el(id).focus(); });
  el(id).addEventListener("keydown", event => {
    const target = event.key === "Home" ? 0 : event.key === "End" ? 2 : ["ArrowDown", "ArrowRight"].includes(event.key) ? (index + 1) % 3 : ["ArrowUp", "ArrowLeft"].includes(event.key) ? (index + 2) % 3 : undefined;
    if (target === undefined) return;
    event.preventDefault();
    selectView(viewTabs[target]!);
    el(viewTabs[target]!).focus();
  });
}
async function settingsAction(body: Request): Promise<void> {
  if (busy) return;
  busy = true; refreshGeneration++;
  installerMessage = undefined;
  el<HTMLButtonElement>("check-updates").disabled = true;
  el<HTMLInputElement>("update-preference").disabled = true;
  try {
    if (body.op === "update-check" && appUpdaterConfigured()) await checkAppUpdates(true);
    else {
      const result = await request(body);
      if (body.op === "update-policy") {
        if (typeof result.auto !== "boolean") throw new Error("The automatic update preference is unavailable.");
        autoUpdates = result.auto;
      } else updateStatus = result.update as UpdateStatus | undefined;
      if (body.op === "update-check") await checkAppUpdates(true);
    }
    announce(body.op === "update-check" ? appUpdaterConfigured() ? "Update check complete." : "Update check complete. Cached results may be used." : "Update preference saved.");
    text("settings-message", "");
  } catch (error) { text("settings-message", error instanceof Error ? error.message : String(error)); }
  finally {
    busy = false; refreshGeneration++; renderSettings(); el<HTMLButtonElement>("check-updates").disabled = false;
    if (body.op === "update-check" && appUpdate && ["available", "ready"].includes(appUpdate.phase)) void applyAppUpdate();
  }
}
el("restart-update").addEventListener("click", () => void applyAppUpdate(true));
el("check-updates").addEventListener("click", () => void settingsAction({ op: "update-check" }));
el("update-preference").addEventListener("change", () => {
  const enabled = el<HTMLInputElement>("update-preference").checked;
  const policy = updatePolicy(updateStatus?.channel, appPlatform, appUpdaterConfigured());
  void settingsAction(appUpdaterConfigured() ? { op: "update-policy", auto: enabled } : { op: "update-settings", ...(policy.label === "Install updates automatically" ? { auto: enabled } : { notify: enabled }) });
});
el("update-download").addEventListener("click", () => void openInstaller());
el("setup-installer").addEventListener("click", event => { event.preventDefault(); void invoke("open_browser", { url: el<HTMLAnchorElement>("setup-installer").href }).catch(refusal); });
el("settings-download").addEventListener("click", () => void openInstaller());
el("apps-fix-connection").addEventListener("click", () => { selectView("view-connection"); el("connection-title").focus(); });
el("apps-refresh").addEventListener("click", () => void agentApps.load(true));
el("conflicts-back").addEventListener("click", closeConflicts);
el("conflicts-refresh").addEventListener("click", () => void action(async () => { await spaces(true); renderConflicts(); }));
el("recover-apps").addEventListener("click", () => openApps());
window.addEventListener("focus", () => { if (isTauri() && !agentApps.busy && (appsOpen || agentApps.apps && Date.now() - appsLoadedAt > 30_000)) void agentApps.load(); });
el("account-outcome-back").addEventListener("click", () => { accountOutcomeOpen = false; renderSettings(); el("settings-title").focus(); });
el("settings-signout").addEventListener("click", () => confirmAccountAction("logout"));
el("settings-disconnect").addEventListener("click", () => confirmAccountAction("disconnect"));
el("account-cancel").addEventListener("click", closeAccountConfirmation);
el("account-confirm").addEventListener("click", () => void runAccountAction());
el("settings-panel").addEventListener("keydown", event => {
  if (event.key === "Escape" && pendingAccountAction) { event.preventDefault(); event.stopPropagation(); closeAccountConfirmation(); }
});
el("update-later").addEventListener("click", () => { dismissedUpdate = offeredVersion(); if (dismissedUpdate) localStorage.setItem("dismissed-update", dismissedUpdate); renderSettings(); });
el("release-notes").addEventListener("click", () => { if (appVersion) void invoke("open_browser", { url: releaseUrl(appVersion) }).catch(refusal); });
el("autostart").addEventListener("change", () => void action(async () => {
  const checkbox = el<HTMLInputElement>("autostart");
  await setLoginPreference(checkbox.checked);
}));
function receiveLinks(urls: string[]): void {
  if (busy || loginActive) { refusal(new Error("Finish the current operation before opening another connection link.")); return; }
  if (urls.length !== 1) { refusal(new Error("Open one computer-connection link at a time.")); return; }
  try {
    const link = onboardingLink(urls[0]); el<HTMLInputElement>("provider").value = link.idp;
    requestedSpace = link.space; linked = true; editing = true;
    text("link-context", `${link.space ? "Connecting your account at" : "Connecting with"} ${new URL(link.idp).host}. Sign in below to continue.`); el("link-context").hidden = false;
    notice(""); showStage("welcome");
  } catch (error) { refusal(error); }
}
async function start(): Promise<void> {
  showStage("welcome");
  if (!isTauri()) {
    text("machine-details", "Computer information is unavailable in browser preview."); text("version", "Preview");
    notice("Browser preview only. Native controls are unavailable here. No connection is simulated.");
    el<HTMLInputElement>("autostart").disabled = true; document.querySelector(".app")!.classList.remove("loading"); return;
  }
  const schedulePoll = () => {
    if (poll) clearTimeout(poll);
    const delayMs = !ready && appliedUpdate ? 1000 : 60_000;
    poll = setTimeout(() => void tick(), delayMs);
  };
  const tick = async () => {
    if (tickRunning) return;
    if (poll) { clearTimeout(poll); poll = undefined; }
    tickRunning = true;
    try {
      if (!busy && !appApplyRunning) {
        lastTickAt = Date.now();
        if (!watchActive) await refresh();
        void checkAppUpdates();
        if (appUpdate?.version && ["available", "ready"].includes(appUpdate.phase)) void applyAppUpdate(false, true);
      }
    } finally {
      tickRunning = false;
      if (initialized) schedulePoll();
    }
  };
  try {
    await startPresence(notice, { settings: openSettings, dashboard: () => openDashboard(true) });
    await onOpenUrl(receiveLinks); const initialLinks = await getCurrent(); if (initialLinks?.length) receiveLinks(initialLinks);
    const info = await request({ op: "about" }); appVersion = String(info.version);
    appPlatform = String(info.platform); appArch = String(info.arch);
    renderComputerName(String(info.machine)); text("version", `v${String(info.version)}`);
    const os = ({ darwin: "macOS", win32: "Windows", linux: "Linux" } as Record<string, string>)[String(info.platform)] ?? String(info.platform);
    const arch = info.platform === "darwin" && info.arch === "arm64" ? "Apple silicon" : ({ x64: "64-bit Intel / AMD", arm64: "ARM64", ia32: "32-bit Intel" } as Record<string, string>)[String(info.arch)] ?? String(info.arch);
    text("machine-details", `${os} · ${arch} · ${Math.round(Number(info.memoryBytes) / 1024 ** 3)} GB`);
    await listen<AppUpdate>("desktop-update", event => {
      appUpdate = event.payload;
      if (appUpdate.phase === "downloading" || appUpdate.phase === "installing") appliedUpdate = undefined;
      renderSettings();
    });
    await listen("desktop-hidden", () => {
      windowHidden = true;
      void applyAppUpdate();
    });
    await listen("desktop-shown", () => {
      const wasHidden = windowHidden;
      windowHidden = false;
      if (wasHidden && initialized && !watchActive && !tickRunning) void tick();
    });
    await listen("desktop-tray-open", () => {
      if (windowHidden && initialized && !watchActive && !tickRunning && Date.now() - lastTickAt >= 1000) void tick();
    });
    try {
      appliedUpdate = await invoke<AppUpdateReceipt | undefined>("app_update_receipt") ?? undefined;
      if (appliedUpdate?.phase === "failed") nextAppApplyTick = Date.now() + 600_000;
    }
    catch (error) { text("settings-message", error instanceof Error ? error.message : String(error)); }
    void checkAppUpdates();
    await refresh();
    if (ready) {
      await spaces(false);
      if (selectedSpace()) { if (!linked) showStage("connect"); await refresh(); }
      else if (!linked && el<HTMLSelectElement>("space").options.length > 1) showStage("connect");
    }
  } catch (error) {
    if (error instanceof DaemonRefusal && error.code === "SETUP_INTERRUPTED") text("machine-details", "Computer information is unavailable while setup is incomplete.");
    refusal(error);
  }
  initialized = true;
  lastTickAt = Date.now();
  document.querySelector(".app")!.classList.remove("loading");
  showStage(stage);
  if (ready) startStatusWatch();
  schedulePoll();
}
const details = el<HTMLDetailsElement>("details");
document.addEventListener("keydown", event => {
  if (event.key === "," && !event.altKey && !event.shiftKey && (appPlatform === "darwin" ? event.metaKey : event.ctrlKey)) {
    event.preventDefault(); openSettings(); return;
  }
  if (event.key === "Escape" && details.open && !settingsOpen && !appsOpen) {
    event.preventDefault(); details.open = false;
    details.querySelector<HTMLElement>("summary")!.focus();
  }
  if (event.key !== "Enter" || event.defaultPrevented || (event.target as Element).closest("button,input,select,summary")) return;
  const primary = [...document.querySelectorAll<HTMLButtonElement>(".connection-card .primary:not(:disabled):not([hidden])")].find(button => !button.closest("[hidden]"));
  if (primary) { event.preventDefault(); primary.click(); }
});
window.addEventListener("beforeunload", () => { if (poll) clearTimeout(poll); if (watchReconnect) clearTimeout(watchReconnect); if (countdown) clearInterval(countdown); });
if (isTauri()) {
  void reportFirstPaint(document.querySelector<HTMLImageElement>(".brand-mark")!, document.querySelector<HTMLElement>(".sidebar")!, () => invoke<boolean | null>("first_paint"))
    .then(visible => { if (visible === false) windowHidden = true; return start(); }, error => { notice(String(error), true); return start(); });
} else void start();
