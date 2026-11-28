export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
export type Request = { op: string; candidate?: string; holder?: string; space?: string; idp?: string; refresh?: boolean; enabled?: boolean; name?: string; auto?: boolean; notify?: boolean; version?: string; lifecycleUid?: string; confirm?: true; agents?: readonly string[] };
export const COTAL_CLOUD_IDP = "https://cotal.cloud/api/auth";
export function isCotalCloudIdp(provider: string | undefined): boolean {
  return provider === COTAL_CLOUD_IDP || provider === "https://cloud.cotal.ai/api/auth";
}
export interface SetupProgress { step: "install" | "sign-in" | "discover" | "manager" | "applications" | "register" | "connect"; outcome: string; detail: string; applications?: readonly string[] }
export interface Frame { v: 1; event: "result" | "login-prompt" | "setup-progress" | "status"; watchMode?: string; progress?: SetupProgress; line?: string; ok?: boolean; result?: Record<string, unknown>; prompt?: Record<string, unknown>; error?: { code: string; message: string; remedy?: string; native?: { code: string; detail?: Record<string, unknown> }; detail?: Record<string, unknown> }; code?: string; message?: string }

export class DaemonRefusal extends Error {
  constructor(readonly code: string, message: string, readonly native?: string, readonly remedy?: string, readonly detail?: Record<string, unknown>, readonly result?: Record<string, unknown>) { super(message); }
}

export function launchReady(manager: unknown): boolean {
  if (!manager || typeof manager !== "object") return false;
  const m = manager as Record<string, unknown>;
  return m.state === "answering" && m.connection === undefined && typeof m.instanceId === "string" && Array.isArray(m.connectors) && m.connectors.some((c) => c?.state === "available");
}

export function machinesUrl(provider: string, spaceId: string, instanceId: string): string {
  const url = new URL("/machines", approvalUrl(provider));
  url.searchParams.set("space", spaceId); url.searchParams.set("machine", instanceId);
  return url.href;
}

export interface ComputerSpace { space: string; desired: boolean; observed: string; lastRefusal?: string; custodyRecovery?: { holder: string; candidate: string } }
/** States a space passes through without anyone acting. A space that was just turned on reports `not-requested` while its Manager boots. */
const PASSING_SPACE_STATE: Record<string, string> = {
  "not-requested": "Starting",
  connecting: "Starting",
  starting: "Starting",
  restarting: "Starting",
  stopping: "Stopping",
};
/** States a space stays in until someone acts. */
const SETTLED_SPACE_STATE: Record<string, string> = {
  refused: "Refused",
  ended: "Ended by the space",
  conflict: "Registration conflict",
  "credential-expired": "Credential expired",
  "credential-not-yet-valid": "Credential not yet valid",
  disconnected: "Disconnected",
  unavailable: "Unreachable",
  "local-state-error": "Local records unusable",
  "account-mismatch": "Account mismatch",
  "not-signed-in": "Not signed in",
  "not-registered": "Not registered on this computer",
  unsupported: "Unsupported by this space",
  stopped: "Stopped",
};
/** A space whose Manager lost its connection. It reconnects by itself, so nobody needs to act. */
const NETWORK_SPACE_STATE: Record<string, string> = {
  offline: "No internet connection",
  unreachable: "Can't reach this space",
};
/** The window title, the header pill and the tray all read these words for one connection state. */
export const CONNECTION_COPY: Record<"offline" | "unreachable", { title: string; description: string; pill: string; icon: "offline" | "warning" }> = {
  offline: { title: "No internet connection", description: "Cotal reconnects by itself when this computer is back online.", pill: "Offline", icon: "offline" },
  unreachable: { title: "Can't reach your space", description: "Cotal reconnects by itself when the space answers again.", pill: "Can't connect", icon: "warning" },
};
export function networkState(observed: string): "offline" | "unreachable" | undefined {
  return observed === "offline" || observed === "unreachable" ? observed : undefined;
}
const OWN_SPACE_STATE = ["connected", "approval-pending", "removed on this computer"];
/** Whether this app has decided what to show for a state the daemon reports. */
export function spaceStateKnown(observed: string): boolean {
  return OWN_SPACE_STATE.includes(observed) || Object.hasOwn(NETWORK_SPACE_STATE, observed) || Object.hasOwn(PASSING_SPACE_STATE, observed) || Object.hasOwn(SETTLED_SPACE_STATE, observed);
}
export function computerSpaceState(row: ComputerSpace, ready = false): string {
  if (row.lastRefusal) return row.lastRefusal;
  if (row.observed === "connected") return ready ? "Connected" : "Starting";
  if (row.observed === "approval-pending") return "Waiting for owner approval";
  if (row.observed === "removed on this computer") return "Removed on this computer";
  return NETWORK_SPACE_STATE[row.observed] ?? SETTLED_SPACE_STATE[row.observed] ?? PASSING_SPACE_STATE[row.observed] ?? "Starting";
}
export type ComputerSummary = "connected" | "offline" | "unreachable" | "attention" | "starting" | "idle";
/** One answer for the window title and the tray, so the two cannot disagree. A lost connection comes
 *  before other problems, because it can cause them. */
