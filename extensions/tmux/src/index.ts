/** @cotal-ai/tmux — the tmux integration: a thin driver over the tmux CLI plus
 *  self-registering `tmux` Runtime and TerminalLayout providers. Importing the package
 *  registers both with the core Registry (like a connector), so the manager can spawn
 *  into tmux windows and `cotal setup` can open/close them — neither depending on this
 *  package. The driver itself stays mesh-free; launch scripts import `./driver.js`
 *  directly to avoid the registration side effect. */
export * as tmux from "./driver.js";
// importing registers the tmux runtime + terminal-layout providers
export { TmuxRuntime, tmuxRuntimeProvider, tmuxTerminalProvider } from "./runtime.js";
