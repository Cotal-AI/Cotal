/**
 * Plane-1 user-bearer ISSUER — the server-side piece that turns an already-authenticated human
 * (an owner) into the short-lived Cotal user bearer an agent presents to the callout (the plan's
 * §"Plane 1"; the exact claim shape {@link validateUserToken} enforces on the other side).
 *
 * This is the production form of what the callout E2E smoke hand-rolls: an EdDSA (Ed25519) signer
 * whose public keys are published as a JWKS the callout verifies against OFFLINE. It is deliberately
 * NOT the Better-Auth binding (that's Plane-1's IdP adapter, a later slice) — an issuer takes an
 * ALREADY-derived owner + a ledger-authorized actor and mints; deriving the owner and authorizing
 * the actor happen upstream.
 *
 * Load-bearing properties:
 *  - `alg` is EdDSA only; every token carries a `kid` so verifiers pick the right key across rotation;
 *  - the minted claims are exactly {@link validateUserToken}'s reject matrix inverse — a token this
 *    issuer produces MUST validate, and the round-trip smoke pins that (issuer ↔ validator agree);
 *  - the lifetime is capped at {@link MAX_TOKEN_TTL_SEC} at MINT (fail loud on an overlong ask) — the
 *    validator caps on the read side too, but a mint that quietly exceeded the cap would be dead JWTs;
 *  - rotation is real: multiple keys live in the JWKS at once (sign with the newest, verify any
 *    still-published kid), and a retired kid stops verifying — that's the revocation seam for the
 *    signing key, distinct from the per-token exp lever.
 *
 * NOTHING here leaks private material: `jwks()` exports public JWKs only; the private key stays a
 * `CryptoKey` in memory (or a persisted private JWK the operator controls).
 */
import { SignJWT, calculateJwkThumbprint, createRemoteJWKSet, exportJWK, generateKeyPair, importJWK } from "jose";
import type { CryptoKey, JWK, JWTVerifyGetKey } from "jose";
import { assertDerivedOwnerToken, assertValidOwnerToken } from "@cotal-ai/core";
import { MAX_TOKEN_TTL_SEC, USER_TOKEN_VER, USER_TOKEN_VIEWS, type UserTokenView } from "./token.js";

/** The one signing algorithm — Ed25519. Pinned on both mint and verify. */
export const USER_TOKEN_ALG = "EdDSA";

/** An active signing key: the private `CryptoKey` for minting + its published public JWK. The `kid`
 *  is the RFC 7638 thumbprint of the public key (stable, collision-free, verifier-recomputable). */
export interface SigningKey {
  kid: string;
  privateKey: CryptoKey;
  /** Public JWK as published in the set (carries `kid`/`alg`/`use`; never `d`). */
  publicJwk: JWK;
}

/** A signing key serialized for persistence — the PRIVATE JWK (with `d`) plus its kid. Guard this at
 *  rest like any signing secret; `importSigningKey` restores it (kid integrity re-checked). */
export interface SerializedSigningKey {
  kid: string;
  privateJwk: JWK;
}

function publicMembers(jwk: JWK): JWK {
  // OKP public projection — the members a verifier (and the thumbprint) needs; drop the private `d`.
  if (jwk.kty !== "OKP" || jwk.crv !== "Ed25519" || typeof jwk.x !== "string")
    throw new Error(`signing key must be an Ed25519 OKP JWK (got kty=${String(jwk.kty)} crv=${String(jwk.crv)})`);
  return { kty: jwk.kty, crv: jwk.crv, x: jwk.x };
}

async function toSigningKey(privateKey: CryptoKey, privateJwk: JWK): Promise<SigningKey> {
  const pub = publicMembers(privateJwk);
  const kid = await calculateJwkThumbprint(pub);
  return { kid, privateKey, publicJwk: { ...pub, kid, alg: USER_TOKEN_ALG, use: "sig" } };
}

/** Mint a fresh Ed25519 signing key (extractable, so it can be persisted with {@link exportSigningKey}). */
export async function generateSigningKey(): Promise<SigningKey> {
  const { privateKey } = await generateKeyPair(USER_TOKEN_ALG, { extractable: true });
  return toSigningKey(privateKey as CryptoKey, await exportJWK(privateKey as CryptoKey));
}

