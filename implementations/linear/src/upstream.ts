/**
 * One bounded MCP client session against the pinned Linear MCP server, for one account.
 *
 * DISCOVERY is complete or it fails: the negotiated server capabilities, then every page of
 * `tools/list`, and, only when advertised, every page of `resources/list`,
 * `resources/templates/list` and `prompts/list`. Cursors are opaque and passed back verbatim. Pages
 * and total bytes are capped across the whole inventory, and crossing a cap refuses the inventory
 * rather than returning part of it. Names, descriptions, schemas and annotations are kept exactly as
 * the server sent them. The inventory carries a digest so a caller can pin the context it read.
 *
 * Capabilities this package does not represent (resource subscriptions, logging, experimental and
 * anything unknown) are listed in `unsupported`, never dropped silently. This client declares no
 * client capabilities, so the server has no sampling, elicitation or roots to call back into.
 *
 * DISPATCH never retries. Once a request has been handed to the transport, a timeout, a caller
 * cancellation, a response over the byte cap, a lost session (HTTP 404) or any transport failure is
 * reported with outcome `unknown`: the tool may or may not have run, and that holds for read-only
 * tools too. A tool result with `isError: true` is an ordinary MCP result and is returned as such. A
 * JSON-RPC error from the server is a protocol error, kept apart from both. `not-executed` is only
 * claimed for refusals made before dispatch (queue full, unknown tool, stale inventory pin, the
 * deadline expiring while queued, discovering or connecting). An HTTP 401/403/429 answer to a
 * dispatched request is `unknown` too: the MCP transport gives no proof that the server did not act.
 *
 * One deadline bounds the whole operation: the slot wait, discovery, connect and the call itself.
 * Errors carry a status or a class, never response text, and the bearer is scrubbed from anything
 * the server sent back before it leaves this module.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport, StreamableHTTPError } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import {
  CallToolResultSchema,
  CompleteResultSchema,
  ErrorCode,
  GetPromptResultSchema,
  ListPromptsResultSchema,
  ListResourcesResultSchema,
  ListResourceTemplatesResultSchema,
  ListToolsResultSchema,
  McpError,
  PromptListChangedNotificationSchema,
  ReadResourceResultSchema,
  ResourceListChangedNotificationSchema,
  ToolListChangedNotificationSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { contractDigest } from "@cotal-ai/core";
import type { LinearAccount } from "./account.js";
import { credentialFor, type LinearCredential } from "./oauth.js";
import { linearMcpUrl, OriginRefusedError, pinnedFetch, ResponseTooLargeError } from "./origin.js";

export interface LinearLimits {
  /** Cap on one HTTP response body, checked before it is accumulated. */
  maxResponseBytes: number;
  /** Cap on the summed bytes of every discovery page. */
  maxInventoryBytes: number;
  /** Cap on the number of discovery pages across all lists. */
  maxInventoryPages: number;
  /** Upstream requests in flight at once. */
  maxConcurrent: number;
  /** Requests allowed to wait for a slot; one more is refused before dispatch. */
  maxQueued: number;
  /** Default and ceiling for one request's deadline. */
  defaultTimeoutMs: number;
  maxTimeoutMs: number;
  /** An inventory older than this is read again before the next request, for servers that do not
   *  send list-changed notifications. */
  maxInventoryAgeMs: number;
}

export const DEFAULT_LIMITS: LinearLimits = {
  maxResponseBytes: 512 * 1024,
  maxInventoryBytes: 4 * 1024 * 1024,
  maxInventoryPages: 200,
  maxConcurrent: 8,
  maxQueued: 32,
  defaultTimeoutMs: 30_000,
  maxTimeoutMs: 120_000,
  maxInventoryAgeMs: 15 * 60_000,
};

type Json = Record<string, unknown>;

