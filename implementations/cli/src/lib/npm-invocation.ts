import { AsyncLocalStorage } from "node:async_hooks";
import { spawnSync } from "node:child_process";
import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { basename, delimiter, dirname, isAbsolute, join, parse, resolve } from "node:path";
import { logicalExecutionEntry, resolveOnPath } from "@cotal-ai/workspace";

const { satisfies } = createRequire(import.meta.url)("semver") as { satisfies: (version: string, range: string) => boolean };
export const npmProjectDirectory = new AsyncLocalStorage<string | undefined>();

function npmEngine(file: string): { entry: string; range: string } | undefined {
  try {
    let entry = realpathSync(file);
    if (basename(entry).toLowerCase() === "npm.cmd") {
      const target = /^[ \t]*@?node[ \t]+"%~dp0[\\/]?((?:[^"%!^\r\n]+[\\/])?dist[\\/]npm\.js)"[ \t]+%\*[ \t]*\r?$/im.exec(readFileSync(entry, "utf8"))?.[1];
      entry = realpathSync(target ? resolve(dirname(entry), target) : join(dirname(entry), "node_modules", "npm", "bin", "npm-cli.js"));
    }
    const corepack = basename(entry) === "npm.js" && basename(dirname(entry)) === "dist";
    if (!corepack && basename(entry) !== "npm-cli.js") return;
    const manifest = JSON.parse(readFileSync(join(dirname(dirname(entry)), "package.json"), "utf8"));
    if (manifest.name !== (corepack ? "corepack" : "npm") || (!corepack && manifest.bin?.npm !== "bin/npm-cli.js") || typeof manifest.engines?.node !== "string") return;
    return { entry, range: manifest.engines.node };
  } catch { return undefined; }
}

function recordedNode(): string | undefined {
  try {
    const entry = logicalExecutionEntry();
    if (!entry) return;
    const launcher = join(dirname(entry), "cotal-npm");
    const info = lstatSync(launcher);
    if (!info.isFile() || (info.mode & 0o022) !== 0 || info.uid !== lstatSync(entry).uid) return;
    const match = /^  node=('(?:[^'\n]|'\\'')*')$/m.exec(readFileSync(launcher, "utf8"));
    const node = match?.[1]?.slice(1, -1).replaceAll("'\\''", "'");
    return node && isAbsolute(node) ? node : undefined;
  } catch { return undefined; }
}

function probeNode(file: string, cwd: string, env: NodeJS.ProcessEnv): { path: string; version: string } | undefined {
  const result = spawnSync(file, ["-p", "JSON.stringify({ path: process.execPath, version: process.version })"], {
    cwd, env, encoding: "utf8", timeout: 1000, killSignal: "SIGKILL", windowsHide: true,
  });
  if (result.status !== 0) return;
  try {
    const { path, version } = JSON.parse(result.stdout) as { path?: unknown; version?: unknown };
    if (typeof path === "string" && isAbsolute(path) && typeof version === "string") return { path, version };
  } catch { return undefined; }
}

export function npmInvocation(env: NodeJS.ProcessEnv, args: string[]) {
  const cwd = parse(homedir()).root;
  const windows = process.platform === "win32";
  const pathKey = windows
    ? Object.keys(env).find(key => key.toLowerCase() === "path") ?? "PATH" : "PATH";
  const path = env[pathKey];
  if (path === undefined) return { file: "npm", args, env, cwd };
  const directories = path.split(delimiter).map(dir => resolve(cwd, dir));
  const lookup = { ...env, [pathKey]: directories.join(delimiter) };
  const file = resolveOnPath("npm", windows ? env : lookup);
  if (!file) return { file: "npm", args, env, cwd };
  const engine = npmEngine(file);
  const withNode = (node: string) => ({ ...env, [pathKey]: `${dirname(node)}${delimiter}${path}` });
  if (engine && !satisfies(process.version, engine.range)) {
    const current = realpathSync(process.execPath);
    const seen = new Set<string>();
    const probeEnv = { ...env };
    delete probeEnv.NODE_OPTIONS;
    const project = npmProjectDirectory.getStore() ?? cwd;
    for (const candidate of [recordedNode(), ...[dirname(file), ...directories].map(dir => resolveOnPath("node", { ...env, [pathKey]: dir }))]) {
      if (!candidate || seen.has(candidate)) continue;
      seen.add(candidate);
      try { if (realpathSync(candidate) === current) continue; } catch { continue; }
      // Version-manager shims can select the tool by the invoked filename.
      const selected = probeNode(candidate, project, probeEnv);
      if (!selected || !satisfies(selected.version, engine.range)) continue;
      // Confirm npm can use the same executable without the shim or its project context.
      const verified = candidate === selected.path && project === cwd ? selected : probeNode(selected.path, cwd, probeEnv);
      if (verified?.path === selected.path && verified.version === selected.version)
        return { file: verified.path, args: [engine.entry, ...args], env: withNode(verified.path), cwd };
    }
  }
  if (windows) return { file: "npm", args, env, cwd };
  const node = resolveOnPath("node", lookup);
  if (node && realpathSync(node) === realpathSync(process.execPath)) return { file: "npm", args, env, cwd };
  return { file, args, env: withNode(process.execPath), cwd };
}
