import { EndpointRefusal } from "./endpoint.js";

const failures = {
  "connector-setup-failed": { message: "Cotal could not set up the connections to your agent apps on this computer.", action: "repair" },
  "sign-in-required": { message: "Cotal needs a fresh sign-in for this space on this computer.", action: "sign-in" },
  "folder-protection": { message: "Cotal cannot access a folder it needs on this computer.", action: "none" },
  "update-pending": { message: "Cotal must finish updating on this computer before it can start the Manager.", action: "none" },
  "space-unavailable": { message: "Cotal cannot use this space from this computer right now.", action: "none" },
  "permission-denied": { message: "This space has not allowed this computer to start a Manager.", action: "none" },
  "local-state-error": { message: "Cotal cannot use its saved setup for this space on this computer.", action: "none" },
  "start-failed": { message: "Cotal could not start the Manager on this computer.", action: "repair" },
} as const;

export type ManagerStartFailureCode = keyof typeof failures;

export function isManagerStartFailureCode(code: unknown): code is ManagerStartFailureCode {
  return typeof code === "string" && Object.hasOwn(failures, code);
}

export function managerStartFailure(spaceId: string, code: ManagerStartFailureCode) {
  return { spaceId, code, ...failures[code] };
}

export class ManagerStartupError extends Error {
  constructor(readonly code: ManagerStartFailureCode, message: string) { super(message); }
}

export function managerStartupCode(error: unknown, fallback: ManagerStartFailureCode = "start-failed"): ManagerStartFailureCode {
  if (error instanceof ManagerStartupError) return error.code;
  if (error instanceof EndpointRefusal && error.code.startsWith("DIR_")) return "folder-protection";
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  if (code === "EACCES" || code === "EPERM") return "folder-protection";
  if (code === "GENERATION_PENDING") return "update-pending";
  return fallback;
}

export function startupPrerequisiteCode(outcome: string): ManagerStartFailureCode {
  switch (outcome) {
    case "not-registered": case "not-user-auth": case "unreachable": case "account-mismatch": return "space-unavailable";
    case "not-signed-in": case "credential-expired": return "sign-in-required";
    case "local-state-error": return "local-state-error";
    default: return "start-failed";
  }
}