/** Serialize a signing key (private JWK + kid) for persistence. */
export async function exportSigningKey(key: SigningKey): Promise<SerializedSigningKey> {
  return { kid: key.kid, privateJwk: await exportJWK(key.privateKey) };
}

/** Restore a persisted signing key; re-derives the kid from the public projection and refuses a
 *  serialized blob whose stored kid doesn't match (tamper / corruption fail-loud). */
export async function importSigningKey(s: SerializedSigningKey): Promise<SigningKey> {
  const privateKey = (await importJWK(s.privateJwk, USER_TOKEN_ALG)) as CryptoKey;
  const key = await toSigningKey(privateKey, s.privateJwk);
  if (key.kid !== s.kid) throw new Error(`signing key kid mismatch: serialized ${s.kid} != recomputed ${key.kid}`);
  return key;
}

/** The claims a caller supplies to mint a bearer — the owner is already derived and the actor is
 *  already ledger-authorized upstream; the issuer only stamps and signs. */
export interface IssueClaims {
  /** The opaque derived owner (`u_…`; format-asserted). */
  owner: string;
  /** The space the bearer is scoped to (becomes `aud`). */
  space: string;
  /** The ledger-authorized agent-instance id (becomes `act.actor`; grammar-asserted). */
  actor: string;
  /** Capability scope. */
  scope?: string[];
  /** At most one spawner audit link, `<owner>.<actor>` dot-form. */
  parent?: string;
  /** The ledger row's lifecycle UID (SPEC 13.1) — lifecycle-BINDS the bearer: the callout requires
   *  exact equality with the CURRENT row at connect, so a predecessor incarnation's still-unexpired
   *  bearer can never mint the successor's broker authority. Stamped whenever the row carries one. */
  lifecycleUid?: string;
  /** Exchange-authorized elevated view (already ledger-checked upstream; the issuer only stamps —
   *  and re-asserts the closed enum, mint ↔ validate inverse). */
  view?: UserTokenView;
  /** Requested lifetime; capped at {@link MAX_TOKEN_TTL_SEC} (an overlong ask THROWS). */
  ttlSec?: number;
}

/** A running issuer: mints bearers with the active key, publishes the public JWKS, and rotates. */
export interface UserTokenIssuer {
  /** The `iss` every bearer carries (verifiers pin this). */
  readonly issuer: string;
  /** The active signing kid. */
  activeKid(): string;
  /** Mint a bearer for a validated (owner, actor). Returns the compact JWS. */
  issue(claims: IssueClaims): Promise<string>;
  /** The public JWK Set to publish for offline verification (all live kids, public members only). */
  jwks(): { keys: JWK[] };
  /** Add a key and make it the active signer; prior keys stay published until {@link retire}. */
  rotate(key: SigningKey): void;
  /** Drop a retired kid from the set — after that, tokens it signed no longer verify. */
  retire(kid: string): void;
  /** A verifier over the CURRENT key set (reflects rotate/retire live) — for a co-located callout
   *  or tests. Same `JWTVerifyGetKey` shape {@link validateUserToken} accepts. */
  localKeySet(): JWTVerifyGetKey;
}

export interface CreateIssuerOpts {
  /** Exact issuer string minted into `iss` (verifiers pin it). */
  issuer: string;
  /** The initial (active) signing key. */
  key: SigningKey;
}

