/**
 * On-disk persistence for a space's USER-AUTH material, under the same `.cotal/auth/` dir as the
 * space trust material (explicit-dir APIs, the auth-paths posture: the caller picks the dir, nothing
 * here discovers paths ambiently). Everything is generate-on-first-use and STABLE thereafter — the
 * callout account identity, the issuer signing keys, and the owner-derivation secret must survive
 * restarts, or previously-minted credentials/owners silently break:
 *
 *  - `callout.json` — the dedicated auth-callout account ({@link CalloutAuth}: account + signing key,
 *    callout service creds, deny-all sentinel creds, xkey). Regenerating it would orphan the account
 *    the broker config preloads; minting it the first time needs the FULL SpaceAuth (operator seed).
 *  - `issuer.json` — the Cotal user-bearer issuer: its pinned `iss` string plus the serialized
 *    Ed25519 signing keys (private JWKs) and the active kid. Losing these kills every outstanding
 *    bearer (rotation is `rotate`/`retire` on the loaded issuer, then {@link saveIssuerFile}).
 *  - `owner-secret.json` — the per-space owner-derivation secret (32 random bytes). REGENERATING IT
 *    RE-KEYS EVERY OWNER in the space (same human → different `u_…`), which is a migration, never an
 *    accident — hence load-or-create with no overwrite path.
 *
 * All files 0600 under a 0700 dir (core's secret-fs helpers), atomic writes, versioned JSON with
 * fail-loud parsing (the login session-cache posture: a torn/hand-edited credential file surfaces as
 * one legible sentence, never a raw SyntaxError downstream).
 */
import { existsSync, readFileSync, rmSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { mkSecretDir, writeSecretFileAtomic } from "@cotal-ai/core";
import { createCalloutAuth, type CalloutAuth, type CalloutProvisionInput } from "./callout.js";
import { normalizeIdpUrl } from "./login.js";
import {
  createUserTokenIssuer,
  exportSigningKey,
  generateSigningKey,
  importSigningKey,
  type SerializedSigningKey,
  type UserTokenIssuer,
} from "./issuer.js";

const CALLOUT_FILE = "callout.json";
const ISSUER_FILE = "issuer.json";
const OWNER_SECRET_FILE = "owner-secret.json";
const STORE_VER = 1;

/** The pinned `iss` for a space's Cotal user bearers — a stable URN, deliberately NOT the auth
 *  service's URL (the service port is ephemeral; an issuer pin must never change across restarts).
 *  Both the issuer (mint) and the callout (validate) take it from here — one source, no drift. */
export function spaceIssuer(space: string): string {
  if (!space) throw new Error("spaceIssuer: a space is required");
  return `urn:cotal:auth:${space}`;
}

/** Fail-loud versioned-JSON read: a missing file is undefined; a torn/edited/unknown-version file is
 *  a legible sentence naming the file and the recovery, never a raw parse error downstream. */
function readStoreFile<T extends { ver: number }>(path: string, what: string): T | undefined {
  if (!existsSync(path)) return undefined;
  let parsed: T;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8")) as T;
  } catch (e) {
    throw new Error(`${path}: the ${what} file is not valid JSON (${e instanceof Error ? e.message : String(e)}) — restore it from backup; regenerating breaks existing credentials`);
  }
  if (parsed === null || typeof parsed !== "object" || parsed.ver !== STORE_VER)
    throw new Error(`${path}: unknown ${what} version ${String((parsed as { ver?: unknown })?.ver)} (expected ${STORE_VER}) — refusing to guess at credential material`);
  return parsed;
}

// ---- the dedicated auth-callout account ----

interface CalloutFile {
  ver: number;
  callout: CalloutAuth;
}

/** Load the persisted callout account material, or undefined if this space never enabled user auth. */
export function loadCalloutAuth(dir: string): CalloutAuth | undefined {
  const f = readStoreFile<CalloutFile>(join(dir, CALLOUT_FILE), "callout account");
  if (!f) return undefined;
  const c = f.callout;
  if (!c?.account?.pub || !c.account.jwt || !c.calloutCreds || !c.sentinelCreds || !c.xkey?.seed)
    throw new Error(`${join(dir, CALLOUT_FILE)}: malformed callout account material — restore it from backup; regenerating orphans the preloaded auth account`);
  return c;
}

