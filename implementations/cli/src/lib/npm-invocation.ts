import { spawnSync } from "node:child_process";
import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { basename, delimiter, dirname, isAbsolute, join, parse, resolve } from "node:path";
import { logicalExecutionEntry, resolveOnPath } from "@cotal-ai/workspace";

const { satisfies } = createRequire(import.meta.url)("semver") as { satisfies: (version: string, range: string) => boolean };

function npmEngine(file: string): { entry: string; range: string } | undefined {
  try {
    const real = realpathSync(file);
    const entry = basename(real).toLowerCase() === "npm.cmd"
      ? realpathSync(join(dirname(real), "node_modules", "npm", "bin", "npm-cli.js")) : real;
    if (basename(entry) !== "npm-cli.js") return;
    const manifest = JSON.parse(readFileSync(join(dirname(dirname(entry)), "package.json"), "utf8"));
    if (manifest.name !== "npm" || manifest.bin?.npm !== "bin/npm-cli.js" || typeof manifest.engines?.node !== "string") return;
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
    const seen = new Set([realpathSync(process.execPath)]);
    const probeEnv = { ...env };
    delete probeEnv.NODE_OPTIONS;
    for (const candidate of [recordedNode(), ...[dirname(file), ...directories].map(dir => resolveOnPath("node", { ...env, [pathKey]: dir }))]) {
      if (!candidate) continue;
      let node: string;
      try { node = realpathSync(candidate); } catch { continue; }
      if (seen.has(node)) continue;
      seen.add(node);
      const version = spawnSync(node, ["--version"], { cwd, env: probeEnv, encoding: "utf8", timeout: 1000, killSignal: "SIGKILL", windowsHide: true });
      if (version.status === 0 && satisfies(version.stdout.trim(), engine.range))
        return { file: node, args: [engine.entry, ...args], env: withNode(node), cwd };
    }
  }
  if (windows) return { file: "npm", args, env, cwd };
  const node = resolveOnPath("node", lookup);
  if (node && realpathSync(node) === realpathSync(process.execPath)) return { file: "npm", args, env, cwd };
  return { file, args, env: withNode(process.execPath), cwd };
}
