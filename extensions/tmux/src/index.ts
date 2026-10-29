/** @cotal-ai/tmux — the tmux integration: a thin driver over the tmux CLI plus a
 *  self-registering `tmux` Runtime provider. Importing the package registers it with the core
 *  Registry (like a connector), so the manager can spawn into tmux windows without depending on
 *  this package. The driver itself stays mesh-free; launch scripts import `./driver.js`
 *  directly to avoid the registration side effect. */
export * as tmux from "./driver.js";
// importing registers the tmux runtime provider
export { TmuxRuntime, tmuxRuntimeProvider } from "./runtime.js";
