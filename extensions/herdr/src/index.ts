import type { PluginHost } from "@cotal-ai/core";
import { herdrRuntimeProvider } from "./runtime.js";

export * as herdr from "./driver.js";
export { HerdrRuntime, herdrRuntimeProvider, privateLauncher } from "./runtime.js";

export default function registerHerdr(host: PluginHost): void {
  host.register(herdrRuntimeProvider);
}
