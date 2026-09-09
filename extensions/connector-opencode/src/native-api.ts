/** Bounded access to an existing OpenCode server. This client never launches a server,
 * creates/deletes a session, installs a plugin, or changes provider credentials. */
export interface OpenCodeNativeSession {
  readonly id: string;
  readonly projectID: string;
  readonly directory: string;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly parentID?: string;
  readonly archivedAt?: number;
}

export interface OpenCodeNativeStatus {
  readonly type: "idle" | "busy" | "retry";
}

export interface OpenCodeNativeApiOptions {
  readonly endpoint: string;
  readonly username?: string;
  readonly password?: string;
  readonly timeoutMs?: number;
  readonly maxResponseBytes?: number;
}

export type OpenCodeNativeErrorCode =
  | "invalid-config" | "invalid-session" | "transport" | "timeout" | "cancelled"
  | "unauthorized" | "not-found" | "http-error" | "response-too-large" | "invalid-response";

export class OpenCodeNativeApiError extends Error {
  constructor(readonly code: OpenCodeNativeErrorCode, readonly status?: number) {
    super(`OpenCode native API: ${code}${status === undefined ? "" : ` (HTTP ${status})`}`);
    this.name = "OpenCodeNativeApiError";
  }
}

const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const text = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0 && value.length <= 8192;
const timestamp = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

function sessionId(value: unknown): string {
  if (typeof value !== "string" || !/^ses_[A-Za-z0-9]+$/.test(value) || value.length > 256)
    throw new OpenCodeNativeApiError("invalid-session");
  return value;
}

function parseSession(value: unknown): OpenCodeNativeSession {
  if (!object(value) || !text(value.projectID) || !text(value.directory) || !object(value.time)
    || !timestamp(value.time.created) || !timestamp(value.time.updated)
    || (value.time.archived !== undefined && !timestamp(value.time.archived)))
    throw new OpenCodeNativeApiError("invalid-response");
  return {
    id: sessionId(value.id),
    projectID: value.projectID,
    directory: value.directory,
    createdAt: value.time.created,
    updatedAt: value.time.updated,
    ...(value.parentID === undefined ? {} : { parentID: sessionId(value.parentID) }),
    ...(value.time.archived === undefined ? {} : { archivedAt: value.time.archived as number }),
  };
}

export class OpenCodeNativeApi {
  readonly endpoint: string;
  readonly #authorization?: string;
  readonly #timeoutMs: number;
  readonly #maxResponseBytes: number;

