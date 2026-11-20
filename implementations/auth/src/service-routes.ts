/** The auth service's HTTP route handlers: chat sessions, the service endpoint host and authority
 *  routes, endpoint deregistration and the tool-result human-proof and consent routes. service.ts
 *  owns both route tables and dispatches to these. */
import { type ExchangePolicy } from "./service-exchange-routes.js";
import { send, RequestBodyError, sendRequestError, refuseCapability, refuseExchange, REFUSAL_STATUS, readJsonBody } from "./service-http.js";
import { type IncomingMessage, type ServerResponse } from "node:http";
import { VOID_SCHEMA, singleDocumentClosure, contractDigest, contractRefToHex, EpEnvelopeError, contractArtifactCanonicalBytes, publishContractArtifact, parseServiceAuthorityEnvelope, SERVICE_AUTHORITY_MAX_BYTES, parseServiceRegistrationWitness, serviceWitnessDigest, type ServiceAuthorityRequest, type ServiceRegistrationWitness } from "@cotal-ai/core";
import { decodeJwt } from "jose";
import { deriveOwnerForIdpSubject } from "./derive.js";
import { verifyIdpToken, verifyToolResultHumanProof } from "./idp.js";
import { validateUserToken } from "./token.js";
import { type UserTokenIssuer } from "./issuer.js";
import { parseRemoteEndpointDeregisterRequest } from "@cotal-ai/core";
import { parseServiceHostRequest } from "./service-host-contract.js";
import { S2A_INVOCATION_MS } from "./service-host-kernel.js";
import { openServiceHostEffect } from "./service-host-ops.js";
import { answerServiceAuthority, serviceAuthorityDenied, serviceAuthorityInfo, serviceHostGranterFor, type ServiceAuthorityCaller } from "./service-endpoint-authority.js";
import { validateServiceRenewalProof } from "./service-renewal.js";
import { findInteractiveActor } from "./ledger.js";
import type { HandlerCtx } from "./service.js";

/** Each chat-session route's CLOSED body: an unknown or missing field refuses before any read. */
const CHAT_SESSION_FIELDS: Readonly<Record<"open" | "bearer" | "retire", { required: readonly string[]; optional: readonly string[] }>> = {
  open: { required: ["idpToken", "holderHash", "read", "post", "ttlSec"], optional: ["label"] },
  bearer: { required: ["idpToken", "actor", "holderProof"], optional: [] },
  retire: { required: ["idpToken", "actor", "lifecycleUid", "holderProof"], optional: [] },
};

/**
 * The chat-session routes, on both faces. The owner is derived from a fresh IdP proof exactly as
 * `/exchange` derives it; the body never names one. `open` admits, `bearer` exchanges the holder
 * proof for one short bearer, `retire` retires. Every refusal answers `{ error, code, outcome }`:
 * `not-executed` when nothing was written, `executed` when this request wrote before refusing, and
 * `unknown` when a write may have landed (a retry with the SAME holder resolves it). The holder proof
 * and the bearer never reach a log line.
 */
