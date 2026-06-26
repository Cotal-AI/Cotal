import { runVercelAgentPeer } from "./peer.js";

runVercelAgentPeer().catch((e: unknown) => {
  process.stderr.write(`[vercel-ai] fatal: ${(e as Error).message}\n`);
  process.exit(1);
});
