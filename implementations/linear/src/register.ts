import "./service-adapter.js";
import { registry, type Command } from "@cotal-ai/core";
import { jsonFlag, plainFlag, serverFlag, spaceFlag } from "@cotal-ai/workspace";
import { linearForms, validateLinearArguments, USAGE } from "./arguments.js";

const linearCommand: Command = {
  kind: "command",
  name: "linear",
  group: "Integrations",
  summary: "Linear MCP: accounts, inventory, tool calls, and a registered Linear endpoint for agents",
  usage: USAGE,
  positionals: "<subcommand> …",
  prepareMeshTarget: false,
  reads: true,
  outputs: ["json", "plain"],
  subcommands: [
    { name: "account", summary: "record an explicit account or read its metadata", reads: true, prepareMeshTarget: false, outputs: ["json", "plain"], flagNames: ["json", "plain"], subcommands: linearForms.filter((form) => form.path[0] === "account").map((form) => ({ name: form.path[1]!, summary: form.summary, usage: form.usage, flagNames: [...form.flags], outputs: [...form.outputs], ...(form.reads ? { reads: true as const } : {}), prepareMeshTarget: false as const })) },
    ...linearForms.filter((form) => form.path.length === 1).map((form) => ({ name: form.path[0], summary: form.summary, usage: form.usage, flagNames: [...form.flags], outputs: [...form.outputs], ...(form.reads ? { reads: true as const } : {}), prepareMeshTarget: false as const })),
  ],
  validate: validateLinearArguments,
  flags: [
    { name: "mode", type: "string", value: "<write|readonly>", description: "account add: which Linear MCP server the account uses" },
    { name: "token-stdin", type: "boolean", description: "account add: read the API key or OAuth token from stdin and store it 0600" },
    { name: "token-file", type: "string", value: "<path>", description: "account add: use an existing 0600 file holding the token" },
    jsonFlag, plainFlag,
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
  async run(args) { await (await import("./cli.js")).linear(args); },
};

registry.register(linearCommand);
