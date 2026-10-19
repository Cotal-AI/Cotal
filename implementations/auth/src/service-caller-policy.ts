import {
  EpEnvelopeError, SERVICE_AUTHORITY_MAX_BYTES, assertBoundedOwner, assertDerivedOwnerToken,
  assertLifecycleToken, canonicalJson, endpointToken, isAccountNkey, isCasLoss, isContractDigest,
  parseEndpointCapabilities, spacePrefix, type ServicePrincipal,
} from "@cotal-ai/core";
import { registryStores, type LifecycleRegistry } from "./lifecycle-registry.js";
import type { ServiceCallerGrant, ServiceGrantRef, ServiceGrantSource, ServiceGrantState, ServiceParentRef } from "./service-host-contract.js";

export interface ServiceCallerPolicyBinding {
  accountPublicKey: string;
  space: string;
  grantee: ServicePrincipal;
}
export interface NativeServiceCallerPolicy extends ServiceCallerPolicyBinding {
  v: 1;
  grants: ServiceCallerGrant[];
}
export interface NativeServiceCallerPolicyRead { row: NativeServiceCallerPolicy; revision: number }
const enc = new TextEncoder(), dec = new TextDecoder("utf-8", { fatal: true });
const compare = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;
function bad(): never { throw new EpEnvelopeError("bad-request", "invalid native service caller policy"); }
function conflict(message: string): never { throw new EpEnvelopeError("conflict", message); }
function object(raw: unknown, fields: readonly string[]): Record<string, unknown> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) bad();
  const proto = Object.getPrototypeOf(raw);
  if (proto !== Object.prototype && proto !== null) bad();
  if (fields.some((k) => !Object.hasOwn(raw, k)) || Reflect.ownKeys(raw).some((k) => typeof k !== "string" || !fields.includes(k))) bad();
  return raw as Record<string, unknown>;
}
function id(raw: unknown): string {
  if (typeof raw !== "string" || !/^[0-9a-f]{32}$/.test(raw)) bad();
  return raw;
}
function uint(raw: unknown, positive = false): number {
  if (typeof raw !== "number" || !Number.isSafeInteger(raw) || raw < (positive ? 1 : 0)) bad();
  return raw;
}
function digest(raw: unknown): string { if (typeof raw !== "string" || !isContractDigest(raw)) bad(); return raw; }
function lifecycle(raw: unknown): string { if (typeof raw !== "string") bad(); return assertLifecycleToken(raw, "policy lifecycle"); }
function principal(raw: unknown): ServicePrincipal {
  const o = object(raw, ["owner", "actor", "lifecycleUid"]);
  if (typeof o.owner !== "string" || typeof o.actor !== "string") bad();
  return { owner: assertDerivedOwnerToken(o.owner), actor: assertBoundedOwner(o.actor, "policy actor"), lifecycleUid: lifecycle(o.lifecycleUid) };
}
function refs(raw: unknown): ServiceGrantRef[] {
  if (!Array.isArray(raw) || raw.length === 0) bad();
  const seen = new Set<string>();
  const result = raw.map((r) => {
    const o = object(r, ["granteeUid", "grantId"]), ref = { granteeUid: lifecycle(o.granteeUid), grantId: id(o.grantId) };
    const key = canonicalJson(ref); if (seen.has(key)) bad(); seen.add(key); return ref;
  });
  return result.sort((a, b) => compare(canonicalJson(a), canonicalJson(b)));
}
function source(raw: unknown): ServiceGrantSource {
  const kind = raw && typeof raw === "object" ? (raw as Record<string, unknown>).kind : undefined;
  if (kind === "service-owner") {
    const o = object(raw, ["kind", "owner", "approvalDigest", "nameAuthorityRevision"]);
    if (typeof o.owner !== "string") bad();
    return { kind, owner: assertDerivedOwnerToken(o.owner), approvalDigest: digest(o.approvalDigest), nameAuthorityRevision: uint(o.nameAuthorityRevision, true) };
  }
  if (kind === "delegated") {
    const o = object(raw, ["kind", "principal", "grants"]), holder = principal(o.principal), grants = refs(o.grants);
    if (grants.some((g) => g.granteeUid !== holder.lifecycleUid)) bad();
    return { kind, principal: holder, grants };
  }
  return bad();
}
function state(raw: unknown): ServiceGrantState {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) bad();
  const s = raw as Record<string, unknown>;
  if (s.state === "active") { object(s, ["state"]); return { state: "active" }; }
  if (s.state === "revoking" && s.phase === "cutoff-required") {
    object(s, ["state", "operationId", "phase"]);
    return { state: "revoking", operationId: id(s.operationId), phase: "cutoff-required" };
  }
  if (s.state === "revoking") {
    object(s, ["state", "operationId", "markerKey", "markerRevision", "notBefore"]);
    if (typeof s.markerKey !== "string" || !/^[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)*$/.test(s.markerKey) || s.markerKey.length > 512) bad();
    return { state: "revoking", operationId: id(s.operationId), markerKey: s.markerKey,
      markerRevision: uint(s.markerRevision, true), notBefore: uint(s.notBefore, true) };
  }
  if (s.state === "revoked") {
    object(s, ["state", "operationId", "verifiedAt"]);
    return { state: "revoked", operationId: id(s.operationId), verifiedAt: uint(s.verifiedAt, true) };
  }
  return bad();
}
function grant(raw: unknown): ServiceCallerGrant {
  const o = object(raw, ["grantId", "endpoint", "instanceId", "serviceApprovalDigest", "capabilities", "source", "parentRefs", "status"]);
  if (typeof o.endpoint !== "string" || !Array.isArray(o.parentRefs)) bad();
  endpointToken(o.endpoint);
  const seen = new Set<string>();
  const parents: ServiceParentRef[] = o.parentRefs.map((p) => {
    const ref = object(p, ["principal", "grants"]), holder = principal(ref.principal), grants = refs(ref.grants);
    if (seen.has(holder.lifecycleUid) || grants.some((g) => g.granteeUid !== holder.lifecycleUid)) bad();
    seen.add(holder.lifecycleUid); return { principal: holder, grants };
  });
  parents.sort((a, b) => compare(a.principal.lifecycleUid, b.principal.lifecycleUid));
  const capabilities = parseEndpointCapabilities(o.capabilities), provenance = source(o.source), approvalDigest = digest(o.serviceApprovalDigest);
  if (capabilities.some((c) => c.endpoint !== o.endpoint) || (provenance.kind === "service-owner" && provenance.approvalDigest !== approvalDigest)) bad();
  return { grantId: id(o.grantId), endpoint: o.endpoint, instanceId: lifecycle(o.instanceId), serviceApprovalDigest: approvalDigest,
    capabilities, source: provenance, parentRefs: parents, status: state(o.status) };
}

