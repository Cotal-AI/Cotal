/** What the Agent apps screen shows for each application, as plain data. No window or asset needed. */
import { DaemonRefusal } from "./model";

export type AgentAppState = "signed-in" | "installed" | "signed-out" | "missing";
export interface AgentApp {
  name: string; title: string; maker?: string; state: AgentAppState; version?: string;
  missing?: string[]; install?: { source: string; needs?: string[] }; signIn?: true;
}
/** What the person started on one row, and how it went. */
export type Activity =
  | { kind: "installing" | "signing-in"; line?: string; url?: string }
  | { kind: "failed"; action: "install" | "sign-in"; message: string; detail?: string };

const ORDER = ["claude", "codex", "opencode", "pi", "jcode", "hermes"];
const SYSTEM_NAMES: Record<string, string> = { win32: "Windows", darwin: "macOS", linux: "Linux" };

/** Claude Code first, then the other official apps, then any other connector by name. */
export function orderedApps(apps: readonly AgentApp[]): AgentApp[] {
  const rank = (name: string) => { const at = ORDER.indexOf(name); return at < 0 ? ORDER.length : at; };
  return [...apps].sort((a, b) => rank(a.name) - rank(b.name) || a.title.localeCompare(b.title));
}

export function parseApps(result: Record<string, unknown>): AgentApp[] {
  if (!Array.isArray(result.apps)) throw new Error("The agent app list is unsupported.");
  return result.apps.map(raw => {
    const app = raw as AgentApp;
    if (!app || typeof app.name !== "string" || typeof app.title !== "string" || !["signed-in", "installed", "signed-out", "missing"].includes(app.state)) throw new Error("The agent app list is unsupported.");
    return app;
  });
}

export const isReady = (app: AgentApp) => app.state === "signed-in" || app.state === "installed";

export interface RowView {
  tone: "ready" | "warn" | "missing" | "busy" | "failed" | "off";
  status: string;
  line?: string;
  action?: { kind: "install" | "sign-in" | "open-page"; label: string; primary?: boolean };
  detail?: string;
}

/** What one row says and offers. Pure, so every state is tested without a window. */
export function rowView(app: AgentApp, activity: Activity | undefined, platform: string): RowView {
  if (activity?.kind === "installing") return { tone: "busy", status: `Installing from ${app.install?.source ?? "its maker"}…`, ...(activity.line ? { line: activity.line } : {}) };
  if (activity?.kind === "signing-in") return { tone: "busy", status: "Finish signing in in your browser", ...(activity.line ? { line: activity.line } : {}), ...(activity.url ? { action: { kind: "open-page", label: "Open sign-in page" } } : {}) };
  const version = app.version ? ` · version ${app.version}` : "";
  if (activity?.kind === "failed") return { tone: "failed", status: `${activity.action === "install" ? "Couldn’t install" : "Couldn’t sign in"}: ${activity.message}`, action: { kind: activity.action, label: "Try again" }, ...(activity.detail ? { detail: activity.detail } : {}) };
  if (app.state === "signed-in") return { tone: "ready", status: `Signed in${version}` };
  if (app.state === "installed") return { tone: "ready", status: `Installed${version}` };
  if (app.state === "signed-out") return { tone: "warn", status: `Installed${version}, not signed in`, action: { kind: "sign-in", label: "Sign in", primary: true } };
  if (!app.install) return { tone: "off", status: SYSTEM_NAMES[platform] && app.maker ? `No installer for ${SYSTEM_NAMES[platform]}` : "Not installed" };
  if (app.install.needs?.length) return { tone: "off", status: `Needs ${new Intl.ListFormat("en", { type: "conjunction" }).format(app.install.needs)} installed first` };
  return { tone: "missing", status: "Not installed", action: { kind: "install", label: "Install" } };
}

/** The first https address a sign-in printed, which the person can open again if the browser did not. */
export function signInUrl(line: string): string | undefined {
  const match = /https:\/\/[^\s"'<>]+/.exec(line);
  return match ? match[0] : undefined;
}

/** The app that the no-app prompt offers to install: Claude Code when it can be installed here. */
export function suggestedApp(apps: readonly AgentApp[]): AgentApp | undefined {
  return orderedApps(apps).find(app => app.state === "missing" && app.install && !app.install.needs?.length);
}

/** The detail a refusal carries for the Details disclosure: the installer's last lines. */
export function refusalDetail(error: unknown): string | undefined {
  if (!(error instanceof DaemonRefusal)) return undefined;
  const detail = error.detail as unknown;
  return typeof detail === "string" && detail.trim() ? detail : undefined;
}

/** The refusal's first line, without the "Next:" line the panel shows apart. */
export function refusalMessage(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  const first = text.split("\n")[0]!.trim();
  return first ? first[0]!.toUpperCase() + first.slice(1) : "The operation could not finish";
}
