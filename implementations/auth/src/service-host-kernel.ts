/** The S2-A record kernel shared by the service host families: record keys and ids, the keyed
 *  reads and writes, capacity release, operation settlement and debt, and the result arms. */
import { createHash } from "node:crypto";
import { assertLifecycleToken, canonicalJson, contractDigest, endpointToken, type ContractStoreContext, type EpCapability } from "@cotal-ai/core";
import { SERVICE_HOST_INVOCATION_MS } from "./authority-client.js";
import { readNativeServiceName } from "./native-service-name.js";
import { encodeRoundTrip } from "./service-custody-shapes.js";
import { type ServiceDenyNew, type ServiceHostDebt, type ServiceHostReason, type ServiceNameView, type ServiceOperationRefusal } from "./service-host-contract.js";
import { Held, bounded, held, leader, message, write, type Ctx, type HostInternals, type ServiceCustodyHost, type ServiceWriteScope } from "./service-write.js";
import { hexN, parseServiceHostOperationRecord, parseServiceProposalRecord, parseServiceCapacityRecord, parseServiceAssignmentRecord, parseServiceRequestIntentRecord, parseServiceRequestIntentIndexRecord, parseServiceAdmissionRecord, type Final, type Progress, type OpLive, type OpTerminal, type Op, type CapEntry, type Capacity } from "./service-host-records.js";

/** Original authority limit of one approve, refuse or register, from its admission. */
export const S2A_OPERATION_TTL_MS = 600_000;
/** Per-invocation limit for reads, bookkeeping, settlement and native cancellation, and the
 *  longest window an invocation's effect credential may cover. */
export const S2A_INVOCATION_MS = SERVICE_HOST_INVOCATION_MS;
/** A proposal's canonical lifetime (canon:203). */
export const S2A_PROPOSAL_LIFETIME_MS = 86_400_000;
export const S2A_MAX_PROPOSAL_BYTES = 256 * 1024;
/** Fresh decisions after a CAS loss before a step holds. */
export const S2A_MAX_REDECIDE = 4;

/** The space's service host admission row: `open` while the auth service admits service endpoints. */
export const ADMISSION_KEY = "svchost.admission";
export const CAPACITY_KEY = "svccap.space";
export const opKey = (operationId: string) => `svcop.${operationId}`;
export const proposalKey = (proposalId: string) => `svcprop.${proposalId}`;
export const assignmentKey = (endpoint: string, instanceId: string) => `svcasg.${endpointToken(endpoint)}.${assertLifecycleToken(instanceId, "instanceId")}`;
export const intentKey = (operationId: string) => `svcint.${hexN(operationId, 32)}`;
export const intentIndexKey = (endpoint: string, instanceId: string) => `svcintx.${endpointToken(endpoint)}.${assertLifecycleToken(instanceId, "instanceId")}`;
export const callerIndexKey = (endpoint: string, instanceId: string) => `svcpolx.${endpointToken(endpoint)}.${assertLifecycleToken(instanceId, "instanceId")}`;
export const cutoffKey = (operationId: string) => `svccut.${hexN(operationId, 32)}`;
export const seconds = (ms: number) => Math.floor(ms / 1000);

// ---- identities ---------------------------------------------------------------------------------

const hex32 = (tag: string, space: string, value: string) => createHash("sha256").update(`${tag}\0${space}\0${value}`, "utf8").digest("hex").slice(0, 32);
/** One id namespace for every host request in a space; a valid lifecycle token. */
export const serviceHostOperationId = (space: string, requestId: string) => hex32("cotal-service-host-op", space, requestId);
/** The native cancel identity an expiry settlement derives from recorded facts only. */
export const expiryOperationId = (space: string, approveOperationId: string) => hex32("cotal-service-host-expiry", space, approveOperationId);
/** A caller grant's id, from its operation: one grant per bound grant request, never reused. */
export const callerGrantId = (space: string, operationId: string) => hex32("cotal-service-caller-grant", space, operationId);
export const expiryRequestDigest = (operationId: string, assignmentDigest: string) =>
  contractDigest({ v: 1, kind: "service-approval-expiry", operationId, assignmentDigest });
export const proposalIdOf = (proposalDigest: string, registerRequestId: string) =>
  contractDigest({ v: 1, kind: "service-proposal-id", proposalDigest, registerRequestId }).slice("sha256:".length);
export const approvalDigestOf = (a: { proposalDigest: string; assignmentDigest: string; callerCeiling: EpCapability[]; approvalExpiresAt: number | null; nameAuthorityRevision: number; operationId: string }) =>
  contractDigest({ v: 1, kind: "service-approval", ...a });

// ---- keyed reads and writes ---------------------------------------------------------------------

export type Read<T> = { state: "absent" } | { state: "value"; row: T; bytes: Uint8Array; revision: number };

/** Leader-read one S2-A key. A deletion marker or spent tombstone holds under a key-specific
 *  reason and is never recreated; anything its closed parser refuses holds as malformed. */
