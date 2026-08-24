import { createConnection } from "node:net";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { cotalToolSpecs, parseToolArgs, type AgentConfig, type ToolResult } from "@cotal-ai/connector-core";

const MAX_REPLY_BYTES = 4 * 1024 * 1024;

/**
 * The MCP SDK's stock transport parses raw JSON through Zod before dispatch. Zod drops a
 * JSON-own `__proto__` key while coercing the JSON-RPC envelope, turning hostile input into an
 * empty argument object. Reject that key while it is still raw JSON; all other framing and
 * validation stays in the SDK transport.
 */
class ClosedStdioServerTransport extends StdioServerTransport {
  private buffer = "";

  override async start(): Promise<void> {
    if ((this as unknown as { _started: boolean })._started)
      throw new Error("StdioServerTransport already started!");
    (this as unknown as { _started: boolean })._started = true;
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", this.read);
    process.stdin.on("error", this.onError);
  }

  override async close(): Promise<void> {
    process.stdin.off("data", this.read);
    process.stdin.off("error", this.onError);
    if (process.stdin.listenerCount("data") === 0) process.stdin.pause();
    (this as unknown as { _readBuffer: { clear(): void } })._readBuffer.clear();
    this.onclose?.();
  }

  private onError = (error: Error): void => this.onerror?.(error);

  private read = (chunk: string): void => {
    this.buffer += chunk;
    for (;;) {
      const newline = this.buffer.indexOf("\n");
      if (newline < 0) return;
      const line = this.buffer.slice(0, newline);
      this.buffer = this.buffer.slice(newline + 1);
      if (!line) continue;
      try {
        const frame = JSON.parse(line) as { id?: unknown; method?: unknown; params?: { arguments?: unknown } };
        if (frame.method === "tools/call" && Object.hasOwn(frame.params?.arguments ?? {}, "__proto__")) {
          if (frame.id !== undefined)
            void this.send({
              jsonrpc: "2.0",
              id: frame.id as never,
              result: { content: [{ type: "text", text: "cotal tool: unknown argument(s): __proto__ — the argument is not accepted" }], isError: true },
            } as never);
          continue;
        }
      } catch {
        // The SDK receives malformed frames and reports the protocol error.
      }
      const readBuffer = (this as unknown as { _readBuffer: { append(chunk: Buffer): void; readMessage(): unknown } })._readBuffer;
      readBuffer.append(Buffer.from(line + "\n"));
      for (;;) {
        try {
          const message = readBuffer.readMessage();
          if (message === null) break;
          this.onmessage?.(message as never);
        } catch (error) {
          this.onerror?.(error as Error);
        }
      }
    }
  };
}

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
  await server.connect(new ClosedStdioServerTransport());
}
