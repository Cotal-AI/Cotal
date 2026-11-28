/** A stable agent identity belongs to one owner. Each run still has its own lifecycle UID. */
import { EpEnvelopeError } from "./endpoint-error.js";
import { assertDerivedOwnerToken, assertLifecycleToken, assertValidOwnerToken } from "./subject-grammar.js";

const AGENT_UID = /^ag_[a-z2-7]{26}$/;
const B32 = "abcdefghijklmnopqrstuvwxyz234567";

/** The last run linked to an identity. Its lifecycle, not the actor name, identifies the run. */
export interface AgentIdentityLink {
  lifecycleUid: string;
  actor: string;
  linkedAt: number;
  via: "mint" | "owner" | "launcher";
}

/** The closed `agentid.<agentUid>` record. */
export interface AgentIdentityRecord {
  v: 1;
  agentUid: string;
  owner: string;
  state: "active" | "revoked";
  linkSeq: number;
  current: AgentIdentityLink;
  createdAt: number;
  revokedAt?: number;
}

/** The preceding run is settled only when the server has confirmed it cannot run again. */
export type AgentPredecessor = "settled" | "live" | "unknown";

/** Server-resolved facts, not a launch request schema. `owner` is the target owner for whom
 * `authority` was checked. `launcher` means a launcher authorized to link this identity for that
 * owner. A run presenting its own agent credential is `agent`, even if it holds other grants. */
export interface AgentLinkRequest {
  agentUid: string;
  owner: string;
  authority: "owner" | "launcher" | "agent" | "none";
  actor: string;
  lifecycleUid: string;
  predecessor: AgentPredecessor;
  now: number;
}

const isRec = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);
const positiveInt = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v) && v > 0;
const closedKeys = (o: Record<string, unknown>, required: string[], optional: string[] = []): boolean =>
  required.every((k) => Object.hasOwn(o, k)) && Object.keys(o).every((k) => required.includes(k) || optional.includes(k));
const denied = (why: string): never => {
  throw new EpEnvelopeError("permission-denied", `agent link refused: ${why}`);
};

function assertAgentUid(v: unknown): string {
  if (typeof v !== "string" || !AGENT_UID.test(v)) throw new Error(`${JSON.stringify(v)} is not an agent identity (ag_ + 26 lowercase base32)`);
  return v;
}

/** Draw a fresh `agentUid` with 130 bits from the CSPRNG. The `_` keeps it disjoint from the
 * lifecycle UID grammar. */
export function mintAgentUid(): string {
  const bytes = globalThis.crypto.getRandomValues(new Uint8Array(26));
  return `ag_${Array.from(bytes, (b) => B32[b & 31]).join("")}`;
}

export function agentIdentityKey(agentUid: string): string {
  return `agentid.${assertAgentUid(agentUid)}`;
}

function assertRun(run: { lifecycleUid: unknown; actor: unknown }): void {
  if (typeof run.lifecycleUid !== "string" || typeof run.actor !== "string") throw new Error("run requires a lifecycle and actor token");
  assertLifecycleToken(run.lifecycleUid);
  assertValidOwnerToken(run.actor);
}

function parseLink(raw: unknown, bad: (why: string) => never): void {
  if (!isRec(raw) || !closedKeys(raw, ["lifecycleUid", "actor", "linkedAt", "via"])) bad("has a malformed current link");
  const o = raw as Record<string, unknown>;
  try { assertRun({ lifecycleUid: o.lifecycleUid, actor: o.actor }); } catch { bad("links a malformed lifecycle or actor"); }
  if (!positiveInt(o.linkedAt)) bad("has a malformed linkedAt");
  if (o.via !== "mint" && o.via !== "owner" && o.via !== "launcher") bad("has an unknown link kind");
}