export async function read<T>(ctx: Ctx, key: string, what: string, parse: (v: unknown) => T): Promise<Read<T>> {
  const cur = await leader(ctx, "auth", key);
  if (cur.state === "absent") return cur;
  if (cur.state === "marker") return held(`${what}-tombstone`, ctx.step, `${key} carries a ${cur.op} marker; a spent key is never recreated`);
  if (cur.state === "malformed") return held(`${what}-malformed`, ctx.step, `${key} is not JSON`);
  try { return { state: "value", row: parse(cur.value), bytes: cur.bytes, revision: cur.revision }; }
  catch (e) { return held(`${what}-malformed`, ctx.step, message(e)); }
}
export const readOp = (ctx: Ctx, id: string) => read(ctx, opKey(id), "operation", parseServiceHostOperationRecord);
export const readProposal = (ctx: Ctx, id: string) => read(ctx, proposalKey(id), "proposal", parseServiceProposalRecord);
export const readCapacity = (ctx: Ctx) => read(ctx, CAPACITY_KEY, "capacity", parseServiceCapacityRecord);
export const readAssignment = (ctx: Ctx, endpointName: string, instanceId: string) => read(ctx, assignmentKey(endpointName, instanceId), "assignment", parseServiceAssignmentRecord);
export const readAdmission = (ctx: Ctx) => read(ctx, ADMISSION_KEY, "admission", parseServiceAdmissionRecord);
export const readIntent = (ctx: Ctx, id: string) => read(ctx, intentKey(id), "intent", parseServiceRequestIntentRecord);
export const readIntentIndex = (ctx: Ctx, endpointName: string, instanceId: string) => read(ctx, intentIndexKey(endpointName, instanceId), "intent-index", parseServiceRequestIntentIndexRecord);

/** One zero-history create (no prior) or exact-revision CAS of a closed record. */
export function put<T>(ctx: Ctx, key: string, row: T, parse: (v: unknown) => T, prior?: { revision: number; bytes: Uint8Array }): Promise<number | "moved"> {
  return write(ctx, "auth", key, encodeRoundTrip(row, parse), prior ? { revision: prior.revision, preimage: prior.bytes } : { create: true });
}
const byProposal = (a: CapEntry, b: CapEntry) => (a.proposalId < b.proposalId ? -1 : a.proposalId > b.proposalId ? 1 : 0);
export const putCapacity = (ctx: Ctx, cap: Read<Capacity>, pending: CapEntry[]) =>
  put(ctx, CAPACITY_KEY, { v: 1, kind: "service-proposal-capacity", pending: [...pending].sort(byProposal) } satisfies Capacity, parseServiceCapacityRecord,
    cap.state === "value" ? cap : undefined);
export const isEntry = (proposalId: string, registerRequestId: string) => (e: CapEntry) => e.proposalId === proposalId && e.registerRequestId === registerRequestId;
/** Canonical expiry only: an entry past `expiresAtMs` is ineligible. No grace is temporal proof. */
export const eligible = (cap: Read<Capacity>, now: number) => (cap.state === "value" ? cap.row.pending.filter((e) => e.expiresAtMs > now) : []);

export async function nameOf(ctx: Ctx, endpointName: string): Promise<ServiceNameView | undefined> {
  const r = await bounded(ctx, () => readNativeServiceName(ctx.h.registry, { accountPublicKey: ctx.h.accountPublicKey, space: ctx.h.space }, endpointName));
  if (!r.ok) return held("unavailable", ctx.step, "timedOut" in r ? "the service name read timed out" : message(r.error));
  return r.value;
}

/** Remove one proposal's capacity entry. True only when a read or this CAS observed it gone; an
 *  unobserved release is debt, never success. */
export async function release(ctx: Ctx, proposalId: string, registerRequestId: string): Promise<boolean> {
  try {
    for (let i = 0; i < S2A_MAX_REDECIDE; i++) {
      const cap = await readCapacity(ctx);
      if (cap.state === "absent" || !cap.row.pending.some(isEntry(proposalId, registerRequestId))) return true;
      if ((await putCapacity(ctx, cap, cap.row.pending.filter((e) => !isEntry(proposalId, registerRequestId)(e)))) !== "moved") return true;
    }
    return false;
  } catch (e) {
    if (e instanceof Held && e.reason !== "readiness" && e.reason !== "post-write-readiness") return false;
    throw e;
  }
}

export const isFinal = (p: Progress): p is Final => p.state === "complete" || p.state === "refused" || p.state === "superseded";
export const sameDebt = (a: ServiceHostDebt[], b: ServiceHostDebt[]) => canonicalJson(a) === canonicalJson(b);

/** Re-read and CAS the live operation until `next` is durable or reports nothing to change. A
 *  terminal record is returned as stored. */
