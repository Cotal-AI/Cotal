import type { IncomingMessage, ServerResponse } from "node:http";
import { assertValidOwnerToken } from "@cotal-ai/core";
import { decodeJwt } from "jose";
import { ConnectRateLimited } from "./connect-limit.js";
import { checkConversationResumeExchange } from "./conversation-resume-exchange.js";
import { deriveOwnerForIdpSubject } from "./derive.js";
import { verifyIdpToken } from "./idp.js";
import { AGENT_BEARER_TTL_SEC, ledgerAuthorizeAgentExchange } from "./ledger.js";
import type { HandlerCtx, ManagerCaller } from "./service.js";
import { readJsonBody, refuseCapability, refuseExchange, send } from "./service-http.js";
import { grantCoordinates } from "./session-redemption.js";
import { PUBLIC_EXCHANGE_VIEWS, assertTransferWriterClaim, type UserTokenView } from "./token.js";

/** Failed-exchange rate limit: at most this many REFUSED exchanges per rolling minute; further
 *  attempts get 429 until the window drains. Successes are unthrottled (the CLI's normal path). */
const FAILED_EXCHANGE_PER_MIN = 30;

/** PUBLIC-face budgets — their own pools entirely, so public probing can never consume the
 *  loopback face's windows (and vice versa). A full per-peer probing bucket never refuses a
 *  request that would have succeeded, matching the loopback stance. */
const PUBLIC_FAILED_PER_MIN = 30; // per-PEER refused-exchange window (rolling minute)
const PUBLIC_PEER_BUCKETS_MAX = 1024; // bounded LRU of per-peer failure buckets
/** PUBLIC-face per-principal authenticated manager-selection refusal budget (#3959): once a
 *  caller's credential and actor grant verify, manager-selection refusals are tracked in two
 *  rolling windows per authenticated principal keyed by principal and request class (`pinned`
 *  when the request names a manager instance, `unpinned` when it does not, never by the requested
 *  instance id) in a 1024-key LRU. Each class counts only its own selection refusals and, once
 *  full, sheds `selectManagerInstance` for that class (refusing requests of that class, including
 *  ones that would have succeeded, with its class remedy while leaving the other class open). */
const PUBLIC_SELECTION_FAILED_PER_MIN = 30; // per-principal-class selection-refusal window (rolling minute)
const PUBLIC_SELECTION_BUCKETS_MAX = 1024; // bounded LRU of per-principal-class selection-refusal buckets
const PUBLIC_UNPINNED_SELECTION_THROTTLED_REASON =
  "too many manager-caller selection refusals - name a manager instance (--on <id> or --manager-instance <id>) or start one with `cotal manager start`, then wait a minute and retry";
const PUBLIC_PINNED_SELECTION_THROTTLED_REASON =
  "too many pinned manager-caller selection refusals - check that the pinned manager instance is live and registered to you, then wait a minute and retry";

/** An unpinned manager-caller selection that found no single live manager. It is raised only after
 *  the exchange's credential verified, and it describes the caller's own owner, so it is not probing:
 *  the exchange arms neither count it against the refused-exchange budget nor hide it behind 429. */
export class ManagerSelectionRefusal extends Error {}

/** Per-listener policy for `POST /exchange` — how a caller is proven, attributed, and throttled on
 *  the face the request arrived on. The loopback face demands the per-start capability (a same-uid
 *  file-ACL boundary via the 0600 discovery file) and attributes peers by socket address; the
 *  public face demands no capability (it has no remote meaning — the credential is the proof) and
 *  buckets failures per peer. Each face owns its budgets — neither can starve the other.
 *  `POST /manager-service-authority` takes the same policy and spends the same budgets. */
export interface ExchangePolicy {
  /** Demand `Authorization: Bearer <cap>` (the discovery-file capability) before anything else. */
  requireCapability: boolean;
  /** Refuse `view` requests that are not in {@link PUBLIC_EXCHANGE_VIEWS}. Loopback leaves this
   *  false so every view still reaches the bridge; the public face keeps god-view, history-purge,
   *  deployer, and manager-service loopback-only. */
  refuseViews: boolean;
  /** Name the requesting peer for failure attribution. */
  peerKey(req: IncomingMessage): string;
  /** True when this face's refused-exchange budget (for `peer`) is exhausted; prunes the window. */
  throttled(ctx: Pick<HandlerCtx, "failures">, peer: string): boolean;
  /** Record a refused exchange against this face's budget (for `peer`). */
  recordFailure(ctx: Pick<HandlerCtx, "failures">, peer: string): void;
  /** Public face only: rolling window of authenticated manager-selection refusals for `key`
   *  (`${principal}:pinned` or `${principal}:unpinned`). Absent on loopback, which keeps its
   *  existing refusal classification and shared probing window. */
  selectionWindow?(key: string): number[];
}

