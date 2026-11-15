import { realpathSync } from "node:fs";
import { isAbsolute } from "node:path";
import { pathToFileURL } from "node:url";
import { readExecutionPreinstall, type ExecutionPreinstallRequest } from "./daemon/execution-preinstall.js";

/** A declared side-effect-free entry, not ordinary CLI startup or connector reconciliation. */
export async function executionPreinstall(input: string | undefined): Promise<void> {
  if (!input || Buffer.byteLength(input) > 64 * 1024) throw new Error("invalid execution pre-install request");
  const request = JSON.parse(input) as ExecutionPreinstallRequest;
  if (!request || request.v !== 1 || typeof request.nonce !== "string" || !/^[a-f0-9]{32}$/.test(request.nonce) ||
      typeof request.installedEntry !== "string" || !isAbsolute(request.installedEntry) ||
      !Array.isArray(request.daemonArgv) || request.daemonArgv.length < 2 || request.daemonArgv.some(item => typeof item !== "string" || item.includes("\0")) ||
      !request.flags || typeof request.flags !== "object" || Array.isArray(request.flags) ||
      Object.entries(request.flags).some(([key, value]) => !["space", "server", "creds", "on"].includes(key) || typeof value !== "string"))
    throw new Error("invalid execution pre-install request");
  const result = await readExecutionPreinstall({ ...request, installedEntry: realpathSync(request.installedEntry) });
  process.stdout.write(`COTAL_PREINSTALL_RESULT ${JSON.stringify({ v: 1, nonce: request.nonce, installedEntry: request.installedEntry, ...result })}\n`);
}

if (process.argv[1] && pathToFileURL(realpathSync(process.argv[1])).href === import.meta.url) {
  try { await executionPreinstall(process.argv[2]); }
  catch (error) { process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`); process.exitCode = 1; }
}
