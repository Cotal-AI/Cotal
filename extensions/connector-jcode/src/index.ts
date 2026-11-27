import type { PluginHost } from "@cotal-ai/core";
import { jcodeConnector } from "./extension.js";

export * from "./extension.js";
export { JCODE_READINESS_TIMEOUT_MS } from "./readiness-bound.js";

export default function registerJcode(host: PluginHost): void {
  host.register(jcodeConnector);
}