/** Load-or-create the callout account: first call on a space mints it (operator seed required)
 *  and persists; every later call returns the SAME account, so the broker config preload and
 *  previously-issued sentinel creds stay valid. Idempotent. */
export async function ensureCalloutAuth(dir: string, input: CalloutProvisionInput): Promise<CalloutAuth> {
  const existing = loadCalloutAuth(dir);
  if (existing) return existing;
  const callout = await createCalloutAuth(input);
  mkSecretDir(dir); // harden BEFORE the secret lands
  writeSecretFileAtomic(join(dir, CALLOUT_FILE), JSON.stringify({ ver: STORE_VER, callout } satisfies CalloutFile, null, 2));
  return callout;
}

// ---- the user-bearer issuer signing keys ----

interface IssuerFile {
  ver: number;
  issuer: string;
  activeKid: string;
  keys: SerializedSigningKey[];
}

/** Load the persisted issuer (all published kids live; the persisted active kid signs), or undefined
 *  if this space never enabled user auth. */
export async function loadIssuer(dir: string): Promise<UserTokenIssuer | undefined> {
  const f = readStoreFile<IssuerFile>(join(dir, ISSUER_FILE), "issuer key");
  if (!f) return undefined;
  if (!f.issuer || !Array.isArray(f.keys) || !f.keys.length || !f.activeKid)
    throw new Error(`${join(dir, ISSUER_FILE)}: malformed issuer key file — restore it from backup; regenerating kills every outstanding bearer`);
  const active = f.keys.find((k) => k.kid === f.activeKid);
  if (!active)
    throw new Error(`${join(dir, ISSUER_FILE)}: active kid ${f.activeKid} is not in the key set — restore it from backup`);
  // createUserTokenIssuer starts with one active key; rotate() adds the rest (each rotate re-points
  // active, so feed the non-active keys THROUGH rotate and finish on the persisted active kid).
  const issuer = createUserTokenIssuer({ issuer: f.issuer, key: await importSigningKey(active) });
  for (const k of f.keys) if (k.kid !== f.activeKid) issuer.rotate(await importSigningKey(k));
  if (issuer.activeKid() !== f.activeKid) issuer.rotate(await importSigningKey(active));
  return issuer;
}

/** Load-or-create the space's user-bearer issuer: first call generates the Ed25519 signing key and
 *  persists it under the pinned {@link spaceIssuer} `iss`; later calls return the SAME keys, so
 *  outstanding bearers keep verifying. A persisted `iss` that disagrees with the space's pin fails
 *  loud (the material belongs to another space/layout — never sign under a mismatched issuer). */
export async function ensureIssuer(dir: string, space: string): Promise<UserTokenIssuer> {
  const iss = spaceIssuer(space);
  const existing = await loadIssuer(dir);
  if (existing) {
    if (existing.issuer !== iss)
      throw new Error(`${join(dir, ISSUER_FILE)}: persisted issuer "${existing.issuer}" != this space's pin "${iss}" — the material belongs to a different space; refusing to mint under it`);
    return existing;
  }
  const key = await generateSigningKey();
  mkSecretDir(dir);
  writeSecretFileAtomic(
    join(dir, ISSUER_FILE),
    JSON.stringify({ ver: STORE_VER, issuer: iss, activeKid: key.kid, keys: [await exportSigningKey(key)] } satisfies IssuerFile, null, 2),
  );
  return createUserTokenIssuer({ issuer: iss, key });
}

// ---- the owner-derivation secret ----

interface OwnerSecretFile {
  ver: number;
  /** 32 random bytes, base64 — the per-space HMAC key behind every derived `u_…` owner. */
  secretB64: string;
}