export async function handleChatSession(req: IncomingMessage, res: ServerResponse, ctx: HandlerCtx, policy: ExchangePolicy, op: "open" | "bearer" | "retire"): Promise<void> {
  // Every answer before the dispatch is refused with nothing read or written.
  const before = { outcome: "not-executed" } as const;
  if (req.method !== "POST") return send(res, 405, { error: "POST only", code: "bad-request", ...before });
  if (req.headers.origin !== undefined) return send(res, 403, { error: "browser-origin requests are not served here", code: "permission-denied", ...before });
  if (!/^application\/json\b/.test(req.headers["content-type"] ?? ""))
    return send(res, 415, { error: "content-type must be application/json", code: "bad-request", ...before });
  if (policy.requireCapability && (req.headers.authorization ?? "") !== `Bearer ${ctx.cap}`)
    return refuseCapability(res, ctx, "missing/invalid exchange capability - read it from the space's auth-service.json", { code: "unauthenticated", ...before });
  const peer = policy.peerKey(req);
  const peerThrottled = policy.throttled(ctx, peer);
  const body = await readJsonBody(req);
  const malformed = (why: string) => send(res, 400, { error: `chat-session ${op}: ${why}`, code: "bad-request", ...before });
  if (body === null || typeof body !== "object" || Array.isArray(body)) return malformed("the body must be a JSON object");
  const b = body as Record<string, unknown>;
  const fields = CHAT_SESSION_FIELDS[op];
  const extra = Object.keys(b).find((k) => !fields.required.includes(k) && !fields.optional.includes(k));
  if (extra !== undefined) return malformed(`unknown field "${extra}"`);
  const missing = fields.required.find((k) => !Object.hasOwn(b, k));
  if (missing !== undefined) return malformed(`missing field "${missing}"`);
  if (typeof b.idpToken !== "string" || b.idpToken === "") return malformed("idpToken must be a non-empty string");
  if (op === "open" && (typeof b.holderHash !== "string" || !Array.isArray(b.read) || !Array.isArray(b.post) || typeof b.ttlSec !== "number" || (b.label !== undefined && typeof b.label !== "string")))
    return malformed("open takes { idpToken, holderHash: string, read: string[], post: string[], ttlSec: number, label?: string }");
  if (op !== "open" && (typeof b.actor !== "string" || typeof b.holderProof !== "string" || (op === "retire" && typeof b.lifecycleUid !== "string")))
    return malformed(op === "bearer" ? "bearer takes { idpToken, actor: string, holderProof: string }" : "retire takes { idpToken, actor: string, lifecycleUid: string, holderProof: string }");
  // A refusal keeps the effect outcome its source stated; one that states none is unknown.
  const refuse = (status: number, message: string, code: string, outcome: string = "unknown") =>
    refuseExchange(res, ctx, policy, peer, peerThrottled, `refused a chat-session ${op}: ${message}`, status, { error: message, code, outcome }, { code: "resource-exhausted", outcome });
  let owner: string;
  let idpExp: number;
  try {
    const verified = await verifyIdpToken(b.idpToken, ctx.bridgeIdp);
    owner = deriveOwnerForIdpSubject(ctx.ownerSecret, ctx.bridgeIdp.issuer, verified.sub);
    idpExp = verified.exp;
  } catch (e) {
    return refuse(401, e instanceof Error ? e.message : String(e), "unauthenticated", "not-executed");
  }
  try {
    if (op === "open")
      return send(res, 200, await ctx.openChatSession({
        owner, holderHash: b.holderHash as string, read: b.read as string[], post: b.post as string[], ttlSec: b.ttlSec as number,
        ...(typeof b.label === "string" ? { label: b.label } : {}),
      }));
    if (op === "bearer") {
      const minted = await ctx.chatSessionBearer({ owner, actor: b.actor as string, holderProof: b.holderProof as string, idpExp, issuer: ctx.issuer });
      return send(res, 200, { token: minted.token, owner, exp: minted.exp });
    }
    return send(res, 200, await ctx.retireChatSession({ owner, actor: b.actor as string, lifecycleUid: b.lifecycleUid as string, holderProof: b.holderProof as string }));
  } catch (e) {
    if (e instanceof EpEnvelopeError) return refuse(REFUSAL_STATUS[e.code] ?? 500, e.message, e.code, e.outcome ?? "unknown");
    // Anything else came from a store, broker or file read partway through: its effect is unknown.
    return refuse(503, e instanceof Error ? e.message : String(e), "unavailable", "unknown");
  }
}

/** A service renewal or access proof, verified against this context's own signing keys: the
 *  signed witness it binds. A request that carries a witness must name the proof's; a status query
 *  carries none, so its proof's own witness is the expected one. Current native state is the
 *  engine's check, never the proof's. */