export function computerSummary(rows: readonly ComputerSpace[], anyConnected: boolean): ComputerSummary {
  if (anyConnected) return "connected";
  if (rows.some(row => networkState(row.observed) === "offline")) return "offline";
  if (rows.some(row => networkState(row.observed) === "unreachable")) return "unreachable";
  if (rows.some(row => Boolean(row.lastRefusal) || Object.hasOwn(SETTLED_SPACE_STATE, row.observed))) return "attention";
  if (rows.some(row => row.desired && row.observed !== "removed on this computer")) return "starting";
  return "idle";
}

/** The ten words the window, pill, dot, tray menu and tooltip share. A problem names itself; there is no
 *  generic "needs attention". The dot follows the word, so the two cannot disagree. */
export type SurfaceWord = "Connected" | "Starting" | "Offline" | "Can't connect" | "Sign in required" | "Service stopped" | "Updating" | "Not set up" | "Disk full" | "Repair needed";
/** The one Start the stopped card and the tray send. It asks the service to start; it does not install it. */
export const SERVICE_START: { op: "start" } = { op: "start" };
export interface SurfaceState { word: SurfaceWord; dot: "ok" | "waiting" | "problem"; title: string; description: string }
/** The fields the window reads off one status frame. `diskFull` is the frame's own flag. `generation`
 *  present means an update is in progress. `recovery` is the repair #10913 reports; nothing else is. */
export interface SurfaceFrame { diskFull?: unknown; generation?: unknown; recovery?: unknown; account?: { mode?: unknown; reason?: unknown; spaces?: readonly ComputerSpace[] } }
export function surfaceInputs(frame: SurfaceFrame | undefined, rows: readonly ComputerSpace[], anyConnected: boolean): { rows: ComputerSpace[]; anyConnected: boolean; signInRequired: boolean; computerRemoved: boolean; service?: "stopped" | "not-set-up"; updating: boolean; diskFull: boolean; repairNeeded: boolean } {
  const account = frame?.account;
  return {
    rows: rows.map(row => ({ ...row })),
    // A row that remembers a refusal is not connected, even when its Manager answers.
    anyConnected: anyConnected && rows.some(row => !row.lastRefusal && row.observed === "connected"),
    signInRequired: account?.mode === "sign-in-required",
    computerRemoved: account?.mode === "sign-in-required" && account?.reason === "computer-removed",
    updating: frame?.generation !== undefined && frame?.generation !== null,
    diskFull: frame?.diskFull === true,
    repairNeeded: frame?.recovery !== undefined && frame?.recovery !== null,
  };
}
export function surfaceState(input: { rows: readonly ComputerSpace[]; anyConnected: boolean; signInRequired?: boolean; computerRemoved?: boolean; service?: "stopped" | "not-set-up"; updating?: boolean; diskFull?: boolean; repairNeeded?: boolean }): SurfaceState {
  const lost = networkState(computerSummary(input.rows, input.anyConnected));
  if (lost === "offline") return { word: "Offline", dot: "problem", title: CONNECTION_COPY.offline.title, description: CONNECTION_COPY.offline.description };
  if (lost === "unreachable") return { word: "Can't connect", dot: "problem", title: CONNECTION_COPY.unreachable.title, description: CONNECTION_COPY.unreachable.description };
  if (input.diskFull) return { word: "Disk full", dot: "problem", title: "Your disk is full", description: "Free up space on this computer. Cotal continues by itself once there is room." };
  if (input.signInRequired) return { word: "Sign in required", dot: "problem", title: "Sign in to keep this computer connected", description: input.computerRemoved ? "This computer was removed from your account. Sign in to add it back." : "Approve this computer in your browser to keep managing its spaces." };
  if (input.service === "stopped") return { word: "Service stopped", dot: "problem", title: "The background service is stopped", description: "You stopped the background service. Start it to run agents on this computer again." };
  if (input.service === "not-set-up") return { word: "Not set up", dot: "waiting", title: "This computer is not set up", description: "Set it up to use it from your spaces." };
  if (input.updating) return { word: "Updating", dot: "waiting", title: "Cotal is updating", description: "It finishes by itself. Agents keep running." };
  const desired = input.rows.filter(row => row.desired);
  const refused = (row: ComputerSpace) => Boolean(row.lastRefusal) || Object.hasOwn(SETTLED_SPACE_STATE, row.observed);
  // A refusal is checked before any connection, so one refused row cannot make the computer Connected.
  if (desired.length && desired.every(refused)) return { word: "Can't connect", dot: "problem", title: "Can't connect to your spaces", description: "Cotal reconnects by itself when the space answers again." };
  if (input.repairNeeded) return { word: "Repair needed", dot: "problem", title: "This computer needs a repair", description: "Repair it to use it from your spaces again." };
  if (input.anyConnected) return { word: "Connected", dot: "ok", title: "This computer is connected", description: "Your spaces can use the agent applications on this computer." };
  if (desired.some(row => row.observed !== "removed on this computer")) return { word: "Starting", dot: "waiting", title: "This computer is starting", description: "It connects by itself once the spaces are ready." };
  return { word: "Connected", dot: "ok", title: input.rows.length ? "No space is using this computer" : "This computer is connected to your account", description: "Turn on the spaces that can use it in the dashboard." };
}
export function computerSpaces(account: { spaces: ComputerSpace[] }): ComputerSpace[] {
  return account.spaces.filter(row => row.desired || row.observed === "connected" || row.observed === "removed on this computer");
}

