/**
 * A minimal stdio MCP server used by mcp-bridge.smoke.ts — one `echo` tool.
 * Low-level Server API so the fixture needs no extra deps beyond the MCP SDK.
 */
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { ListToolsRequestSchema, CallToolRequestSchema } from "@modelcontextprotocol/sdk/types.js";

const server = new Server(
  { name: "echo-fixture", version: "0.0.0" },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "echo",
      description: "Echo back the message.",
      inputSchema: {
        type: "object",
        properties: { message: { type: "string" } },
        required: ["message"],
      },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const message = String(req.params.arguments?.message ?? "");
  return { content: [{ type: "text", text: message }] };
});

await server.connect(new StdioServerTransport());
