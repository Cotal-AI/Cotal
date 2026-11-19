import { registry, type Command } from "@cotal-ai/core";
import { serverFlag, spaceFlag } from "@cotal-ai/workspace";
import { acp, USAGE } from "./cli.js";

/**
 * `@cotal-ai/acp`: Cotal as an ACP (Agent Client Protocol) agent, so an ACP client such as T3 Code,
 * Zed or a JetBrains IDE can spawn and drive Cotal agents. `cotal ext add @cotal-ai/acp` makes
 * `cotal acp` appear in help, completion and dispatch. Self-registers into the shared core Registry
 * on import.
 */
const acpCommand: Command = {
  kind: "command",
  name: "acp",
  group: "Integrations",
  summary: "serve Cotal as an ACP agent on stdio, for T3 Code, Zed and other ACP clients",
  usage: USAGE,
  examples: [
    { command: "cotal acp", note: "serve the ACP agent on stdin and stdout" },
    { command: "cotal acp --space <name>", note: "serve it for one space" },
    { command: "cotal acp --auth", note: "sign in, as an ACP client's terminal runs it" },
  ],
  // The agent asks managers to launch and installs nothing on this machine, so the binary refreshes
  // no connectors before it runs. A client starts this process on every provider refresh.
  reads: true,
  // The agent resolves its own space when the client first needs it, and never asks a question:
  // stdin is the protocol.
  prepareMeshTarget: false,
  flags: [
    { name: "auth", type: "boolean", description: "sign in to the space, or set one up, then exit" },
    spaceFlag,
    serverFlag,
  ],
  run: acp,
};
registry.register(acpCommand);

export { cotalAgent, COMMANDS, promptText, type CotalAgentOptions, type HiddenSessions } from "./agent.js";
export { FrameMapper, type RunSignal } from "./frames.js";
export { openLiveMesh, frameOf } from "./live-mesh.js";
export type { Mesh, AgentCatalog, ManagerChoice, SeatRef, SeatRow, SeatFrame, SpawnRequest } from "./mesh.js";
export { SignInRequired } from "./mesh.js";
