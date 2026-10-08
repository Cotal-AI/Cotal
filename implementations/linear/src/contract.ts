/**
 * The Cotal endpoint contract for one Linear MCP account: a FIXED command catalog whose envelopes
 * carry the upstream MCP values as data. Linear's tools are not republished as Cotal commands, so
 * a Linear inventory change never changes this cluster; the caller reads `inventory` and pins its
 * digest on every request, and a request against a changed inventory is refused before dispatch.
 *
 * Every command needs the one `linear.mcp` capability. That is a call permission on the endpoint,
 * not per-tool authorization: what a call can reach upstream is decided by the account's Linear
 * token and mode (`readonly` serves `/mcp/readonly`).
 *
 * `inventory` is paged so every reply fits a broker message. Each page is bounded in bytes, carries
 * every entry verbatim (an entry is never cut or dropped; one that cannot fit a reply refuses the
 * page), and returns an opaque cursor bound to the inventory digest. A cursor or pin from another
 * inventory is refused before anything is sent upstream.
 */
import {
  contractDigest,
  EpEnvelopeError,
  serviceContractTable,
  type EpCommandDef,
  type EpErrorCode,
  type EpServeContext,
} from "@cotal-ai/core";
import { renderedBytes } from "./upstream.js";
import type { LinearInventory, LinearUpstream, UpstreamReply } from "./upstream.js";

export const LINEAR_CLUSTER_URN = "ai.cotal.linear";
export const LINEAR_CAPABILITY = "linear.mcp";

const OBJECT = { type: "object" } as const;
const DIGEST = { type: "string", minLength: 1, maxLength: 128 } as const;
const TIMEOUT = { type: "integer", minimum: 1, maximum: 120000 } as const;

const SECTIONS = ["tools", "resources", "resourceTemplates", "prompts"] as const;
type Section = (typeof SECTIONS)[number];

const INVENTORY_INPUT = {
  type: "object",
  additionalProperties: false,
  properties: {
    refresh: { type: "boolean" },
    inventoryDigest: DIGEST,
    section: { enum: [...SECTIONS] },
    cursor: { type: "string", minLength: 1, maxLength: 512 },
    limit: { type: "integer", minimum: 1, maximum: 500 },
  },
} as const;

/** One page of the inventory. `summary` (server, capabilities, instructions, the capability paths
 *  this endpoint does not represent, and per-section counts) rides the first page only. Entries are
 *  the server's objects, verbatim. */
const INVENTORY_OUTPUT = {
  type: "object",
  additionalProperties: false,
  required: ["digest", "fetchedAt", "section", "start", "total", "items"],
  properties: {
    digest: DIGEST,
    fetchedAt: { type: "string" },
    summary: {
      type: "object",
      required: ["endpoint", "mode", "server", "capabilities", "unsupported", "counts", "pages", "bytes"],
      properties: {
        endpoint: { type: "string" },
        mode: { enum: ["write", "readonly"] },
        server: OBJECT,
        instructions: { type: "string" },
        capabilities: OBJECT,
        unsupported: { type: "array", items: { type: "string" } },
        counts: OBJECT,
        pages: { type: "integer", minimum: 0 },
        bytes: { type: "integer", minimum: 0 },
      },
    },
    section: { enum: [...SECTIONS] },
    start: { type: "integer", minimum: 0 },
    total: { type: "integer", minimum: 0 },
    items: { type: "array", items: OBJECT },
    nextCursor: { type: "string" },
  },
} as const;

/** Item bytes per page, and the most one reply may carry: a single entry over the page budget is
 *  sent alone, and one over the reply cap refuses rather than being cut. Both sit under the broker's
 *  default 1 MiB message size with room for the envelope. */
export const INVENTORY_PAGE_BYTES = 256 * 1024;
export const INVENTORY_REPLY_MAX_BYTES = 768 * 1024;

interface PageCursor { d: string; s: Section; i: number }

function encodeCursor(c: PageCursor): string {
  return Buffer.from(JSON.stringify(c)).toString("base64url");
}

