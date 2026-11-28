import { AsyncLocalStorage } from "node:async_hooks";
import { spawnSync } from "node:child_process";
import { existsSync, lstatSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { basename, delimiter, dirname, isAbsolute, join, parse, resolve } from "node:path";
import { logicalExecutionEntry, protectedLocalDirectory, resolveOnPath } from "@cotal-ai/workspace";

const { satisfies } = createRequire(import.meta.url)("semver") as { satisfies: (version: string, range: string) => boolean };
export const npmProjectDirectory = new AsyncLocalStorage<string | undefined>();
const UPDATE_NPM = "COTAL_UPDATE_NPM";
const UPDATE_NPM_NODE = "COTAL_UPDATE_NPM_NODE";
const windows = process.platform === "win32";

type AsdfCacheEntry = { kind: "resolved"; file: string } | { kind: "timeout" } | { kind: "none" };
let updatePath: { value: string; directories: string[] } | undefined;
const asdfNpmCache = new Map<string, AsdfCacheEntry>();
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

function callerDirectory(cwd: string): string | undefined {
  const store = npmProjectDirectory.getStore();
  if (store !== undefined) return store;
  try {
    const current = process.cwd();
    return current === cwd ? undefined : current;
  } catch { return undefined; }
}

function validInherited(candidate: string | undefined, directories: string[], env: NodeJS.ProcessEnv): string | undefined {
  if (!candidate || !isAbsolute(candidate)) return;
  const bin = dirname(candidate);
  if ((directories.includes(bin) || (!windows && bin.includes(delimiter))) &&
      resolveOnPath(candidate, env) === candidate) return candidate;
}

function stripShellComment(line: string): string {
  let quote: string | undefined;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]!;
    if (quote) {
      if (ch === quote && (quote === "'" || line[i - 1] !== "\\")) quote = undefined;
    } else if (ch === "'" || ch === '"') {
      quote = ch;
    } else if (ch === "#" && (i === 0 || line[i - 1] === " " || line[i - 1] === "\t")) {
      return line.slice(0, i);
    }
  }
  return line;
}

function parseAsdfExecLine(line: string): string | undefined {
  if (line.endsWith("\r")) line = line.slice(0, -1);
  if (line.length > 512 || (!line.startsWith("exec ") && !line.startsWith("exec\t"))) return;
  const body = stripShellComment(line).trimEnd();
  const split = Math.max(body.lastIndexOf(" exec "), body.lastIndexOf("\texec "), body.lastIndexOf(" exec\t"), body.lastIndexOf("\texec\t"));
  if (split < 4) return;
  const raw = body.slice(4, split).trim();
  const rest = body.slice(split + 5).trimStart();
  if (!raw || !/^(?:"npm"|'npm'|npm)[ \t]+(?:"\$@"|\$@)$/.test(rest)) return;
  return (raw.startsWith('"') && raw.endsWith('"')) || (raw.startsWith("'") && raw.endsWith("'"))
    ? raw.slice(1, -1) : raw;
}

function asdfShimExecutable(file: string, env: NodeJS.ProcessEnv): string | undefined {
  try {
    const entry = realpathSync(file);
    const info = lstatSync(entry);
    if (!info.isFile() || info.size > 4096) return;
    const lines = readFileSync(entry, "utf8").split("\n");
    if (!lines.some(line => line.startsWith("# asdf-plugin:"))) return;
    for (const line of lines) {
      let candidate = parseAsdfExecLine(line);
      if (!candidate) continue;
      if (/^\$\{?ASDF_DIR\}?\/bin\/asdf$/.test(candidate)) {
        if (!env.ASDF_DIR || !isAbsolute(env.ASDF_DIR)) return;
        candidate = join(env.ASDF_DIR, "bin", "asdf");
      }
      if (candidate === "asdf" || (isAbsolute(candidate) && basename(candidate) === "asdf")) return candidate;
    }
  } catch { return undefined; }
}

