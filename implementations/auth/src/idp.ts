/**
 * Plane-1 IdP bridge — the token exchange that turns an EXTERNAL IdP-authenticated human into a
 * Cotal user bearer (the plan's §"Plane 1"): verify the IdP's JWT offline against its pinned JWKS,
 * derive the opaque per-space owner from the IdP subject, authorize the requested actor against
 * the operator's ledger, and mint the bearer through the {@link UserTokenIssuer}.
 *
 * The bridge is IdP-GENERIC on purpose (pluggable edges): any IdP that publishes an EdDSA/Ed25519
 * JWKS and mints `iss`/`aud`/`sub`/`exp` JWTs plugs in via {@link IdpConfig} — Better Auth (JWT
 * plugin) is the reference IdP, and the integration smoke runs a real instance. Nothing
 * Better-Auth-specific leaks in here.
 *
 * Trust-boundary order inside {@link IdpBridge.exchange} (each step fail-loud, no fallback):
 *  1. the requested actor is grammar-asserted BEFORE anything else touches it;
 *  2. the IdP token verifies against the PINNED key path only — `alg` pinned to EdDSA, embedded
 *     key material (`jku`/`jwk`/`x5u`/`x5c`) rejected outright, exact `iss`/`aud`, `exp` and a
 *     non-post-dated `iat` required, `sub` a non-empty string (no coercion);
 *  3. the owner derives from the JSON-array encoding of [idp issuer, sub] — issuer-namespaced so
 *     the same `sub` from two IdPs can never collide, INJECTIVE by construction (JSON escaping —
 *     no delimiter an issuer/sub pair could straddle), and deterministic so re-login re-lands in
 *     the same lanes. This encoding is FROZEN: changing it (or the IdP issuer string) re-keys
 *     every owner in the space — a migration, like rotating the space secret;
 *  4. the ledger hook AUTHORIZES (owner, actor) and is the ONLY source of `scope`/`parent` — the
 *     request cannot carry them (server-authored `act`, no confused deputy). The hook must return
 *     an explicit grant object; anything else is a deny;
 *  5. the issuer mints (which re-asserts every claim shape — the issuer ↔ validator inverse).
 */
import { decodeJwt, decodeProtectedHeader, jwtVerify } from "jose";
import type { CryptoKey, JWTVerifyGetKey } from "jose";
import { assertValidOwnerToken } from "@cotal-ai/core";
import { deriveOwnerToken } from "./derive.js";
import type { UserTokenIssuer } from "./issuer.js";

/** The pinned identity of ONE external IdP. All fields are operator config — nothing in here is
 *  ever read from a presented token. */
export interface IdpConfig {
  /** Exact `iss` the IdP mints (Better Auth default: its base-URL origin). */
  issuer: string;
  /** Exact `aud` the IdP mints (Better Auth default: its base-URL origin). */
  audience: string;
  /** The pinned verification key path over the IdP's JWKS — a {@link pinnedJwksResolver} on the
   *  IdP's JWKS URL, or a local public key. The token never influences key resolution. */
  key: JWTVerifyGetKey | CryptoKey;
  /** Clock skew tolerance in seconds (default 5). */
  clockToleranceSec?: number;
}

/** What the operator's ledger grants a (owner, actor) pair — the ONLY source of `scope`/`parent`
 *  in the minted bearer. Returned by {@link CreateIdpBridgeOpts.authorizeActor}; the hook throws
 *  to deny. */
export interface ActorGrant {
  scope?: string[];
  /** The spawning principal (`<owner>.<actor>` dot-form), when the ledger records one. */
  parent?: string;
}

export interface CreateIdpBridgeOpts {
  /** The one IdP this bridge trusts. */
  idp: IdpConfig;
  /** The space every minted bearer is scoped to (`aud`). One bridge per space. */
  space: string;
  /** The space's owner-derivation secret (≥32 bytes, operator-held). */
  spaceSecret: string | Uint8Array;
  /** The Plane-1 issuer that mints the Cotal bearer. */
  issuer: UserTokenIssuer;
  /** The ledger authority: is `actor` a live, ledger-authorized instance of `owner`, and what does
   *  it get? MUST return an {@link ActorGrant} object to allow; throw to deny. There is no
   *  allow-by-default — a hook that returns anything else fails the exchange. */
  authorizeActor: (owner: string, actor: string) => ActorGrant | Promise<ActorGrant>;
}

/** A successful exchange: the minted bearer plus what a caller needs to cache/refresh it. */
export interface ExchangeResult {
  /** The Cotal user bearer (compact JWS) the agent presents in `auth_token`. */
  token: string;
  /** The derived opaque owner the bearer is bound to. */
  owner: string;
  /** Bearer expiry (unix seconds) — schedule re-mint before this. */
  exp: number;
}

