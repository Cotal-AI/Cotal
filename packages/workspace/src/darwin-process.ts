import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

/** One process's kernel entry: its start time in microseconds as a decimal string, its process group,
 *  and whether a signal or a debugger has it stopped. */
export interface DarwinProcess { token: string; pgid: number; stopped: boolean }

/** The shipped macOS binding over sysctl and gethostuuid. `processInfo` is undefined for a process ID
 *  that names no process and for an argument that is not one; every other failed read throws. */
export interface DarwinProcessBinding {
  processInfo(pid: number): DarwinProcess | undefined;
  groupMembers(pgid: number): number[] | undefined;
  hostIdentity(): { machine: string; boot: string };
}

const require = createRequire(import.meta.url);
let binding: DarwinProcessBinding | undefined;

/** Load the shipped Node-API binding once. A broken installation is a loud failure, not an unreadable process. */
export function darwinProcessBinding(): DarwinProcessBinding {
  if (process.platform !== "darwin" || (process.arch !== "x64" && process.arch !== "arm64"))
    throw new Error(`macOS process identity is unsupported on ${process.platform}/${process.arch}`);
  if (binding === undefined) {
    const path = new URL(`../build/Release/darwin-${process.arch}/process.node`, import.meta.url);
    let loaded: unknown;
    try { loaded = require(fileURLToPath(path)); }
    catch (cause) { throw new Error("could not load the shipped macOS process identity binding; reinstall this version", { cause }); }
    if (loaded === null || typeof loaded !== "object" || !["processInfo", "groupMembers", "hostIdentity"].every((name) => typeof (loaded as Record<string, unknown>)[name] === "function"))
      throw new Error("the shipped macOS process identity binding is missing a reader");
    binding = loaded as DarwinProcessBinding;
  }
  return binding;
}
