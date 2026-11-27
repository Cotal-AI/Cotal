import type { PluginHost } from "@cotal-ai/core";
import { cmuxRuntimeProvider } from "./runtime.js";

export * as cmux from "./driver.js";
export { CmuxRuntime, cmuxRuntimeProvider } from "./runtime.js";

export default function registerCmux(host: PluginHost): void {
  host.register(cmuxRuntimeProvider);
}
