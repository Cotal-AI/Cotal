import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { MeshAgent, configFromEnv, launchEnv, type AgentConfig } from "@cotal-ai/connector-core";
import { writeRpc, readJsonLines } from "./rpc-frames.js";
import { PROVIDER_KEYS } from "./connector.js";

// Resolve the `pi` wrapper the same way connector.ts resolves `tsx`: as the
// extension's own node_modules/.bin entry (pnpm provides it for the
// @earendil-works/pi-coding-agent dependency). Spawn PI_CLI directly, matching
// how the connector spawns TSX as the command.
const PI_CLI = fileURLToPath(new URL("../node_modules/.bin/pi", import.meta.url));

/**
 * Interactive mesh-driven peer — the TUI launch mode selected by `PI_PEER_MODE=tui`.
 * Spawns stock `pi --mode rpc` as a child and drives it from the mesh while rendering
 * `extension_ui_request` dialogs locally in the pane, so any pi extension that calls
 * `ctx.ui.*` (approval gates, prompts, selects, editors) becomes live and
 * operator-answerable per-pane.
 */
export async function runTuiClient(config: AgentConfig = configFromEnv()): Promise<void> {
  const mesh = new MeshAgent(config);
  mesh.start();

  const child = spawn(PI_CLI, ["--mode", "rpc", "--no-session"], {
    cwd: process.cwd(),
    stdio: ["pipe", "pipe", "pipe"],
    env: launchEnv({ providerKeys: PROVIDER_KEYS }),
  });

  let stderrBuf = "";
  child.stderr?.on("data", (d: Buffer) => { stderrBuf += d.toString(); });
  child.on("exit", (code) => {
    if (stderrBuf) process.stderr.write(`[pi-peer] child stderr:\n${stderrBuf}`);
    process.stderr.write(`[pi-peer] child exit ${code}\n`);
    process.exit(code ?? 1);
  });

  // Slice 2: prove the bridge round-trips. Send one prompt and log every stdout frame.
  // Mesh driving + local dialogs land in slice 3.
  writeRpc(child, { type: "prompt", message: "Say hello in one word." });
  for await (const frame of readJsonLines(child.stdout)) {
    process.stderr.write(`[pi-peer] ${JSON.stringify(frame)}\n`);
  }
}