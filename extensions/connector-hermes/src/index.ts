import type { PluginHost } from "@cotal-ai/core";
import { hermesConnector } from "./extension.js";

export * from "./extension.js";

export default function registerHermes(host: PluginHost): void {
  host.register(hermesConnector);
}
