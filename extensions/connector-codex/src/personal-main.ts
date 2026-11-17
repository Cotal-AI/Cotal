import { serveCodexPersonal } from "./personal.js";

serveCodexPersonal().catch((e) => {
  process.stderr.write(`[cotal-codex] fatal: ${(e as Error).stack ?? String(e)}\n`);
  process.exit(1);
});
