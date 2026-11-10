/** Validate an installed replacement before releasing the daemon to its recorded supervisor. */
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { globalConfigDir } from "@cotal-ai/core";
import { fileURLToPath } from "node:url";

export function installedGenerationVersion(): string {
  const pkg = JSON.parse(readFileSync(packageFile(), "utf8"));
  if (typeof pkg.version !== "string" || !pkg.version) throw new Error("the daemon's CLI version is not identifiable");
  return pkg.version;
}

export class ReplacedDaemonGeneration extends Error {
  constructor(readonly loaded: string, readonly installed: string) {
    super(`daemon loaded CLI ${loaded}, but the installed CLI is ${installed}; refusing to launch a hosted Manager from the replaced installation`);
    this.name = "ReplacedDaemonGeneration";
  }
}

export async function reconcileHostedConnectors(version: string): Promise<void> {
  const installed = installedGenerationVersion();
  if (installed !== version) throw new ReplacedDaemonGeneration(version, installed);
  try {
    const stamp = JSON.parse(readFileSync(join(globalConfigDir(), "seed", "stamp.json"), "utf8"));
    if (stamp?.generation === version) return;
  } catch (error) {
    if (!(error instanceof SyntaxError) && (error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  await reconcileInstalledGeneration();
}

function packageFile(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 4; i++, dir = dirname(dir)) {
    const path = join(dir, "package.json");
    try { if (JSON.parse(readFileSync(path, "utf8")).name === "cotal-ai") return path; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  }
  throw new Error("the daemon's CLI package is not identifiable");
}

export async function reconcileInstalledGeneration(): Promise<void> {
  const file = packageFile();
  await new Promise<void>((resolve, reject) => {
    const child = spawn(process.execPath, [join(dirname(file), "dist", "cotal.js"), "ext", "seed"], { env: { ...process.env, COTAL_SKIP_CONNECTOR_SEED: "1" }, stdio: ["ignore", "ignore", "pipe"], windowsHide: true });
    let error = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => { error = (error + chunk).slice(-1500); });
    const timer = setTimeout(() => child.kill("SIGKILL"), 120_000);
    child.once("error", (cause) => { clearTimeout(timer); reject(cause); });
    child.once("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new Error(`replacement connector reconciliation failed (exit ${code}): ${error.trim()}; run cotal ext seed --repair with the installed CLI`));
    });
  });
}

/** Poll cheap package metadata. Expensive validation and activation attempts back off on failure. */
export function watchDaemonGeneration(version: string, changed: (version: string) => Promise<void>, report: (line: string) => void, pending: (version: string | undefined, reason?: string) => void = () => {}, activate = true): () => void {
  const file = packageFile();
  let busy = false, closed = false, candidate: string | undefined;
  let retryAt = 0, delay = 5000, lastReport = "";
  const announce = (line: string) => { if (line !== lastReport) { lastReport = line; report(line); } };
  const failed = (next: string, reason: string) => {
    pending(next, reason);
    announce(`daemon: installed CLI ${next} activation pending: ${reason}; current generation remains loaded and will retry automatically`);
    retryAt = Date.now() + delay;
    delay = Math.min(300_000, delay * 2);
    busy = false;
  };
  const timer = setInterval(() => {
    if (busy || closed) return;
    let next: string;
    try {
      const pkg = JSON.parse(readFileSync(file, "utf8"));
      if (pkg.name !== "cotal-ai" || typeof pkg.version !== "string") return;
      next = pkg.version;
    } catch { return; }
    if (next === version) { candidate = undefined; retryAt = 0; delay = 5000; pending(undefined); return; }
    if (candidate !== next) {
      candidate = next; retryAt = 0; delay = 5000;
      const reason = activate ? "verifying the installed entry" : "no verified native launch marker; automatic activation is unavailable; use the installed CLI to restart this daemon";
      pending(next, reason);
      announce(`daemon: installed CLI generation changed to ${next}; ${reason}`);
      return;
    }
    if (!activate || Date.now() < retryAt) return;
    busy = true;
    const child = spawn(process.execPath, [join(dirname(file), "dist", "cotal.js"), "--version"], { env: { ...process.env, COTAL_SKIP_CONNECTOR_SEED: "1" }, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    let output = "", settled = false;
    child.stdout.on("data", (chunk) => { if (output.length < 1024) output += String(chunk); });
    child.stderr.resume();
    const timeout = setTimeout(() => child.kill("SIGKILL"), 5000);
    child.once("error", () => { clearTimeout(timeout); settled = true; if (!closed) failed(next, "the installed entry could not start"); });
    child.once("close", (code) => {
      clearTimeout(timeout);
      if (settled || closed) return;
      if (code !== 0 || output.split(/\r?\n/, 1)[0] !== `cotal-ai ${next}`) { failed(next, `entry verification did not confirm its version (exit ${code})`); return; }
      void changed(next).catch((error: unknown) => { if (!closed) failed(next, error instanceof Error ? error.message : "the replacement could not be activated"); });
    });
  }, 1000);
  timer.unref();
  return () => { closed = true; clearInterval(timer); };
}
