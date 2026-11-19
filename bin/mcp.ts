/** Stock stdio MCP entry point, composed here so the CLI implementation stays adapter-independent. */
import { registry, type Command, type FlagSpec } from "@cotal-ai/core";
import { CommandFailure } from "@cotal-ai/workspace";
import { ownStdoutErrors } from "@cotal-ai/cli/dispatch";

const flags = [
  { name: "space", type: "string", value: "<name>", description: "the registered local space to connect to" },
] as const satisfies readonly FlagSpec[];

const command: Command = {
  kind: "command",
  name: "mcp",
  group: "Agents",
  summary: "serve Cotal tools over stdio for an MCP-only host",
  usage: "cotal mcp [--space <name>]",
  examples: [
    { command: "cotal mcp --space main", note: "serve the tools for the local space main" },
    { command: "cotal mcp", note: "serve them for the default space" },
  ],
  flags,
  validate(args) {
    if (args.positionals.length || (args.values.space !== undefined && !String(args.values.space).trim()))
      throw new CommandFailure("refused", "USAGE_INVALID", "usage: cotal mcp [--space <name>]");
  },
  async run(args) {
    const { GATEWAY_LISTENING, serveGatewayStdio } = await import("@cotal-ai/connector-core");
    const { createMcpHost } = await import("./mcp-host.js");
    const host = createMcpHost(args.values.space as string | undefined);
    const directConnect = "Open and static local spaces connect directly using their default persona. You can narrow its channels, role and capabilities, but cannot widen them. For a signed-in space, use its hosted connector or a native Cotal connector instead.";
    let served: Awaited<ReturnType<typeof serveGatewayStdio>> | undefined;
    let ending: Promise<void> | undefined;
    let finish!: () => void;
    const done = new Promise<void>((resolve) => { finish = resolve; });
    const end = (): Promise<void> => ending ??= (async () => {
      try { await host.closeAll(); }
      catch {
        process.stderr.write("[cotal mcp] identity cleanup is unfinished; recovery records were retained\n");
        process.exitCode = 1;
      }
      finally {
        await served?.close();
        finish();
      }
    })();
    const onEnd = (): void => { void end(); };
    const releaseOutput = ownStdoutErrors(onEnd);
    process.stdin.once("end", onEnd);
    process.stdin.once("close", onEnd);
    process.on("SIGINT", onEnd);
    process.on("SIGTERM", onEnd);
    try {
      served = await serveGatewayStdio(host, {
        source: "mcp",
        selection: true,
        instructions: `Call cotal_connect with a short name. ${directConnect} Pass the returned connection_id on every other Cotal tool call. Never reuse another conversation's connection_id. ${GATEWAY_LISTENING}`,
        connectDescription: `Connect this conversation to the local space. ${directConnect} If the name is taken, the server chooses and reports the next free name (name_2, name_3, ...). Pass the returned connection_id on every other Cotal tool call.`,
      });
      if (ending) await served.close();
      if (process.stdin.readableEnded || process.stdin.destroyed) onEnd();
      await done;
    } finally {
      await end();
      process.stdin.off("end", onEnd);
      process.stdin.off("close", onEnd);
      process.off("SIGINT", onEnd);
      process.off("SIGTERM", onEnd);
      releaseOutput();
    }
  },
};
registry.register(command);
