/** Agent apps: the harnesses this computer's connectors run, where each stands, and the buttons that
 *  install one or sign it in. The service names an application; this file only shows it. */
import { Channel, invoke } from "@tauri-apps/api/core";
import { DaemonRefusal, requireResult, type Frame } from "./model";
import { icon } from "./icons";
import { appManagementMessages, appManagementRefusals, installedMessage, orderedApps, otherCopyMessage, parseApps, refusalDetail, refusalMessage, rowView, serviceOwnerOf, signInUrl, unknownAppChange, type Activity, type AgentApp, type AppManagement, type RowView, type ServiceOwner, type ServiceRefresh } from "./agent-apps-model";
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
function logo(name: string): HTMLElement {
  const box = document.createElement("span");
  box.className = "app-logo app-logo-row";
  const known = LOGOS[name];
  if (known) {
    const img = document.createElement("img");
    img.src = known.src; img.alt = ""; img.decoding = "async";
    if (known.fill) img.classList.add("fill");
    box.append(img);
  } else box.textContent = name.slice(0, 1).toUpperCase();
  return box;
}

export interface AppResult { app?: AgentApp; apps?: AgentApp[]; management?: AppManagement; serviceOwner?: ServiceOwner; serviceRefresh?: ServiceRefresh; pathAdded?: string }

/** One bridge request; progress lines arrive through `onLine`. */
export async function appRequest(request: { op: "agent-apps"; refresh?: boolean } | { op: "agent-app-install" | "agent-app-sign-in"; name: string }, onLine?: (line: string) => void): Promise<AppResult> {
  const events = new Channel<Frame & { name?: string }>();
  events.onmessage = frame => { if ((frame.event as string) === "agent-app-progress" && typeof frame.line === "string") onLine?.(frame.line); };
  const result = requireResult(await invoke<Frame>("daemon_request", { request, onEvent: events }));
  if (request.op === "agent-apps" && result.management !== "local" && result.management !== "service" && (typeof result.management !== "string" || !Object.hasOwn(appManagementMessages, result.management))) {
    throw new Error("Cotal could not confirm how this copy can manage agent apps.");
  }
  return { ...result, serviceOwner: serviceOwnerOf(result.serviceOwner), ...(Array.isArray(result.apps) ? { apps: parseApps(result) } : {}), ...(result.app ? { app: parseApps({ apps: [result.app] })[0] } : {}) } as AppResult;
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
  const mark = view.tone === "warn" || view.tone === "failed" ? "warning" : view.tone === "busy" ? "spinner" : undefined;
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
    button.type = "button"; button.className = "button secondary";
    if (view.action.kind === "open-page") button.className = "text-button";
    button.textContent = view.action.label;
    button.setAttribute("aria-label", `${view.action.label}: ${app.title}`);
    const kind = view.action.kind;
    button.addEventListener("click", () => act(kind));
    holder.replaceChildren(button);
  } else if (view.tone === "ready") {
    const ready = document.createElement("span"); ready.className = "app-pill";
    const dot = document.createElement("span"); dot.className = "dot connected"; dot.setAttribute("aria-hidden", "true");
    ready.append(dot, "Ready", icon("chevron"));
    holder.replaceChildren(ready);
  } else holder.replaceChildren();
}

export interface AgentAppsHost {
  platform(): string;
  announce(message: string): void;
  openUrl(url: string): void;
  /** Something the main window shows changed: readiness, a running action or the list. */
  changed(): void;
}

/** State and actions for the Agent apps pane. */
export class AgentApps {
  apps: AgentApp[] | undefined;
  management: AppResult["management"];
  private serviceOwner: ServiceOwner | undefined;
  private installedBeforeOwnerChanged: string | undefined;
  get readOnly(): boolean { return this.unknownChange || !!this.error || this.management !== undefined && this.management !== "local" && this.management !== "service"; }
  get showCheckAgain(): boolean { return this.unknownChange || !!this.error || !this.readOnly || this.management === "no-user-services"; }
  get showFixConnection(): boolean { return this.readOnly && !this.showCheckAgain && this.management !== "checking"; }
  get retryOwnerCheck(): boolean { return !this.unknownChange && !this.error && this.management === "checking"; }
  get ownerMessage(): string {
    const management = this.management;
    if (this.error || this.unknownChange) return "";
    if (management === "other-copy" && this.serviceOwner) return otherCopyMessage(this.serviceOwner, this.installedBeforeOwnerChanged);
    return management && management !== "local" && management !== "service" ? appManagementMessages[management] : "";
  }
  private unknownChange = false;
  private error: string | undefined;
  private loading: Promise<void> | undefined;
  private readonly activity = new Map<string, Activity>();
  private message = "";
  /** An install the service could not pick up while agents ran. Checked again once they stop. */
  private waitingForAgents = false;
  private lastIdlePickup = -Infinity;
  /** The message says the service has not picked an install up; a refresh that succeeds clears it. */
  private servicePending = false;
  constructor(private readonly host: AgentAppsHost) {}

  get busy(): boolean { return [...this.activity.values()].some(item => item.kind === "installing" || item.kind === "signing-in"); }

  observeRunningAgents(count: number | undefined, now = Date.now()): void {
    if (typeof count !== "number") return;
    if (count !== 0) { this.lastIdlePickup = -Infinity; return; }
    if (!this.waitingForAgents || this.readOnly || this.busy || this.loading || now - this.lastIdlePickup < 30_000) return;
    this.lastIdlePickup = now;
    void this.load();
  }