export function canonicalProvider(value: string): string {
  const url = new URL(approvalUrl(value));
  if (url.search || url.hash) throw new Error("The provider URL must not contain a query or fragment.");
  const path = url.pathname.replace(/\/+$/, "");
  return url.origin + (path || "/api/auth");
}

export interface ComputerAccount { idpUrl?: string; sub?: string; label?: string; mode: string; hostSupport: string; spaces: ComputerSpace[] }

/** The name the settings account line shows beside the host. A missing or whitespace-only label is not
 *  one, so the line uses the subject. Both blank leaves the host by itself. */
export function shownAccountLabel(label: string | undefined, sub: string | undefined): string | undefined {
  if (label && label.trim()) return label;
  if (sub && sub.trim()) return sub;
  return undefined;
}
export function activeComputerAccount(account: ComputerAccount & { accounts?: ComputerAccount[] } | undefined, provider?: string): ComputerAccount | undefined {
  if (!account?.accounts) return account;
  if (provider) return account.accounts.find(item => item.idpUrl !== undefined && canonicalProvider(item.idpUrl) === canonicalProvider(provider));
  const supported = account.accounts.filter(item => item.hostSupport === "supported");
  return supported.length === 1 ? supported[0] : undefined;
}

/** Return a non-blocking notice only when the active provider refreshed successfully. */
export function catalogRefreshNotice(result: Record<string, unknown>, provider?: string): string {
  const failed = Array.isArray(result.failedProviders) && result.failedProviders.every(item => typeof item === "string") ? result.failedProviders as string[] : undefined;
  const partial = result.refresh === "failed" || result.refresh === "partial";
  if (partial && !failed) throw new Error("Some space catalogs could not be refreshed. Saved entries may be out of date.");
  if (failed?.length && (!provider || failed.some(item => canonicalProvider(item) === canonicalProvider(provider)))) {
    const host = provider ? new URL(provider).host : failed.map(url => new URL(url).host).join(", ");
    throw new Error(`Spaces from ${host} could not be refreshed. Saved entries from that host may be out of date.`);
  }
  if (Number(result.collisions) > 0) throw new Error("Some space names conflict with existing registrations. No conflicting registration was replaced.");
  if (Number(result.unreadable) > 0) throw new Error("Some local space registrations could not be read. They were not changed.");
  return failed?.length ? `Spaces from ${[...new Set(failed.map(url => new URL(url).host))].join(", ")} could not be refreshed. Saved entries from that host may be out of date.` : "";
}

