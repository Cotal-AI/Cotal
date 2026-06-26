import { runOpenAIAgentPeer } from "./peer.js";

runOpenAIAgentPeer().catch((e) => {
  process.stderr.write(`[openai-peer] fatal: ${(e as Error).message}\n`);
  process.exit(1);
});
