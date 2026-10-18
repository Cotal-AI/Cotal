/**
 * The host's tool-result consent anchors (SPEC 13.6/13.10): the PUBLIC verification keys a
 * launcher registers for the `consents` role, scoped to `tool-results`, and the fresh resolver a
 * serving session verifies every consent through.
 *
 * WHAT AN OPERATOR CONFIGURES. One JSON file: an array of records
 * `{ keyId, publicKey, owner, validFrom, validTo, revoked? }`. `publicKey` is the nkeys user public
 * key (`U…`) of the host's consent signer; the private key stays with the signing host and never
 * appears here. The role and scope are NOT configurable: every record is registered as exactly
 * `roles: ["consents"]`, `scope: { consents: ["tool-results"] }`, so this file can never turn a key
 * into a session, handle or receipt signer, and an anchor of any other role is not reachable
 * through it. A malformed, partial, duplicate or empty file refuses; an absent file is the
 * default: no anchors, every consent refused.
 *
 * CURRENCY. The resolver re-reads the file on EVERY resolution, so an edit is effective at the
 * next verification: rotation adds a successor record and closes the predecessor's window
 * (`validTo`), withdrawal sets `revoked: true` or removes the record. A file that cannot be read or
 * parsed resolves nothing (fail closed). {@link consentSignerStillCurrent} is the same check for a
 * consent already applied, which a serving session repeats on a bounded period.
 */
import { readFileSync } from "node:fs";
import { isAbsolute } from "node:path";
import { fromPublic } from "@nats-io/nkeys";
import { assertAnchorScopeCovers, resolveAnchorForUse, type AnchorResolver, type SignerAnchor } from "./endpoint-signing.js";
import { TOOL_RESULT_CONSENT_SCOPE } from "./tool-result-consent.js";

/** At most this many records: a registry, not a key dump. */
export const TOOL_RESULT_CONSENT_ANCHOR_MAX = 16;

/** One configured public anchor record, exactly as the operator's file states it. */
export interface ToolResultConsentAnchorRecord {
  keyId: string;
  publicKey: string;
  owner: string;
  validFrom: number;
  validTo: number;
  revoked?: boolean;
}

const KEY_ID = /^[A-Za-z0-9_.-]{1,64}$/;
const OWNER = /^[A-Za-z0-9_.:-]{1,253}$/;
const FIELDS = ["keyId", "publicKey", "owner", "validFrom", "validTo", "revoked"];

/** Parse an operator's anchor records into registered `consents` anchors. Throws, naming the
 *  record, on anything but a well-formed non-empty list. */
export function parseToolResultConsentAnchors(raw: unknown, what = "tool-result consent anchors"): readonly SignerAnchor[] {
  if (!Array.isArray(raw) || raw.length === 0) throw new Error(`${what}: expected a non-empty array of anchor records`);
  if (raw.length > TOOL_RESULT_CONSENT_ANCHOR_MAX) throw new Error(`${what}: at most ${TOOL_RESULT_CONSENT_ANCHOR_MAX} records`);
  const keyIds = new Set<string>();
  const keys = new Set<string>();
  return Object.freeze(raw.map((r, i) => {
    const at = `${what}[${i}]`;
    if (r === null || typeof r !== "object" || Array.isArray(r)) throw new Error(`${at}: not an object`);
    const o = r as Record<string, unknown>;
    for (const k of Object.keys(o)) if (!FIELDS.includes(k)) throw new Error(`${at}: unknown field "${k}" (role and scope are fixed, not configurable)`);
    if (typeof o.keyId !== "string" || !KEY_ID.test(o.keyId)) throw new Error(`${at}: keyId is not a bounded key id`);
    if (typeof o.owner !== "string" || !OWNER.test(o.owner)) throw new Error(`${at}: owner is not a bounded principal or domain`);
    if (typeof o.publicKey !== "string" || !o.publicKey.startsWith("U")) throw new Error(`${at}: publicKey is not an nkeys user public key`);
    try {
      fromPublic(o.publicKey);
    } catch {
      throw new Error(`${at}: publicKey does not parse as an nkeys public key`);
    }
    if (typeof o.validFrom !== "number" || !Number.isSafeInteger(o.validFrom) || typeof o.validTo !== "number" || !Number.isSafeInteger(o.validTo) || o.validFrom >= o.validTo)
      throw new Error(`${at}: validFrom/validTo are not an increasing ms-epoch window`);
    if (o.revoked !== undefined && typeof o.revoked !== "boolean") throw new Error(`${at}: revoked is not a boolean`);
    if (keyIds.has(o.keyId)) throw new Error(`${at}: keyId "${o.keyId}" is registered twice`);
    if (keys.has(o.publicKey)) throw new Error(`${at}: the same public key is registered under two key ids`);
    keyIds.add(o.keyId);
    keys.add(o.publicKey);
    return Object.freeze({
      keyId: o.keyId,
      publicKey: o.publicKey,
      owner: o.owner,
      roles: Object.freeze(["consents"] as const),
      scope: Object.freeze({ consents: Object.freeze([TOOL_RESULT_CONSENT_SCOPE]) }),
      validFrom: o.validFrom,
      validTo: o.validTo,
      ...(o.revoked === true ? { revoked: true } : {}),
    }) as SignerAnchor;
  }));
}

/** Read and parse the operator's anchor file. Throws on an unreadable, non-JSON or invalid file. */
export function readToolResultConsentAnchorFile(path: string): readonly SignerAnchor[] {
  if (!isAbsolute(path)) throw new Error(`tool-result consent anchors: ${path} is not an absolute path`);
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch (e) {
    throw new Error(`tool-result consent anchors: cannot read ${path} (${(e as Error).message})`);
  }
  return parseToolResultConsentAnchors(raw, `tool-result consent anchors ${path}`);
}

/** The FRESH resolver over the operator's anchor file: re-read on every call, so rotation and
 *  withdrawal apply at the next verification. A file that no longer reads resolves nothing. */
export function toolResultConsentAnchorFileResolver(path: string): AnchorResolver {
  if (!isAbsolute(path)) throw new Error(`tool-result consent anchors: ${path} is not an absolute path`);
  return (keyId) => {
    try {
      return readToolResultConsentAnchorFile(path).find((a) => a.keyId === keyId);
    } catch {
      return undefined;
    }
  };
}

/** Is the signer of an applied consent still a current `consents` anchor covering `tool-results`
 *  for its signing time? The same gate verification ran, resolved fresh; any refusal is `false`. */
export async function consentSignerStillCurrent(resolve: AnchorResolver, consent: { issuer: { keyId: string }; iat: number }): Promise<boolean> {
  try {
    const anchor = await resolveAnchorForUse(resolve, { keyId: consent.issuer.keyId, role: "consents", at: consent.iat });
    assertAnchorScopeCovers(anchor, "consents", TOOL_RESULT_CONSENT_SCOPE, "the consent's scope");
    return true;
  } catch {
    return false;
  }
}
