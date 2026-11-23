import type { IncomingMessage, ServerResponse } from "node:http";
import { assertDerivedOwnerToken, EpEnvelopeError } from "@cotal-ai/core";
import { deriveOwnerForIdpSubject } from "./derive.js";
import { verifyIdpToken } from "./idp.js";
import { hasInteractiveOwnerGrant } from "./ledger.js";
import type { HandlerCtx } from "./service.js";
import type { ExchangePolicy } from "./service-exchange-routes.js";
import { readJsonBody, refuseCapability, refuseExchange, REFUSAL_STATUS, send } from "./service-http.js";

export const USERNAME_PICK_PATH = "/username/pick";
export const USERNAME_RESERVE_PATH = "/username/reserve";
export const USERNAME_BACKFILL_PATH = "/username/backfill";

export async function handleUsername(req: IncomingMessage, res: ServerResponse, ctx: HandlerCtx, policy: ExchangePolicy, operation: "pick" | "reserve" | "backfill") {
  if (!ctx.username) return send(res, 404, { error: "username service is not available" });
  if (req.method !== "POST") return send(res, 405, { error: "POST only" });
  if (req.headers.origin !== undefined) return send(res, 403, { error: "browser-origin requests are not served here" });
  if (!/^application\/json\b/.test(req.headers["content-type"] ?? "")) return send(res, 415, { error: "content-type must be application/json" });
  if ((policy.requireCapability || operation !== "pick") && req.headers.authorization !== `Bearer ${ctx.cap}`)
    return refuseCapability(res, ctx, "missing/invalid auth-service capability");
  const raw = await readJsonBody(req);
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return send(res, 400, { error: "username request must be a JSON object" });
  const body = raw as Record<string, unknown>;
  const expected = operation === "pick" ? ["idpToken", "username"] : operation === "reserve" ? ["owner", "username"] : ["owner"];
  if (Object.keys(body).some((key) => !expected.includes(key)) || (Object.hasOwn(body, "username") && typeof body.username !== "string"))
    return send(res, 400, { error: "invalid username request fields", code: "bad-request" });
  let owner: string;
  let claims = {};
  const peer = policy.peerKey(req);
  const throttled = policy.throttled(ctx, peer);
  if (operation === "pick") {
    if (typeof body.idpToken !== "string") return send(res, 400, { error: "username pick requires an IdP proof", code: "bad-request" });
    try {
      const verified = await verifyIdpToken(body.idpToken, ctx.bridgeIdp);
      if (verified.exp <= Date.now() / 1_000) throw new Error("expired proof");
      claims = verified;
      owner = deriveOwnerForIdpSubject(ctx.ownerSecret, ctx.bridgeIdp.issuer, verified.sub);
    } catch {
      return refuseExchange(res, ctx, policy, peer, throttled, "refused a username pick: invalid IdP proof", 401, { error: "invalid IdP proof" });
    }
  } else {
    try { owner = assertDerivedOwnerToken(body.owner as string); }
    catch { return send(res, 400, { error: "username operation requires a derived owner", code: "bad-request" }); }
  }
  try {
    if (operation !== "reserve" && !hasInteractiveOwnerGrant(ctx.dir, owner))
      return send(res, 403, { error: "username operation requires an interactive grant in this space", code: "permission-denied" });
    if (operation === "pick") {
      const choice = await ctx.username.choose(owner, claims, body.username as string | undefined);
      return send(res, 200, choice ?? {});
    }
    if (operation === "backfill") return send(res, 200, await ctx.username.backfill(owner));
    if (typeof body.username !== "string") return send(res, 400, { error: "username reserve requires a username", code: "bad-request" });
    return send(res, 200, await ctx.username.reserveDirectory(owner, body.username));
  } catch (error) {
    if (error instanceof EpEnvelopeError) return send(res, REFUSAL_STATUS[error.code] ?? 503, { error: error.message, code: error.code });
    return send(res, 503, { error: "username registry is unavailable", code: "unavailable" });
  }
}
