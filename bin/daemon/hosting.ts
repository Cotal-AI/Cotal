import type { HostedManager } from "./protocol.js";

/** Inspect or start the agent host before optional machine-service work. */
export async function ensureHostedManager(space: string, managers: {
  refresh(space: string): Promise<HostedManager>;
  start(space: string): Promise<HostedManager>;
}): Promise<HostedManager> {
  const current = await managers.refresh(space);
  return current.state === "answering" ? current : managers.start(space);
}

/** A host may run agents without exposing machine-service endpoints. */
export function hostingPrerequisite(outcome: string): boolean {
  return ["ready-to-register", "unsupported-by-space", "account-mismatch"].includes(outcome);
}
