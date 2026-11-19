import { controlCall, type ControlEndpoint } from "@cotal-ai/core";

const TIMEOUT_MS = 2_000;
const MAX_REPLY_BYTES = 16 * 1024;

/**
 * Read the exact host session id from a managed connector's authenticated local control endpoint.
 *
 * Used by Pi crash recovery: the manager must reopen the exact JSONL session the child reports,
 * never guess from cwd or newest-session ordering. The query runs through the control exchange, so
 * an answer is used only from a server that proved it holds the endpoint's key. The key is per
 * launch and memory-only.
 */
export async function controlSession(endpoint: ControlEndpoint): Promise<string> {
  const text = await controlCall(endpoint, { op: "session" }, { timeoutMs: TIMEOUT_MS, maxReplyBytes: MAX_REPLY_BYTES }).catch((error: Error) => {
    throw new Error(error.message === "control call timed out" ? "session query timed out" : error.message);
  });
  let reply: { ok?: unknown; sessionId?: unknown; error?: unknown };
  try {
    reply = JSON.parse(text) as typeof reply;
  } catch {
    throw new Error("session query returned malformed JSON");
  }
  if (reply.ok !== true || typeof reply.sessionId !== "string" || !reply.sessionId.trim())
    throw new Error(typeof reply.error === "string" ? reply.error : "session query returned no session id");
  return reply.sessionId;
}
