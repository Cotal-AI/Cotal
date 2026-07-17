/**
 * Read-only user-auth backup seams. These functions only load and validate existing provider
 * state: no ensure/load-or-create helper is used anywhere in this file.
 */
import { createHash, timingSafeEqual } from "node:crypto";
import { decode, type Account } from "@nats-io/jwt";
import { fromCurveSeed, fromSeed } from "@nats-io/nkeys";
import type { AuthTrustFingerprint, RetainedAgentAuthority, SecretStore } from "@cotal-ai/core";
import { ledgerAuthorizeAgentExchange, loadActorLedger } from "./ledger.js";
import {
  loadCalloutAuth,
  loadIssuer,
  loadOwnerSecret,
  loadPinnedIdp,
  loadServiceKeys,
  spaceIssuer,
} from "./store.js";

export const USER_AUTH_TRUST_SCHEME = "cotal-user-auth-trust/v1:sha256";

const sha256 = (value: string | Uint8Array): string => createHash("sha256").update(value).digest("hex");
const sortedUnique = (values: string[]): string[] => [...new Set(values)].sort();
const compareCodeUnits = (a: string, b: string): number => a < b ? -1 : a > b ? 1 : 0;
const commitment = (domain: string, value: string | Uint8Array): string =>
  sha256(Buffer.concat([Buffer.from(`${domain}\0`), Buffer.from(value)]));

function requireState<T>(value: T | undefined, where: string, what: string): T {
  if (value === undefined)
    throw new Error(`user-auth trust state ${where} is missing ${what} - restore the existing state; continuity reads never generate replacements`);
  return value;
}

/**
 * Canonical non-secret commitment to every user-auth input that determines principal identity or
 * standing authority. Secrets are represented only by public keys or domain-separated hashes;
 * timestamps and labels are excluded because they grant no authority. Set-like lists and ledger
 * rows are sorted so filesystem order and harmless list ordering cannot perturb the result. This
 * is the provider-local component: the CLI must compose its generic broker root-chain input
 * separately rather than this package rediscovering workspace auth files outside `dir`.
 * SECRET kinds read through the caller-composed `store`; the IdP pin and ledger stay under `dir`.
 */
