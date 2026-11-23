/**
 * Starting this machine's manager for a thread that has none, through `cotal manager start`, so the
 * person never has to keep a manager running for their client.
 */
import { spawn } from "node:child_process";
import { NoLaunchManager, type ManagerChoice, type Mesh } from "./mesh.js";

/** How long a manager the bridge starts waits with no agents before it stops itself. */
const IDLE_EXIT_SECONDS = 600;

type StartResult = { outcome?: unknown; error?: { message?: unknown; remedy?: unknown } };

/** The start's JSON result, or undefined when it printed none. */
function startResult(stdout: string): StartResult | undefined {
  try {
    return JSON.parse(stdout) as StartResult;
  } catch {
    return undefined;
  }
}

/** The start's own reason, from its JSON result, else the last line it wrote to stderr. */
export function startFailure(code: number | null, stdout: string, stderr: string): string {
  const error = startResult(stdout)?.error;
  if (typeof error?.message === "string") return typeof error.remedy === "string" ? `${error.message}; ${error.remedy}` : error.message;
  return stderr.trim().split("\n").at(-1) || `it exited with code ${code}`;
}

/** The line a thread shows after a start that succeeded. A start that found the manager already
 *  running, such as one another thread started a moment earlier, reports "no-op". */
export function startLine(space: string, stdout: string): string {
  const idle = `It stops itself after ${IDLE_EXIT_SECONDS / 60} minutes with no agents.`;
  return startResult(stdout)?.outcome === "no-op" ? `This machine's manager for ${space} is running. ${idle}` : `Started this machine's manager for ${space}. ${idle}`;
}

/** Run `cotal manager start --space <space> --idle-exit 600` with the node and cotal entry this
 *  process runs from, as `cotal acp --auth` runs `cotal login`. It returns once the manager serves
 *  its endpoint, and the manager runs detached from this process. Rejects with
 *  {@link NoLaunchManager} naming the start's reason. */
export async function startManager(space: string): Promise<string> {
  const args = [...process.execArgv, process.argv[1]!, "manager", "start", "--space", space, "--idle-exit", String(IDLE_EXIT_SECONDS), "--json"];
  const child = spawn(process.execPath, args, { stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (b: Buffer) => (stdout += b));
  child.stderr.on("data", (b: Buffer) => (stderr += b));
  const failed = (why: string) => new NoLaunchManager(`Could not start this machine's manager for ${space}: ${why}`);
  const code = await new Promise<number | null>((resolve, reject) => {
    child.once("error", (e) => reject(failed(e.message)));
    child.once("close", resolve);
  });
  if (code !== 0) throw failed(startFailure(code, stdout, stderr));
  return startLine(space, stdout);
}

/** The managers a new agent may start on. When none may, this machine's manager is started and the
 *  list read again, and `onStart` gets the line the thread shows. */
export async function launchManagers(m: Pick<Mesh, "managers" | "startManager">, onStart: (line: string) => void): Promise<ManagerChoice[]> {
  try {
    return await m.managers();
  } catch (e) {
    if (!(e instanceof NoLaunchManager)) throw e;
    onStart(await m.startManager());
    return m.managers();
  }
}