function resolveAsdfNpm(
  asdfCommand: string,
  findOnPath: (bin: string) => string | undefined,
  directory: string | undefined,
  cwd: string,
  probeEnv: NodeJS.ProcessEnv,
  env: NodeJS.ProcessEnv,
): { resolved?: string; timedOut?: boolean } {
  const asdf = asdfCommand === "asdf"
    ? findOnPath("asdf")
    : resolveOnPath(asdfCommand, env) === asdfCommand ? asdfCommand : undefined;
  if (!asdf) return {};
  const timedOut = (res: ReturnType<typeof spawnSync>) =>
    (res.error as NodeJS.ErrnoException | undefined)?.code === "ETIMEDOUT";
  const runAsdf = (args: string[]) => {
    const first = spawnSync(asdf, args, {
      cwd: directory ?? cwd, env: probeEnv, encoding: "utf8", timeout: 2000, killSignal: "SIGKILL", windowsHide: true,
    });
    if (directory && directory !== cwd && (first.error as NodeJS.ErrnoException | undefined)?.code === "ENOENT") {
      return spawnSync(asdf, args, {
        cwd, env: probeEnv, encoding: "utf8", timeout: 2000, killSignal: "SIGKILL", windowsHide: true,
      });
    }
    return first;
  };
  const result = runAsdf(["which", "npm"]);
  if (timedOut(result)) return { timedOut: true };
  if (result.status !== 0) return {};
  const line = result.stdout.trim();
  if (!line || line.includes("\n") || !isAbsolute(line)) return {};
  let resolved = resolve(line);
  // asdf-nodejs points `which npm` at its reshim wrapper, which still calls `asdf where` from cwd.
  if (!npmEngine(resolved) && basename(dirname(resolved)) === "shims" &&
      basename(dirname(dirname(dirname(resolved)))) === "plugins") {
    const where = runAsdf(["where", basename(dirname(dirname(resolved)))]);
    if (timedOut(where)) return { timedOut: true };
    const installed = where.status === 0 ? where.stdout.trim() : "";
    if (!installed || installed.includes("\n") || !isAbsolute(installed)) return {};
    resolved = join(resolve(installed), "bin", "npm");
  }
  return resolveOnPath(resolved, env) === resolved && npmEngine(resolved) ? { resolved } : {};
}

function selectAsdfNpm(
  shim: string,
  asdfCommand: string,
  inheritedNpm: string | undefined,
  directories: string[],
  findOnPath: (bin: string) => string | undefined,
  cwd: string,
  lookup: NodeJS.ProcessEnv,
  pathValue: string,
  env: NodeJS.ProcessEnv,
): { file: string; engine: NonNullable<ReturnType<typeof npmEngine>> } | undefined {
  const inherited = validInherited(inheritedNpm, directories, env);
  let resolved = inherited && npmEngine(inherited) ? inherited : undefined;
  if (!resolved) {
    const directory = callerDirectory(cwd);
    const cacheKey = `${shim}\0${directory ?? ""}\0${pathValue}`;
    const cached = asdfNpmCache.get(cacheKey);
    if (cached?.kind === "resolved") {
      resolved = resolveOnPath(cached.file, env) === cached.file ? cached.file : undefined;
    } else if (!cached || cached.kind === "timeout") {
      const probeEnv = { ...lookup };
      delete probeEnv.NODE_OPTIONS;
      const probe = resolveAsdfNpm(asdfCommand, findOnPath, directory, cwd, probeEnv, env);
      if (probe.resolved) {
        asdfNpmCache.set(cacheKey, { kind: "resolved", file: probe.resolved });
        resolved = probe.resolved;
      } else {
        asdfNpmCache.set(cacheKey, !cached && probe.timedOut ? { kind: "timeout" } : { kind: "none" });
      }
    }
  }
  if (!resolved) return;
  try {
    if (realpathSync(resolved) === realpathSync(shim)) return;
    const engine = npmEngine(resolved);
    return engine ? { file: resolved, engine } : undefined;
  } catch { return undefined; }
}

