import type { ChildProcess } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface LoadChildOutcome {
  /** The locally spawned process; for SSH this is NOT the remote generator's pid. */
  localPid: number | null;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  output: string;
  partialResult?: unknown;
}

/** A child report is evidence, not proof that its process completed successfully. */
export class LoadChildFailure extends Error {
  constructor(message: string, readonly outcome: LoadChildOutcome) {
    super(message);
    this.name = "LoadChildFailure";
    Object.defineProperty(this, "outcome", { enumerable: false });
  }
}

/** Wait for stdio closure before accepting the report, and retain partial output on failure. */
export function collectLoadResult<T extends { clientSigning: string }>(child: ChildProcess, signing: string): Promise<T & { pid: number }> {
  return new Promise((resolve, reject) => {
    let output = "";
    let inputFailed = false;
    child.stdin?.once("error", () => { inputFailed = true; });
    const outcome = (exitCode = child.exitCode, signal = child.signalCode): LoadChildOutcome => ({
      localPid: child.pid ?? null, exitCode, signal, output,
    });
    if (!child.stdout) return reject(new LoadChildFailure("load child has no stdout pipe", outcome()));
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (data: string) => { output += data; });
    child.once("error", () => reject(new LoadChildFailure("load child failed to start", outcome())));
    child.stdout.once("error", () => reject(new LoadChildFailure("load child output failed", outcome())));
    child.once("close", (code, signal) => {
      const observed = outcome(code, signal);
      const line = output.split("\n").find((value) => value.startsWith("RESULT "));
      let parsed: unknown;
      let parsedOk = false;
      if (line !== undefined) {
        try { parsed = JSON.parse(line.slice("RESULT ".length)); parsedOk = true; observed.partialResult = parsed; }
        catch { /* The protected failure evidence keeps the raw output; never echo it in an error. */ }
      }
      if (inputFailed) return reject(new LoadChildFailure("load child input failed", observed));
      if (code !== 0 || signal !== null)
        return reject(new LoadChildFailure(`load child did not complete successfully (exit ${code}, signal ${signal ?? "none"})`, observed));
      if (line === undefined) return reject(new LoadChildFailure("load child closed with no result", observed));
      if (!parsedOk) return reject(new LoadChildFailure(`load child closed with an unparseable result (${line.length} bytes)`, observed));
      if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed) ||
          (parsed as { clientSigning?: unknown }).clientSigning !== signing)
        return reject(new LoadChildFailure("load child did not confirm the requested signing backend", observed));
      if (child.pid === undefined) return reject(new LoadChildFailure("load child has no local process identity", observed));
      resolve(Object.assign(parsed as T, { pid: child.pid }));
    });
  });
}

/** Keep failed-child evidence outside the broker's automatically removed run directory. */
export function retainLoadFailure(failure: LoadChildFailure, parent = tmpdir()): string {
  const root = mkdtempSync(join(parent, "cotal-load-failure-"));
  const file = join(root, "child.json");
  writeFileSync(file, `${JSON.stringify(failure.outcome)}\n`, { mode: 0o600, flag: "wx" });
  return file;
}
