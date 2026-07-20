import { execFile, execFileSync } from "node:child_process";
import { existsSync, realpathSync, statSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";

const MAX_BUFFER = 16 * 1024 * 1024;
const PROBE_CACHE_MS = 250;
const MAX_WORKTREE_PARENT_PROBES = 12;
const EXIT_WAIT_MS = 8_000;

export interface OrcaWorktree {
  id: string;
  path: string;
  displayName?: string;
}

export interface OrcaTerminal {
  handle: string;
  ptyId?: string;
  title?: string;
  connected?: boolean;
  writable?: boolean;
}

interface OrcaEnvelope<T> {
  ok?: boolean;
  result?: T;
  error?: { code?: string; message?: string };
}

interface WorktreeResult {
  worktree?: OrcaWorktree;
}

interface TerminalResult {
  terminal?: OrcaTerminal;
  handle?: string;
}

interface TerminalListResult {
  terminals?: OrcaTerminal[];
}

interface TerminalWaitResult {
  wait?: {
    handle?: string;
    condition?: string;
    satisfied?: boolean;
    status?: string;
    exitCode?: number;
  };
}

type ExecError = Error & {
  code?: string;
  stderr?: Buffer | string;
  stdout?: Buffer | string;
  status?: number;
};

export class OrcaCliError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
  }
}

let selectedBin: string | undefined;
let availableCache: { at: number; value: boolean } | undefined;
let terminalCache: { at: number; terminals: OrcaTerminal[] } | undefined;

/** Orca terminals are a local runtime boundary. Never let ambient remote-runtime selectors
 * redirect manager lifecycle calls to another Orca environment. */
export function localCliEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const clean = { ...env };
  for (const key of Object.keys(clean)) {
    if (key.toUpperCase() === "ORCA_PAIRING_CODE" || key.toUpperCase() === "ORCA_ENVIRONMENT") delete clean[key];
  }
  return clean;
}

function candidates(): string[] {
  const explicit = process.env.COTAL_ORCA_BIN?.trim();
  if (explicit) return [explicit];
  return process.platform === "linux" ? ["orca-ide", "orca"] : ["orca", "orca-ide"];
}

function errorText(err: unknown): string {
  const e = err as ExecError;
  const stderr = Buffer.isBuffer(e.stderr) ? e.stderr.toString("utf8") : e.stderr;
  const stdout = Buffer.isBuffer(e.stdout) ? e.stdout.toString("utf8") : e.stdout;
  return (stderr?.trim() || stdout?.trim() || e.message || String(err)).replace(/\s+/g, " ");
}

function execOrca(args: string[], opts: { cwd?: string } = {}): string {
  const tried: string[] = [];
  const explicit = !!process.env.COTAL_ORCA_BIN?.trim();
  const bins = !explicit && selectedBin ? [selectedBin] : candidates();
  for (const bin of bins) {
    tried.push(bin);
    try {
      const out = execFileSync(bin, args, {
        cwd: opts.cwd,
        env: localCliEnv(),
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
        maxBuffer: MAX_BUFFER,
      });
      if (!explicit) selectedBin = bin;
      return out;
    } catch (err) {
      const e = err as ExecError;
      if (!selectedBin && e.code === "ENOENT" && bin !== bins[bins.length - 1]) continue;
      const stdout = Buffer.isBuffer(e.stdout) ? e.stdout.toString("utf8") : e.stdout;
      // Orca reports command failures as a JSON envelope on stdout and exits nonzero.
      // Preserve that envelope so request-level code can handle expected errors by code.
      if (typeof stdout === "string" && stdout.trim()) {
        try {
          const envelope = JSON.parse(stdout) as OrcaEnvelope<unknown>;
          if (envelope.ok === false) {
            if (!explicit) selectedBin = bin;
            return stdout;
          }
        } catch {
          /* fall through to the CLI diagnostic below */
        }
      }
      throw new Error(`orca ${args.join(" ")} failed via ${bin} (exit ${e.status ?? "unknown"}): ${errorText(err)}`);
    }
  }
  throw new Error(`orca CLI not found (tried ${tried.join(", ")}); install/register Orca CLI or set COTAL_ORCA_BIN`);
}

