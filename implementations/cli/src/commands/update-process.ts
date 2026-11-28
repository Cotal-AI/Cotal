import { AsyncLocalStorage } from "node:async_hooks";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, unlinkSync, watch, writeFileSync, type FSWatcher } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, parse, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { cmdSpawnSpec, beginGlobalUpdateChild, processGroupMembers, processStartToken } from "@cotal-ai/workspace";
import { withInstallUmask } from "../lib/install-umask.js";
import { npmInvocation, npmLifecycleEnvironment, npmUpdateChildEnvironment } from "../lib/npm-invocation.js";
import { compareSemver } from "../seed/reconcile.js";

export interface CommandResult {
  readonly status: number | null;
  readonly signal?: NodeJS.Signals | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly error?: string;
  readonly errorCode?: string;
}

export class RegistryUnavailable extends Error {}
export class StagingTimeout extends Error {
  constructor(readonly npmOutput: string) { super("Package staging reached its time limit"); }
}

export function parseNpmVersion(output: string): string {
  const parsed: unknown = JSON.parse(output.trim());
  // `npm view cotal-ai@latest version --json` returns a bare string ("0.13.2") only while the
  // registry holds a single published version; once more than one exists npm wraps the field query
  // in a JSON array (["0.13.2"]) even for the @latest tag. Accept both, and take the highest valid
  // semver — the @latest query resolves the array to a single element, and the max is the right
  // answer whether npm hands back one element or the whole version list.
  const candidates = typeof parsed === "string" ? [parsed] : Array.isArray(parsed) ? parsed : [];
  const versions = candidates.filter((v): v is string => typeof v === "string" && STRICT_SEMVER.test(v));
  if (versions.length === 0)
    throw new Error(`npm returned an invalid cotal-ai version: ${JSON.stringify(parsed)}`);
  return versions.reduce((max, v) => (compareSemver(v, max) > 0 ? v : max));
}

const PRE = "(?:0|[1-9]\\d*|[0-9A-Za-z-]*[A-Za-z-][0-9A-Za-z-]*)";
const BUILD = "[0-9A-Za-z-]+";
export const STRICT_SEMVER = new RegExp(
  `^(0|[1-9]\\d*)\\.(0|[1-9]\\d*)\\.(0|[1-9]\\d*)(?:-${PRE}(?:\\.${PRE})*)?(?:\\+${BUILD}(?:\\.${BUILD})*)?$`,
);

/** Bind an npm global installation to its invoked package before replacing it.
 * Local/npx copies and source checkouts retain npm's separate global destination. On Windows an
 * adjacent npm shim must name the entry; on POSIX the bin link must resolve to it. */
export function installedUpdatePrefix(packageRoot: string, entry: string): string | undefined {
  const root = realpathSync(packageRoot);
  const modules = dirname(root);
  if (process.platform === "win32") {
    if (basename(modules).toLowerCase() !== "node_modules" || basename(root).toLowerCase() !== "cotal-ai") return;
    const prefix = dirname(modules);
    const shim = join(prefix, "cotal.cmd");
    if (!existsSync(shim) || existsSync(join(prefix, "package.json"))) return;
    const launcher = readFileSync(shim, "utf8");
    const linked = /"%dp0%[\\/]([^"\r\n]+)"[ \t]+%\*[ \t]*\r?$/im.exec(launcher)?.[1];
    if (!linked || !existsSync(join(prefix, linked)) || realpathSync(join(prefix, linked)) !== realpathSync(entry)) return;
    const version = (JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { version: string }).version;
    return verifyGlobalEntry(modules, version) === realpathSync(entry) ? prefix : undefined;
  }
  if (basename(modules) !== "node_modules" || basename(dirname(modules)) !== "lib")
    return undefined;
  const prefix = dirname(dirname(modules));
  const meta = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { version?: string };
  const linked = realpathSync(join(prefix, "bin", "cotal"));
  if (basename(root) !== "cotal-ai" || !meta.version ||
      verifyGlobalEntry(modules, meta.version) !== realpathSync(entry) ||
      (linked !== realpathSync(entry) && linked !== join(root, "dist", "cotal-npm")))
    throw new Error("the invoked cotal package and its global bin link do not identify the same install");
  return prefix;
}

