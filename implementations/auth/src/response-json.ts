/** Decode an auth face's answer without inventing a result when its body is unreadable.
 * The caller still checks the shape and interprets any authorization or operation outcome. */
export async function readAuthResponseJson(response: Response, face: string): Promise<unknown> {
  return response.json().catch(() => {
    throw new Error(`${face} answered HTTP ${response.status} with a body that could not be read as JSON`);
  });
}

/** The body of a refused exchange: its sentence, and for a rate limit its code, wait and bucket. */
export interface ExchangeRefusal {
  error?: string;
  code?: unknown;
  retryAfterSeconds?: unknown;
  limit?: unknown;
}

/** A rate-limited exchange as a client reports it: the service's sentence, the seconds to wait, the
 *  bucket that ran out, and a remedy saying whether that is the one actor or the whole account. */
export interface ExchangeRateLimit {
  readonly message: string;
  readonly retryAfterSeconds: number;
  readonly limit: "actor" | "owner";
  readonly remedy: string;
}

/** The exchange's 429 for an actor its connect limits turn away (SPEC §10). Undefined for any other
 *  answer. It imports nothing, so `cotal agent-bearer` reads it without loading a package root. */
export function exchangeRateLimit(status: number, body: ExchangeRefusal, actor: string): ExchangeRateLimit | undefined {
  const seconds = body.retryAfterSeconds;
  if (status !== 429 || body.code !== "RATE_LIMITED" || typeof seconds !== "number" || !Number.isSafeInteger(seconds) || seconds < 1) return undefined;
  if (body.limit !== "actor" && body.limit !== "owner") return undefined;
  return {
    message: body.error ?? `actor "${actor}" is over its connect limit - retry in ${seconds}s`,
    retryAfterSeconds: seconds,
    limit: body.limit,
    remedy: body.limit === "actor" ? `only actor "${actor}" is limited, not the account's other actors` : "the account is limited, so every one of its actors is",
  };
}
