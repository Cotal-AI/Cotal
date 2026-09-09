/**
 * Loopback-only independent session-credential remint.
 *
 * The public route table never includes this path. The handler loads the stored
 * enrollment through {@link getSessionEnrollment} (parse on every read),
 * intersects a FRESH ledger grant on every issued dimension, and signs a
 * bounded `session-agent` JWT for the enrolled public nkey. The connector
 * retains the matching seed. No manager is in the path.
 *
 * `ctx.cap` is the daemon's loopback operator exchange capability. It is not
 * proof of possession and must never be distributed to session connectors. A
 * connector remint client needs a narrow owner-authorized
 * actor/lifecycle/resource-bound capability plus key possession.
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import {
  EpEnvelopeError,
  getSessionEnrollment,
  issueSessionRenewal,
  parseResourceKey,
  type ResourceKey,
  type SessionEnrollment,
  type SessionRenewalGrant,
  type SpaceAuth,
} from "@cotal-ai/core";
import type { KV } from "@nats-io/kv";
import { assertWithinSpawnerGrant, findActorUnified } from "./ledger.js";

export const SESSION_RENEWAL_PATH = "/session-renewal";

const BODY_KEYS = new Set(["resourceKey"]);

export interface SessionRenewalCtx {
  cap: string;
  dir: string;
  space: string;
  records: KV;
  account: Pick<SpaceAuth["account"], "pub" | "signingSeed">;
}

type Send = (res: ServerResponse, status: number, body: unknown, headers?: Record<string, string>) => void;

export function liveSessionRenewalGrant(
  dir: string,
  enrollment: SessionEnrollment,
): SessionRenewalGrant {
  if (enrollment.kind !== "mesh-enrolled")
    throw new EpEnvelopeError("failed-precondition", "native-only enrollment has no mesh identity and cannot renew a session credential");
  const parsed = enrollment.ceiling;
  const row = findActorUnified(dir, parsed.owner, parsed.actor);
  if (!row)
    throw new EpEnvelopeError("not-found", `session actor "${parsed.owner}/${parsed.actor}" is not granted`);
  if (!row.lifecycleUid)
    throw new EpEnvelopeError("failed-precondition", `session actor "${parsed.owner}/${parsed.actor}" has no lifecycleUid on its ledger row`);
  if (row.lifecycleUid !== parsed.lifecycleUid)
    throw new EpEnvelopeError("permission-denied", `session actor "${parsed.owner}/${parsed.actor}" is current at lifecycle ${row.lifecycleUid}, not ${parsed.lifecycleUid}`);
  try {
    assertWithinSpawnerGrant(dir, row, "exchange");
  } catch (e) {
    throw new EpEnvelopeError("permission-denied", e instanceof Error ? e.message : String(e));
  }
  return {
    owner: row.owner,
    actor: row.actor,
    lifecycleUid: row.lifecycleUid,
    scope: row.scope,
    allowSubscribe: row.allowSubscribe,
    allowPublish: row.allowPublish,
  };
}

/** Production remint used by the loopback HTTP route. */
export async function renewSessionFromEnrollmentStore(ctx: SessionRenewalCtx, resourceKey: ResourceKey): Promise<{
  jwt: string;
  exp: number;
  authority: Awaited<ReturnType<typeof issueSessionRenewal>>["authority"];
}> {
  const enrollment = await getSessionEnrollment(ctx.records, resourceKey);
  const grant = liveSessionRenewalGrant(ctx.dir, enrollment);
  return issueSessionRenewal({
    kv: ctx.records,
    resourceKey,
    grant,
    auth: { space: ctx.space, account: ctx.account as SpaceAuth["account"] },
  });
}

export async function handleSessionRenewal(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: SessionRenewalCtx,
  send: Send,
  readJsonBody: (req: IncomingMessage) => Promise<unknown>,
): Promise<void> {
  if (req.method !== "POST") return send(res, 405, { error: "POST only" });
  if (req.headers.origin !== undefined) return send(res, 403, { error: "browser-origin requests are not served here" });
  if (!/^application\/json\b/.test(req.headers["content-type"] ?? ""))
    return send(res, 415, { error: "content-type must be application/json" });
  if (req.headers.authorization !== `Bearer ${ctx.cap}`)
    return send(res, 401, { error: "missing/invalid exchange capability - session renewal is a loopback operator action" });
  const body = await readJsonBody(req);
  if (body === null || typeof body !== "object" || Array.isArray(body))
    return send(res, 400, { error: "session renewal needs { resourceKey }" });
  for (const key of Object.keys(body))
    if (!BODY_KEYS.has(key))
      return send(res, 400, { error: `session renewal carries the unknown field "${key}"` });
  const raw = body as { resourceKey?: unknown };
  let resourceKey: ResourceKey;
  try {
    resourceKey = parseResourceKey(raw.resourceKey);
  } catch (e) {
    return send(res, 400, { error: e instanceof Error ? e.message : String(e) });
  }
  try {
    const minted = await renewSessionFromEnrollmentStore(ctx, resourceKey);
    return send(res, 200, { jwt: minted.jwt, exp: minted.exp, authority: minted.authority });
  } catch (e) {
    const reason = e instanceof Error ? e.message : String(e);
    const status = e instanceof EpEnvelopeError && e.code === "permission-denied" ? 403
      : e instanceof EpEnvelopeError && e.code === "not-found" ? 404
      : e instanceof EpEnvelopeError && e.code === "failed-precondition" ? 409
      : 403;
    console.error(`auth-service: refused session renewal: ${reason}`);
    return send(res, status, { error: reason });
  }
}