/** Parse one stored record against its key. Only the closed record shape authorizes. */
export function parseAgentIdentityRecord(key: string, raw: unknown): AgentIdentityRecord {
  const bad = (why: string): never => {
    throw new EpEnvelopeError("failed-precondition", `${key}: agent identity record ${why}; a record outside the closed contract never authorizes`);
  };
  if (!isRec(raw) || !closedKeys(raw, ["v", "agentUid", "owner", "state", "linkSeq", "current", "createdAt"], ["revokedAt"]))
    bad("is not the closed v1 shape");
  const o = raw as Record<string, unknown>;
  if (o.v !== 1) bad("has an unknown version");
  try { assertAgentUid(o.agentUid); assertDerivedOwnerToken(o.owner as string); } catch { bad("names a malformed identity or owner"); }
  if (key !== agentIdentityKey(o.agentUid as string)) bad("is stored under another key");
  if (!positiveInt(o.linkSeq)) bad("has a malformed link sequence");
  parseLink(o.current, bad);
  if (!positiveInt(o.createdAt)) bad("has a malformed createdAt");
  if (o.state === "active") { if (Object.hasOwn(o, "revokedAt")) bad("is active but carries revokedAt"); }
  else if (o.state === "revoked") { if (!positiveInt(o.revokedAt)) bad("is revoked without revokedAt"); }
  else bad("has an unknown state");
  return o as unknown as AgentIdentityRecord;
}

/** Build the record for an identity and its first run. This does not reserve the ID or issue a credential. */
export function mintedAgentIdentity(args: { agentUid: string; owner: string; lifecycleUid: string; actor: string; now: number }): AgentIdentityRecord {
  const record: AgentIdentityRecord = {
    v: 1, agentUid: args.agentUid, owner: args.owner, state: "active", linkSeq: 1,
    current: { lifecycleUid: args.lifecycleUid, actor: args.actor, linkedAt: args.now, via: "mint" }, createdAt: args.now,
  };
  return parseAgentIdentityRecord(agentIdentityKey(args.agentUid), record);
}

/** Decide a link without reading or writing state. The server must fence the lifecycle observation
 * and record update before releasing a credential. An authorized retry for the exact live run
 * leaves the link unchanged. A settled run cannot be issued again under its old lifecycle UID. */
export function decideAgentLink(record: AgentIdentityRecord, req: AgentLinkRequest): { record: AgentIdentityRecord; changed: boolean } {
  const via = req.authority;
  if (via === "agent") denied("an agent cannot link itself");
  if (via !== "owner" && via !== "launcher") return denied("the caller is not authorized to link");
  let key: string;
  try {
    key = agentIdentityKey(req.agentUid);
    assertDerivedOwnerToken(req.owner);
    assertRun(req);
    if (!positiveInt(req.now)) throw new Error("invalid timestamp");
  } catch { throw new EpEnvelopeError("bad-request", "agent link names a malformed identity, owner, run or time"); }
  if (req.agentUid !== record.agentUid || req.owner !== record.owner) denied("the identity does not match the authorized request");
  const stored = parseAgentIdentityRecord(key, record);
  if (stored.state === "revoked") throw new EpEnvelopeError("failed-precondition", `agent identity ${stored.agentUid} is revoked`);
  const current = stored.current;
  const sameRun = current.lifecycleUid === req.lifecycleUid;
  if (req.predecessor === "live") {
    if (sameRun && current.actor === req.actor) return { record: stored, changed: false };
    throw new EpEnvelopeError("conflict", `agent identity ${stored.agentUid} is linked to lifecycle ${current.lifecycleUid}, which may still run; retire it first`);
  }
  if (req.predecessor !== "settled") throw new EpEnvelopeError("unavailable", `agent identity ${stored.agentUid}: the predecessor's state is unknown, so nothing links`);
  if (sameRun) throw new EpEnvelopeError("conflict", `lifecycle ${current.lifecycleUid} has already ended; a new run needs a new lifecycle`);
  const next = { ...stored, linkSeq: stored.linkSeq + 1, current: { lifecycleUid: req.lifecycleUid, actor: req.actor, linkedAt: req.now, via } };
  return { record: parseAgentIdentityRecord(key, next), changed: true };
}