  constructor(options: OpenCodeNativeApiOptions) {
    let endpoint: URL;
    try { endpoint = new URL(options.endpoint); }
    catch { throw new OpenCodeNativeApiError("invalid-config"); }
    if (!["http:", "https:"].includes(endpoint.protocol) || endpoint.username || endpoint.password
      || endpoint.search || endpoint.hash || endpoint.pathname !== "/")
      throw new OpenCodeNativeApiError("invalid-config");
    // A native password must not cross a plaintext remote network. Remote providers use HTTPS.
    if (endpoint.protocol === "http:" && !["127.0.0.1", "[::1]", "localhost"].includes(endpoint.hostname))
      throw new OpenCodeNativeApiError("invalid-config");
    this.endpoint = endpoint.origin;
    this.#timeoutMs = options.timeoutMs ?? 10_000;
    this.#maxResponseBytes = options.maxResponseBytes ?? 4 * 1024 * 1024;
    if (!Number.isSafeInteger(this.#timeoutMs) || this.#timeoutMs < 1 || this.#timeoutMs > 60_000
      || !Number.isSafeInteger(this.#maxResponseBytes) || this.#maxResponseBytes < 1
      || this.#maxResponseBytes > 16 * 1024 * 1024)
      throw new OpenCodeNativeApiError("invalid-config");
    if (options.username !== undefined && options.password === undefined)
      throw new OpenCodeNativeApiError("invalid-config");
    if (options.password !== undefined) {
      const username = options.username ?? "opencode";
      if (!text(username) || username.includes(":") || /[\r\n]/.test(username) || !text(options.password))
        throw new OpenCodeNativeApiError("invalid-config");
      this.#authorization = `Basic ${Buffer.from(`${username}:${options.password}`).toString("base64")}`;
    }
  }

  async health(signal?: AbortSignal): Promise<{ readonly version: string }> {
    const value = await this.#request("/global/health", signal);
    if (!object(value) || value.healthy !== true || !text(value.version))
      throw new OpenCodeNativeApiError("invalid-response");
    return { version: value.version };
  }

  async sessions(signal?: AbortSignal): Promise<readonly OpenCodeNativeSession[]> {
    const value = await this.#request("/session", signal);
    if (!Array.isArray(value)) throw new OpenCodeNativeApiError("invalid-response");
    const sessions = value.map(parseSession);
    if (new Set(sessions.map(session => session.id)).size !== sessions.length)
      throw new OpenCodeNativeApiError("invalid-response");
    return sessions;
  }

  async session(id: string, signal?: AbortSignal): Promise<OpenCodeNativeSession> {
    const expected = sessionId(id);
    const value = parseSession(await this.#request(`/session/${expected}`, signal));
    if (value.id !== expected) throw new OpenCodeNativeApiError("invalid-response");
    return value;
  }

  async statuses(signal?: AbortSignal): Promise<Readonly<Record<string, OpenCodeNativeStatus>>> {
    const value = await this.#request("/session/status", signal);
    if (!object(value)) throw new OpenCodeNativeApiError("invalid-response");
    const result: Record<string, OpenCodeNativeStatus> = Object.create(null);
    for (const [id, state] of Object.entries(value)) {
      sessionId(id);
      if (!object(state) || !["idle", "busy", "retry"].includes(String(state.type)))
        throw new OpenCodeNativeApiError("invalid-response");
      result[id] = { type: state.type as OpenCodeNativeStatus["type"] };
    }
    return result;
  }

  async #request(path: string, signal?: AbortSignal): Promise<unknown> {
    const deadline = AbortSignal.timeout(this.#timeoutMs);
    const combined = signal ? AbortSignal.any([signal, deadline]) : deadline;
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    try {
      const response = await fetch(`${this.endpoint}${path}`, {
        method: "GET",
        redirect: "error",
        signal: combined,
        headers: { accept: "application/json", ...(this.#authorization ? { authorization: this.#authorization } : {}) },
      });
      reader = response.body?.getReader();
      if (response.status === 401 || response.status === 403)
        throw new OpenCodeNativeApiError("unauthorized", response.status);
      if (response.status === 404) throw new OpenCodeNativeApiError("not-found", 404);
      if (!response.ok) throw new OpenCodeNativeApiError("http-error", response.status);
      if (!reader) throw new OpenCodeNativeApiError("invalid-response");
      const chunks: Uint8Array[] = [];
      let bytes = 0;
      for (;;) {
        const chunk = await reader.read();
        if (chunk.done) break;
        bytes += chunk.value.byteLength;
        if (bytes > this.#maxResponseBytes) throw new OpenCodeNativeApiError("response-too-large");
        chunks.push(chunk.value);
      }
      const body = Buffer.concat(chunks, bytes);
      try { return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(body)); }
      catch { throw new OpenCodeNativeApiError("invalid-response"); }
    } catch (error) {
      if (error instanceof OpenCodeNativeApiError) throw error;
      if (signal?.aborted) throw new OpenCodeNativeApiError("cancelled");
      if (deadline.aborted) throw new OpenCodeNativeApiError("timeout");
      // Native response bodies, credentials and nested fetch errors stay out of operator output.
      throw new OpenCodeNativeApiError("transport");
    } finally {
      await reader?.cancel().catch(() => {});
    }
  }
}
