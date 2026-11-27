import {
  EpEnvelopeError, agentIdentityKey, assertDerivedOwnerToken, assertLifecycleToken, assertValidChannel, assertValidOwnerToken,
  canonicalJson, isAccountNkey, isCasLoss, isConcreteChannel, spacePrefix,
} from "@cotal-ai/core";
import type { KV } from "@nats-io/kv";

export type LinkedTarget = { owner: string; actor: string; lifecycleUid: string; agentUid: string };
export type LinkedSelection = { mode: "create" } | { mode: "select"; agentUid: string };
export type LinkedGrantInput = Pick<LinkedTarget, "owner" | "actor"> & {
  requestId: string; agentLink: LinkedSelection; approvalId: string; approvalExpiresAtMs: number;
  scope: string[]; allowSubscribe: string[]; allowPublish: string[];
};
export type LinkedGrantAck = Omit<LinkedTarget, "agentUid"> & {
  v: 1; state: "pending"; agentLink: { mode: LinkedSelection["mode"]; agentUid: string }; actorToken: string;
};
export type LinkedGrant = LinkedTarget & {
  linkOperationId: string; tokenHash: string; scope: string[]; allowSubscribe: string[]; allowPublish: string[]; eventPayloads?: false;
};
type Stage = "intent" | "pending" | "committing" | "ready" | "retiring" | "ended";
export type LinkedJournal = LinkedGrant & {
  v: 1; accountPublicKey: string; space: string; mode: LinkedSelection["mode"]; requestId: string; approvalId: string;
  stage: Stage; admittedAt: number; expectedIdentityRevision: number; identityCommitted: boolean;
  commit: { at: number; credentialId: string; generation: number; processEpoch: number } | null;
  end: { at: number; by: "owner" | "recovery" } | null;
};
export type LinkRef = LinkedTarget & { v: 1; linkOperationId: string; mode: LinkedSelection["mode"] };
export type LinkedCoordinates = { accountPublicKey: string; space: string };
export type LinkedBinding = LinkRef & LinkedCoordinates & NonNullable<LinkedJournal["commit"]>;
export type Snapshot<T> = { row: T; revision: number };

export const LINK_ENABLE_KEY = "agentlink.enable";
export const journalKey = (j: Pick<LinkedJournal, "mode" | "agentUid" | "linkOperationId">) =>
  j.mode === "create" ? `agentlinkjournal.create.${j.agentUid}` : `agentlinkjournal.select.${j.linkOperationId}`;
export const winnerKey = (uid: string) => `agentlinkwinner.${uid}`;
export const markerKey = (uid: string) => `agentlinkpending.${uid}`;
export const bindingKey = (uid: string) => `agentlinkbinding.${uid}`;
export const approvalKey = (approvalId: string) => `agentlinkapproval.${approvalId}`;
export const auditKey = (op: string, kind: "link" | "unlink") => `agentlinkaudit.${op}.${kind}`;
export const linkRef = ({ owner, actor, lifecycleUid, agentUid, linkOperationId, mode }: LinkedJournal): LinkRef =>
  ({ v: 1, owner, actor, lifecycleUid, agentUid, linkOperationId, mode });
export const LINK_WRITE_KEYS = ["agentid.*", "agentlinkjournal.*.*", "agentlinkwinner.*", "agentlinkpending.*", "agentlinkbinding.*", "agentlinkapproval.*", "agentlinkaudit.*.*"];

const enc = new TextEncoder();
const dec = new TextDecoder("utf-8", { fatal: true });
const hex = (x: unknown, len: 32 | 64): x is string => typeof x === "string" && x.length === len && /^[a-f0-9]+$/.test(x);
const nat = (x: unknown): x is number => typeof x === "number" && Number.isSafeInteger(x) && x >= 0;
const pos = (x: unknown): x is number => nat(x) && x > 0;
const stringToken = (x: unknown): x is string => typeof x === "string" && /^[a-zA-Z0-9_-]{1,128}$/.test(x);
const allowedStages: ReadonlySet<unknown> = new Set<Stage>(["intent", "pending", "committing", "ready", "retiring", "ended"]);

