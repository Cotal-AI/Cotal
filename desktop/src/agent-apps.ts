/** Agent apps: the harnesses this computer's connectors run, where each stands, and the buttons that
 *  install one or sign it in. The service names an application; this file only shows it. */
import { Channel, invoke } from "@tauri-apps/api/core";
import { requireResult, type Frame } from "./model";
import { icon } from "./icons";
import { installedMessage, isReady, orderedApps, parseApps, refusalDetail, refusalMessage, rowView, signInUrl, suggestedApp, type Activity, type AgentApp, type RowView } from "./agent-apps-model";
import claudeLogo from "../../assets/agents/claude-code.svg";
import codexLogo from "../../assets/agents/codex.svg";
import opencodeLogo from "../../assets/agents/opencode.svg";
import piLogo from "../../assets/agents/pi.svg";
import hermesLogo from "../../assets/agents/hermes.png";
import jcodeLogo from "../../assets/agents/jcode.png";

const LOGOS: Record<string, { src: string; fill?: true }> = {
  claude: { src: claudeLogo }, codex: { src: codexLogo }, opencode: { src: opencodeLogo, fill: true },
  pi: { src: piLogo }, hermes: { src: hermesLogo, fill: true }, jcode: { src: jcodeLogo, fill: true },
};
export function logo(name: string, size: "row" | "tile" = "row"): HTMLElement {
  const box = document.createElement("span");
  box.className = `app-logo app-logo-${size}`;
  const known = LOGOS[name];
  if (known) {
    const img = document.createElement("img");
    img.src = known.src; img.alt = ""; img.decoding = "async";
    if (known.fill) img.classList.add("fill");
    box.append(img);
  } else box.textContent = name.slice(0, 1).toUpperCase();
  return box;
}

export interface AppResult { app?: AgentApp; apps?: AgentApp[]; service?: "none" | "unchanged" | "refreshed" | "waiting" | "failed"; serviceError?: string; serviceOwner?: { kind: "app" | "cli"; location?: string }; pathAdded?: string }

/** One bridge request; progress lines arrive through `onLine`. */
export async function appRequest(request: { op: "agent-apps"; refresh?: boolean } | { op: "agent-app-install" | "agent-app-sign-in"; name: string }, onLine?: (line: string) => void): Promise<AppResult> {
  const events = new Channel<Frame & { name?: string }>();
  events.onmessage = frame => { if ((frame.event as string) === "agent-app-progress" && typeof frame.line === "string") onLine?.(frame.line); };
  const result = requireResult(await invoke<Frame>("daemon_request", { request, onEvent: events }));
  return { ...result, ...(Array.isArray(result.apps) ? { apps: parseApps(result) } : {}), ...(result.app ? { app: parseApps({ apps: [result.app] })[0] } : {}) } as AppResult;
}