function execOrcaAsync(args: string[], opts: { cwd?: string; timeoutMs?: number } = {}): Promise<string> {
  const explicit = !!process.env.COTAL_ORCA_BIN?.trim();
  const bins = !explicit && selectedBin ? [selectedBin] : candidates();
  const run = (index: number): Promise<string> => {
    const bin = bins[index];
    if (!bin) return Promise.reject(new Error(`orca CLI not found (tried ${bins.join(", ")})`));
    return new Promise((resolvePromise, reject) => {
      execFile(
        bin,
        args,
        {
          cwd: opts.cwd,
          env: localCliEnv(),
          encoding: "utf8",
          maxBuffer: MAX_BUFFER,
          timeout: opts.timeoutMs,
        },
        (err, stdout, stderr) => {
          if (!err) {
            if (!explicit) selectedBin = bin;
            resolvePromise(stdout);
            return;
          }
          const e = err as ExecError;
          if (!selectedBin && e.code === "ENOENT" && index < bins.length - 1) {
            void run(index + 1).then(resolvePromise, reject);
            return;
          }
          if (stdout.trim()) {
            try {
              const envelope = JSON.parse(stdout) as OrcaEnvelope<unknown>;
              if (envelope.ok === false) {
                if (!explicit) selectedBin = bin;
                resolvePromise(stdout);
                return;
              }
            } catch {
              /* fall through to the CLI diagnostic below */
            }
          }
          const detail = (stderr.trim() || stdout.trim() || err.message).replace(/\s+/g, " ");
          reject(new Error(`orca ${args.join(" ")} failed via ${bin} (exit ${e.status ?? "unknown"}): ${detail}`));
        },
      );
    });
  };
  return run(0);
}

function parseEnvelope<T>(stdout: string, args: string[]): OrcaEnvelope<T> {
  try {
    return JSON.parse(stdout) as OrcaEnvelope<T>;
  } catch (e) {
    throw new Error(`orca ${args.join(" ")} returned non-JSON output: ${(e as Error).message}`);
  }
}

function request<T>(args: string[], opts: { cwd?: string } = {}): OrcaEnvelope<T> {
  return parseEnvelope<T>(execOrca(args, opts), args);
}

async function requestAsync<T>(
  args: string[],
  opts: { cwd?: string; timeoutMs?: number } = {},
): Promise<OrcaEnvelope<T>> {
  return parseEnvelope<T>(await execOrcaAsync(args, opts), args);
}

function requireOk<T>(args: string[], opts: { cwd?: string } = {}): T {
  const r = request<T>(args, opts);
  if (r.ok === false) {
    const code = r.error?.code ?? "unknown_error";
    const msg = r.error?.message ?? r.error?.code ?? "unknown Orca error";
    throw new OrcaCliError(code, `orca ${args.join(" ")} failed: ${msg}`);
  }
  if (r.result === undefined) throw new Error(`orca ${args.join(" ")} returned no result`);
  return r.result;
}

function isUnder(parent: string, child: string): boolean {
  const rel = relative(parent, child);
  return rel === "" || (!!rel && !rel.startsWith("..") && !isAbsolute(rel));
}

function assertDir(path: string): void {
  if (!existsSync(path)) throw new Error(`orca runtime: cwd does not exist: ${path}`);
  if (!statSync(path).isDirectory()) throw new Error(`orca runtime: cwd is not a directory: ${path}`);
}

/** True when an Orca runtime is reachable through the public CLI. */
export function available(): boolean {
  const cacheable = !process.env.COTAL_ORCA_BIN?.trim();
  if (cacheable && availableCache && Date.now() - availableCache.at < PROBE_CACHE_MS) return availableCache.value;
  try {
    const r = request<{ runtime?: { reachable?: boolean } }>(["status", "--json"]);
    const value = r.ok === true && r.result?.runtime?.reachable === true;
    if (cacheable) availableCache = { at: Date.now(), value };
    return value;
  } catch {
    if (cacheable) availableCache = { at: Date.now(), value: false };
    return false;
  }
}

/** Resolve the Orca worktree that encloses `cwd`. Uses `current` first because it is the documented
 *  cwd-aware selector, then falls back to exact `path:` checks up the parent chain. */