async function verifyServiceProof(proof: { kind: "service-renewal" | "service-access"; token: string }, request: ServiceAuthorityRequest,
  issuer: UserTokenIssuer, space: string): Promise<ServiceRegistrationWitness> {
  const key = issuer.localKeySet();
  if (proof.kind === "service-renewal") {
    const expected = "witness" in request ? request.witness : parseServiceRegistrationWitness(decodeJwt(proof.token).witness);
    return (await validateServiceRenewalProof(proof.token, { issuer: issuer.issuer, key, witness: expected })).witness;
  }
  const token = await validateUserToken(proof.token, { issuer: issuer.issuer, audience: space, key });
  if (token.act.view !== "service-endpoint" || token.act.service?.duty !== "serve") throw new Error("the access proof is not a service bearer");
  const witness = parseServiceRegistrationWitness(token.act.service.witness);
  if (token.owner !== witness.principal.owner || token.act.owner !== witness.principal.owner || token.act.actor !== witness.principal.actor
    || token.act.lifecycleUid !== witness.principal.lifecycleUid || token.credentialId !== witness.rootCredentialId)
    throw new Error("the access proof does not bind its witness");
  if ("witness" in request && serviceWitnessDigest(request.witness) !== serviceWitnessDigest(witness)) throw new Error("the access proof binds another witness");
  return witness;
}

/** The authenticated service endpoint host route, on both faces and only with `serviceEndpoints`:
 *  POST takes `{ idpToken, request }`, where `request` is a host request without its granter. The
 *  fresh IdP proof derives the owner, who needs a current interactive row (the engine checks it);
 *  owner operations and reads run under that owner and the engine scopes them to the owner's own
 *  rows. An operator action (`name-bind`, the restore controls, a non-owner revoke) runs only on the
 *  loopback face under the operator exchange capability, with the proved subject as its audit id;
 *  the public face refuses it. The route authenticates the granter and never invents one; the
 *  engine's answer, replay included, is returned as is. */
export async function handleServiceEndpointHost(req: IncomingMessage, res: ServerResponse, ctx: HandlerCtx, policy: ExchangePolicy): Promise<void> {
  const host = ctx.serviceHost;
  if (host === undefined) return send(res, 404, { error: "service endpoint host is not enabled for this space" });
  if (req.method !== "POST") return send(res, 405, { error: "POST only" });
  if (req.headers.origin !== undefined) return send(res, 403, { error: "browser-origin requests are not served here" });
  if (!/^application\/json\b/.test(req.headers["content-type"] ?? ""))
    return send(res, 415, { error: "content-type must be application/json" });
  if (policy.requireCapability && req.headers.authorization !== `Bearer ${ctx.cap}`)
    return refuseCapability(res, ctx, "missing/invalid exchange capability - the service endpoint host requires the operator exchange capability on this face");
  const peer = policy.peerKey(req);
  const peerThrottled = policy.throttled(ctx, peer);
  let body: { idpToken?: unknown; request?: unknown } | null;
  try {
    body = await readJsonBody(req, SERVICE_HOST_BODY_MAX_BYTES) as typeof body;
  } catch (e) {
    return sendRequestError(res, e);
  }
  if (typeof body?.idpToken !== "string" || !body.idpToken || body.request === null || typeof body.request !== "object" || Array.isArray(body.request)
      || Object.hasOwn(body.request, "granter"))
    return send(res, 400, { error: "service endpoint host needs { idpToken, request } with the granter left to this route" });
  let proved: { owner: string; subject: string };
  try {
    const verified = await verifyIdpToken(body.idpToken, ctx.bridgeIdp);
    proved = { owner: deriveOwnerForIdpSubject(ctx.ownerSecret, ctx.bridgeIdp.issuer, verified.sub), subject: verified.sub };
  } catch (e) {
    const reason = e instanceof Error ? e.message : String(e);
    return refuseExchange(res, ctx, policy, peer, peerThrottled, `refused service endpoint host: ${reason}`, 403, { error: reason });
  }
  const granter = serviceHostGranterFor(body.request as { operation: unknown; input: unknown }, proved, policy.requireCapability);
  if (granter === undefined) return send(res, 403, { error: "this host operation is the operator's; it is served on the loopback face under the exchange capability only" });
  let request: ReturnType<typeof parseServiceHostRequest>;
  try { request = parseServiceHostRequest({ ...(body.request as Record<string, unknown>), granter }); }
  catch (e) { return send(res, 400, { error: e instanceof Error ? e.message : String(e) }); }
  try {
    return send(res, 200, await host(request), { "cache-control": "no-store" });
  } catch (e) {
    const reason = e instanceof Error ? e.message : String(e);
    console.error(`auth-service: service endpoint host failed: ${reason}`);
    return send(res, /unavailable/i.test(reason) ? 503 : 500, { error: reason });
  }
}

