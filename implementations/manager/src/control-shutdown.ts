import { connect } from "node:net";
import type { ManagementControlFence } from "@cotal-ai/core";

/** Window to deliver the cooperative shutdown frame before we give up and let the runtime's own
 *  grace timer hard-kill. Short — the frame is one small write; this only guards a hung connect. */
const TIMEOUT_MS = 2_000;

/**
 * Ask a managed agent to shut down cleanly over its authenticated control endpoint.
 *
 * On a runtime that can't deliver a clean exit signal (ConPTY/Windows: node-pty `kill(SIGTERM)`
 * throws, a pseudoconsole can't carry a signal), a hard kill denies the agent its exit handlers —
 * so it never leaves the mesh / publishes offline presence. This sends the separate management token
 * plus the exact Binding.bindingId/controllerEpoch fence; the server rechecks both before it runs
 * `agent.stop()` and exits on its own. A legacy endpoint without that split throws BLOCKED.
 *
 * Best-effort and fire-and-forget: the runtime hard-kills as a fallback after its own grace window,
 * so a failed, refused, or slow send never blocks the stop — it just falls through to the kill. The
 * management token authenticates the frame; it is held in memory only (never logged or persisted).
 */
export interface ShutdownControlEndpoint {
  path: string;
  management?: {
    token: string;
    fence: ManagementControlFence;
  };
}

export function controlShutdown(endpoint: ShutdownControlEndpoint): void {
  const management = endpoint.management;
  if (!management)
    throw new Error(
      "control shutdown BLOCKED: the endpoint carries no separate management credential bound to " +
        "Binding.bindingId + controllerEpoch; refusing to fall back to the hook credential",
    );
  let sock: ReturnType<typeof connect>;
  let done = false;
  const finish = (): void => {
    if (done) return;
    done = true;
    clearTimeout(timer);
    try {
      sock.destroy();
    } catch {
      /* ignore */
    }
  };
  const timer = setTimeout(finish, TIMEOUT_MS);
  timer.unref?.(); // best-effort + fire-and-forget — never hold the manager's event loop open at exit
  try {
    sock = connect(endpoint.path);
  } catch {
    clearTimeout(timer);
    return; // not reachable — the fallback hard-kill covers it
  }
  sock.setEncoding("utf8");
  sock.on("connect", () => {
    try {
      sock.write(JSON.stringify({
        token: management.token,
        op: "shutdown",
        resourceId: management.fence.resourceId,
        bindingId: management.fence.bindingId,
        controllerEpoch: management.fence.controllerEpoch,
      }) + "\n");
    } catch {
      /* ignore — fallback kill covers it */
    }
  });
  sock.on("data", finish); // ack received — the agent is tearing down
  sock.on("end", finish);
  sock.on("error", finish); // not running / refused — fallback kill covers it
}
