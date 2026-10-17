/**
 * The Cotal tool surface for a REMOTE MCP server: one server, many conversations.
 *
 * A stdio connector is one process per session, so its tools reach the mesh through the one
 * {@link MeshAgent} that process owns. A remote server has no such anchor. A hosted MCP client such
 * as Claude pools one OAuth bearer and one MCP transport session across every conversation of an
 * account, so nothing on a request says which conversation sent it. Each conversation therefore
 * opens its own connection with `cotal_connect` and names it on every later call. A missing or
 * foreign handle refuses and runs nothing. No call falls back to the account's last, only or most
 * recent connection, because that would put one conversation's words under another's identity.
 *
 * The embedder owns everything account-shaped through {@link GatewayHost}: authentication,
 * credential issuance and revocation, and durable records. This module owns the surface and the
 * name rule.
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import { z } from "zod";
import { cotalToolSpecs, parseToolArgs, type ToolResult } from "./tool-specs.js";
import type { MeshAgent } from "./agent.js";
import type { AgentConfig } from "./config.js";

/** Thrown by {@link GatewayHost.open} when, and only when, the issuer reports that the name already
 *  exists. It is the one failure that moves `cotal_connect` to the next candidate name. An auth,
 *  quota, permission or network failure must be any other error, so it reaches the caller instead
 *  of being retried under a different name. */
export class NameTaken extends Error {
  constructor(readonly taken: string) {
    super(`name ${JSON.stringify(taken)} is taken`);
    this.name = "NameTaken";
  }
}

/** One live connection: a mesh identity serving one conversation. */
export interface GatewayConnection {
  readonly id: string;
  readonly agent: MeshAgent;
  readonly config: AgentConfig;
}

/** What the embedding service supplies. Every method receives the authenticated account, never a
 *  value a tool argument chose. */
export interface GatewayHost {
  /** The account the request authenticated as. Throw when the request carries no valid
   *  authentication; the tool then runs nothing. */
  account(auth: AuthInfo | undefined): string;
  /** Open a fresh connection for `account` named exactly `name`. Throw {@link NameTaken} only for
   *  an authoritative name collision. */
  open(account: string, name: string): Promise<GatewayConnection>;
  /** The connection `id` if `account` owns it, otherwise undefined. Never a default. */
  find(account: string, id: string): Promise<GatewayConnection | undefined>;
  /** Stop and release one connection `account` owns. False when it owns no such connection. */
  close(account: string, id: string): Promise<boolean>;
}

/** The mesh tools a remote conversation may call. Process and seat authority (spawn, despawn,
 *  persona, run, yield, reconnect) belongs to a supervised local seat and is not offered here. */
export const GATEWAY_TOOLS: ReadonlySet<string> = new Set([
  "cotal_orientation",
  "cotal_connection_status",
  "cotal_roster",
  "cotal_inbox",
  "cotal_send",
  "cotal_dm",
  "cotal_anycast",
  "cotal_status",
  "cotal_channel_info",
  "cotal_channels",
  "cotal_channel_mode",
  "cotal_join",
  "cotal_leave",
]);

/** How many names `cotal_connect` tries: the requested one, then `_2` up to this suffix. */
export const GATEWAY_NAME_ATTEMPTS = 20;

/** The names `cotal_connect` tries for `base`, in order. */
export function gatewayNames(base: string, attempts = GATEWAY_NAME_ATTEMPTS): string[] {
  return [base, ...Array.from({ length: attempts - 1 }, (_, i) => `${base}_${i + 2}`)];
}

const CONNECTION_REQUIRED =
  "CONNECTION_REQUIRED: no connection with that connection_id belongs to this account. Call cotal_connect " +
  "for this conversation and pass the connection_id it returns. Nothing was done.";

const CONNECTION_ID = z
  .string()
  .min(1)
  .describe("The connection_id cotal_connect returned in THIS conversation. Never reuse another conversation's.");

function toContent(r: ToolResult) {
  const content = [{ type: "text" as const, text: r.text }];
  return r.isError ? { content, isError: true as const } : { content };
}

