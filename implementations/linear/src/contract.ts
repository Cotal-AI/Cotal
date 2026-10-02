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
 * This module is pure data, schema and reply mapping. Registering and serving the cluster needs a
 * registration credential for a third-party endpoint name, which the mesh does not issue yet.
 */
import {
  compileContract,
  contractDigest,
  EpEnvelopeError,
  type CompiledContract,
  type EpCommandDef,
  type EpErrorCode,
  type EpServeContext,
} from "@cotal-ai/core";
import type { LinearUpstream, UpstreamReply } from "./upstream.js";

export const LINEAR_CLUSTER_URN = "ai.cotal.linear";
export const LINEAR_CAPABILITY = "linear.mcp";

const OBJECT = { type: "object" } as const;
const DIGEST = { type: "string", minLength: 1, maxLength: 128 } as const;
const TIMEOUT = { type: "integer", minimum: 1, maximum: 120000 } as const;

const INVENTORY_INPUT = {
  type: "object",
  additionalProperties: false,
  properties: { refresh: { type: "boolean" } },
} as const;

/** The inventory as the server sent it. Tool, resource and prompt entries are verbatim objects. */
const INVENTORY_OUTPUT = {
  type: "object",
  required: ["endpoint", "mode", "server", "capabilities", "tools", "unsupported", "pages", "bytes", "fetchedAt", "digest"],
  properties: {
    endpoint: { type: "string" },
    mode: { enum: ["write", "readonly"] },
    server: OBJECT,
    instructions: { type: "string" },
    capabilities: OBJECT,
    tools: { type: "array", items: OBJECT },
    resources: { type: "array", items: OBJECT },
    resourceTemplates: { type: "array", items: OBJECT },
    prompts: { type: "array", items: OBJECT },
    unsupported: { type: "array", items: { type: "string" } },
    pages: { type: "integer", minimum: 0 },
    bytes: { type: "integer", minimum: 0 },
    fetchedAt: { type: "string" },
    digest: DIGEST,
  },
} as const;

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
    handler: (u, a) => u.inventory({ refresh: a.refresh === true }),
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

/** Map a forwarded reply onto the endpoint reply. Only `result` succeeds; everything else is an
 *  error carrying the outcome the upstream layer established, never a stronger one. */
export function resultOrThrow(reply: UpstreamReply): { result: Record<string, unknown>; inventoryDigest: string } {
  if (reply.kind === "result") return { result: reply.result, inventoryDigest: reply.inventoryDigest };
  if (reply.kind === "refused") {
    const code: EpErrorCode = reply.reason === "queue-full" ? "resource-exhausted"
      : reply.reason === "unknown-tool" ? "not-found"
      : reply.reason === "not-advertised" ? "unimplemented"
      : reply.reason === "stale-inventory" ? "failed-precondition"
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
  throw new EpEnvelopeError(code, reply.detail, [{ kind: ERROR_DETAIL, reason: reply.reason }], reply.outcome);
}

type ContractPair = { input: CompiledContract; output: CompiledContract };
const COMPILED = new Map<string, ContractPair>();

function pairFor(r: CommandRow): ContractPair {
  let pair = COMPILED.get(r.name);
  if (!pair) {
    pair = { input: compileContract({ root: r.input as Record<string, unknown> }), output: compileContract({ root: r.output as Record<string, unknown> }) };
    COMPILED.set(r.name, pair);
  }
  return pair;
}

function closureDigestOfSource(root: unknown): string {
  return contractDigest({ v: 1, root: contractDigest(root), members: [] });
}

/** Every contract artifact a registration publishes: each distinct schema root and its manifest. */
export function linearContractArtifactValues(): unknown[] {
  const values: unknown[] = [];
  const seen = new Set<string>();
  for (const r of ROWS) {
    for (const source of [r.input, r.output]) {
      const rootDigest = contractDigest(source);
      if (seen.has(rootDigest)) continue;
      seen.add(rootDigest);
      values.push(source, { v: 1, root: rootDigest, members: [] });
    }
  }
  return values;
}

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
    contract: pairFor(r),
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
