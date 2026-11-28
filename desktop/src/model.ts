export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
export type Request = { op: string; candidate?: string; holder?: string; space?: string; idp?: string; refresh?: boolean; enabled?: boolean; name?: string; auto?: boolean; notify?: boolean; version?: string; lifecycleUid?: string; digest?: string; consent?: string[] };
export const COTAL_CLOUD_IDP = "https://cotal.cloud/api/auth";
export function isCotalCloudIdp(provider: string | undefined): boolean {
  return provider === COTAL_CLOUD_IDP || provider === "https://cloud.cotal.ai/api/auth";
}
export interface SetupProgress { step: "install" | "sign-in" | "discover" | "manager" | "applications" | "register" | "connect"; outcome: string; detail: string; applications?: readonly string[] }
export interface Frame { v: 1; event: "result" | "login-prompt" | "setup-progress" | "repair-progress" | "status"; watchMode?: string; progress?: SetupProgress; line?: string; ok?: boolean; result?: Record<string, unknown>; prompt?: Record<string, unknown>; error?: { code: string; message: string; remedy?: string; native?: { code: string; detail?: Record<string, unknown> }; detail?: Record<string, unknown> }; code?: string; message?: string }

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
export interface SpaceRowRefusal { text: string; action: "recover" | "sign-in" | "apps" | "check" | "remove"; label: string }
const KEEPS_TRYING = "Cotal keeps trying by itself.";
/** What a space row says about the refusal the background service saved, and the one action for it.
 *  The service's own sentence is never shown: it can name a sign-in address or a command. */
