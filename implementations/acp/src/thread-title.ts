/**
 * The client's own title for a thread, through a thread server the client lists in a session's
 * `mcpServers`: a stdio MCP server that offers `t3_thread_configure`, `t3_thread_read` and
 * `t3_thread_update`, as T3 Code's `t3-code` server does. The server is found by the tools it offers,
 * never by the client's name. The bridge starts each listed stdio server once per process to list its
 * tools, and closes it once the list is read unless it offers the three. It starts a server with the
 * command, arguments and environment the client gave and nothing else, so nothing of the bridge's own
 * environment, such as its sign-in, reaches it.
 */
import type { McpServer, McpServerStdio } from "@agentclientprotocol/sdk";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { DEFAULT_INHERITED_ENV_VARS, StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

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

/** Start one stdio server and connect to it. */
async function connect(server: McpServerStdio, version: string): Promise<Client> {
  const client = new Client({ name: "cotal-acp", version });
  // The SDK adds a few of the bridge's own variables, PATH and HOME among them, under the client's.
  // Node's spawn leaves out a variable whose value is undefined, so naming each that way drops them.
  const env = { ...Object.fromEntries(DEFAULT_INHERITED_ENV_VARS.map((name) => [name, undefined])), ...Object.fromEntries(server.env.map((v) => [v.name, v.value])) };
  try {
    await client.connect(new StdioClientTransport({ command: server.command, args: server.args, env: env as Record<string, string>, stderr: "ignore" }), { timeout: CONNECT_MS });
  } catch (e) {
    await client.close().catch(() => {});
    throw e;
  }
  return client;
}

/** The stdio servers sessions listed, and which of them offer the thread tools, for one bridge. */
export class ThreadServers {
  /** Whether each server offers the thread tools, by its command and arguments. The environment is
   *  left out of the key, as it carries what changes from one session to the next. */
  private readonly offers = new Map<string, Promise<boolean>>();

  constructor(private readonly version: string) {}

  /** The thread server among the servers a session lists: the first in the client's order that offers
   *  the thread tools, kept open for the session. A server that cannot be started is logged and
   *  skipped. */
  async find(servers: readonly McpServer[], log: (line: string) => void): Promise<ThreadTitles | undefined> {
    const stdio = servers.filter((s): s is McpServerStdio => "command" in s);
    const tried = await Promise.all(stdio.map((s) => this.open(s).catch((e: Error) => {
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

  /** Start `server` when it offers the thread tools, or may. Its tools are listed the first time only,
   *  and a server that does not offer them, or could not be listed, is not started again. */
  private open(server: McpServerStdio): Promise<Client | undefined> {
    const key = JSON.stringify([server.command, server.args]);
    const known = this.offers.get(key);
    if (known) return known.then((offers) => (offers ? connect(server, this.version) : undefined));
    const first = connect(server, this.version).then(async (client) => {
      try {
        const { tools } = await client.listTools(undefined, { timeout: CONNECT_MS });
        if (TOOLS.every((name) => tools.some((t) => t.name === name))) return client;
      } catch (e) {
        await client.close().catch(() => {});
        throw e;
      }
      await client.close();
      return undefined;
    });
    this.offers.set(key, first.then((client) => client !== undefined, () => false));
    return first;
  }
}

/** A session's title on the client's thread server, kept in step with its agent's name. The bridge
 *  remembers the title it last wrote or read, so its own write is never read back as a rename, and
 *  hands each new one to `remember` to store with the thread's link. Reads and writes run one at a
 *  time, so a read never sees a write half done. */
export class ClientTitle {
  private tail: Promise<unknown> = Promise.resolve();

  /** `known` is the title the thread's link stored when the bridge last wrote or read it, if any. */
  constructor(private readonly server: Promise<ThreadTitles | undefined>, private known: string | undefined, private readonly remember: (title: string) => void) {
    // A server that failed to start fails each later call, which says why.
    server.catch(() => {});
  }

  private inTurn<T>(run: () => Promise<T>): Promise<T> {
    const next = this.tail.then(run);
    this.tail = next.catch(() => {});
    return next;
  }

  /** Write `name` as the thread's title, unless the thread carries it already. A failed write leaves
   *  the title unknown, so the next read is taken as it stands rather than as a rename. */
  push(name: string): Promise<void> {
    return this.inTurn(async () => {
      const titles = await this.server;
      if (!titles || name === this.known) return;
      this.known = undefined;
      const written = await titles.write(name);
      this.known = written;
      this.remember(written);
    });
  }

  /** The thread's title when someone else changed it since the bridge last wrote or read it. With
   *  nothing known, the read is taken as it stands. */
  pull(): Promise<string | undefined> {
    return this.inTurn(async () => {
      const titles = await this.server;
      if (!titles) return undefined;
      const now = await titles.read();
      const before = this.known;
      if (now === before) return undefined;
      this.known = now;
      this.remember(now);
      return before === undefined ? undefined : now;
    });
  }

  async close(): Promise<void> {
    await (await this.server.catch(() => undefined))?.close();
  }
}
