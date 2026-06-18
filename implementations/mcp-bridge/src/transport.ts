import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import type { OAuthClientProvider } from "@modelcontextprotocol/sdk/client/auth.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";

/** One external MCP server to bridge — a local stdio child, or a remote HTTP/SSE endpoint. */
export type McpServerSpec =
  | {
      /** Logical name — namespaces tools as `<name>.<tool>` when more than one server is bridged. */
      name: string;
      command: string;
      args?: string[];
      env?: Record<string, string>;
    }
  | {
      name: string;
      url: string;
      /** Use the legacy SSE transport instead of Streamable HTTP. */
      sse?: boolean;
      /** Static headers (e.g. a bearer token) attached to every request. */
      headers?: Record<string, string>;
      /** Authenticate via OAuth (uses tokens cached by `cotal mcp-bridge login`). */
      oauth?: boolean;
    };

export const isStdioSpec = (s: McpServerSpec): s is Extract<McpServerSpec, { command: string }> =>
  "command" in s;

/** A remote transport — Streamable HTTP (preferred) or legacy SSE. Both expose `finishAuth`. */
export type RemoteTransport = StreamableHTTPClientTransport | SSEClientTransport;

/** Build a remote (HTTP/SSE) transport with optional OAuth provider + static headers. */
export function buildRemoteTransport(
  url: string,
  opts: { sse?: boolean; headers?: Record<string, string>; authProvider?: OAuthClientProvider },
): RemoteTransport {
  const u = new URL(url);
  const requestInit = opts.headers ? { headers: opts.headers } : undefined;
  return opts.sse
    ? new SSEClientTransport(u, { authProvider: opts.authProvider, requestInit })
    : new StreamableHTTPClientTransport(u, { authProvider: opts.authProvider, requestInit });
}

/** Build the MCP client transport for a spec. `authProvider` is used only for remote specs. */
export function buildClientTransport(
  spec: McpServerSpec,
  authProvider?: OAuthClientProvider,
): Transport {
  if (isStdioSpec(spec)) {
    return new StdioClientTransport({ command: spec.command, args: spec.args, env: spec.env });
  }
  return buildRemoteTransport(spec.url, { sse: spec.sse, headers: spec.headers, authProvider });
}
