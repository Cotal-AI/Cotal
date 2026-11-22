import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, realpathSync, rmSync, watch, writeFileSync, type FSWatcher } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, delimiter, dirname, isAbsolute, join, parse, relative, resolve, sep } from "node:path";
import { cmdSpawnSpec, beginGlobalUpdateChild, processGroupMembers, processStartToken, resolveOnPath } from "@cotal-ai/workspace";
import { withInstallUmask } from "../lib/install-umask.js";
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

/** Bind a POSIX npm global installation to its package and bin link before replacing it.
 * Local/npx copies and source checkouts retain npm's separate global destination. A global-shaped
 * installation with a missing, redirected or escaping entry refuses instead of guessing a prefix. */
export function installedUpdatePrefix(packageRoot: string, entry: string): string | undefined {
  const root = realpathSync(packageRoot);
  const modules = dirname(root);
  if (process.platform === "win32" || basename(modules) !== "node_modules" || basename(dirname(modules)) !== "lib")
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

function npmInvocation(env: NodeJS.ProcessEnv) {
  const cwd = parse(homedir()).root;
  if (process.platform === "win32" || env.PATH === undefined) return { file: "npm", env, cwd };
  const lookup = { PATH: env.PATH.split(delimiter).map(dir => resolve(cwd, dir)).join(delimiter) };
  const file = resolveOnPath("npm", lookup);
  if (!file) return { file: "npm", env, cwd };
  const node = resolveOnPath("node", lookup);
  if (node && realpathSync(node) === process.execPath) return { file: "npm", env, cwd };
  return { file, env: { ...env, PATH: `${dirname(process.execPath)}${delimiter}${env.PATH}` }, cwd };
}

export async function runNpmAsync(args: string[], archiveCache?: string): Promise<CommandResult> {
  try {
    const npm = npmInvocation(process.env);
    const { file, args: spawnArgs, windowsVerbatimArguments } = cmdSpawnSpec(npm.file, args);
    const gated = archiveCache !== undefined && (process.platform === "linux" || process.platform === "darwin");
    const gate = 'IFS= read -r permit <&3 && [ "$permit" = run ] || exit 1; exec 3<&-; exec "$@"';
    const child = spawn(gated ? "/bin/sh" : file, gated ? ["-c", gate, "cotal-release-check", file, ...spawnArgs] : spawnArgs, {
      cwd: npm.cwd, env: npm.env, windowsVerbatimArguments, windowsHide: true,
      ...(gated ? { detached: true, stdio: ["ignore", "pipe", "pipe", "pipe"] } : {}),
    });
    let stdout = "", stderr = "", error: string | undefined;
    child.stdout?.on("data", (chunk: Buffer | string) => { stdout += chunk.toString(); });
    child.stderr?.on("data", (chunk: Buffer | string) => { stderr += chunk.toString(); });
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
    const status = await new Promise<number | null>(resolveClose => child.once("close", resolveClose));
    return { status, stdout, stderr, ...(error ? { error } : {}) };
  } catch (error) {
    return { status: null, stdout: "", stderr: "", error: message(error) };
  }
}

export function runNpm(args: string[], inherit = false): CommandResult {
  try {
    const npm = npmInvocation(process.env);
    const { file, args: spawnArgs, windowsVerbatimArguments } = cmdSpawnSpec(npm.file, args);
    const result = spawnSync(file, spawnArgs, {
      cwd: npm.cwd, env: npm.env, windowsVerbatimArguments,
      ...(inherit ? { stdio: "inherit" as const } : { encoding: "utf8" as const }),
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
  const result = withInstallUmask(() => spawnSync(file, args, inherit ? { stdio: "inherit", env } : { encoding: "utf8", env }));
  return {
    status: result.status,
    stdout: `${result.stdout ?? ""}`,
    stderr: `${result.stderr ?? ""}`,
    error: result.error?.message,
  };
}

export async function runGlobalProcess(
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
  let published = false;
  let preservePending = false;
  const watchers: FSWatcher[] = [];
  let elapsed: ReturnType<typeof setTimeout> | undefined;
  let idle: ReturnType<typeof setTimeout> | undefined;
  let stopping: Promise<void> | undefined;
  try {
    const npm = operation === "install" && file === "npm" ? npmInvocation(env) : undefined;
    file = npm?.file ?? file;
    cache = mkdtempSync(join(tmpdir(), "cotal-update-npm-"));
    const recordCache = gated && staging !== undefined;
    if (recordCache) {
      const start = processStartToken(process.pid);
      if (!start) throw new Error("cannot identify the staged npm cache owner");
      writeFileSync(join(cache, ".owner"), `${process.pid}\n${start}\n`, { mode: 0o600, flag: "wx" });
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
    // The pipe closes without permission if the parent dies before publishing the PID.
    // exec keeps the published PID and the real child keeps its original argv and stdin.
    const gate = 'IFS= read -r permit <&3 && [ "$permit" = run ] || exit 1; exec 3<&-; exec "$@"';
    const child = withInstallUmask(() => spawn(gated ? "/bin/sh" : file, gated ? ["-c", gate, "cotal-update", file, ...args] : args, {
      // Corepack searches ancestors for a package manager. Keep only npm at the filesystem root.
      ...(operation === "install" ? { cwd: parse(homedir()).root } : {}),
      env: { ...(npm?.env ?? env), npm_config_cache: cache, npm_config_logs_max: "0", npm_config_update_notifier: "false" },
      // A separate process group keeps terminal interrupts out of npm's live replacement.
      // Keep the ChildProcess referenced and await close; this is not a background update.
      detached: true,
      windowsHide: true,
      windowsVerbatimArguments,
      ...(gated ? { stdio: [inherit ? "inherit" : "pipe", inherit ? "inherit" : "pipe", inherit ? "inherit" : "pipe", "pipe"] } : inherit ? { stdio: "inherit" as const } : {}),
    }));
    const permit = gated ? child.stdio[3] as import("node:stream").Writable : undefined;
    let error = "";
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (chunk: Buffer | string) => { stdout += chunk.toString(); });
    child.stderr?.on("data", (chunk: Buffer | string) => { stderr += chunk.toString(); });
    child.once("error", (e) => { error = e.message; });
    permit?.on("error", (e) => { error = e.message; });
    if (child.pid !== undefined) {
      try {
        // Publish cache custody before the gate permits npm to write to it.
        if (recordCache) writeFileSync(join(cache, `.worker-${child.pid}`), "", { mode: 0o600, flag: "wx" });
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
      throw new RegistryUnavailable("target staging could not reach the registry");
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
    if (e instanceof RegistryUnavailable) throw e;
    return { status: null, stdout: "", stderr: "", error: message(e) };
  } finally {
    for (const watcher of watchers) watcher.close();
    clearTimeout(elapsed);
    clearTimeout(idle);
    if (!published && !preservePending) mutation.clear();
    if (cache) rmSync(cache, { recursive: true, force: true, maxRetries: 3 });
  }
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
