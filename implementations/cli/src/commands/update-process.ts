import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, watch, writeFileSync, type FSWatcher } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, parse, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
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
  readonly scrub?: (text: string) => string;
  readonly stagingFailure?: Error;
  readonly missingVersion?: string | null;
}

export class RegistryUnavailable extends Error {}
export class StagingTimeout extends Error {
  constructor(npmOutput: string) {
    super("Package staging reached its time limit");
    stagingDiagnostic.set(this, npmOutput);
  }
}

function stagingNpmFailure(result: CommandResult): Error {
  const text = result.error || result.stderr.trim() || result.stdout.trim() || `npm exited ${result.status}`;
  const error = new Error(`target staging failed: ${result.scrub?.(text) ?? text}`);
  stagingDiagnostic.set(error, `target staging failed: ${text}`);
  return error;
}

const stagingDiagnostic = new WeakMap<Error, string>();
export function rawStagingDiagnostic(error: unknown): string {
  return error instanceof Error ? stagingDiagnostic.get(error) ?? message(error) : message(error);
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

// The pipe closes without permission if the parent dies before publishing the PID.
// exec keeps the published PID and the real child keeps its original argv and stdin.
const npmChildGate = 'IFS= read -r permit <&3 && [ "$permit" = run ] || exit 1; exec 3<&-; exec "$@"';

async function stopStagingGroup(pgid: number, grace: number, reap: number): Promise<void> {
  const signal = (value: NodeJS.Signals) => {
    try { process.kill(-pgid, value); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; }
  };
  signal("SIGTERM");
  await new Promise(resolve => setTimeout(resolve, grace));
  if (processGroupMembers(pgid).length) signal("SIGKILL");
  const deadline = performance.now() + reap;
  while (processGroupMembers(pgid).length) {
    if (performance.now() >= deadline) throw new Error(`could not stop staging npm process group ${pgid}`);
    await new Promise(resolve => setTimeout(resolve, 25));
  }
}

export async function runNpmAsync(args: string[], archiveCache?: string): Promise<CommandResult> {
  let npm: ReturnType<typeof npmInvocation> | undefined;
  try {
    const prefix = args.indexOf("--prefix");
    npm = npmInvocation(process.env, args, args[0] === "install" && prefix >= 0 ? args[prefix + 1] : undefined);
    const { file, args: spawnArgs, windowsVerbatimArguments } = cmdSpawnSpec(npm.file, npm.args, npm.env);
    const gated = archiveCache !== undefined && (process.platform === "linux" || process.platform === "darwin");
    const child = spawn(gated ? "/bin/sh" : file, gated ? ["-c", npmChildGate, "cotal-release-check", file, ...spawnArgs] : spawnArgs, {
      cwd: npm.cwd, env: npm.env, windowsVerbatimArguments, windowsHide: true,
      ...(gated ? { detached: true, stdio: ["ignore", "pipe", "pipe", "pipe"] }
        : args[0] === "install" ? { stdio: ["ignore", "pipe", "pipe"] } : {}),
    });
    let stdout = "", stderr = "", error: string | undefined;
    child.stdout?.setEncoding("utf8").on("data", (chunk: string) => { stdout += chunk; });
    child.stderr?.setEncoding("utf8").on("data", (chunk: string) => { stderr += chunk; });
    child.once("error", cause => { error = cause.message; });
    if (gated) {
      const permit = child.stdio[3] as import("node:stream").Writable;
      permit.on("error", cause => { error = message(cause); });
      try {
        if (child.pid === undefined) permit.end();
        else {
          writeFileSync(join(archiveCache!, `.worker-${child.pid}`), "", { mode: 0o600 });
          permit.end("run\n");
        }
      } catch (cause) { error = message(cause); permit.end(); }
    }
    const closed = await new Promise<{ status: number | null; signal: NodeJS.Signals | null }>(resolveClose =>
      child.once("close", (status, signal) => resolveClose({ status, signal })));
    return { status: closed.status, stdout, stderr, ...(error ? { error } : {}),
      ...(args[0] === "install" && { signal: closed.signal }), ...(npm.config && { scrub: npm.config.scrub }) };
  } catch (error) {
    return { status: null, stdout: "", stderr: "", error: message(error), scrub: npm?.config?.scrub };
  } finally { npm?.config?.dispose(); }
}

export function runNpm(args: string[], inherit = false): CommandResult {
  let npm: ReturnType<typeof npmInvocation> | undefined;
  try {
    npm = npmInvocation(process.env, args);
    const { file, args: spawnArgs, windowsVerbatimArguments } = cmdSpawnSpec(npm.file, npm.args, npm.env);
    const result = spawnSync(file, spawnArgs, {
      cwd: npm.cwd, env: npm.env, windowsVerbatimArguments,
      ...(inherit && !npm.config ? { stdio: "inherit" as const } : { encoding: "utf8" as const }), windowsHide: true,
    });
    const scrub = npm.config?.scrub;
    const stdout = String(result.stdout ?? ""), stderr = String(result.stderr ?? "");
    if (inherit && scrub) { process.stdout.write(scrub(stdout)); process.stderr.write(scrub(stderr)); }
    return {
      status: result.status,
      signal: result.signal,
      stdout: inherit ? "" : stdout,
      stderr: inherit ? "" : stderr,
      error: result.error?.message,
      errorCode: (result.error as NodeJS.ErrnoException | undefined)?.code,
      ...(scrub && { scrub }),
    };
  } catch (e) {
    return { status: null, stdout: "", stderr: "", error: message(e), errorCode: (e as NodeJS.ErrnoException)?.code, scrub: npm?.config?.scrub };
  } finally { npm?.config?.dispose(); }
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

export function runGlobalProcess(
  ...args: Parameters<typeof runGlobalChild>
): Promise<CommandResult> {
  const [root, operation, file, argv, env, inherit = false, verbatim = false, staging] = args;
  return process.platform === "win32" && operation === "install"
    ? runWindowsInstall(root, file, argv, env, inherit, verbatim, staging)
    : runGlobalChild(...args);
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
  let npm: ReturnType<typeof npmInvocation> | undefined;
  let published = false;
  let preservePending = false;
  const watchers: FSWatcher[] = [];
  let elapsed: ReturnType<typeof setTimeout> | undefined;
  let idle: ReturnType<typeof setTimeout> | undefined;
  let stopping: Promise<void> | undefined;
  try {
    if (operation === "reconcile") env = npmUpdateChildEnvironment(env);
    const reconcileCache = gated && operation === "reconcile";
    cache = mkdtempSync(join(tmpdir(), reconcileCache ? "cotal-update-reconcile-" : "cotal-update-npm-"));
    npm = operation === "install" && file === "npm" ? npmInvocation(env, args, staging ?? cache) : undefined;
    const pipeConsole = process.platform === "win32" && inherit && !npm?.config;
    if (npm) ({ file, args, windowsVerbatimArguments } = cmdSpawnSpec(npm.file, npm.args, npm.env));
    if (npm) lifecycle = npmLifecycleEnvironment(npm, cache);
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
    const child = withInstallUmask(() => spawn(gated ? "/bin/sh" : file, gated ? ["-c", npmChildGate, "cotal-update", file, ...args] : args, {
      // Corepack searches ancestors for a package manager. Keep only npm at the filesystem root.
      ...(operation === "install" ? { cwd: parse(homedir()).root } : {}),
      env: { ...(lifecycle?.env ?? npm?.env ?? env), npm_config_cache: cache, npm_config_logs_max: "0", npm_config_update_notifier: "false" },
      // A separate process group keeps terminal interrupts out of npm's live replacement.
      // Keep the ChildProcess referenced and await close; this is not a background update.
      detached: true,
      windowsHide: true,
      windowsVerbatimArguments,
      stdio: updateChildStdio(gated, inherit && !npm?.config, pipeConsole),
    }));
    const permit = gated ? child.stdio[3] as import("node:stream").Writable : undefined;
    let error = "";
    let stdout = "";
    let stderr = "";
    child.stdout?.setEncoding("utf8").on("data", (chunk: string) => { if (pipeConsole) process.stdout.write(chunk); else stdout += chunk; });
    child.stderr?.setEncoding("utf8").on("data", (chunk: string) => { if (pipeConsole) process.stderr.write(chunk); else stderr += chunk; });
    child.once("error", (e) => { error = e.message; });
    permit?.on("error", (e) => { error = e.message; });
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
    permit?.end(published ? "run\n" : undefined);
    let rejectClose: (error: unknown) => void;
    const close = new Promise<{ status: number | null; signal: NodeJS.Signals | null }>((resolveClose, reject) => {
      rejectClose = reject;
      child.once("close", (status, signal) => resolveClose({ status, signal }));
    });
    if (staging !== undefined && child.pid !== undefined) {
      const pgid = child.pid;
      const grace = 2000;
      const reap = 1000;
      const stop = () => {
        if (stopping) return;
        clearTimeout(elapsed);
        clearTimeout(idle);
        stopping = stopStagingGroup(pgid, grace, reap);
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
    const scrub = npm?.config?.scrub;
    if (inherit && scrub) { process.stdout.write(scrub(stdout)); process.stderr.write(scrub(stderr)); stdout = stderr = ""; }
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
    const result = { status: error ? null : closed.status, signal: closed.signal, stdout, stderr, ...(error ? { error } : {}), ...(scrub && { scrub }) };
    return staging && scrub && result.status !== 0 ? { ...result, stagingFailure: stagingNpmFailure(result) } : result;
  } catch (e) {
    if (e instanceof StagingTimeout) throw e;
    return { status: null, stdout: "", stderr: "", error: npm?.config?.scrub(message(e)) ?? message(e) };
  } finally {
    for (const watcher of watchers) watcher.close();
    clearTimeout(elapsed);
    clearTimeout(idle);
    if (!published && !preservePending) mutation.clear();
    lifecycle?.dispose();
    npm?.config?.dispose();
    if (cache) rmSync(cache, { recursive: true, force: true, maxRetries: 3 });
  }
}

function updateChildStdio(gated: boolean, inherit: boolean, pipeConsole: boolean): import("node:child_process").StdioOptions | undefined {
  if (gated) return [...Array<"inherit" | "pipe">(3).fill(inherit ? "inherit" : "pipe"), "pipe"];
  return pipeConsole ? ["ignore", "pipe", "pipe"] : inherit ? "inherit" : undefined;
}

async function runWindowsInstall(root: string, file: string, args: string[], env: NodeJS.ProcessEnv, inherit: boolean, verbatim: boolean, staging?: string): Promise<CommandResult> {
  const cache = mkdtempSync(join(tmpdir(), "cotal-update-npm-"));
  let npm: ReturnType<typeof npmInvocation> | undefined;
  try {
    npm = file === "npm" ? npmInvocation(env, args, staging ?? cache) : undefined;
    const target = npm?.config ? args.find(arg => arg.startsWith("cotal-ai@"))?.slice("cotal-ai@".length) : undefined;
    if (npm) ({ file, args, windowsVerbatimArguments: verbatim } = cmdSpawnSpec(npm.file, npm.args, npm.env));
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
          worker.send!({ file, args, cwd: parse(homedir()).root, log: join(cache, "install.log"), verbatim, config: npm?.config?.file, target });
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
  } catch (cause) { return { status: null, stdout: "", stderr: "", error: npm?.config?.scrub(message(cause)) ?? message(cause) }; }
  finally { npm?.config?.dispose(); rmSync(cache, { recursive: true, force: true, maxRetries: 3 }); }
}

/** npm --json supplies the code, but its summary is the only field naming the missing spec. */
export function latestNotAvailable(result: CommandResult, version: string): boolean {
  if (result.status === 0 || result.status === null || result.error) return false;
  if (result.missingVersion !== undefined) return result.missingVersion === version;
  try {
    const error = (JSON.parse(result.stdout) as { error?: { code?: unknown; summary?: unknown } }).error;
    return error?.code === "ETARGET" && error.summary === `No matching version found for cotal-ai@${version}.`;
  } catch { return false; }
}

export function failure(result: CommandResult, raw = false): string {
  const text = [result.signal && `process terminated by ${result.signal}`, result.error, result.stderr.trim(), result.stdout.trim()].filter(Boolean).join("\n") || `process exited ${result.status}`;
  return raw ? text : result.scrub?.(text) ?? text;
}

export function message(value: unknown): string {
  return value instanceof Error ? value.message : String(value);
}
