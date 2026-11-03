export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
export type Request = { op: string; space?: string; idp?: string; refresh?: boolean };
export interface Frame { v: 1; event: "result" | "login-prompt"; ok?: boolean; result?: Record<string, unknown>; prompt?: Record<string, unknown>; error?: { code: string; message: string }; code?: string; message?: string }

export function connectionView(state: string): { title: string; description: string; connected: boolean } {
  switch (state) {
    case "connected": return { title: "Connected", description: "The broker accepted this daemon and the space confirmed it is ready.", connected: true };
    case "approval-pending": return { title: "Waiting for owner approval", description: "The space owner must approve this machine. No connection is claimed yet.", connected: false };
    case "connecting": return { title: "Connecting", description: "Waiting for both broker acceptance and space readiness.", connected: false };
    case "disconnected": return { title: "Disconnected from this space", description: "The local daemon is still running. This does not revoke remote grants.", connected: false };
    case "ready": return { title: "Background service is ready", description: "Choose a space below. Local readiness does not mean connected.", connected: false };
    default: return { title: "Not connected", description: "No verified connection to the selected space is available.", connected: false };
  }
}

export function approvalUrl(value: unknown): string {
  if (typeof value !== "string") throw new Error("No approval URL was provided.");
  const url = new URL(value);
  if (url.username || url.password || (url.protocol !== "https:" && !(url.protocol === "http:" && ["127.0.0.1", "[::1]"].includes(url.hostname)))) throw new Error("The approval page must use HTTPS or a loopback address.");
  return url.href;
}

export function requireResult(frame: Frame): Record<string, unknown> {
  if (frame.v !== 1 || frame.event !== "result" || frame.ok !== true) throw new Error(frame.error?.message ?? frame.message ?? "The daemon did not confirm this operation.");
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
