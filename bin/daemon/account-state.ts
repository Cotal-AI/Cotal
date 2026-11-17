/** Public account-computer state. Desired intent is separate from observed readiness. */
export interface AccountComputerStatus {
  machineId?: string;
  idpUrl?: string;
  sub?: string;
  label?: string;
  computer?: string;
  accounts?: AccountComputerStatus[];
  mode: "signed-out" | "account" | "per-space" | "sign-in-required" | "account-selection-required" | "unavailable";
  hostSupport: "unknown" | "supported" | "unsupported";
  lastRegistration?: string;
  desiredRevision?: number;
  message?: string;
  /** `observed` is launch readiness. `machineService` is set while that separate registration is not connected. */
  spaces: { space: string; desired: boolean; observed: string; machineService?: string; lastRefusal?: string }[];
}

export function validAccountComputerStatus(raw: unknown): raw is AccountComputerStatus {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return false;
  const r = raw as Record<string, unknown>;
  return (r.machineId === undefined || (typeof r.machineId === "string" && /^[0-9a-f-]{36}$/.test(r.machineId)))
    && [r.idpUrl, r.sub, r.label, r.computer].every(value => value === undefined || typeof value === "string")
    && (r.accounts === undefined || (Array.isArray(r.accounts) && r.accounts.every(validAccountComputerStatus)))
    && ["signed-out", "account", "per-space", "sign-in-required", "account-selection-required", "unavailable"].includes(String(r.mode))
    && ["unknown", "supported", "unsupported"].includes(String(r.hostSupport))
    && (r.lastRegistration === undefined || (typeof r.lastRegistration === "string" && Number.isFinite(Date.parse(r.lastRegistration))))
    && (r.desiredRevision === undefined || (Number.isSafeInteger(r.desiredRevision) && Number(r.desiredRevision) >= 0))
    && (r.message === undefined || typeof r.message === "string")
    && Array.isArray(r.spaces) && r.spaces.every((row: unknown) => {
      if (!row || typeof row !== "object") return false;
      const s = row as Record<string, unknown>;
      return typeof s.space === "string" && typeof s.desired === "boolean" && typeof s.observed === "string" && (s.machineService === undefined || typeof s.machineService === "string") && (s.lastRefusal === undefined || typeof s.lastRefusal === "string");
    });
}
