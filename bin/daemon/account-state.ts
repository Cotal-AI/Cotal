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
  /** Set only when this computer was removed from the account. */
  reason?: string;
  /** Present while a Cloud read is being retried. `notice` is the one sentence every view shows. */
  cloud?: { state: "retrying"; since?: string; reason?: string; notice?: string };
  /** `observed` is launch readiness. `machineService` is set while that separate registration is not connected. */
  spaces: { space: string; desired: boolean; observed: string; machineService?: string; lastRefusal?: string; custodyRecovery?: { holder: string; candidate: string } }[];
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
    && (r.reason === undefined || typeof r.reason === "string")
    && validAccountCloud(r.cloud)
    && Array.isArray(r.spaces) && r.spaces.every((row: unknown) => {
      if (!row || typeof row !== "object") return false;
      const s = row as Record<string, unknown>;
      const recovery = s.custodyRecovery as Record<string, unknown> | undefined;
      if (recovery !== undefined && (!recovery || typeof recovery !== "object" || typeof recovery.holder !== "string" || typeof recovery.candidate !== "string" || !/^[0-9a-f]{64}$/.test(recovery.candidate))) return false;
      return typeof s.space === "string" && typeof s.desired === "boolean" && typeof s.observed === "string" && (s.machineService === undefined || typeof s.machineService === "string") && (s.lastRefusal === undefined || typeof s.lastRefusal === "string");
    });
}

function validAccountCloud(raw: unknown): boolean {
  if (raw === undefined) return true;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return false;
  const cloud = raw as Record<string, unknown>;
  return (cloud.state === "retrying")
    && (cloud.since === undefined || (typeof cloud.since === "string" && Number.isFinite(Date.parse(cloud.since))))
    && (cloud.reason === undefined || typeof cloud.reason === "string")
    && (cloud.notice === undefined || typeof cloud.notice === "string");
}