/** The loopback face: capability-gated; peers keyed by socket remote address; one shared
 *  refused-exchange window (the pre-public behavior, unchanged). */
export const LOOPBACK_POLICY: ExchangePolicy = {
  requireCapability: true,
  refuseViews: false,
  peerKey: (req) => req.socket.remoteAddress ?? "loopback",
  throttled: (ctx) => {
    const now = Date.now();
    while (ctx.failures.length && now - ctx.failures[0] > 60_000) ctx.failures.shift();
    return ctx.failures.length >= FAILED_EXCHANGE_PER_MIN;
  },
  recordFailure: (ctx) => ctx.failures.push(Date.now()),
};

/** Bounded LRU of 60-second rolling timestamp windows, shared by per-peer public throttling and
 *  per-principal public selection throttling. */
function makeRollingBuckets(max: number): (key: string) => number[] {
  const buckets = new Map<string, number[]>(); // insertion order = recency (touched keys re-insert)
  return (key: string): number[] => {
    const existing = buckets.get(key);
    let b: number[];
    if (existing !== undefined) {
      buckets.delete(key); // re-insert → most-recently-used
      buckets.set(key, existing);
      b = existing;
    } else {
      if (buckets.size >= max) buckets.delete(buckets.keys().next().value as string);
      b = [];
      buckets.set(key, b);
    }
    const now = Date.now();
    while (b.length && now - b[0] > 60_000) b.shift();
    return b;
  };
}

/** The public face's policy: no capability, views other than {@link PUBLIC_EXCHANGE_VIEWS}
 *  refused, and failures bucketed per peer in a
 *  bounded LRU — peer A's refusal flood throttles peer A, not peer B, and never the loopback
 *  face. With `trustedProxy`, the peer is the LAST X-Forwarded-For hop (the one address the
 *  operator's own reverse proxy appended — earlier hops are attacker-writable); without it the
 *  header is ignored entirely and the socket remote address attributes the peer. */
export function makePublicPolicy(trustedProxy: boolean): ExchangePolicy {
  const bucket = makeRollingBuckets(PUBLIC_PEER_BUCKETS_MAX);
  const selectionBucket = makeRollingBuckets(PUBLIC_SELECTION_BUCKETS_MAX);
  return {
    requireCapability: false,
    refuseViews: true,
    peerKey: (req) => {
      if (trustedProxy) {
        const xff = req.headers["x-forwarded-for"];
        const last = (Array.isArray(xff) ? xff[xff.length - 1] : xff)?.split(",").pop()?.trim();
        if (last) return last;
      }
      return req.socket.remoteAddress ?? "unknown";
    },
    throttled: (_ctx, peer) => {
      const b = bucket(peer);
      return b.length >= PUBLIC_FAILED_PER_MIN;
    },
    recordFailure: (_ctx, peer) => bucket(peer).push(Date.now()),
    selectionWindow: (principal) => selectionBucket(principal),
  };
}

/** Public-face authenticated manager-selection (#3959): called ONLY after the caller's
 *  credential (IdP JWT or actor secret) and ledger actor grant have verified. On loopback
 *  (`policy.selectionWindow === undefined`), selection runs directly inside the caller's try and
 *  keeps its existing refusal classification: unpinned selection misses do not spend the probing
 *  budget. On the
 *  public face, each verified principal has two selection-refusal windows keyed by principal and
 *  request class (`pinned` when `requested !== undefined`, `unpinned` when `requested === undefined`,
 *  never by the requested instance id): each class checks its own window BEFORE
 *  `selectManagerInstance` runs, sheds only its own selection work with its class remedy when
 *  full (refusing requests of that class that would have succeeded while leaving the other class
 *  open), and records in-budget selection refusals into that class window without touching the
 *  per-peer probing budget. */
