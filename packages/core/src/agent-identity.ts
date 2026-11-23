/**
 * Agent identity: the identity of one agent across its runs. Each run keeps its own lifecycle UID;
 * the identity is what a relaunch proves it continues. A later run is linked only by a signature of
 * the identity's continuity key over that run's enrollment. The actor name, a persona and the
 * `agentUid` itself never link: none of them is a secret.
 */
import { createPrivateKey, createPublicKey, generateKeyPairSync, sign, verify } from "node:crypto";
import { canonicalJson } from "./canonical-json.js";
import { EpEnvelopeError } from "./endpoint-error.js";
import { assertDerivedOwnerToken, assertLifecycleToken, assertValidOwnerToken } from "./subject-grammar.js";

const AGENT_UID = /^ag_[a-z2-7]{26}$/;
const B32 = "abcdefghijklmnopqrstuvwxyz234567";
const RAW_KEY = /^[A-Za-z0-9_-]{43}$/;
const SIGNATURE = /^[A-Za-z0-9_-]{86}$/;
const HEX64 = /^[0-9a-f]{64}$/;
const LINK_DOMAIN = "cotal.agent-link/v1";
const MAX_WINDOW_MS = 300_000;
const SKEW_MS = 60_000;
const ED25519_SPKI = Buffer.from("302a300506032b6570032100", "hex");
const ED25519_PKCS8 = Buffer.from("302e020100300506032b657004220420", "hex");

/** The run an identity is linked to. `tokenHash` is the SHA-256 of that run's standing actor token,
 *  so a retry of the same enrollment is recognized without linking anything new. */
export interface AgentIdentityLink {
  lifecycleUid: string;
  actor: string;
  tokenHash: string;
  linkedAt: number;
  via: "mint" | "key" | "owner";
}

/** The closed `agentid.<agentUid>` record. `revoked` is terminal. */
export interface AgentIdentityRecord {
  v: 1;
  agentUid: string;
  owner: string;
  state: "active" | "revoked";
  key: { alg: "ed25519"; publicKey: string };
  keyEpoch: number;
  linkSeq: number;
  current: AgentIdentityLink;
  createdAt: number;
  revokedAt?: number;
}

/** What a rerun's enrollment carries. The verifier takes space, owner, actor and token hash from
 *  the enrollment it authenticated, never from the proof. */
export interface AgentLinkProof {
  agentUid: string;
  keyEpoch: number;
  linkSeq: number;
  issuedAt: number;
  expiresAt: number;
  signature: string;
}

/** The enrollment a proof is signed for and checked against. */
export interface AgentLinkContext {
  space: string;
  owner: string;
  actor: string;
  tokenHash: string;
}

/** Whether the run the record links may still be running: `settled` when its lifecycle is retired
 *  or its alias was replaced, `unknown` when the store could not answer. */
export type AgentPredecessor = "settled" | "live" | "unknown";

export interface AgentLinkRequest extends AgentLinkContext {
  /** As received on the wire; the decision parses it. */
  proof: unknown;
  lifecycleUid: string;
  predecessor: AgentPredecessor;
  now: number;
}

const isRec = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);
const uint = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v) && v >= 0;
const epochMs = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v) && v > 0;
const closedKeys = (o: Record<string, unknown>, required: string[], optional: string[] = []): boolean =>
  required.every((k) => k in o) && Object.keys(o).every((k) => required.includes(k) || optional.includes(k));
const denied = (why: string): never => {
  throw new EpEnvelopeError("permission-denied", `agent link refused: ${why}; only the identity's continuity key links a run`);
};

function assertAgentUid(v: unknown): string {
  if (typeof v !== "string" || !AGENT_UID.test(v)) throw new Error(`${JSON.stringify(v)} is not an agent identity (ag_ + 26 lowercase base32)`);
  return v;
}

/** Draw a fresh `agentUid` with 130 bits from the CSPRNG. The `_` keeps it disjoint from the
 *  lifecycle UID grammar. */
export function mintAgentUid(): string {
  const bytes = globalThis.crypto.getRandomValues(new Uint8Array(26));
  return `ag_${Array.from(bytes, (b) => B32[b & 31]).join("")}`;
}

export function agentIdentityKey(agentUid: string): string {
  return `agentid.${assertAgentUid(agentUid)}`;
}

