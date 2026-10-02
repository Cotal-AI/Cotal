import { registry, type Command } from "@cotal-ai/core";
import { linear, USAGE } from "./cli.js";

/**
 * `@cotal-ai/linear`: a bounded client for the official Linear MCP server as an operator-installed
 * CLI extension. `cotal ext add @cotal-ai/linear` makes `cotal linear` appear in help, completion
 * and dispatch. Self-registers into the shared core Registry on import.
 */
const linearCommand: Command = {
  kind: "command",
  name: "linear",
  group: "Integrations",
  summary: "Linear MCP: accounts, complete inventory, and tool calls with explicit outcomes",
  usage: USAGE,
  positionals: "<subcommand> …",
  prepareMeshTarget: false,
  flags: [
    { name: "mode", type: "string", value: "<write|readonly>", description: "account add: which Linear MCP server the account uses" },
    { name: "token-stdin", type: "boolean", description: "account add: read the API key or OAuth token from stdin and store it 0600" },
    { name: "token-file", type: "string", value: "<path>", description: "account add: use an existing 0600 file holding the token" },
    { name: "json", type: "boolean", description: "inventory: print the full inventory" },
    { name: "args", type: "string", value: "<json>", description: "call/prompt: arguments as a JSON object" },
    { name: "inventory", type: "string", value: "<digest>", description: "refuse before dispatch unless the live inventory has this digest" },
    { name: "timeout", type: "string", value: "<ms>", description: "request deadline in milliseconds (default 30000, max 120000)" },
  ],
  run: linear,
};
registry.register(linearCommand);

export { LinearUpstream, DEFAULT_LIMITS, type LinearInventory, type LinearLimits, type UpstreamReply } from "./upstream.js";
export { LINEAR_MCP_ORIGIN, LINEAR_MCP_PATHS, linearMcpUrl, type LinearMode } from "./origin.js";
export { loadAccount, type LinearAccount } from "./account.js";
export { linearClusterArtifacts, linearCommandDefs, linearContractArtifactValues, LINEAR_CAPABILITY, LINEAR_CLUSTER_URN } from "./contract.js";
