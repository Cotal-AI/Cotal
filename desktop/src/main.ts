import { Channel, invoke, isTauri } from "@tauri-apps/api/core";
import { getCurrent, onOpenUrl } from "@tauri-apps/plugin-deep-link";
import { enable, disable, isEnabled } from "@tauri-apps/plugin-autostart";
import { approvalUrl, connectionView, requireResult, onboardingLink, type Frame, type Request } from "./model";
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
const selectedSpace = () => el<HTMLSelectElement>("space").value;
const connected = () => connection?.space === selectedSpace() && connection?.state === "connected";

function notice(message: string, error = false): void {
  text("notice", message); el("notice").hidden = false; el("notice").classList.toggle("error", error);
}
function buttons(): void {
  el<HTMLButtonElement>("install").disabled = busy;
  el<HTMLButtonElement>("login").disabled = busy || loginActive || !ready;
  el<HTMLButtonElement>("connect").disabled = busy || !ready || !selectedSpace() || connected();
  el<HTMLButtonElement>("disconnect").disabled = busy || !ready || !selectedSpace();
  el<HTMLButtonElement>("sync").disabled = busy || !ready;
}
async function request(body: Request): Promise<Record<string, unknown>> {
  const events = new Channel<Frame>();
  events.onmessage = (frame) => {
    if (frame.event !== "login-prompt" || !frame.prompt) return;
    try {
      approval = approvalUrl(frame.prompt.verificationUriComplete);
      text("approval-code", String(frame.prompt.userCode ?? ""));
      text("approval-expiry", `Expires ${String(frame.prompt.expiresAt ?? "")}`);
      el("approval").hidden = false;
      notice("Approve sign-in in your browser. Do not share the approval link or code.");
    } catch (error) { notice(String(error), true); }
  };
  return requireResult(await invoke<Frame>("daemon_request", { request: body, onEvent: events }));
}
function state(value: string, space = selectedSpace()): void {
  if (space !== selectedSpace()) return;
  connection = { space, state: value };
  const view = connectionView(value);
  text("connection-title", view.title); text("connection-description", view.description);
  text("tray-label", view.connected ? "Connected" : ready ? "Daemon ready" : "Daemon unavailable");
  el("tray-indicator").classList.toggle("connected", view.connected);
  text("connection-icon", view.connected ? "✓" : "◌");
  if (isTauri()) void invoke("set_connection_state", { connected: view.connected }).catch(() => undefined);
}
async function refresh(): Promise<void> {
  const space = selectedSpace();
  try {
    const status = await request({ op: "status" });
    ready = status.state === "ready";
    el("install-panel").hidden = ready;
    if (space) {
      const connection = await request({ op: "service-status", space });
      state(String(connection.state), space);
    } else state("ready", space);
  } catch (error) {
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
  if (busy) return; busy = true; buttons();
  try { await fn(); } catch (error) { notice(error instanceof Error ? error.message : String(error), true); }
  finally { busy = false; buttons(); }
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
      const result = await request({ op: "login", idp: provider });
      if (result.outcome !== "signed-in") throw new Error(String(result.message ?? "Sign-in was not completed."));
      notice("Signed in. Choose a space to request owner approval."); await spaces(true);
    } finally { loginActive = false; approval = undefined; el("approval").hidden = true; }
  });
});
el("open-approval").addEventListener("click", () => {
  if (approval) void invoke("open_browser", { url: approval }).catch((error) => notice(String(error), true));
});
el("connect").addEventListener("click", () => void action(async () => {
  if (connected()) return;
  const space = selectedSpace();
  const registration = await request({ op: "register", space });
  if (registration.outcome !== "registered") {
    const pending = registration.outcome === "approval-required" || registration.outcome === "pending";
    notice(String(registration.message ?? "Registration was not completed.") + (pending ? " After approval, choose Request connection again." : ""), !pending);
    state(pending ? "approval-pending" : "unavailable", space); return;
  }
  const result = await request({ op: "service-connect", space });
  state(String(result.state), space); notice(String(result.message ?? "Connection state updated."), result.state !== "connected");
}));
el("disconnect").addEventListener("click", () => void action(async () => {
  const space = selectedSpace();
  const result = await request({ op: "service-disconnect", space });
  state(String(result.state), space); notice(String(result.message ?? "Connection state updated."));
}));
el("sync").addEventListener("click", () => void action(() => spaces(true)));
el("refresh").addEventListener("click", () => void action(refresh));
el("space").addEventListener("change", () => { buttons(); void refresh(); });
el("machine-tab").addEventListener("click", () => window.scrollTo({ top: 0, behavior: "smooth" }));
el("dashboard").addEventListener("click", () => {
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
