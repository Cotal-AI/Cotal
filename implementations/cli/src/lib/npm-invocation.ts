import { AsyncLocalStorage } from "node:async_hooks";
import { spawnSync } from "node:child_process";
import { lstatSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir, tmpdir } from "node:os";
import { basename, delimiter, dirname, isAbsolute, join, parse, resolve } from "node:path";
import { logicalExecutionEntry, protectedLocalDirectory, resolveOnPath } from "@cotal-ai/workspace";

const { satisfies } = createRequire(import.meta.url)("semver") as { satisfies: (version: string, range: string) => boolean };
export const npmProjectDirectory = new AsyncLocalStorage<string | undefined>();
const UPDATE_NPM_NODE = "COTAL_UPDATE_NPM_NODE";
const windows = process.platform === "win32";

let updatePath: { value: string; directories: string[] } | undefined;

export function preserveUpdatePath(): void {
  const path = process.env.PATH;
  if (path === undefined || path === updatePath?.value) return;
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

function compatibleNode(candidate: string, directory: string, cwd: string, env: NodeJS.ProcessEnv, range: string): string | undefined {
  // Version-manager shims can select the tool by the invoked filename.
  const selected = probeNode(candidate, directory, env);
  if (!selected || !satisfies(selected.version, range)) return;
  if (directory === cwd && candidate === selected.path) return selected.path;
  // npm uses the same executable from its isolated cwd without the shim.
  const verified = probeNode(selected.path, cwd, env);
  if (verified?.path === selected.path && verified.version === selected.version) return verified.path;
}

function pathVariable(env: NodeJS.ProcessEnv): string {
  return windows ? Object.keys(env).find(key => key.toLowerCase() === "path") ?? "PATH" : "PATH";
}

export function npmUpdateChildEnvironment(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  if (!npmProjectDirectory.getStore() && env[UPDATE_NPM_NODE] === undefined) return env;
  const { node } = selectNpm(env, []);
  if (!node) {
    if (env[UPDATE_NPM_NODE] === undefined) return env;
    const next = { ...env };
    delete next[UPDATE_NPM_NODE];
    return next;
  }
  const pathKey = pathVariable(env);
  const path = env[pathKey]!;
  const bin = dirname(node);
  // Older reconcile and rollback children can find Node on PATH without shadowing the selected npm.
  return { ...env, [UPDATE_NPM_NODE]: node, [pathKey]: bin.includes(delimiter) || path.split(delimiter).includes(bin) ? path : `${path}${delimiter}${bin}` };
}

function selectNpm(env: NodeJS.ProcessEnv, args: string[]): {
  file: string; args: string[]; env: NodeJS.ProcessEnv; cwd: string; node?: string; pathNode?: string; direct?: true;
} {
  const cwd = parse(homedir()).root;
  const pathKey = pathVariable(env);
  const inheritedNode = env[UPDATE_NPM_NODE];
  if (inheritedNode !== undefined) {
    env = { ...env };
    delete env[UPDATE_NPM_NODE];
  }
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
  const withNode = (node: string, preserveLiteral = literal !== undefined) => preserveLiteral && dirname(node).includes(delimiter) ? env
    : { ...env, [pathKey]: `${dirname(node)}${delimiter}${path}` };
  const withRuntime = (node: string, preserveLiteral = literal !== undefined) => {
    if (windows) return { env: withNode(node, preserveLiteral) };
    const bin = dirname(node);
    const named = !bin.includes(delimiter) && inDirectory(bin, "node");
    return named && realpathSync(named) === realpathSync(node) ? { env: withNode(node) } : { env, pathNode: node };
  };
  if (engine && !satisfies(process.version, engine.range)) {
    const current = realpathSync(process.execPath);
    const probeEnv = { ...env };
    delete probeEnv.NODE_OPTIONS;
    const project = npmProjectDirectory.getStore();
    // A POSIX directory with a colon travels in the absolute hint, not PATH.
    const inheritedBin = inheritedNode ? dirname(inheritedNode) : "";
    if (inheritedNode && isAbsolute(inheritedNode) &&
        (directories.includes(inheritedBin) || (!windows && inheritedBin.includes(delimiter))) &&
        resolveOnPath(inheritedNode, env) === inheritedNode) {
      const node = compatibleNode(inheritedNode, cwd, cwd, probeEnv, engine.range);
      if (node === inheritedNode) return { file: node, args: [engine.entry, ...args], ...withRuntime(node, true), cwd, node, direct: true };
    }
    const seen = new Set<string>();
    const candidates: string[] = [];
    for (const candidate of [recordedNode(), ...[dirname(file), ...directories].map(dir => inDirectory(dir, "node"))]) {
      if (!candidate || seen.has(candidate)) continue;
      seen.add(candidate);
      try { if (realpathSync(candidate) === current) continue; } catch { continue; }
      candidates.push(candidate);
      const node = project === undefined ? undefined : compatibleNode(candidate, project, cwd, probeEnv, engine.range);
      if (node) return { file: node, args: [engine.entry, ...args], ...withRuntime(node, true), cwd, node, direct: true };
    }
    for (const candidate of candidates) {
      // Keep the shim's invocation name and environment for npm if isolated version lookup succeeds.
      const version = spawnSync(candidate, ["--version"], { cwd, env: probeEnv, encoding: "utf8", timeout: 1000, killSignal: "SIGKILL", windowsHide: true });
      if (version.status === 0 && satisfies(version.stdout.trim(), engine.range))
        return { file: candidate, args: [engine.entry, ...args], ...withRuntime(candidate), cwd, direct: true };
    }
  }
  if (windows) return { file: "npm", args, env, cwd };
  const node = resolveOnPath("node", lookup);
  if (node && realpathSync(node) === realpathSync(process.execPath))
    return { file: literal ? file : "npm", args, env, cwd };
  const runtime = withRuntime(process.execPath);
  if (engine && runtime.pathNode) return { file: process.execPath, args: [engine.entry, ...args], ...runtime, cwd, direct: true };
  return { file, args, ...runtime, cwd };
}

export function npmInvocation(env: NodeJS.ProcessEnv, args: string[], phase: "preflight" | "lifecycle") {
  const { pathNode, direct, ...npm } = selectNpm(env, args);
  // A wrapper may need `node` to start. A direct preflight already has its executable.
  if (!pathNode || (direct && phase === "preflight")) return { ...npm, [Symbol.dispose]() {} };
  const temp = realpathSync(tmpdir());
  // Keep npm's scratch where the caller requested it. Only the executable link needs a PATH entry.
  const parent = temp.includes(delimiter) ? realpathSync(homedir()) : temp;
  if (parent.includes(delimiter)) throw new Error(`npm cannot put its Node link on PATH: both TMPDIR and the home directory contain ${JSON.stringify(delimiter)}`);
  protectedLocalDirectory(parent, "the npm Node link parent");
  const bin = mkdtempSync(join(parent, "cotal-npm-node-"));
  const dispose = () => rmSync(bin, { recursive: true, force: true, maxRetries: 3 });
  try {
    // npm's lifecycle shell and node-gyp resolve `node` by name, even when npm itself starts directly.
    symlinkSync(pathNode, join(bin, "node"));
    return { ...npm, env: { ...npm.env, PATH: `${bin}${delimiter}${npm.env.PATH}` }, [Symbol.dispose]: dispose };
  } catch (error) {
    dispose();
    throw error;
  }
}