export function spaceRowRefusal(row: ComputerSpace): SpaceRowRefusal {
  const saved = row.lastRefusal ?? "";
  const check = (text: string): SpaceRowRefusal => ({ text, action: "check", label: "Check again" });
  if (row.custodyRecovery) return { text: "This space is set up under another sign-in on this computer.", action: "recover", label: "Move to this account" };
  if (saved.startsWith("The local space connection is held by ")) return { text: "This space is set up under another sign-in on this computer.", action: "remove", label: "Remove" };
  if (saved === "no available application") return { text: "No agent app is installed.", action: "apps", label: "Set up agent apps" };
  if (["not-signed-in", "credential-expired", "not-user-auth"].includes(saved)) return { text: "Sign in again to use this space.", action: "sign-in", label: "Sign in" };
  if (saved === "Manager is not answering") return check(`Starting this space. ${KEEPS_TRYING}`);
  if (["unreachable", "account space is currently unavailable"].includes(saved)) return check(`Can't reach this space. ${KEEPS_TRYING}`);
  if (saved.startsWith("disconnect refused")) return check(`Couldn't remove this space from this computer. ${KEEPS_TRYING}`);
  if (saved.startsWith("local removal could not stop")) return check("Couldn't remove this space from this computer.");
  return check("Can't connect this space.");
}
export function computerSpaceState(row: ComputerSpace, ready = false): string {
  if (row.lastRefusal) return spaceRowRefusal(row).text;
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

export interface RefusalView { title: string; description: string; action: "login" | "connect" | "refresh" | "spaces" | "install" | "repair" | "installer" | "none"; label: string }
/** Rule 0: every screen offers one button that fixes the cause here. A cause no button can fix
 *  directly gets Repair, which checks the background service and fixes what it finds. */
export function refusalView(code: string, applications: readonly string[] = []): RefusalView {
  const repair = (title: string, description: string): RefusalView => ({ title, description, action: "repair", label: "Repair" });
  switch (code) {
    case "NO_AVAILABLE_CONNECTOR": return { title: "No agent app is installed", description: `Install ${applications.length ? new Intl.ListFormat("en", { type: "disjunction" }).format(applications) : "an agent app"} from Agent apps, then check again.`, action: "connect", label: "Check again" };
    case "SEATS_ACTIVE": return { title: "Agent sessions are still running", description: "The connection cannot be updated while agent applications are using it. Stop those sessions, then check again.", action: "connect", label: "Check again" };
    case "DENIED": return { title: "Sign-in was declined", description: "This computer was not approved in your browser. You can try again when you are ready.", action: "login", label: "Try sign-in again" };
    case "EXPIRED": return { title: "Your code has expired", description: "This code can no longer approve your sign-in. Get a new code to continue in your browser.", action: "login", label: "Get a new code" };
    case "CREDENTIAL_EXPIRED": return { title: "Sign in again", description: "Your saved sign-in has expired. Approve this computer in your browser to reconnect.", action: "login", label: "Sign in again" };
    case "AUTH_REQUIRED": case "NOT_SIGNED_IN": return { title: "Sign in to continue", description: "This computer is not signed in. Approve it in your browser to continue.", action: "login", label: "Sign in" };
    case "SETUP_INTERRUPTED": return { title: "Setup was interrupted", description: "This copy of Cotal did not finish installing. Download the installer and run it again.", action: "installer", label: "Download installer" };
    case "NOT_RUNNING": return { title: "The background service is not running", description: "Start it again to continue.", action: "install", label: "Start service" };
    case "DAEMON_LOST": return repair("The background service stopped", "The background service stopped before Cotal could confirm the result. Repair checks what changed and starts the service again if needed.");
    case "NOT_ANSWERING": return repair("The background service has not started", "Cotal asked the background service on this computer to start, and it has not answered. Repair checks why and fixes what it can.");
    case "ANOTHER_INSTALLATION": return repair("Another copy of Cotal runs the background service", "Repair can move it to this app. Your spaces and sign-in stay as they are.");
    // A service started by hand or by a container has no unit Cotal can stop, so no button here can fix it.
    case "RUNNING_WITHOUT_UNIT": return { title: "A background service is already running", description: "Cotal did not set it up, so this app can't use it or stop it. Restarting this computer stops it.", action: "none", label: "" };
    case "MANAGER_UNAVAILABLE": return repair("The agent host for this space stopped", "Repair checks it and starts it again if it can.");
    case "LOCK_HELD": case "PEER_NOT_LOCK_OWNER": return repair("The background service can't be checked", "Another program holds it, so this app cannot confirm it is Cotal's. Repair checks it and tells you what it found.");
    // Repair cannot act on another account's service, so no button that cannot work is offered.
    case "PEER_UID_MISMATCH": return { title: "The background service can't be used", description: "The background service on this computer belongs to another user account, so this app can't use it.", action: "none", label: "" };
    case "OFFLINE": return { title: CONNECTION_COPY.offline.title, description: CONNECTION_COPY.offline.description, action: "refresh", label: "Check again" };
    case "SPACE_UNREACHABLE": return { title: CONNECTION_COPY.unreachable.title, description: `${CONNECTION_COPY.unreachable.description} Details shows the reason.`, action: "refresh", label: "Check again" };
    case "UNREACHABLE": return { title: "We cannot reach your connection", description: `${CONNECTION_COPY.unreachable.description} Details shows the reason.`, action: "refresh", label: "Try again" };
    case "NO_SPACES": return { title: "No spaces in this account", description: "Create a space in your Cotal host’s dashboard, or ask a space owner for access. Then refresh your spaces to continue.", action: "spaces", label: "Refresh spaces" };
    case "APPROVAL_PENDING": return { title: "Waiting for owner approval", description: "The space owner needs to approve this computer. Ask them to review the request, then check its status.", action: "refresh", label: "Check approval" };
    case "VERSION_MISMATCH": return { title: "Cotal was updated", description: "Restart the background service to finish the update. If agents are running, the restart waits until they finish, then happens by itself.", action: "connect", label: "Restart background service" };
    // A failure inside this window, not on the computer: nothing changed, so trying again is the fix.
    case "RETRY": return { title: "That didn't finish", description: "Cotal couldn't confirm the result. Try again. Details shows what the background service said.", action: "refresh", label: "Try again" };
    default: return repair("Something on this computer needs fixing", "Repair checks the background service, your sign-in and your spaces, and fixes what it finds.");
  }
}

export function approvalUrl(value: unknown): string {
  if (typeof value !== "string") throw new Error("No approval URL was provided.");
  const url = new URL(value);
  if (url.username || url.password || (url.protocol !== "https:" && !(url.protocol === "http:" && ["127.0.0.1", "[::1]"].includes(url.hostname)))) throw new Error("The approval page must use HTTPS or a loopback address.");
  return url.href;
}

/** A daemon message or remedy that names a command, a path, a file or a web address is for a terminal, not a window. */
export function forTerminal(text: string): boolean {
  return /`|\bcotal\s|systemctl|loginctl|launchctl|schtasks|https?:\/\/|(?:^|[\s(])(?:\/|~\/|[A-Za-z]:\\)\S/.test(text);
}

export function requireResult(frame: Frame): Record<string, unknown> {
  if (frame.v !== 1 || frame.event !== "result" || frame.ok !== true) {
    const message = frame.error?.message ?? frame.message ?? "The daemon did not confirm this operation.";
    const remedy = frame.error?.remedy && !forTerminal(frame.error.remedy) && !/[`]|\/|\\/.test(frame.error.remedy) ? frame.error.remedy : undefined;
    const shown = forTerminal(message) ? "The background service refused this request. Repair shows what it found." : message;
    throw new DaemonRefusal(frame.error?.code ?? "OPERATION_FAILED", [shown, remedy ? `Next: ${remedy}` : ""].filter(Boolean).join("\n"), frame.error?.native?.code, remedy, frame.error?.native?.detail ?? frame.error?.detail, frame.result);
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