export interface IdpBridge {
  /** Exchange a verified IdP token for a Cotal user bearer bound to (derived owner, actor). */
  exchange(idpToken: string, req: { actor: string; ttlSec?: number }): Promise<ExchangeResult>;
}

/** Verify an external IdP JWT against the pinned config and return its `sub`. Same pinning
 *  posture as `validateUserToken`, minus the Cotal claim shape (an IdP token has no `ver`/`act`;
 *  its lifetime is the IdP's session policy, so no cap — but it must expire and must not be
 *  post-dated). */
async function verifyIdpToken(token: string, idp: IdpConfig): Promise<string> {
  const header = decodeProtectedHeader(token);
  if (header.jku !== undefined || header.jwk !== undefined || header.x5u !== undefined || header.x5c !== undefined)
    throw new Error("idp token: embedded key material (jku/jwk/x5u/x5c) is rejected — keys resolve only via the pinned JWKS");
  if (header.alg !== "EdDSA") throw new Error(`idp token: alg must be EdDSA (got ${String(header.alg)})`);

  const tol = idp.clockToleranceSec ?? 5;
  const { payload } = await jwtVerify(token, idp.key as JWTVerifyGetKey, {
    algorithms: ["EdDSA"],
    issuer: idp.issuer,
    audience: idp.audience,
    clockTolerance: tol,
  });

  // jose's `audience` option is SET-MEMBERSHIP (an aud array containing the expected value
  // passes) — exact means the token's audience set is exactly {configured}: the plain string, or
  // a singleton array of it. A multi-audience session proof minted for other services too must
  // not be exchangeable here.
  if (payload.aud !== idp.audience && !(Array.isArray(payload.aud) && payload.aud.length === 1 && payload.aud[0] === idp.audience))
    throw new Error("idp token: aud must be exactly the configured audience — a multi-audience session proof is rejected");
  if (typeof payload.exp !== "number") throw new Error("idp token: exp is required — an IdP session proof must expire");
  if (typeof payload.iat !== "number") throw new Error("idp token: iat is required");
  if (payload.iat > Math.floor(Date.now() / 1000) + tol) throw new Error("idp token: iat is in the future");
  if (typeof payload.sub !== "string" || !payload.sub)
    throw new Error("idp token: sub must be a non-empty string user id — no coercion at a trust boundary");
  return payload.sub;
}

/** Build an {@link IdpBridge}. Misconfig fails HERE, at construction — an empty pin would
 *  otherwise fail closed on every exchange with a far worse operator signal. */
export function createIdpBridge(opts: CreateIdpBridgeOpts): IdpBridge {
  if (!opts.space) throw new Error("idp bridge: a space is required");
  if (typeof opts.idp?.issuer !== "string" || !opts.idp.issuer)
    throw new Error("idp bridge: idp.issuer (the exact iss pin) is required");
  if (typeof opts.idp.audience !== "string" || !opts.idp.audience)
    throw new Error("idp bridge: idp.audience (the exact aud pin) is required");
  if (!opts.idp.key) throw new Error("idp bridge: idp.key (the pinned JWKS resolver / public key) is required");
  if (typeof opts.authorizeActor !== "function")
    throw new Error("idp bridge: an authorizeActor ledger hook is required — there is no allow-by-default");
  return {
    exchange: async (idpToken, req) => {
      assertValidOwnerToken(req.actor);
      const sub = await verifyIdpToken(idpToken, opts.idp);
      // JSON-array encoding, NOT `${issuer}|${sub}`: a bare-delimiter concat is non-injective
      // (("a","b|c") and ("a|b","c") would hash the same input). Safe-by-luck today (one fixed
      // issuer per bridge), but the derivation input is frozen once real owners exist — an
      // ambiguity here becomes an owner re-key migration, so it is closed now, while it's free.
      const owner = deriveOwnerToken(opts.spaceSecret, JSON.stringify([opts.idp.issuer, sub]));
      const grant = await opts.authorizeActor(owner, req.actor);
      if (grant === null || typeof grant !== "object" || Array.isArray(grant))
        throw new Error("idp bridge: authorizeActor must return a grant object — anything else is a deny");
      const token = await opts.issuer.issue({
        owner,
        space: opts.space,
        actor: req.actor,
        scope: grant.scope,
        parent: grant.parent,
        ttlSec: req.ttlSec,
      });
      const { exp } = decodeJwt(token);
      if (typeof exp !== "number") throw new Error("idp bridge: minted bearer is missing exp — issuer contract violated");
      return { token, owner, exp };
    },
  };
}
