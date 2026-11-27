import { spawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import { statSync } from "node:fs";
import { delimiter, resolve } from "node:path";

/** Native launch accepts only a real uv.exe on PATH, never a PATHEXT script shim. */
export function findWindowsUv(): string | undefined {
  for (const dir of (process.env.PATH ?? "").split(delimiter)) {
    if (!dir) continue;
    const path = resolve(dir, "uv.exe");
    try { if (statSync(path, { throwIfNoEntry: false })?.isFile()) return path; }
    catch { /* Skip inaccessible PATH entries. */ }
  }
  return undefined;
}

/** The exact `uv` executable resolved by manager boot. A bare fallback remains for library
 * compositions that do not run the installed-extension inventory. */
export function hermesUvCommand(env: NodeJS.ProcessEnv = process.env): string {
  return env.COTAL_HERMES_UV_BIN?.trim() || "uv";
}

/** Spawn the project-pinned Hermes gateway through the exact manager-resolved uv executable. The
 * injectable spawn function is a smoke seam over this real call, not a second launch renderer. */
export function spawnHermesGateway(opts: {
  pkgDir: string;
  env: NodeJS.ProcessEnv;
  spawnImpl?: typeof spawn;
}): ChildProcess {
  const spawnImpl = opts.spawnImpl ?? spawn;
  const spawnOptions: SpawnOptions = { env: opts.env, stdio: "inherit", windowsHide: true };
  return spawnImpl(hermesUvCommand(opts.env), ["run", "--project", opts.pkgDir, "hermes", "gateway", "run"], spawnOptions);
}
