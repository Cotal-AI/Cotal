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
  flags,
  validate(args) {
    if (args.positionals.length || (args.values.space !== undefined && !String(args.values.space).trim()))
      throw new CommandFailure("refused", "USAGE_INVALID", "usage: cotal mcp [--space <name>]");
  },
  async run(args) {
    const { serveGatewayStdio } = await import("@cotal-ai/connector-core");
    const { createMcpHost } = await import("./mcp-host.js");
    const host = createMcpHost(args.values.space as string | undefined);
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
      served = await serveGatewayStdio(host, { source: "mcp", selection: true });
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
