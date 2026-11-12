export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
export type Request = { op: string; space?: string; idp?: string; refresh?: boolean; enabled?: boolean; name?: string; auto?: boolean; notify?: boolean; version?: string };
export const COTAL_CLOUD_IDP = "https://cloud.cotal.ai/api/auth";
export interface SetupProgress { step: "install" | "sign-in" | "discover" | "manager" | "applications" | "register" | "connect"; outcome: string; detail: string; applications?: readonly string[] }
export interface Frame { v: 1; event: "result" | "login-prompt" | "setup-progress"; progress?: SetupProgress; line?: string; ok?: boolean; result?: Record<string, unknown>; prompt?: Record<string, unknown>; error?: { code: string; message: string; remedy?: string; native?: { code: string } }; code?: string; message?: string }

export class DaemonRefusal extends Error {
  constructor(readonly code: string, message: string, readonly native?: string, readonly remedy?: string) { super(message); }
}

export function launchReady(manager: unknown): boolean {
  if (!manager || typeof manager !== "object") return false;
  const m = manager as Record<string, unknown>;
  return m.state === "answering" && typeof m.instanceId === "string" && Array.isArray(m.connectors) && m.connectors.some((c) => c?.state === "available");
}

export function machinesUrl(provider: string, spaceId: string, instanceId: string): string {
  const url = new URL("/machines", approvalUrl(provider));
  url.searchParams.set("space", spaceId); url.searchParams.set("machine", instanceId);
  return url.href;
}

export interface ComputerSpace { space: string; desired: boolean; observed: string; lastRefusal?: string }
export function computerSpaceState(row: ComputerSpace, ready = false): string {
  if (row.lastRefusal) return row.lastRefusal;
  if (row.observed === "connected") return ready ? "Connected" : "Starting";
  if (row.observed === "approval-pending") return "Waiting for owner approval";
  if (row.observed === "removed on this computer") return "Removed on this computer";
  return "Starting";
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

/** Discovery selects a target, but never grants consent to connect. */
export function initialSpace(spaces: readonly AccountSpace[], requested?: string): string | undefined {
  const linked = requested && spaces.find(item => item.space === requested || item.catalogId === requested);
  if (linked) return linked.space;
  return spaces.find(item => item.kind === "personal")?.space ?? (spaces.length === 1 ? spaces[0].space : undefined);
}

export function connectionView(state: string): { title: string; description: string; connected: boolean } {
  switch (state) {
    case "launch-ready": return { title: "This computer is connected", description: "Manage the spaces that can launch agent applications on this computer.", connected: true };
    case "no-application": return { title: "No agent application found", description: "Install a supported application named below, then choose Check again.", connected: false };
    case "connected": return { title: "Not connected", description: "The connection is not yet ready to launch agent applications.", connected: false };
    case "approval-pending": return { title: "Waiting for owner approval", description: "The space owner must approve this computer. No connection is claimed yet.", connected: false };
    case "connecting": return { title: "Connecting this computer", description: "Checking that this computer can launch agent applications.", connected: false };
    case "disconnected": return { title: "Computer disconnected", description: "The background service is still running. Disconnecting does not revoke remote permissions.", connected: false };
    case "ready": return { title: "Background service is ready", description: "Connect this computer to your account.", connected: false };
    default: return { title: "Not connected", description: "No verified connection to the selected space is available.", connected: false };
  }
}

export interface RefusalView { title: string; description: string; action: "login" | "connect" | "refresh" | "spaces"; label: string }
export function refusalView(code: string, applications: readonly string[] = []): RefusalView {
  switch (code) {
    case "NO_AVAILABLE_CONNECTOR": return { title: "No agent application found", description: `Install ${applications.length ? new Intl.ListFormat("en", { type: "disjunction" }).format(applications) : "a supported agent application"}. Make sure it opens in your login terminal, then check again.`, action: "connect", label: "Check again" };
    case "SEATS_ACTIVE": return { title: "Agent sessions are still running", description: "The connection cannot be updated while agent applications are using it. Stop those sessions, then check again.", action: "connect", label: "Check again" };
    case "DENIED": return { title: "Sign-in was declined", description: "This computer was not approved in your browser. You can try again when you are ready.", action: "login", label: "Try sign-in again" };
    case "EXPIRED": return { title: "Your code has expired", description: "This code can no longer approve your sign-in. Get a new code to continue in your browser.", action: "login", label: "Get a new code" };
    case "CREDENTIAL_EXPIRED": return { title: "Sign in again", description: "Your saved sign-in has expired. Approve this computer in your browser to reconnect.", action: "login", label: "Sign in again" };
    case "NOT_ANSWERING": case "UNREACHABLE": return { title: "We cannot reach your connection", description: "The host or background service is not answering. Check your network and the exact next step in Details, then try again.", action: "refresh", label: "Try again" };
    case "NO_SPACES": return { title: "No spaces in this account", description: "Create a space in your Cotal host’s dashboard, or ask a space owner for access. Then refresh your spaces to continue.", action: "spaces", label: "Refresh spaces" };
    case "APPROVAL_PENDING": return { title: "Waiting for owner approval", description: "The space owner needs to approve this computer. Ask them to review the request, then check its status.", action: "refresh", label: "Check approval" };
    case "VERSION_MISMATCH": return { title: "Your connection needs an update", description: "This app and the background service have different versions. Update the connection when no agent sessions are running.", action: "connect", label: "Update connection" };
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
  if (frame.v !== 1 || frame.event !== "result" || frame.ok !== true) throw new DaemonRefusal(frame.error?.code ?? "OPERATION_FAILED", [frame.error?.message ?? frame.message ?? "The daemon did not confirm this operation.", frame.error?.remedy ? `Next: ${frame.error.remedy}` : ""].filter(Boolean).join("\n"), frame.error?.native?.code, frame.error?.remedy);
  if (!frame.result || typeof frame.result !== "object" || Array.isArray(frame.result)) throw new Error("The daemon returned an unsupported result.");
  return frame.result;
}

/** A dashboard link can prefill public onboarding coordinates, never authenticate or connect. */
export function onboardingLink(value: string): { idp: string; space?: string } {
  const u = new URL(value);
  if (u.protocol !== "cotal:" || u.hostname !== "connect" || !["", "/"].includes(u.pathname) || u.username || u.password || u.port || u.hash) throw new Error("Unsupported Cotal onboarding link.");
  const keys = [...u.searchParams.keys()];
  if (keys.some((key) => key !== "idp" && key !== "space") || new Set(keys).size !== keys.length) throw new Error("The onboarding link contains unsupported fields.");
  const idp = approvalUrl(u.searchParams.get("idp"));
  const provider = new URL(idp);
  if (provider.search || provider.hash) throw new Error("A provider cannot contain a query or fragment.");
  const space = u.searchParams.get("space");
  if (space !== null && !/^[A-Za-z0-9_-]{1,64}$/.test(space)) throw new Error("Invalid onboarding space.");
  return { idp, ...(space ? { space } : {}) };
}