/** Build a {@link UserTokenIssuer}. */
export function createUserTokenIssuer(opts: CreateIssuerOpts): UserTokenIssuer {
  if (!opts.issuer) throw new Error("issuer: an `iss` string is required");
  const keys = new Map<string, SigningKey>([[opts.key.kid, opts.key]]);
  let active = opts.key.kid;

  const issue = async (claims: IssueClaims): Promise<string> => {
    // Every claim is RUNTIME-shape-checked, not just TS-typed: C2 feeds this from IdP/session JSON,
    // and a mis-shaped claim must fail HERE — signing it would mint a dead bearer the validator
    // rejects, silently breaking the issuer ↔ validator inverse.
    assertDerivedOwnerToken(claims.owner);
    assertValidOwnerToken(claims.actor);
    if (typeof claims.space !== "string" || !claims.space)
      throw new Error("issue: space (aud) must be a non-empty string");
    if (claims.scope !== undefined && !(Array.isArray(claims.scope) && claims.scope.every((s) => typeof s === "string")))
      throw new Error("issue: scope must be a string list when present");
    if (claims.parent !== undefined) {
      if (typeof claims.parent !== "string")
        throw new Error("issue: parent must be a string principal (<owner>.<actor>)");
      const parts = claims.parent.split(".");
      if (parts.length !== 2) throw new Error(`issue: parent "${claims.parent}" is not a principal (<owner>.<actor>)`);
      assertDerivedOwnerToken(parts[0]);
      assertValidOwnerToken(parts[1]);
    }
    if (claims.view !== undefined && !USER_TOKEN_VIEWS.includes(claims.view))
      throw new Error(
        `issue: view "${String(claims.view)}" is not a known view (${USER_TOKEN_VIEWS.join(", ")}) - the enum is closed on the mint side too`,
      );
    const ttl = claims.ttlSec ?? MAX_TOKEN_TTL_SEC;
    if (typeof ttl !== "number" || !Number.isFinite(ttl) || !(ttl > 0) || ttl > MAX_TOKEN_TTL_SEC)
      throw new Error(`issue: ttlSec ${ttl} out of range (0, ${MAX_TOKEN_TTL_SEC}] - the cap is the revocation lever`);
    const signer = keys.get(active);
    if (!signer) throw new Error("issue: no active signing key");
    const now = Math.floor(Date.now() / 1000);
    return new SignJWT({
      scope: claims.scope ?? [],
      ver: USER_TOKEN_VER,
      act: { owner: claims.owner, actor: claims.actor, ...(claims.scope ? { scope: claims.scope } : {}), ...(claims.parent ? { parent: claims.parent } : {}), ...(claims.lifecycleUid ? { lifecycleUid: claims.lifecycleUid } : {}), ...(claims.view ? { view: claims.view } : {}) },
    })
      .setProtectedHeader({ alg: USER_TOKEN_ALG, kid: signer.kid })
      .setSubject(claims.owner)
      .setIssuer(opts.issuer)
      .setAudience(claims.space)
      .setIssuedAt(now)
      .setNotBefore(now)
      .setExpirationTime(now + ttl)
      .sign(signer.privateKey);
  };

  return {
    issuer: opts.issuer,
    activeKid: () => active,
    issue,
    jwks: () => ({ keys: [...keys.values()].map((k) => k.publicJwk) }),
    rotate: (key: SigningKey) => { keys.set(key.kid, key); active = key.kid; },
    retire: (kid: string) => {
      if (kid === active) throw new Error(`issuer: refusing to retire the active kid ${kid} - rotate to a new key first`);
      keys.delete(kid);
    },
    localKeySet: (): JWTVerifyGetKey => async (header) => {
      const jwk = header.kid ? keys.get(header.kid)?.publicJwk : undefined;
      if (!jwk) throw new Error(`no published signing key for kid ${String(header.kid)}`);
      return (await importJWK(jwk, USER_TOKEN_ALG)) as CryptoKey;
    },
  };
}

/** Build the callout's pinned key resolver: a `createRemoteJWKSet` locked to ONE origin. The token
 *  never influences where the key comes from — jose fetches only this URL and ignores any embedded
 *  `jku`/`jwk` (and {@link validateUserToken} rejects those headers outright). HTTPS is required
 *  except for loopback (dev). */
export function pinnedJwksResolver(jwksUri: string): JWTVerifyGetKey {
  const url = new URL(jwksUri);
  const loopback = url.hostname === "127.0.0.1" || url.hostname === "localhost" || url.hostname === "[::1]";
  if (url.protocol !== "https:" && !loopback)
    throw new Error(`JWKS origin must be https (or loopback for dev), got ${url.protocol}//${url.hostname}`);
  return createRemoteJWKSet(url);
}
