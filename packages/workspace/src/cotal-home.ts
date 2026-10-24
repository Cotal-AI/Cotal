import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";

/** The cotal machine-home dir, overridable via `COTAL_HOME`.
 *
 *  WHAT THE OVERRIDE ENFORCES (and only this): the mesh registry (`meshes/`), the current-mesh
 *  pointer, the onboard marker, prepared spaces (`prepared/`) and service records (`services/`)
 *  resolve under this directory. POSIX default `~/.cotal`; Windows `%LOCALAPPDATA%\Cotal`.
 *
 *  WHAT IT DOES NOT ENFORCE: project-root state. `cotal up`, broker launch policy
 *  (`.cotal/broker-policy.json`), the NATS store, manager/delivery pidfiles, and auth material all
 *  resolve via {@link findCotalRoot} (walk up from cwd for a `.cotal/`). Setting only `COTAL_HOME`
 *  does not redirect those paths. A test or probe that sets `COTAL_HOME` and runs a real
 *  `cotal up` from a tree whose walked root is the operator home can still write live operator
 *  config. Sandbox the project root too (temp dir with its own `.cotal/`, and run the CLI with
 *  `cwd` there) — or you have sandboxed the registry label, not the launch surface. */
export function homeCotalDir(): string {
  if (process.env.COTAL_HOME) return process.env.COTAL_HOME;
  return userCotalDir();
}

/** The OS user's own Cotal directory, which `COTAL_HOME` never redirects: POSIX `~/.cotal`, Windows
 *  `%LOCALAPPDATA%\Cotal`. Telemetry keeps its settings here, so every workspace one person runs
 *  under their own account shares one install id. */
export function userCotalDir(): string {
  if (process.platform === "win32" && process.env.LOCALAPPDATA)
    return join(process.env.LOCALAPPDATA, "Cotal");
  return join(homedir(), ".cotal");
}

/** The root the get.cotal.ai launcher runs Cotal from, or undefined outside it. The launcher exports
 *  `COTAL_LAUNCHER=1` and points npm's prefix at this root, which holds the Node runtime the
 *  installer vendored, the `cotal-ai` package and its bin. */
export function launcherInstallRoot(): string | undefined {
  const prefix = process.env.npm_config_prefix;
  return process.env.COTAL_LAUNCHER === "1" && prefix && isAbsolute(prefix) ? prefix : undefined;
}
