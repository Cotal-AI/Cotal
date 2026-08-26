import { runMcpBridge } from "./mcp.js";

runMcpBridge().catch((error) => {
  process.stderr.write(`[cotal-jcode] fatal: ${(error as Error).message}\n`);
  process.exit(1);
});
