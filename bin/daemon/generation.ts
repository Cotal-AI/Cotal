/** Validate an installed replacement before releasing the daemon to its recorded supervisor. */
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

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

export function watchDaemonGeneration(version: string, changed: (version: string) => Promise<void>, report: (line: string) => void): () => void {
  const file = packageFile();
  let busy = false, closed = false;
  let candidate: string | undefined;
  const timer = setInterval(() => {
    if (busy || closed) return;
    let next: string;
    try {
      const pkg = JSON.parse(readFileSync(file, "utf8"));
      if (pkg.name !== "cotal-ai" || typeof pkg.version !== "string") return;
      next = pkg.version;
    } catch { return; } // npm may be replacing this owned path, never read a partial generation.
    if (next === version) { candidate = undefined; return; }
    if (candidate !== next) { candidate = next; report(`daemon: installed CLI generation changed to ${next}; verifying its entry`); return; }
    busy = true;
    const child = spawn(process.execPath, [join(dirname(file), "dist", "cotal.js"), "--version"], { env: { ...process.env, COTAL_SKIP_CONNECTOR_SEED: "1" }, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    let output = "";
    child.stdout.on("data", (chunk) => { if (output.length < 1024) output += String(chunk); });
    child.stderr.resume();
    const timeout = setTimeout(() => child.kill("SIGKILL"), 5000);
    child.once("error", () => { clearTimeout(timeout); busy = false; });
    child.once("close", (code) => {
      clearTimeout(timeout);
      if (closed || code !== 0 || output.split(/\r?\n/, 1)[0] !== `cotal-ai ${next}`) { if (!closed) report(`daemon: installed CLI ${next} verification did not confirm its version (exit ${code})`); busy = false; return; }
      void changed(next).catch((error: unknown) => { report(`daemon: installed CLI ${next} activation pending: ${error instanceof Error ? error.message : "the replacement could not be activated"}; current generation remains loaded and will retry automatically`); busy = false; });
    });
  }, 1000);
  timer.unref();
  return () => { closed = true; clearInterval(timer); };
}
