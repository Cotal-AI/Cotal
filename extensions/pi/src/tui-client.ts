import { configFromEnv, type AgentConfig } from "@cotal-ai/connector-core";

/**
 * Interactive mesh-driven peer — the TUI launch mode selected by
 * `PI_PEER_MODE=tui`. Spawns `pi --mode rpc` as a child and drives it from the
 * mesh while rendering `extension_ui_request` dialogs locally in the pane, so
 * any pi extension that calls `ctx.ui.*` (approval gates, prompts, selects,
 * editors) becomes live and operator-answerable per-pane.
 */
export async function runTuiClient(_config: AgentConfig = configFromEnv()): Promise<void> {
  throw new Error("PI_PEER_MODE=tui: not implemented");
}