async function selectExchangeManagerInstance(
  res: ServerResponse,
  ctx: Pick<HandlerCtx, "selectManagerInstance">,
  policy: ExchangePolicy,
  principal: string,
  owner: string,
  requested: string | undefined,
  caller: ManagerCaller,
  logLabel: string,
): Promise<string | undefined> {
  if (!policy.selectionWindow) return ctx.selectManagerInstance(owner, requested, caller);
  const selectionClass = requested !== undefined ? "pinned" : "unpinned";
  const window = policy.selectionWindow(`${principal}:${selectionClass}`);
  if (window.length >= PUBLIC_SELECTION_FAILED_PER_MIN) {
    const throttledReason =
      selectionClass === "pinned" ? PUBLIC_PINNED_SELECTION_THROTTLED_REASON : PUBLIC_UNPINNED_SELECTION_THROTTLED_REASON;
    console.error(`auth-service: ${logLabel}: ${throttledReason}`);
    send(res, 429, { error: throttledReason });
    return undefined;
  }
  try {
    return await ctx.selectManagerInstance(owner, requested, caller);
  } catch (e) {
    window.push(Date.now());
    const reason = e instanceof Error ? e.message : String(e);
    console.error(`auth-service: ${logLabel}: ${reason}`);
    send(res, 401, { error: reason });
    return undefined;
  }
}

/** The exchange body, shared by every face; `policy` says how this face proves and attributes the
 *  caller, and whether authenticated manager-selection refusals use the public face's two
 *  per-principal class windows (`pinned` and `unpinned`) or the loopback face's existing
 *  refusal classification. */