/** The notice for a sign-in that replaced an account but could not delete some of that account's
 *  discovered-space credential files. The daemon has already switched, so the sign-in stands and the
 *  notice names each kept file, why it stayed, and the cleanup. Empty when every file was deleted. */
export function keptCredentialsNotice(result: Record<string, unknown>): string {
  const kept = (Array.isArray(result.credentialsKept) ? result.credentialsKept : []).filter((item): item is { space: string; path: string; reason: string } =>
    typeof item === "object" && item !== null && typeof item.space === "string" && typeof item.path === "string" && typeof item.reason === "string");
  if (!kept.length) return "";
  const files = kept.map(item => `${item.path} (${item.space}: ${item.reason})`).join(", ");
  return `Signed in, but ${kept.length === 1 ? "a credential file" : `${kept.length} credential files`} of the previous account's spaces could not be deleted: ${files}. Delete each file named. The previous account's spaces are already removed.`;
}

export interface AccountSpace { space: string; label: string; catalogId?: string; kind?: string; role?: string }

/** The name a space row shows. A missing or whitespace-only label is not one, so the row uses the space id. */
export function shownSpaceLabel(label: string | undefined, space: string): string {
  return label && label.trim() ? label : space;
}

/** The kind chip beside a space. A missing or whitespace-only kind is not one, so the chip says Space. */
export function shownSpaceKind(kind: string | undefined): string {
  return kind && kind.trim() ? kind : "Space";
}

/** Discovery selects a target, but never grants consent to connect. */
export function initialSpace(spaces: readonly AccountSpace[], requested?: string): string | undefined {
  const linked = requested && spaces.find(item => item.space === requested || item.catalogId === requested);
  if (linked) return linked.space;
  return spaces.find(item => item.kind === "personal")?.space ?? (spaces.length === 1 ? spaces[0].space : undefined);
}

export function connectionView(state: string): { title: string; description: string; connected: boolean } {
  switch (state) {
    case "launch-ready": return { title: "This computer is connected", description: "Manage the spaces that can launch agent applications on this computer.", connected: true };
    case "no-application": return { title: "No agent app is installed", description: "Install one from Agent apps, then choose Check again.", connected: false };
    case "connected": return { title: "Not connected", description: "The connection is not yet ready to launch agent applications.", connected: false };
    case "approval-pending": return { title: "Waiting for owner approval", description: "The space owner must approve this computer. No connection is claimed yet.", connected: false };
    case "connecting": return { title: "Connecting this computer", description: "Checking that this computer can launch agent applications.", connected: false };
    case "disconnected": return { title: "Computer disconnected", description: "The background service is still running. Disconnecting does not revoke remote permissions.", connected: false };
    case "ready": return { title: "Background service is ready", description: "Connect this computer to your account.", connected: false };
    default: return { title: "Not connected", description: "No verified connection to the selected space is available.", connected: false };
  }
}

