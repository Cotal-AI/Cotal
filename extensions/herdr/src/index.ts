/** @cotal-ai/herdr — the Herdr integration: a thin driver over the herdr CLI plus a
 *  self-registering `herdr` Runtime provider. Importing the package registers the provider
 *  with the core Registry (like a connector), so the manager can spawn agents into panes of
 *  a dedicated Herdr session without depending on this package. The driver itself stays
 *  mesh-free; launch scripts import `./driver.js` directly to avoid the registration
 *  side effect. */
export * as herdr from "./driver.js";
// importing registers the herdr runtime provider
export { HerdrRuntime, herdrRuntimeProvider, privateLauncher } from "./runtime.js";