export async function handleExchange(req: IncomingMessage, res: ServerResponse, ctx: HandlerCtx, policy: ExchangePolicy): Promise<void> {
  if (req.method !== "POST") return send(res, 405, { error: "POST only" });
  // Browser exclusion: a cross-site page CAN reach loopback, but its requests carry `Origin`
  // (and can't strip it). The CLI never sends one. Reject before touching anything else.
  if (req.headers.origin !== undefined) return send(res, 403, { error: "browser-origin requests are not served here" });
  if (!/^application\/json\b/.test(req.headers["content-type"] ?? ""))
    return send(res, 415, { error: "content-type must be application/json" });
  if (policy.requireCapability) {
    // The capability gate: same-user file ACL on the 0600 discovery file is the boundary. An
    // invalid/missing cap is still a failed exchange attempt — audited and throttled, in its own
    // window (see BAD_CAP_PER_MIN), before anything downstream is touched.
    const auth = req.headers.authorization ?? "";
    if (auth !== `Bearer ${ctx.cap}`)
      return refuseCapability(res, ctx, "missing/invalid exchange capability - read it from the space's auth-service.json");
  }
  // Refused-exchange rate limit (probing protection): count only FAILURES, on THIS face's budget.
  //
  // The gate is evaluated here but NOT enforced here. Enforcing before the body was read meant a
  // full bucket refused every request from that peer key, including ones carrying a valid IdP JWT
  // or actor token - and on the public face the default peer key is the socket address, so in the
  // reverse-proxy topology `run-a-mesh.md` recommends, every client shares one bucket. Thirty
  // unauthenticated garbage POSTs then denied the public mint path for a rolling minute (#802).
  //
  // Peer throttling exists to slow PROBING, and a valid credential is not probing. So a throttled
  // peer still gets its credential evaluated: if it is good, it mints; if it is bad, the refusal
  // arms below answer 429 instead of the specific reason, because the reason is what makes probing
  // cheap and withholding it is the whole point of the peer budget. A full peer bucket never
  // refuses a request that would have succeeded; on the public face, only a principal's own full
  // `pinned` or `unpinned` selection-refusal window sheds `selectManagerInstance` for that class
  // (refusing requests of that class before selection, including ones that would have succeeded,
  // while leaving the other class open).
  const peer = policy.peerKey(req);
  const peerThrottled = policy.throttled(ctx, peer);
  const body = await readJsonBody(req);
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    const reason = "exchange body must be a JSON object";
    return refuseExchange(res, ctx, policy, peer, peerThrottled, `refused an exchange: ${reason}`, 400, { error: reason });
  }
  const { idpToken, actor, actorToken, owner, ttlSec, view, managerInstanceId, sessionGrant, transferWriter, conversationResume } = body as {
    idpToken?: unknown;
    actor?: unknown;
    actorToken?: unknown;
    owner?: unknown;
    ttlSec?: unknown;
    view?: unknown;
    managerInstanceId?: unknown;
    sessionGrant?: unknown;
    transferWriter?: unknown;
    conversationResume?: unknown;
  };
  if ((view === "session-caller") !== (sessionGrant !== undefined))
    return send(res, 400, { error: 'view "session-caller" and sessionGrant come together or not at all' });
  if ((view === "transfer-writer") !== (transferWriter !== undefined))
    return send(res, 400, { error: 'view "transfer-writer" and transferWriter come together or not at all' });
  if (ttlSec !== undefined && typeof ttlSec !== "number") return send(res, 400, { error: "ttlSec must be a number" });
  if (view !== undefined && typeof view !== "string") return send(res, 400, { error: "view must be a string when present" });
  if (managerInstanceId !== undefined && typeof managerInstanceId !== "string") return send(res, 400, { error: "managerInstanceId must be a string when present" });
  if (managerInstanceId !== undefined && view !== "manager-caller") return send(res, 400, { error: 'managerInstanceId is valid only with view "manager-caller"' });
  // Public face: channel-writer / channel-purger and the narrowing manager-caller view.
  // admin, purger, deployer, and manager-service stay loopback-only, whatever the credential.
  // A refused view is a refused exchange, answered through refuseExchange like the neighbouring
  // denial sites. A served view stays unthrottled.
  if (policy.refuseViews && view !== undefined && !(PUBLIC_EXCHANGE_VIEWS as readonly string[]).includes(view)) {
    const reason = "elevated views are a loopback operator surface - the public exchange never serves them";
    return refuseExchange(res, ctx, policy, peer, peerThrottled, `refused an exchange: ${reason}`, 403, { error: reason });
  }
  // TWO grant types, disjoint by construction: a HUMAN exchange proves an IdP session
  // (idpToken), an AGENT exchange proves a spawn-time ledger secret (owner + actorToken).
  // A request presenting both is malformed — refuse rather than pick.
  if (idpToken !== undefined && actorToken !== undefined)
    return send(res, 400, { error: "exchange takes idpToken (human) OR owner+actorToken (agent), never both" });
  if (actorToken !== undefined) {
    // The actor-secret exception is manager-caller only: it adds no command capability.
    // Elevated views still require a signed-in human, whatever this agent's row carries.
    if (view !== undefined && view !== "manager-caller")
      return send(res, 400, { error: "the managed (agent-secret) exchange never mints elevated views - views ride a signed-in human exchange" });
    if (typeof owner !== "string" || !owner || typeof actor !== "string" || !actor || typeof actorToken !== "string" || !actorToken)
      return send(res, 400, { error: "agent exchange needs { owner: string, actor: string, actorToken: string, ttlSec?: number }" });
    const readRouting = () => ctx.resolvePluginChannelState(ctx.space);
    if (req.headers["cotal-conversation-resume"] === "1") {
      if (view !== undefined || ttlSec !== undefined) return send(res, 400, { error: "conversation resume cannot mint a bearer" });
      const answer = await checkConversationResumeExchange(ctx.dir, owner, actor, actorToken, conversationResume, readRouting);
      if (answer.status === 401) return refuseExchange(res, ctx, policy, peer, peerThrottled, "refused an agent exchange: conversation resume was refused", 401, answer.body);
      return send(res, answer.status, answer.body);
    }
    try {
      const grant = await ledgerAuthorizeAgentExchange(ctx.dir, owner, actor, actorToken, readRouting);
      if (typeof grant.lifecycleUid !== "string" || !grant.lifecycleUid)
        throw new Error(`actor "${actor}" has no lifecycleUid on its ledger row - respawn it (bearers are lifecycle-bound from v0.4)`);
      ctx.connectLimiter.check({ owner, actor });
      let selectedManagerInstanceId: string | undefined;
      if (view === "manager-caller") {
        selectedManagerInstanceId = await selectExchangeManagerInstance(
          res,
          ctx,
          policy,
          `${owner}.${actor}`,
          owner,
          managerInstanceId as string | undefined,
          "agent",
          "refused an agent exchange",
        );
        if (selectedManagerInstanceId === undefined) return;
      }
      // Credential-BIND the bearer (SPEC 13.1, R1): the incarnation's live root credential is
      // ensured (minted release-last on first exchange) BEFORE the bearer bytes are signed,
      // and rides act.credentialId — the connect arm requires it against the LIVE cred row.
      const credentialId = await ctx.mintConnectCredential({ owner, actor, lifecycleUid: grant.lifecycleUid });
      const token = await ctx.issuer.issue({
        owner,
        space: ctx.space,
        actor,
        scope: grant.scope,
        parent: grant.parent,
        // Lifecycle-BIND the bearer (SPEC 13.1): the row's uid rides act.lifecycleUid, and the
        // callout refuses a mismatch against the CURRENT row at connect — a predecessor's
        // still-unexpired bearer dies at the alias's respawn instead of minting the
        // successor's broker authority.
        lifecycleUid: grant.lifecycleUid,
        credentialId,
        ...(view === "manager-caller" ? { view, managerInstanceId: selectedManagerInstanceId } : {}),
        ttlSec: Math.min(ttlSec ?? AGENT_BEARER_TTL_SEC, AGENT_BEARER_TTL_SEC),
      });
      const { exp } = decodeJwt(token);
      return send(res, 200, { token, owner, exp });
    } catch (e) {
      const reason = e instanceof Error ? e.message : String(e);
      if (e instanceof ConnectRateLimited) return sendRateLimited(res, e);
      if (e instanceof ManagerSelectionRefusal) {
        console.error(`auth-service: refused an agent exchange: ${reason}`);
        return send(res, 401, { error: reason });
      }
      return refuseExchange(res, ctx, policy, peer, peerThrottled, `refused an agent exchange: ${reason}`, 401, { error: reason });
    }
  }
  if (typeof idpToken !== "string" || !idpToken || typeof actor !== "string" || !actor)
    return send(res, 400, { error: "exchange needs { idpToken: string, actor: string, ttlSec?: number, view?: string }" });
  try {
    // The bridge validates `view` against the closed enum and the fresh ledger grant — an
    // unknown or under-scoped view is a refused exchange (audited + throttled like any other).
    let selectedManagerInstanceId: string | undefined;
    if (view === "manager-caller") {
      assertValidOwnerToken(actor);
      const derivedOwner = deriveOwnerForIdpSubject(
        ctx.ownerSecret,
        ctx.bridgeIdp.issuer,
        (await verifyIdpToken(idpToken, ctx.bridgeIdp)).sub,
      );
      ctx.authorizeActor(derivedOwner, actor);
      selectedManagerInstanceId = await selectExchangeManagerInstance(
        res,
        ctx,
        policy,
        derivedOwner,
        derivedOwner,
        managerInstanceId as string | undefined,
        "human",
        "refused an exchange",
      );
      if (selectedManagerInstanceId === undefined) return;
    }
    // #2312: a session-caller bearer is signed only once the identity plane has decided that THIS
    // principal holds THAT redeemed session. The bridge's `verifySession` hook runs the decision on
    // the principal it derived, before signing; the callout re-runs it at the mint.
    const session = view === "session-caller" ? grantCoordinates(sessionGrant) : undefined;
    if (transferWriter !== undefined) assertTransferWriterClaim(transferWriter);
    const r = await ctx.bridge.exchange(idpToken, {
      actor,
      ttlSec,
      view: view as UserTokenView | undefined,
      managerInstanceId: selectedManagerInstanceId,
      ...(session ? { verifySession: (p: { owner: string; actor: string; lifecycleUid: string }) => ctx.verifySession(p, session) } : {}),
      ...(transferWriter !== undefined ? { transferWriter } : {}),
    });
    return send(res, 200, r);
  } catch (e) {
    // A refused exchange (bad IdP token, ungranted actor, expired proof) is an AUTHENTICATED
    // denial with the reason — the client shows it to the operator verbatim.
    const reason = e instanceof Error ? e.message : String(e);
    if (e instanceof ConnectRateLimited) return sendRateLimited(res, e);
    if (e instanceof ManagerSelectionRefusal) {
      console.error(`auth-service: refused an exchange: ${reason}`);
      return send(res, 401, { error: reason });
    }
    return refuseExchange(res, ctx, policy, peer, peerThrottled, `refused an exchange: ${reason}`, 401, { error: reason });
  }
}

/** An authenticated exchange whose actor the connect limits refuse. It is not probing, so it spends
 *  no refused-exchange budget; it answers 429 with the typed body and `Retry-After` (SPEC §10). */
function sendRateLimited(res: ServerResponse, e: ConnectRateLimited): void {
  console.error(`auth-service: refused an exchange: ${e.code} retry-after ${e.retryAfterSeconds}s: ${e.message}`);
  send(res, 429, { code: e.code, retryAfterSeconds: e.retryAfterSeconds, limit: e.limit, error: `${e.message} - retry in ${e.retryAfterSeconds}s` }, { "retry-after": String(e.retryAfterSeconds) });
}
