import { connect } from "node:net";

const TIMEOUT_MS = 2_000;
const MAX_REPLY_BYTES = 16 * 1024;

/**
 * Read the exact host session id from a managed connector's authenticated local control endpoint.
 *
 * Used by Pi crash recovery: the manager must reopen the exact JSONL session the child reports,
 * never guess from cwd or newest-session ordering. The endpoint token is per launch and memory-only.
 */
export function controlSession(endpoint: { path: string; token: string }): Promise<string> {
  return new Promise((resolve, reject) => {
    let sock: ReturnType<typeof connect>;
    let settled = false;
    let buf = "";
    const finish = (error?: Error, sessionId?: string): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { sock.destroy(); } catch { /* already closed */ }
      if (error) reject(error);
      else resolve(sessionId!);
    };
    const timer = setTimeout(() => finish(new Error("session query timed out")), TIMEOUT_MS);
    timer.unref?.();
    try {
      sock = connect(endpoint.path);
    } catch (error) {
      clearTimeout(timer);
      reject(error);
      return;
    }
    sock.setEncoding("utf8");
    sock.on("connect", () => {
      try {
        sock.write(JSON.stringify({ token: endpoint.token, op: "session" }) + "\n");
      } catch (error) {
        finish(error instanceof Error ? error : new Error(String(error)));
      }
    });
    sock.on("data", (chunk: string) => {
      buf += chunk;
      if (buf.length > MAX_REPLY_BYTES) {
        finish(new Error("session query reply exceeded 16 KiB"));
        return;
      }
      const newline = buf.indexOf("\n");
      if (newline < 0) return;
      let reply: { ok?: unknown; sessionId?: unknown; error?: unknown };
      try {
        reply = JSON.parse(buf.slice(0, newline)) as typeof reply;
      } catch {
        finish(new Error("session query returned malformed JSON"));
        return;
      }
      if (reply.ok !== true || typeof reply.sessionId !== "string" || !reply.sessionId.trim()) {
        finish(new Error(typeof reply.error === "string" ? reply.error : "session query returned no session id"));
        return;
      }
      finish(undefined, reply.sessionId);
    });
    sock.on("end", () => !settled && finish(new Error("session query closed without a reply")));
    sock.on("error", (error) => finish(error));
  });
}