/** Render one row into `row`, reusing its nodes so a progress line does not rebuild it. */
export function renderRow(row: HTMLElement, app: AgentApp, view: RowView, act: (kind: NonNullable<RowView["action"]>["kind"]) => void): void {
  row.className = "app-row"; row.dataset.state = view.tone; row.dataset.app = app.name;
  if (!row.firstChild) {
    const copy = document.createElement("div"); copy.className = "app-copy";
    const name = document.createElement("div"); name.className = "app-name";
    const status = document.createElement("p"); status.className = "app-status";
    copy.append(name, status);
    const action = document.createElement("div"); action.className = "app-action";
    row.append(logo(app.name), copy, action);
  }
  const copy = row.children[1] as HTMLElement;
  const name = copy.querySelector<HTMLElement>(".app-name")!;
  const nameText = `${app.title}${app.maker ? ` ${app.maker}` : ""}`;
  if (name.dataset.text !== nameText) {
    name.dataset.text = nameText;
    const maker = document.createElement("span"); maker.className = "app-maker"; maker.textContent = app.maker ?? "";
    name.replaceChildren(document.createTextNode(app.title), ...(app.maker ? [document.createTextNode(" "), maker] : []));
  }
  const status = copy.querySelector<HTMLElement>(".app-status")!;
  const mark = view.tone === "ready" ? "check" : view.tone === "warn" || view.tone === "failed" ? "warning" : view.tone === "busy" ? "spinner" : undefined;
  if (status.dataset.text !== `${mark}:${view.status}`) {
    status.dataset.text = `${mark}:${view.status}`;
    status.replaceChildren(...(mark ? [icon(mark)] : []), document.createTextNode(view.status));
  }
  let line = copy.querySelector<HTMLElement>(".app-line");
  if (view.line || view.tone === "busy") {
    if (!line) { line = document.createElement("p"); line.className = "app-line"; copy.append(line); const bar = document.createElement("div"); bar.className = "app-bar"; bar.setAttribute("aria-hidden", "true"); copy.append(bar); }
    line.textContent = view.line ?? ""; line.title = view.line ?? "";
  } else { line?.remove(); copy.querySelector(".app-bar")?.remove(); }
  let details = copy.querySelector<HTMLDetailsElement>("details");
  if (view.detail) {
    if (!details) { details = document.createElement("details"); const summary = document.createElement("summary"); summary.textContent = "Details"; details.append(summary, document.createElement("pre")); copy.append(details); }
    details.querySelector("pre")!.textContent = view.detail;
  } else details?.remove();
  const holder = row.children[2] as HTMLElement;
  const key = view.action ? `${view.action.kind}:${view.action.label}` : view.tone === "ready" ? "ready" : "";
  if (holder.dataset.key === key) return;
  holder.dataset.key = key;
  if (view.action) {
    const button = document.createElement("button");
    button.type = "button"; button.className = `button ${view.action.primary ? "primary" : "secondary"}`;
    if (view.action.kind === "open-page") button.className = "text-button";
    button.textContent = view.action.label;
    button.setAttribute("aria-label", `${view.action.label}: ${app.title}`);
    const kind = view.action.kind;
    button.addEventListener("click", () => act(kind));
    holder.replaceChildren(button);
  } else if (view.tone === "ready") {
    const pill = document.createElement("span"); pill.className = "app-pill"; pill.textContent = "Ready";
    holder.replaceChildren(pill);
  } else holder.replaceChildren();
}

export interface AgentAppsHost {
  platform(): string;
  announce(message: string): void;
  openUrl(url: string): void;
  /** Show the Agent apps screen. */
  openPanel(): void;
  /** Something the main window shows changed: readiness, a running action or the list. */
  changed(): void;
}

/** The Agent apps state and its two views: the full screen and the Ready screen's section. */
export class AgentApps {
  apps: AgentApp[] | undefined;
  private error: string | undefined;
  private loading: Promise<void> | undefined;
  private readonly activity = new Map<string, Activity>();
  private message = "";
  /** The last install outcome is a warning, not a success: the service has not picked the app up. */
  private messageWarning = false;
  /** An install the service could not pick up while agents ran. Checked again once they stop. */
  waitingForAgents = false;
  /** Another Cotal installation owns the background service, so this copy's own re-check cannot
   *  succeed. The panel hides Check again while this is set, and the periodic re-read with refresh
   *  clears it by itself once the other copy fixes the service. */
  ownerBlocked = false;
  /** The message says the service has not picked an install up; a refresh that succeeds clears it. */
  private servicePending = false;
  constructor(private readonly host: AgentAppsHost) {}

  get busy(): boolean { return [...this.activity.values()].some(item => item.kind === "installing" || item.kind === "signing-in"); }
  get readyCount(): number { return this.apps?.filter(isReady).length ?? 0; }

  /** Read the list again. `refresh` also lets the service pick up applications it cannot find yet. */
  load(refresh = false): Promise<void> {
    if (this.loading) return this.loading;
    this.loading = (async () => {
      try {
        // Another installation owning the service is not something time fixes, but the person can fix
        // the other copy; while that is pending, a periodic re-read with refresh clears this box by
        // itself once the service really is refreshed, with no button this copy could press.
        const result = await appRequest({ op: "agent-apps", ...(refresh || this.waitingForAgents || this.ownerBlocked ? { refresh: true } : {}) });
        this.apps = orderedApps(result.apps ?? []); this.error = undefined;
        // Only a refresh that ran clears the warning: "unchanged" also comes back when the service does not answer.
        if (result.service === "refreshed" && this.servicePending) { this.message = ""; this.messageWarning = false; this.ownerBlocked = false; this.servicePending = false; }
        if (result.service === "failed" && !this.servicePending) { this.message = ""; this.messageWarning = false; this.ownerBlocked = false; }
        if (result.service === "refreshed" || result.service === "unchanged") this.waitingForAgents = false;
      } catch (error) { this.error = refusalMessage(error); }
      finally { this.loading = undefined; this.host.changed(); }
    })();
    return this.loading;
  }

