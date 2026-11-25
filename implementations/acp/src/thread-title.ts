/**
 * The client's own title for a thread, through a thread server the client lists in a session's
 * `mcpServers`: a stdio MCP server that offers `t3_thread_configure`, `t3_thread_read` and
 * `t3_thread_update`, as T3 Code's `t3-code` server does. The server is found by the tools it offers,
 * never by the client's name. The bridge starts each listed stdio server with the command, arguments
 * and environment the client gave, plus only the variables the MCP SDK passes by default, so nothing
 * of the bridge's own environment, such as its sign-in, reaches it. A server without the three tools
 * is closed without a call.
 */
import type { McpServer, McpServerStdio } from "@agentclientprotocol/sdk";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const TOOLS = ["t3_thread_configure", "t3_thread_read", "t3_thread_update"] as const;
/** How long one call may take. A prompt waits for a read, so this stays short. */
const CALL_MS = 5_000;
/** How long a server may take to start and list its tools. */
const CONNECT_MS = 15_000;

/** One thread's title on the client's thread server. */
export interface ThreadTitles {
  /** The title the thread carries now. */
  read(): Promise<string>;
  /** Set the thread's title. Resolves with the title it now carries. */
  write(title: string): Promise<string>;
  close(): Promise<void>;
}

/** Call one tool and return its result. A refusal rejects with the server's own words. */
async function call(client: Client, tool: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const result = await client.callTool({ name: tool, arguments: args }, undefined, { timeout: CALL_MS });
  const text = ((result.content ?? []) as { type: string; text?: string }[]).filter((p) => p.type === "text").map((p) => p.text).join("\n");
  if (result.isError) throw new Error(`${tool} failed: ${text || JSON.stringify(result.structuredContent ?? null)}`);
  const value: unknown = result.structuredContent ?? (text ? JSON.parse(text) : undefined);
  if (typeof value !== "object" || value === null) throw new Error(`${tool} answered with no result`);
  return value as Record<string, unknown>;
}

function stringAt(value: unknown, key: string, tool: string): string {
  const field = (value as Record<string, unknown> | undefined)?.[key];
  if (typeof field !== "string") throw new Error(`${tool} answered without a ${key}`);
  return field;
}

/** The thread the client's server acts on, by the id its `t3_thread_configure` read names. */
async function threadOn(client: Client): Promise<ThreadTitles> {
  const threadId = stringAt(await call(client, "t3_thread_configure", {}), "threadId", "t3_thread_configure");
  return {
    read: async () => stringAt((await call(client, "t3_thread_read", { threadId, limit: 1, maxCharsPerItem: 1 })).thread, "title", "t3_thread_read"),
    write: async (title) => stringAt(await call(client, "t3_thread_update", { threadId, action: "rename", title }), "title", "t3_thread_update"),
    close: () => client.close(),
  };
}

/** Start one stdio server and list its tools. Resolves with the client when it offers all three. */
async function offered(server: McpServerStdio, version: string): Promise<Client | undefined> {
  const client = new Client({ name: "cotal-acp", version });
  const transport = new StdioClientTransport({ command: server.command, args: server.args, env: Object.fromEntries(server.env.map((v) => [v.name, v.value])), stderr: "ignore" });
  try {
    await client.connect(transport, { timeout: CONNECT_MS });
    const { tools } = await client.listTools(undefined, { timeout: CONNECT_MS });
    if (TOOLS.every((name) => tools.some((t) => t.name === name))) return client;
  } catch (e) {
    await client.close().catch(() => {});
    throw e;
  }
  await client.close();
  return undefined;
}

/** The thread server among the servers a session lists, if one offers the thread tools. Every stdio
 *  server is tried; the first in the client's order that offers them is kept and the rest are closed.
 *  A server that cannot be started is logged and skipped. */
export async function findThreadTitles(servers: readonly McpServer[], version: string, log: (line: string) => void): Promise<ThreadTitles | undefined> {
  const stdio = servers.filter((s): s is McpServerStdio => "command" in s);
  const tried = await Promise.all(stdio.map((s) => offered(s, version).catch((e: Error) => {
    log(`MCP server ${s.name} not used: ${e.message}`);
    return undefined;
  })));
  const index = tried.findIndex((c) => c !== undefined);
  for (const [i, c] of tried.entries()) if (c && i !== index) await c.close();
  if (index < 0) return undefined;
  const client = tried[index]!;
  try {
    return await threadOn(client);
  } catch (e) {
    await client.close();
    throw new Error(`the client's thread server ${stdio[index]!.name} did not name its thread: ${(e as Error).message}`);
  }
}

/** A session's title on the client's thread server, kept in step with its agent's name. The bridge
 *  remembers the title it last wrote or read, so its own write is never read back as a rename. */
export class ClientTitle {
  /** The title the client's thread carried when the bridge last wrote or read it. */
  private known?: string;

  constructor(private readonly server: Promise<ThreadTitles | undefined>) {
    // A server that failed to start fails each later call, which says why.
    server.catch(() => {});
  }

  /** Write `name` as the thread's title, unless the thread carries it already. A failed write leaves
   *  the title unknown, so the next read is taken as it stands rather than as a rename. */
  async push(name: string): Promise<void> {
    const titles = await this.server;
    if (!titles || name === this.known) return;
    this.known = name;
    try {
      const written = await titles.write(name);
      // A later write overtook this one; its own answer sets the title.
      if (this.known === name) this.known = written;
    } catch (e) {
      if (this.known === name) this.known = undefined;
      throw e;
    }
  }

  /** The thread's title when someone else changed it since the bridge last wrote or read it. The
   *  first read the bridge makes is taken as it stands. */
  async pull(): Promise<string | undefined> {
    const titles = await this.server;
    if (!titles) return undefined;
    const now = await titles.read();
    const before = this.known;
    this.known = now;
    return before !== undefined && now !== before ? now : undefined;
  }

  async close(): Promise<void> {
    await (await this.server.catch(() => undefined))?.close();
  }
}
