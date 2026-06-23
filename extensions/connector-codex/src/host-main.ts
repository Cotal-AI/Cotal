/**
 * Entry point for the Codex host-mode peer — what the `codex-app-server` connector
 * launches via tsx. Runs the embedded MeshAgent + app-server driver loop.
 */
import { runCodexHost } from "./host.js";

runCodexHost().catch((e) => {
  process.stderr.write(`[cotal-codex-host] fatal: ${(e as Error).stack ?? String(e)}\n`);
  process.exit(1);
});