function desktopNpm(): string | undefined {
  const entry = logicalExecutionEntry();
  if (!entry) return;
  const root = dirname(dirname(entry));
  if (!existsSync(join(root, "desktop-runtime.json"))) return;
  try {
    const manifest = createRequire(entry).resolve("npm/package.json");
    // Only the app's own package qualifies, not an ancestor or NODE_PATH installation.
    if (manifest !== join(root, "node_modules", "npm", "package.json")) return;
    const candidate = join(dirname(manifest), "bin", "npm-cli.js");
    const engine = npmEngine(candidate);
    if (engine?.entry === candidate && satisfies(process.version, engine.range)) return candidate;
  } catch { /* The desktop runtime has no usable bundled npm. */ }
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
  if (!npmProjectDirectory.getStore() && env[UPDATE_NPM_NODE] === undefined && env[UPDATE_NPM] === undefined) return env;
  const { node, npm } = npmInvocation(env, []);
  if (!node && !npm) {
    if (env[UPDATE_NPM_NODE] === undefined && env[UPDATE_NPM] === undefined) return env;
    const next = { ...env };
    delete next[UPDATE_NPM_NODE];
    delete next[UPDATE_NPM];
    return next;
  }
  const pathKey = pathVariable(env);
  let path = env[pathKey]!;
  for (const selected of [node, npm]) {
    if (!selected) continue;
    const bin = dirname(selected);
    if (!bin.includes(delimiter) && !path.split(delimiter).includes(bin)) path = `${path}${delimiter}${bin}`;
  }
  // Older reconcile and rollback children can find Node on PATH without shadowing the selected npm.
  const next: NodeJS.ProcessEnv = { ...env, [pathKey]: path };
  if (node) next[UPDATE_NPM_NODE] = node;
  else delete next[UPDATE_NPM_NODE];
  if (npm) next[UPDATE_NPM] = npm;
  else delete next[UPDATE_NPM];
  return next;
}

interface NpmCommand {
  file: string;
  args: string[];
  env: NodeJS.ProcessEnv;
  cwd: string;
  node?: string;
  npm?: string;
  lifecycleNode?: boolean;
  missingOnPath?: true;
}

function bundledNpmInvocation(entry: string, env: NodeJS.ProcessEnv, args: string[], cwd: string): NpmCommand {
  const pathKey = pathVariable(env), path = env[pathKey] ?? "";
  // Windows ships as node.exe. The POSIX sidecar needs a temporary `node` name for lifecycle scripts.
  const childEnv = { ...env, [pathKey]: windows ? `${dirname(process.execPath)}${delimiter}${path}` : path };
  return { file: process.execPath, args: [entry, ...args], env: childEnv, cwd,
    lifecycleNode: !windows && args[0] === "install" && !args.includes("--ignore-scripts") };
}

