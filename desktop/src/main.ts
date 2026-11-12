import { renderAgents } from "./agents";
import { computerName } from "./computer-name";
import { updateNotice, updatePolicy, updateSummary, newerVersion, releaseUrl, installerLink, lastChecked, accountHost, type UpdateStatus } from "./updates";
import { Channel, invoke, isTauri } from "@tauri-apps/api/core";
import { getCurrent, onOpenUrl } from "@tauri-apps/plugin-deep-link";
import { refreshPresence, setLoginPreference, startPresence } from "./presence";
import { canonicalProvider, activeComputerAccount, catalogRefreshNotice, type ComputerAccount, approvalUrl, connectionView, refusalView, requireResult, onboardingLink, launchReady, machinesUrl, COTAL_CLOUD_IDP, DaemonRefusal, initialSpace, computerSpaces, computerSpaceState, type ComputerSpace, type AccountSpace, type Frame, type Request } from "./model";
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
  if (id === "connection-title" && value === "This computer is connected") {
    const highlight = document.createElement("span"); highlight.className = "connected-highlight"; highlight.textContent = "connected";
    node.replaceChildren(document.createTextNode("This computer is "), highlight);
  } else node.textContent = value;
};
function setIcon(node: Element, name: Icon): void {
  if (node.getAttribute("data-icon") === name) return;
  node.setAttribute("data-icon", name); node.replaceChildren(icon(name));
}
setIcon(el("machine-icon"), "computer");
setIcon(el("loading-icon"), "spinner");
el("dashboard").append(icon("external"));
type Stage = "welcome" | "sign-in" | "connect" | "finished";
let nameEditing = false;
let savedComputerName = "This computer";
const computerNameFormHome = el("computer-name-form").parentElement!;
function renderComputerName(value: string): void {
  savedComputerName = value; text("machine-name", value); el("machine-name").title = value;
}
function closeNameEditor(): void {
  nameEditing = false; el("computer-name-form").hidden = true; el("machine-name").hidden = false;
  computerNameFormHome.append(el("computer-name-form"));
  el("settings-computer").hidden = false; el("settings-name").hidden = false;
  el("edit-computer-name").hidden = !(stage === "connect" || stage === "finished");
  (settingsOpen ? el("settings-name") : el("edit-computer-name")).focus();
}
el("edit-computer-name").addEventListener("click", () => {
  nameEditing = true; el("machine-name").hidden = !settingsOpen; el("edit-computer-name").hidden = true;
  if (settingsOpen) {
    el("settings-computer").parentElement!.append(el("computer-name-form"));
    el("settings-computer").hidden = true; el("settings-name").hidden = true;
  }
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
let approvalExpires = 0;
let countdown: ReturnType<typeof setInterval> | undefined;
let stage: Stage = "welcome";
let ready = false;
let appVersion: string | undefined;
let settingsOpen = false;
let updateStatus: UpdateStatus | undefined;
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
async function openInstaller(): Promise<void> {
  const version = updateStatus?.latest;
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
const preferencesHome = el("preferences").parentElement!;
preferencesHome.insertBefore(el("update-banner"), el("connection-icon"));
function renderSettings(): void {
  const configured = stage === "finished" && !setupActive;
  el("open-settings").hidden = !configured;
  text("open-settings", settingsOpen ? "Back" : "Settings");
  el("settings-panel").hidden = !settingsOpen;
  document.querySelector<HTMLElement>(".connection-card")!.hidden = settingsOpen;
  document.querySelector(".app")!.classList.toggle("settings-open", settingsOpen);
  const latest = appVersion ? updateNotice(updateStatus, appVersion, dismissedUpdate) : undefined;
  const nextTray = configured ? latest : undefined;
  if (isTauri() && nextTray !== trayUpdate) { trayUpdate = nextTray; void invoke("set_update_notice", { version: nextTray ?? null }).catch(error => notice(String(error), true)); }
  el("update-banner").hidden = !configured || settingsOpen || !latest;
  text("update-banner-copy", latest ? `Cotal ${latest} is available.` : "");
  text("settings-computer", savedComputerName);
  text("settings-versions", `App ${appVersion ?? "Unavailable"} · Service ${daemonVersion}`);
  text("settings-update-summary", updateSummary(updateStatus, appVersion ?? ""));
  text("settings-last-check", installerMessage ?? lastChecked(updateStatus?.lastCheck));
  text("settings-spaces", disconnectSpaces(accountProvider()).map(space => accountSpaces.get(space)?.label ?? space).join(", ") || "No observed spaces for this provider");
  const policy = updatePolicy(updateStatus?.channel, appPlatform);
  text("update-preference-label", policy.label); text("update-policy", policy.description);
  el<HTMLInputElement>("update-preference").checked = policy.label === "Install updates automatically" ? updateStatus?.automatic === true : updateStatus?.notify !== false;
  const available = appVersion && newerVersion(updateStatus?.latest, appVersion);
  if (available && updateStatus?.latest && releaseVersion !== updateStatus.latest && releaseLoading !== updateStatus.latest && releaseFailed !== updateStatus.latest) void loadRelease(updateStatus.latest);
  const download = updateStatus?.latest && releaseVersion === updateStatus.latest ? installerLink(updateStatus.latest, appPlatform, appArch, releaseAssets) : undefined;
  for (const id of ["update-download", "settings-download"]) { text(id, download?.label ?? "Checking release…"); el<HTMLButtonElement>(id).disabled = !download; }
  el("settings-download-row").hidden = !available;
  text("settings-download-copy", available ? `Version ${updateStatus?.latest}. Installer availability is checked when opened.` : "");
  text("settings-account", [accountHost(accountProvider()), computerAccount?.label ?? computerAccount?.sub].filter(Boolean).join(" · "));
  renderAccountActions();
  el("settings-panel").classList.toggle("confirming-account", !!pendingAccountAction);
  el("settings-panel").classList.toggle("account-outcome-view", accountOutcomeOpen);
  el("account-outcome-back").hidden = !accountOutcomeOpen;
  el("account-outcome").hidden = !accountOutcomeOpen;
  el("preferences").hidden = !settingsOpen;
  if (settingsOpen) { el("settings-startup").append(el("preferences")); el("preferences").hidden = false; }
  else if (el("preferences").parentElement !== preferencesHome) preferencesHome.append(el("preferences"));
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
  el<HTMLButtonElement>("settings-signout").disabled = blocked || !signedInAccountProvider();
  el<HTMLButtonElement>("settings-disconnect").disabled = blocked || !disconnectSpaces(accountProvider()).length;
  el<HTMLButtonElement>("open-settings").disabled = busy;
  el<HTMLButtonElement>("settings-back").disabled = busy;
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
    const li = document.createElement("li"); const label = accountSpaces.get(space)?.label;
    li.textContent = label && label !== space ? `${label} (${space})` : space; return li;
  }));
  text("account-confirm", kind === "logout" ? "Sign out" : "Disconnect listed spaces");
  renderSettings(); el("account-cancel").focus();
}
async function runAccountAction(): Promise<void> {
  const target = pendingAccountAction;
  if (!target || busy || loginActive) return;
  busy = true; refreshGeneration++; buttons(); renderSettings();
  const outcomes: string[] = [];
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
          outcomes.push(`${space}: service reports disconnected; checking current status.`);
        } catch (error) { outcomes.push(`${space}: ${error instanceof Error ? error.message : String(error)}`); }
        text("account-outcome", outcomes.join("\n"));
      }
    }
    try { await spaces(false); catalogRefreshed = true; } catch (error) { outcomes.push(`Space refresh: ${error instanceof Error ? error.message : String(error)}`); }
    await refresh();
    // Replace progress-only rows with the final observation, keeping operation errors.
    for (const space of acknowledged) {
      const index = outcomes.indexOf(`${space}: service reports disconnected; checking current status.`);
      if (index >= 0) outcomes.splice(index, 1);
    }
    if (target.kind === "disconnect" && ready) {
      for (const space of target.spaces) {
        const row = sameProvider(computerAccount?.idpUrl, target.provider) ? computerAccount?.spaces.find(item => item.space === space) : undefined;
        try {
          const service = await request({ op: "service-status", space });
          if (service.state !== "disconnected" || launchReady(service.manager) || observedReadySpaces.includes(space) || row?.desired || (row && row.observed !== "removed on this computer" && row.observed !== "disconnected")) {
            outcomes.push(`${space}: refreshed status does not confirm removal. Disconnect is incomplete.`);
          } else {
            connections.delete(space); instances.delete(space); applicationRefusals.delete(space);
            if (selectedSpace() === space) connection = { space, state: "disconnected" };
            if (acknowledged.has(space) && catalogRefreshed) outcomes.push(`${space}: disconnected, confirmed by refresh.`);
            else if (!catalogRefreshed) outcomes.push(`${space}: service is disconnected, but account refresh failed. Full removal is not confirmed.`);
            else outcomes.push(`${space}: currently disconnected, but the requested operation was not confirmed.`);
          }
        } catch (error) { outcomes.push(`${space}: refresh could not confirm removal. ${error instanceof Error ? error.message : String(error)}`); }
      }
    }
    if (!ready) {
      for (const space of acknowledged) outcomes.push(`${space}: service reported disconnected, but current removal status is unverified.`);
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
let busy = false;
let loginActive = false;
let setupActive = false;
let approval: string | undefined;
let requestedSpace: string | undefined;
let linked = false;
let customHost = false;
let editing = false;
let completedSetup = false;
let observedReadySpaces: string[] = [];
let poll: ReturnType<typeof setTimeout> | undefined;
let connection: { space: string; state: string } | undefined;
let refreshGeneration = 0;
const accountSpaces = new Map<string, AccountSpace>();
let signedInProvider: string | undefined;
let computerAccount: ComputerAccount | undefined;
const computerRows = new Map<string, ComputerSpace>();
const connections = new Map<string, string>();
let choosingSpace = false;
let addingSpace = false;
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
let progress: ProgressState[] = progressNames.map(() => "waiting");
const progressDetails = ["Starting your background service.", "Checking your sign-in.", "Finding your account’s spaces.", "Checking installed agent applications.", "Verifying your connection."];
let lastView = "";
function announce(message: string): void { text("announcer", message); }

function notice(message: string, error = false): void {
  if (message) text("notice", message);
  el("notice-wrap").classList.toggle("expanded", Boolean(message));
  el("notice").setAttribute("aria-hidden", String(!message));
  if (message || !window.matchMedia || window.matchMedia("(prefers-reduced-motion: reduce)").matches) { el("notice").hidden = !message; if (!message) text("notice", ""); }
  el("notice").classList.toggle("error", error);
  if (message) announce(message);
}
function clearDetails(): void {
  problem = undefined;
  text("refusal-detail", ""); el("setup-lines").replaceChildren(); el("details").hidden = true;
  el<HTMLDetailsElement>("details").open = false;
}
function refusal(error: unknown): void {
  const exact = error instanceof Error ? error.message : String(error);
  text("refusal-detail", exact); el("details").hidden = false;
  problem = error instanceof DaemonRefusal ? error.native ?? error.code : "OPERATION_FAILED";
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
    if (li.dataset.state === progress[index]) return;
    li.dataset.state = progress[index];
    const mark = li.querySelector(".progress-mark")!;
    if (progress[index] === "waiting") { mark.removeAttribute("data-icon"); mark.textContent = String(index + 1); }
    else setIcon(mark, progress[index] === "done" ? "check" : progress[index] === "failed" ? "warning" : "spinner");
    const detail = li.querySelector<HTMLElement>(".progress-detail")!;
    detail.textContent = progressDetails[index]; detail.hidden = progress[index] !== "running";
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
let resizeRule: CSSStyleRule | undefined;
let resizeSheet: CSSStyleSheet | undefined;
let resizeIndex = -1;
function resizeCard(previous: number): void {
  const card = document.querySelector<HTMLElement>(".connection-card")!;
  card.classList.remove("height-changing");
  if (resizeSheet && resizeIndex >= 0) { resizeSheet.deleteRule(resizeIndex); resizeIndex = -1; }
  const target = card.getBoundingClientRect().height;
  if (!initialized || Math.abs(previous - target) < 1 || !document.styleSheets.length || window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) return;
  // Insert into our same-origin stylesheet, never a CSP-blocked style attribute.
  resizeSheet = document.styleSheets[0];
  resizeIndex = resizeSheet.insertRule(`.connection-card.height-changing { height: ${previous}px; }`, resizeSheet.cssRules.length);
  resizeRule = resizeSheet.cssRules[resizeIndex] as CSSStyleRule;
  card.classList.add("height-changing"); void card.offsetHeight;
  resizeRule.style.height = `${target}px`;
}
function showStage(next: Stage, focus = false): void {
  const previousHeight = document.querySelector(".connection-card")!.getBoundingClientRect().height;
  stage = next;
  renderSettings();
  el("edit-computer-name").hidden = nameEditing || !(next === "connect" || next === "finished");
  const finished = next === "finished";
  const anyConnected = [...connections.values()].includes("launch-ready");
  const pending = !anyConnected && [...connections].find(([, value]) => value === "approval-pending");
  const signIn = next === "welcome" || next === "sign-in";
  el("sign-in-panel").hidden = !signIn;
  el("space-panel").hidden = !((next === "connect" || finished && addingSpace) && choosingSpace) || setupActive;
  el("connect-panel").hidden = !(next === "connect" || finished && addingSpace) || setupActive;
  el("connected-panel").hidden = !finished;
  el("preferences").hidden = !settingsOpen;
  el("setup-progress").hidden = (!setupActive && !progress.some(value => value !== "waiting")) || finished && !setupActive;
  document.querySelector(".app")!.classList.toggle("later-open", finished && !completedSetup);
  document.querySelector(".connection-card")!.classList.toggle("has-refusal", el("notice").classList.contains("error"));
  el("link-context").hidden = !linked || next !== "welcome";
  el("refresh").hidden = signIn || busy || finished;
  el("custom-host").hidden = !customHost || loginActive;
  el("login-actions").hidden = loginActive;
  el("service-explanation").hidden = loginActive;
  text("step-caption", finished ? "Ready for your next agent" : `Step ${["welcome", "sign-in", "connect", "finished"].indexOf(next) + 1} of 4`);
  el("step-caption").hidden = finished;
  if (finished) el("details").hidden = true;
  let title: string, description: string;
  if (next === "welcome") { title = "Welcome to Cotal"; description = welcome; }
  else if (next === "sign-in") { title = loginActive ? approval ? "Approve sign-in in your browser" : "Preparing your sign-in" : "Sign in to Cotal"; description = "Approve this computer in your browser. We will continue here automatically."; }
  else if (finished && computerAccount?.mode === "sign-in-required") { title = "Sign in to keep this computer connected"; description = "Approve this computer in your browser to keep managing its spaces."; }
  else if (finished && computerAccount?.hostSupport === "supported") {
    const rows = computerSpaces(computerAccount);
    title = anyConnected ? connectionView("launch-ready").title : rows.some(row => row.observed === "refusal") ? "Connection needs attention" : rows.some(row => row.desired && row.observed !== "removed on this computer") ? "This computer is starting" : rows.length ? "No space is using this computer" : "This computer is connected to your account";
    description = rows.length ? connectionView("launch-ready").description : "Turn on the spaces that can use it in the dashboard.";
  }
  else if (finished && pending) { title = "Waiting for owner approval"; description = `The owner of ${accountSpaces.get(pending[0])?.label ?? pending[0]} needs to approve this computer. It connects by itself once they do.`; }
  else if (finished) { title = anyConnected ? connectionView("launch-ready").title : "Spaces using this computer"; description = connectionView("launch-ready").description; }
  else if (setupActive) { title = "Connecting this computer"; description = "Keep this window open while we check your connection and agent applications."; }
  else if (connection?.space === selectedSpace() && connection.state !== "ready" && connection.state !== "disconnected") { const view = connectionView(connection.state); title = view.title; description = view.description; }
  else { title = "Ready to connect"; description = "You are signed in. Choose Connect when you are ready."; }
  const issue = problem ?? (!setupActive && applicationRefusals.has(selectedSpace()) ? "NO_AVAILABLE_CONNECTOR" : !setupActive && upgradeNeeded && selectedSpace() ? "VERSION_MISMATCH" : undefined);
  const recovery = issue ? refusalView(issue, applications) : undefined;
  if (recovery) { title = recovery.title; description = recovery.description; }
  el("recovery-panel").hidden = !recovery;
  if (recovery) {
    for (const id of ["sign-in-panel", "space-panel", "connect-panel", "setup-progress", "connected-panel", "preferences", "refresh"]) el(id).hidden = true;
    text("recover", recovery.label); el("recover").dataset.action = recovery.action;
    el<HTMLButtonElement>("recover").disabled = busy && issue !== "EXPIRED" || retrySignIn;
    if (retrySignIn) text("recover", "Getting a new code…");
    if (!retrySignIn && ["EXPIRED", "VERSION_MISMATCH"].includes(issue!) && !el("recover").querySelector(".icon-refresh")) el("recover").prepend(icon("refresh"));
    if (issue === "VERSION_MISMATCH") {
      text("refusal-detail", `App version: ${appVersion}. Background service version differs. Update the connection when agent sessions have stopped.`); el("details").hidden = false;
    }
  }
  document.querySelector(".connection-card")!.classList.toggle("has-refusal", Boolean(recovery) && issue !== "APPROVAL_PENDING");
  el("connection-icon").dataset.tone = recovery ? ["EXPIRED", "VERSION_MISMATCH", "NO_AVAILABLE_CONNECTOR", "APPROVAL_PENDING", "SEATS_ACTIVE"].includes(issue!) ? "waiting" : "error" : finished ? "success" : loginActive ? "waiting" : "neutral";
  text("connection-title", title); text("connection-description", description);
  setIcon(el("connection-icon"), recovery ? issue === "APPROVAL_PENDING" ? "clock" : "warning" : finished ? "check" : next === "welcome" ? "computer" : next === "sign-in" ? "browser" : setupActive ? "spinner" : "connect");
  const target = accountSpaces.get(selectedSpace());
  if (next === "connect" && !setupActive && !recovery) description = target ? `Connect this computer to ${target.kind === "personal" ? "your personal space, " : ""}${target.label}. You can add it to other spaces afterwards.` : "Choose which space can use this computer.";
  text("connection-description", description);
  el("selected-space").hidden = !addingSpace;
  text("selected-space", target ? addingSpace ? `People authorized in ${target.label} will be able to launch agent applications on this computer as you.` : `Connect this computer to ${target.kind === "personal" ? "your personal space, " : ""}${target.label}. You can add it to other spaces afterwards.` : "Choose which space can use this computer.");
  el("connected-space").hidden = true;
  const formParent = addingSpace ? el("add-space-panel") : document.querySelector(".connection-card")!;
  if (el("space-panel").parentElement !== formParent) {
    if (addingSpace) formParent.append(el("space-panel"), el("connect-panel"));
    else el("setup-progress").before(el("space-panel"), el("connect-panel"));
  }
  const inventoryVisible = !addingSpace && (anyConnected || el("agent-list").children.length > 0);
  el("running-agents").hidden = !inventoryVisible;
  const summaryVisible = inventoryVisible && el("running-agents").dataset.available === "true";
  el("applications-summary").hidden = !summaryVisible;
  el("applications-label").hidden = summaryVisible || addingSpace || !anyConnected || !el("connected-applications").children.length;
  el("connected-applications").hidden = summaryVisible || addingSpace || !anyConnected;
  el("dashboard").hidden = addingSpace || !(anyConnected || computerAccount?.hostSupport === "supported");
  if (finished && pending) { el("connection-icon").dataset.tone = "waiting"; setIcon(el("connection-icon"), "clock"); }
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
    for (const id of ["retry-login", "sync", "another-space", "dashboard", "preferences"]) el(id).hidden = true;
  }
  if (finished && computerAccount?.hostSupport === "supported") {
    const signInRequired = computerAccount.mode === "sign-in-required";
    el("spaces-heading").hidden = signInRequired || !anyConnected;
    const starting = computerSpaces(computerAccount).some(row => row.desired && row.observed !== "removed on this computer");
    const refused = computerSpaces(computerAccount).some(row => row.observed === "refusal");
    text("tray-label", signInRequired ? "Sign in required" : anyConnected ? "Connected" : refused ? "Needs attention" : starting ? "Starting" : "Ready");
    el("tray-indicator").classList.toggle("connected", anyConnected || !starting && !signInRequired && !refused);
    el("tray-indicator").classList.toggle("error", signInRequired || refused);
    if (!anyConnected) {
      const empty = computerSpaces(computerAccount).length === 0;
      el("connection-icon").dataset.tone = signInRequired || refused ? "error" : starting ? "waiting" : empty ? "success" : "neutral";
      setIcon(el("connection-icon"), signInRequired ? "browser" : refused ? "warning" : starting ? "clock" : empty ? "check" : "computer");
    }
  } else el("spaces-heading").hidden = false;
  el("dashboard-spaces-note").hidden = !finished || addingSpace || computerAccount?.hostSupport !== "supported" || computerAccount.mode === "sign-in-required" || computerSpaces(computerAccount).length === 0;
  el("connection-icon").hidden = addingSpace;
  document.querySelector(".connection-card")!.classList.toggle("adding-space", addingSpace);
  renderConnections();
  text("login", linked || customHost || next === "sign-in" ? "Continue in browser" : "Continue with Cotal Cloud");
  el("other-host").hidden = customHost || linked;
  el("change-space").hidden = !addingSpace;
  text("footer-note", finished ? "Closing this window keeps your connection running." : "You choose when to connect this computer.");
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
    const card = document.querySelector(".connection-card")!;
    card.classList.remove("stage-enter");
    if (changed && initialized) { void (card as HTMLElement).offsetWidth; card.classList.add("stage-enter"); }
    if (focus || changed && initialized) el("connection-title").focus({ preventScroll: true });
    announce(title);
    resizeCard(previousHeight);
  }
  el("tray-indicator").classList.toggle("in-flight", busy);
  buttons();
}
function renderConnections(): void {
  const list = el("connected-spaces");
  list.parentElement!.tabIndex = connections.size >= 4 ? 0 : -1;
  const signature = JSON.stringify([...connections].map(([space, state]) => [space, state, accountSpaces.get(space), computerRows.get(space), busy]));
  if (list.dataset.rows === signature) return;
  list.dataset.rows = signature;
  list.replaceChildren(...[...connections].map(([space, state]) => {
    const row = document.createElement("li"); row.dataset.testid = "connected-space-row"; row.dataset.space = space;
    const copy = document.createElement("span");
    const name = document.createElement("strong"); name.textContent = accountSpaces.get(space)?.label ?? space;
    const kind = document.createElement("small"); kind.className = "application-chip"; kind.textContent = accountSpaces.get(space)?.kind ?? "Space";
    copy.append(name, kind);
    const accountRow = computerRows.get(space);
    if (accountRow) { const detail = document.createElement("small"); detail.textContent = computerSpaceState(accountRow); copy.append(detail); }
    else if (state === "approval-pending") { const waiting = document.createElement("small"); waiting.dataset.testid = "approval-pending"; waiting.textContent = "Waiting for owner approval"; copy.append(waiting); }
    const restore = accountRow?.observed === "removed on this computer";
    const remove = document.createElement("button"); remove.type = "button"; remove.className = "text-button"; remove.textContent = restore ? "Add" : "Remove"; remove.disabled = busy; remove.setAttribute("aria-label", `${restore ? "Add" : "Remove"} ${name.textContent}`);
    remove.addEventListener("click", () => void action(async () => { if (restore) { await request({ op: "space-intent", space, enabled: true }); await refresh(); } else await removeSpace(space); }));
    row.append(copy, remove); return row;
  }));
}
async function removeSpace(space: string): Promise<void> {
  const result = await request({ op: "service-disconnect", space });
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
  el<HTMLButtonElement>("connect").disabled = busy || !ready || !selectedSpace() || connected();
  text("connect", addingSpace ? `Add to ${accountSpaces.get(selectedSpace())?.label ?? "space"}` : applicationRefusals.has(selectedSpace()) || el("notice").classList.contains("error") ? "Check again" : "Connect this computer");
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
  for (const id of ["space", "change-space", "another-space", "sign-in-again", "retry-login", "refresh", "autostart"]) (el(id) as HTMLButtonElement).disabled = busy;
}
function updateCountdown(): void {
  const remaining = Math.max(0, Math.ceil((approvalExpires - Date.now()) / 1000));
  text("approval-expiry", remaining ? `Expires in ${Math.floor(remaining / 60)}:${String(remaining % 60).padStart(2, "0")}` : "This code has expired.");
  el<HTMLButtonElement>("copy-code").disabled = remaining === 0;
  el<HTMLButtonElement>("open-approval").disabled = remaining === 0;
  if (!remaining && problem !== "EXPIRED") {
    problem = "EXPIRED";
    text("refusal-detail", "The approval code expired before sign-in was confirmed."); el("details").hidden = false;
    showStage("sign-in", true);
    if (countdown) clearInterval(countdown);
  }
}
el("copy-code").addEventListener("click", () => {
  void navigator.clipboard.writeText(el("approval-code").textContent ?? "").then(() => { text("copy-code", "Copied"); text("announcer", "Approval code copied."); }).catch(() => notice("The code could not be copied. Select the code and copy it manually.", true));
});
function showApplications(manager: unknown): void {
  const names: Record<string, string> = { claude: "Claude Code", codex: "Codex", hermes: "Hermes", jcode: "Jcode", opencode: "OpenCode", pi: "pi" };
  const connectors = (manager as { connectors?: { agent?: string; state?: string }[] })?.connectors ?? [];
  const available = connectors.filter(c => c.state === "available" && typeof c.agent === "string").map(c => names[c.agent!] ?? c.agent!);
  const container = el("connected-applications");
  const value = available.join("\n");
  text("applications-summary", available.length ? `Applications: ${available.join(", ")}` : "");
  if (container.dataset.applications === value) return;
  container.dataset.applications = value;
  container.replaceChildren(...available.map(name => { const chip = document.createElement("span"); chip.className = "application-chip"; chip.dataset.testid = "application-chip"; chip.textContent = name; return chip; }));
}
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
  text("tray-label", initialized ? verified ? "Connected" : "Not connected" : "Checking connection");
  el("tray-indicator").classList.toggle("connected", verified);
  if (isTauri()) void invoke("set_connection_state", { connected: verified }).catch(() => undefined);
  if (connected() && !editing) { listOpened = true; showStage("finished"); }
  else if ((value === "approval-pending" || listOpened) && !editing) { listOpened = true; showStage("finished"); }
  else if (stage === "finished" && !listOpened) showStage(selectedSpace() ? "connect" : "welcome");
  else showStage(stage);
  if (isTauri()) void refreshPresence(verified).catch(refusal);
}
async function refresh(): Promise<void> {
  const space = selectedSpace();
  const generation = ++refreshGeneration;
  const current = () => generation === refreshGeneration && space === selectedSpace();
  try {
    const status = await request({ op: "status" });
    if (!current()) return;
    ready = status.state === "ready";
    renderAgents(status, el("running-agents"));
    daemonVersion = String(status.version);
    updateStatus = status.update as UpdateStatus | undefined;
    renderSettings();
    if (typeof status.computer === "string") renderComputerName(status.computer);
    observedReadySpaces = Array.isArray(status.managers) ? status.managers.filter(launchReady).map(item => String(item.space)) : [];
      computerAccount = activeComputerAccount(status.account as ComputerAccount & { accounts?: ComputerAccount[] } | undefined, signedInProvider ?? providers.get(space));
      if (computerAccount?.hostSupport === "supported") {
        computerRows.clear(); connections.clear();
        for (const row of computerSpaces(computerAccount)) {
          computerRows.set(row.space, row);
          connections.set(row.space, row.observed === "connected" && observedReadySpaces.includes(row.space) ? "launch-ready" : row.observed);
        }
        const manager = Array.isArray(status.managers) ? status.managers.find(item => item.space === space) : undefined;
        if (launchReady(manager)) { instances.set(space, manager.instanceId); showApplications(manager); }
        else instances.delete(space);
        connection = { space, state: connections.get(space) ?? "ready" };
        upgradeNeeded = appVersion !== undefined && status.version !== appVersion;
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
    upgradeNeeded = appVersion !== undefined && status.version !== appVersion;
    if (upgradeNeeded) {
      state("ready", space);
      showStage(stage);
      buttons(); return;
    }
    if (space) {
      const manager = Array.isArray(status.managers) ? status.managers.find((item) => item.space === space) : undefined;
      if (launchReady(manager)) { instances.set(space, manager.instanceId); showApplications(manager); state("launch-ready", space); buttons(); return; }
      instances.delete(space);
      const service = await request({ op: "service-status", space });
      if (!current()) return;
      state(applicationRefusals.has(space) ? "no-application" : String(service.state) === "connected" ? "ready" : String(service.state), space);
      if (manager?.reason) refusal(new DaemonRefusal("DEPENDENCY_UNAVAILABLE", `${manager.reason}${manager.next ? `\nNext: ${manager.next}` : ""}`));
    } else { state("ready", space); if (stage === "connect") showStage("connect"); }
  } catch (error) {
    if (!current()) return;
    ready = false; state("unavailable");
    if (!(error instanceof DaemonRefusal && error.code === "NOT_RUNNING" && (stage === "welcome" || stage === "sign-in") && !loginActive)) refusal(error);
  }
  buttons();
}
async function spaces(refreshCatalog: boolean): Promise<void> {
  const activeProvider = signedInProvider ?? providers.get(selectedSpace()) ?? computerAccount?.idpUrl;
  const result = await request({ op: "spaces", refresh: refreshCatalog });
  signedInProvidersKnown = Array.isArray(result.signedInProviders);
  signedInProviders = Array.isArray(result.signedInProviders) ? result.signedInProviders.filter((item): item is string => typeof item === "string") : [];
  const select = el<HTMLSelectElement>("space"); const previous = select.value;
  const connectedProviders = [...providers].filter(([space]) => connections.has(space));
  select.replaceChildren(new Option("Choose a space", "")); providers.clear(); catalogIds.clear(); accountSpaces.clear();
  if (!Array.isArray(result.spaces)) throw new Error("The background service returned no space list.");
  for (const item of result.spaces) {
    if (!item || typeof item.space !== "string" || item.mode !== "user") continue;
    accountSpaces.set(item.space, { space: item.space, label: String(item.label ?? item.space), ...(typeof item.catalogId === "string" ? { catalogId: item.catalogId } : {}), ...(typeof item.kind === "string" ? { kind: item.kind } : {}), ...(typeof item.role === "string" ? { role: item.role } : {}) });
    select.add(new Option(String(item.label ?? item.space), item.space));
    if (typeof item.idp === "string") providers.set(item.space, item.idp);
    if (typeof item.catalogId === "string") catalogIds.set(item.space, item.catalogId);
  }
  for (const [space, provider] of connectedProviders) {
    if (!providers.has(space)) providers.set(space, provider);
    if (![...select.options].some(option => option.value === space)) select.add(new Option(space, space));
  }
  const preferred = connections.has(previous) ? previous : initialSpace([...accountSpaces.values()], requestedSpace) ?? (accountSpaces.has(previous) ? previous : undefined) ?? observedReadySpaces.find(space => accountSpaces.has(space));
  if (preferred) select.value = preferred;
  choosingSpace = !preferred;
  const message = catalogRefreshNotice(result, activeProvider ?? providers.get(select.value));
  if (message) notice(message);
  buttons();
}
async function action(fn: () => Promise<void>): Promise<void> {
  if (busy) return; busy = true; refreshGeneration++; buttons();
  try { await fn(); } catch (error) { refusal(error); }
  finally {
    refreshGeneration++; busy = false; showStage(stage);
    if (retrySignIn) { retrySignIn = false; beginSignIn(); el<HTMLFormElement>("login-form").requestSubmit(); }
  }
}
function nextAfterSignIn(): void {
  editing = false;
  connection = undefined;
  if (selectedSpace()) showStage("connect", true);
  else {
    showStage("connect", true);
    if (requestedSpace && !selectedSpace()) notice("The requested space is not available to this account. Ask its owner for access, then refresh spaces.");
    else if (!el<HTMLSelectElement>("space").options[1]) { problem = "NO_SPACES"; showStage("connect", true); }
  }
}
el<HTMLInputElement>("provider").value = COTAL_CLOUD_IDP;
el("other-host").addEventListener("click", () => { customHost = true; el<HTMLInputElement>("provider").value = ""; showStage(stage); el("provider").focus(); });
el("login-form").addEventListener("submit", (event) => {
  event.preventDefault();
  void action(async () => {
    loginActive = true; editing = true; clearDetails(); notice(""); showStage("sign-in", true);
    try {
      const provider = canonicalProvider(el<HTMLInputElement>("provider").value.trim());
      if (!ready) { notice("Preparing the background service…"); await request({ op: "install" }); await refresh(); if (!ready) throw new Error("The background service is not ready."); }
      const result = await request({ op: "login", idp: provider });
      problem = undefined;
      if (result.outcome !== "signed-in") throw new DaemonRefusal(String(result.reason ?? "refused").toUpperCase().replaceAll("-", "_"), String(result.message ?? "Sign-in was not completed."));
      signedInProvider = provider;
      for (const item of signedOutProviders) if (sameProvider(item, provider)) signedOutProviders.delete(item);
      notice(""); await spaces(true); await refresh();
      if (computerAccount?.hostSupport === "supported" && computerAccount.mode === "account") {
        editing = false; completedSetup = true; listOpened = true; showStage("finished");
      } else nextAfterSignIn();
    } finally { loginActive = false; approval = undefined; if (countdown) clearInterval(countdown); el("approval").hidden = true; }
  });
});
el("recover").addEventListener("click", () => {
  if (busy) { if (problem === "EXPIRED" && !retrySignIn) { retrySignIn = true; showStage(stage); } return; }
  const recovery = el("recover").dataset.action;
  problem = undefined; notice("");
  if (recovery === "login") { beginSignIn(); el<HTMLFormElement>("login-form").requestSubmit(); }
  else if (recovery === "connect") el<HTMLButtonElement>("connect").click();
  else if (recovery === "spaces") void action(async () => { await spaces(true); nextAfterSignIn(); });
  else void action(async () => { clearDetails(); await refresh(); });
});
el("open-approval").addEventListener("click", () => { if (approval) void invoke("open_browser", { url: approval }).catch(refusal); });
function beginSignIn(): void {
  if (busy) return;
  editing = true;
  const provider = providers.get(selectedSpace());
  if (provider) el<HTMLInputElement>("provider").value = provider;
  customHost = el<HTMLInputElement>("provider").value !== COTAL_CLOUD_IDP;
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
  for (const option of select.options) option.hidden = connections.has(option.value);
  select.value = ""; connection = undefined;
  notice(""); clearDetails(); progress = progressNames.map(() => "waiting"); showStage("finished", true); select.focus();
});
el("retry-login").addEventListener("click", beginSignIn);
el("sign-in-again").addEventListener("click", () => { beginSignIn(); if (computerAccount?.mode === "sign-in-required") el<HTMLFormElement>("login-form").requestSubmit(); });
el("connect").addEventListener("click", () => void action(async () => {
  if (connected() || !ready || !selectedSpace()) return;
  const space = selectedSpace(); const idp = providers.get(space) ?? el<HTMLInputElement>("provider").value.trim();
  setupActive = true; editing = false; applications = []; clearDetails(); notice("");
  progress = ["running", "waiting", "waiting", "waiting", "waiting"]; renderProgress(); showStage("connect", true);
  try {
    const result = await request({ op: "setup", space, idp });
    if (result.launchReady !== true || !launchReady(result.manager)) throw new Error("Setup did not confirm that this computer can launch agent applications.");
    applicationRefusals.delete(space); upgradeNeeded = false;
    instances.set(space, (result.manager as { instanceId: string }).instanceId); showApplications(result.manager);
    progress = progressNames.map(() => "done"); renderProgress();
    completedSetup = true; addingSpace = false; choosingSpace = false; listOpened = true;
    state("launch-ready", space); notice(""); showStage("finished", true);
  } catch (error) {
    const failed = progress.indexOf("failed");
    const active = progress.indexOf("running");
    if (failed < 0) progress[active < 0 ? 4 : active] = "failed"; renderProgress();
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
el("space").addEventListener("change", () => { signedInProvider = undefined; connection = undefined; progress = progressNames.map(() => "waiting"); clearDetails(); notice(""); showStage(stage); void refresh(); });
function openDashboard(): void {
  const space = selectedSpace(); const provider = providers.get(space) ?? el<HTMLInputElement>("provider").value.trim();
  const spaceId = catalogIds.get(space), instanceId = instances.get(space);
  if (computerAccount?.hostSupport === "supported" && computerAccount.mode !== "sign-in-required" && provider) void invoke("open_browser", { url: new URL("/machines", approvalUrl(provider)).href }).catch(refusal);
  else if (connected() && spaceId && instanceId && provider) void invoke("open_browser", { url: machinesUrl(provider, spaceId, instanceId) }).catch(refusal);
  else { openSettings(); notice("The dashboard needs a verified connection and the space's saved address. Refresh spaces before trying again."); }
}
el("dashboard").addEventListener("click", openDashboard);
function openSettings(): void {
  if (busy || loginActive) return;
  editing = false; addingSpace = false; choosingSpace = false;
  const select = el<HTMLSelectElement>("space");
  for (const option of select.options) option.hidden = false;
  if (!connections.has(select.value)) select.value = connections.keys().next().value ?? select.value;
  if (connections.size || completedSetup || listOpened || computerAccount?.hostSupport === "supported") {
    listOpened = true; showStage("finished");
    settingsOpen = true; renderSettings(); el("settings-title").focus();
  }
  void refresh();
}
async function settingsAction(body: Request): Promise<void> {
  if (busy) return;
  busy = true; refreshGeneration++;
  installerMessage = undefined;
  el<HTMLButtonElement>("check-updates").disabled = true;
  el<HTMLInputElement>("update-preference").disabled = true;
  try {
    const result = await request(body);
    updateStatus = result.update as UpdateStatus | undefined;
    announce(body.op === "update-check" ? "Update check complete. The background service uses its registry cache." : "Update preference saved.");
    text("settings-message", "");
  } catch (error) { text("settings-message", error instanceof Error ? error.message : String(error)); }
  finally { busy = false; refreshGeneration++; renderSettings(); el<HTMLButtonElement>("check-updates").disabled = false; el<HTMLInputElement>("update-preference").disabled = false; }
}
el("check-updates").addEventListener("click", () => void settingsAction({ op: "update-check" }));
el("update-preference").addEventListener("change", () => {
  const enabled = el<HTMLInputElement>("update-preference").checked;
  const automatic = updatePolicy(updateStatus?.channel, appPlatform).label === "Install updates automatically";
  void settingsAction({ op: "update-settings", ...(automatic ? { auto: enabled } : { notify: enabled }) });
});
el("update-download").addEventListener("click", () => void openInstaller());
el("settings-download").addEventListener("click", () => void openInstaller());
el("open-settings").addEventListener("click", () => { if (busy) return; if (settingsOpen) { if (nameEditing) closeNameEditor(); pendingAccountAction = undefined; settingsOpen = false; showStage(stage); renderSettings(); } else openSettings(); });
el("settings-back").addEventListener("click", () => { if (busy) return; if (nameEditing) closeNameEditor(); pendingAccountAction = undefined; settingsOpen = false; showStage(stage); renderSettings(); el("open-settings").focus(); });
el("account-outcome-back").addEventListener("click", () => { accountOutcomeOpen = false; renderSettings(); el("settings-title").focus(); });
el("settings-signout").addEventListener("click", () => confirmAccountAction("logout"));
el("settings-disconnect").addEventListener("click", () => confirmAccountAction("disconnect"));
el("account-cancel").addEventListener("click", closeAccountConfirmation);
el("account-confirm").addEventListener("click", () => void runAccountAction());
el("settings-panel").addEventListener("keydown", event => {
  if (event.key === "Escape" && pendingAccountAction) { event.preventDefault(); event.stopPropagation(); closeAccountConfirmation(); }
});
el("settings-name").addEventListener("click", () => el("edit-computer-name").click());
el("update-later").addEventListener("click", () => { dismissedUpdate = updateStatus?.latest; if (dismissedUpdate) localStorage.setItem("dismissed-update", dismissedUpdate); renderSettings(); });
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
  try {
    await startPresence(notice, { settings: openSettings, dashboard: openDashboard });
    await onOpenUrl(receiveLinks); const initialLinks = await getCurrent(); if (initialLinks?.length) receiveLinks(initialLinks);
    const info = await request({ op: "about" }); appVersion = String(info.version);
    appPlatform = String(info.platform); appArch = String(info.arch);
    renderComputerName(String(info.machine)); text("version", `v${String(info.version)}`);
    const os = ({ darwin: "macOS", win32: "Windows", linux: "Linux" } as Record<string, string>)[String(info.platform)] ?? String(info.platform);
    const arch = info.platform === "darwin" && info.arch === "arm64" ? "Apple silicon" : ({ x64: "64-bit Intel / AMD", arm64: "ARM64", ia32: "32-bit Intel" } as Record<string, string>)[String(info.arch)] ?? String(info.arch);
    text("machine-details", `${os} · ${arch} · ${Math.round(Number(info.memoryBytes) / 1024 ** 3)} GB`);
    await refresh();
    if (ready) {
      await spaces(false);
      if (selectedSpace()) { if (!linked) showStage("connect"); await refresh(); }
      else if (!linked && el<HTMLSelectElement>("space").options.length > 1) showStage("connect");
    }
  } catch (error) { refusal(error); }
  initialized = true;
  document.querySelector(".app")!.classList.remove("loading");
  if (computerAccount?.hostSupport !== "supported") text("tray-label", [...connections.values()].includes("launch-ready") ? "Connected" : "Not connected");
  const tick = async () => { if (!busy) await refresh(); poll = setTimeout(() => void tick(), computerAccount?.hostSupport === "supported" ? 1000 : 10_000); };
  poll = setTimeout(() => void tick(), computerAccount?.hostSupport === "supported" ? 1000 : 10_000);
}
document.querySelector(".connection-card")!.addEventListener("transitionend", event => {
  if ((event as TransitionEvent).propertyName !== "height") return;
  document.querySelector(".connection-card")!.classList.remove("height-changing");
  if (resizeSheet && resizeIndex >= 0) { resizeSheet.deleteRule(resizeIndex); resizeIndex = -1; }
});
el("notice-wrap").addEventListener("transitionend", () => { if (!el("notice-wrap").classList.contains("expanded")) el("notice").hidden = true; });
const details = el<HTMLDetailsElement>("details");
let closingDetails = false;
function closeDetails(): void {
  if (!details.open || closingDetails) return;
  if (!window.matchMedia || window.matchMedia("(prefers-reduced-motion: reduce)").matches) { details.open = false; return; }
  closingDetails = true; details.classList.add("closing");
}
details.querySelector("summary")!.addEventListener("click", event => {
  event.preventDefault();
  if (details.open) { closeDetails(); return; }
  details.classList.add("opening"); details.open = true;
  void details.querySelector<HTMLElement>(".details-content")!.offsetHeight;
  details.classList.remove("opening");
});
details.querySelector(".details-content")!.addEventListener("transitionend", () => {
  if (closingDetails) { details.open = false; closingDetails = false; details.classList.remove("closing"); }
});
document.addEventListener("keydown", event => {
  if (event.key === "Escape" && el<HTMLDetailsElement>("details").open) {
    event.preventDefault(); closeDetails();
    el("details").querySelector<HTMLElement>("summary")!.focus();
  }
  if (event.key !== "Enter" || event.defaultPrevented || (event.target as Element).closest("button,input,select,summary")) return;
  const primary = [...document.querySelectorAll<HTMLButtonElement>(".connection-card .primary:not(:disabled):not([hidden])")].find(button => !button.closest("[hidden]"));
  if (primary) { event.preventDefault(); primary.click(); }
});
window.addEventListener("beforeunload", () => { if (poll) clearTimeout(poll); if (countdown) clearInterval(countdown); });
if (isTauri()) {
  void reportFirstPaint(document.querySelector<HTMLImageElement>(".brand-mark")!, document.querySelector<HTMLElement>(".sidebar")!, () => invoke("first_paint"))
    .then(start, error => { notice(String(error), true); return start(); });
} else void start();
