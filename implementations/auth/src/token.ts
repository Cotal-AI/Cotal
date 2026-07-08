/**
 * User-token validation — the strict Plane-2 check the auth callout runs on the bearer an agent
 * presents in `auth_token` (SPEC-normative claim shape; the plan's §"Token shape").
 *
 * Claim shape (normative): `sub` = the opaque derived owner · `act` = server-authored
 * { owner, actor, scope?, parent? } with AT MOST one parent/spawner audit link (nested delegation
 * chains are cross-account scope, not this plan) · `aud` = the space · `scope` = capability list ·
 * `ver` = token-shape version (a stale `ver` is rejected — downgrade defense).
 *
 * Validation is fail-closed and pinned end-to-end:
 *  - `alg` pinned to EdDSA (Ed25519) — nothing else verifies;
 *  - key-smuggling headers (`jku` / `jwk` / `x5u` / `x5c`) are rejected outright — the key is
 *    resolved ONLY through the caller-pinned resolver (a `createRemoteJWKSet` on a pinned origin,
 *    or a local key); a `kid` never resolves anywhere else;
 *  - `iss` / `aud` enforced; `exp`, `iat`, and `nbf` are REQUIRED; the lifetime is capped and
 *    ANCHORED TO THE VALIDATOR'S CLOCK — future-dated `iat`/`exp` windows are rejected, not just
 *    long spans (short-lived tokens are the v1 revocation lever — an unbounded or post-dated
 *    token would quietly disable it).
 */
import { decodeProtectedHeader, jwtVerify } from "jose";
import type { CryptoKey, JWTVerifyGetKey } from "jose";
import { assertDerivedOwnerToken, assertValidOwnerToken } from "@cotal-ai/core";

/** Current normative token-shape version. Bump only with a SPEC change; validators reject
 *  anything else (older = downgrade, newer = from-the-future misconfig). */
export const USER_TOKEN_VER = 1;

/** Default cap on `exp - iat`. 15 minutes: long enough for connect + retries, short enough that
 *  re-mint is the working revocation path. */
export const MAX_TOKEN_TTL_SEC = 900;

/** The server-authored actor claim. `owner` restates `sub` (cross-checked); `actor` is the
 *  ledger-derived agent-instance id; `parent` is at most ONE spawner audit link. */
export interface UserTokenActor {
  owner: string;
  actor: string;
  scope?: string[];
  /** The spawning principal (`<owner>.<actor>` dot-form), when this agent was spawned by another. */
  parent?: string;
}

/** A fully validated user token, reduced to what the callout needs. */
export interface ValidatedUserToken {
  /** The opaque derived owner (== `sub`, format-asserted). */
  owner: string;
  /** The space this token is scoped to (== `aud`). */
  space: string;
  /** Capability scope (`scope` claim; empty when absent). */
  scope: string[];
  /** The validated actor claim. */
  act: UserTokenActor;
  /** Token-shape version (== {@link USER_TOKEN_VER}). */
  ver: number;
  /** Bearer expiry (unix seconds) — the callout binds the minted NATS user JWT's lifetime to it,
   *  so broker access dies with the bearer (the v1 revocation lever, enforced server-side). */
  exp: number;
}

export interface ValidateUserTokenOpts {
  /** The pinned verification key path: a `createRemoteJWKSet(new URL(<pinned origin>))` resolver
   *  or a local public key. The token itself NEVER influences where the key comes from. */
  key: JWTVerifyGetKey | CryptoKey;
  /** Exact expected issuer (the IdP bridge). */
  issuer: string;
  /** Exact expected audience — the space name. */
  audience: string;
  /** Override of the {@link MAX_TOKEN_TTL_SEC} lifetime cap (tests only; keep short). */
  maxTtlSec?: number;
  /** Clock skew tolerance in seconds (default 5). */
  clockToleranceSec?: number;
}

/** Validate a user bearer token. Returns the reduced, validated claims or THROWS — there is no
 *  partially-valid result and no fallback (a validation failure at the callout is a denied
 *  connection). */
