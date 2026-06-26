import { runPiPeer } from "./peer.js";

runPiPeer().catch((e) => {
  process.stderr.write(`[pi-peer] fatal: ${(e as Error).message}\n`);
  process.exit(1);
});
