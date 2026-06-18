import "./commands.js"; // self-registers the `mcp-bridge` command on import

export { McpBridge, type McpBridgeOptions } from "./bridge.js";
export { buildClientTransport, buildRemoteTransport, type McpServerSpec } from "./transport.js";
export { runOAuthLogin, FileOAuthProvider, mcpAuthDir, DEFAULT_CALLBACK_PORT } from "./oauth.js";
