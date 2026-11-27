import type { PluginHost } from "@cotal-ai/core";
import { claudeConnector } from "./extension.js";
import { claudeSetupProvider } from "./setup.js";

export * from "./setup.js";
export * from "./extension.js";

export default function registerClaude(host: PluginHost): void {
  host.register(claudeConnector, claudeSetupProvider);
}