export async function updateOp(ctx: Ctx, operationId: string, next: (op: OpLive) => OpLive | undefined): Promise<{ op: Op; wrote: boolean }> {
  for (let i = 0; i < S2A_MAX_REDECIDE; i++) {
    const cur = await readOp(ctx, operationId);
    if (cur.state === "absent") return held("reference-unavailable", ctx.step, "the operation binding is not readable");
    if (cur.row.kind !== "service-host-operation") return { op: cur.row, wrote: false };
    const n = next(cur.row);
    if (n === undefined) return { op: cur.row, wrote: false };
    if ((await put(ctx, opKey(operationId), n, parseServiceHostOperationRecord, cur)) !== "moved") return { op: n, wrote: true };
  }
  return held("contention", ctx.step);
}

/** Record an outcome (a stored one wins), keep any debt, then compact once no debt remains.
 *  `wrote` is whether this invocation recorded the outcome. */
export async function settle(ctx: Ctx, operationId: string, outcome: Final | undefined, debts: ServiceHostDebt[]): Promise<{ op: Op; wrote: boolean }> {
  const step = await updateOp(ctx, operationId, (cur) => {
    const progress = isFinal(cur.progress) ? cur.progress : outcome;
    if (progress === undefined || (progress === cur.progress && sameDebt(cur.debt, debts))) return undefined;
    return { ...cur, progress, debt: debts };
  });
  const wrote = step.wrote && step.op.kind === "service-host-operation" && outcome !== undefined && step.op.progress === outcome;
  if (step.op.kind !== "service-host-operation" || !isFinal(step.op.progress) || step.op.debt.length) return { op: step.op, wrote };
  for (let i = 0; i < S2A_MAX_REDECIDE; i++) {
    const cur = await readOp(ctx, operationId);
    if (cur.state === "absent") return held("reference-unavailable", ctx.step, "the operation binding is not readable");
    if (cur.row.kind !== "service-host-operation") return { op: cur.row, wrote };
    const live = cur.row;
    if (!isFinal(live.progress) || live.debt.length) return { op: live, wrote };
    const terminal: OpTerminal = { v: 1, kind: "service-host-operation-terminal", operationId: live.operationId, requestId: live.requestId,
      requestDigest: live.requestDigest, operation: live.operation, account: live.account, granter: live.granter, admittedAtMs: live.admittedAtMs,
      projection: live.projection, outcome: live.progress };
    if ((await put(ctx, opKey(operationId), terminal, parseServiceHostOperationRecord, cur)) !== "moved") return { op: terminal, wrote };
  }
  return held("contention", ctx.step);
}
export const outcomeOf = (op: Op): Final | undefined => (op.kind === "service-host-operation-terminal" ? op.outcome : isFinal(op.progress) ? op.progress : undefined);
export const debtOf = (op: Op) => (op.kind === "service-host-operation" ? op.debt : []);

/** Retry recorded capacity debt; returns the debt that remains. */
export async function retryDebt(ctx: Ctx, op: Op, registerRequestIdOf: (proposalId: string) => Promise<string | undefined>): Promise<ServiceHostDebt[]> {
  const left: ServiceHostDebt[] = [];
  for (const d of debtOf(op)) {
    const reg = await registerRequestIdOf(d.proposalId);
    if (d.kind !== "capacity-release" || reg === undefined || !(await release(ctx, d.proposalId, reg))) left.push(d);
  }
  return left;
}

export type Arms =
  | { state: "pending"; operationId: string; phase: string; notBefore?: number; assignmentDigest?: string; denyNew?: ServiceDenyNew; root?: "none" | "revoked" | "retained-stamped"; debt?: ServiceHostDebt[] }
  | { state: "held"; operationId: string; reason: string; phase: string; assignmentDigest?: string; denyNew?: ServiceDenyNew; debt?: ServiceHostDebt[] }
  | { state: "refused"; operationId: string; reason: ServiceOperationRefusal; boundOperationId?: string; debt?: ServiceHostDebt[] }
  | { state: "denied"; reason: ServiceHostReason; boundOperationId?: string };

export interface Inv { host: ServiceCustodyHost; h: HostInternals; writes: ServiceWriteScope; endMs: number; operationId: string; bound: boolean; assignmentDigest?: string; contract?: ContractStoreContext }
export const denied = (reason: ServiceHostReason, boundOperationId?: string): Arms => ({ state: "denied", reason, ...(boundOperationId ? { boundOperationId } : {}) });
const refusedArm = (operationId: string, reason: ServiceOperationRefusal, debts: ServiceHostDebt[], boundOperationId?: string): Arms =>
  ({ state: "refused", operationId, reason, ...(boundOperationId ? { boundOperationId } : {}), ...(debts.length ? { debt: debts } : {}) });
export const finalArm = (operationId: string, f: Exclude<Final, { state: "complete" }>, debts: ServiceHostDebt[]): Arms =>
  f.state === "refused" ? refusedArm(operationId, f.reason, debts) : refusedArm(operationId, "superseded", debts, f.boundOperationId);

export type Live<T> = Extract<Read<T>, { state: "value" }>;
