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
/** A grant's immutable fields as canonical JSON: everything but `status`, the one field that advances. */
export function immutableGrantView(g: ServiceCallerGrant): string {
  return canonicalJson({ grantId: g.grantId, endpoint: g.endpoint, instanceId: g.instanceId, serviceApprovalDigest: g.serviceApprovalDigest,
    capabilities: g.capabilities, source: g.source, parentRefs: g.parentRefs });
}

/** One stored grant's closed syntax, as a row holds it. */
export function parseServiceCallerGrant(raw: unknown): ServiceCallerGrant { return grant(raw); }
/** The auth-store key of one grantee's policy row. */
export function servicePolicyKey(granteeUid: string): string { return `servicepolicy.${lifecycle(granteeUid)}`; }

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
  return { kv: stores.authKv, key: servicePolicyKey(expected.grantee.lifecycleUid), expected };
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

const byteSize = (value: unknown) => Buffer.byteLength(canonicalJson(value), "utf8");
// Exact closed status syntax bounds. Reserve for all grants simultaneously, not just the
// newly appended grant or the first cutoff intent. No cap increase or old-row rewriting.
const maxStatusBytes = Math.max(...[
  { state: "active" },
  { state: "revoking", operationId: "f".repeat(32), phase: "cutoff-required" },
  { state: "revoking", operationId: "f".repeat(32), markerKey: "m".repeat(512),
    markerRevision: Number.MAX_SAFE_INTEGER, notBefore: Number.MAX_SAFE_INTEGER },
  { state: "revoked", operationId: "f".repeat(32), verifiedAt: Number.MAX_SAFE_INTEGER },
].map(byteSize));
/** Whether every grant of `row` could still take its largest status within the byte bound. */
export function callerPolicyHasRevocationHeadroom(row: NativeServiceCallerPolicy): boolean {
  const worstBytes = byteSize(row) + row.grants.reduce((sum, g) => sum + Math.max(0, maxStatusBytes - byteSize(g.status)), 0);
  return worstBytes <= SERVICE_AUTHORITY_MAX_BYTES;
}

// ---- pure steps ---------------------------------------------------------------------------------
// Each takes the row as one read found it (undefined when absent) and decides the next write. The
// storage helpers below and the service host both use them, so the rules live in one place.

/** Appending `candidate` (status active) at `expectedRevision`. An existing grant with the same id
 *  answers present whatever its status, because the comparison leaves out status, which only
 *  advances: a replay after deny-new adopts the row and never reactivates the grant. */
export type CallerAppendStep =
  | { kind: "present"; grant: ServiceCallerGrant }
  | { kind: "mismatch" }
  | { kind: "moved" }
  | { kind: "headroom" }
  | { kind: "write"; row: NativeServiceCallerPolicy };
export function callerAppendStep(found: NativeServiceCallerPolicyRead | undefined, empty: NativeServiceCallerPolicy, expectedRevision: number, candidate: ServiceCallerGrant): CallerAppendStep {
  const existing = found?.row.grants.find((g) => g.grantId === candidate.grantId);
  if (existing) return immutableGrantView(existing) === immutableGrantView(candidate) ? { kind: "present", grant: existing } : { kind: "mismatch" };
  if ((found?.revision ?? 0) !== expectedRevision) return { kind: "moved" };
  const row = found?.row ?? empty;
  const next = { ...row, grants: [...row.grants, candidate] };
  return callerPolicyHasRevocationHeadroom(next) ? { kind: "write", row: next } : { kind: "headroom" };
}

/** Deny-new: an active grant moves to `revoking` under `operationId` in phase `cutoff-required`. A
 *  grant already revoking or revoked names the operation that holds its intent. */
export type CallerBeginStep =
  | { kind: "absent" }
  | { kind: "held"; grant: ServiceCallerGrant; operationId: string }
  | { kind: "write"; row: NativeServiceCallerPolicy; grant: ServiceCallerGrant };
export function callerBeginStep(row: NativeServiceCallerPolicy | undefined, grantId: string, operationId: string): CallerBeginStep {
  const existing = row?.grants.find((g) => g.grantId === grantId);
  if (!row || !existing) return { kind: "absent" };
  if (existing.status.state !== "active") return { kind: "held", grant: existing, operationId: existing.status.operationId };
  const status: ServiceGrantState = { state: "revoking", operationId, phase: "cutoff-required" };
  return { kind: "write", row: { ...row, grants: row.grants.map((g) => (g.grantId === grantId ? { ...g, status } : g)) }, grant: { ...existing, status } };
}

/** The cutoff marker and its fixed deadline, on a grant whose deny-new intent `operationId` holds.
 *  The same marker again is a no-op; anything else is a conflict, so a recorded deadline is never
 *  reset. `notBefore` is in epoch seconds. */
