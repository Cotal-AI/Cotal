import { controlCall, type ControlEndpoint } from "@cotal-ai/core";

/** Window to deliver the cooperative shutdown frame before we give up and let the runtime's own
 *  grace timer hard-kill. Short — the frame is one small write; this only guards a hung connect. */
const TIMEOUT_MS = 2_000;

/**
 * Ask a managed agent to shut down cleanly over its authenticated control endpoint.
 *
 * On a runtime that can't deliver a clean exit signal (ConPTY/Windows: node-pty `kill(SIGTERM)`
 * throws, a pseudoconsole can't carry a signal), a hard kill denies the agent its exit handlers —
 * so it never leaves the mesh / publishes offline presence. This sends `{op:"shutdown"}` through the
 * control exchange, so the agent's control server and this call each prove they hold the endpoint's
 * key without sending it; the server then runs `agent.stop()` and exits on its own.
 *
 * Best-effort and fire-and-forget: the runtime hard-kills as a fallback after its own grace window,
 * so a failed, refused, or slow send never blocks the stop — it just falls through to the kill. The
 * key is held in memory only (never logged or persisted).
 */
export function controlShutdown(endpoint: ControlEndpoint): void {
  void controlCall(endpoint, { op: "shutdown" }, { timeoutMs: TIMEOUT_MS }).catch(() => {
    /* not running, refused, or unproven — the fallback hard-kill covers it */
  });
}
