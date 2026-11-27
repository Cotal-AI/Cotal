import { createHash } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { assertLifecycleToken, assertValidChannel, assertValidOwnerToken, EpEnvelopeError } from "@cotal-ai/core";
import { verifyLinkedAgentApproval, type IdpConfig } from "./idp.js";
import { LOOPBACK_POLICY } from "./service-exchange-routes.js";
import { readJsonBody, refuseCapability, refuseExchange, REFUSAL_STATUS, RequestBodyError, send } from "./service-http.js";

type LinkSelection = { mode: "create" } | { mode: "select"; agentUid: string };
type GrantInput = {
  actor: string;
  requestId: string;
  agentLink: LinkSelection;
  scope: string[];
  allowSubscribe: string[];
  allowPublish: string[];
};
type LinkedGrantAdmission = GrantInput & { owner: string; approvalId: string; approvalExpiresAtMs: number };
type LinkedGrantPending = {
  v: 1;
  state: "pending";
  owner: string;
  actor: string;
  lifecycleUid: string;
  agentLink: { mode: LinkSelection["mode"]; agentUid: string };
  actorToken: string;
};

export interface LinkedAgentGrantOptions {
  space: string;
  account: string;
  spaceSecret: string | Uint8Array;
  idp: IdpConfig;
  approvalAudience: string;
  cap: string;
  badCaps: number[];
  failures: number[];
  admit: (input: LinkedGrantAdmission) => Promise<LinkedGrantPending>;
}

const GRANT_KEYS = ["actor", "requestId", "scope", "allowSubscribe", "allowPublish", "agentLink"];
const AGENT_UID = /^ag_[a-z2-7]{26}$/;
const REQUEST_ID = /^[A-Za-z0-9_-]{1,128}$/;
const BEFORE = { outcome: "not-executed" } as const;

function closedRecord(value: unknown, keys: readonly string[]): Record<string, unknown> | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return;
  if (Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key)))
    return value as Record<string, unknown>;
}

function parseSelection(value: unknown): { agentLink: LinkSelection; approval: string } {
  const create = closedRecord(value, ["mode", "approval"]);
  if (create?.mode === "create" && typeof create.approval === "string" && create.approval !== "")
    return { agentLink: { mode: "create" }, approval: create.approval };
  const select = closedRecord(value, ["mode", "agentUid", "approval"]);
  if (select?.mode === "select" && typeof select.agentUid === "string" && AGENT_UID.test(select.agentUid) &&
      typeof select.approval === "string" && select.approval !== "")
    return { agentLink: { mode: "select", agentUid: select.agentUid }, approval: select.approval };
  throw new RequestBodyError(400, "agentLink must carry a create or select intent with its approval");
}

function concreteChannels(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > 32 || new Set(value).size !== value.length)
    throw new RequestBodyError(400, "channel ACLs must be arrays of at most 32 unique entries");
  return value.map(channel => {
    if (typeof channel !== "string") throw new RequestBodyError(400, "channel ACL entries must be strings");
    if (/[*>]/.test(channel)) throw new EpEnvelopeError("permission-denied", "linked foreground grants cannot request wildcard ACLs", undefined, "not-executed");
    try {
      return assertValidChannel(channel);
    } catch {
      throw new RequestBodyError(400, "invalid concrete channel ACL entry");
    }
  });
}

function parseGrant(value: unknown): { input: GrantInput; approval: string } {
  const body = closedRecord(value, GRANT_KEYS);
  if (!body || typeof body.requestId !== "string" || !REQUEST_ID.test(body.requestId) || typeof body.actor !== "string" || !Array.isArray(body.scope))
    throw new RequestBodyError(400, "linked grant needs exactly { actor, requestId, scope, allowSubscribe, allowPublish, agentLink }");
  let actor: string;
  try {
    actor = assertValidOwnerToken(body.actor);
  } catch {
    throw new RequestBodyError(400, "invalid actor token");
  }
  const { agentLink, approval } = parseSelection(body.agentLink);
  if (body.scope.length !== 0)
    throw new EpEnvelopeError("permission-denied", "linked foreground grants cannot request additional scopes", undefined, "not-executed");
  return {
    input: { actor, requestId: body.requestId, agentLink, scope: [], allowSubscribe: concreteChannels(body.allowSubscribe), allowPublish: concreteChannels(body.allowPublish) },
    approval,
  };
}

/** The native owner retirement door derives owner from an ordinary IdP proof outside this body. */
export function parseLinkedAgentRetirementBody(value: unknown): { actor: string; lifecycleUid: string } {
  const body = closedRecord(value, ["actor", "lifecycleUid"]);
  if (!body || typeof body.actor !== "string" || typeof body.lifecycleUid !== "string")
    throw new RequestBodyError(400, "linked agent retirement needs exactly { actor, lifecycleUid }");
  try {
    return { actor: assertValidOwnerToken(body.actor), lifecycleUid: assertLifecycleToken(body.lifecycleUid) };
  } catch {
    throw new RequestBodyError(400, "linked agent retirement needs valid actor and lifecycle tokens");
  }
}

