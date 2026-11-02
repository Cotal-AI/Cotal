import { accessSync, constants, readFileSync, realpathSync, statSync } from "node:fs";
import { delimiter, isAbsolute, join } from "node:path";

/** The env name carrying the absolute real path of the `claude` file a once launch started. */
export const HOST_EXE_ENV = "COTAL_CLAUDE_EXE";

/** How long the once exit waits for `claude` after SIGTERM, and after SIGKILL. */
const TERM_WAIT_MS = 5_000;
const KILL_WAIT_MS = 2_000;

/** The `claude` process a managed once seat's MCP server runs under, as recorded at the server's
 *  start: its pid, its start token, and the real path of its executable. */
export interface ClaudeHost {
  pid: number;
  start: string;
  exe: string;
}

/** Resolve the `claude` a once launch starts to its absolute real path, so the seat can tell its
 *  parent is that file. Linux only, where the seat can read its parent's identity; elsewhere, or
 *  when nothing resolves, it answers undefined and the launch passes no path. */
export function resolveHostExe(binary: string, env: Record<string, string>): string | undefined {
  if (process.platform !== "linux") return undefined;
  const candidates = binary.includes("/") ? [binary] : (env.PATH ?? "").split(delimiter).filter((d) => isAbsolute(d)).map((d) => join(d, binary));
  for (const c of candidates) {
    try {
      if (!statSync(c).isFile()) continue;
      accessSync(c, constants.X_OK);
      return realpathSync(c);
    } catch { /* not this one */ }
  }
  return undefined;
}

type HostState = "same" | "gone" | "unknown";

/** Read `pid` from the process table: `gone` when no such process runs or another process holds the
 *  pid, `same` when it is still `host`, and `unknown` when its entry or executable cannot be read
 *  or its executable is another file. */
function hostState(host: ClaudeHost): HostState {
  let stat: string;
  try { stat = readFileSync(`/proc/${host.pid}/stat`, "utf8"); }
  catch (e) { return (e as NodeJS.ErrnoException).code === "ENOENT" ? "gone" : "unknown"; }
  const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
  if (fields[19] !== host.start || fields[0] === "Z") return "gone";
  try { return realpathSync(`/proc/${host.pid}/exe`) === host.exe ? "same" : "unknown"; }
  catch { return "unknown"; }
}

/** Record this MCP server's parent as the seat's `claude`, only when its executable is the file the
 *  launch named in {@link HOST_EXE_ENV}. A wrapper (a script run by node or a shell) does not match,
 *  and nothing is recorded, so the once exit declines. */
export function recordHost(env: NodeJS.ProcessEnv, pid = process.ppid): ClaudeHost | undefined {
  const exe = env[HOST_EXE_ENV];
  if (process.platform !== "linux" || !exe || pid <= 1) return undefined;
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    const start = stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19];
    if (!start || realpathSync(`/proc/${pid}/exe`) !== exe) return undefined;
    return { pid, start, exe };
  } catch {
    return undefined;
  }
}

async function goneWithin(host: ClaudeHost, ms: number): Promise<boolean> {
  const until = Date.now() + ms;
  for (;;) {
    if (hostState(host) === "gone") return true;
    if (Date.now() >= until) return false;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

/** End the seat's `claude`: SIGTERM while it is still the recorded process, then SIGKILL if it is
 *  still that process after {@link TERM_WAIT_MS}, rereading pid, start token and executable right
 *  before each signal. Resolves true once that process is gone. Resolves false, and sends nothing
 *  more, when nothing was recorded, the process changed or cannot be read, or it outlived SIGKILL:
 *  the seat could not be ended, and its once report goes on. */
export async function endHost(host: ClaudeHost | undefined): Promise<boolean> {
  if (host === undefined) return false;
  for (const [signal, wait] of [["SIGTERM", TERM_WAIT_MS], ["SIGKILL", KILL_WAIT_MS]] as const) {
    const state = hostState(host);
    if (state !== "same") return state === "gone";
    try { process.kill(host.pid, signal); } catch { return hostState(host) === "gone"; }
    if (await goneWithin(host, wait)) return true;
  }
  return false;
}
