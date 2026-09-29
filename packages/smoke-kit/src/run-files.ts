/**
 * A bounded scheduler for a package's smoke files: one real OS process per file, run in parallel,
 * with each file's complete output printed whole and in declared order.
 *
 * It replaces a serial `tsx a.smoke.ts && tsx b.smoke.ts && ...` chain and grades the same way the
 * shard does: a file passes only if it exits 0 AND its COMPLETE output parses to a non-zero tally
 * with no failures. Every selected file runs even after one fails, then the run fails.
 *
 * Settings (environment, validated strictly; a malformed value throws rather than defaulting):
 *   COTAL_TEST_JOBS        positive integer, at most 64. Default max(1, min(6, cores - 1)).
 *   COTAL_TEST_TIMEOUT_MS  positive integer, at most 3600000. Per file. Default 120000.
 * Captured output is bounded per file (32 MiB); overflow kills the file and fails the run.
 *
 * Cleanup: on POSIX each child leads its own process group and every kill targets that group, so a
 * file's own descendants go with it. Windows has no groups; there the tree is killed with
 * `taskkill /T /F`. The returned promise settles only after every child has closed.
 */
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { readdirSync } from "node:fs";
import { availableParallelism } from "node:os";
import { join } from "node:path";
import { emitSentinel, parseSentinel } from "./sentinel.js";

export interface RunFilesOptions {
  /** Working directory of every child, and the base of `dir`. */
  cwd: string;
  /** Directory (relative to `cwd`) holding the `*.smoke.ts` files. */
  dir: string;
  /** Base names, in declared (output) order. */
  files: readonly string[];
  /** Files present in `dir` that are deliberately not run, each with the reason. */
  excluded: Readonly<Record<string, string>>;
  env?: NodeJS.ProcessEnv;
}

export interface FileResult {
  file: string;
  ok: boolean;
  cells: number;
  failed: number;
  ms: number;
  reason?: string;
}

const MAX_OUTPUT_BYTES = 32 * 1024 * 1024;
const KILL_GRACE_MS = 3_000;
const SUFFIX = ".smoke.ts";

function positiveInt(name: string, raw: string | undefined, fallback: number, max: number): number {
  if (raw === undefined) return fallback;
  if (!/^[1-9]\d*$/.test(raw)) throw new Error(`${name}=${JSON.stringify(raw)} is not a positive integer`);
  const n = Number(raw);
  if (!Number.isSafeInteger(n) || n > max) throw new Error(`${name}=${raw} is above the maximum ${max}`);
  return n;
}

export function defaultJobs(): number {
  return Math.max(1, Math.min(6, availableParallelism() - 1));
}

/** Refuse anything but an exact match between the declared files, the exclusions and the directory. */
export function checkSelection(opts: Pick<RunFilesOptions, "cwd" | "dir" | "files" | "excluded">): void {
  const { files, excluded } = opts;
  if (files.length === 0) throw new Error("run-files: empty file selection");
  const declared = new Set<string>();
  for (const f of files) {
    if (!f.endsWith(SUFFIX) || f.includes("/") || f.includes("\\")) throw new Error(`run-files: ${JSON.stringify(f)} is not a bare *${SUFFIX} name`);
    if (declared.has(f)) throw new Error(`run-files: duplicate entry ${f}`);
    declared.add(f);
  }
  for (const [f, reason] of Object.entries(excluded)) {
    if (!f.endsWith(SUFFIX)) throw new Error(`run-files: excluded ${JSON.stringify(f)} is not a *${SUFFIX} name`);
    if (declared.has(f)) throw new Error(`run-files: ${f} is both selected and excluded`);
    if (reason.trim() === "") throw new Error(`run-files: excluded ${f} has no reason`);
  }
  const onDisk = new Set(readdirSync(join(opts.cwd, opts.dir)).filter((n) => n.endsWith(SUFFIX)));
  const missing = files.filter((f) => !onDisk.has(f));
  const undeclared = [...onDisk].filter((f) => !declared.has(f) && !(f in excluded));
  const staleExcluded = Object.keys(excluded).filter((f) => !onDisk.has(f));
  const problems = [
    ...missing.map((f) => `declared but missing: ${f}`),
    ...undeclared.map((f) => `undeclared suite: ${f}`),
    ...staleExcluded.map((f) => `excluded but missing: ${f}`),
  ];
  if (problems.length > 0) throw new Error(`run-files: ${opts.dir} does not match the declared set\n  ${problems.join("\n  ")}`);
}

type Live = { child: ChildProcess; kill: () => void };

function killTree(child: ChildProcess, signal: NodeJS.Signals): void {
  const pid = child.pid;
  if (pid === undefined) return;
  try {
    if (process.platform === "win32") spawnSync("taskkill", ["/pid", String(pid), "/T", "/F"], { stdio: "ignore" });
    else process.kill(-pid, signal);
  } catch {
    // group already gone
  }
}

function grade(file: string, code: number | null, signal: NodeJS.Signals | null, output: string): { ok: boolean; cells: number; failed: number; reason?: string } {
  if (signal !== null) return { ok: false, cells: 0, failed: 0, reason: `killed by ${signal}` };
  if (code !== 0) return { ok: false, cells: 0, failed: 0, reason: `exit code ${code}` };
  const t = parseSentinel(output);
  if (t === null) return { ok: false, cells: 0, failed: 0, reason: "no tally in the output" };
  if (t.cells === 0) return { ok: false, cells: 0, failed: t.failed, reason: "zero cells ran" };
  if (t.failed !== 0) return { ok: false, cells: t.cells, failed: t.failed, reason: `${t.failed} cells reported failed` };
  if (t.passed !== t.cells) return { ok: false, cells: t.cells, failed: t.failed, reason: `inconsistent tally: ${t.passed} passed of ${t.cells}` };
  return { ok: true, cells: t.cells, failed: 0 };
}

