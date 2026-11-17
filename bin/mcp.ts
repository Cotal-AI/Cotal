import { registry, type Command, type FlagSpec, type FlagValues, type ParsedArgs } from "@cotal-ai/core";
import { ownStdoutErrors } from "@cotal-ai/cli/dispatch";
import { CommandFailure } from "@cotal-ai/workspace";

const flags = [
  { name: "space", type: "string", value: "<space>", description: "registered mesh to connect to" },
  { name: "wake-socket", type: "string", value: "<path>", description: "private Unix socket for background wake notifications" },
  { name: "connection", type: "string", value: "<id>", description: "wait: the connection_id returned by cotal_connect" },
] as const satisfies readonly FlagSpec[];
const usage = (message: string): CommandFailure => new CommandFailure("refused", "USAGE_INVALID", message);

async function mcp(args: ParsedArgs): Promise<void> {
  const v = args.values as FlagValues<typeof flags>;
  if (v.space !== undefined && !v.space.trim()) throw usage("--space needs a space name");
  if (v["wake-socket"] !== undefined && !v["wake-socket"].trim()) throw usage("--wake-socket needs a path");
  if (args.positionals[0] === "wait" && args.positionals.length === 1) {
    if (!v["wake-socket"] || !v.connection || !/^[a-f0-9-]{36}$/.test(v.connection))
      throw usage("mcp wait needs --wake-socket <path> and --connection <connection_id>");
    if (v.space !== undefined) throw usage("mcp wait uses its socket's connection, not --space");
    await (await import("./mcp-wake.js")).waitMcpWake(v["wake-socket"], v.connection);
    return;
  }
  if (args.positionals.length || v.connection !== undefined) throw usage("use cotal mcp [--space <space>] or cotal mcp wait --wake-socket <path> --connection <id>");

  const { createMcpHost } = await import("./mcp-host.js");
  const { serveGatewayStdio } = await import("@cotal-ai/connector-core");
  let wake: Awaited<ReturnType<typeof import("./mcp-wake.js").openMcpWake>> | undefined;
  const host = createMcpHost(v.space, (id) => wake?.released(id));
  let gateway: Awaited<ReturnType<typeof serveGatewayStdio>> | undefined;
  let finish!: () => void;
  const ended = new Promise<void>((resolve) => { finish = resolve; });
  let shutdown: Promise<void> | undefined;
  const stop = (): void => {
    shutdown ??= (async () => {
      try { await host.closeAll(); }
      catch {
        process.stderr.write("[cotal-mcp] identity retirement did not finish; saved records were retained for recovery\n");
        process.exitCode = 1;
      }
    })().catch(() => { process.exitCode = 1; }).finally(finish);
  };
  const interrupt = (): void => { process.exitCode = 130; stop(); };
  const terminate = (): void => { process.exitCode = 143; stop(); };
  const inputError = (): void => { process.exitCode = 1; stop(); };
  const releaseOutput = ownStdoutErrors(stop);
  process.once("SIGINT", interrupt);
  process.once("SIGTERM", terminate);
  process.stdin.once("end", stop);
  process.stdin.once("close", stop);
  process.stdin.once("error", inputError);
  try {
    if (v["wake-socket"]) wake = await (await import("./mcp-wake.js")).openMcpWake(v["wake-socket"], (id) => host.find("local", id));
    gateway = await serveGatewayStdio(host, { source: "mcp", selection: true, ...(wake ? { wake: wake.wake } : {}) });
    if (process.stdin.readableEnded || process.stdin.destroyed) stop();
    await ended;
  } finally {
    stop();
    const results = await Promise.allSettled([shutdown, wake?.close(), gateway?.close()]);
    if (results.some((r) => r.status === "rejected")) process.exitCode = 1;
    process.off("SIGINT", interrupt);
    process.off("SIGTERM", terminate);
    process.stdin.off("end", stop);
    process.stdin.off("close", stop);
    process.stdin.off("error", inputError);
    releaseOutput();
  }
}

const command = {
  kind: "command", name: "mcp", group: "Communication",
  summary: "serve Cotal's MCP tools to a local stdio MCP host",
  positionals: "[wait]",
  usage: "cotal mcp [--space <space>] [--wake-socket <path>] | cotal mcp wait --wake-socket <path> --connection <id>",
  flags, run: mcp,
} satisfies Command;
registry.register(command);
