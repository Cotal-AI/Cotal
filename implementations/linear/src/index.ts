import { registry, type Command } from "@cotal-ai/core";
import { serverFlag, spaceFlag } from "@cotal-ai/workspace";
import { linear, USAGE } from "./cli.js";

/**
 * `@cotal-ai/linear`: the official Linear MCP server as a registered Cotal endpoint, plus the
 * operator commands that set it up, as an operator-installed CLI extension. `cotal ext add
 * @cotal-ai/linear` makes `cotal linear` appear in help, completion and dispatch. Self-registers
 * into the shared core Registry on import.
 */
const linearCommand: Command = {
  kind: "command",
  name: "linear",
  group: "Integrations",
  summary: "Linear MCP: accounts, inventory, tool calls, and a registered Linear endpoint for agents",
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
    { name: "endpoint", type: "string", value: "<name>", description: "serve/caller: the reverse-DNS endpoint name, in a namespace you own" },
    { name: "out", type: "string", value: "<path>", description: "caller: write the caller credential here (0600, never printed)" },
    { name: "channels", type: "string", value: "<a,b>", description: "caller: channels the caller seat may read and post" },
    { name: "expires-in", type: "string", value: "<s>", description: "caller: credential lifetime in seconds" },
    spaceFlag,
    serverFlag,
  ],
  run: linear,
};
registry.register(linearCommand);

export { LinearUpstream, DEFAULT_LIMITS, type LinearInventory, type LinearLimits, type UpstreamReply } from "./upstream.js";
export { LINEAR_MCP_ORIGIN, LINEAR_MCP_PATHS, linearMcpUrl, type LinearMode } from "./origin.js";
export { loadAccount, type LinearAccount } from "./account.js";
export { inventoryPage, linearClusterArtifacts, linearCommandDefs, linearContractArtifactValues, INVENTORY_PAGE_BYTES, INVENTORY_REPLY_MAX_BYTES, LINEAR_CAPABILITY, LINEAR_CLUSTER_URN, LINEAR_COMMANDS } from "./contract.js";
export {
  assertLinearEndpointName,
  linearCallerCapabilities,
  provisionLinearCaller,
  registerLinearEndpoint,
  renewalDelayMs,
  runLinearEndpoint,
  type LinearEndpointHandle,
  type LinearRegistration,
  type LinearServeBundle,
} from "./serve.js";