export function verifyGlobalEntry(root: string, expectedVersion: string): string {
  const packageDir = realpathSync(join(resolve(root), "cotal-ai"));
  const meta = JSON.parse(readFileSync(join(packageDir, "package.json"), "utf8")) as {
    name?: string;
    version?: string;
    bin?: string | Record<string, string>;
  };
  if (meta.name !== "cotal-ai" || meta.version !== expectedVersion)
    throw new Error(`expected cotal-ai@${expectedVersion}, found ${meta.name ?? "unnamed"}@${meta.version ?? "unknown"}`);
  const declared = typeof meta.bin === "string" ? meta.bin : meta.bin?.cotal;
  if (!declared) throw new Error("the installed package declares no cotal executable");
  const entry = realpathSync(resolve(packageDir, declared));
  const rel = relative(packageDir, entry);
  if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel))
    throw new Error(`the installed cotal executable escapes its package: ${entry}`);
  return entry;
}

const SHELL_IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;
const npmChildPermitGate = 'IFS= read -r permit <&3 && [ "$permit" = run ] || exit 1; exec 3<&-; exec "$@"';
const shellPreservesCache = new Map<string, boolean>();
const pinnedPosixGate = new AsyncLocalStorage<{ dir: string; path?: string }>();

function hasNonIdentifierEnv(env: NodeJS.ProcessEnv): boolean {
  for (const [key, value] of Object.entries(env)) {
    if (value !== undefined && key && !key.includes("=") && !SHELL_IDENTIFIER.test(key)) return true;
  }
  return false;
}

function shellPreservesNonIdentifiers(shell: string): boolean {
  let key = shell;
  try { key = `${shell}\0${realpathSync(shell)}`; } catch { /* keep literal shell path */ }
  const cached = shellPreservesCache.get(key);
  if (cached !== undefined) return cached;
  const probeKey = "cotal_gate_probe:1";
  const probe = spawnSync(
    shell,
    ["-c", 'exec "$@"', "cotal-gate-probe", process.execPath, "-e", `process.stdout.write(process.env[${JSON.stringify(probeKey)}] === "1" ? "1" : "0")`],
    { env: { [probeKey]: "1" }, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 5000, killSignal: "SIGKILL", windowsHide: true },
  );
  const preserves = !probe.error && probe.signal === null && probe.stdout === "1";
  shellPreservesCache.set(key, preserves);
  return preserves;
}

export async function withPosixGateScratch<T>(scratchDir: string | undefined, run: () => Promise<T>): Promise<T> {
  if (pinnedPosixGate.getStore()) return run();
  const ownDir = scratchDir === undefined ? mkdtempSync(join(tmpdir(), "cotal-update-")) : undefined;
  const store: { dir: string; path?: string } = { dir: realpathSync(scratchDir ?? ownDir!) };
  try {
    return await pinnedPosixGate.run(store, run);
  } finally {
    if (store.path) {
      try { unlinkSync(store.path); } catch { /* already removed */ }
    }
    if (ownDir) rmSync(ownDir, { recursive: true, force: true, maxRetries: 3 });
  }
}

export function pinPosixGateIfNeeded(env: NodeJS.ProcessEnv, shell = "/bin/sh"): void {
  if (process.platform === "win32") return;
  if (hasNonIdentifierEnv(env) && !shellPreservesNonIdentifiers(shell)) posixGateScriptPath();
}

