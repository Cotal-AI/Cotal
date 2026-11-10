/** CLI sign-in cancellation shared by login and both setup paths, not the desktop bridge. */
import { CommandFailure } from "@cotal-ai/workspace";
import { loginViaDaemon, type LoginOptions, type LoginReply } from "./client.js";

/** Keep the command alive until the daemon answers cancellation, then restore signal handling. */
export async function loginFromCli(opts: Omit<LoginOptions, "signal">) {
  const abort = new AbortController();
  const onSignal = () => abort.abort();
  process.once("SIGINT", onSignal);
  process.once("SIGTERM", onSignal);
  let reply: LoginReply;
  try {
    reply = await loginViaDaemon({ ...opts, signal: abort.signal });
  } finally {
    process.off("SIGINT", onSignal);
    process.off("SIGTERM", onSignal);
  }
  if (!reply.ok && reply.code === "ABANDONED") {
    throw new CommandFailure("refused", "USAGE_INVALID", reply.message, { selfContained: true, native: { code: reply.code } });
  }
  if (!reply.ok) return reply;
  if (reply.result.outcome === "cancelled") {
    throw new CommandFailure("refused", "USAGE_INVALID", "the sign-in was cancelled on this machine; nothing was saved and nothing was revoked at the provider", { selfContained: true, native: { code: "CANCELLED" } });
  }
  return { ...reply, result: reply.result };
}