/** Stored syntax only. Eligibility, ancestry and native capability containment are host checks. */
export function parseNativeServiceCallerPolicy(raw: unknown): NativeServiceCallerPolicy {
  const o = object(raw, ["v", "accountPublicKey", "space", "grantee", "grants"]);
  if (o.v !== 1 || typeof o.accountPublicKey !== "string" || !isAccountNkey(o.accountPublicKey)
    || typeof o.space !== "string" || !Array.isArray(o.grants)) bad();
  spacePrefix(o.space);
  if (Buffer.byteLength(canonicalJson(o), "utf8") > SERVICE_AUTHORITY_MAX_BYTES)
    throw new EpEnvelopeError("resource-exhausted", "native service caller policy exceeds its byte bound");
  const grantee = principal(o.grantee), seen = new Set<string>();
  const grants = o.grants.map((g) => {
    const parsed = grant(g); if (seen.has(parsed.grantId)) bad(); seen.add(parsed.grantId); return parsed;
  });
  return { v: 1, accountPublicKey: o.accountPublicKey, space: o.space, grantee, grants };
}
function context(reg: LifecycleRegistry, binding: ServiceCallerPolicyBinding) {
  const stores = registryStores(reg);
  const expected = parseNativeServiceCallerPolicy({ v: 1, ...binding, grants: [] });
  if (stores.space !== expected.space) throw new EpEnvelopeError("permission-denied", "caller policy belongs to another registry space");
  return { kv: stores.authKv, key: `servicepolicy.${expected.grantee.lifecycleUid}`, expected };
}