export interface LinearInventory {
  endpoint: string;
  mode: LinearAccount["mode"];
  server: { name?: string; version?: string };
  instructions?: string;
  /** The server's capabilities object, verbatim. */
  capabilities: Json;
  tools: Json[];
  resources?: Json[];
  resourceTemplates?: Json[];
  prompts?: Json[];
  /** Capability paths the server advertised that this package does not represent. */
  unsupported: string[];
  pages: number;
  bytes: number;
  fetchedAt: string;
  /** Digest over everything above except `pages`, `bytes` and `fetchedAt`. */
  digest: string;
}

export type Outcome = "not-executed" | "unknown";

/** The result of one forwarded request. `result` covers tool results whose `isError` is true. */
export type UpstreamReply =
  | { kind: "result"; result: Json; inventoryDigest: string }
  | { kind: "protocol-error"; code: number; message: string; data?: unknown; outcome: Outcome }
  | { kind: "refused"; reason: "queue-full" | "unknown-tool" | "not-advertised" | "stale-inventory" | "discovery-failed" | "deadline" | "closed"; detail: string; outcome: "not-executed" }
  | {
      kind: "failed";
      reason: "timeout" | "cancelled" | "output-too-large" | "session-expired" | "unauthenticated" | "permission-denied" | "rate-limited" | "transport";
      detail: string;
      outcome: Outcome;
    };

/** Paths in the server capability object that this package represents. */
const REPRESENTED = new Set([
  "tools", "tools.listChanged",
  "resources", "resources.listChanged",
  "prompts", "prompts.listChanged",
  "completions",
]);

function capabilityPaths(caps: Json, prefix = ""): string[] {
  const out: string[] = [];
  for (const [k, v] of Object.entries(caps)) {
    const path = prefix ? `${prefix}.${k}` : k;
    out.push(path);
    if (v && typeof v === "object" && !Array.isArray(v) && path !== "experimental") out.push(...capabilityPaths(v as Json, path));
  }
  return out;
}

class Slots {
  private active = 0;
  private readonly waiting: Array<() => void> = [];
  constructor(private readonly max: number, private readonly maxQueued: number) {}
  /** Resolves with a release function, `null` when the queue is full, or rejects with the
   *  signal's reason when it aborts while waiting (the waiter leaves the queue). */
  async acquire(signal?: AbortSignal): Promise<(() => void) | null> {
    signal?.throwIfAborted();
    if (this.active < this.max) this.active++;
    else if (this.waiting.length >= this.maxQueued) return null;
    // A released slot is handed straight to the next waiter, so `active` never overshoots.
    else
      await new Promise<void>((resolve, reject) => {
        const wake = (): void => {
          signal?.removeEventListener("abort", onAbort);
          resolve();
        };
        const onAbort = (): void => {
          const i = this.waiting.indexOf(wake);
          if (i >= 0) this.waiting.splice(i, 1);
          reject(signal!.reason);
        };
        this.waiting.push(wake);
        signal?.addEventListener("abort", onAbort, { once: true });
      });
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const next = this.waiting.shift();
      if (next) next();
      else this.active--;
    };
  }
}

/** Reject when `signal` aborts, without leaving a listener behind. */
function bounded<T>(p: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => reject(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
    p.then(
      (v) => { signal.removeEventListener("abort", onAbort); resolve(v); },
      (e) => { signal.removeEventListener("abort", onAbort); reject(e); },
    );
  });
}

class DeadlineError extends Error {
  constructor() {
    super("the request deadline expired before dispatch");
    this.name = "DeadlineError";
  }
}

export class LinearUpstream {
  private client?: Client;
  private transport?: StreamableHTTPClientTransport;
  private connecting?: Promise<Client>;
  private current?: LinearInventory;
  private stale = true;
  private closed = false;
  /** Aborts every queued or in-flight operation on {@link close}. */
  private readonly closing = new AbortController();
  private readonly slots: Slots;
  private readonly url: URL;
  private readonly credential: LinearCredential;

