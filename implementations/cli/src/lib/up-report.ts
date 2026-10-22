import { oneLine } from "@cotal-ai/workspace";

export interface DetachedStatus {
  root?: string;
  /** The stack runs from the machine home, which bare `down` does not stop. */
  machineHome?: boolean;
  pid: number;
  delivery: boolean;
  authService: boolean;
  manager: boolean;
}

/** Render only components confirmed running for this detached boot. */
export function renderDetachedSummary(status: DetachedStatus): string {
  const components = [`nats-server (pid ${status.pid})`];
  if (status.delivery) components.push("delivery daemon");
  if (status.authService) components.push("user-auth service");
  if (status.manager) components.push("manager");
  // The home stack's only stop is --preserve-state, which takes its inventory from a manager.
  const stop = !status.machineHome ? "cotal down" : status.manager ? "cotal down --preserve-state" : "cotal up to start its manager, then cotal down --preserve-state";
  return `✓ running in the background: ${components.join(", ")} - ${status.root ? `from ${oneLine(status.root)}, stop with: ${stop}` : `stop with: ${stop}`}`;
}
