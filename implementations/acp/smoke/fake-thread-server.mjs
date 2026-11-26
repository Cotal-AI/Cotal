// A stand-in for a client's thread server, as T3 Code hands one to an ACP agent in `mcpServers`: a
// stdio MCP server whose `t3_thread_configure`, `t3_thread_read` and `t3_thread_update` act on one
// thread. Its first argument names the tools it lists, comma-separated (default: all three). A smoke
// drives it through files named in its environment:
//   THREAD_STATE  JSON `{ threadId, title, failRead? }`, read on every call, so a smoke renames the
//                 thread or fails its reads by rewriting it;
//   THREAD_CALLS  one JSON line per event, appended: `{ start }` with the names of the variables it
//                 started with, `{ list: true }` for each tool listing, and `{ tool, args }` per call.
// Results carry `structuredContent` and the same JSON as text, as T3's server answers.
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

const statePath = process.env.THREAD_STATE;
const callsPath = process.env.THREAD_CALLS;
const tools = (process.argv[2] ?? "t3_thread_configure,t3_thread_read,t3_thread_update").split(",");
const record = (event) => { if (callsPath) appendFileSync(callsPath, `${JSON.stringify(event)}\n`); };
const state = () => JSON.parse(readFileSync(statePath, "utf8"));
const answer = (value) => ({ structuredContent: value, content: [{ type: "text", text: JSON.stringify(value) }] });
const refuse = (message) => ({ isError: true, content: [{ type: "text", text: message }] });

record({ start: Object.keys(process.env).sort() });
const server = new Server({ name: "fake-thread-server", version: "0.0.0" }, { capabilities: { tools: {} } });
server.setRequestHandler(ListToolsRequestSchema, async () => {
  record({ list: true });
  return { tools: tools.map((name) => ({ name, inputSchema: { type: "object" } })) };
});
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args = {} } = request.params;
  record({ tool: name, args });
  const now = state();
  if (!tools.includes(name)) return refuse(`no tool ${name}`);
  if (name === "t3_thread_configure") return answer({ threadId: now.threadId, runtimeMode: "full-access" });
  if (args.threadId !== undefined && args.threadId !== now.threadId) return refuse(`Thread ${args.threadId} was not found.`);
  if (name === "t3_thread_read") {
    if (now.failRead) return refuse(now.failRead);
    return answer({ thread: { threadId: now.threadId, title: now.title }, recentRuns: [], items: [], nextPosition: null, hasMore: false });
  }
  if (args.action !== "rename" || typeof args.title !== "string") return refuse("rename requires title");
  writeFileSync(statePath, JSON.stringify({ ...now, title: args.title }));
  return answer({ threadId: now.threadId, action: "rename", title: args.title });
});
await server.connect(new StdioServerTransport());
