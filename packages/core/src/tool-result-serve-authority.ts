/**
 * User-mode tool-result serving (SPEC 13.6): the closed request a participant manager sends its
 * host to issue or renew ONE managed incarnation's `tool-results` serving material, the host's
 * material, and the 0600 serving file the manager maintains for the session.
 *
 * WHY A HOST. On a user-mode mesh (Cloud) the participant manager holds no space authority; only the
 * host can register the incarnation's serving instance and sign its `endpoint-serve` credential.
 * The manager generates the serving nkey locally and sends only its public id; the host returns a
 * signed JWT for it, the serve grant it minted under, and the PUBLIC consent anchors it registers.
 * No seed, signer, permission object or consent private key crosses this seam.
 *
 * WHY A FILE THE MANAGER REWRITES. The session runs beside the manager, and the material is
 * finite: the manager renews it before `notAfter` and rewrites the file; the session re-reads the
 * creds on every (re)connect and the anchors on every consent verification, so a renewal applies
 * without restarting it. A failed or unknown renewal removes the file, and past `notAfter` the
 * anchors resolve nothing, so a missed renewal stops authorization instead of keeping a stale
 * snapshot current.
 */
import { readFileSync, statSync } from "node:fs";
import { isAbsolute } from "node:path";
import type { AnchorResolver, SignerAnchor } from "./endpoint-signing.js";
import type { EpServeGrant } from "./endpoint-service.js";
import { credsFromJwt, isUserNkey, type Identity } from "./identity.js";
import { writeSecretFile } from "./secret-fs.js";
import { assertDerivedOwnerToken, assertLifecycleToken, assertValidOwnerToken } from "./subjects.js";
import { parseToolResultConsentAnchors, type ToolResultConsentAnchorRecord } from "./tool-result-anchors.js";
import { TOOL_RESULT_ENDPOINT } from "./tool-result-contract.js";

export interface ToolResultServeAuthorityRequest {
  v: 1;
  kind: "tool-result-serve-authority";
  /** `issue` registers the incarnation's instance; `renew` re-mints on the SAME registration. */
  operation: "issue" | "renew";
  space: string;
  /** The managed agent, re-read by the host from its ledger row and lifecycle head. */
  target: { actor: string; lifecycleUid: string };
  /** The participant manager instance that launched it; the host checks it is the row's parent. */
  managerInstanceId: string;
  /** The caller-generated serving nkey (public id only). */
  serve: { id: string };
  /** Renew only: the serve epoch the current grant names; a moved gate refuses. */
  epoch?: number;
  requestId: string;
}

export interface ToolResultServeAuthorityMaterial {
  v: 1;
  kind: "tool-result-serve-authority";
  operation: ToolResultServeAuthorityRequest["operation"];
  space: string;
  owner: string;
  target: ToolResultServeAuthorityRequest["target"];
  requestId: string;
  grant: EpServeGrant;
  credential: { jwt: string; exp: number };
  /** The host's registered public consent anchors. Absent: the host registers none and every
   *  consent is refused. */
  consentAnchors?: ToolResultConsentAnchorRecord[];
}

const isRec = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);
const closed = (o: Record<string, unknown>, keys: string[], what: string): void => {
  for (const k of Object.keys(o)) if (!keys.includes(k)) throw new Error(`${what}: unknown field "${k}"`);
};
const REQUEST_ID = /^[A-Za-z0-9_-]{16,64}$/;

/** The host's closed parser. Every coordinate is re-checked against the host's own records after. */
export function parseToolResultServeAuthorityRequest(raw: unknown): ToolResultServeAuthorityRequest {
  const what = "tool-result serve authority request";
  if (!isRec(raw)) throw new Error(`${what}: not an object`);
  closed(raw, ["v", "kind", "operation", "space", "target", "managerInstanceId", "serve", "epoch", "requestId"], what);
  if (raw.v !== 1 || raw.kind !== "tool-result-serve-authority") throw new Error(`${what}: not a v1 tool-result-serve-authority request`);
  if (raw.operation !== "issue" && raw.operation !== "renew") throw new Error(`${what}: operation must be issue or renew`);
  if (typeof raw.space !== "string" || raw.space.length === 0) throw new Error(`${what}: space is not a string`);
  if (!isRec(raw.target)) throw new Error(`${what}: target is not an object`);
  closed(raw.target, ["actor", "lifecycleUid"], `${what} target`);
  if (typeof raw.target.actor !== "string" || typeof raw.target.lifecycleUid !== "string") throw new Error(`${what}: target needs actor and lifecycleUid`);
  assertValidOwnerToken(raw.target.actor);
  assertLifecycleToken(raw.target.lifecycleUid, "target.lifecycleUid");
  if (typeof raw.managerInstanceId !== "string") throw new Error(`${what}: managerInstanceId is not a string`);
  assertLifecycleToken(raw.managerInstanceId, "managerInstanceId");
  if (!isRec(raw.serve)) throw new Error(`${what}: serve is not an object`);
  closed(raw.serve, ["id"], `${what} serve`);
  if (!isUserNkey(raw.serve.id)) throw new Error(`${what}: serve.id is not a user nkey`);
  if (raw.operation === "renew") {
    if (typeof raw.epoch !== "number" || !Number.isSafeInteger(raw.epoch) || raw.epoch < 0) throw new Error(`${what}: renew needs the current serve epoch`);
  } else if (raw.epoch !== undefined) throw new Error(`${what}: issue must not carry an epoch`);
  if (typeof raw.requestId !== "string" || !REQUEST_ID.test(raw.requestId)) throw new Error(`${what}: requestId is not a bounded token`);
  return raw as unknown as ToolResultServeAuthorityRequest;
}

