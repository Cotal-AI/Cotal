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

const NPM_NODE_WARNING = /^(?:npm warn cli npm v\S+ does not support|ERROR: npm v\S+ is known not to run on) Node\.js \S+\. +This version of npm supports the following node versions: `([^`\r\n]+)`/m;

function corepackNpmRange(node: string, entry: string, cwd: string, env: NodeJS.ProcessEnv): string | undefined {
  const result = spawnSync(node, [entry, "--version", "--loglevel=warn", "--color=false"], {
    cwd, env, encoding: "utf8", timeout: 2000, killSignal: "SIGKILL", windowsHide: true,
  });
  // npm can print its version and exit successfully even on an unsupported Node.
  return NPM_NODE_WARNING.exec(result.stderr ?? "")?.[1];
}

function workingDirectory(): string | undefined {
  try { return process.cwd(); } catch { return undefined; }
}

function projectCorepackDirectory(start: string | undefined): string | undefined {
  if (!start) return;
  for (let dir = resolve(start); ;) {
    try {
      const manifest = JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as {
        packageManager?: unknown;
        devEngines?: { packageManager?: unknown };
      };
      if (manifest.packageManager !== undefined && manifest.packageManager !== null)
        return typeof manifest.packageManager === "string" && manifest.packageManager.startsWith("npm@") ? dir : undefined;
      const dev = manifest.devEngines?.packageManager;
      if (dev !== undefined && dev !== null) {
        const entries = Array.isArray(dev) ? dev : [dev];
        return entries.some(item => typeof item === "object" && item !== null && (item as { name?: unknown }).name === "npm") ? dir : undefined;
      }
    } catch { /* ancestor may have no readable package.json */ }
    const parent = dirname(dir);
    if (parent === dir) return;
    dir = parent;
  }
}

function corepackCacheRoots(projectDir: string, env: NodeJS.ProcessEnv): string[] {
  if (env.COREPACK_HOME) return [resolve(projectDir, env.COREPACK_HOME)];
  const home = homedir();
  return windows
    ? [join(env.LOCALAPPDATA || join(home, "AppData", "Local"), "node", "corepack")]
    : [
        ...(env.XDG_CACHE_HOME ? [join(env.XDG_CACHE_HOME, "node", "corepack")] : []),
        join(home, ".cache", "node", "corepack"),
        ...(process.platform === "darwin" ? [join(home, "Library", "Caches", "node", "corepack")] : []),
      ];
}

function projectCorepackNpm(
  node: string,
  nodeVersion: string,
  corepackEntry: string,
  projectDir: string,
  env: NodeJS.ProcessEnv,
): { entry: string; prefixArgs: string[]; npmDirectory?: string } | undefined {
  const probeEnv = { ...env, COREPACK_ENABLE_DOWNLOAD_PROMPT: env.COREPACK_ENABLE_DOWNLOAD_PROMPT ?? "0" };
  const result = spawnSync(node, [corepackEntry, "--version", "--loglevel=warn", "--color=false"], {
    cwd: projectDir, env: probeEnv, encoding: "utf8", timeout: 15_000, killSignal: "SIGKILL", windowsHide: true,
  });
  if (result.status !== 0) return;
  const range = NPM_NODE_WARNING.exec(result.stderr ?? "")?.[1];
  if (range && !satisfies(nodeVersion, range)) return;
  const version = result.stdout?.trim() ?? "";
  if (!/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)*$/.test(version)) return;
  for (const root of corepackCacheRoots(projectDir, probeEnv)) {
    for (const segments of [["v1", "npm", version], ["npm", version]]) {
      const cached = npmEngine(join(root, ...segments, "bin", "npm-cli.js"));
      if (cached && !cached.corepack && satisfies(nodeVersion, cached.range))
        return { entry: cached.entry, prefixArgs: [], npmDirectory: dirname(cached.entry) };
    }
  }
  const cli = join(dirname(corepackEntry), "corepack.js");
  try {
    if (lstatSync(cli).isFile()) return { entry: cli, prefixArgs: [`npm@${version}`] };
  } catch { /* Corepack CLI sibling is optional in synthetic fixtures */ }
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

export function npmUpdateChildEnvironment(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  if (!npmProjectDirectory.getStore() && env[UPDATE_NPM_NODE] === undefined) return env;
  const { node, npmDirectory } = npmInvocation(env, []);
  const pathKey = pathVariable(env);
  const path = env[pathKey];
  const npmBin = npmDirectory && !npmDirectory.includes(delimiter) ? npmDirectory : undefined;
  if (!node && !npmBin) {
    if (env[UPDATE_NPM_NODE] === undefined) return env;
    const next = { ...env };
    delete next[UPDATE_NPM_NODE];
    return next;
  }
  let nextPath = path ?? "";
  if (npmBin && nextPath.split(delimiter)[0] !== npmBin)
    nextPath = nextPath ? `${npmBin}${delimiter}${nextPath}` : npmBin;
  if (!node) {
    const next = { ...env, [pathKey]: nextPath };
    delete next[UPDATE_NPM_NODE];
    return next;
  }
  const bin = dirname(node);
  if (!bin.includes(delimiter) && !nextPath.split(delimiter).includes(bin))
    nextPath = nextPath ? `${nextPath}${delimiter}${bin}` : bin;
  // Older reconcile and rollback children can find Node on PATH without shadowing the selected npm.
  return { ...env, [UPDATE_NPM_NODE]: node, [pathKey]: nextPath };
}

interface NpmCommand {
  file: string;
  args: string[];
  env: NodeJS.ProcessEnv;
  cwd: string;
  node?: string;
  npmDirectory?: string;
  lifecycleNode?: boolean;
}

function directNpmOnCurrentNode(
  entry: string,
  prefixArgs: string[],
  args: string[],
  env: NodeJS.ProcessEnv,
  lookup: NodeJS.ProcessEnv,
  inDirectory: (dir: string, bin: string) => string | undefined,
  withNode: (node: string, preserveLiteral?: boolean) => NodeJS.ProcessEnv,
  cwd: string,
  npmDirectory?: string,
): NpmCommand {
  const node = resolveOnPath("node", lookup);
  const sameNode = !!node && realpathSync(node) === realpathSync(process.execPath);
  const bin = dirname(process.execPath);
  const missingNode = !node && (bin.includes(delimiter) || !inDirectory(bin, "node"));
  return {
    file: process.execPath,
    args: [entry, ...prefixArgs, ...args],
    env: sameNode ? env : withNode(process.execPath, missingNode ? true : undefined),
    cwd,
    npmDirectory,
    lifecycleNode: missingNode && args[0] === "install" && !args.includes("--ignore-scripts"),
  };
}

interface CorepackFallbackContext {
  primaryFile: string;
  corepack: { entry: string; range: string };
  currentSupportsEngine: boolean;
  project: string | undefined;
  directories: string[];
  inDirectory: (dir: string, bin: string) => string | undefined;
  lookup: NodeJS.ProcessEnv;
  probeEnv: NodeJS.ProcessEnv;
  withNode: (node: string, preserveLiteral?: boolean) => NodeJS.ProcessEnv;
  inheritedNode: string | undefined;
  candidates: string[];
  args: string[];
  env: NodeJS.ProcessEnv;
  cwd: string;
}

function alternativeNodes(
  ctx: CorepackFallbackContext,
  supports: (version: string) => boolean,
): Array<{ file: string; version: string; node?: string }> {
  const found: Array<{ file: string; version: string; node?: string }> = [];
  if (ctx.inheritedNode) {
    const node = compatibleNode(ctx.inheritedNode, ctx.cwd, ctx.cwd, ctx.probeEnv, supports);
    if (node?.path === ctx.inheritedNode) found.push({ file: node.path, version: node.version, node: node.path });
  }
  for (const candidate of ctx.candidates) {
    const fromProject = ctx.project === undefined ? undefined : compatibleNode(candidate, ctx.project, ctx.cwd, ctx.probeEnv, supports);
    if (fromProject) { found.push({ file: fromProject.path, version: fromProject.version, node: fromProject.path }); continue; }
    const version = spawnSync(candidate, ["--version"], { cwd: ctx.cwd, env: ctx.probeEnv, encoding: "utf8", timeout: 1000, killSignal: "SIGKILL", windowsHide: true });
    if (version.status === 0 && supports(version.stdout.trim())) found.push({ file: candidate, version: version.stdout.trim() });
  }
  return found;
}

function corepackNpmFallback(ctx: CorepackFallbackContext): NpmCommand | undefined {
  const projectDir = projectCorepackDirectory(ctx.project ?? workingDirectory());
  if (projectDir) {
    if (ctx.currentSupportsEngine) {
      const probe = { ...ctx.withNode(process.execPath, true) };
      delete probe.NODE_OPTIONS;
      const selected = projectCorepackNpm(process.execPath, process.version, ctx.corepack.entry, projectDir, probe);
      if (selected)
        return directNpmOnCurrentNode(selected.entry, selected.prefixArgs, ctx.args, ctx.env, ctx.lookup, ctx.inDirectory, ctx.withNode, ctx.cwd, selected.npmDirectory);
    }
    for (const item of alternativeNodes(ctx, v => satisfies(v, ctx.corepack.range))) {
      const nextEnv = ctx.withNode(item.file, item.node ? true : undefined);
      const probe = { ...nextEnv };
      delete probe.NODE_OPTIONS;
      const selected = projectCorepackNpm(item.file, item.version, ctx.corepack.entry, projectDir, probe);
      if (selected)
        return { file: item.file, args: [selected.entry, ...selected.prefixArgs, ...ctx.args], env: nextEnv, cwd: ctx.cwd, node: item.node, npmDirectory: selected.npmDirectory };
    }
  }
  const seenNpm = new Set<string>();
  try { seenNpm.add(realpathSync(ctx.primaryFile)); } catch { /* ignore unreadable link */ }
  for (const dir of ctx.directories) {
    const alt = ctx.inDirectory(dir, "npm");
    if (!alt) continue;
    let resolvedAlt: string;
    try { resolvedAlt = realpathSync(alt); } catch { continue; }
    if (seenNpm.has(resolvedAlt)) continue;
    seenNpm.add(resolvedAlt);
    const altEngine = npmEngine(alt);
    if (!altEngine) continue;
    const okWith = (nodeBin: string, nodeVer: string, checkEnv: NodeJS.ProcessEnv) => {
      if (!satisfies(nodeVer, altEngine.range)) return false;
      if (!altEngine.corepack) return true;
      const probe = { ...checkEnv };
      delete probe.NODE_OPTIONS;
      const range = corepackNpmRange(nodeBin, altEngine.entry, ctx.cwd, probe);
      return !range || satisfies(nodeVer, range);
    };
    if (okWith(process.execPath, process.version, ctx.withNode(process.execPath, true)))
      return directNpmOnCurrentNode(altEngine.entry, [], ctx.args, ctx.env, ctx.lookup, ctx.inDirectory, ctx.withNode, ctx.cwd);
    for (const item of alternativeNodes(ctx, v => satisfies(v, altEngine.range))) {
      const nextEnv = ctx.withNode(item.file, item.node ? true : undefined);
      if (okWith(item.file, item.version, nextEnv))
        return { file: item.file, args: [altEngine.entry, ...ctx.args], env: nextEnv, cwd: ctx.cwd, node: item.node };
    }
  }
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
  if (!file) return { file: "npm", args, env, cwd };
  const engine = npmEngine(file);
  const withNode = (node: string, preserveLiteral = literal !== undefined) => preserveLiteral && dirname(node).includes(delimiter) ? env
    : { ...env, [pathKey]: `${dirname(node)}${delimiter}${path}` };
  const currentSupportsEngine = !!engine && satisfies(process.version, engine.range);
  let npmRange = engine?.corepack && currentSupportsEngine
    ? corepackNpmRange(process.execPath, engine.entry, cwd, withNode(process.execPath, true)) : undefined;
  if (engine && (!currentSupportsEngine || (npmRange && !satisfies(process.version, npmRange)))) {
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
    const validInherited = inheritedNode && isAbsolute(inheritedNode) &&
        (directories.includes(inheritedBin) || (!windows && inheritedBin.includes(delimiter))) &&
        resolveOnPath(inheritedNode, env) === inheritedNode ? inheritedNode : undefined;
    if (validInherited) {
      const node = compatibleNode(validInherited, cwd, cwd, probeEnv, supports);
      if (node?.path === validInherited) {
        const npm = invocation(node.path, node.version, node.path);
        if (npm) return npm;
      }
    }
    const seen = new Set<string>();
    const candidates: string[] = [];
    for (const candidate of [recordedNode(), ...[dirname(file), ...directories].map(dir => inDirectory(dir, "node"))]) {
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
    if (engine.corepack) {
      const alternateNpm = corepackNpmFallback({
        primaryFile: file, corepack: engine, currentSupportsEngine, project, directories, inDirectory,
        lookup, probeEnv, withNode, inheritedNode: validInherited, candidates, args, env, cwd,
      });
      if (alternateNpm) return alternateNpm;
    }
    if (fallback) return fallback;
  }
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