function parseLink(raw: unknown, bad: (why: string) => never): void {
  if (!isRec(raw) || !closedKeys(raw, ["lifecycleUid", "actor", "tokenHash", "linkedAt", "via"])) bad("has a malformed current link");
  const o = raw as Record<string, unknown>;
  try { assertLifecycleToken(o.lifecycleUid as string); assertValidOwnerToken(o.actor as string); } catch { bad("links a malformed lifecycle or actor"); }
  if (typeof o.tokenHash !== "string" || !HEX64.test(o.tokenHash)) bad("links a malformed token hash");
  if (!epochMs(o.linkedAt)) bad("has a malformed linkedAt");
  if (o.via !== "mint" && o.via !== "key" && o.via !== "owner") bad("has an unknown link kind");
}

/** Parse one stored record against its key. Anything outside the closed shape refuses: garbled
 *  authority state never authorizes. */
export function parseAgentIdentityRecord(key: string, raw: unknown): AgentIdentityRecord {
  const bad = (why: string): never => {
    throw new EpEnvelopeError("failed-precondition", `${key}: agent identity record ${why}; a record outside the closed contract never authorizes`);
  };
  if (!isRec(raw) || !closedKeys(raw, ["v", "agentUid", "owner", "state", "key", "keyEpoch", "linkSeq", "current", "createdAt"], ["revokedAt"]))
    bad("is not the closed v1 shape");
  const o = raw as Record<string, unknown>;
  if (o.v !== 1) bad("has an unknown version");
  try { assertAgentUid(o.agentUid); assertDerivedOwnerToken(o.owner as string); } catch { bad("names a malformed identity or owner"); }
  if (key !== agentIdentityKey(o.agentUid as string)) bad("is stored under another key");
  if (!isRec(o.key) || !closedKeys(o.key, ["alg", "publicKey"]) || o.key.alg !== "ed25519" || typeof o.key.publicKey !== "string" || !RAW_KEY.test(o.key.publicKey))
    bad("has a malformed continuity key");
  if (!uint(o.keyEpoch) || !uint(o.linkSeq) || (o.linkSeq as number) < 1) bad("has malformed epochs");
  parseLink(o.current, bad);
  if (!epochMs(o.createdAt)) bad("has a malformed createdAt");
  if (o.state === "active") { if (o.revokedAt !== undefined) bad("is active but carries revokedAt"); }
  else if (o.state === "revoked") { if (!epochMs(o.revokedAt)) bad("is revoked without revokedAt"); }
  else bad("has an unknown state");
  return o as unknown as AgentIdentityRecord;
}

function parseAgentLinkProof(raw: unknown): AgentLinkProof {
  const bad = (why: string): never => { throw new EpEnvelopeError("bad-request", `agent link proof ${why}`); };
  if (!isRec(raw) || !closedKeys(raw, ["agentUid", "keyEpoch", "linkSeq", "issuedAt", "expiresAt", "signature"])) bad("is not the closed shape");
  const o = raw as Record<string, unknown>;
  try { assertAgentUid(o.agentUid); } catch { bad("names a malformed identity"); }
  if (!uint(o.keyEpoch) || !uint(o.linkSeq) || !epochMs(o.issuedAt) || !epochMs(o.expiresAt)) bad("has malformed numbers");
  if (typeof o.signature !== "string" || !SIGNATURE.test(o.signature)) bad("has a malformed signature");
  return o as unknown as AgentLinkProof;
}

/** A fresh continuity key pair, both halves raw 32 bytes in base64url. The custodian keeps the
 *  private half; only the public half is ever sent. */
export function createAgentContinuityKey(): { publicKey: string; privateKey: string } {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  return { publicKey: publicKey.export({ format: "jwk" }).x!, privateKey: privateKey.export({ format: "jwk" }).d! };
}

function linkClaims(ctx: AgentLinkContext, p: Omit<AgentLinkProof, "signature">): Uint8Array {
  return new TextEncoder().encode(canonicalJson({
    d: LINK_DOMAIN, space: ctx.space, owner: ctx.owner, agentUid: p.agentUid, keyEpoch: p.keyEpoch, linkSeq: p.linkSeq,
    actor: ctx.actor, tokenHash: ctx.tokenHash, issuedAt: p.issuedAt, expiresAt: p.expiresAt,
  }));
}

export function signAgentLink(privateKey: string, ctx: AgentLinkContext, p: Omit<AgentLinkProof, "signature">): AgentLinkProof {
  if (!RAW_KEY.test(privateKey)) throw new Error("agent continuity private key must be 32 bytes in base64url");
  const der = Buffer.concat([ED25519_PKCS8, Buffer.from(privateKey, "base64url")]);
  try {
    const key = createPrivateKey({ key: der, format: "der", type: "pkcs8" });
    return { ...p, signature: sign(null, linkClaims(ctx, p), key).toString("base64url") };
  } finally { der.fill(0); }
}

