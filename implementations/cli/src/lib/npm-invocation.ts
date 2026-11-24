import { spawnSync } from "node:child_process";
import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { basename, delimiter, dirname, isAbsolute, join, parse, resolve } from "node:path";
import { logicalExecutionEntry, resolveOnPath } from "@cotal-ai/workspace";

const { satisfies } = createRequire(import.meta.url)("semver") as { satisfies: (version: string, range: string) => boolean };

let updatePath: { value: string; directories: string[] } | undefined;

export function preserveUpdatePath(): void {
  const path = process.env.PATH;
  if (path === undefined || path === updatePath?.value) return;
  const windows = process.platform === "win32";
  const directories = path.split(delimiter)
    .map(dir => isAbsolute(dir) || (dir === "" && windows) ? dir : resolve(dir));
  // An empty POSIX entry resolves like `.`. A resolved directory with a colon can be
  // searched as a literal path, but cannot be represented in the child's PATH.
  const serializable = windows ? directories : directories.filter(dir => !dir.includes(delimiter));
  const value = serializable.join(delimiter);
  updatePath = serializable.length === directories.length ? undefined : { value, directories };
  process.env.PATH = value;
}

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

export function npmInvocation(env: NodeJS.ProcessEnv, args: string[]) {
  const cwd = parse(homedir()).root;
  const windows = process.platform === "win32";
  const pathKey = windows
    ? Object.keys(env).find(key => key.toLowerCase() === "path") ?? "PATH" : "PATH";
  const path = env[pathKey];
  if (path === undefined) return { file: "npm", args, env, cwd };
  const literal = updatePath?.value === path ? updatePath.directories : undefined;
  const directories = literal ?? path.split(delimiter).map(dir => resolve(cwd, dir));
  const lookup = literal ? env : { ...env, [pathKey]: directories.join(delimiter) };
  const inDirectory = (dir: string, bin: string) => literal
    ? resolveOnPath(join(dir, bin)) : resolveOnPath(bin, { ...env, [pathKey]: dir });
  let file: string | undefined;
  if (literal) {
    for (const dir of literal) {
      file = inDirectory(dir, "npm");
      if (file) break;
    }
  } else file = resolveOnPath("npm", windows ? env : lookup);
  if (!file) return { file: "npm", args, env, cwd };
  const engine = npmEngine(file);
  const withNode = (node: string) => literal && dirname(node).includes(delimiter) ? env
    : { ...env, [pathKey]: `${dirname(node)}${delimiter}${path}` };
  if (engine && !satisfies(process.version, engine.range)) {
    const current = realpathSync(process.execPath);
    const seen = new Set<string>();
    const probeEnv = { ...env };
    delete probeEnv.NODE_OPTIONS;
    for (const candidate of [recordedNode(), ...[dirname(file), ...directories].map(dir => inDirectory(dir, "node"))]) {
      if (!candidate || seen.has(candidate)) continue;
      seen.add(candidate);
      try { if (realpathSync(candidate) === current) continue; } catch { continue; }
      // Version-manager shims can select the tool by the invoked filename.
      const version = spawnSync(candidate, ["--version"], { cwd, env: probeEnv, encoding: "utf8", timeout: 1000, killSignal: "SIGKILL", windowsHide: true });
      if (version.status === 0 && satisfies(version.stdout.trim(), engine.range))
        return { file: candidate, args: [engine.entry, ...args], env: withNode(candidate), cwd };
    }
  }
  if (windows) return { file: "npm", args, env, cwd };
  const node = resolveOnPath("node", lookup);
  if (node && realpathSync(node) === realpathSync(process.execPath))
    return { file: literal ? file : "npm", args, env, cwd };
  if (!node && engine && literal && dirname(process.execPath).includes(delimiter))
    return { file: process.execPath, args: [engine.entry, ...args], env, cwd };
  return { file, args, env: withNode(process.execPath), cwd };
}
