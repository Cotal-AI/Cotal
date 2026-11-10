import { Channel, invoke, isTauri } from "@tauri-apps/api/core";
import { getCurrent, onOpenUrl } from "@tauri-apps/plugin-deep-link";
import { enable, disable, isEnabled } from "@tauri-apps/plugin-autostart";
import { approvalUrl, connectionView, refusalView, requireResult, onboardingLink, launchReady, machinesUrl, COTAL_CLOUD_IDP, DaemonRefusal, type Frame, type Request } from "./model";
import { icon, type Icon } from "./icons";
import "./style.css";

const el = <T extends HTMLElement>(id: string): T => {
  const node = document.getElementById(id);
  if (!node) throw new Error(`Missing element ${id}`);
  return node as T;
};
const text = (id: string, value: string) => { if (el(id).textContent !== value) el(id).textContent = value; };
function setIcon(node: Element, name: Icon): void {
  if (node.getAttribute("data-icon") === name) return;
  node.setAttribute("data-icon", name); node.replaceChildren(icon(name));
}
setIcon(el("machine-icon"), "computer");
setIcon(el("loading-icon"), "spinner");
el("dashboard").append(icon("external"));
type Stage = "welcome" | "sign-in" | "space" | "connect" | "finished";
let initialized = false;
let retrySignIn = false;
let approvalExpires = 0;
let countdown: ReturnType<typeof setInterval> | undefined;
let stage: Stage = "welcome";
let ready = false;
let appVersion: string | undefined;
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
const providers = new Map<string, string>();
const catalogIds = new Map<string, string>();
const instances = new Map<string, string>();
const applicationRefusals = new Set<string>();
let applications: readonly string[] = [];
const selectedSpace = () => el<HTMLSelectElement>("space").value;
const spaceLabel = () => el<HTMLSelectElement>("space").selectedOptions[0]?.textContent ?? selectedSpace();
const connected = () => !upgradeNeeded && connection?.space === selectedSpace() && connection?.state === "launch-ready";
const welcome = "Launch agent applications from your space’s dashboard. People authorized in that space can launch them as your operating-system user, with your applications’ sign-in and file permissions.";
const progressNames = ["Background service", "Sign-in", "Space", "Agent applications", "Ready"];
type ProgressState = "waiting" | "running" | "done" | "failed";
let problem: string | undefined;
let progress: ProgressState[] = progressNames.map(() => "waiting");
const progressDetails = ["Starting your background service.", "Checking your sign-in.", "Finding your space.", "Checking installed agent applications.", "Verifying your connection."];
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
  const finished = next === "finished" && connected();
  const signIn = next === "welcome" || next === "sign-in";
  el("sign-in-panel").hidden = !signIn;
  el("space-panel").hidden = next !== "space";
  el("connect-panel").hidden = next !== "connect" || setupActive;
  el("connected-panel").hidden = !finished;
  el("preferences").hidden = !finished;
  el("setup-progress").hidden = (!setupActive && !progress.some(value => value !== "waiting")) || finished;
  document.querySelector(".app")!.classList.toggle("later-open", finished && !completedSetup);
  document.querySelector(".connection-card")!.classList.toggle("has-refusal", el("notice").classList.contains("error"));
  el("link-context").hidden = !linked || next !== "welcome";
  el("refresh").hidden = signIn || busy || finished;
  el("custom-host").hidden = !customHost || loginActive;
  el("login-actions").hidden = loginActive;
  el("service-explanation").hidden = loginActive;
  text("step-caption", finished ? "Ready for your next agent" : `Step ${["welcome", "sign-in", "space", "connect", "finished"].indexOf(next) + 1} of 5`);
  el("step-caption").hidden = finished;
  if (finished) el("details").hidden = true;
  let title: string, description: string;
  if (next === "welcome") { title = "Welcome to Cotal"; description = welcome; }
  else if (next === "sign-in") { title = loginActive ? approval ? "Approve sign-in in your browser" : "Preparing your sign-in" : "Sign in to Cotal"; description = "Approve this computer in your browser. We will continue here automatically."; }
  else if (next === "space") { title = "Choose your space"; description = "A space is where your team and agent applications work together. Choose which one can use this computer."; }
  else if (finished) { title = connectionView("launch-ready").title; description = connectionView("launch-ready").description; }
  else if (setupActive) { title = "Connecting this computer"; description = "Keep this window open while we check your connection and agent applications."; }
  else if (connection?.space === selectedSpace() && connection.state !== "ready") { const view = connectionView(connection.state); title = view.title; description = view.description; }
  else { title = "Ready to connect"; description = "You are signed in. Connect this computer to make it available to your space."; }
  const issue = problem ?? (!setupActive && applicationRefusals.has(selectedSpace()) ? "NO_AVAILABLE_CONNECTOR" : !setupActive && upgradeNeeded && selectedSpace() ? "VERSION_MISMATCH" : !setupActive && connection?.state === "approval-pending" ? "APPROVAL_PENDING" : undefined);
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
  text("connection-title", title); text("connection-description", description);
  setIcon(el("connection-icon"), recovery ? issue === "APPROVAL_PENDING" ? "clock" : "warning" : finished ? "check" : next === "welcome" ? "computer" : next === "sign-in" ? "browser" : next === "space" ? "space" : setupActive ? "spinner" : "connect");
  text("selected-space", `Space: ${spaceLabel()}`); text("connected-space", `Connected to ${spaceLabel()}`);
  el("connected-space").hidden = !finished;
  text("login", linked || customHost || next === "sign-in" ? "Continue in browser" : "Continue with Cotal Cloud");
  el("other-host").hidden = customHost || linked;
  el("change-space").hidden = el<HTMLSelectElement>("space").options.length <= 2;
  text("footer-note", finished ? "Closing this window keeps your connection running." : "You choose when to connect this computer.");
  const stages: Stage[] = ["welcome", "sign-in", "space", "connect", "finished"];
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
function buttons(): void {
  el<HTMLButtonElement>("login").disabled = busy || loginActive || !isTauri();
  el<HTMLButtonElement>("other-host").disabled = busy;
  el<HTMLButtonElement>("connect").disabled = busy || !ready || !selectedSpace() || connected();
  text("connect", applicationRefusals.has(selectedSpace()) || el("notice").classList.contains("error") ? "Check again" : "Connect this computer");
  el<HTMLButtonElement>("disconnect").disabled = busy || !ready || !selectedSpace();
  el<HTMLButtonElement>("dashboard").disabled = busy || !connected();
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
  return requireResult(await invoke<Frame>("daemon_request", { request: body, onEvent: events }));
}
function state(value: string, space = selectedSpace()): void {
  if (space !== selectedSpace()) return;
  connection = { space, state: value };
  const verified = connected();
  if (verified) problem = undefined;
  text("tray-label", initialized ? verified ? "Connected" : "Not connected" : "Checking connection");
  el("tray-indicator").classList.toggle("connected", verified);
  if (isTauri()) void invoke("set_connection_state", { connected: verified }).catch(() => undefined);
  if (verified && !editing) showStage("finished");
  else if (stage === "finished") showStage(selectedSpace() ? "connect" : "welcome");
  else showStage(stage);
}
async function refresh(): Promise<void> {
  const space = selectedSpace();
  const generation = ++refreshGeneration;
  const current = () => generation === refreshGeneration && space === selectedSpace();
  try {
    const status = await request({ op: "status" });
    if (!current()) return;
    ready = status.state === "ready";
    observedReadySpaces = Array.isArray(status.managers) ? status.managers.filter(launchReady).map(item => String(item.space)) : [];
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
    } else { state("ready", space); if (stage === "space") showStage("space"); }
  } catch (error) {
    if (!current()) return;
    ready = false; state("unavailable");
    if (!(error instanceof DaemonRefusal && error.code === "NOT_RUNNING" && (stage === "welcome" || stage === "sign-in") && !loginActive)) refusal(error);
  }
  buttons();
}
async function spaces(refreshCatalog: boolean): Promise<void> {
  const result = await request({ op: "spaces", refresh: refreshCatalog });
  const select = el<HTMLSelectElement>("space"); const previous = select.value;
  select.replaceChildren(new Option("Choose a space", "")); providers.clear(); catalogIds.clear();
  if (!Array.isArray(result.spaces)) throw new Error("The background service returned no space list.");
  for (const item of result.spaces) {
    if (!item || typeof item.space !== "string" || item.mode !== "user") continue;
    select.add(new Option(String(item.label ?? item.space), item.space));
    if (typeof item.idp === "string") providers.set(item.space, item.idp);
    if (typeof item.catalogId === "string") catalogIds.set(item.space, item.catalogId);
  }
  const preferred = requestedSpace || previous || observedReadySpaces.find(space => [...select.options].some(option => option.value === space));
  const option = [...select.options].find(option => option.value && (option.value === preferred || catalogIds.get(option.value) === preferred));
  if (option) select.value = option.value;
  else if (!requestedSpace && select.options.length === 2) select.selectedIndex = 1;
  if (result.refresh === "failed" || result.refresh === "partial") throw new Error("Some space catalogs could not be refreshed. Saved entries may be out of date.");
  if (Number(result.collisions) > 0) throw new Error("Some space names conflict with existing registrations. No conflicting registration was replaced.");
  if (Number(result.unreadable) > 0) throw new Error("Some local space registrations could not be read. They were not changed.");
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
  if (selectedSpace() && (requestedSpace || el<HTMLSelectElement>("space").options.length === 2)) showStage("connect", true);
  else {
    showStage("space", true);
    if (requestedSpace && !selectedSpace()) notice("The requested space is not available to this account. Ask its owner for access, then refresh spaces.");
    else if (!el<HTMLSelectElement>("space").options[1]) { problem = "NO_SPACES"; showStage("space", true); }
  }
}
el<HTMLInputElement>("provider").value = COTAL_CLOUD_IDP;
el("other-host").addEventListener("click", () => { customHost = true; el<HTMLInputElement>("provider").value = ""; showStage(stage); el("provider").focus(); });
el("login-form").addEventListener("submit", (event) => {
  event.preventDefault();
  void action(async () => {
    loginActive = true; editing = true; clearDetails(); notice(""); showStage("sign-in", true);
    try {
      const provider = el<HTMLInputElement>("provider").value.trim(); approvalUrl(provider);
      if (!ready) { notice("Preparing the background service…"); await request({ op: "install" }); await refresh(); if (!ready) throw new Error("The background service is not ready."); }
      const result = await request({ op: "login", idp: provider });
      problem = undefined;
      if (result.outcome !== "signed-in") throw new DaemonRefusal(String(result.reason ?? "refused").toUpperCase().replaceAll("-", "_"), String(result.message ?? "Sign-in was not completed."));
      notice(""); await spaces(true); nextAfterSignIn();
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
  if (!busy && selectedSpace()) { editing = false; notice(""); connection = undefined; showStage("connect", true); void refresh(); }
});
el("change-space").addEventListener("click", () => { if (!busy) { editing = true; showStage("space", true); } });
el("another-space").addEventListener("click", () => { if (!busy) { editing = true; notice(""); clearDetails(); progress = progressNames.map(() => "waiting"); showStage("space", true); } });
el("retry-login").addEventListener("click", beginSignIn);
el("sign-in-again").addEventListener("click", beginSignIn);
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
    completedSetup = true;
    state("launch-ready", space); notice(""); showStage("finished", true);
  } catch (error) {
    const failed = progress.indexOf("failed");
    const active = progress.indexOf("running");
    if (failed < 0) progress[active < 0 ? 4 : active] = "failed"; renderProgress();
    if (error instanceof DaemonRefusal && error.native === "NO_AVAILABLE_CONNECTOR") { applicationRefusals.add(space); state("no-application", space); }
    else state("unavailable", space);
    throw error;
  } finally { setupActive = false; }
}));
el("disconnect").addEventListener("click", () => void action(async () => {
  const space = selectedSpace(); instances.delete(space);
  const result = await request({ op: "service-disconnect", space });
  applicationRefusals.delete(space); progress = progressNames.map(() => "waiting"); clearDetails();
  state(String(result.state), space); notice("");
}));
el("sync").addEventListener("click", () => void action(async () => { notice(""); await spaces(true); }));
el("refresh").addEventListener("click", () => void action(refresh));
el("space").addEventListener("change", () => { instances.clear(); connection = undefined; progress = progressNames.map(() => "waiting"); clearDetails(); notice(""); buttons(); void refresh(); });
el("dashboard").addEventListener("click", () => {
  const space = selectedSpace(); const provider = providers.get(space) ?? el<HTMLInputElement>("provider").value.trim();
  const spaceId = catalogIds.get(space), instanceId = instances.get(space);
  if (connected() && spaceId && instanceId && provider) void invoke("open_browser", { url: machinesUrl(provider, spaceId, instanceId) }).catch(refusal);
  else notice("The dashboard needs a verified connection and the space's saved address. Refresh spaces before trying again.");
});
el("autostart").addEventListener("change", () => void action(async () => {
  const checkbox = el<HTMLInputElement>("autostart");
  try { if (checkbox.checked) await enable(); else await disable(); }
  finally { checkbox.checked = await isEnabled(); }
}));
function receiveLinks(urls: string[]): void {
  if (busy || loginActive) { refusal(new Error("Finish the current operation before opening another connection link.")); return; }
  if (urls.length !== 1) { refusal(new Error("Open one computer-connection link at a time.")); return; }
  try {
    const link = onboardingLink(urls[0]); el<HTMLInputElement>("provider").value = link.idp;
    requestedSpace = link.space; linked = true; editing = true;
    text("link-context", `${link.space ? "Connecting to your space at" : "Connecting with"} ${new URL(link.idp).host}. Sign in below to continue.`); el("link-context").hidden = false;
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
    await onOpenUrl(receiveLinks); const initialLinks = await getCurrent(); if (initialLinks?.length) receiveLinks(initialLinks);
    const info = await request({ op: "about" }); appVersion = String(info.version);
    text("machine-name", String(info.machine)); text("version", `v${String(info.version)}`);
    const os = ({ darwin: "macOS", win32: "Windows", linux: "Linux" } as Record<string, string>)[String(info.platform)] ?? String(info.platform);
    const arch = info.platform === "darwin" && info.arch === "arm64" ? "Apple silicon" : ({ x64: "64-bit Intel / AMD", arm64: "ARM64", ia32: "32-bit Intel" } as Record<string, string>)[String(info.arch)] ?? String(info.arch);
    text("machine-details", `${os} · ${arch} · ${Math.round(Number(info.memoryBytes) / 1024 ** 3)} GB`);
    el<HTMLInputElement>("autostart").checked = await isEnabled();
    await refresh();
    if (ready) {
      await spaces(false);
      if (selectedSpace()) { if (!linked) showStage("connect"); await refresh(); }
      else if (!linked && el<HTMLSelectElement>("space").options.length > 1) showStage("space");
    }
  } catch (error) { refusal(error); }
  initialized = true;
  document.querySelector(".app")!.classList.remove("loading");
  text("tray-label", connected() ? "Connected" : "Not connected");
  const tick = async () => { if (!busy && !document.hidden) await refresh(); poll = setTimeout(() => void tick(), 10_000); };
  poll = setTimeout(() => void tick(), 10_000);
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
void start();