export function npmInvocation(env: NodeJS.ProcessEnv, args: string[]): NpmCommand {
  const cwd = parse(homedir()).root;
  const pathKey = pathVariable(env);
  const inheritedNpm = env[UPDATE_NPM];
  const inheritedNode = env[UPDATE_NPM_NODE];
  if (inheritedNpm !== undefined || inheritedNode !== undefined) {
    env = { ...env };
    delete env[UPDATE_NPM];
    delete env[UPDATE_NPM_NODE];
  }
  const path = env[pathKey];
  if (path === undefined) {
    const entry = desktopNpm();
    return entry ? bundledNpmInvocation(entry, env, args, cwd) : { file: "npm", args, env, cwd };
  }
  const literal = updatePath?.value === path ? updatePath.directories : undefined;
  const directories = literal ?? path.split(delimiter).map(dir => resolve(cwd, dir));
  const lookup = literal ? env : { ...env, [pathKey]: directories.join(delimiter) };
  const inDirectory = (dir: string, bin: string) => literal
    ? resolveOnPath(join(dir, bin)) : resolveOnPath(bin, { ...env, [pathKey]: dir });
  const findOnPath = (bin: string) => {
    if (!literal) return resolveOnPath(bin, windows ? env : lookup);
    for (const dir of literal) {
      const found = inDirectory(dir, bin);
      if (found) return found;
    }
  };
  let file = findOnPath("npm");
  let engine = file ? npmEngine(file) : undefined;
  let selectedNpm: string | undefined;
  const project = npmProjectDirectory.getStore();
  const asdfCommand = file && !engine && !windows ? asdfShimExecutable(file, env) : undefined;
  if (file && asdfCommand) {
    const selected = selectAsdfNpm(file, asdfCommand, inheritedNpm, directories, findOnPath, cwd, lookup, lookup[pathKey] ?? "", env);
    if (selected) {
      selectedNpm = file = selected.file;
      engine = selected.engine;
    }
  }
  const withNode = (node: string, preserveLiteral = literal !== undefined) => preserveLiteral && dirname(node).includes(delimiter) ? env
    : { ...env, [pathKey]: `${dirname(node)}${delimiter}${path}` };
  const currentSupportsEngine = !!engine && satisfies(process.version, engine.range);
  let npmRange = engine?.corepack && currentSupportsEngine
    ? corepackNpmRange(process.execPath, engine.entry, cwd, withNode(process.execPath, true)) : undefined;
  if (file && engine && (!currentSupportsEngine || (npmRange && !satisfies(process.version, npmRange)))) {
    const engineEntry = engine.entry;
    const engineRange = engine.range;
    const engineCorepack = engine.corepack;
    const supports = (version: string) => satisfies(version, engineRange) && (!npmRange || satisfies(version, npmRange));
    let fallback: NpmCommand | undefined;
    const invocation = (file: string, version: string, node?: string) => {
      const npm: NpmCommand = { file, args: [engineEntry, ...args], env: withNode(file, node ? true : undefined), cwd, node, npm: selectedNpm };
      if (engineCorepack && !npmRange) npmRange = corepackNpmRange(file, engineEntry, cwd, npm.env);
      if (!npmRange || satisfies(version, npmRange)) return npm;
      // npm may still complete an operation on a Node outside its declared range.
      if (!currentSupportsEngine) fallback ??= npm;
    };
    const current = realpathSync(process.execPath);
    const probeEnv = { ...env };
    delete probeEnv.NODE_OPTIONS;
    // A POSIX directory with a colon travels in the absolute hint, not PATH.
    const verifiedInheritedNode = validInherited(inheritedNode, directories, env);
    if (verifiedInheritedNode) {
      const node = compatibleNode(verifiedInheritedNode, cwd, cwd, probeEnv, supports);
      if (node?.path === verifiedInheritedNode) {
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
  if (pathNpmMissing || pathNpmReportsUnsupported) {
    const entry = desktopNpm();
    if (entry) return bundledNpmInvocation(entry, env, args, cwd);
  }
  // A file named npm whose engine cannot be read is still the npm on PATH. Only a missing
  // file, or npm's own unsupported-Node report, selects the package shipped with this Node.
  if (!windows && (pathNpmMissing || pathNpmReportsUnsupported)) {
    const bundled = bundledNpm();
    if (bundled && !bundledNoticePrinted) {
      bundledNoticePrinted = true;
      const why = pathNpmReportsUnsupported ? `the npm on PATH does not support Node ${process.version}` : "npm is not on PATH";
      process.stderr.write(`Using the npm shipped with ${process.version} because ${why}.\n`);
    }
    if (bundled) return bundledNpmInvocation(bundled.entry, env, args, cwd);
  }
  if (!file) return { file: "npm", args, env, cwd, missingOnPath: true };
  if (windows) return { file: "npm", args, env, cwd };
  const node = resolveOnPath("node", lookup);
  if (node && realpathSync(node) === realpathSync(process.execPath))
    return { file: literal || selectedNpm ? file : "npm", args, env, cwd, npm: selectedNpm };
  const bin = dirname(process.execPath);
  // Prepending the runtime directory cannot satisfy npm's shebang without a `node` entry.
  if ((!node || selectedNpm) && engine && (bin.includes(delimiter) || !inDirectory(bin, "node")))
    return { file: process.execPath, args: [engine.entry, ...args], env: withNode(process.execPath, true), cwd, npm: selectedNpm,
      lifecycleNode: args[0] === "install" && !args.includes("--ignore-scripts") };
  return { file, args, env: withNode(process.execPath), cwd, npm: selectedNpm };
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