export interface RefusalView { title: string; description: string; action: "login" | "connect" | "refresh" | "spaces" | "install" | "none"; label: string }
export function refusalView(code: string, applications: readonly string[] = []): RefusalView {
  switch (code) {
    case "NO_AVAILABLE_CONNECTOR": return { title: "No agent app is installed", description: `Install ${applications.length ? new Intl.ListFormat("en", { type: "disjunction" }).format(applications) : "an agent app"} from Agent apps, then check again.`, action: "connect", label: "Check again" };
    case "SEATS_ACTIVE": return { title: "Agent sessions are still running", description: "The connection cannot be updated while agent applications are using it. Stop those sessions, then check again.", action: "connect", label: "Check again" };
    case "DENIED": return { title: "Sign-in was declined", description: "This computer was not approved in your browser. You can try again when you are ready.", action: "login", label: "Try sign-in again" };
    case "EXPIRED": return { title: "Your code has expired", description: "This code can no longer approve your sign-in. Get a new code to continue in your browser.", action: "login", label: "Get a new code" };
    case "CREDENTIAL_EXPIRED": return { title: "Sign in again", description: "Your saved sign-in has expired. Approve this computer in your browser to reconnect.", action: "login", label: "Sign in again" };
    case "SETUP_INTERRUPTED": return { title: "Setup was interrupted", description: "Run the installer again to finish updating Cotal.", action: "refresh", label: "Check again" };
    case "NOT_RUNNING": return { title: "The background service is not running", description: "Start it again to continue.", action: "install", label: "Start service" };
    case "DAEMON_LOST": return { title: "The background service stopped", description: "It stopped before this could finish, so nothing was completed. This clears when the service is running again.", action: "refresh", label: "Check status" };
    case "NOT_ANSWERING": return { title: "The background service has not started", description: "Cotal asked the background service on this computer to start, and it has not answered. Details shows the reason it gave, if it gave one.", action: "refresh", label: "Check status" };
    case "OFFLINE": return { title: CONNECTION_COPY.offline.title, description: CONNECTION_COPY.offline.description, action: "refresh", label: "Check again" };
    case "SPACE_UNREACHABLE": return { title: CONNECTION_COPY.unreachable.title, description: `${CONNECTION_COPY.unreachable.description} Details shows the reason.`, action: "refresh", label: "Check again" };
    case "UNREACHABLE": return { title: "We cannot reach your connection", description: `${CONNECTION_COPY.unreachable.description} Details shows the reason.`, action: "refresh", label: "Try again" };
    case "NO_SPACES": return { title: "No spaces in this account", description: "Create a space in your Cotal host’s dashboard, or ask a space owner for access. Then refresh your spaces to continue.", action: "spaces", label: "Refresh spaces" };
    case "APPROVAL_PENDING": return { title: "Waiting for owner approval", description: "The space owner needs to approve this computer. Ask them to review the request, then check its status.", action: "refresh", label: "Check approval" };
    case "VERSION_MISMATCH": return { title: "Your connection needs an update", description: "This app and the background service have different versions. Update the connection when no agent sessions are running.", action: "connect", label: "Update connection" };
    case "CONFLICT": return { title: "Another Cotal installation runs the background service", description: "This copy cannot take it over. Nothing was changed.", action: "none", label: "" };
    default: return { title: "This operation could not finish", description: "The connection has not been confirmed. Read the exact reason and next step in Details before trying again.", action: "refresh", label: "Try again" };
  }
}

export function approvalUrl(value: unknown): string {
  if (typeof value !== "string") throw new Error("No approval URL was provided.");
  const url = new URL(value);
  if (url.username || url.password || (url.protocol !== "https:" && !(url.protocol === "http:" && ["127.0.0.1", "[::1]"].includes(url.hostname)))) throw new Error("The approval page must use HTTPS or a loopback address.");
  return url.href;
}

export function requireResult(frame: Frame): Record<string, unknown> {
  if (frame.v !== 1 || frame.event !== "result" || frame.ok !== true) {
    const remedy = frame.error?.remedy && !/[`]|\/|\\/.test(frame.error.remedy) ? frame.error.remedy : undefined;
    throw new DaemonRefusal(frame.error?.code ?? "OPERATION_FAILED", [frame.error?.message ?? frame.message ?? "The daemon did not confirm this operation.", remedy ? `Next: ${remedy}` : ""].filter(Boolean).join("\n"), frame.error?.native?.code, remedy, frame.error?.native?.detail ?? frame.error?.detail, frame.result);
  }
  if (!frame.result || typeof frame.result !== "object" || Array.isArray(frame.result)) throw new Error("The daemon returned an unsupported result.");
  return frame.result;
}

/** A dashboard link can prefill public onboarding coordinates, never authenticate or connect. */
export function onboardingLink(value: string): { idp: string; space?: string } {
  // Validate before a special-scheme parser can normalize authority, ports or paths.
  // Some WebViews treat custom schemes as opaque paths, so never parse cotal: itself.
  const prefix = /^cotal:\/\//i.exec(value);
  const remainder = prefix ? value.slice(prefix[0].length) : "";
  const route = remainder.split(/[?#]/, 1)[0];
  if (!prefix || !["connect", "connect/"].includes(route) || value.includes("#") || /[\u0000-\u0020\u007f]/.test(value)) throw new Error("Unsupported Cotal onboarding link.");
  const u = new URL(`https://${remainder}`);
  const keys = [...u.searchParams.keys()];
  if (keys.some((key) => key !== "idp" && key !== "space") || new Set(keys).size !== keys.length) throw new Error("The onboarding link contains unsupported fields.");
  const idp = approvalUrl(u.searchParams.get("idp"));
  const provider = new URL(idp);
  if (provider.search || provider.hash) throw new Error("A provider cannot contain a query or fragment.");
  const space = u.searchParams.get("space");
  if (space !== null && !/^[A-Za-z0-9_-]{1,64}$/.test(space)) throw new Error("Invalid onboarding space.");
  return { idp, ...(space ? { space } : {}) };
}
