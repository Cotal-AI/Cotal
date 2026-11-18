import { type IncomingMessage, type ServerResponse } from "node:http";
import type { ExchangePolicy, HandlerCtx } from "./service.js";

/** Invalid-capability attempts get their OWN window (same size): an unauthenticated local prober
 *  is throttled AND audited, but never consumes the refused-exchange budget of a caller holding
 *  the real capability — a cap-less process must not be able to starve legitimate exchanges. */
const BAD_CAP_PER_MIN = 30;

/** JSON reply helper. No CORS headers, ever — a browser context must never be granted a readable
 *  response here. */
export function send(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  res.writeHead(status, { "content-type": "application/json", ...headers });
  res.end(JSON.stringify(body));
}

/** An HTTP-shaped request refusal found while reading the body. Keeping the status on the error
 *  lets both listeners return the SAME exact wire response rather than collapsing a deliberate
 *  size refusal into the generic malformed-request 400. */
export class RequestBodyError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

export function sendRequestError(res: ServerResponse, e: unknown): void {
  if (e instanceof RequestBodyError) return send(res, e.status, { error: e.message });
  console.error("auth-service: unexpected request error", e);
  send(res, 500, { error: "internal server error" });
}

/** Refuse a missing/invalid loopback capability, audited and counted in its own window (see
 *  BAD_CAP_PER_MIN): 401 with `reason` until the window is full, then 429. */
export function refuseCapability(res: ServerResponse, ctx: Pick<HandlerCtx, "badCaps">, reason: string, extra: { code?: string; outcome?: string } = {}): void {
  const now = Date.now();
  while (ctx.badCaps.length && now - ctx.badCaps[0] > 60_000) ctx.badCaps.shift();
  ctx.badCaps.push(now);
  console.error("auth-service: rejected an exchange with a missing/invalid capability");
  if (ctx.badCaps.length > BAD_CAP_PER_MIN)
    return send(res, 429, { error: "too many invalid-capability attempts - wait a minute and retry", ...extra });
  send(res, 401, { error: reason, ...extra });
}

/** Refuse an exchange against the face's refused-exchange budget (see {@link ExchangePolicy}): record
 *  the failure, audit it, then answer 429 when the peer was already throttled, or else `status` with
 *  `body`. Every refusal that spends the budget goes through here, so the mask and the audit line
 *  exist once. `throttledExtra` rides on the 429 for a route whose answers carry a code. */
export function refuseExchange(
  res: ServerResponse,
  ctx: Pick<HandlerCtx, "failures">,
  policy: ExchangePolicy,
  peer: string,
  peerThrottled: boolean,
  audit: string,
  status: number,
  body: { error: string; code?: string; outcome?: string },
  throttledExtra: { code?: string; outcome?: string } = {},
): void {
  policy.recordFailure(ctx, peer);
  console.error(`auth-service: ${audit}`);
  if (peerThrottled) return send(res, 429, { error: "too many refused exchanges - wait a minute and retry", ...throttledExtra });
  send(res, status, body);
}

/** HTTP status for a door refusal's native code; the body carries the code itself. */
export const REFUSAL_STATUS: Readonly<Record<string, number>> = {
  "bad-request": 400, unauthenticated: 401, "permission-denied": 403, "not-found": 404, conflict: 409,
  "failed-precondition": 412, "resource-exhausted": 429, unimplemented: 501, unavailable: 503,
};

/** Read + parse a small JSON body, bounded — the exchange payload is an IdP JWT plus an actor name;
 *  64 KB clears any sane JWT while keeping the loopback surface un-floodable. A route with a larger
 *  protocol envelope passes its own bound. */
export function readJsonBody(req: IncomingMessage, max = 64 * 1024): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let size = 0;
    let tooLarge = false;
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > max) {
        // Stop retaining bytes immediately, but keep draining the request so the client receives
        // the explicit 413 JSON response. Destroying the socket hid the server's decision behind
        // an undici transport error and made the size-bound smoke unable to prove this guard.
        tooLarge = true;
        chunks.length = 0;
        return;
      }
      if (!tooLarge) chunks.push(c);
    });
    req.on("end", () => {
      if (tooLarge) return reject(new RequestBodyError(413, `request body too large (maximum ${max} bytes)`));
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch {
        reject(new RequestBodyError(400, "request body is not valid JSON"));
      }
    });
    req.on("error", reject);
  });
}