function bad(): never { throw new EpEnvelopeError("failed-precondition", "linked lifecycle authority has an invalid stored record"); }
function closed(raw: unknown, keys: string[], optional: string[] = []): Record<string, unknown> {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return bad();
  const row = raw as Record<string, unknown>;
  if (!keys.every(k => Object.hasOwn(row, k)) || Object.keys(row).some(k => !keys.includes(k) && !optional.includes(k))) return bad();
  return row;
}
const refFields = ["v", "owner", "actor", "lifecycleUid", "agentUid", "linkOperationId", "mode"];
const coordinateFields = ["accountPublicKey", "space"];
const commitFields = ["at", "credentialId", "generation", "processEpoch"];
function checkRef(o: Record<string, unknown>): void {
  if (o.v !== 1 || !hex(o.linkOperationId, 32) || (o.mode !== "create" && o.mode !== "select")) return bad();
  if (typeof o.owner !== "string" || typeof o.actor !== "string" || typeof o.lifecycleUid !== "string" || typeof o.agentUid !== "string") return bad();
  try { assertDerivedOwnerToken(o.owner); assertValidOwnerToken(o.actor); assertLifecycleToken(o.lifecycleUid); agentIdentityKey(o.agentUid); } catch { bad(); }
}
function checkCoordinates(o: Record<string, unknown>): void {
  if (!isAccountNkey(o.accountPublicKey) || typeof o.space !== "string") return bad();
  try { spacePrefix(o.space); } catch { bad(); }
}
function checkCommit(o: Record<string, unknown>): void {
  if (!pos(o.at) || !pos(o.generation) || !pos(o.processEpoch) || typeof o.credentialId !== "string") return bad();
  try { assertLifecycleToken(o.credentialId); } catch { bad(); }
}
export function parseLinkRef(value: unknown): LinkRef {
  const row = closed(value, refFields); checkRef(row);
  return row as unknown as LinkRef;
}
export function parseBinding(value: unknown): LinkedBinding {
  const row = closed(value, [...refFields, ...coordinateFields, ...commitFields]);
  checkRef(row); checkCoordinates(row); checkCommit(row);
  return row as unknown as LinkedBinding;
}
export function assertLinkedPermissions(input: Pick<LinkedGrantInput, "scope" | "allowSubscribe" | "allowPublish">): void {
  const concrete = (value: unknown): boolean => {
    if (typeof value !== "string" || !isConcreteChannel(value)) return false;
    try { return assertValidChannel(value) === value; } catch { return false; }
  };
  const channels = (v: unknown) => Array.isArray(v) && v.length <= 32 && new Set(v).size === v.length &&
    v.every(concrete);
  if (!Array.isArray(input.scope) || input.scope.length !== 0 || !channels(input.allowSubscribe) || !channels(input.allowPublish))
    throw new EpEnvelopeError("bad-request", "linked foreground grants require empty scope and concrete channel ACLs");
}
export function parseLinkedJournal(value: unknown): LinkedJournal {
  const o = closed(value, [...refFields, ...coordinateFields, "requestId", "approvalId", "stage", "admittedAt",
    "expectedIdentityRevision", "identityCommitted", "tokenHash", "scope", "allowSubscribe", "allowPublish", "commit", "end"], ["eventPayloads"]);
  checkRef(o); checkCoordinates(o);
  if ((o.mode !== "create" && o.mode !== "select") || !stringToken(o.requestId) || !hex(o.approvalId, 64) || !hex(o.tokenHash, 64) ||
      !allowedStages.has(o.stage) || !pos(o.admittedAt) || !nat(o.expectedIdentityRevision) ||
      (o.mode === "create") !== (o.expectedIdentityRevision === 0) || typeof o.identityCommitted !== "boolean" ||
      (Object.hasOwn(o, "eventPayloads") && o.eventPayloads !== false)) return bad();
  if ((o.stage === "ready" && !o.identityCommitted) ||
      ((o.stage === "ready" || o.stage === "committing" || o.identityCommitted) && o.commit === null) ||
      ((o.stage === "pending" || o.stage === "intent") && (o.commit !== null || o.identityCommitted))) return bad();
  if (o.commit !== null) checkCommit(closed(o.commit, commitFields));
  if ((o.stage === "retiring" || o.stage === "ended") !== (o.end !== null)) return bad();
  if (o.end !== null) {
    const end = closed(o.end, ["at", "by"]);
    if (!pos(end.at) || (end.by !== "owner" && end.by !== "recovery")) return bad();
  }
  try { assertLinkedPermissions(o as LinkedJournal); } catch { bad(); }
  return o as unknown as LinkedJournal;
}
export function parseLinkedEnable(value: unknown, expected: LinkedCoordinates): boolean {
  const o = closed(value, ["v", ...coordinateFields, "enabled"]); checkCoordinates(o);
  if (o.v !== 1 || o.accountPublicKey !== expected.accountPublicKey || o.space !== expected.space || typeof o.enabled !== "boolean") return bad();
  return o.enabled;
}
export function decodeLinkedRecord(data: Uint8Array): unknown {
  try { return JSON.parse(dec.decode(data)); } catch { return bad(); }
}
export function sameLinkedValue(a: unknown, b: unknown): boolean { return canonicalJson(a) === canonicalJson(b); }
export async function linkedRead<T>(kv: KV, key: string, parse: (raw: unknown) => T): Promise<Snapshot<T> | undefined> {
  const e = await kv.get(key);
  if (!e) return undefined;
  if (e.operation !== "PUT") return bad();
  return { row: parse(decodeLinkedRecord(e.value)), revision: e.revision };
}
export async function linkedWrite<T>(kv: KV, key: string, row: T, revision: number): Promise<Snapshot<T>> {
  const data = enc.encode(canonicalJson(row));
  try { return { row, revision: revision === 0 ? await kv.put(key, data, { previousSeq: 0 }) : await kv.update(key, data, revision) }; }
  catch (e) {
    if (isCasLoss(e)) throw new EpEnvelopeError("conflict", "linked lifecycle authority moved; retry using the exact lifecycle");
    throw new EpEnvelopeError("unavailable", "linked lifecycle authority write outcome is unknown");
  }
}
export async function immutableLinkedWrite<T>(kv: KV, key: string, row: T): Promise<Snapshot<T>> {
  const prior = await linkedRead(kv, key, raw => raw);
  if (!prior) return linkedWrite(kv, key, row, 0);
  if (!sameLinkedValue(prior.row, row)) return bad();
  return { row, revision: prior.revision };
}
