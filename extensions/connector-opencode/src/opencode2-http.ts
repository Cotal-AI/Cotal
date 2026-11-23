/**
 * The OpenCode 2.x server's HTTP client types: an error answer as `plugin2.ts`'s `opencodeApi` throws
 * it, and that client's call shape.
 */
export class OpenCodeHttpError extends Error {
  constructor(
    readonly status: number,
    readonly tag: string | undefined,
    readonly field: string | undefined,
    message: string,
  ) {
    super(message);
    this.name = "OpenCodeHttpError";
  }

  static async from(res: Response, path: string): Promise<OpenCodeHttpError> {
    const raw = await res.text().catch(() => "");
    let parsed: { _tag?: unknown; field?: unknown } = {};
    try { parsed = JSON.parse(raw) as typeof parsed; } catch {}
    const text = (v: unknown) => (typeof v === "string" ? v : undefined);
    const body = Buffer.from(raw).subarray(0, 2048).toString("utf8");
    return new OpenCodeHttpError(res.status, text(parsed._tag), text(parsed.field), `OpenCode HTTP ${res.status} ${res.statusText} for ${path}${body ? `: ${body}` : ""}`);
  }
}

/** `opencodeApi` in `plugin2.ts`: the server's authenticated HTTP API. */
export type OpenCodeApi = <T>(path: string, init?: RequestInit, timeoutMs?: number) => Promise<T>;