  private replace(app: AgentApp): void {
    this.apps = orderedApps([...(this.apps ?? []).filter(item => item.name !== app.name), app]);
  }

  private progress(name: string, kind: "installing" | "signing-in"): (line: string) => void {
    return line => {
      const current = this.activity.get(name);
      const url = kind === "signing-in" ? signInUrl(line) : undefined;
      this.activity.set(name, { kind, line, ...(current && "url" in current && current.url ? { url: current.url } : {}), ...(url ? { url } : {}) });
      this.host.changed();
    };
  }

  async install(name: string): Promise<void> {
    if (this.busy) return;
    const title = this.apps?.find(app => app.name === name)?.title ?? name;
    this.activity.set(name, { kind: "installing" }); this.message = ""; this.messageWarning = false; this.ownerBlocked = false; this.host.changed();
    this.host.announce(`Installing ${title}.`);
    try {
      const result = await appRequest({ op: "agent-app-install", name }, this.progress(name, "installing"));
      this.activity.delete(name);
      if (result.app) this.replace(result.app);
      this.waitingForAgents = result.service === "waiting";
      this.servicePending = result.service === "waiting" || result.service === "failed";
      const outcome = installedMessage(title, result);
      this.message = outcome.text; this.messageWarning = outcome.warning;
      this.ownerBlocked = result.service === "failed" && result.serviceOwner !== undefined;
      this.host.announce(this.message);
      if (result.app?.state === "signed-out") await this.signIn(name, result);
    } catch (error) {
      this.activity.set(name, { kind: "failed", action: "install", message: refusalMessage(error), ...(refusalDetail(error) ? { detail: refusalDetail(error)! } : {}) });
      this.host.announce(`${title} could not be installed.`);
    } finally { this.host.changed(); }
  }

  /** `installed` is the install this sign-in follows, whose service state the message keeps. */
  async signIn(name: string, installed: AppResult = {}): Promise<void> {
    if (this.busy) return;
    const title = this.apps?.find(app => app.name === name)?.title ?? name;
    this.activity.set(name, { kind: "signing-in" }); this.host.changed();
    this.host.announce(`Sign in to ${title} in your browser.`);
    try {
      const result = await appRequest({ op: "agent-app-sign-in", name }, this.progress(name, "signing-in"));
      this.activity.delete(name);
      if (result.app) this.replace(result.app);
      if (result.app?.state === "signed-out") this.activity.set(name, { kind: "failed", action: "sign-in", message: "the sign-in finished, but the app still reports it is signed out" });
      else { const outcome = installedMessage(title, installed, true); this.message = outcome.text; this.messageWarning = outcome.warning; this.ownerBlocked = installed.service === "failed" && installed.serviceOwner !== undefined; this.host.announce(this.message); }
    } catch (error) {
      this.activity.set(name, { kind: "failed", action: "sign-in", message: refusalMessage(error), ...(refusalDetail(error) ? { detail: refusalDetail(error)! } : {}) });
      this.host.announce(`${title} sign-in did not finish.`);
    } finally { this.host.changed(); }
  }

  private act(app: AgentApp, kind: NonNullable<RowView["action"]>["kind"]): void {
    if (kind === "open-page") { const activity = this.activity.get(app.name); if (activity && "url" in activity && activity.url) this.host.openUrl(activity.url); return; }
    void (kind === "install" ? this.install(app.name) : this.signIn(app.name));
  }

  renderPanel(list: HTMLElement, message: HTMLElement, refresh: HTMLButtonElement): void {
    const text = this.error ?? this.message;
    if (message.textContent !== text) message.textContent = text;
    message.classList.toggle("error", !!this.error);
    // An install the service has not picked up is a warning, never a success, and when another
    // Cotal copy owns the service this copy's own re-check cannot succeed, so it is not offered.
    message.classList.toggle("warning", !this.error && this.messageWarning);
    refresh.hidden = this.ownerBlocked;
    refresh.disabled = this.busy || !!this.loading;
    if (!this.apps) { if (!list.children.length) list.replaceChildren(); return; }
    const keys = new Set(this.apps.map(app => app.name));
    for (const node of Array.from(list.children)) if (!keys.has((node as HTMLElement).dataset.app ?? "")) node.remove();
    this.apps.forEach((app, index) => {
      let row = Array.from(list.children).find(node => (node as HTMLElement).dataset.app === app.name) as HTMLElement | undefined;
      if (!row) { row = document.createElement("li"); row.dataset.app = app.name; }
      if (list.children[index] !== row) list.insertBefore(row, list.children[index] ?? null);
      renderRow(row, app, rowView(app, this.activity.get(app.name), this.host.platform()), kind => this.act(app, kind));
      row.querySelectorAll<HTMLButtonElement>(".app-action button:not(.text-button)").forEach(button => { button.disabled = this.busy; });
    });
  }

