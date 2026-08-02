/**
 * The real Codex TUI, attached to the agent's mesh thread.
 *
 * `codex resume --remote <ws-url> <threadId>` connects Codex's own interactive app to the
 * app-server the host is already driving, and REJOINS the running thread rather than starting a
 * private one. That is what makes `cotal spawn --agent codex` land you in Codex proper: the mesh
 * turns the host drives render here as they happen, and anything typed here is a real user turn
 * on the same thread, with the cotal_* tools still routed back to the host's mesh endpoint.
 *
 * The TUI owns the terminal (stdio inherited), so the host must not write to it — see host.ts,
 * which redirects its own logging to a file for exactly this reason.
 */
import { spawn, type ChildProcess } from "node:child_process";

/** Env var carrying the capability token to the TUI. Passed by NAME (`--remote-auth-token-env`)
 *  rather than on argv, so the token never appears in the process table. */
const TOKEN_ENV = "COTAL_CODEX_REMOTE_TOKEN";

export interface TuiOpts {
  /** `ws://127.0.0.1:<port>` from the driver's {@link import("./app-server.js").RemoteEndpoint}. */
  url: string;
  token: string;
  /** The thread the host started and drives — the TUI rejoins THIS one. */
  threadId: string;
  /** The agent's private CODEX_HOME, so the TUI reads the managed config, never the operator's. */
  codexHome: string;
  cwd: string;
  bin?: string;
}

/**
 * Launch the TUI on this process's terminal. The caller owns the returned child: its exit means
 * the operator quit the session, which the host treats as a cooperative shutdown.
 */
export function launchTui(opts: TuiOpts): ChildProcess {
  const args = [
    "resume",
    "--remote",
    opts.url,
    "--remote-auth-token-env",
    TOKEN_ENV,
    // A managed agent must never sit on an interactive gate. The update prompt blocks the first
    // paint until someone presses a key, which for a detached agent is nobody.
    "-c",
    "check_for_update_on_startup=false",
    opts.threadId,
  ];
  // Same scrubbing rule as the app-server child: the TUI (and anything it spawns) has no business
  // reading this agent's mesh identity or credential.
  const env: Record<string, string> = { CODEX_HOME: opts.codexHome, [TOKEN_ENV]: opts.token };
  for (const [k, v] of Object.entries(process.env))
    if (v !== undefined && !k.startsWith("COTAL_") && k !== "CODEX_HOME") env[k] = v;
  return spawn(opts.bin ?? "codex", args, { cwd: opts.cwd, env, stdio: "inherit" });
}