export function posixGateScriptPath(): string {
  const store = pinnedPosixGate.getStore();
  if (store?.path) return store.path;
  const path = fileURLToPath(new URL(import.meta.url.endsWith(".ts") ? "./update-posix-gate.ts" : "./update-posix-gate.js", import.meta.url));
  if (!existsSync(path)) {
    throw new Error(`missing POSIX update gate helper (${path}); reinstall with \`npm install -g cotal-ai@latest\` or run \`pnpm --filter @cotal-ai/cli build\` in a source checkout`);
  }
  if (!store) return path;
  const copy = join(store.dir, path.endsWith(".ts") ? "update-posix-gate.mts" : "update-posix-gate.mjs");
  writeFileSync(copy, readFileSync(path), { mode: 0o600, flag: "wx" });
  store.path = copy;
  return copy;
}

function encodeGateEnv(entries: readonly (readonly [string, string])[]): Buffer {
  const parts: Buffer[] = [];
  const header = Buffer.allocUnsafe(4);
  header.writeUInt32BE(entries.length, 0);
  parts.push(header);
  for (const [key, value] of entries) {
    const keyBytes = Buffer.from(key, "utf8");
    const valueBytes = Buffer.from(value, "utf8");
    const lengths = Buffer.allocUnsafe(8);
    lengths.writeUInt32BE(keyBytes.length, 0);
    lengths.writeUInt32BE(valueBytes.length, 4);
    parts.push(lengths, keyBytes, valueBytes);
  }
  const trailer = Buffer.allocUnsafe(4);
  trailer.writeUInt32BE(0xffffffff, 0);
  parts.push(trailer);
  return Buffer.concat(parts);
}

// The pipe closes without permission if the parent dies before publishing the PID.
// When the gate shell drops non-identifier names, pass them over inherited descriptor 4:
// in-process via --import for our own Node children so parent/published PIDs never change,
// or through the adjacent gate stage for external commands such as npm.
export function npmChildGate(
  label: string,
  file: string,
  args: string[],
  env: NodeJS.ProcessEnv,
  shell = "/bin/sh",
  operation: "npm" | "reconcile" = "npm",
): {
  file: string;
  args: string[];
  env: NodeJS.ProcessEnv;
  envPayload?: Buffer;
  groupCleanup?: boolean;
} {
  const extra: [string, string][] = [];
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined || !key || key.includes("=")) continue;
    if (!SHELL_IDENTIFIER.test(key)) extra.push([key, value]);
  }
  if (extra.length === 0 || shellPreservesNonIdentifiers(shell))
    return { file: shell, args: ["-c", npmChildPermitGate, label, file, ...args], env };
  const gateScript = posixGateScriptPath();
  const inProcessPreload = operation === "reconcile" && file === process.execPath;
  const gateEnv: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined || !SHELL_IDENTIFIER.test(key)) continue;
    if (!inProcessPreload && key === "NODE_OPTIONS") continue;
    gateEnv[key] = value;
  }
  if (!inProcessPreload && env.NODE_OPTIONS !== undefined) extra.push(["NODE_OPTIONS", env.NODE_OPTIONS]);
  const envPayload = encodeGateEnv(extra);
  if (inProcessPreload) {
    const preloadUrl = pathToFileURL(gateScript);
    preloadUrl.searchParams.set("label", label);
    return {
      file: shell,
      args: ["-c", npmChildPermitGate, label, file, "--import", preloadUrl.href, ...args],
      env: gateEnv,
      envPayload,
    };
  }
  return {
    file: shell,
    args: ["-c", npmChildPermitGate, label, process.execPath, gateScript, label, file, ...args],
    env: gateEnv,
    envPayload,
    groupCleanup: true,
  };
}

