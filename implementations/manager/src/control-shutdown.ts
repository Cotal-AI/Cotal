import { connect } from "node:net";

/** Window to deliver the cooperative shutdown frame before we give up and let the runtime's own
 *  grace timer hard-kill. Short — the frame is one small write; this only guards a hung connect. */
const TIMEOUT_MS = 2_000;

/**
 * Ask a managed agent to shut down cleanly over its authenticated control endpoint.
 *
 * On a runtime that can't deliver a clean exit signal (ConPTY/Windows: node-pty `kill(SIGTERM)`
 * throws, a pseudoconsole can't carry a signal), a hard kill denies the agent its exit handlers —
 * so it never leaves the mesh / publishes offline presence. This sends `{token, op:"shutdown"}`;
 * the agent's control server (which validated the token) runs `agent.stop()` then exits on its own.
 *
 * Best-effort and fire-and-forget: the runtime hard-kills as a fallback after its own grace window,
 * so a failed, refused, or slow send never blocks the stop — it just falls through to the kill. The
 * token authenticates the frame; it is held in memory only (never logged or persisted).
 */
export function controlShutdown(endpoint: { path: string; token: string }): void {
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
      sock.write(JSON.stringify({ token: endpoint.token, op: "shutdown" }) + "\n");
    } catch {
      /* ignore — fallback kill covers it */
    }
  });
  sock.on("data", finish); // ack received — the agent is tearing down
  sock.on("end", finish);
  sock.on("error", finish); // not running / refused — fallback kill covers it
}
