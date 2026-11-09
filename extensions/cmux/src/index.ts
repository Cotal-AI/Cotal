/** @cotal-ai/cmux — the cmux integration: a thin driver over the cmux CLI plus a
 *  self-registering `cmux` Runtime provider. Importing the package registers it with the core
 *  Registry (like a connector), so the manager can spawn into cmux tabs without depending on
 *  this package. The driver itself stays mesh-free; launch scripts import `./driver.js`
 *  directly to avoid the registration side effect. */
export * as cmux from "./driver.js";
// importing registers the cmux runtime provider
export { CmuxRuntime, cmuxRuntimeProvider } from "./runtime.js";