  /** Read the list again. `refresh` also lets the service pick up applications it cannot find yet. */
  load(refresh = false): Promise<void> {
    if (this.loading) return this.loading;
    if (this.busy) return Promise.resolve();
    if (this.unknownChange && !refresh) return Promise.resolve();
    const observeOnly = this.unknownChange;
    this.loading = (async () => {
      try {
        const result = await appRequest({ op: "agent-apps", ...(!observeOnly && (refresh || this.waitingForAgents) ? { refresh: true } : {}) });
        this.apps = orderedApps(result.apps ?? []); this.error = undefined;
        this.management = result.management;
        this.serviceOwner = result.serviceOwner;
        if (this.management !== "other-copy") this.installedBeforeOwnerChanged = undefined;
        if (observeOnly) { this.unknownChange = false; this.message = ""; }
        if (this.readOnly) {
          if (this.servicePending) this.message = "";
          this.servicePending = this.waitingForAgents = false;
        } else if (result.serviceRefresh?.state === "refreshed") {
          if (this.servicePending) this.message = "";
          this.servicePending = this.waitingForAgents = false;
        } else if (result.serviceRefresh?.state === "pending") {
          this.servicePending = true;
          this.waitingForAgents = result.serviceRefresh.reason === "agents-running";
          if (!this.waitingForAgents) this.message = "Cotal couldn't confirm that the background service can use the new apps. Choose Check again.";
          else if (!this.message) this.message = "Your spaces can use the new apps once the running agents finish.";
        }
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

  private recheckAfterRefusal(name: string, error: unknown): boolean {
    if (!(error instanceof DaemonRefusal)) return false;
    const management = error.native ? appManagementRefusals[error.native] : undefined;
    if (error.code === "OPERATION_UNKNOWN") this.unknownChange = true;
    else if (management) {
      this.management = management;
      this.serviceOwner = management === "other-copy" ? serviceOwnerOf(error.detail?.owner) : undefined;
    }
    else return false;
    this.activity.delete(name);
    this.message = this.unknownChange ? unknownAppChange : "";
    if (this.unknownChange) this.host.announce(this.message);
    return true;
  }

  async install(name: string): Promise<void> {
    if (this.busy || this.readOnly) return;
    const title = this.apps?.find(app => app.name === name)?.title ?? name;
    this.activity.set(name, { kind: "installing" }); this.message = ""; this.host.changed();
    this.lastIdlePickup = -Infinity;
    this.host.announce(`Installing ${title}.`);
    try {
      const result = await appRequest({ op: "agent-app-install", name }, this.progress(name, "installing"));
      this.activity.delete(name);
      if (result.app) this.replace(result.app);
      if (result.serviceOwner) {
        this.management = "other-copy";
        this.serviceOwner = result.serviceOwner;
        this.installedBeforeOwnerChanged = title;
        this.servicePending = this.waitingForAgents = false;
        this.host.announce(this.ownerMessage);
        return;
      }
      this.servicePending = result.serviceRefresh?.state === "pending";
      this.waitingForAgents = result.serviceRefresh?.state === "pending" && result.serviceRefresh.reason === "agents-running";
      this.message = installedMessage(title, result);
      this.host.announce(this.message);
      if (result.app?.state === "signed-out") await this.signIn(name, result);
    } catch (error) {
      if (this.recheckAfterRefusal(name, error)) return;
      this.activity.set(name, { kind: "failed", action: "install", message: refusalMessage(error), ...(refusalDetail(error) ? { detail: refusalDetail(error)! } : {}) });
      this.host.announce(`${title} could not be installed.`);
    } finally { this.host.changed(); }
  }

  /** `installed` is the install this sign-in follows, whose service state the message keeps. */
  async signIn(name: string, installed: AppResult = {}): Promise<void> {
    if (this.busy || this.readOnly) return;
    const title = this.apps?.find(app => app.name === name)?.title ?? name;
    this.activity.set(name, { kind: "signing-in" }); this.host.changed();
    this.host.announce(`Sign in to ${title} in your browser.`);
    try {
      const result = await appRequest({ op: "agent-app-sign-in", name }, this.progress(name, "signing-in"));
      this.activity.delete(name);
      if (result.app) this.replace(result.app);
      if (result.app?.state === "signed-out") this.activity.set(name, { kind: "failed", action: "sign-in", message: "the sign-in finished, but the app still reports it is signed out" });
      else { this.message = installedMessage(title, installed, true); this.host.announce(this.message); }
    } catch (error) {
      if (this.recheckAfterRefusal(name, error)) return;
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
    message.classList.toggle("warning", !this.error && this.servicePending && !this.waitingForAgents && !!text);
    refresh.disabled = this.busy || !!this.loading;
    refresh.hidden = !this.showCheckAgain;
    if (!this.apps) { if (!list.children.length) list.replaceChildren(); return; }
    const keys = new Set(this.apps.map(app => app.name));
    for (const node of Array.from(list.children)) if (!keys.has((node as HTMLElement).dataset.app ?? "")) node.remove();
    this.apps.forEach((app, index) => {
      let row = Array.from(list.children).find(node => (node as HTMLElement).dataset.app === app.name) as HTMLElement | undefined;
      if (!row) { row = document.createElement("li"); row.dataset.app = app.name; }
      if (list.children[index] !== row) list.insertBefore(row, list.children[index] ?? null);
      const view = rowView(app, this.activity.get(app.name), this.host.platform());
      if (this.readOnly && view.action?.kind !== "open-page") delete view.action;
      renderRow(row, app, view, kind => this.act(app, kind));
      row.querySelectorAll<HTMLButtonElement>(".app-action button:not(.text-button)").forEach(button => { button.disabled = this.busy; });
    });
  }

}
