import { configFromEnv } from "@cotal-ai/connector-core";
import { runPiPeer } from "./peer.js";
import { runTuiClient } from "./tui-client.js";

const config = configFromEnv();
const mode = process.env.PI_PEER_MODE;
if (mode !== undefined && mode !== "" && mode !== "tui" && mode !== "headless")
  throw new Error(
    `PI_PEER_MODE must be "tui" or "headless" (got ${JSON.stringify(mode)}); unset => headless`,
  );
const entry = mode === "tui" ? runTuiClient : runPiPeer; // "headless" | unset => current path
entry(config).catch((e) => {
  process.stderr.write(`[pi-peer] fatal: ${(e as Error).message}\n`);
  process.exit(1);
});