  /** The Ready screen's section: the apps that are installed, or a prompt to install one. */
  /** With an app ready, a compact button beside Open dashboard, so the spaces list keeps its room. With
   *  none ready, a callout above it with the one step that matters. */
  renderStrip(root: HTMLElement, chip: HTMLButtonElement): void {
    const apps = this.apps ?? [];
    renderChip(chip, apps.filter(app => app.state !== "missing"));
    if (!apps.length || apps.some(isReady)) { root.hidden = true; delete root.dataset.key; return; }
    root.hidden = false;
    const signedOut = apps.find(app => app.state === "signed-out");
    const suggested = signedOut ?? suggestedApp(apps);
    const key = JSON.stringify([apps.map(app => [app.name, app.state]), suggested?.name, this.busy]);
    if (root.dataset.key === key) return;
    root.dataset.key = key;
    const open = document.createElement("button");
    open.type = "button"; open.className = "text-button"; open.textContent = "See all apps";
    open.addEventListener("click", () => this.host.openPanel());
    const logos = document.createElement("div"); logos.className = "apps-logos"; logos.setAttribute("aria-hidden", "true");
    logos.append(...apps.map(app => logo(app.name, "tile")));
    const heading = document.createElement("h2"); heading.textContent = signedOut ? `Sign in to ${signedOut.title}` : "Install an agent app";
    const copy = document.createElement("p");
    copy.textContent = signedOut ? `${signedOut.title} is installed but not signed in, so your spaces can’t start agents in it yet.` : "Agents run in an app on this computer, such as Claude Code or Codex. None is installed yet, so your spaces can’t start agents here.";
    const actions = document.createElement("div"); actions.className = "actions";
    if (suggested) {
      const go = document.createElement("button");
      go.type = "button"; go.className = "button primary"; go.disabled = this.busy;
      go.textContent = signedOut ? `Sign in to ${signedOut.title}` : `Install ${suggested.title} from ${suggested.install!.source}`;
      go.addEventListener("click", () => { this.host.openPanel(); void (signedOut ? this.signIn(signedOut.name) : this.install(suggested.name)); });
      actions.append(go);
    }
    actions.append(open);
    root.replaceChildren(logos, heading, copy, actions);
  }
}

const listed = (items: string[]): string => new Intl.ListFormat("en", { type: "conjunction" }).format(items);
/** The compact button: the installed apps' logos and "Agent apps", with their states in its name. */
function renderChip(chip: HTMLButtonElement, shown: AgentApp[]): void {
  const key = JSON.stringify(shown.map(app => [app.name, app.state]));
  if (chip.dataset.key === key) return;
  chip.dataset.key = key;
  const signedOut = shown.filter(app => app.state === "signed-out").map(app => app.title);
  const ready = shown.filter(isReady).map(app => app.title);
  const summary = [ready.length ? `${listed(ready)} ready` : "", signedOut.length ? `${listed(signedOut)} not signed in` : ""].filter(Boolean).join("; ");
  chip.setAttribute("aria-label", `Agent apps: ${summary}`);
  chip.title = summary;
  const logos = document.createElement("span"); logos.className = "apps-chip-logos"; logos.setAttribute("aria-hidden", "true");
  logos.append(...shown.slice(0, 4).map(app => logo(app.name, "tile")));
  const label = document.createElement("span"); label.textContent = shown.length > 4 ? `Agent apps +${shown.length - 4}` : "Agent apps";
  const badge = document.createElement("span"); badge.className = "app-badge warn"; badge.setAttribute("aria-hidden", "true"); badge.append(icon("warning"));
  chip.replaceChildren(logos, label, ...(signedOut.length ? [badge] : []));
}