function decodeCursor(raw: string): PageCursor {
  try {
    const c = JSON.parse(Buffer.from(raw, "base64url").toString("utf8")) as PageCursor;
    if (typeof c.d === "string" && (SECTIONS as readonly string[]).includes(c.s) && Number.isSafeInteger(c.i) && c.i >= 0) return c;
  } catch {
    // fall through
  }
  throw new EpEnvelopeError("bad-request", "the inventory cursor is not one this endpoint issued", undefined, "not-executed");
}

// Pages are composed in the size the agent tool prints, which is never smaller than the wire form.
const sizeOf = renderedBytes;

/** One bounded page of `inv`. Pure: the caller has already read the inventory. */
export function inventoryPage(inv: LinearInventory, args: { inventoryDigest?: string; section?: Section; cursor?: string; limit?: number }): Record<string, unknown> {
  const cursor = args.cursor !== undefined ? decodeCursor(args.cursor) : undefined;
  if (cursor && args.inventoryDigest !== undefined && cursor.d !== args.inventoryDigest)
    throw new EpEnvelopeError("bad-request", "the cursor and inventoryDigest name different inventories", undefined, "not-executed");
  if (cursor && args.section !== undefined && cursor.s !== args.section)
    throw new EpEnvelopeError("bad-request", "the cursor and section disagree", undefined, "not-executed");
  const pin = cursor?.d ?? args.inventoryDigest;
  if (pin !== undefined && pin !== inv.digest)
    throw new EpEnvelopeError("failed-precondition", `the inventory changed (now ${inv.digest}); read it again from the first page`,
      [{ kind: ERROR_DETAIL, reason: "stale-inventory" }], "not-executed");
  const section: Section = cursor?.s ?? args.section ?? "tools";
  const list = (inv[section] ?? []) as Record<string, unknown>[];
  const start = cursor?.i ?? 0;
  if (start > list.length) throw new EpEnvelopeError("bad-request", "the inventory cursor is past the end of its section", undefined, "not-executed");
  const limit = args.limit ?? 500;
  const summary = cursor === undefined ? {
    endpoint: inv.endpoint, mode: inv.mode, server: inv.server,
    ...(inv.instructions !== undefined ? { instructions: inv.instructions } : {}),
    capabilities: inv.capabilities, unsupported: inv.unsupported,
    counts: Object.fromEntries(SECTIONS.filter((k) => inv[k] !== undefined).map((k) => [k, (inv[k] as unknown[]).length])),
    pages: inv.pages, bytes: inv.bytes,
  } : undefined;
  let used = summary ? sizeOf(summary) : 0;
  if (used > INVENTORY_PAGE_BYTES)
    throw new EpEnvelopeError("resource-exhausted", `the inventory summary is ${used} bytes, over the ${INVENTORY_PAGE_BYTES}-byte page budget; it is not cut`, undefined, "not-executed");
  const items: Record<string, unknown>[] = [];
  let i = start;
  while (i < list.length && items.length < limit) {
    const n = sizeOf(list[i]);
    if (items.length > 0 && used + n > INVENTORY_PAGE_BYTES) break;
    if (used + n > INVENTORY_REPLY_MAX_BYTES)
      throw new EpEnvelopeError("resource-exhausted", `${section}[${i}] is ${n} bytes and cannot fit one reply; it is not cut`, undefined, "not-executed");
    items.push(list[i]!);
    used += n;
    i++;
  }
  let next: PageCursor | undefined;
  if (i < list.length) next = { d: inv.digest, s: section, i };
  else {
    const following = SECTIONS.slice(SECTIONS.indexOf(section) + 1).find((k) => (inv[k]?.length ?? 0) > 0);
    if (following) next = { d: inv.digest, s: following, i: 0 };
  }
  return {
    digest: inv.digest, fetchedAt: inv.fetchedAt, ...(summary ? { summary } : {}),
    section, start, total: list.length, items, ...(next ? { nextCursor: encodeCursor(next) } : {}),
  };
}

const CALL_TOOL_INPUT = {
  type: "object",
  additionalProperties: false,
  required: ["name", "inventoryDigest"],
  properties: { name: { type: "string", minLength: 1 }, arguments: OBJECT, inventoryDigest: DIGEST, timeoutMs: TIMEOUT },
} as const;

