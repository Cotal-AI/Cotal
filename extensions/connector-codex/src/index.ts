import type { PluginHost } from "@cotal-ai/core";
import { codexConnector } from "./extension.js";
import { codexSetupProvider } from "./setup.js";

export * from "./setup.js";
export * from "./extension.js";

export default function registerCodex(host: PluginHost): void {
  host.register(codexConnector, codexSetupProvider);
}
