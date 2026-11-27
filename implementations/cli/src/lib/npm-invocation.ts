import { AsyncLocalStorage } from "node:async_hooks";
import { spawnSync } from "node:child_process";
import { lstatSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { basename, delimiter, dirname, isAbsolute, join, parse, resolve } from "node:path";
import { logicalExecutionEntry, protectedLocalDirectory, resolveOnPath } from "@cotal-ai/workspace";

const { satisfies } = createRequire(import.meta.url)("semver") as { satisfies: (version: string, range: string) => boolean };
export const npmProjectDirectory = new AsyncLocalStorage<string | undefined>();
const UPDATE_NPM_NODE = "COTAL_UPDATE_NPM_NODE";
const windows = process.platform === "win32";

let updatePath: { value: string; directories: string[] } | undefined;
let bundledNoticePrinted = false;

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

function npmEngine(file: string): { entry: string; range: string; corepack: boolean } | undefined {
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
    return { entry, range: manifest.engines.node, corepack };
  } catch { return undefined; }
}

function corepackNpmRange(node: string, entry: string, cwd: string, env: NodeJS.ProcessEnv): string | undefined {
  const result = spawnSync(node, [entry, "--version", "--loglevel=warn", "--color=false"], {
    cwd, env, encoding: "utf8", timeout: 2000, killSignal: "SIGKILL", windowsHide: true,
  });
  // npm can print its version and exit successfully even on an unsupported Node.
  return /^(?:npm warn cli npm v\S+ does not support|ERROR: npm v\S+ is known not to run on) Node\.js \S+\. +This version of npm supports the following node versions: `([^`\r\n]+)`/m.exec(result.stderr ?? "")?.[1];
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

function compatibleNode(candidate: string, directory: string, cwd: string, env: NodeJS.ProcessEnv, supports: (version: string) => boolean) {
  // Version-manager shims can select the tool by the invoked filename.
  const selected = probeNode(candidate, directory, env);
  if (!selected || !supports(selected.version)) return;
  if (directory === cwd && candidate === selected.path) return selected;
  // npm uses the same executable from its isolated cwd without the shim.
  const verified = probeNode(selected.path, cwd, env);
  if (verified?.path === selected.path && verified.version === selected.version) return verified;
}

function pathVariable(env: NodeJS.ProcessEnv): string {
  return windows ? Object.keys(env).find(key => key.toLowerCase() === "path") ?? "PATH" : "PATH";
}

/** The npm package shipped beside the Node that launched this process, not a file named npm in its bin folder. */
function bundledNpm(): { entry: string; range: string } | undefined {
  if (windows) return;
  let root: string;
  try { root = dirname(dirname(isAbsolute(process.execPath) ? process.execPath : realpathSync(process.execPath))); } catch { return; }
  if (root.includes(delimiter)) return;
  const candidate = join(root, "lib", "node_modules", "npm", "bin", "npm-cli.js");
  const engine = npmEngine(candidate);
  return engine && !engine.corepack && satisfies(process.version, engine.range) ? { entry: candidate, range: engine.range } : undefined;
}

export function npmUpdateChildEnvironment(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  if (!npmProjectDirectory.getStore() && env[UPDATE_NPM_NODE] === undefined) return env;
  const { node } = npmInvocation(env, []);
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

interface NpmCommand {
  file: string;
  args: string[];
  env: NodeJS.ProcessEnv;
  cwd: string;
  node?: string;
  lifecycleNode?: boolean;
}

export function npmInvocation(env: NodeJS.ProcessEnv, args: string[]): NpmCommand {
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
  const engine = file ? npmEngine(file) : undefined;
  const withNode = (node: string, preserveLiteral = literal !== undefined) => preserveLiteral && dirname(node).includes(delimiter) ? env
    : { ...env, [pathKey]: `${dirname(node)}${delimiter}${path}` };
  const currentSupportsEngine = !!engine && satisfies(process.version, engine.range);
  let npmRange = engine?.corepack && currentSupportsEngine
    ? corepackNpmRange(process.execPath, engine.entry, cwd, withNode(process.execPath, true)) : undefined;
  const unusable = !engine || !currentSupportsEngine || (!!npmRange && !satisfies(process.version, npmRange));
  if (engine && unusable) {
    const supports = (version: string) => satisfies(version, engine.range) && (!npmRange || satisfies(version, npmRange));
    let fallback: NpmCommand | undefined;
    const invocation = (file: string, version: string, node?: string) => {
      const npm = { file, args: [engine.entry, ...args], env: withNode(file, node ? true : undefined), cwd, node };
      if (engine.corepack && !npmRange) npmRange = corepackNpmRange(file, engine.entry, cwd, npm.env);
      if (!npmRange || satisfies(version, npmRange)) return npm;
      // npm may still complete an operation on a Node outside its declared range.
      if (!currentSupportsEngine) fallback ??= npm;
    };
    const current = realpathSync(process.execPath);
    const probeEnv = { ...env };
    delete probeEnv.NODE_OPTIONS;
    const project = npmProjectDirectory.getStore();
    // A POSIX directory with a colon travels in the absolute hint, not PATH.
    const inheritedBin = inheritedNode ? dirname(inheritedNode) : "";
    if (inheritedNode && isAbsolute(inheritedNode) &&
        (directories.includes(inheritedBin) || (!windows && inheritedBin.includes(delimiter))) &&
        resolveOnPath(inheritedNode, env) === inheritedNode) {
      const node = compatibleNode(inheritedNode, cwd, cwd, probeEnv, supports);
      if (node?.path === inheritedNode) {
        const npm = invocation(node.path, node.version, node.path);
        if (npm) return npm;
      }
    }
    const seen = new Set<string>();
    const candidates: string[] = [];
    for (const candidate of [recordedNode(), ...[dirname(file!), ...directories].map(dir => inDirectory(dir, "node"))]) {
      if (!candidate || seen.has(candidate)) continue;
      seen.add(candidate);
      try { if (realpathSync(candidate) === current) continue; } catch { continue; }
      candidates.push(candidate);
      const node = project === undefined ? undefined : compatibleNode(candidate, project, cwd, probeEnv, supports);
      if (node) {
        const npm = invocation(node.path, node.version, node.path);
        if (npm) return npm;
      }
    }
    for (const candidate of candidates) {
      // Keep the shim's invocation name and environment for npm if isolated version lookup succeeds.
      const version = spawnSync(candidate, ["--version"], { cwd, env: probeEnv, encoding: "utf8", timeout: 1000, killSignal: "SIGKILL", windowsHide: true });
      if (version.status === 0 && supports(version.stdout.trim())) {
        const npm = invocation(candidate, version.stdout.trim());
        if (npm) return npm;
      }
    }
    if (fallback) return fallback;
  }
  const pathNpmMissing = !file;
  const pathNpmReportsUnsupported = !!npmRange && !satisfies(process.version, npmRange);
  // A file named npm whose engine cannot be read is still the npm on PATH. Only a missing
  // file, or npm's own unsupported-Node report, selects the package shipped with this Node.
  if (!windows && (pathNpmMissing || pathNpmReportsUnsupported)) {
    const bundled = bundledNpm();
    if (bundled && !bundledNoticePrinted) {
      bundledNoticePrinted = true;
      const why = pathNpmReportsUnsupported ? `the npm on PATH does not support Node ${process.version}` : "npm is not on PATH";
      process.stderr.write(`Using the npm shipped with ${process.version} because ${why}.\n`);
    }
    if (bundled) {
      return { file: process.execPath, args: [bundled.entry, ...args], env, cwd,
        lifecycleNode: args[0] === "install" && !args.includes("--ignore-scripts") };
    }
  }
  if (!file) return { file: "npm", args, env, cwd };
  if (windows) return { file: "npm", args, env, cwd };
  const node = resolveOnPath("node", lookup);
  if (node && realpathSync(node) === realpathSync(process.execPath))
    return { file: literal ? file : "npm", args, env, cwd };
  const bin = dirname(process.execPath);
  // Prepending the runtime directory cannot satisfy npm's shebang without a `node` entry.
  if (!node && engine && (bin.includes(delimiter) || !inDirectory(bin, "node")))
    return { file: process.execPath, args: [engine.entry, ...args], env: withNode(process.execPath, true), cwd,
      lifecycleNode: args[0] === "install" && !args.includes("--ignore-scripts") };
  return { file, args, env: withNode(process.execPath), cwd };
}

/** Give lifecycle shells a `node` command when npm itself is launched by absolute Node path. */
export function npmLifecycleEnvironment(npm: ReturnType<typeof npmInvocation>, parent: string) {
  if (!npm.lifecycleNode) return;
  for (const base of new Set([parent, "/tmp"])) {
    let directory: string | undefined;
    try {
      const physical = realpathSync(base);
      if (physical.includes(delimiter)) continue;
      const scratch = directory = mkdtempSync(join(physical, "cotal-npm-node-"));
      protectedLocalDirectory(scratch);
      symlinkSync(npm.file, join(scratch, "node"));
      return {
        env: { ...npm.env, PATH: `${scratch}${delimiter}${npm.env.PATH}` },
        dispose: () => rmSync(scratch, { recursive: true, force: true, maxRetries: 3 }),
      };
    } catch {
      if (directory) rmSync(directory, { recursive: true, force: true, maxRetries: 3 });
    }
  }
  // Installs that do not invoke `node` can still complete; npm reports any script failure.
}
