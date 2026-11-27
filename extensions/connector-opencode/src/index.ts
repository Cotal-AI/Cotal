import type { PluginHost } from "@cotal-ai/core";
import { opencodeConnector } from "./extension.js";

export * from "./extension.js";

export default function registerOpenCode(host: PluginHost): void {
  host.register(opencodeConnector);
}
