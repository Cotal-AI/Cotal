/** Validate an installed replacement before releasing the daemon to its recorded supervisor. */
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { connectorConfigDir, deferredUpdateActivation, loadExtensionsManifest, logicalExecutionEntry, updateActivationBlocked } from "@cotal-ai/workspace";
import { observeExecutionVersion, selectExecutionProgram } from "../cotal.js";
import { fileURLToPath } from "node:url";

export function installedGenerationVersion(): string {
  const selected = selectExecutionProgram(dirname(packageFile()));
  const pkg = JSON.parse(readFileSync(join(selected.root, "package.json"), "utf8"));
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
  if (updateActivationBlocked()) throw new Error("an update is in progress, retry in a minute");
  const installed = installedGenerationVersion();
  if (installed !== version) throw new ReplacedDaemonGeneration(version, installed);
  try {
    const seed = join(connectorConfigDir(), "seed");
    const stamp = JSON.parse(readFileSync(join(seed, "stamp.json"), "utf8"));
    const skewed = loadExtensionsManifest().extensions.some((entry) => entry.pkg.startsWith("@cotal-ai/") && entry.version !== version);
    if (stamp?.generation === version && !skewed && !existsSync(join(seed, "reconcile.cursor.json"))) return;
  } catch (error) {
    if (!(error instanceof SyntaxError) && (error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  await reconcileInstalledGeneration();
}

function packageFile(): string {
  const logical = logicalExecutionEntry();
  if (logical) return join(dirname(dirname(logical)), "package.json");
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 4; i++, dir = dirname(dir)) {
    const path = join(dir, "package.json");
    try { if (JSON.parse(readFileSync(path, "utf8")).name === "cotal-ai") return path; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  }
  throw new Error("the daemon's CLI package is not identifiable");
}

async function reconcileInstalledGeneration(): Promise<void> {
  const file = packageFile();
  await new Promise<void>((resolve, reject) => {
    const child = spawn(process.execPath, [join(dirname(file), "dist", "cotal.js"), "ext", "seed"], { env: { ...process.env, COTAL_SKIP_CONNECTOR_SEED: "1" }, stdio: ["ignore", "ignore", "pipe", "ipc"], windowsHide: true });
    let error = "";
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk: string) => { error = (error + chunk).slice(-1500); });
    // A cold home reconciles every built-in before Manager readiness is bounded.
    const timeoutMs = 10 * 60_000;
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; child.kill("SIGKILL"); }, timeoutMs);
    child.once("error", (cause) => { clearTimeout(timer); reject(cause); });
    child.once("close", (code, signal) => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else {
        const cause = timedOut ? `timed out after ${timeoutMs}ms, signal ${signal ?? "unknown"}` : signal ? `signal ${signal}` : `exit ${code}`;
        const detail = error.trim().split(/\r?\n/).at(-1)?.replace(/\s+/g, " ").trim();
        reject(new Error(`replacement connector reconciliation failed (${cause})${detail ? `: ${detail}` : ""}`));
      }
    });
  });
}

/** Poll cheap package metadata. Expensive validation and activation attempts back off on failure. */
export function watchDaemonGeneration(version: string, changed: (version: string) => Promise<void>, report: (line: string) => void, pending: (version: string | undefined, reason?: string) => void = () => {}, activate = true): () => void {
  const file = packageFile();
  const entry = join(dirname(file), "dist", "cotal.js");
  const initialProbeMs = 5000, maxProbeMs = 60_000;
  let busy = false, closed = false, candidate: string | undefined;
  let retryAt = 0, delay = 5000, lastReport = "";
  let probeMs = initialProbeMs;
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
    try { if (updateActivationBlocked()) return; } catch { return; }
    let next: string;
    try {
      next = observeExecutionVersion(dirname(file));
    } catch { return; }
    if (next === version) { candidate = undefined; retryAt = 0; delay = 5000; probeMs = initialProbeMs; pending(undefined); return; }
    try {
      const deferred = deferredUpdateActivation(entry, next);
      if (deferred) { pending(next, deferred); announce(`daemon: installed CLI ${next} activation deferred: ${deferred}; current generation remains loaded`); return; }
    } catch { pending(next, "activation authority is unreadable; current generation remains loaded"); return; }
    if (candidate !== next) {
      candidate = next; retryAt = 0; delay = 5000; probeMs = initialProbeMs;
      const reason = activate ? "verifying the installed entry" : "no verified native launch marker; automatic activation is unavailable; use the installed CLI to restart this daemon";
      pending(next, reason);
      announce(`daemon: installed CLI generation changed to ${next}; ${reason}`);
      return;
    }
    if (!activate || Date.now() < retryAt) return;
    busy = true;
    const child = spawn(process.execPath, [entry, "--version"], { env: { ...process.env, COTAL_SKIP_CONNECTOR_SEED: "1" }, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    let output = "", settled = false, timedOut = false;
    child.stdout.on("data", (chunk) => { if (output.length < 1024) output += String(chunk); });
    child.stderr.resume();
    const budget = probeMs;
    const timeout = setTimeout(() => { timedOut = child.kill("SIGKILL"); }, budget);
    child.once("error", () => { clearTimeout(timeout); settled = true; if (!closed) failed(next, "the installed entry could not start"); });
    child.once("close", (code) => {
      clearTimeout(timeout);
      if (settled || closed) return;
      if (timedOut) {
        // A healthy cold launch can outlive the initial probe. Only a measured
        // timeout earns this generation more time, not an invalid version or exit.
        probeMs = Math.min(maxProbeMs, budget * 4);
        failed(next, `entry verification timed out after ${budget / 1000}s`);
        return;
      }
      if (code !== 0 || output.split(/\r?\n/, 1)[0] !== `cotal-ai ${next}`) { failed(next, `entry verification did not confirm its version (exit ${code})`); return; }
      try { if (updateActivationBlocked()) { busy = false; return; } } catch { busy = false; return; }
      try { if (deferredUpdateActivation(entry, next)) { busy = false; return; } } catch { busy = false; return; }
      void changed(next).catch((error: unknown) => { if (!closed) failed(next, error instanceof Error ? error.message : "the replacement could not be activated"); });
    });
  }, 1000);
  timer.unref();
  return () => { closed = true; clearInterval(timer); };
}
