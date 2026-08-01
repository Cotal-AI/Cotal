import { runCodexHost } from "./host.js";

runCodexHost().catch((e) => {
  process.stderr.write(`[cotal-codex] fatal: ${(e as Error).stack ?? String(e)}\n`);
  process.exit(1);
});