const refuse = (text: string) => toContent({ text, isError: true });

function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/**
 * Register the remote surface on `server`: `cotal_connect`, `cotal_disconnect`, and each tool in
 * {@link GATEWAY_TOOLS} with a required `connection_id`.
 *
 * `template` is the configuration shape the host issues. It supplies only the advertised schemas
 * and descriptions. Each call is parsed and run against the spec built from that connection's own
 * configuration, so a connection's channels and grants decide what the call does.
 */
export function registerCotalGatewayTools(
  server: McpServer,
  host: GatewayHost,
  template: AgentConfig,
  source = "gateway",
): void {
  server.registerTool(
    "cotal_connect",
    {
      title: "Cotal: connect this conversation",
      description:
        "Join the Cotal mesh as a new agent for THIS conversation and return its connection_id. Call it once per " +
        "conversation, keep the connection_id, and pass it on every other cotal_* call. If the name is taken, the " +
        "next free name is chosen (name_2, name_3, ...) and reported. Never reuse a connection_id from another " +
        "conversation, and call this again if you no longer have this conversation's connection_id.",
      inputSchema: z.strictObject({
        name: z.string().min(1).describe("The agent name to request, for example claude_web."),
      }),
    },
    async ({ name }, extra) => {
      let account: string;
      try {
        account = host.account(extra.authInfo);
      } catch (e) {
        return refuse(`not authenticated: ${errorText(e)}`);
      }
      for (const candidate of gatewayNames(name)) {
        try {
          const c = await host.open(account, candidate);
          const renamed = candidate === name ? "" : ` (${JSON.stringify(name)} was taken)`;
          return toContent({
            text: `Connected as ${c.config.name}${renamed}.\nconnection_id: ${c.id}\nPass this connection_id on every cotal_* call in this conversation.`,
          });
        } catch (e) {
          if (e instanceof NameTaken) continue;
          return refuse(`cotal_connect failed for ${JSON.stringify(candidate)}: ${errorText(e)}`);
        }
      }
      return refuse(`cotal_connect: ${JSON.stringify(name)} and its next ${GATEWAY_NAME_ATTEMPTS - 1} variants are all taken. Choose another name.`);
    },
  );

  server.registerTool(
    "cotal_disconnect",
    {
      title: "Cotal: disconnect this conversation",
      description: "Leave the mesh for this conversation's connection. Other conversations stay connected.",
      inputSchema: z.strictObject({ connection_id: CONNECTION_ID }),
    },
    async ({ connection_id }, extra) => {
      let account: string;
      try {
        account = host.account(extra.authInfo);
      } catch (e) {
        return refuse(`not authenticated: ${errorText(e)}`);
      }
      return (await host.close(account, connection_id))
        ? toContent({ text: `Disconnected ${connection_id}.` })
        : refuse(CONNECTION_REQUIRED);
    },
  );

  for (const spec of cotalToolSpecs(template, source, undefined, GATEWAY_TOOLS)) {
    server.registerTool(
      spec.name,
      {
        title: spec.title,
        description: `${spec.description} Requires this conversation's connection_id from cotal_connect.`,
        inputSchema: spec.schema.extend({ connection_id: CONNECTION_ID }),
      },
      async (args: Record<string, unknown>, extra) => {
        const { connection_id, ...rest } = args as { connection_id: string } & Record<string, unknown>;
        let account: string;
        try {
          account = host.account(extra.authInfo);
        } catch (e) {
          return refuse(`not authenticated: ${errorText(e)}`);
        }
        const c = await host.find(account, connection_id);
        if (!c) return refuse(CONNECTION_REQUIRED);
        const own = cotalToolSpecs(c.config, source, undefined, GATEWAY_TOOLS).find((s) => s.name === spec.name);
        if (!own) return refuse(`${spec.name} is not available on this connection.`);
        try {
          return toContent(await own.run(c.agent, c.config, parseToolArgs(own, rest)));
        } catch (e) {
          return refuse(errorText(e));
        }
      },
    );
  }
}