/** The IdP signs lowercase SHA-256 hex of this ordered UTF-8 JSON tuple, not the raw HTTP body. */
function grantRequestDigest(account: string, space: string, owner: string, input: GrantInput): string {
  const { actor, requestId, agentLink, scope, allowSubscribe, allowPublish } = input;
  return createHash("sha256").update(JSON.stringify([
    "cotal/linked-agent-grant/v1", account, space, owner, actor, requestId,
    agentLink.mode, agentLink.mode === "select" ? agentLink.agentUid : null,
    scope, allowSubscribe, allowPublish,
  ])).digest("hex");
}

async function verifyGrant(req: IncomingMessage, opts: LinkedAgentGrantOptions): Promise<LinkedGrantAdmission> {
  const { input, approval } = parseGrant(await readJsonBody(req));
  const { account, space, spaceSecret } = opts;
  try {
    const verified = await verifyLinkedAgentApproval(approval, opts.idp, opts.approvalAudience, {
      account, space, spaceSecret, actor: input.actor,
      requestDigest: owner => grantRequestDigest(account, space, owner, input),
    });
    return { ...input, ...verified };
  } catch (error) {
    if (error instanceof EpEnvelopeError && error.code === "unavailable") throw error;
    throw new EpEnvelopeError("permission-denied", "valid fresh IdP approval for this exact linked grant is required", undefined, "not-executed");
  }
}

function pendingResponse(grant: LinkedGrantAdmission, result: LinkedGrantPending): LinkedGrantPending {
  const { owner, actor, lifecycleUid, agentLink: { mode, agentUid }, actorToken } = result;
  if (result.v !== 1 || result.state !== "pending" || owner !== grant.owner || actor !== grant.actor ||
      mode !== grant.agentLink.mode || typeof agentUid !== "string" || !AGENT_UID.test(agentUid) ||
      (grant.agentLink.mode === "select" && agentUid !== grant.agentLink.agentUid) || typeof lifecycleUid !== "string" ||
      typeof actorToken !== "string" || !actorToken)
    throw new Error("linked grant authority returned mismatched bootstrap material");
  return { v: 1, state: "pending", owner, actor, lifecycleUid: assertLifecycleToken(lifecycleUid), agentLink: { mode, agentUid }, actorToken };
}

/** Native foreground only. An absent authority or unsupported IdP never enables issuance. */
export async function handleLinkedAgentGrant(req: IncomingMessage, res: ServerResponse, opts?: LinkedAgentGrantOptions): Promise<void> {
  if (req.method !== "POST") return send(res, 405, { error: "POST only", code: "bad-request", ...BEFORE });
  if (req.headers.origin !== undefined)
    return send(res, 403, { error: "browser-origin requests are not served here", code: "permission-denied", ...BEFORE });
  if (!/^application\/json\b/.test(req.headers["content-type"] ?? ""))
    return send(res, 415, { error: "content-type must be application/json", code: "bad-request", ...BEFORE });
  if (!opts?.cap || !opts.approvalAudience || opts.approvalAudience === opts.idp.audience)
    return send(res, 503, { error: "linked foreground grants are unavailable on this host", code: "unavailable", ...BEFORE });
  if (req.headers.authorization !== `Bearer ${opts.cap}`)
    return refuseCapability(res, opts, "missing/invalid exchange capability", { code: "unauthenticated", ...BEFORE });

  const peer = LOOPBACK_POLICY.peerKey(req);
  const throttled = LOOPBACK_POLICY.throttled(opts, peer);
  let grant: LinkedGrantAdmission;
  try {
    grant = await verifyGrant(req, opts);
  } catch (e) {
    if (e instanceof RequestBodyError) return send(res, e.status, { error: e.message, code: "bad-request", ...BEFORE });
    if (e instanceof EpEnvelopeError && e.code === "permission-denied")
      return refuseExchange(res, opts, LOOPBACK_POLICY, peer, throttled, "refused a linked foreground grant", REFUSAL_STATUS[e.code] ?? 500,
        { error: e.message, code: e.code, ...BEFORE }, { code: "resource-exhausted", ...BEFORE });
    return send(res, 503, { error: "linked foreground grant verification unavailable", code: "unavailable", ...BEFORE });
  }
  try {
    return send(res, 200, pendingResponse(grant, await opts.admit(grant)), { "cache-control": "no-store" });
  } catch (e) {
    if (e instanceof EpEnvelopeError)
      return send(res, REFUSAL_STATUS[e.code] ?? 500, { error: e.message, code: e.code, outcome: e.outcome ?? "unknown" });
    return send(res, 503, { error: "linked foreground grant authority unavailable", code: "unavailable", outcome: "unknown" });
  }
}