export type CallerCutoffStep =
  | { kind: "absent" }
  | { kind: "same" }
  | { kind: "conflict"; detail: string }
  | { kind: "write"; row: NativeServiceCallerPolicy };
export function callerCutoffStep(row: NativeServiceCallerPolicy | undefined, grantId: string, marker: { operationId: string; markerKey: string; markerRevision: number; notBefore: number }): CallerCutoffStep {
  const existing = row?.grants.find((g) => g.grantId === grantId);
  if (!row || !existing) return { kind: "absent" };
  const next: ServiceGrantState = { state: "revoking", operationId: id(marker.operationId), markerKey: marker.markerKey,
    markerRevision: uint(marker.markerRevision, true), notBefore: uint(marker.notBefore, true) };
  const s = existing.status;
  if (s.state !== "revoking" || s.operationId !== next.operationId) return { kind: "conflict", detail: "caller grant is not under this revocation operation's deny-new intent" };
  if (!("phase" in s)) return canonicalJson(s) === canonicalJson(next) ? { kind: "same" } : { kind: "conflict", detail: "caller grant already records another cutoff marker" };
  return { kind: "write", row: { ...row, grants: row.grants.map((g) => (g.grantId === grantId ? { ...g, status: next } : g)) } };
}

// ---- storage helpers ----------------------------------------------------------------------------

/** Storage commit only, after trusted host eligibility checks. Never replaces an existing grant. */
export async function appendNativeServiceCallerGrant(reg: LifecycleRegistry, binding: ServiceCallerPolicyBinding, args: {
  expectedRevision: number; grant: ServiceCallerGrant;
}): Promise<NativeServiceCallerPolicyRead> {
  const revision = uint(args.expectedRevision);
  const { accountPublicKey, space, grantee } = context(reg, binding).expected;
  binding = { accountPublicKey, space, grantee };
  const candidate = parseNativeServiceCallerPolicy({ v: 1, ...binding, grants: [args.grant] }).grants[0]!;
  if (candidate.status.state !== "active") bad();
  const found = await readNativeServiceCallerPolicy(reg, binding);
  const step = callerAppendStep(found, context(reg, binding).expected, revision, candidate);
  if (step.kind === "present") return found!;
  if (step.kind === "mismatch") conflict("grant id is immutable and cannot be rebound");
  if (step.kind === "moved") conflict("native caller policy revision changed");
  if (step.kind === "headroom") throw new EpEnvelopeError("resource-exhausted", "native service caller policy lacks all-grant revocation status headroom");
  return write(reg, binding, (step as Extract<CallerAppendStep, { kind: "write" }>).row, revision);
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
  const step = callerBeginStep(found.row, grantId, operationId);
  if (step.kind === "absent") throw new EpEnvelopeError("not-found", "native caller grant is absent");
  if (step.kind === "held") {
    if (step.operationId !== operationId) conflict("caller grant is already bound to another revocation operation");
    return found;
  }
  if (found.revision !== revision) conflict("native caller policy revision changed");
  return write(reg, binding, step.row, found.revision);
}

/** The cutoff step after deny-new: records the op-bound marker and its fixed deadline on a grant
 *  whose intent this operation already holds. The same values again are a no-op. Other values,
 *  another operation's intent in either revoking form, an active grant or a revoked one are a
 *  conflict, so a recorded deadline is never reset. `notBefore` is in epoch seconds. */
export async function recordNativeServiceCallerCutoff(reg: LifecycleRegistry, binding: ServiceCallerPolicyBinding, args: {
  expectedRevision: number; grantId: string; operationId: string; markerKey: string; markerRevision: number; notBefore: number;
}): Promise<NativeServiceCallerPolicyRead> {
  const revision = uint(args.expectedRevision), grantId = id(args.grantId), operationId = id(args.operationId);
  const marker = { operationId, markerKey: args.markerKey, markerRevision: uint(args.markerRevision, true), notBefore: uint(args.notBefore, true) };
  const { accountPublicKey, space, grantee } = context(reg, binding).expected;
  binding = { accountPublicKey, space, grantee };
  const found = await readNativeServiceCallerPolicy(reg, binding);
  if (!found) throw new EpEnvelopeError("not-found", "native caller policy is absent");
  const step = callerCutoffStep(found.row, grantId, marker);
  if (step.kind === "absent") throw new EpEnvelopeError("not-found", "native caller grant is absent");
  if (step.kind === "conflict") conflict(step.detail);
  if (step.kind === "same") return found;
  if (found.revision !== revision) conflict("native caller policy revision changed");
  return write(reg, binding, (step as Extract<CallerCutoffStep, { kind: "write" }>).row, found.revision);
}
