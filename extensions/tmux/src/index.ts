import type { PluginHost } from "@cotal-ai/core";
import { tmuxRuntimeProvider } from "./runtime.js";

export * as tmux from "./driver.js";
export { TmuxRuntime, tmuxRuntimeProvider } from "./runtime.js";

export default function registerTmux(host: PluginHost): void {
  host.register(tmuxRuntimeProvider);
}