export function releaseChildGate(
  child: import("node:child_process").ChildProcess,
  permitted: boolean,
  envPayload: Buffer | undefined,
  onPermitError: (cause: Error) => void,
  groupCleanup = false,
  startTokenOf: (pid: number) => string | undefined = processStartToken,
): void {
  const permit = child.stdio[3] as import("node:stream").Writable;
  const envPipe = envPayload ? child.stdio[4] as import("node:stream").Writable : undefined;
  permit.on("error", onPermitError);
  envPipe?.on("error", () => {});
  if (permitted && groupCleanup && child.pid !== undefined && child.pid > 1) {
    const pgid = child.pid;
    const leaderStart = startTokenOf(pgid);
    if (leaderStart !== undefined) {
      child.once("exit", (_code, sig) => {
        if (sig === null) return;
        try {
          // Once the leader is reaped, a recycled PID could lead a new group only after all our
          // members exited; verify no new leader holds pgid and our group still has live members.
          const currentStart = startTokenOf(pgid);
          if (currentStart !== undefined && currentStart !== leaderStart) return;
          if (processGroupMembers(pgid).length === 0) return;
          const groupSig = sig === "SIGPIPE" || sig === "SIGXFSZ" || sig === "SIGUSR1" ? "SIGTERM" : sig;
          process.kill(-pgid, groupSig);
        } catch { /* group already gone */ }
      });
    }
  }
  envPipe?.end(permitted ? envPayload : undefined);
  permit.end(permitted ? "run\n" : undefined);
}

export async function runNpmAsync(args: string[], archiveCache?: string): Promise<CommandResult> {
  try {
    const npm = npmInvocation(process.env, args);
    const { file, args: spawnArgs, windowsVerbatimArguments } = cmdSpawnSpec(npm.file, npm.args, npm.env);
    const gated = archiveCache !== undefined && (process.platform === "linux" || process.platform === "darwin");
    const launch = gated ? npmChildGate("cotal-release-check", file, spawnArgs, npm.env) : undefined;
    const child = spawn(launch ? launch.file : file, launch ? launch.args : spawnArgs, {
      cwd: npm.cwd, env: launch ? launch.env : npm.env, windowsVerbatimArguments, windowsHide: true,
      ...(launch ? { detached: true, stdio: launch.envPayload ? ["ignore", "pipe", "pipe", "pipe", "pipe"] : ["ignore", "pipe", "pipe", "pipe"] } : {}),
    });
    let stdout = "", stderr = "", error: string | undefined;
    child.stdout?.on("data", (chunk: Buffer | string) => { stdout += chunk.toString(); });
    child.stderr?.on("data", (chunk: Buffer | string) => { stderr += chunk.toString(); });
    child.once("error", cause => { error = cause.message; });
    if (launch) {
      let permitted = false;
      if (child.pid !== undefined) {
        try {
          writeFileSync(join(archiveCache!, `.worker-${child.pid}`), "", { mode: 0o600 });
          permitted = true;
        } catch (cause) { error = message(cause); }
      }
      releaseChildGate(child, permitted, launch.envPayload, cause => { error = message(cause); }, launch.groupCleanup);
    }
    const [status, signal] = await new Promise<[number | null, NodeJS.Signals | null]>(resolveClose =>
      child.once("close", (code, sig) => resolveClose([code, sig])),
    );
    return { status, signal, stdout, stderr, ...(error ? { error } : {}) };
  } catch (error) {
    return { status: null, stdout: "", stderr: "", error: message(error) };
  }
}

export function runNpm(args: string[], inherit = false): CommandResult {
  try {
    const npm = npmInvocation(process.env, args);
    const { file, args: spawnArgs, windowsVerbatimArguments } = cmdSpawnSpec(npm.file, npm.args, npm.env);
    const result = spawnSync(file, spawnArgs, {
      cwd: npm.cwd, env: npm.env, windowsVerbatimArguments,
      ...(inherit ? { stdio: "inherit" as const } : { encoding: "utf8" as const }), windowsHide: true,
    });
    return {
      status: result.status,
      signal: result.signal,
      stdout: `${result.stdout ?? ""}`,
      stderr: `${result.stderr ?? ""}`,
      error: result.error?.message,
      errorCode: (result.error as NodeJS.ErrnoException | undefined)?.code,
    };
  } catch (e) {
    return { status: null, stdout: "", stderr: "", error: message(e), errorCode: (e as NodeJS.ErrnoException)?.code };
  }
}