export function resolveWorktree(cwd: string): OrcaWorktree {
  const requested = resolve(cwd);
  assertDir(requested);
  const abs = realpathSync(requested);

  const current = request<WorktreeResult>(["worktree", "current", "--json"], { cwd: abs });
  if (current.ok !== false && current.result?.worktree?.id && current.result.worktree.path) {
    const wt = current.result.worktree;
    if (isUnder(realpathSync(wt.path), abs)) return wt;
  }

  let probes = 0;
  for (let dir = abs; probes < MAX_WORKTREE_PARENT_PROBES; probes++) {
    const shown = request<WorktreeResult>(["worktree", "show", "--worktree", `path:${dir}`, "--json"]);
    if (shown.ok !== false && shown.result?.worktree?.id && shown.result.worktree.path) {
      const wt = shown.result.worktree;
      if (isUnder(realpathSync(wt.path), abs)) return wt;
    }
    if (shown.ok === false && shown.error?.code && shown.error.code !== "selector_not_found") {
      throw new Error(`orca worktree lookup failed for ${dir}: ${shown.error.message ?? shown.error.code}`);
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error(`orca runtime: ${abs} is not inside an Orca-managed worktree; open/register that project in Orca first`);
}

export function createTerminal(opts: { worktreeId: string; title: string; command: string }): OrcaTerminal {
  const result = requireOk<TerminalResult>([
    "terminal",
    "create",
    "--worktree",
    `id:${opts.worktreeId}`,
    "--title",
    opts.title,
    "--command",
    opts.command,
    "--json",
  ]);
  const terminal = result.terminal ?? (result.handle ? { handle: result.handle } : undefined);
  if (!terminal?.handle) throw new Error("orca terminal create returned no terminal handle");
  terminalCache = undefined;
  return terminal;
}

export function showTerminal(handle: string): OrcaEnvelope<TerminalResult> {
  return request<TerminalResult>(["terminal", "show", "--terminal", handle, "--json"]);
}

/** Resolve the current handle for a terminal. Orca handles are runtime-scoped, while ptyId stays
 * stable across handle rotation. */
export function currentTerminal(terminal: Pick<OrcaTerminal, "handle" | "ptyId">): OrcaTerminal | undefined {
  if (!terminalCache || Date.now() - terminalCache.at >= PROBE_CACHE_MS) {
    const listed = requireOk<TerminalListResult>(["terminal", "list", "--json"]).terminals ?? [];
    terminalCache = { at: Date.now(), terminals: listed };
  }
  const listed = terminal.ptyId
    ? terminalCache.terminals.find((candidate) => candidate.ptyId === terminal.ptyId)
    : terminalCache.terminals.find((candidate) => candidate.handle === terminal.handle);
  if (listed) return { ...terminal, ...listed };

  const shown = showTerminal(terminal.handle);
  if (shown.ok === false) {
    const code = shown.error?.code ?? "";
    if (/not_found|stale|closed/i.test(code)) return undefined;
    throw new OrcaCliError(code, `orca terminal show failed: ${shown.error?.message ?? code}`);
  }
  return shown.result?.terminal ?? terminal;
}

export function terminalAlive(terminal: Pick<OrcaTerminal, "handle" | "ptyId">): boolean {
  try {
    const current = currentTerminal(terminal);
    return current ? current.connected !== false : false;
  } catch {
    // Status drives teardown. An unreachable CLI is not positive evidence that the agent exited.
    return true;
  }
}

async function waitTerminalExit(handle: string, timeoutMs: number): Promise<void> {
  const args = [
    "terminal",
    "wait",
    "--terminal",
    handle,
    "--for",
    "exit",
    "--timeout-ms",
    String(timeoutMs),
    "--json",
  ];
  const result = await requestAsync<TerminalWaitResult>(args, { timeoutMs: timeoutMs + 250 });
  if (result.ok === false) {
    const code = result.error?.code ?? "unknown_error";
    throw new OrcaCliError(code, `orca terminal wait failed for ${handle}: ${result.error?.message ?? code}`);
  }
  const wait = result.result?.wait;
  if (wait?.condition !== "exit" || wait.satisfied !== true || wait.status !== "exited")
    throw new Error(`orca terminal wait returned no authoritative exit for ${handle}`);
}

async function currentTerminalForWait(
  terminal: Pick<OrcaTerminal, "handle" | "ptyId">,
  deadline: number,
): Promise<OrcaTerminal | undefined> {
  let remaining = deadline - Date.now();
  if (remaining <= 0) throw new Error(`orca: timed out while resolving terminal ${terminal.handle}`);
  const listedResult = await requestAsync<TerminalListResult>(["terminal", "list", "--json"], {
    timeoutMs: remaining,
  });
  if (listedResult.ok === false) {
    const code = listedResult.error?.code ?? "unknown_error";
    throw new OrcaCliError(code, `orca terminal list failed: ${listedResult.error?.message ?? code}`);
  }
  const listed = (listedResult.result?.terminals ?? []).find((candidate) =>
    terminal.ptyId ? candidate.ptyId === terminal.ptyId : candidate.handle === terminal.handle,
  );
  if (listed) return { ...terminal, ...listed };
  if (terminal.ptyId) return undefined;

  remaining = deadline - Date.now();
  if (remaining <= 0) throw new Error(`orca: timed out while resolving terminal ${terminal.handle}`);
  const shown = await requestAsync<TerminalResult>(
    ["terminal", "show", "--terminal", terminal.handle, "--json"],
    { timeoutMs: remaining },
  );
  if (shown.ok === false) {
    const code = shown.error?.code ?? "";
    if (/not_found|stale|closed/i.test(code)) return undefined;
    throw new OrcaCliError(code, `orca terminal show failed: ${shown.error?.message ?? code}`);
  }
  if (!shown.result?.terminal)
    throw new Error(`orca terminal show returned no authoritative state for ${terminal.handle}`);
  return shown.result.terminal;
}

/** Await Orca's provider-native terminal exit condition, following one or more handle rotations by
 * stable ptyId. The native wait is bounded so it cannot outlive the manager's preservation cut. */
export async function waitManagedTerminalExit(
  terminal: Pick<OrcaTerminal, "handle" | "ptyId">,
  timeoutMs = EXIT_WAIT_MS,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let current = { ...terminal };
  while (true) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new Error(`orca: terminal ${terminal.handle} did not exit within ${timeoutMs}ms`);
    try {
      await waitTerminalExit(current.handle, remaining);
      terminalCache = undefined;
      return;
    } catch (err) {
      if (!(err instanceof OrcaCliError) || !/not_found|stale|closed/i.test(err.code)) throw err;
      terminalCache = undefined;
      const rotated = await currentTerminalForWait(terminal, deadline);
      if (!rotated) return;
      if (rotated.handle === current.handle) throw err;
      current = rotated;
    }
  }
}

export function sendTerminal(handle: string, opts: { text?: string; enter?: boolean; interrupt?: boolean } = {}): void {
  const args = ["terminal", "send", "--terminal", handle];
  if (opts.text !== undefined) args.push("--text", opts.text);
  if (opts.enter) args.push("--enter");
  if (opts.interrupt) args.push("--interrupt");
  args.push("--json");
  requireOk<Record<string, unknown>>(args);
}

export function closeTerminal(handle: string): boolean {
  try {
    const r = request<Record<string, unknown>>(["terminal", "close", "--terminal", handle, "--json"]);
    if (r.ok === false) {
      const code = r.error?.code ?? "";
      if (/not_found|stale|closed/i.test(code)) return false;
      throw new Error(`orca terminal close failed for ${handle}: ${r.error?.message ?? code}`);
    }
    return true;
  } finally {
    terminalCache = undefined;
  }
}

/** Close by stable identity. If the handle rotates between resolution and close, refresh by ptyId
 * and retry once instead of treating a stale handle as a successful stop. */
export function closeManagedTerminal(terminal: Pick<OrcaTerminal, "handle" | "ptyId">): void {
  const current = currentTerminal(terminal);
  if (!current) return;
  if (closeTerminal(current.handle) || !current.ptyId) return;
  const rotated = currentTerminal(current);
  if (rotated && rotated.handle !== current.handle) closeTerminal(rotated.handle);
}

export function terminals(): OrcaTerminal[] {
  return requireOk<TerminalListResult>(["terminal", "list", "--json"]).terminals ?? [];
}
