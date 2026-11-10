import { Channel, invoke, isTauri } from "@tauri-apps/api/core";
import { getCurrent, onOpenUrl } from "@tauri-apps/plugin-deep-link";
import { enable, disable, isEnabled } from "@tauri-apps/plugin-autostart";
import { approvalUrl, connectionView, requireResult, onboardingLink, launchReady, machinesUrl, DaemonRefusal, type Frame, type Request } from "./model";
import "./style.css";

const el = <T extends HTMLElement>(id: string): T => {
  const node = document.getElementById(id);
  if (!node) throw new Error(`Missing element ${id}`);
  return node as T;
};
const text = (id: string, value: string) => { el(id).textContent = value; };
let ready = false;
let busy = false;
let loginActive = false;
let approval: string | undefined;
let dashboard: string | undefined;
let requestedSpace: string | undefined;
let poll: ReturnType<typeof setTimeout> | undefined;
let connection: { space: string; state: string } | undefined;
let refreshGeneration = 0;
const providers = new Map<string, string>();
const catalogIds = new Map<string, string>();
const instances = new Map<string, string>();
const applicationRefusals = new Set<string>();
const selectedSpace = () => el<HTMLSelectElement>("space").value;
const connected = () => connection?.space === selectedSpace() && connection?.state === "launch-ready";

function notice(message: string, error = false): void {
  text("notice", message); el("notice").hidden = false; el("notice").classList.toggle("error", error);
}
function buttons(): void {
  el<HTMLButtonElement>("install").disabled = busy;
  el<HTMLButtonElement>("login").disabled = busy || loginActive;
  el<HTMLButtonElement>("connect").disabled = busy || !ready || !selectedSpace() || connected();
  text("connect", applicationRefusals.has(selectedSpace()) ? "Check again" : "Connect this computer");
  el<HTMLButtonElement>("disconnect").disabled = busy || !ready || !selectedSpace();
  el<HTMLButtonElement>("sync").disabled = busy || !ready;
}
async function request(body: Request): Promise<Record<string, unknown>> {
  const events = new Channel<Frame>();
  events.onmessage = (frame) => {
    if (frame.event === "setup-progress" && typeof frame.line === "string") {
      const line = document.createElement("li"); line.textContent = frame.line;
      el("setup-progress").append(line); el("setup-progress").hidden = false;
      return;
    }
    if (frame.event !== "login-prompt" || !frame.prompt) return;
    try {
      approval = approvalUrl(frame.prompt.verificationUriComplete);
      text("approval-code", String(frame.prompt.userCode ?? ""));
      text("approval-expiry", `Expires ${String(frame.prompt.expiresAt ?? "")}`);
      el("approval").hidden = false;
      notice("Approve sign-in in your browser. Do not share the approval link or code.");
      void invoke("open_browser", { url: approval }).catch((error) => notice(String(error), true));
    } catch (error) { notice(String(error), true); }
  };
  return requireResult(await invoke<Frame>("daemon_request", { request: body, onEvent: events }));
}
function state(value: string, space = selectedSpace()): void {
  if (space !== selectedSpace()) return;
  connection = { space, state: value };
  const view = connectionView(value);
  text("connection-title", view.title); text("connection-description", value === "launch-ready" ? `Space ${space}. ${view.description}` : view.description);
  text("tray-label", view.connected ? "Ready to launch" : ready ? "Daemon ready" : "Daemon unavailable");
  el("tray-indicator").classList.toggle("connected", view.connected);
  text("connection-icon", view.connected ? "✓" : "◌");
  if (isTauri()) void invoke("set_connection_state", { connected: view.connected }).catch(() => undefined);
}
async function refresh(): Promise<void> {
  const space = selectedSpace();
  const generation = ++refreshGeneration;
  const current = () => generation === refreshGeneration && space === selectedSpace();
  try {
    const status = await request({ op: "status" });
    if (!current()) return;
    ready = status.state === "ready";
    el("install-panel").hidden = ready;
    if (space) {
      const manager = Array.isArray(status.managers) ? status.managers.find((item) => item.space === space) : undefined;
      if (launchReady(manager)) { instances.set(space, manager.instanceId); state("launch-ready", space); buttons(); return; }
      const connection = await request({ op: "service-status", space });
      if (!current()) return;
      state(applicationRefusals.has(space) ? "no-application" : String(connection.state) === "connected" ? "ready" : String(connection.state), space);
      if (manager?.reason) notice(`${manager.reason}${manager.next ? `\nNext: ${manager.next}` : ""}`, true);
    } else state("ready", space);
  } catch (error) {
    if (!current()) return;
    ready = false; el("install-panel").hidden = false; state("unavailable"); notice(String(error), true);
  }
  buttons();
}
async function spaces(refreshCatalog: boolean): Promise<void> {
  const result = await request({ op: "spaces", refresh: refreshCatalog });
  const select = el<HTMLSelectElement>("space"); const previous = select.value;
  select.replaceChildren(new Option("Choose a space", ""));
  if (!Array.isArray(result.spaces)) throw new Error("The daemon returned no space list.");
  for (const item of result.spaces) {
    if (!item || typeof item.space !== "string" || item.mode !== "user") continue;
    select.add(new Option(String(item.label ?? item.space), item.space));
    if (typeof item.idp === "string") providers.set(item.space, item.idp);
    if (typeof item.catalogId === "string") catalogIds.set(item.space, item.catalogId);
  }
  const preferred = previous || requestedSpace;
  if (preferred && [...select.options].some((option) => option.value === preferred)) select.value = preferred;
  if (result.refresh === "not-signed-in") notice("Sign in to a provider before refreshing space catalogs. No catalog refresh was attempted.", true);
  if (result.refresh === "failed" || result.refresh === "partial") notice("Some space catalogs could not be refreshed. Saved entries may be out of date.", true);
  if (Number(result.collisions) > 0) notice("Some space names conflict with existing registrations. No conflicting registration was replaced.", true);
  if (Number(result.unreadable) > 0) notice("Some local space registrations could not be read. They were not changed.", true);
  buttons();
}
async function action(fn: () => Promise<void>): Promise<void> {
  // Discard reads begun before this action, and selection reads still pending when it finishes.
  if (busy) return; busy = true; refreshGeneration++; buttons();
  try { await fn(); } catch (error) { notice(error instanceof Error ? error.message : String(error), true); }
  finally { refreshGeneration++; busy = false; buttons(); }
}