export function runProcess(file: string, args: string[], env: NodeJS.ProcessEnv, inherit = false): CommandResult {
  env = npmUpdateChildEnvironment(env);
  const result = withInstallUmask(() => spawnSync(file, args, { env, ...(inherit ? { stdio: "inherit" as const } : { encoding: "utf8" as const }), windowsHide: true }));
  return {
    status: result.status,
    stdout: `${result.stdout ?? ""}`,
    stderr: `${result.stderr ?? ""}`,
    error: result.error?.message,
  };
}

export async function runGlobalProcess(
  ...args: Parameters<typeof runGlobalChild>
): Promise<CommandResult> {
  const [root, operation, file, argv, env, inherit = false, verbatim = false] = args;
  if (process.platform === "win32" && operation === "install")
    return runWindowsInstall(root, file, argv, env, inherit, verbatim);
  if (process.platform === "linux") {
    try { pinPosixGateIfNeeded(env); }
    catch (e) { return { status: null, stdout: "", stderr: "", error: message(e) }; }
  }
  return runGlobalChild(...args);
}

async function runGlobalChild(
  root: string,
  operation: "install" | "reconcile",
  file: string,
  args: string[],
  env: NodeJS.ProcessEnv,
  inherit = false,
  windowsVerbatimArguments = false,
  staging?: string,
): Promise<CommandResult> {
  const gated = process.platform === "linux";
  const mutation = beginGlobalUpdateChild(root, operation, gated);
  let cache: string | undefined;
  let lifecycle: ReturnType<typeof npmLifecycleEnvironment>;
  let published = false;
  let preservePending = false;
  const watchers: FSWatcher[] = [];
  let elapsed: ReturnType<typeof setTimeout> | undefined;
  let idle: ReturnType<typeof setTimeout> | undefined;
  let stopping: Promise<void> | undefined;
  try {
    if (operation === "reconcile") env = npmUpdateChildEnvironment(env);
    const pipeConsole = process.platform === "win32" && inherit;
    const npm = operation === "install" && file === "npm" ? npmInvocation(env, args) : undefined;
    if (npm) ({ file, args, windowsVerbatimArguments } = cmdSpawnSpec(npm.file, npm.args, npm.env));
    const reconcileCache = gated && operation === "reconcile";
    cache = mkdtempSync(join(tmpdir(), reconcileCache ? "cotal-update-reconcile-" : "cotal-update-npm-"));
    if (npm) lifecycle = npmLifecycleEnvironment(npm, cache);
    const childEnv = { ...(lifecycle?.env ?? npm?.env ?? env), npm_config_cache: cache, npm_config_logs_max: "0", npm_config_update_notifier: "false" };
    const launch = gated ? npmChildGate("cotal-update", file, args, childEnv, "/bin/sh", operation === "reconcile" ? "reconcile" : "npm") : undefined;
    let recordCache = gated && (staging !== undefined || reconcileCache);
    if (recordCache) {
      try {
        const start = processStartToken(process.pid);
        if (!start) throw new Error("cannot identify the staged npm cache owner");
        writeFileSync(join(cache, ".owner"), `${process.pid}\n${start}\n`, { mode: 0o600, flag: "wx" });
      } catch (cause) {
        if (!reconcileCache) throw cause;
        recordCache = false;
      }
    }
    if (staging !== undefined) {
      // npm is quiet during a download. Its private cache receives the archive bytes and
      // the private prefix changes as packages unpack. Neither depends on terminal output.
      for (const path of [cache, staging]) {
        const watcher = watch(path, { recursive: true }, () => idle?.refresh());
        watcher.on("error", () => { clearTimeout(idle); idle = undefined; watcher.close(); });
        watchers.push(watcher);
      }
    }
    const child = withInstallUmask(() => spawn(launch ? launch.file : file, launch ? launch.args : args, {
      // Corepack searches ancestors for a package manager. Keep only npm at the filesystem root.
      ...(operation === "install" ? { cwd: parse(homedir()).root } : {}),
      env: launch ? launch.env : childEnv,
      // A separate process group keeps terminal interrupts out of npm's live replacement.
      // Keep the ChildProcess referenced and await close; this is not a background update.
      detached: true,
      windowsHide: true,
      windowsVerbatimArguments,
      stdio: launch?.envPayload ? [...Array<"inherit" | "pipe">(3).fill(inherit ? "inherit" : "pipe"), "pipe", "pipe"] : updateChildStdio(gated, inherit, pipeConsole),
    }));
    let error = "";
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (chunk: Buffer | string) => { if (pipeConsole) process.stdout.write(chunk); else stdout += chunk.toString(); });
    child.stderr?.on("data", (chunk: Buffer | string) => { if (pipeConsole) process.stderr.write(chunk); else stderr += chunk.toString(); });
    child.once("error", (e) => { error = e.message; });
    if (child.pid !== undefined) {
      try {
        // Publish cache custody before the gate permits npm to write to it.
        if (recordCache) {
          try { writeFileSync(join(cache, `.worker-${child.pid}`), "", { mode: 0o600, flag: "wx" }); }
          catch (cause) { if (!reconcileCache) throw cause; }
        }
        mutation.markLive(child.pid);
        published = true;
      } catch (e) {
        error = `could not journal ${operation} child ${child.pid}: ${(e as Error).message}`;
        preservePending = true;
      }
    }
    if (launch) releaseChildGate(child, published, launch.envPayload, (e) => { error = e.message; }, launch.groupCleanup);
    let rejectClose: (error: unknown) => void;
    const close = new Promise<{ status: number | null; signal: NodeJS.Signals | null }>((resolveClose, reject) => {
      rejectClose = reject;
      child.once("close", (status, signal) => resolveClose({ status, signal }));
    });
    if (staging !== undefined && child.pid !== undefined) {
      const pgid = child.pid;
      const signalGroup = (signal: NodeJS.Signals) => {
        try { process.kill(-pgid, signal); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; }
      };
      const grace = 2000;
      const reap = 1000;
      const stop = () => {
        if (stopping) return;
        clearTimeout(elapsed);
        clearTimeout(idle);
        stopping = (async () => {
          signalGroup("SIGTERM");
          await new Promise(resolve => setTimeout(resolve, grace));
          if (processGroupMembers(pgid).length) signalGroup("SIGKILL");
          const deadline = performance.now() + reap;
          while (processGroupMembers(pgid).length) {
            if (performance.now() >= deadline) throw new Error(`could not stop staging npm process group ${pgid}`);
            await new Promise(resolve => setTimeout(resolve, 25));
          }
        })();
        void stopping.catch(error => {
          child.stdin?.destroy();
          child.stdout?.destroy();
          child.stderr?.destroy();
          child.unref();
          rejectClose(error);
        });
      };
      // Leave room for TERM and KILL within the five-minute staging budget. Idle time
      // covers three 15-second fetch attempts plus their one- and two-second backoffs.
      elapsed = setTimeout(stop, 300_000 - grace - reap);
      idle = setTimeout(stop, 50_000);
    }
    const closed = await close;
    clearTimeout(elapsed);
    clearTimeout(idle);
    if (stopping) {
      await stopping;
      if (published) mutation.clear();
      throw new StagingTimeout(`${stderr}\n${stdout}`);
    }
    if (published) mutation.complete(
      closed.status,
      closed.signal,
      closed.signal !== null
        ? `${operation} child terminated by ${closed.signal}`
        : `Windows npm intermediary exited ${closed.status}; descendant completion is unproved`,
    );
    return { status: error ? null : closed.status, signal: closed.signal, stdout, stderr, ...(error ? { error } : {}) };
  } catch (e) {
    if (e instanceof StagingTimeout) throw e;
    return { status: null, stdout: "", stderr: "", error: message(e) };
  } finally {
    for (const watcher of watchers) watcher.close();
    clearTimeout(elapsed);
    clearTimeout(idle);
    if (!published && !preservePending) mutation.clear();
    lifecycle?.dispose();
    if (cache) rmSync(cache, { recursive: true, force: true, maxRetries: 3 });
  }
}