export async function runFiles(opts: RunFilesOptions): Promise<{ ok: boolean; results: FileResult[] }> {
  const env = opts.env ?? process.env;
  const jobs = positiveInt("COTAL_TEST_JOBS", env.COTAL_TEST_JOBS, defaultJobs(), 64);
  const timeoutMs = positiveInt("COTAL_TEST_TIMEOUT_MS", env.COTAL_TEST_TIMEOUT_MS, 120_000, 3_600_000);
  checkSelection(opts);
  const files = [...opts.files];
  const posix = process.platform !== "win32";
  const live = new Set<Live>();
  let aborted: NodeJS.Signals | null = null;

  const results: (FileResult | undefined)[] = new Array(files.length).fill(undefined);
  const outputs: string[] = new Array(files.length).fill("");
  let printed = 0;
  const flush = (): void => {
    while (printed < files.length && results[printed] !== undefined) {
      const r = results[printed]!;
      process.stdout.write(`\n=== ${opts.dir}/${r.file}\n${outputs[printed]}`);
      if (!outputs[printed].endsWith("\n")) process.stdout.write("\n");
      const tail = r.ok ? `${r.cells} cells` : `FAILED: ${r.reason}`;
      process.stdout.write(`=== ${r.file}: ${tail} (${(r.ms / 1000).toFixed(1)}s)\n`);
      outputs[printed] = "";
      printed++;
    }
  };

  const runOne = (index: number): Promise<void> =>
    new Promise<void>((resolve) => {
      const file = files[index]!;
      const started = Date.now();
      const chunks: Buffer[] = [];
      let bytes = 0;
      let forced: string | undefined;
      let done = false;
      const child = spawn(process.execPath, ["--import", "tsx", join(opts.dir, file)], {
        cwd: opts.cwd,
        env,
        stdio: ["ignore", "pipe", "pipe"],
        detached: posix,
      });
      const entry: Live = { child, kill: () => killTree(child, "SIGKILL") };
      live.add(entry);
      let grace: NodeJS.Timeout | undefined;
      const stop = (why: string): void => {
        if (forced === undefined) forced = why;
        killTree(child, "SIGTERM");
        grace ??= setTimeout(() => killTree(child, "SIGKILL"), KILL_GRACE_MS);
      };
      const timer = setTimeout(() => stop(`TIMEOUT after ${timeoutMs}ms`), timeoutMs);
      const take = (chunk: Buffer): void => {
        if (forced !== undefined) return;
        bytes += chunk.length;
        if (bytes > MAX_OUTPUT_BYTES) {
          stop(`output exceeded ${MAX_OUTPUT_BYTES} bytes`);
          return;
        }
        chunks.push(chunk);
      };
      child.stdout!.on("data", take);
      child.stderr!.on("data", take);
      const finish = (code: number | null, signal: NodeJS.Signals | null, spawnError?: Error): void => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        if (grace !== undefined) clearTimeout(grace);
        // The leader has closed; sweep any descendant it left in its own group.
        if (posix && !spawnError) killTree(child, "SIGKILL");
        live.delete(entry);
        const output = Buffer.concat(chunks).toString("utf8");
        outputs[index] = output;
        const graded = spawnError
          ? { ok: false, cells: 0, failed: 0, reason: `spawn failed: ${spawnError.message}` }
          : forced !== undefined
            ? { ok: false, cells: 0, failed: 0, reason: forced }
            : aborted !== null
              ? { ok: false, cells: 0, failed: 0, reason: `interrupted by ${aborted}` }
              : grade(file, code, signal, output);
        results[index] = { file, ms: Date.now() - started, ...graded };
        flush();
        resolve();
      };
      child.on("error", (e) => {
        if (child.pid === undefined) finish(null, null, e);
      });
      child.on("close", (code, signal) => finish(code, signal));
    });

  // A synchronous backstop for a parent that dies without unwinding.
  const onExit = (): void => {
    for (const l of live) l.kill();
  };
  process.on("exit", onExit);
  const signals = ["SIGINT", "SIGTERM", "SIGHUP"] as const;
  const onSignal = (sig: NodeJS.Signals): void => {
    aborted ??= sig;
    for (const l of live) killTree(l.child, "SIGKILL");
  };
  const handlers = signals.map((sig) => {
    const h = (): void => onSignal(sig);
    process.on(sig, h);
    return [sig, h] as const;
  });

  let next = 0;
  const worker = async (): Promise<void> => {
    while (aborted === null && next < files.length) await runOne(next++);
  };
  try {
    await Promise.all(Array.from({ length: Math.min(jobs, files.length) }, worker));
  } finally {
    process.off("exit", onExit);
    for (const [sig, h] of handlers) process.off(sig, h);
  }
  if (aborted !== null) {
    process.stderr.write(`run-files: interrupted by ${aborted}\n`);
    process.exit(128 + ({ SIGHUP: 1, SIGINT: 2, SIGTERM: 15 } as Record<string, number>)[aborted]!);
  }

  const done = results as FileResult[];
  const failedFiles = done.filter((r) => !r.ok);
  const passed = done.reduce((n, r) => n + (r.ok ? r.cells : 0), 0);
  if (failedFiles.length > 0) {
    process.stdout.write(`\nrun-files: ${failedFiles.length} of ${done.length} files failed: ${failedFiles.map((r) => `${r.file} (${r.reason})`).join(", ")}\n`);
    return { ok: false, results: done };
  }
  emitSentinel({ passed, failed: 0 });
  return { ok: true, results: done };
}
