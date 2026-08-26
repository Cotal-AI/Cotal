import { createConnection } from "node:net";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { ReadBuffer, serializeMessage } from "@modelcontextprotocol/sdk/shared/stdio.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { JSONRPCMessage, RequestId } from "@modelcontextprotocol/sdk/types.js";
import { cotalToolSpecs, parseToolArgs, type AgentConfig, type ToolResult } from "@cotal-ai/connector-core";

const MAX_REPLY_BYTES = 4 * 1024 * 1024;

/**
 * The MCP SDK's stock transport parses raw JSON through Zod before dispatch. Zod drops a
 * JSON-own `__proto__` key while coercing the JSON-RPC envelope, turning hostile input into an
 * empty argument object. Reject that key while it is still raw JSON; all other framing and
 * validation stays in the SDK transport.
 */
class ClosedStdioServerTransport implements Transport {
  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: Transport["onmessage"];
  private readonly input = new ReadBuffer();
  private raw = Buffer.alloc(0);
  private started = false;

  async start(): Promise<void> {
    if (this.started) throw new Error("ClosedStdioServerTransport already started!");
    this.started = true;
    process.stdin.on("data", this.read);
    process.stdin.on("error", this.onError);
  }

  async close(): Promise<void> {
    process.stdin.off("data", this.read);
    process.stdin.off("error", this.onError);
    if (process.stdin.listenerCount("data") === 0) process.stdin.pause();
    this.input.clear();
    this.onclose?.();
  }

  async send(message: JSONRPCMessage): Promise<void> {
    await new Promise<void>((resolve) => {
      if (process.stdout.write(serializeMessage(message))) resolve();
      else process.stdout.once("drain", resolve);
    });
  }

  private onError = (error: Error): void => this.onerror?.(error);

  private rejectPrototypeKey(id: unknown): void {
    if (typeof id !== "string" && typeof id !== "number") return;
    void this.send({
      jsonrpc: "2.0",
      id: id as RequestId,
      result: { content: [{ type: "text", text: "cotal tool: unknown argument(s): __proto__ — the argument is not accepted" }], isError: true },
    });
  }

  private dispatch(line: Buffer): void {
    this.input.append(Buffer.concat([line, Buffer.from("\n")]));
    for (;;) {
      try {
        const message = this.input.readMessage();
        if (message === null) return;
        this.onmessage?.(message);
      } catch (error) {
        this.onerror?.(error as Error);
      }
    }
  }

  private read = (chunk: Buffer): void => {
    this.raw = Buffer.concat([this.raw, chunk]);
    for (;;) {
      const newline = this.raw.indexOf(0x0a);
      if (newline < 0) return;
      const line = this.raw.subarray(0, newline);
      this.raw = this.raw.subarray(newline + 1);
      if (line.length === 0) continue;
      try {
        const frame = JSON.parse(line.toString("utf8")) as { id?: unknown; method?: unknown; params?: { arguments?: unknown } };
        if (frame.method === "tools/call" && Object.hasOwn(frame.params?.arguments ?? {}, "__proto__")) {
          this.rejectPrototypeKey(frame.id);
          continue;
        }
      } catch {
        // The SDK receives malformed frames and reports the protocol error.
      }
      this.dispatch(line);
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