const READ_RESOURCE_INPUT = {
  type: "object",
  additionalProperties: false,
  required: ["uri", "inventoryDigest"],
  properties: { uri: { type: "string", minLength: 1 }, inventoryDigest: DIGEST, timeoutMs: TIMEOUT },
} as const;

const GET_PROMPT_INPUT = {
  type: "object",
  additionalProperties: false,
  required: ["name", "inventoryDigest"],
  properties: {
    name: { type: "string", minLength: 1 },
    arguments: { type: "object", additionalProperties: { type: "string" } },
    inventoryDigest: DIGEST,
    timeoutMs: TIMEOUT,
  },
} as const;

const COMPLETE_INPUT = {
  type: "object",
  additionalProperties: false,
  required: ["params", "inventoryDigest"],
  properties: { params: OBJECT, inventoryDigest: DIGEST, timeoutMs: TIMEOUT },
} as const;

/** The upstream MCP result object, verbatim (a tool result keeps `content`, `structuredContent`
 *  and `isError`), plus the inventory digest it ran against. */
const RESULT_OUTPUT = {
  type: "object",
  additionalProperties: false,
  required: ["result", "inventoryDigest"],
  properties: { result: OBJECT, inventoryDigest: DIGEST },
} as const;

type Handler = (upstream: LinearUpstream, args: Record<string, unknown>, timeoutMs: number | undefined) => Promise<unknown>;

interface CommandRow {
  name: string;
  input: unknown;
  output: unknown;
  handler: Handler;
}

const pinned = (args: Record<string, unknown>): string => args.inventoryDigest as string;

const ROWS: CommandRow[] = [
  {
    name: "inventory", input: INVENTORY_INPUT, output: INVENTORY_OUTPUT,
    handler: async (u, a, timeoutMs) => {
      // A cursor is checked before any upstream read, so a malformed one never costs a request.
      if (typeof a.cursor === "string") decodeCursor(a.cursor);
      let inv: LinearInventory;
      try {
        inv = await u.inventory({ refresh: a.refresh === true, signal: AbortSignal.timeout(timeoutMs ?? u.limits.defaultTimeoutMs) });
      } catch (e) {
        throw new EpEnvelopeError("unavailable", e instanceof Error ? e.message : "Linear discovery failed", [{ kind: ERROR_DETAIL, reason: "discovery-failed" }]);
      }
      return inventoryPage(inv, a as { inventoryDigest?: string; section?: Section; cursor?: string; limit?: number });
    },
  },
  {
    name: "call-tool", input: CALL_TOOL_INPUT, output: RESULT_OUTPUT,
    handler: async (u, a, timeoutMs) => resultOrThrow(await u.callTool({
      name: a.name as string, arguments: a.arguments as Record<string, unknown> | undefined, inventoryDigest: pinned(a), timeoutMs,
    })),
  },
  {
    name: "read-resource", input: READ_RESOURCE_INPUT, output: RESULT_OUTPUT,
    handler: async (u, a, timeoutMs) => resultOrThrow(await u.readResource({ uri: a.uri as string, inventoryDigest: pinned(a), timeoutMs })),
  },
  {
    name: "get-prompt", input: GET_PROMPT_INPUT, output: RESULT_OUTPUT,
    handler: async (u, a, timeoutMs) => resultOrThrow(await u.getPrompt({
      name: a.name as string, arguments: a.arguments as Record<string, string> | undefined, inventoryDigest: pinned(a), timeoutMs,
    })),
  },
  {
    name: "complete", input: COMPLETE_INPUT, output: RESULT_OUTPUT,
    handler: async (u, a, timeoutMs) => resultOrThrow(await u.complete({ params: a.params as Record<string, unknown>, inventoryDigest: pinned(a), timeoutMs })),
  },
];

const ERROR_DETAIL = "ai.cotal.linear.upstream";

/** Every command this contract declares, in catalog order. */
export const LINEAR_COMMANDS: readonly string[] = ROWS.map((r) => r.name);

/** Map a forwarded reply onto the endpoint reply. Only `result` succeeds; everything else is an
 *  error carrying the outcome the upstream layer established, never a stronger one. */