/** What a session's serving file holds. `notAfter` (ms) is the credential's expiry: the latest
 *  moment anything in the file may be used. */
export interface ToolResultServingFile {
  creds: string;
  grant: EpServeGrant;
  consentAnchors?: ToolResultConsentAnchorRecord[];
  notAfter: number;
}

/** The participant's check of the host's answer, then the file content. Refuses material that does
 *  not echo the request, a grant for any other endpoint/space/incarnation (or, on renew, epoch),
 *  a JWT for any other key, or malformed anchors. */
export function toolResultServingFromMaterial(raw: unknown, request: ToolResultServeAuthorityRequest, identity: Identity): ToolResultServingFile {
  const what = "tool-result serve authority material";
  if (!isRec(raw)) throw new Error(`${what}: not an object`);
  const m = raw as unknown as ToolResultServeAuthorityMaterial;
  if (m.v !== 1 || m.kind !== "tool-result-serve-authority" || m.operation !== request.operation || m.space !== request.space || m.requestId !== request.requestId)
    throw new Error(`${what}: does not echo the request`);
  if (!isRec(m.target) || m.target.actor !== request.target.actor || m.target.lifecycleUid !== request.target.lifecycleUid)
    throw new Error(`${what}: names another target`);
  assertDerivedOwnerToken(m.owner);
  const g = m.grant;
  if (!isRec(g) || g.space !== request.space || g.endpoint !== TOOL_RESULT_ENDPOINT || g.instanceId !== request.target.lifecycleUid || g.owner !== m.owner)
    throw new Error(`${what}: the grant is not this incarnation's tool-results instance`);
  if (request.operation === "renew" && g.epoch !== request.epoch) throw new Error(`${what}: the renewed grant moved to another serve epoch`);
  if (!isRec(m.credential) || typeof m.credential.jwt !== "string" || typeof m.credential.exp !== "number" || !Number.isSafeInteger(m.credential.exp))
    throw new Error(`${what}: credential is not a bounded JWT`);
  if (m.credential.exp * 1000 <= Date.now()) throw new Error(`${what}: credential is already expired`);
  const creds = credsFromJwt(m.credential.jwt, identity);
  if (m.consentAnchors !== undefined) parseToolResultConsentAnchors(m.consentAnchors, `${what} consentAnchors`);
  return { creds, grant: g, ...(m.consentAnchors !== undefined ? { consentAnchors: m.consentAnchors } : {}), notAfter: m.credential.exp * 1000 };
}

/** Write (or atomically replace) the session's serving file at 0600. */
export function writeToolResultServingFile(path: string, file: ToolResultServingFile): void {
  if (!isAbsolute(path)) throw new Error(`tool-result serving file ${path} is not an absolute path`);
  writeSecretFile(path, JSON.stringify(file));
}

/** Read the serving file fresh. Throws on a missing, group/world-readable or malformed file. */
export function readToolResultServingFile(path: string): ToolResultServingFile {
  if (!isAbsolute(path)) throw new Error(`tool-result serving file ${path} is not an absolute path`);
  if (process.platform !== "win32" && (statSync(path).mode & 0o077) !== 0) throw new Error(`tool-result serving file ${path} is readable beyond its owner`);
  const raw = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  if (!isRec(raw) || typeof raw.creds !== "string" || !isRec(raw.grant) || typeof raw.notAfter !== "number") throw new Error(`tool-result serving file ${path} is malformed`);
  if (raw.consentAnchors !== undefined) parseToolResultConsentAnchors(raw.consentAnchors, `tool-result serving file ${path}`);
  return raw as unknown as ToolResultServingFile;
}

/** The fresh resolver over the serving file: the host's anchors as of the latest renewal, and
 *  nothing once `notAfter` passed or the file is gone or unreadable. */
export function toolResultServingFileResolver(path: string, now: () => number = Date.now): AnchorResolver {
  return (keyId): SignerAnchor | undefined => {
    try {
      const f = readToolResultServingFile(path);
      if (now() > f.notAfter || f.consentAnchors === undefined) return undefined;
      return parseToolResultConsentAnchors(f.consentAnchors).find((a) => a.keyId === keyId);
    } catch {
      return undefined;
    }
  };
}