function updateChildStdio(gated: boolean, inherit: boolean, pipeConsole: boolean): import("node:child_process").StdioOptions | undefined {
  if (gated) return [...Array<"inherit" | "pipe">(3).fill(inherit ? "inherit" : "pipe"), "pipe"];
  return pipeConsole ? ["ignore", "pipe", "pipe"] : inherit ? "inherit" : undefined;
}

async function runWindowsInstall(root: string, file: string, args: string[], env: NodeJS.ProcessEnv, inherit: boolean, verbatim: boolean): Promise<CommandResult> {
  const npm = file === "npm" ? npmInvocation(env, args) : undefined;
  if (npm) ({ file, args, windowsVerbatimArguments: verbatim } = cmdSpawnSpec(npm.file, npm.args, npm.env));
  const cache = mkdtempSync(join(tmpdir(), "cotal-update-npm-"));
  try {
    const mutation = beginGlobalUpdateChild(root, "install");
    let published = false;
    let error: string | undefined;
    let result: CommandResult | undefined;
    try {
      const worker = spawn(process.execPath, [fileURLToPath(new URL("./update-windows-install.js", import.meta.url))], {
        detached: true, windowsHide: true, stdio: ["ignore", "ignore", "ignore", "ipc"],
        env: { ...(npm?.env ?? env), npm_config_cache: cache, npm_config_logs_max: "0", npm_config_update_notifier: "false" },
      });
      worker.once("error", cause => { error = cause.message; });
      worker.once("message", (reply: CommandResult) => { result = reply; });
      const closed = new Promise<{ status: number | null; signal: NodeJS.Signals | null }>(done => worker.once("close", (status, signal) => done({ status, signal })));
      if (worker.pid !== undefined) {
        published = true;
        try {
          mutation.markLive(worker.pid);
          worker.send!({ file, args, cwd: parse(homedir()).root, log: join(cache, "install.log"), verbatim });
        } catch (cause) { error = message(cause); worker.disconnect?.(); }
      }
      const exit = await closed;
      if (!result || exit.status !== 0) {
        if (published) mutation.complete(exit.status === 0 ? null : exit.status, exit.signal, "Windows npm job completion could not be verified");
        return { status: null, stdout: "", stderr: "", error: error ?? result?.error ?? "Windows npm job completion could not be verified" };
      }
      mutation.clear();
      if (inherit && result.stdout) process.stdout.write(result.stdout);
      return inherit ? { ...result, stdout: "" } : result;
    } finally { if (!published) mutation.clear(); }
  } catch (cause) { return { status: null, stdout: "", stderr: "", error: message(cause) }; }
  finally { rmSync(cache, { recursive: true, force: true, maxRetries: 3 }); }
}

/** npm --json supplies the code, but its summary is the only field naming the missing spec. */
export function latestNotAvailable(result: CommandResult, version: string): boolean {
  if (result.status === 0 || result.status === null || result.error) return false;
  try {
    const error = (JSON.parse(result.stdout) as { error?: { code?: unknown; summary?: unknown } }).error;
    return error?.code === "ETARGET" && error.summary === `No matching version found for cotal-ai@${version}.`;
  } catch { return false; }
}

export function failure(result: CommandResult): string {
  return [result.signal && `process terminated by ${result.signal}`, result.error, result.stderr.trim(), result.stdout.trim()].filter(Boolean).join("\n") || `process exited ${result.status}`;
}

export function message(value: unknown): string {
  return value instanceof Error ? value.message : String(value);
}