el("install").addEventListener("click", () => void action(async () => {
  notice("Installing the owned background service…"); await request({ op: "install" }); await refresh();
  notice("The background service is ready. Sign in to connect this machine.");
}));
el("login-form").addEventListener("submit", (event) => {
  event.preventDefault();
  void action(async () => {
    loginActive = true; buttons();
    try {
      const provider = el<HTMLInputElement>("provider").value.trim();
      dashboard = new URL(approvalUrl(provider)).origin;
      if (!ready) { notice("Preparing the background service…"); await request({ op: "install" }); await refresh(); }
      const result = await request({ op: "login", idp: provider });
      if (result.outcome !== "signed-in") throw new Error(String(result.message ?? "Sign-in was not completed."));
      notice("Signed in. Choose a space, then Connect this computer."); await spaces(true);
    } finally { loginActive = false; approval = undefined; el("approval").hidden = true; }
  });
});
el("open-approval").addEventListener("click", () => {
  if (approval) void invoke("open_browser", { url: approval }).catch((error) => notice(String(error), true));
});
el("connect").addEventListener("click", () => void action(async () => {
  if (connected()) return;
  const space = selectedSpace();
  const idp = providers.get(space) ?? el<HTMLInputElement>("provider").value.trim();
  el("setup-progress").replaceChildren();
  notice("Connecting this computer. Setup steps appear below.");
  try {
    const result = await request({ op: "setup", space, idp });
    if (result.launchReady !== true || !launchReady(result.manager)) throw new Error("Setup did not confirm launch-readiness.");
    applicationRefusals.delete(space);
    instances.set(space, (result.manager as { instanceId: string }).instanceId);
    state("launch-ready", space); notice(`Ready to launch in ${space}. Agents can now be launched on this computer from the dashboard.`);
  } catch (error) {
    if (error instanceof DaemonRefusal && error.native === "NO_AVAILABLE_CONNECTOR") {
      applicationRefusals.add(space); state("no-application", space);
    } else state("unavailable", space);
    throw error;
  }
}));
el("disconnect").addEventListener("click", () => void action(async () => {
  const space = selectedSpace();
  const result = await request({ op: "service-disconnect", space });
  applicationRefusals.delete(space);
  state(String(result.state), space); notice(String(result.message ?? "Connection state updated."));
}));
el("sync").addEventListener("click", () => void action(() => spaces(true)));
el("refresh").addEventListener("click", () => void action(refresh));
el("space").addEventListener("change", () => { buttons(); void refresh(); });
el("machine-tab").addEventListener("click", () => window.scrollTo({ top: 0, behavior: "smooth" }));
el("dashboard").addEventListener("click", () => {
  const provider = providers.get(selectedSpace()) ?? el<HTMLInputElement>("provider").value.trim();
  const spaceId = catalogIds.get(selectedSpace()), instanceId = instances.get(selectedSpace());
  if (spaceId && instanceId && provider) dashboard = machinesUrl(provider, spaceId, instanceId);
  if (dashboard) void invoke("open_browser", { url: dashboard }).catch((error) => notice(String(error), true));
  else notice("Sign in to your provider first to choose the dashboard origin.");
});
el("autostart").addEventListener("change", () => void action(async () => {
  const checkbox = el<HTMLInputElement>("autostart");
  try { if (checkbox.checked) await enable(); else await disable(); }
  finally { checkbox.checked = await isEnabled(); }
}));

