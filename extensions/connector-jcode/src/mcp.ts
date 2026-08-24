import { createConnection } from "node:net";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { PassThrough } from "node:stream";
import { StringDecoder } from "node:string_decoder";
import { cotalToolSpecs, parseToolArgs, type AgentConfig, type ToolResult } from "@cotal-ai/connector-core";

const MAX_REPLY_BYTES = 4 * 1024 * 1024;

function content(result: ToolResult) {
  const text = [{ type: "text" as const, text: result.text }];
  return result.isError ? { content: text, isError: true as const } : { content: text };
}

function relayConfig(): AgentConfig {
  const raw = process.env.COTAL_JCODE_MCP_CONFIG?.trim();
  if (!raw) throw new Error("jcode connector: COTAL_JCODE_MCP_CONFIG is not set");
  let config: unknown;
  try {
    config = JSON.parse(raw);
  } catch {
    throw new Error("jcode connector: COTAL_JCODE_MCP_CONFIG is not valid JSON");
  }
  if (!config || typeof config !== "object" || Array.isArray(config))
    throw new Error("jcode connector: COTAL_JCODE_MCP_CONFIG must be an object");
  return config as AgentConfig;
}

async function invoke(name: string, args: Record<string, unknown>): Promise<ToolResult> {
  const path = process.env.COTAL_JCODE_MCP_SOCKET?.trim();
  const token = process.env.COTAL_JCODE_MCP_TOKEN?.trim();
  if (!path || !token) throw new Error("jcode connector: MCP relay socket or token is missing");
  return new Promise<ToolResult>((resolve, reject) => {
    const socket = createConnection(path);
    let response = "";
    const finish = (error?: Error): void => {
      socket.destroy();
      if (error) reject(error);
    };
    socket.setEncoding("utf8");
    socket.setTimeout(30_000, () => finish(new Error(`jcode connector: ${name} relay timed out`)));
    socket.once("error", (error) => finish(new Error(`jcode connector: ${name} relay failed: ${error.message}`)));
    socket.on("data", (chunk: string) => {
      response += chunk;
      if (response.length > MAX_REPLY_BYTES) return finish(new Error(`jcode connector: ${name} relay response is too large`));
      const newline = response.indexOf("\n");
      if (newline < 0) return;
      try {
        const frame = JSON.parse(response.slice(0, newline)) as { result?: ToolResult; error?: unknown };
        if (frame.error) return finish(new Error(String(frame.error)));
        if (!frame.result || typeof frame.result.text !== "string") return finish(new Error(`jcode connector: ${name} relay returned no tool result`));
        socket.destroy();
        resolve(frame.result);
      } catch (error) {
        finish(new Error(`jcode connector: ${name} relay returned invalid JSON: ${(error as Error).message}`));
      }
    });
    socket.once("connect", () => socket.write(JSON.stringify({ token, name, args }) + "\n"));
  });
}

/** Serve cotal_* through Jcode's supported stdio MCP transport. The process has only a capability
 * to call the host's fixed tool relay; the MeshAgent and its Cotal credentials stay in the host. */
export async function runMcpBridge(): Promise<void> {
  const config = relayConfig();
  const server = new McpServer({ name: "cotal", version: "0.0.0" });
  for (const spec of cotalToolSpecs(config, "jcode")) {
    // Jcode's MCP executor injects these two harness-owned fields *before validating against the
    // advertised input schema*. The shared Cotal schema remains closed; this bridge widens only its
    // host-facing copy then removes the fields before relaying, so arbitrary arguments still fail.
    const inputSchema = spec.schema.extend({
      accept_large_output: z.boolean().optional(),
      intent: z.string().optional(),
    }).strict();
    server.registerTool(
      spec.name,
      { title: spec.title, description: spec.description, inputSchema },
      async (args: Record<string, unknown>) => {
        try {
          // Jcode currently adds `accept_large_output` / `intent` to MCP arguments. They are
          // harness metadata, not Cotal tool arguments; passing them into a closed Cotal schema
          // makes every otherwise-valid call fail before the host can enforce its own contract.
          // Validate before removing the two allowed harness fields so no other unrecognised
          // input can be silently erased by the metadata split. The raw stdio decoder rejects
          // JSON-own `__proto__` before the MCP SDK's Zod validation can drop it.
          parseToolArgs(
            { ...spec, schema: inputSchema },
            args,
          );
          const { accept_large_output: _acceptLargeOutput, intent: _intent, ...candidate } = args;
          return content(await invoke(spec.name, parseToolArgs(spec, candidate)));
        } catch (error) {
          return content({ text: `${spec.name}: ${(error as Error).message}`, isError: true });
        }
      },
    );
  }
  // Reject JSON-own prototype keys before the SDK's Zod validation. Zod reads `__proto__`
  // through Object.prototype and otherwise converts it into `{}`, which could invoke a
  // destructive default. Keep this parser deliberately narrow: all other frames flow unchanged
  // to the MCP SDK, which remains the JSON-RPC authority.
  const input = new PassThrough();
  const decoder = new StringDecoder("utf8");
  let buffered = "";
  process.stdin.on("data", (chunk: Buffer) => {
    buffered += decoder.write(chunk);
    for (;;) {
      const newline = buffered.indexOf("\n");
      if (newline < 0) return;
      const line = buffered.slice(0, newline);
      buffered = buffered.slice(newline + 1);
      if (!line) continue;
      try {
        const frame = JSON.parse(line) as { id?: unknown; method?: unknown; params?: { arguments?: unknown } };
        if (frame.method === "tools/call" && Object.hasOwn(frame.params?.arguments ?? {}, "__proto__")) {
          if (frame.id === undefined) continue;
          process.stdout.write(JSON.stringify({
            jsonrpc: "2.0",
            id: frame.id,
            result: { content: [{ type: "text", text: "cotal tool: unknown argument(s): __proto__ — the argument is not accepted" }], isError: true },
          }) + "\n");
          continue;
        }
      } catch {
        // Forward malformed frames untouched so the MCP SDK reports its protocol error.
      }
      input.write(line + "\n");
    }
  });
  process.stdin.on("end", () => {
    const final = decoder.end();
    if (final) input.write(final);
    input.end();
  });
  await server.connect(new StdioServerTransport(input, process.stdout));
}