export function resultOrThrow(reply: UpstreamReply): { result: Record<string, unknown>; inventoryDigest: string } {
  if (reply.kind === "result") return { result: reply.result, inventoryDigest: reply.inventoryDigest };
  if (reply.kind === "refused") {
    const code: EpErrorCode = reply.reason === "queue-full" ? "resource-exhausted"
      : reply.reason === "unknown-tool" ? "not-found"
      : reply.reason === "not-advertised" ? "unimplemented"
      : reply.reason === "stale-inventory" ? "failed-precondition"
      : reply.reason === "deadline" ? "deadline-exceeded"
      : "unavailable";
    throw new EpEnvelopeError(code, reply.detail, [{ kind: ERROR_DETAIL, reason: reply.reason }], "not-executed");
  }
  if (reply.kind === "protocol-error") {
    const code: EpErrorCode = reply.code === -32602 ? "bad-request" : reply.code === -32601 ? "unimplemented" : "internal";
    throw new EpEnvelopeError(code, `Linear MCP error ${reply.code}: ${reply.message}`,
      [{ kind: ERROR_DETAIL, reason: "protocol-error", mcpCode: reply.code, ...(reply.data !== undefined ? { data: reply.data } : {}) }], reply.outcome);
  }
  const code: EpErrorCode = reply.reason === "timeout" ? "deadline-exceeded"
    : reply.reason === "cancelled" ? "cancelled"
    : reply.reason === "output-too-large" || reply.reason === "rate-limited" ? "resource-exhausted"
    : reply.reason === "unauthenticated" || reply.reason === "permission-denied" ? "failed-precondition"
    : "unavailable";
  // A post-dispatch failure keeps its outcome; the code only says which kind of failure it was.
  throw new EpEnvelopeError(code, reply.detail, [{ kind: ERROR_DETAIL, reason: reply.reason }], reply.outcome);
}

const TABLE = serviceContractTable(ROWS);

function closureDigestOfSource(root: unknown): string {
  return contractDigest({ v: 1, root: contractDigest(root), members: [] });
}

/** Every contract artifact a registration publishes: each distinct schema root and its manifest. */
export const linearContractArtifactValues = TABLE.artifactValues;

export function linearClusterDocument() {
  return {
    urn: LINEAR_CLUSTER_URN,
    revision: 1,
    attributes: [] as unknown[],
    events: [] as unknown[],
    commands: ROWS.map((r) => ({
      name: r.name,
      class: "ephemeral" as const,
      targeted: false,
      capability: LINEAR_CAPABILITY,
      inputDigest: closureDigestOfSource(r.input),
      outputDigest: closureDigestOfSource(r.output),
    })),
  };
}

export function linearClusterArtifacts(): {
  document: ReturnType<typeof linearClusterDocument>;
  rootDigest: string;
  manifest: { v: 1; root: string; members: string[] };
  closureDigest: string;
} {
  const document = linearClusterDocument();
  const rootDigest = contractDigest(document);
  const manifest = { v: 1 as const, root: rootDigest, members: [] as string[] };
  return { document, rootDigest, manifest, closureDigest: contractDigest(manifest) };
}

/** The `EpCommandDef[]` `serveEndpoint` consumes. The call deadline bounds the upstream request. */
export function linearCommandDefs(upstream: LinearUpstream): EpCommandDef[] {
  return ROWS.map((r) => ({
    command: r.name,
    contract: TABLE.contracts[r.name],
    handler: (ctx: EpServeContext) => {
      const args = (ctx.request.args ?? {}) as Record<string, unknown>;
      const requested = typeof args.timeoutMs === "number" ? args.timeoutMs : undefined;
      // Leave the reply a second of the caller's budget to travel back.
      const deadline = ctx.request.deadlineMs !== undefined ? Math.max(1, ctx.request.deadlineMs - 1000) : undefined;
      const timeoutMs = requested !== undefined && deadline !== undefined ? Math.min(requested, deadline) : requested ?? deadline;
      return r.handler(upstream, args, timeoutMs);
    },
  }));
}
