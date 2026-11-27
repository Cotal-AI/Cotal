import type { PluginHost } from "@cotal-ai/core";
import { orcaRuntimeProvider } from "./runtime.js";

export * as orca from "./driver.js";
export { OrcaRuntime, orcaRuntimeProvider } from "./runtime.js";

export default function registerOrca(host: PluginHost): void {
  host.register(orcaRuntimeProvider);
}