/** A host request is small: a decision, a binding or a read. */
const SERVICE_HOST_BODY_MAX_BYTES = 64 * 1024;

/** Publish the canonical void closure, manifest and schema, create-only, through one effect whose
 *  credential publishes exactly those two artifacts and reads them back, over the read-only discovery
 *  base every effect credential carries; no other write is granted. Idempotent: a store that holds
 *  them already answers without a write. */
export async function publishCanonicalVoidClosure(opts: Parameters<typeof openServiceHostEffect>[0]): Promise<void> {
  const artifacts: unknown[] = [singleDocumentClosure(VOID_SCHEMA).manifest, VOID_SCHEMA];
  const effect = await openServiceHostEffect(opts, { keys: { records: [], auth: [], authFamilies: [] }, deadlineMs: Date.now() + S2A_INVOCATION_MS,
    reads: { records: [], contract: artifacts.map((a) => contractRefToHex(contractDigest(a))) } });
  try {
    for (const a of artifacts) await publishContractArtifact(effect.contract!, contractArtifactCanonicalBytes(a));
  } finally { await effect.close(); }
}

/** The public service endpoint authority route, on both faces and only with `serviceEndpoints`: GET
 *  reads the account info, POST takes one `{request, proof}` envelope. The proof is the credential on
 *  either face; the loopback capability is never read or accepted here. An IdP proof verifies against
 *  the pinned issuer and exact audience, and its subject derives the owner. A service renewal or
 *  access proof verifies against this context's own issuer and binds a witness, never an owner's
 *  authority. A refused proof counts against the face's refusal budget; a valid proof does not,
 *  whatever the answer. */
