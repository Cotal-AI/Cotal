/**
 * Owner-authorized remint capability for independent session-credential renewal.
 *
 * R4:106 only. The loopback operator bearer (`ctx.cap`) is not proof of possession
 * and must never be distributed to connectors. This artifact is a signed, actor /
 * lifecycle / resource-bound capability. Presenting it authorizes a remint of that
 * enrollment only after the caller also proves possession of the enrolled nkey.
 *
 * Never signing-key transfer. Never `supervise`. Replay of a used nonce is refused.
 */
import { randomBytes } from "node:crypto";
import { fromPublic } from "@nats-io/nkeys";
import { EpEnvelopeError } from "./endpoint-envelope.js";
import {
  assertAnchorScopeCovers,
  assertArtifactCurrency,
  resolveAnchorForUse,
  signArtifact,
  verifyArtifactSignature,
  type AnchorResolver,
} from "./endpoint-signing.js";
import { assertIdToken, assertLifecycleToken, assertNonce } from "./endpoint-subjects.js";
import { parseResourceKey, resourceKeyId, type ResourceKey } from "./session-lifecycle-records.js";
import { parsePrincipalKey } from "./subjects.js";

const isRec = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === "object" && !Array.isArray(v);

function refuse(code: "contract-invalid" | "permission-denied" | "failed-precondition" | "expired", message: string): never {
  throw new EpEnvelopeError(code, `${message} (session remint capability)`);
}

const CAP_FIELDS = new Set([
  "v", "family", "id", "space", "resourceKey", "holder", "enrolledPublicId", "iat", "nbf", "exp", "nonce", "issuer", "sig",
]);
const HOLDER_FIELDS = new Set(["owner", "actor", "lifecycleUid"]);
const ISSUER_FIELDS = new Set(["keyId"]);
const USER_NKEY = /^U[A-Z2-7]{55}$/;
const HANDLE_TOKEN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

/** Live-class ceiling, same as a session grant: a remint cap is not sturdy. */
export const SESSION_REMINT_CAP_MAX_TTL_MS = 24 * 60 * 60 * 1000;
export const SESSION_REMINT_CAP_MAX_BYTES = 16 * 1024;
export const SESSION_REMINT_FAMILY = "session-remint" as const;

export interface SessionRemintCap {
  readonly v: 1;
  readonly family: typeof SESSION_REMINT_FAMILY;
  readonly id: string;
  readonly space: string;
  readonly resourceKey: ResourceKey;
  readonly holder: { readonly owner: string; readonly actor: string; readonly lifecycleUid: string };
  readonly enrolledPublicId: string;
  readonly iat: number;
  readonly nbf?: number;
  readonly exp: number;
  readonly nonce: string;
  readonly issuer: { readonly keyId: string };
  readonly sig: string;
}

export interface MintSessionRemintCapArgs {
  space: string;
  resourceKey: ResourceKey;
  holder: { owner: string; actor: string; lifecycleUid: string };
  enrolledPublicId: string;
  ttlMs: number;
  issuerKeyId: string;
  now?: number;
  id?: string;
}

export type SessionRemintNonceSeen = (nonce: string) => Promise<boolean> | boolean;
export type SessionRemintNonceMark = (nonce: string) => Promise<void> | void;

function assertCapToken(v: unknown, what: string): string {
  if (typeof v !== "string" || !HANDLE_TOKEN.test(v)) refuse("contract-invalid", `${what} is not a bounded token`);
  return v;
}

function assertHolder(value: unknown, label: string): SessionRemintCap["holder"] {
  if (!isRec(value)) refuse("contract-invalid", `${label} is not an object`);
  for (const k of Object.keys(value)) if (!HOLDER_FIELDS.has(k)) refuse("contract-invalid", `${label} carries unknown field "${k}"`);
  if (typeof value.owner !== "string" || typeof value.actor !== "string")
    refuse("contract-invalid", `${label} does not carry owner and actor strings`);
  const principal = parsePrincipalKey(`${value.owner}.${value.actor}`);
  if (principal === null) refuse("contract-invalid", `${label} is not a canonical owner.actor principal`);
  let lifecycleUid: string;
  try { lifecycleUid = assertLifecycleToken(value.lifecycleUid as string, `${label}.lifecycleUid`); }
  catch { refuse("contract-invalid", `${label}.lifecycleUid is not a lifecycle token`); }
  return { owner: principal.owner, actor: principal.actor, lifecycleUid };
}

