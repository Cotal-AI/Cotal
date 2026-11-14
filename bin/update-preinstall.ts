/** Read-only pre-install entry executed only after the updater verifies this staged package. */
import { realpathSync } from "node:fs";
import { isAbsolute } from "node:path";
import { pathToFileURL } from "node:url";
import { runTargetPreinstall } from "./daemon/update-preflight.js";

export async function main(input: string | undefined): Promise<void> {
  if (!input || input.length > 64 * 1024) throw new Error("invalid target pre-install request");
  const request: unknown = JSON.parse(input);
  if (!request || typeof request !== "object" || Array.isArray(request)) throw new Error("invalid target pre-install request");
  const value = request as Record<string, unknown>;
  if (value.v !== 1 || typeof value.installedEntry !== "string" || !isAbsolute(value.installedEntry) ||
      !Array.isArray(value.daemonArgv) || !value.daemonArgv.length ||
      !value.daemonArgv.every(arg => typeof arg === "string" && !arg.includes("\0")) ||
      !value.flags || typeof value.flags !== "object" || Array.isArray(value.flags)) throw new Error("invalid target pre-install request");
  const flags = value.flags as Record<string, unknown>;
  if (Object.entries(flags).some(([key, item]) => !["space", "server", "creds", "on"].includes(key) || typeof item !== "string"))
    throw new Error("invalid target pre-install selectors");
  const installedEntry = realpathSync(value.installedEntry);
  const result = await runTargetPreinstall({ installedEntry, daemonArgv: value.daemonArgv as string[], flags });
  process.stdout.write(`COTAL_PREINSTALL_RESULT ${JSON.stringify({ v: 1, ...result })}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  try { await main(process.argv[2]); }
  catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
