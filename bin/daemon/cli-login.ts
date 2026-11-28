/** CLI sign-in cancellation shared by login and setup, not the desktop bridge. */
import { CommandFailure } from "@cotal-ai/workspace";
import { loginViaDaemon, type LoginOptions, type LoginReply } from "./client.js";
import { createLoginCoordinator } from "./login.js";
import type { LoginResult } from "./protocol.js";

async function withLoginSignals<T>(run: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const abort = new AbortController();
  const signals = ["SIGINT", "SIGTERM", "SIGHUP"] as const;
  const removeHandlers = () => { for (const signal of signals) process.off(signal, onSignal); };
  const onSignal = () => { removeHandlers(); abort.abort(); };
  for (const signal of signals) process.once(signal, onSignal);
  try {
    return await run(abort.signal);
  } finally {
    removeHandlers();
  }
}

function completedLogin(result: LoginResult) {
  if (result.outcome === "cancelled") {
    throw new CommandFailure("refused", "USAGE_INVALID", "the sign-in was cancelled on this machine; no sign-in was saved and nothing was revoked at the provider", { selfContained: true, native: { code: "CANCELLED" } });
  }
  return result;
}

/** Keep the command alive until the daemon answers cancellation, then restore signal handling. */
export async function loginFromCli(opts: Omit<LoginOptions, "signal">) {
  const reply: LoginReply = await withLoginSignals(signal => loginViaDaemon({ ...opts, signal }));
  if (!reply.ok && reply.code === "ABANDONED") {
    throw new CommandFailure("refused", "USAGE_INVALID", reply.message, { selfContained: true, native: { code: reply.code } });
  }
  if (!reply.ok) return reply;
  return { ...reply, result: completedLogin(reply.result) };
}

/** With no service yet, approve into the same session directory the daemon will use. */
export async function loginBeforeInstall(opts: Omit<LoginOptions, "signal">, sessionDir: string) {
  return withLoginSignals(async signal => {
    const login = createLoginCoordinator({ sessionDir });
    let prompted = false;
    const cancel = () => { void login.close(); };
    const attempt = login.start({ ...opts, onPrompt: (_, prompt) => { prompted = true; opts.onPrompt(prompt); }, onResult: async () => {} })!;
    signal.addEventListener("abort", cancel, { once: true });
    try {
      const result = await attempt.settled;
      if (result.outcome === "cancelled" && !prompted) {
        throw new CommandFailure("refused", "USAGE_INVALID", "stopped before the approval prompt; no sign-in was saved", { selfContained: true, native: { code: "ABANDONED" } });
      }
      return completedLogin(result);
    }
    finally { signal.removeEventListener("abort", cancel); }
  });
}