function assertUserNkey(v: unknown, label: string): string {
  if (typeof v !== "string" || !USER_NKEY.test(v)) refuse("contract-invalid", `${label} is not a NATS user public nkey`);
  return v;
}

/** Closed-schema parse without audience, currency, signature, or possession. */
export function parseSessionRemintCapShape(raw: unknown): SessionRemintCap {
  if (!isRec(raw)) refuse("contract-invalid", "is not an object");
  return parseUnsigned(raw);
}

function parseUnsigned(raw: Record<string, unknown>, space?: string): SessionRemintCap {
  for (const k of Object.keys(raw)) if (!CAP_FIELDS.has(k)) refuse("contract-invalid", `carries unknown field "${k}" (closed schema)`);
  if (raw.v !== 1) refuse("contract-invalid", "version is not 1");
  if (raw.family !== SESSION_REMINT_FAMILY) refuse("contract-invalid", `family is not ${SESSION_REMINT_FAMILY}`);
  if (typeof raw.space !== "string" || raw.space.length === 0) refuse("contract-invalid", "space is not a string");
  if (space !== undefined && raw.space !== space) refuse("permission-denied", `is bound to space ${raw.space}, not ${space}`);
  let id: string;
  try { id = assertIdToken(raw.id as string, "id"); }
  catch { refuse("contract-invalid", "id is not a bounded id token"); }
  let resourceKey: ResourceKey;
  try { resourceKey = parseResourceKey(raw.resourceKey, "resourceKey"); }
  catch (e) { refuse("contract-invalid", e instanceof Error ? e.message : String(e)); }
  const holder = assertHolder(raw.holder, "holder");
  const enrolledPublicId = assertUserNkey(raw.enrolledPublicId, "enrolledPublicId");
  if (typeof raw.iat !== "number" || !Number.isSafeInteger(raw.iat) || raw.iat < 0) refuse("contract-invalid", "iat is not a non-negative integer");
  if (raw.nbf !== undefined && (typeof raw.nbf !== "number" || !Number.isSafeInteger(raw.nbf) || raw.nbf < 0))
    refuse("contract-invalid", "nbf is not a non-negative integer");
  if (typeof raw.exp !== "number" || !Number.isSafeInteger(raw.exp) || raw.exp < 0) refuse("contract-invalid", "exp is not a non-negative integer");
  let nonce: string;
  try { nonce = assertNonce(raw.nonce as string); }
  catch { refuse("contract-invalid", "nonce is not a bounded CSPRNG token"); }
  if (!isRec(raw.issuer)) refuse("contract-invalid", "issuer is not an object");
  for (const k of Object.keys(raw.issuer)) if (!ISSUER_FIELDS.has(k)) refuse("contract-invalid", `issuer carries unknown field "${k}"`);
  const keyId = assertCapToken((raw.issuer as Record<string, unknown>).keyId, "issuer.keyId");
  if (typeof raw.sig !== "string") refuse("contract-invalid", "has no sig");
  return {
    v: 1,
    family: SESSION_REMINT_FAMILY,
    id,
    space: raw.space,
    resourceKey,
    holder,
    enrolledPublicId,
    iat: raw.iat,
    ...(raw.nbf !== undefined ? { nbf: raw.nbf } : {}),
    exp: raw.exp,
    nonce,
    issuer: { keyId },
    sig: raw.sig,
  };
}

/** Mint a live remint capability bound to one enrollment resource and one enrolled nkey. */
export function mintSessionRemintCap(
  args: MintSessionRemintCapArgs,
  keyPair: { sign(input: Uint8Array): Uint8Array },
): SessionRemintCap {
  const now = args.now ?? Date.now();
  if (!Number.isSafeInteger(now) || now < 0) refuse("contract-invalid", "now is not a non-negative integer");
  if (!Number.isSafeInteger(args.ttlMs) || args.ttlMs <= 0 || args.ttlMs > SESSION_REMINT_CAP_MAX_TTL_MS)
    refuse("contract-invalid", `ttlMs ${String(args.ttlMs)} is not in (0, ${SESSION_REMINT_CAP_MAX_TTL_MS}]`);
  const holder = assertHolder(args.holder, "holder");
  const resourceKey = parseResourceKey(args.resourceKey, "resourceKey");
  const enrolledPublicId = assertUserNkey(args.enrolledPublicId, "enrolledPublicId");
  const id = args.id !== undefined ? assertIdToken(args.id, "id") : assertIdToken(randomBytes(18).toString("base64url"), "id");
  const unsigned = {
    v: 1 as const,
    family: SESSION_REMINT_FAMILY,
    id,
    space: args.space,
    resourceKey,
    holder,
    enrolledPublicId,
    iat: now,
    exp: now + args.ttlMs,
    nonce: assertNonce(randomBytes(18).toString("base64url")),
    issuer: { keyId: assertCapToken(args.issuerKeyId, "issuerKeyId") },
  };
  return signArtifact(unsigned, keyPair);
}