/** The first record of a freshly minted identity, linked to the run that minted it. Throws on any
 *  malformed input, so a minted record always parses. */
export function mintedAgentIdentity(args: { agentUid: string; owner: string; publicKey: string; lifecycleUid: string; actor: string; tokenHash: string; now: number }): AgentIdentityRecord {
  const record: AgentIdentityRecord = {
    v: 1, agentUid: args.agentUid, owner: args.owner, state: "active", key: { alg: "ed25519", publicKey: args.publicKey }, keyEpoch: 0, linkSeq: 1,
    current: { lifecycleUid: args.lifecycleUid, actor: args.actor, tokenHash: args.tokenHash, linkedAt: args.now, via: "mint" }, createdAt: args.now,
  };
  return parseAgentIdentityRecord(agentIdentityKey(args.agentUid), record);
}

function assertProofWindow(p: AgentLinkProof, now: number): void {
  if (p.expiresAt <= p.issuedAt || p.expiresAt - p.issuedAt > MAX_WINDOW_MS) denied(`the proof window is not 1..${MAX_WINDOW_MS} ms`);
  if (now + SKEW_MS < p.issuedAt) denied("the proof is issued in the future");
  if (now - SKEW_MS >= p.expiresAt) denied("the proof expired");
}

function assertProofSignature(record: AgentIdentityRecord, ctx: AgentLinkContext, p: AgentLinkProof, linkSeq: number): void {
  if (p.keyEpoch !== record.keyEpoch) denied("the proof names another key epoch");
  if (p.linkSeq !== linkSeq) denied("the proof names another link sequence, so it is stale or replayed");
  const key = createPublicKey({ key: Buffer.concat([ED25519_SPKI, Buffer.from(record.key.publicKey, "base64url")]), format: "der", type: "spki" });
  if (!verify(null, linkClaims(ctx, p), key, Buffer.from(p.signature, "base64url")))
    denied("the signature does not verify under the identity's continuity key for this enrollment");
}

/**
 * Decide a key-proved link of a new run to `record`. Returns the next record and whether it
 * changed: an exact retry of the enrollment that already holds the link answers the record
 * unchanged. Refuses a revoked identity, another owner, a proof that does not verify for this
 * space, owner, actor, token, key epoch and sequence, a proof outside its window, and a
 * predecessor that may still run or whose state is unknown.
 */
export function decideAgentLink(record: AgentIdentityRecord, req: AgentLinkRequest): { record: AgentIdentityRecord; changed: boolean } {
  const proof = parseAgentLinkProof(req.proof);
  try { assertLifecycleToken(req.lifecycleUid); assertValidOwnerToken(req.actor); } catch { throw new EpEnvelopeError("bad-request", "agent link names a malformed lifecycle or actor"); }
  if (typeof req.tokenHash !== "string" || !HEX64.test(req.tokenHash)) throw new EpEnvelopeError("bad-request", "agent link names a malformed token hash");
  if (proof.agentUid !== record.agentUid) denied("the proof names another identity");
  if (record.state !== "active") throw new EpEnvelopeError("failed-precondition", `agent identity ${record.agentUid} is revoked; it never links again`);
  if (req.owner !== record.owner) denied("the identity belongs to another owner");
  assertProofWindow(proof, req.now);
  const c = record.current;
  if (c.via === "key" && c.lifecycleUid === req.lifecycleUid && c.actor === req.actor && c.tokenHash === req.tokenHash) {
    assertProofSignature(record, req, proof, record.linkSeq - 1);
    return { record, changed: false };
  }
  assertProofSignature(record, req, proof, record.linkSeq);
  if (req.predecessor === "live") throw new EpEnvelopeError("conflict", `agent identity ${record.agentUid} is linked to lifecycle ${c.lifecycleUid}, which may still run; retire it first`);
  if (req.predecessor !== "settled") throw new EpEnvelopeError("unavailable", `agent identity ${record.agentUid}: the predecessor's state is unknown, so nothing links`);
  const current: AgentIdentityLink = { lifecycleUid: req.lifecycleUid, actor: req.actor, tokenHash: req.tokenHash, linkedAt: req.now, via: "key" };
  return { record: { ...record, linkSeq: record.linkSeq + 1, current }, changed: true };
}