  constructor(readonly account: LinearAccount, readonly limits: LinearLimits = DEFAULT_LIMITS) {
    this.url = linearMcpUrl(account.mode);
    this.credential = credentialFor(account);
    this.slots = new Slots(limits.maxConcurrent, limits.maxQueued);
  }

  private async session(signal: AbortSignal): Promise<Client> {
    if (this.closed) throw new Error("the Linear upstream is closed");
    if (this.client) return this.client;
    this.connecting ??= this.connect().finally(() => (this.connecting = undefined));
    return bounded(this.connecting, signal);
  }

  private async connect(): Promise<Client> {
    const transport = new StreamableHTTPClientTransport(this.url, {
      fetch: pinnedFetch(this.url, () => this.credential.bearer(), this.limits.maxResponseBytes),
      // Resuming a dropped stream is not a re-dispatch, but this client still never reconnects on its own.
      reconnectionOptions: { maxRetries: 0, initialReconnectionDelay: 1000, maxReconnectionDelay: 1000, reconnectionDelayGrowFactor: 1 },
    });
    const client = new Client({ name: "cotal-linear", version: "1" }, { capabilities: {} });
    const markStale = async (): Promise<void> => {
      this.stale = true;
    };
    client.setNotificationHandler(ToolListChangedNotificationSchema, markStale);
    client.setNotificationHandler(ResourceListChangedNotificationSchema, markStale);
    client.setNotificationHandler(PromptListChangedNotificationSchema, markStale);
    client.onclose = () => this.drop(client);
    try {
      await client.connect(transport, { timeout: this.limits.defaultTimeoutMs });
    } catch (e) {
      await client.close().catch(() => {});
      throw e;
    }
    this.client = client;
    this.transport = transport;
    // A new session may negotiate differently, so the inventory is re-read before the next call.
    this.stale = true;
    return client;
  }

  /** Forget a session the server ended or that failed. Its in-flight requests reject. */
  private drop(client: Client): void {
    if (this.client !== client) return;
    this.client = undefined;
    this.transport = undefined;
    this.stale = true;
    void client.close().catch(() => {});
  }