export interface VerifySessionRemintCapOpts {
  space: string;
  resolveAnchor: AnchorResolver;
  now?: number;
  resourceKey: ResourceKey;
  holder: { owner: string; actor: string; lifecycleUid: string };
  enrolledPublicId: string;
  possession: Uint8Array;
  nonceSeen: SessionRemintNonceSeen;
  markNonce: SessionRemintNonceMark;
}

/**
 * Verify a presented remint cap, then require possession of the enrolled nkey.
 * `possession` is the Ed25519 signature of the cap's nonce under that nkey.
 * A used nonce is refused rather than replayed.
 */
export async function verifySessionRemintCap(raw: unknown, opts: VerifySessionRemintCapOpts): Promise<SessionRemintCap> {
  const now = opts.now ?? Date.now();
  if (!Number.isSafeInteger(now) || now < 0)
    throw new EpEnvelopeError("failed-precondition", `now must be a non-negative safe integer; got ${JSON.stringify(now)}`);
  if (!isRec(raw)) refuse("contract-invalid", "is not an object");
  const canonical = JSON.stringify(raw);
  if (Buffer.byteLength(canonical, "utf8") > SESSION_REMINT_CAP_MAX_BYTES)
    refuse("contract-invalid", `exceeds ${SESSION_REMINT_CAP_MAX_BYTES} bytes`);
  const cap = parseUnsigned(raw, opts.space);
  const expectedResource = parseResourceKey(opts.resourceKey, "presented resourceKey");
  if (resourceKeyId(cap.resourceKey) !== resourceKeyId(expectedResource))
    refuse("permission-denied", "is not bound to the requested resource");
  const expectedHolder = assertHolder(opts.holder, "presented holder");
  if (cap.holder.owner !== expectedHolder.owner
    || cap.holder.actor !== expectedHolder.actor
    || cap.holder.lifecycleUid !== expectedHolder.lifecycleUid)
    refuse("permission-denied", "is not bound to the requested actor and lifecycle");
  const enrolledPublicId = assertUserNkey(opts.enrolledPublicId, "presented enrolledPublicId");
  if (cap.enrolledPublicId !== enrolledPublicId)
    refuse("permission-denied", "is not bound to the enrolled public nkey");

  const anchor = await resolveAnchorForUse(opts.resolveAnchor, { keyId: cap.issuer.keyId, role: "sessions", at: cap.iat });
  assertAnchorScopeCovers(anchor, "sessions", SESSION_REMINT_FAMILY, "the remint family");
  verifyArtifactSignature(raw, anchor);
  assertArtifactCurrency(
    { iat: cap.iat, ...(cap.nbf !== undefined ? { nbf: cap.nbf } : {}), exp: cap.exp },
    { now, ceilingMs: SESSION_REMINT_CAP_MAX_TTL_MS, what: "session remint capability", ceilingName: "live", refusals: "post-signature" },
  );

  if (!(opts.possession instanceof Uint8Array) || opts.possession.length !== 64)
    refuse("permission-denied", "key possession proof is not a 64-byte Ed25519 signature");
  let possessed = false;
  try {
    possessed = fromPublic(cap.enrolledPublicId).verify(new TextEncoder().encode(cap.nonce), opts.possession);
  } catch (e) {
    refuse("permission-denied", `key possession proof does not verify: ${e instanceof Error ? e.message : String(e)}`);
  }
  if (!possessed) refuse("permission-denied", "key possession proof does not match the enrolled nkey");

  const seen = await opts.nonceSeen(cap.nonce);
  if (seen === true) refuse("permission-denied", "nonce has already been used; replay is refused");
  await opts.markNonce(cap.nonce);
  return cap as SessionRemintCap;
}
