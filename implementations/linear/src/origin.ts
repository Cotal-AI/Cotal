/**
 * The only network surface of this package: the official Linear MCP server, hard-pinned. There is
 * no caller-supplied URL or header anywhere; a mode picks one of two fixed paths.
 *
 * Every request goes through {@link pinnedFetch}, which refuses any other origin or path, sets the
 * bearer itself, never follows a redirect (a redirect would carry the credential somewhere else),
 * and bounds each response body BEFORE it is accumulated: a declared `content-length` over the cap
 * is refused unread, and an undeclared or streamed body errors at the first byte past the cap.
 */
import type { FetchLike } from "@modelcontextprotocol/sdk/shared/transport.js";

export const LINEAR_MCP_ORIGIN = "https://mcp.linear.app";

/** `write` is Linear's default read-write server; `readonly` only exposes read tools. */
export const LINEAR_MCP_PATHS = { write: "/mcp", readonly: "/mcp/readonly" } as const;

export type LinearMode = keyof typeof LINEAR_MCP_PATHS;

export function isLinearMode(v: unknown): v is LinearMode {
  return v === "write" || v === "readonly";
}

export function linearMcpUrl(mode: LinearMode): URL {
  return new URL(LINEAR_MCP_PATHS[mode], LINEAR_MCP_ORIGIN);
}

/** A response body crossed the per-response byte cap. The payload is discarded, never truncated. */
export class ResponseTooLargeError extends Error {
  constructor(readonly maxBytes: number) {
    super(`the Linear MCP response exceeded ${maxBytes} bytes and was discarded`);
    this.name = "ResponseTooLargeError";
  }
}

/** Refused before any byte left this process. */
export class OriginRefusedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OriginRefusedError";
  }
}

export function pinnedFetch(pinned: URL, readToken: () => string, maxBytes: number): FetchLike {
  return async (url, init) => {
    const target = new URL(typeof url === "string" ? url : url.href);
    if (target.origin !== pinned.origin || target.pathname !== pinned.pathname || target.search !== "")
      throw new OriginRefusedError(`refusing a request to ${target.origin}${target.pathname}: only ${pinned.href} is allowed`);
    const headers = new Headers(init?.headers);
    headers.set("authorization", `Bearer ${readToken()}`);
    const res = await fetch(target, { ...init, headers, redirect: "manual" });
    if (res.type === "opaqueredirect" || (res.status >= 300 && res.status < 400)) {
      await res.body?.cancel().catch(() => {});
      throw new OriginRefusedError(`refusing a ${res.status} redirect from ${pinned.href}: the credential is never forwarded`);
    }
    return boundResponse(res, maxBytes);
  };
}

function boundResponse(res: Response, maxBytes: number): Response {
  const declared = res.headers.get("content-length");
  if (declared !== null && Number(declared) > maxBytes) {
    void res.body?.cancel().catch(() => {});
    throw new ResponseTooLargeError(maxBytes);
  }
  if (!res.body) return res;
  let seen = 0;
  const counted = res.body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, ctl) {
      seen += chunk.byteLength;
      if (seen > maxBytes) {
        ctl.error(new ResponseTooLargeError(maxBytes));
      } else ctl.enqueue(chunk);
    },
  }));
  return new Response(counted, { status: res.status, statusText: res.statusText, headers: res.headers });
}