  /** Complete discovery. Refuses on any cap rather than returning a partial inventory. `signal`
   *  bounds the whole read, including the slot wait and connect. */
  async inventory(opts: { refresh?: boolean; signal?: AbortSignal } = {}): Promise<LinearInventory> {
    const fresh = this.current && Date.now() - Date.parse(this.current.fetchedAt) < this.limits.maxInventoryAgeMs;
    if (this.current && fresh && !this.stale && !opts.refresh) return this.current;
    const signal = AbortSignal.any([this.closing.signal, opts.signal ?? AbortSignal.timeout(this.limits.maxTimeoutMs)]);
    const release = await this.slots.acquire(signal);
    if (!release) throw new Error("the Linear upstream queue is full");
    try {
      await bounded(this.credential.prepare(), signal);
      const client = await this.session(signal);
      const caps = (client.getServerCapabilities() ?? {}) as unknown as Json;
      const version = client.getServerVersion();
      let pages = 0;
      let bytes = 0;
      const timeout = this.limits.defaultTimeoutMs;
      const drain = async (
        method: string,
        schema: typeof ListToolsResultSchema | typeof ListResourcesResultSchema | typeof ListResourceTemplatesResultSchema | typeof ListPromptsResultSchema,
        key: string,
      ): Promise<Json[]> => {
        const items: Json[] = [];
        const seen = new Set<string>();
        let cursor: string | undefined;
        do {
          if (++pages > this.limits.maxInventoryPages) throw new Error(`Linear discovery exceeded ${this.limits.maxInventoryPages} pages; refusing a partial inventory`);
          const page = (await client.request({ method, params: cursor === undefined ? {} : { cursor } } as never, schema, { timeout, signal })) as unknown as Json;
          bytes += Buffer.byteLength(JSON.stringify(page));
          if (bytes > this.limits.maxInventoryBytes) throw new Error(`Linear discovery exceeded ${this.limits.maxInventoryBytes} bytes; refusing a partial inventory`);
          const list = page[key];
          if (!Array.isArray(list)) throw new Error(`${method} returned no ${key} array`);
          items.push(...(list as Json[]));
          const next = page.nextCursor;
          if (next !== undefined && typeof next !== "string") throw new Error(`${method} returned a non-string cursor`);
          if (next !== undefined && seen.has(next)) throw new Error(`${method} repeated a cursor; refusing a looping inventory`);
          if (next !== undefined) seen.add(next);
          cursor = next;
        } while (cursor !== undefined);
        return items;
      };
      // Mark fresh before reading, so a list_changed that lands mid-read leaves it stale.
      this.stale = false;
      const tools = caps.tools ? await drain("tools/list", ListToolsResultSchema, "tools") : [];
      const resources = caps.resources ? await drain("resources/list", ListResourcesResultSchema, "resources") : undefined;
      const resourceTemplates = caps.resources ? await drain("resources/templates/list", ListResourceTemplatesResultSchema, "resourceTemplates") : undefined;
      const prompts = caps.prompts ? await drain("prompts/list", ListPromptsResultSchema, "prompts") : undefined;
      const names = new Set<string>();
      for (const t of tools) {
        if (typeof t.name !== "string") throw new Error("tools/list returned a tool with no name");
        if (names.has(t.name)) throw new Error(`tools/list returned the tool name "${t.name}" twice`);
        names.add(t.name);
      }
      const body = {
        endpoint: this.url.href,
        mode: this.account.mode,
        server: { ...(version?.name !== undefined ? { name: version.name } : {}), ...(version?.version !== undefined ? { version: version.version } : {}) },
        ...(client.getInstructions() !== undefined ? { instructions: client.getInstructions() } : {}),
        capabilities: caps,
        tools,
        ...(resources ? { resources } : {}),
        ...(resourceTemplates ? { resourceTemplates } : {}),
        ...(prompts ? { prompts } : {}),
        unsupported: capabilityPaths(caps).filter((p) => !REPRESENTED.has(p)),
      };
      const inv: LinearInventory = { ...body, pages, bytes, fetchedAt: new Date().toISOString(), digest: contractDigest(JSON.parse(JSON.stringify(body))) };
      this.current = inv;
      return inv;
    } catch (e) {
      this.stale = true;
      if (e instanceof StreamableHTTPError && e.code === 404 && this.client) this.drop(this.client);
      throw new Error(this.describeError(e));
    } finally {
      release();
    }
  }

  /** Forward `tools/call`. `inventoryDigest`, when given, must match the live inventory. */
  async callTool(req: { name: string; arguments?: Json; inventoryDigest?: string; timeoutMs?: number; signal?: AbortSignal }): Promise<UpstreamReply> {
    return this.forward(req, (inv) => {
      if (!inv.tools.some((t) => t.name === req.name)) return `the tool "${req.name}" is not in the current inventory`;
    }, { method: "tools/call", params: { name: req.name, ...(req.arguments !== undefined ? { arguments: req.arguments } : {}) } }, CallToolResultSchema);
  }

  async readResource(req: { uri: string; inventoryDigest?: string; timeoutMs?: number; signal?: AbortSignal }): Promise<UpstreamReply> {
    return this.forward(req, (inv) => (inv.capabilities.resources ? undefined : "the server does not advertise resources"),
      { method: "resources/read", params: { uri: req.uri } }, ReadResourceResultSchema, "not-advertised");
  }

  async getPrompt(req: { name: string; arguments?: Record<string, string>; inventoryDigest?: string; timeoutMs?: number; signal?: AbortSignal }): Promise<UpstreamReply> {
    return this.forward(req, (inv) => (inv.prompts?.some((p) => p.name === req.name) ? undefined : `the prompt "${req.name}" is not in the current inventory`),
      { method: "prompts/get", params: { name: req.name, ...(req.arguments ? { arguments: req.arguments } : {}) } }, GetPromptResultSchema, "not-advertised");
  }