/** Load the owner-derivation secret, or undefined if this space never enabled user auth. */
export function loadOwnerSecret(dir: string): Uint8Array | undefined {
  const f = readStoreFile<OwnerSecretFile>(join(dir, OWNER_SECRET_FILE), "owner secret");
  if (!f) return undefined;
  const secret = Buffer.from(f.secretB64 ?? "", "base64");
  if (secret.byteLength !== 32)
    throw new Error(`${join(dir, OWNER_SECRET_FILE)}: malformed owner secret — restore it from backup; a regenerated secret RE-KEYS EVERY OWNER in the space`);
  return new Uint8Array(secret);
}

/** Load-or-create the per-space owner-derivation secret. There is deliberately NO regenerate path:
 *  a new secret re-keys every owner in the space (a migration, never an accident). */
export function ensureOwnerSecret(dir: string): Uint8Array {
  const existing = loadOwnerSecret(dir);
  if (existing) return existing;
  const secret = randomBytes(32);
  mkSecretDir(dir);
  writeSecretFileAtomic(
    join(dir, OWNER_SECRET_FILE),
    JSON.stringify({ ver: STORE_VER, secretB64: Buffer.from(secret).toString("base64") } satisfies OwnerSecretFile, null, 2),
  );
  return new Uint8Array(secret);
}

// ---- the pinned external IdP ----

const IDP_FILE = "idp.json";

/** The persisted pin of THE external IdP this space trusts (plan gate 4: "pin IdP JWKS/issuer/
 *  audience"). All four strings are frozen at `up --user-auth --idp <url>` time; nothing here is
 *  ever read from a presented token. Better Auth conventions seed the derivation (issuer/audience =
 *  the base URL's origin, JWKS under `<base>/jwks`) — a strict-OIDC IdP with different values plugs
 *  in by editing the pin file deliberately, not by the client guessing. */
export interface PinnedIdp {
  /** The auth base URL as given (normalized; the `cotal login --idp` target). */
  url: string;
  /** Exact `iss` the IdP mints. */
  issuer: string;
  /** Exact `aud` the IdP mints. */
  audience: string;
  /** The pinned JWKS URL keys resolve from — the ONLY key path. */
  jwksUri: string;
}

interface IdpFile extends PinnedIdp {
  ver: number;
}

/** Load the pinned IdP, or undefined if this space never pinned one. */
export function loadPinnedIdp(dir: string): PinnedIdp | undefined {
  const f = readStoreFile<IdpFile>(join(dir, IDP_FILE), "IdP pin");
  if (!f) return undefined;
  if (!f.url || !f.issuer || !f.audience || !f.jwksUri)
    throw new Error(`${join(dir, IDP_FILE)}: malformed IdP pin — re-pin with \`cotal up --user-auth --idp <url>\``);
  return { url: f.url, issuer: f.issuer, audience: f.audience, jwksUri: f.jwksUri };
}

/** Pin-or-verify the space's IdP. First call REQUIRES a URL (there is no default IdP); later calls
 *  either omit it (reuse the pin) or must MATCH it — re-pointing a space at a different IdP re-keys
 *  every derived owner (the issuer is part of the derivation input), a migration this refuses to do
 *  as a flag side-effect. */
export function ensurePinnedIdp(dir: string, idpUrl?: string): PinnedIdp {
  const existing = loadPinnedIdp(dir);
  if (existing) {
    if (idpUrl !== undefined && idpUrl !== existing.url)
      throw new Error(
        `this space's IdP is pinned to ${existing.url}; --idp ${idpUrl} would re-key every derived owner. ` +
          `Re-pointing an IdP is a migration — remove ${join(dir, IDP_FILE)} deliberately if you mean it.`,
      );
    return existing;
  }
  if (!idpUrl)
    throw new Error("user auth needs an IdP on first enable — run with --idp <auth base URL> (Better Auth: <origin>/api/auth)");
  // Same normalization + scheme guard as `cotal login` (https, or loopback http for dev; no
  // query/hash/userinfo) — the pin and the login cache must key on the SAME canonical URL.
  const url = normalizeIdpUrl(idpUrl);
  const origin = new URL(url).origin;
  const pin: PinnedIdp = { url, issuer: origin, audience: origin, jwksUri: `${url}/jwks` };
  mkSecretDir(dir);
  writeSecretFileAtomic(join(dir, IDP_FILE), JSON.stringify({ ver: STORE_VER, ...pin } satisfies IdpFile, null, 2));
  return pin;
}

