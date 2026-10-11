import { fromPublic } from "@nats-io/nkeys";
import { canonicalJson, isContractDigest, isWellFormedUnicode } from "./canonical.js";
import { endpointToken } from "./endpoint-subjects.js";
import { environmentBootstrapActor, environmentManagerPermissions } from "./environment-manager-grants.js";
import { accountFromCreds, credsClaims, credsFromJwt, identityFromCreds, isAccountNkey, isUserNkey, jwtFromCreds } from "./identity.js";
import { assertDerivedOwnerToken, assertLifecycleToken, parsePrincipalKey, principalFromTags, principalTags } from "./subjects.js";

export interface EnvironmentBootstrapCommandDigests {
  clusterDigest: string;
  inputDigest: string;
  outputDigest: string;
}

/** Private post-boot carrier. The connection seed is inside creds, never in public host records. */
export interface EnvironmentManagerBootstrapDocument {
  v: 1;
  environmentId: string;
  space: string;
  instanceId: string;
  lifecycleUid: string;
  accountPublicKey: string;
  brokerUrl: string;
  authorityEndpoint: string;
  authorityInstanceId: string;
  /** Credential expiry in epoch seconds. */
  expiresAt: number;
  contracts: {
    bootstrap: EnvironmentBootstrapCommandDigests;
    "bootstrap-status": EnvironmentBootstrapCommandDigests;
  };
  creds: string;
}

const INVALID = "environment manager bootstrap document is invalid";
const MAX_DOCUMENT_BYTES = 64 * 1024;
function fail(): never { throw new Error(INVALID); }
const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
const closed = (value: unknown, fields: string[]): value is Record<string, unknown> => record(value) &&
  Object.keys(value).length === fields.length && Object.keys(value).every(key => fields.includes(key));

function grantMatches(raw: unknown, expected: unknown): boolean {
  if (!record(expected) || !Array.isArray(expected.allow) || !record(raw) ||
      Object.keys(raw).some(key => key !== "allow" && key !== "deny") || !Array.isArray(raw.allow) ||
      raw.allow.some(value => typeof value !== "string") || new Set(raw.allow).size !== raw.allow.length ||
      (raw.deny !== undefined && (!Array.isArray(raw.deny) || raw.deny.length !== 0))) return false;
  return JSON.stringify([...raw.allow].sort()) === JSON.stringify([...expected.allow].sort());
}

/** Decode bounded canonical version-one bytes after private file custody. No connection or fresh
 *  key is created. Credential claims, profile ceilings and coordinate checks are unverified local
 *  consistency only: the broker verifies the JWT and the host authenticates admission and currency.
 *  System/private-CA trust, live contract verification and coupled recovery persistence remain
 *  caller duties. Refusals disclose no carried bytes, paths, credentials or private seeds. */
export function parseEnvironmentManagerBootstrapDocument(text: string): EnvironmentManagerBootstrapDocument {
  if (typeof text !== "string" || Buffer.byteLength(text, "utf8") > MAX_DOCUMENT_BYTES) fail();
  let raw: unknown;
  try { raw = JSON.parse(text); } catch { fail(); }
  if (!record(raw)) fail();
  if (raw.v !== 1) throw new Error("environment manager bootstrap document version must be one");
  try {
    const fields = ["v", "environmentId", "space", "instanceId", "lifecycleUid", "accountPublicKey", "brokerUrl",
      "authorityEndpoint", "authorityInstanceId", "expiresAt", "contracts", "creds"];
    if (!closed(raw, fields) || typeof raw.environmentId !== "string" || !/^[a-f0-9]{64}$/.test(raw.environmentId) ||
        typeof raw.space !== "string" || !raw.space || raw.space.length > 256 || !isWellFormedUnicode(raw.space) || /\p{Cc}/u.test(raw.space) ||
        raw.space === "." || raw.space === ".." || typeof raw.instanceId !== "string" || typeof raw.lifecycleUid !== "string" ||
        typeof raw.authorityEndpoint !== "string" || typeof raw.authorityInstanceId !== "string" ||
        typeof raw.brokerUrl !== "string" || typeof raw.creds !== "string" || !isAccountNkey(raw.accountPublicKey)) fail();
    assertLifecycleToken(raw.instanceId);
    assertLifecycleToken(raw.lifecycleUid);
    assertLifecycleToken(raw.authorityInstanceId);
    endpointToken(raw.authorityEndpoint);
    fromPublic(raw.accountPublicKey);
    const now = Math.floor(Date.now() / 1000);
    if (!Number.isSafeInteger(raw.expiresAt) || Number(raw.expiresAt) <= now || Number(raw.expiresAt) > now + 300) fail();
    const broker = new URL(raw.brokerUrl);
    if (broker.protocol !== "wss:" || !broker.hostname || broker.username || broker.password || broker.search || broker.hash || broker.href !== raw.brokerUrl) fail();
    if (!closed(raw.contracts, ["bootstrap", "bootstrap-status"])) fail();
    for (const command of ["bootstrap", "bootstrap-status"]) {
      const digests = raw.contracts[command];
      if (!closed(digests, ["clusterDigest", "inputDigest", "outputDigest"]) ||
          Object.values(digests).some(value => typeof value !== "string" || !isContractDigest(value))) fail();
    }
    // One byte representation rejects duplicate member names and projections before any credential
    // inspection. The host writes canonicalJson; whitespace and reordered members are not carriers.
    if (canonicalJson(raw) !== text) fail();
    const jwt = jwtFromCreds(raw.creds);
    if (!jwt || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(jwt)) fail();
    const identity = identityFromCreds(raw.creds);
    if (!isUserNkey(identity.id) || !identity.seed.startsWith("SU") || credsFromJwt(jwt, identity) !== raw.creds) fail();
    const claims = credsClaims(raw.creds);
    if (claims.name !== "environment-bootstrap" || claims.sub !== identity.id || claims.exp !== raw.expiresAt ||
        !Number.isSafeInteger(claims.iat) || Number(claims.iat) > now || Number(claims.iat) > Number(claims.exp) ||
        Number(claims.exp) - Number(claims.iat) > 300) fail();
    if (accountFromCreds(raw.creds) !== raw.accountPublicKey || !record(claims.nats)) fail();
    const nats = claims.nats as Record<string, unknown>;
    if (nats.type !== "user" || nats.version !== 2 || nats.resp !== undefined ||
        (nats.bearer_token !== undefined && nats.bearer_token !== false) ||
        !Array.isArray(nats.tags) || nats.tags.some(value => typeof value !== "string")) fail();
    const principal = parsePrincipalKey(principalFromTags(nats.tags as string[]) ?? "");
    if (!principal) fail();
    assertDerivedOwnerToken(principal.owner);
    const actor = environmentBootstrapActor(raw.instanceId);
    if (principal.actor !== actor || JSON.stringify([...nats.tags].sort()) !== JSON.stringify(principalTags(principal.owner, actor).sort())) fail();
    const expected = environmentManagerPermissions("environment-bootstrap", raw.space,
      { owner: principal.owner, actor, connId: identity.id, lifecycleUid: raw.lifecycleUid },
      { owner: principal.owner, instanceId: raw.instanceId, lifecycleUid: raw.lifecycleUid,
        authorityEndpoint: raw.authorityEndpoint, authorityInstanceId: raw.authorityInstanceId, expiresAt: Number(raw.expiresAt) });
    if (!grantMatches(nats.pub, expected.pub) || !grantMatches(nats.sub, expected.sub)) fail();
    return raw as unknown as EnvironmentManagerBootstrapDocument;
  } catch { fail(); }
}
