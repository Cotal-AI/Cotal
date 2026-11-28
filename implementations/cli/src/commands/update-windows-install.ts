import { spawn } from "node:child_process";
import { closeSync, existsSync, fstatSync, openSync, readSync, writeFileSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { win32ProcessBinding, windowsCommandLine, windowsEnvironmentBlock } from "@cotal-ai/workspace";
import { scrubProjectedNpmrc } from "../lib/npm-reachability.js";
import { latestNotAvailable } from "./update-process.js";

interface InstallJob { file: string; args: string[]; cwd: string; log: string; verbatim: boolean; config?: string; target?: string }
const npmJob = "COTAL_WINDOWS_NPM_JOB";

function recentOutput(path: string): string {
  const fd = openSync(path, "r");
  try {
    const size = fstatSync(fd).size;
    const bytes = Buffer.alloc(Math.min(size, 1024 * 1024));
    const count = readSync(fd, bytes, 0, bytes.length, size - bytes.length);
    return bytes.toString("utf8", 0, count);
  } finally { closeSync(fd); }
}

function runNpm(job: InstallJob): void {
  delete process.env[npmJob];
  const scrub = job.config ? scrubProjectedNpmrc(job.config, process.env) : undefined;
  const child = spawn(job.file, job.args, { windowsVerbatimArguments: job.verbatim, windowsHide: true });
  if (scrub) {
    let stdout = "", stderr = "";
    child.stdout.setEncoding("utf8").on("data", chunk => { stdout += chunk; });
    child.stderr.setEncoding("utf8").on("data", chunk => { stderr += chunk; });
    child.once("close", status => {
      // The native job log gets only the displayed text, never the raw npm diagnostics.
      if (job.target && latestNotAvailable({ status, stdout, stderr }, job.target))
        writeFileSync(`${job.log}.missing-version`, "", { flag: "wx", mode: 0o600 });
      process.stdout.write(scrub(stdout)); process.stderr.write(scrub(stderr));
    });
  } else {
    child.stdout.pipe(process.stdout);
    child.stderr.pipe(process.stderr);
  }
  child.once("error", error => { process.stderr.write(`${scrub?.(error.message) ?? error.message}\n`); });
  child.once("close", status => { process.exitCode = status ?? 1; });
}

async function runJob(job: InstallJob): Promise<void> {
  try {
    const native = win32ProcessBinding();
    writeFileSync(job.log, "", { flag: "wx", mode: 0o600 });
    const commandLine = windowsCommandLine(process.execPath, [fileURLToPath(import.meta.url)]);
    native.launch({ application: process.execPath, commandLine, cwd: job.cwd, environment: windowsEnvironmentBlock({ ...process.env, [npmJob]: JSON.stringify(job) }), log: job.log });
    let status = native.rootExit();
    while (status === undefined) { await delay(100); status = native.rootExit(); }
    if (native.drain(20_000) !== "drained") throw new Error("Windows npm job did not drain");
    const output = recentOutput(job.log);
    const missingVersion = job.config ? (existsSync(`${job.log}.missing-version`) ? job.target : null) : undefined;
    const busy = (status | 0) === -4082;
    process.off("disconnect", parentGone);
    process.send?.({ status, stdout: output, stderr: "", missingVersion, ...(busy ? { error: "Windows could not replace a file in the npm installation because it is in use. Close the program holding the file, then run `cotal update --self` again." } : {}) }, () => process.disconnect());
  } catch (cause) {
    process.off("disconnect", parentGone);
    process.exitCode = 1;
    process.send?.({ status: null, stdout: "", stderr: "", error: cause instanceof Error ? cause.message : String(cause) }, () => process.disconnect());
  }
}

// The IPC connection gates launch until the updater has published this worker's identity.
const parentGone = () => process.exit(1);
if (process.send) {
  process.once("disconnect", parentGone);
  process.once("message", runJob);
} else if (process.env[npmJob]) runNpm(JSON.parse(process.env[npmJob]));