/** Internal leader-served read. Deleted or corrupt records are not an absent/empty policy. */
export async function readNativeServiceCallerPolicy(reg: LifecycleRegistry, binding: ServiceCallerPolicyBinding): Promise<NativeServiceCallerPolicyRead | undefined> {
  const { kv, key, expected } = context(reg, binding), entry = await kv.get(key);
  if (!entry) return undefined;
  if (entry.operation !== "PUT") throw new EpEnvelopeError("failed-precondition", "native caller policy carries a deletion marker");
  const row = parseNativeServiceCallerPolicy(JSON.parse(dec.decode(entry.value)));
  if (row.accountPublicKey !== expected.accountPublicKey || row.space !== expected.space || canonicalJson(row.grantee) !== canonicalJson(expected.grantee))
    conflict("native caller policy belongs to another immutable grantee binding");
  return { row, revision: entry.revision };
}
async function write(reg: LifecycleRegistry, binding: ServiceCallerPolicyBinding, row: NativeServiceCallerPolicy, revision: number): Promise<NativeServiceCallerPolicyRead> {
  const { kv, key } = context(reg, binding), parsed = parseNativeServiceCallerPolicy(row), bytes = enc.encode(canonicalJson(parsed));
  try { return { row: parsed, revision: revision === 0 ? await kv.put(key, bytes, { previousSeq: 0 }) : await kv.update(key, bytes, revision) }; }
  catch (error) {
    if (isCasLoss(error)) conflict("native caller policy changed; re-read before another mutation");
    throw new EpEnvelopeError("unavailable", "native caller policy write outcome is unknown; retain the operation identity");
  }
}

/** Storage commit only, after trusted host eligibility checks. Never replaces an existing grant. */
export async function appendNativeServiceCallerGrant(reg: LifecycleRegistry, binding: ServiceCallerPolicyBinding, args: {
  expectedRevision: number; grant: ServiceCallerGrant;
}): Promise<NativeServiceCallerPolicyRead> {
  const revision = uint(args.expectedRevision);
  const { accountPublicKey, space, grantee } = context(reg, binding).expected;
  binding = { accountPublicKey, space, grantee };
  const candidate = parseNativeServiceCallerPolicy({ v: 1, ...binding, grants: [args.grant] }).grants[0]!;
  if (candidate.status.state !== "active") bad();
  const found = await readNativeServiceCallerPolicy(reg, binding), existing = found?.row.grants.find((g) => g.grantId === candidate.grantId);
  if (existing) {
    if (canonicalJson(existing) !== canonicalJson(candidate)) conflict("grant id is immutable and cannot be rebound or reactivated");
    return found!;
  }
  if ((found?.revision ?? 0) !== revision) conflict("native caller policy revision changed");
  const row = found?.row ?? context(reg, binding).expected;
  return write(reg, binding, { ...row, grants: [...row.grants, candidate] }, revision);
}

/** Monotonic deny-new intent only. Cutoff, descendant invalidation and live retirement remain host work. */
export async function beginNativeServiceCallerRevocation(reg: LifecycleRegistry, binding: ServiceCallerPolicyBinding, args: {
  expectedRevision: number; grantId: string; operationId: string;
}): Promise<NativeServiceCallerPolicyRead> {
  const revision = uint(args.expectedRevision), grantId = id(args.grantId), operationId = id(args.operationId);
  const { accountPublicKey, space, grantee } = context(reg, binding).expected;
  binding = { accountPublicKey, space, grantee };
  const found = await readNativeServiceCallerPolicy(reg, binding);
  if (!found) throw new EpEnvelopeError("not-found", "native caller policy is absent");
  const existing = found.row.grants.find((g) => g.grantId === grantId);
  if (!existing) throw new EpEnvelopeError("not-found", "native caller grant is absent");
  if (existing.status.state !== "active") {
    if (existing.status.operationId !== operationId) conflict("caller grant is already bound to another revocation operation");
    return found;
  }
  if (found.revision !== revision) conflict("native caller policy revision changed");
  return write(reg, binding, { ...found.row, grants: found.row.grants.map((g) => g.grantId === grantId
    ? { ...g, status: { state: "revoking", operationId, phase: "cutoff-required" } } : g) }, found.revision);
}