  async complete(req: { params: Json; inventoryDigest?: string; timeoutMs?: number; signal?: AbortSignal }): Promise<UpstreamReply> {
    return this.forward(req, (inv) => (inv.capabilities.completions ? undefined : "the server does not advertise completions"),
      { method: "completion/complete", params: req.params }, CompleteResultSchema, "not-advertised");
  }

  private async forward(
    req: { inventoryDigest?: string; timeoutMs?: number; signal?: AbortSignal },
    precheck: (inv: LinearInventory) => string | undefined,
    request: { method: string; params: Json },
    schema: typeof CallToolResultSchema | typeof ReadResourceResultSchema | typeof GetPromptResultSchema | typeof CompleteResultSchema,
    absentReason: "unknown-tool" | "not-advertised" = "unknown-tool",
  ): Promise<UpstreamReply> {
    if (this.closed) return { kind: "refused", reason: "closed", detail: "the Linear upstream is closed", outcome: "not-executed" };
    const timeoutMs = Math.min(req.timeoutMs ?? this.limits.defaultTimeoutMs, this.limits.maxTimeoutMs);
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) throw new Error(`timeoutMs must be a positive integer`);
    // ONE deadline for the whole operation: queueing, discovery, connect and the call.
    const ctl = new AbortController();
    let why: "timeout" | "cancelled" | undefined;
    const timer = setTimeout(() => {
      why ??= "timeout";
      ctl.abort(new DeadlineError());
    }, timeoutMs);
    const onCancel = (): void => {
      why ??= "cancelled";
      ctl.abort(new Error("cancelled"));
    };
    req.signal?.addEventListener("abort", onCancel, { once: true });
    this.closing.signal.addEventListener("abort", onCancel, { once: true });
    if (req.signal?.aborted || this.closing.signal.aborted) onCancel();
    const notDispatched = (): UpstreamReply => why === "timeout"
      ? { kind: "refused", reason: "deadline", detail: "the deadline expired before the request was sent", outcome: "not-executed" }
      : { kind: "refused", reason: "closed", detail: "cancelled before the request was sent", outcome: "not-executed" };
    let release: (() => void) | null | undefined;
    try {
      // Discovery happens before dispatch: a stale or never-read inventory is re-read first. The
      // request itself has not been sent if discovery fails.
      let inv: LinearInventory;
      try {
        inv = await this.inventory({ signal: ctl.signal });
        await bounded(this.credential.prepare(), ctl.signal);
      } catch (e) {
        if (ctl.signal.aborted) return notDispatched();
        return { kind: "refused", reason: "discovery-failed", detail: `Linear discovery failed: ${this.describeError(e)}`, outcome: "not-executed" };
      }
      if (req.inventoryDigest !== undefined && req.inventoryDigest !== inv.digest)
        return { kind: "refused", reason: "stale-inventory", detail: `the inventory changed (now ${inv.digest}); read it again before calling`, outcome: "not-executed" };
      const absent = precheck(inv);
      if (absent) return { kind: "refused", reason: absentReason, detail: absent, outcome: "not-executed" };
      try {
        release = await this.slots.acquire(ctl.signal);
      } catch {
        return notDispatched();
      }
      if (!release) return { kind: "refused", reason: "queue-full", detail: "the Linear upstream queue is full", outcome: "not-executed" };
      const client = this.client;
      if (!client) return { kind: "refused", reason: "discovery-failed", detail: "the MCP session ended after discovery; read the inventory again", outcome: "not-executed" };
      if (ctl.signal.aborted) return notDispatched();
      // From here the request is handed to the transport. The SDK sends notifications/cancelled
      // when the signal aborts; its own timeout sits past ours.
      const result = (await client.request(request as never, schema, { signal: ctl.signal, timeout: timeoutMs + 5_000 })) as unknown as Json;
      return { kind: "result", result, inventoryDigest: inv.digest };
    } catch (e) {
      return this.classify(e, why);
    } finally {
      clearTimeout(timer);
      req.signal?.removeEventListener("abort", onCancel);
      this.closing.signal.removeEventListener("abort", onCancel);
      release?.();
    }
  }

  /** A failure as a status or class, with the bearer scrubbed. Response bodies are never kept. */
  private describeError(e: unknown): string {
    if (e instanceof StreamableHTTPError) return `HTTP ${e.code ?? "error"} from the Linear MCP server`;
    if (e instanceof OriginRefusedError || e instanceof ResponseTooLargeError || e instanceof DeadlineError) return e.message;
    if (e instanceof McpError) return this.scrub(`MCP error ${e.code}: ${e.message}`);
    return this.scrub(e instanceof Error ? `${e.name}: ${e.message}` : "an unexpected failure");
  }

  /** Remove the current bearer from text the server or a library produced. */
  private scrub(text: string): string {
    let token: string | undefined;
    try {
      token = this.credential.bearer();
    } catch {
      token = undefined;
    }
    return token && token.length >= 8 ? text.split(token).join("[redacted]") : text;
  }

  private scrubValue(v: unknown): unknown {
    if (typeof v === "string") return this.scrub(v);
    if (Array.isArray(v)) return v.map((x) => this.scrubValue(x));
    if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, this.scrubValue(x)]));
    return v;
  }

  private classify(e: unknown, why: "timeout" | "cancelled" | undefined): UpstreamReply {
    const detail = this.describeError(e);
    if (e instanceof OriginRefusedError) return { kind: "failed", reason: "transport", detail, outcome: "not-executed" };
    if (why) return { kind: "failed", reason: why, detail: `${why} after dispatch; the request may or may not have run`, outcome: "unknown" };
    // Attributed only when THIS request's own response crossed the cap. A streamed overflow on
    // another request's stream ends that request, not this one.
    if (e instanceof ResponseTooLargeError)
      return { kind: "failed", reason: "output-too-large", detail: `the response exceeded ${this.limits.maxResponseBytes} bytes and was discarded; the request may have run`, outcome: "unknown" };
    if (e instanceof StreamableHTTPError) {
      const status = e.code;
      if (status === 404) {
        if (this.client) this.drop(this.client);
        return { kind: "failed", reason: "session-expired", detail: "the MCP session expired; the call is not retried and may have run", outcome: "unknown" };
      }
      if (status === 401) return { kind: "failed", reason: "unauthenticated", detail, outcome: "unknown" };
      if (status === 403) return { kind: "failed", reason: "permission-denied", detail, outcome: "unknown" };
      if (status === 429) return { kind: "failed", reason: "rate-limited", detail, outcome: "unknown" };
      return { kind: "failed", reason: "transport", detail, outcome: "unknown" };
    }
    if (e instanceof McpError) {
      if (e.code === ErrorCode.RequestTimeout) return { kind: "failed", reason: "timeout", detail, outcome: "unknown" };
      if (e.code === ErrorCode.ConnectionClosed) return { kind: "failed", reason: "transport", detail, outcome: "unknown" };
      return { kind: "protocol-error", code: e.code, message: this.scrub(e.message), ...(e.data !== undefined ? { data: this.scrubValue(e.data) } : {}), outcome: "unknown" };
    }
    return { kind: "failed", reason: "transport", detail, outcome: "unknown" };
  }

  /** Close the session and end it upstream, within `graceMs`. Queued requests refuse before
   *  dispatch; in-flight ones are cancelled and report `unknown`. */
  async close(graceMs = 5_000): Promise<void> {
    this.closed = true;
    this.closing.abort(new Error("the Linear upstream is closing"));
    const transport = this.transport;
    const client = this.client;
    this.client = undefined;
    this.transport = undefined;
    const grace = AbortSignal.timeout(graceMs);
    if (transport?.sessionId) await bounded(transport.terminateSession(), grace).catch(() => {});
    await bounded(client?.close() ?? Promise.resolve(), grace).catch(() => {});
  }
}