// ---- the auth service's own key projection ----

const SERVICE_KEYS_FILE = "service-keys.json";

/** EXACTLY what the long-lived auth service may hold of the space's signing material: the data
 *  account's pub + user-minting signing seed (minting scoped users at connect time IS the service's
 *  function) — and nothing else. Written by `prepareServer` (which may briefly see more), loaded by
 *  the daemon INSTEAD of the space's full trust bundle: the operator seed and the account seed never
 *  enter the service process. */
export interface ServiceKeys {
  dataAccount: { pub: string; signingSeed: string };
}

interface ServiceKeysFile extends ServiceKeys {
  ver: number;
}

export function loadServiceKeys(dir: string): ServiceKeys | undefined {
  const f = readStoreFile<ServiceKeysFile>(join(dir, SERVICE_KEYS_FILE), "service key projection");
  if (!f) return undefined;
  if (!f.dataAccount?.pub || !f.dataAccount.signingSeed)
    throw new Error(`${join(dir, SERVICE_KEYS_FILE)}: malformed service key projection — re-run \`cotal up --user-auth\` to rewrite it`);
  return { dataAccount: { pub: f.dataAccount.pub, signingSeed: f.dataAccount.signingSeed } };
}

/** Write (or refresh) the service's key projection. Idempotent overwrite — the projection carries
 *  no identity of its own, it IS the (stable) data-account signing material, so rewriting from the
 *  same space bundle is a no-op in content. */
export function saveServiceKeys(dir: string, keys: ServiceKeys): void {
  mkSecretDir(dir);
  writeSecretFileAtomic(join(dir, SERVICE_KEYS_FILE), JSON.stringify({ ver: STORE_VER, ...keys } satisfies ServiceKeysFile, null, 2));
}

// ---- the auth-service runtime discovery file ----

const SERVICE_FILE = "auth-service.json";

/** Where the RUNNING auth service listens — written by the daemon only after EVERY plane is bound
 *  (its existence is the readiness signal), read by user-mode connects from other directories on
 *  this machine. Runtime state, not a trust pin: the port and capability rotate per start.
 *  `cap` is the per-start exchange capability: /exchange requires `Authorization: Bearer <cap>`,
 *  so a local process can only exchange if it can read this 0600 file — same-user file ACL is the
 *  boundary, and browser/off-user processes are shut out of the loopback port. */
export interface AuthServiceInfo {
  /** The local exchange/JWKS base URL, e.g. `http://127.0.0.1:53200`. */
  url: string;
  pid: number;
  /** High-entropy per-start exchange capability (hex). NEVER copied into the mesh registry. */
  cap: string;
}

interface ServiceFile extends AuthServiceInfo {
  ver: number;
}

export function loadAuthServiceInfo(dir: string): AuthServiceInfo | undefined {
  const f = readStoreFile<ServiceFile>(join(dir, SERVICE_FILE), "auth service info");
  if (!f) return undefined;
  if (!f.url || typeof f.pid !== "number" || !f.cap)
    throw new Error(`${join(dir, SERVICE_FILE)}: malformed auth service info — restart the mesh (\`cotal down\` then \`cotal up\`)`);
  return { url: f.url, pid: f.pid, cap: f.cap };
}

export function saveAuthServiceInfo(dir: string, info: AuthServiceInfo): void {
  mkSecretDir(dir);
  writeSecretFileAtomic(join(dir, SERVICE_FILE), JSON.stringify({ ver: STORE_VER, ...info } satisfies ServiceFile, null, 2));
}

/** Remove the discovery file (daemon shutdown / CLI pre-start scrub) so a stale entry can never
 *  satisfy a readiness poll for the NEXT start. */
export function clearAuthServiceInfo(dir: string): void {
  rmSync(join(dir, SERVICE_FILE), { force: true });
}