export async function handleServiceEndpointAuthority(req: IncomingMessage, res: ServerResponse, ctx: HandlerCtx, policy: ExchangePolicy): Promise<void> {
  const door = ctx.serviceAuthority;
  if (door === undefined) return send(res, 404, { error: "service endpoint authority is not enabled for this space" });
  if (req.headers.origin !== undefined) return send(res, 403, { error: "browser-origin requests are not served here" });
  const noStore = { "cache-control": "no-store" };
  if (req.method === "GET") return send(res, 200, serviceAuthorityInfo(door, ctx.issuer), noStore);
  if (req.method !== "POST") return send(res, 405, { error: "GET or POST only" });
  if (!/^application\/json\b/.test(req.headers["content-type"] ?? ""))
    return send(res, 415, { error: "content-type must be application/json" });
  const peer = policy.peerKey(req);
  const peerThrottled = policy.throttled(ctx, peer);
  let envelope: ReturnType<typeof parseServiceAuthorityEnvelope>;
  try { envelope = parseServiceAuthorityEnvelope(await readJsonBody(req, SERVICE_AUTHORITY_MAX_BYTES)); }
  catch (e) {
    // The parser's bad-request names the caller's own malformed envelope, so it stays a named 400.
    if (e instanceof EpEnvelopeError && e.code === "bad-request") return send(res, 400, { error: e.message });
    return sendRequestError(res, e);
  }
  const { request, proof } = envelope;
  const answer = (r: { status: number; body: unknown }) => send(res, r.status, r.body, noStore);
  if (request.space !== door.space || request.accountPublicKey !== door.accountPublicKey) return answer(serviceAuthorityDenied(request, "account-mismatch"));
  let caller: ServiceAuthorityCaller;
  try {
    caller = proof.kind === "idp"
      ? { kind: "idp", owner: deriveOwnerForIdpSubject(ctx.ownerSecret, ctx.bridgeIdp.issuer, (await verifyIdpToken(proof.token, ctx.bridgeIdp)).sub) }
      : { kind: "service", witness: await verifyServiceProof(proof, request, ctx.issuer, door.space) };
  } catch (e) {
    policy.recordFailure(ctx, peer);
    console.error(`auth-service: refused a service endpoint authority proof: ${e instanceof Error ? e.message : String(e)}`);
    return answer(serviceAuthorityDenied(request, peerThrottled ? "rate-limited" : "unauthenticated"));
  }
  try {
    return answer(await answerServiceAuthority(door, request, caller));
  } catch (e) {
    // After the proof, a register may already be bound: an unexpected failure is an unknown effect.
    console.error(`auth-service: service endpoint authority ${request.operation} failed: ${e instanceof Error ? e.message : String(e)}`);
    return send(res, 503, { error: "service endpoint authority did not complete; the request may be bound, so retain its request identity" }, noStore);
  }
}

/** Same-account human removal. Operator authority exists only on the trusted in-process door. */
export async function handleEndpointDeregister(req: IncomingMessage, res: ServerResponse, ctx: HandlerCtx, policy: ExchangePolicy): Promise<void> {
  if (req.method !== "POST") return send(res, 405, { error: "POST only" });
  if (req.headers.origin !== undefined) return send(res, 403, { error: "browser-origin requests are not served here" });
  if (!/^application\/json\b/.test(req.headers["content-type"] ?? "")) return send(res, 415, { error: "content-type must be application/json" });
  if (policy.requireCapability && req.headers.authorization !== `Bearer ${ctx.cap}`)
    return refuseCapability(res, ctx, "missing/invalid exchange capability");
  const peer = policy.peerKey(req), throttled = policy.throttled(ctx, peer);
  let body: { idpToken: string; request: unknown };
  try {
    const raw = await readJsonBody(req);
    if (!raw || typeof raw !== "object" || Array.isArray(raw) || Object.keys(raw).sort().join(",") !== "idpToken,request" ||
        !("idpToken" in raw) || typeof raw.idpToken !== "string" || !raw.idpToken) return send(res, 400, { error: "endpoint deregistration needs only { idpToken, request }" });
    body = raw as typeof body;
    parseRemoteEndpointDeregisterRequest(body.request);
  } catch (error) {
    if (error instanceof RequestBodyError) return sendRequestError(res, error);
    return send(res, error instanceof EpEnvelopeError && error.code === "unimplemented" ? 422 : 400, { error: "invalid endpoint deregistration request" });
  }
  let owner: string;
  try {
    const verified = await verifyIdpToken(body.idpToken, ctx.bridgeIdp);
    owner = deriveOwnerForIdpSubject(ctx.ownerSecret, ctx.bridgeIdp.issuer, verified.sub);
    const row = findInteractiveActor(ctx.dir, owner, "cli");
    if (!row || !(row.scope ?? []).includes("supervise")) throw new Error("endpoint deregistration requires the current cli supervise grant");
  } catch {
    return refuseExchange(res, ctx, policy, peer, throttled, "endpoint deregistration proof or current grant refused", 403, { error: "endpoint deregistration proof or current grant refused" });
  }
  try {
    return send(res, 200, await ctx.deregisterEndpoint(body.request, { kind: "owner", owner }), { "cache-control": "no-store" });
  } catch {
    return send(res, 503, { error: "endpoint deregistration did not return a confirmed result; inspect the same registration before another request" });
  }
}