export async function userAuthTrustFingerprint(store: SecretStore, dir: string, space: string): Promise<AuthTrustFingerprint> {
  if (!space) throw new Error("user-auth trust fingerprint needs a space");
  const inStore = `for space "${space}"`;
  const keys = requireState(await loadServiceKeys(store, space), inStore, "the data-account identity");
  const callout = requireState(await loadCalloutAuth(store, space), inStore, "the callout account");
  const ownerSecret = requireState(await loadOwnerSecret(store, space), inStore, "the owner-derivation secret");
  const idp = requireState(loadPinnedIdp(dir), `under ${dir}`, "the IdP pin");
  const issuer = requireState(await loadIssuer(store, space), inStore, "the bearer issuer");
  if (issuer.issuer !== spaceIssuer(space))
    throw new Error(`user-auth trust state ${inStore} belongs to issuer "${issuer.issuer}", not space "${space}"`);

  const publicFromSeed = (seed: string): string => {
    const pair = fromSeed(new TextEncoder().encode(seed));
    try {
      return pair.getPublicKey();
    } finally {
      pair.clear();
    }
  };
  const dataSigningPub = publicFromSeed(keys.dataAccount.signingSeed);
  const calloutAccountPub = publicFromSeed(callout.account.seed);
  const calloutSigningPub = publicFromSeed(callout.account.signingSeed);
  const curvePair = fromCurveSeed(new TextEncoder().encode(callout.xkey.seed));
  let calloutXkeyPub: string;
  try {
    calloutXkeyPub = curvePair.getPublicKey();
  } finally {
    curvePair.clear();
  }
  if (calloutAccountPub !== callout.account.pub || calloutSigningPub !== callout.account.signingPub || calloutXkeyPub !== callout.xkey.pub)
    throw new Error(`user-auth trust state ${inStore} has a callout seed/public-key mismatch`);

  const accountClaims = decode<Account>(callout.account.jwt);
  const external = accountClaims.nats.authorization;
  const signingKeys = accountClaims.nats.signing_keys ?? [];
  if (accountClaims.sub !== callout.account.pub || signingKeys.length !== 1 || signingKeys[0] !== callout.account.signingPub ||
      external?.allowed_accounts?.length !== 1 || external.allowed_accounts[0] !== keys.dataAccount.pub ||
      external.auth_users?.length !== 1 || external.xkey !== callout.xkey.pub)
    throw new Error(`user-auth trust state ${inStore} has a callout account JWT that does not match its account, signer, xkey, or data-account binding`);
  const ledger = loadActorLedger(dir)
    .map((row) => ({
      kind: row.kind,
      owner: row.owner,
      actor: row.actor,
      scope: sortedUnique(row.scope),
      allowSubscribe: sortedUnique(row.allowSubscribe),
      allowPublish: sortedUnique(row.allowPublish),
      role: row.role ?? null,
      parent: row.parent ?? null,
      tokenHash: row.kind === "managed-agent" ? row.tokenHash! : null,
    }))
    .sort((a, b) => compareCodeUnits(`${a.kind}\0${a.owner}\0${a.actor}`, `${b.kind}\0${b.owner}\0${b.actor}`));
  const issuerKeys = issuer.jwks().keys
    .map((key) => ({
      kty: key.kty ?? null,
      crv: key.crv ?? null,
      x: key.x ?? null,
      kid: key.kid ?? null,
      alg: key.alg ?? null,
      use: key.use ?? null,
    }))
    .sort((a, b) => compareCodeUnits(String(a.kid), String(b.kid)));
  const canonical = {
    space,
    account: {
      dataPub: keys.dataAccount.pub,
      dataSigningPub,
      calloutPub: calloutAccountPub,
      calloutSigningPub,
      calloutXkeyPub,
      calloutAccountJwt: commitment("cotal-callout-account-jwt/v1", callout.account.jwt),
      calloutAccountSeed: commitment("cotal-callout-account-seed/v1", callout.account.seed),
      calloutSigningSeed: commitment("cotal-callout-signing-seed/v1", callout.account.signingSeed),
      calloutXkeySeed: commitment("cotal-callout-xkey-seed/v1", callout.xkey.seed),
      calloutCreds: commitment("cotal-callout-service-creds/v1", callout.calloutCreds),
      sentinelCreds: commitment("cotal-callout-sentinel-creds/v1", callout.sentinelCreds),
    },
    ownerSecret: commitment("cotal-owner-secret/v1", ownerSecret),
    idp: { url: idp.url, issuer: idp.issuer, audience: idp.audience, jwksUri: idp.jwksUri },
    issuer: { issuer: issuer.issuer, activeKid: issuer.activeKid(), keys: issuerKeys },
    ledger,
  };
  return {
    scheme: USER_AUTH_TRUST_SCHEME,
    value: sha256(`${USER_AUTH_TRUST_SCHEME}\0${JSON.stringify(canonical)}`),
  };
}

function sameSecret(a: string, b: string): boolean {
  const ah = Buffer.from(sha256(a), "hex");
  const bh = Buffer.from(sha256(b), "hex");
  return timingSafeEqual(ah, bh);
}

/** Validate retained managed-agent material without writing or minting anything. */
export async function validateRetainedManagedAgent(input: {
  store: SecretStore;
  dir: string;
  space: string;
  owner: string;
  actor: string;
  actorToken: string;
  sentinelCreds: string;
}): Promise<RetainedAgentAuthority> {
  const issuer = requireState(await loadIssuer(input.store, input.space), `for space "${input.space}"`, "the bearer issuer");
  if (issuer.issuer !== spaceIssuer(input.space))
    throw new Error(`retained user-auth state belongs to issuer "${issuer.issuer}", not space "${input.space}"`);
  const callout = requireState(await loadCalloutAuth(input.store, input.space), `for space "${input.space}"`, "the callout account");
  if (!sameSecret(input.sentinelCreds, callout.sentinelCreds))
    throw new Error(`retained sentinel credential for ${input.owner}.${input.actor} does not match space "${input.space}"`);

  // This checks the token hash in constant time and re-walks the current delegation envelope.
  const row = ledgerAuthorizeAgentExchange(input.dir, input.owner, input.actor, input.actorToken);
  return {
    owner: row.owner,
    actor: row.actor,
    scope: [...row.scope],
    allowSubscribe: [...row.allowSubscribe],
    allowPublish: [...row.allowPublish],
    ...(row.role ? { role: row.role } : {}),
    ...(row.parent ? { parent: row.parent } : {}),
  };
}