export async function validateUserToken(token: string, opts: ValidateUserTokenOpts): Promise<ValidatedUserToken> {
  const header = decodeProtectedHeader(token);
  if (header.jku !== undefined || header.jwk !== undefined || header.x5u !== undefined || header.x5c !== undefined)
    throw new Error("user token: embedded key material (jku/jwk/x5u/x5c) is rejected — keys resolve only via the pinned JWKS");
  if (header.alg !== "EdDSA") throw new Error(`user token: alg must be EdDSA (got ${String(header.alg)})`);

  const { payload } = await jwtVerify(token, opts.key as JWTVerifyGetKey, {
    algorithms: ["EdDSA"],
    issuer: opts.issuer,
    audience: opts.audience,
    clockTolerance: opts.clockToleranceSec ?? 5,
  });

  // jose's `audience` option is SET-MEMBERSHIP (an aud array containing the space passes) — the
  // bearer must be scoped to EXACTLY this space: the plain string, or a singleton array of it. A
  // multi-audience bearer would be replayable across spaces.
  if (payload.aud !== opts.audience && !(Array.isArray(payload.aud) && payload.aud.length === 1 && payload.aud[0] === opts.audience))
    throw new Error("user token: aud must be exactly the space — a multi-audience bearer is rejected");
  if (typeof payload.exp !== "number") throw new Error("user token: exp is required (tokens must be short-lived)");
  if (typeof payload.iat !== "number") throw new Error("user token: iat is required");
  if (typeof payload.nbf !== "number") throw new Error("user token: nbf is required");
  // The lifetime cap must hold from the VALIDATOR's clock, not the token's own claims — a signed
  // token post-dated a year out (iat/exp both in the future) satisfies `exp - iat ≤ cap` and
  // sails through exp/nbf checks, giving it an effective validity far beyond the cap and quietly
  // defeating the short-lived-token revocation lever. So: iat may not be in the future, and exp
  // may not sit further than the cap from now.
  const maxTtl = opts.maxTtlSec ?? MAX_TOKEN_TTL_SEC;
  const tol = opts.clockToleranceSec ?? 5;
  const now = Math.floor(Date.now() / 1000);
  if (payload.iat > now + tol) throw new Error("user token: iat is in the future");
  if (payload.exp > now + maxTtl + tol)
    throw new Error(`user token: exp is more than the ${maxTtl}s cap past now — short-lived tokens are the revocation lever`);
  if (payload.exp - payload.iat > maxTtl)
    throw new Error(`user token: lifetime ${payload.exp - payload.iat}s exceeds the ${maxTtl}s cap — short-lived tokens are the revocation lever`);

  if (payload.ver !== USER_TOKEN_VER)
    throw new Error(`user token: ver ${String(payload.ver)} != ${USER_TOKEN_VER} — stale or unknown token shape (downgrade defense)`);

  if (typeof payload.sub !== "string") throw new Error("user token: sub must be a string token — no coercion at a trust boundary");
  const owner = assertDerivedOwnerToken(payload.sub);

  const act = payload.act as UserTokenActor | undefined;
  if (!act || typeof act !== "object") throw new Error("user token: act claim is required (server-authored owner/actor)");
  if (act.owner !== owner) throw new Error(`user token: act.owner "${String(act.owner)}" != sub "${owner}" — inconsistent principal`);
  if (typeof act.actor !== "string") throw new Error("user token: act.actor must be a string token — no coercion at a trust boundary");
  assertValidOwnerToken(act.actor);
  if (act.scope !== undefined && !(Array.isArray(act.scope) && act.scope.every((s) => typeof s === "string")))
    throw new Error("user token: act.scope must be a string list when present");
  if (act.parent !== undefined) {
    // At most ONE parent audit link, and it must BE a principal (dot-form <owner>.<actor> with a
    // derived owner) — an arbitrary string here would flow into mint/audit trails unchecked.
    if (typeof act.parent !== "string")
      throw new Error("user token: act.parent must be a single principal string when present (no delegation chains)");
    const parts = act.parent.split(".");
    if (parts.length !== 2)
      throw new Error(`user token: act.parent "${act.parent}" is not a principal (<owner>.<actor> dot-form)`);
    assertDerivedOwnerToken(parts[0]);
    assertValidOwnerToken(parts[1]);
  }

  const scope = payload.scope === undefined ? [] : payload.scope;
  if (!(Array.isArray(scope) && scope.every((s) => typeof s === "string")))
    throw new Error("user token: scope must be a string list when present");

  return {
    owner,
    space: opts.audience,
    scope,
    act: { owner: act.owner, actor: act.actor, scope: act.scope, parent: act.parent },
    ver: USER_TOKEN_VER,
    exp: payload.exp,
  };
}