/** Minimal host-held inputs for the proof decision; no signing or storage authority is used. */
export type ToolResultHumanProofCtx = Pick<HandlerCtx, "cap" | "bridgeIdp" | "ownerSecret" | "badCaps">;

/** Decide one signed password proof against the host's authenticated session subject.
 * The subject is an equality constraint, never the source of the derived owner. */
export async function handleToolResultHumanProof(
  req: IncomingMessage, res: ServerResponse, ctx: ToolResultHumanProofCtx,
): Promise<void> {
  if (req.method !== "POST") return send(res, 405, { error: "POST only" });
  if (req.headers.origin !== undefined) return send(res, 403, { error: "browser-origin requests are not served here" });
  if (!/^application\/json\b/.test(req.headers["content-type"] ?? ""))
    return send(res, 415, { error: "content-type must be application/json" });
  if (req.headers.authorization !== `Bearer ${ctx.cap}`)
    return refuseCapability(res, ctx, "missing/invalid exchange capability - human proof verification is a loopback host action");
  let body: unknown;
  try { body = await readJsonBody(req); }
  catch (error) { return send(res, error instanceof RequestBodyError ? error.status : 400, { error: "invalid human proof request" }); }
  if (!body || typeof body !== "object" || Array.isArray(body) ||
      Object.keys(body).some(key => key !== "idpToken" && key !== "subject") ||
      !("idpToken" in body) || typeof body.idpToken !== "string" || !body.idpToken ||
      !("subject" in body) || typeof body.subject !== "string" || !body.subject)
    return send(res, 400, { error: "human proof verification needs only { idpToken, subject }" });
  try {
    const proof = await verifyToolResultHumanProof(body.idpToken, ctx.bridgeIdp);
    if (proof.sub !== body.subject) return send(res, 403, { error: "human proof subject does not match the session" });
    const owner = deriveOwnerForIdpSubject(ctx.ownerSecret, ctx.bridgeIdp.issuer, proof.sub);
    return send(res, 200, { authorized: true, owner, ...proof });
  } catch {
    return send(res, 403, { error: "fresh signed password proof required" });
  }
}

/** Consent issuance is confined to the authenticated host face and uses sanitized refusals. */
export async function handleToolResultConsent(req: IncomingMessage, res: ServerResponse,
  ctx: Pick<HandlerCtx, "cap" | "badCaps" | "issueToolResultConsent">): Promise<void> {
  if (req.method !== "POST") return send(res, 405, { error: "POST only" });
  if (req.headers.origin !== undefined) return send(res, 403, { error: "browser-origin requests are not served here" });
  if (!/^application\/json\b/.test(req.headers["content-type"] ?? "")) return send(res, 415, { error: "content-type must be application/json" });
  if (req.headers.authorization !== `Bearer ${ctx.cap}`)
    return refuseCapability(res, ctx, "missing/invalid exchange capability - consent issuance is a loopback host action");
  if (!ctx.issueToolResultConsent) return send(res, 503, { error: "tool-result-consent-unavailable", outcome: "not-executed" });
  let body: unknown;
  try { body = await readJsonBody(req); }
  catch { return send(res, 400, { error: "invalid consent request", outcome: "not-executed" }); }
  try { return send(res, 200, { consent: await ctx.issueToolResultConsent(body) }, { "cache-control": "no-store" }); }
  catch (error) {
    const code = error instanceof EpEnvelopeError ? error.code : "unavailable";
    const status = code === "bad-request" ? 400 : code === "permission-denied" ? 403 : code === "conflict" ? 409 : 503;
    return send(res, status, { error: `tool-result-consent-${code}`, outcome: error instanceof EpEnvelopeError ? error.outcome ?? "unknown" : "unknown" });
  }
}
