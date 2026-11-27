import { registry, type Command } from "@cotal-ai/core";
import { serverFlag, spaceFlag } from "@cotal-ai/workspace";
import { t3Provider } from "./setup/t3.js";
import { zedProvider } from "./setup/zed.js";

const acpCommand: Command = {
  kind: "command",
  name: "acp",
  group: "Integrations",
  summary: "serve Cotal as an ACP agent on stdio, for T3 Code, Zed and other ACP clients",
  usage: "cotal acp [--space <name>] [--server <url>] | cotal acp --auth [--space <name>]",
  examples: [
    { command: "cotal acp", note: "serve the ACP agent on stdin and stdout" },
    { command: "cotal acp --space <name>", note: "serve it for one space" },
    { command: "cotal acp --auth", note: "sign in, as an ACP client's terminal runs it" },
  ],
  // ACP clients start this process on refresh. It spawns through the Manager, not local seed.
  reads: true,
  // The agent resolves the space on the first request. stdin belongs to the protocol.
  prepareMeshTarget: false,
  flags: [
    { name: "auth", type: "boolean", description: "sign in to the space, or set one up, then exit" },
    spaceFlag,
    serverFlag,
  ],
  async run(args) { await (await import("./cli.js")).acp(args); },
};

registry.register(acpCommand, t3Provider, zedProvider);
