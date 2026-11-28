/** What the Agent apps screen shows for each application, as plain data. No window or asset needed. */
import { DaemonRefusal } from "./model";

export type AgentAppState = "signed-in" | "installed" | "signed-out" | "missing";
export interface AgentApp {
  name: string; title: string; maker?: string; state: AgentAppState; version?: string;
  missing?: string[]; install?: { source: string; needs?: string[] }; signIn?: true;
  /** Set only for a connector that is not Cotal's own: the npm package that declared the installer. */
  package?: string;
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
  return { tone: "missing", status: `Not installed · ${installsFrom(app)}`, action: { kind: "install", label: "Install" } };
}

/** What the app says once an install finished, and again once the sign-in that follows it finished, so
 *  a background service that has not picked the app up yet is still said, with its reason. */
export const appManagementMessages = {
  "other-copy": "Another copy of Cotal runs the background service on this computer, so this one can show your agent apps but can't change them.",
  "version-conflict": "The app and the background service are different versions.",
  "older-service": "This background service is too old to manage agent apps here.",
  foreground: "Cotal is running without an installed background service. This app can show your agent apps, but it can’t change them.",
  "unrecorded-service": "There's a background service on this computer that this copy of Cotal can't verify. It won't change your agent apps.",
  "no-user-services": "Cotal can't reach this Linux session's user services. Open Cotal from a desktop session, then choose Check again.",
  checking: "Checking the background service…",
} as const;

export type AppManagement = "service" | "local" | keyof typeof appManagementMessages;
export type ServiceOwner = { kind: "app" | "cli" };
export function serviceOwnerOf(value: unknown): ServiceOwner | undefined {
  const kind = (value as Partial<ServiceOwner> | null | undefined)?.kind;
  return kind === "app" || kind === "cli" ? { kind } : undefined;
}

/** Another copy of Cotal runs the service. The one next step is the Fix in Connection button, where
 *  Repair offers to move the service to this app, so this sentence names the copy and no other step. */
export function otherCopyMessage(owner: ServiceOwner, installed?: string): string {
  const where = owner.kind === "app" ? "the Cotal app" : "a command-line install of Cotal";
  const blocked = installed ? `, so ${installed} can't be used yet.` : ". This copy can show your agent apps but can't change them.";
  return `${installed ? `${installed} is installed. ` : ""}Another copy of Cotal runs the background service (${where})${blocked}`;
}

export const unknownAppChange = "Cotal couldn’t confirm whether the app changed. Choose Check again to see its current status.";
export const appManagementRefusals: Partial<Record<string, AppManagement>> = {
  APP_OTHER_COPY: "other-copy", APP_VERSION_CONFLICT: "version-conflict", APP_OLDER_SERVICE: "older-service",
  APP_FOREGROUND: "foreground", APP_UNRECORDED_SERVICE: "unrecorded-service", APP_NO_USER_SERVICES: "no-user-services", APP_OWNER_CHECKING: "checking",
};
export type ServiceRefresh = { state: "refreshed" } | { state: "pending"; reason?: "agents-running" | "unconfirmed" };

export function installedMessage(title: string, result: { serviceRefresh?: ServiceRefresh; pathAdded?: string }, signedIn = false): string {
  const state = signedIn ? "signed in" : "installed";
  if (result.serviceRefresh?.state === "pending") return result.serviceRefresh.reason === "agents-running"
    ? `${title} is ${state}. Your spaces can use it once the running agents finish.`
    : `${title} is ${state}. Cotal couldn't confirm that the background service can use it. Choose Check again.`;
  const done = signedIn ? `${title} is ready.` : `${title} is installed.`;
  return result.pathAdded ? `${done} Cotal added its folder to PATH in ${result.pathAdded}.` : done;
}

/** Where Install downloads from, said before the click: the executables when they are not the app's
 *  own (Hermes installs uv), the installer's host, and the package of a connector that is not Cotal's. */
export function installsFrom(app: AgentApp): string {
  const own = !app.missing?.length || app.missing.every(command => command === app.name);
  const what = own ? "installs" : `installs ${new Intl.ListFormat("en", { type: "conjunction" }).format(app.missing!)}`;
  return `${what} from ${app.install?.source ?? "its maker"}${app.package ? ` · package ${app.package}` : ""}`;
}

/** The first https address a sign-in printed, which the person can open again if the browser did not. */
export function signInUrl(line: string): string | undefined {
  const match = /https:\/\/[^\s"'<>]+/.exec(line);
  return match ? match[0] : undefined;
}

/** The app that the no-app prompt offers to install: Claude Code when it can be installed here. Only
 *  Cotal's own connectors are offered there; any other installs from its row, which names its package. */
export function suggestedApp(apps: readonly AgentApp[]): AgentApp | undefined {
  return orderedApps(apps).find(app => app.state === "missing" && app.install && !app.install.needs?.length && !app.package);
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