function receiveLinks(urls: string[]): void {
  if (busy || loginActive) { notice("Finish the current operation before opening another onboarding link.", true); return; }
  if (urls.length !== 1) { notice("Open one machine-connection link at a time.", true); return; }
  try {
    const link = onboardingLink(urls[0]);
    el<HTMLInputElement>("provider").value = link.idp;
    requestedSpace = link.space;
    dashboard = new URL(link.idp).origin;
    notice("Connection details received. Check the provider, then choose Continue in browser. No sign-in or connection has started.");
  } catch (error) { notice(String(error), true); }
}

async function start(): Promise<void> {
  if (!isTauri()) {
    ready = false; state("unavailable"); buttons(); el("install-panel").hidden = true;
    text("machine-details", "Native machine information is unavailable in browser preview."); text("version", "Preview");
    notice("Browser preview only. Native daemon controls are unavailable here; no connection is simulated.");
    el<HTMLInputElement>("autostart").disabled = true; el<HTMLButtonElement>("refresh").disabled = true;
    return;
  }
  try {
    await onOpenUrl(receiveLinks);
    const initialLinks = await getCurrent();
    if (initialLinks?.length) receiveLinks(initialLinks);
    const info = await request({ op: "about" });
    text("machine-name", String(info.machine)); text("version", `v${String(info.version)}`);
    text("machine-details", `${String(info.platform)} · ${String(info.arch)} · ${(Number(info.memoryBytes) / 1024 ** 3).toFixed(1)} GB memory`);
    el<HTMLInputElement>("autostart").checked = await isEnabled();
    await refresh(); if (ready) await spaces(false);
  } catch (error) { notice(String(error), true); }
  const tick = async () => { if (!busy && !document.hidden) await refresh(); poll = setTimeout(() => void tick(), 10_000); };
  poll = setTimeout(() => void tick(), 10_000);
}
window.addEventListener("beforeunload", () => { if (poll) clearTimeout(poll); });
void start();
