import { spawn } from "node:child_process";
import { resolve } from "node:path";

export interface EndpointCallerCLIInput {
  cwd: string;
  env: NodeJS.ProcessEnv;
  node?: string;
  /** A packed entry may be supplied by a separately qualified installation witness. Omitted uses
   * the source composition root and must not be reported as installed-package acceptance. */
  cli?: string;
}
export interface EndpointCallerCLIResult {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

/** Known child only. The existing authority fixture owns its broker, IdP, account projection,
 * client session and protected deployment installation. This helper supplies none of them. */
export async function runEndpointCallerCLI(input: EndpointCallerCLIInput, args: string[]): Promise<EndpointCallerCLIResult> {
  const entry = input.cli ?? resolve(input.cwd, "bin/cotal.ts");
  const argv = input.cli ? [entry, ...args] : ["--import", "tsx", entry, ...args];
  const child = spawn(input.node ?? process.execPath, argv, {
    cwd: input.cwd, env: input.env, stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "", stderr = "", timedOut = false;
  child.stdout.on("data", bytes => { stdout += bytes; });
  child.stderr.on("data", bytes => { stderr += bytes; });
  const timer = setTimeout(() => { timedOut = true; child.kill("SIGKILL"); }, 30000);
  try {
    const result = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((accept, reject) => {
      child.once("error", reject);
      child.once("close", (code, signal) => accept({ code, signal }));
    });
    return { ...result, stdout, stderr, timedOut };
  } finally {
    clearTimeout(timer);
  }
}
