import type { KV } from "@nats-io/kv";
import { EpEnvelopeError, lifecycleBlocked } from "./endpoint-error.js";
import { isCasLoss } from "./endpoint-records.js";
import { assertLifecycleToken, endpointToken } from "./endpoint-subjects.js";
import { epgateKey, parseEndpointGate } from "./lifecycle-state.js";
import { isUserNkey } from "./identity.js";
import { mintLifecycleUid, parsePrincipalKey } from "./subjects.js";

/** A definite lease refusal, distinct from an unconfirmed store write. */
export class EndpointRegistrationLeaseRefused extends EpEnvelopeError {}

/** Host-owned exclusion for one registration attempt, independent of its executor connection. */
export interface EndpointRegistrationLease {
  v: 1;
  leaseId: string;
  requestId: string;
  principal: string;
  executorNkey: string;
  lifecycleUid: string;
  generation: number;
  registrationRevision: number;
  expiresAt: number;
  state: "active" | "recovering" | "released";
  freezeToken?: number;
}

/** Disjoint auth-store family. Participants can read it but cannot write or renew it directly. */
export function epRegistrationLeaseKey(endpoint: string, instanceId: string): string {
  return `epreg.${endpointToken(endpoint)}.${assertLifecycleToken(instanceId, "instanceId")}`;
}

const enc = new TextEncoder();

/** Read the closed durable lease. Tombstones and malformed state fail closed. */
export async function readEndpointRegistrationLease(kv: KV, endpoint: string, instanceId: string): Promise<{ lease: EndpointRegistrationLease; revision: number } | null> {
  const key = epRegistrationLeaseKey(endpoint, instanceId);
  const entry = await kv.get(key);
  if (!entry) return null;
  if (entry.operation !== "PUT") throw new EndpointRegistrationLeaseRefused("failed-precondition", `registration lease ${key} was deleted`);
  let value: unknown;
  try { value = JSON.parse(new TextDecoder().decode(entry.value)); }
  catch { throw new EndpointRegistrationLeaseRefused("internal", `registration lease ${key} is malformed`); }
  const row = value as EndpointRegistrationLease;
  const keys = ["v", "leaseId", "requestId", "principal", "executorNkey", "lifecycleUid", "generation", "registrationRevision", "expiresAt", "state", "freezeToken"];
  if (!row || typeof row !== "object" || Array.isArray(row) || Object.keys(row).some(k => !keys.includes(k)) || row.v !== 1
    || typeof row.requestId !== "string" || row.requestId.length === 0 || row.requestId.length > 128
    || typeof row.principal !== "string" || !parsePrincipalKey(row.principal) || !isUserNkey(row.executorNkey)
    || !Number.isSafeInteger(row.generation) || row.generation < 0 || !Number.isSafeInteger(row.expiresAt) || row.expiresAt <= 0
    || !Number.isSafeInteger(row.registrationRevision) || row.registrationRevision < 0
    || !["active", "recovering", "released"].includes(row.state)
    || (row.state === "recovering" ? !Number.isSafeInteger(row.freezeToken) || row.freezeToken! <= 0 : row.freezeToken !== undefined))
    throw new EndpointRegistrationLeaseRefused("internal", `registration lease ${key} does not validate`);
  try {
    assertLifecycleToken(row.leaseId, "registration leaseId");
    assertLifecycleToken(row.lifecycleUid, "registration lease lifecycleUid");
  } catch { throw new EndpointRegistrationLeaseRefused("internal", `registration lease ${key} does not validate`); }
  return { lease: row, revision: entry.revision };
}

async function gateAt(kv: KV, endpoint: string, instanceId: string) {
  const key = epgateKey(endpoint, instanceId);
  const entry = await kv.get(key);
  if (!entry || entry.operation !== "PUT") throw new EpEnvelopeError("failed-precondition", `no live endpoint gate at ${key}`);
  return { row: parseEndpointGate(entry.value, key), revision: entry.revision };
}

/** Acquire or renew only through trusted host authority. The expiry must outlive every executor
 * JWT released under this lease, so recovery cannot race an old executor reconnect after expiry. */
export async function renewEndpointRegistrationLease(kv: KV, args: {
  endpoint: string; instanceId: string; principal: string; executorNkey: string; lifecycleUid: string;
  requestId: string; leaseId?: string; expiresAt: number;
}): Promise<EndpointRegistrationLease> {
  if (!Number.isSafeInteger(args.expiresAt) || args.expiresAt <= Date.now() || !isUserNkey(args.executorNkey))
    throw new EpEnvelopeError("bad-request", "registration lease requires a future expiry and executor nkey");
  assertLifecycleToken(args.lifecycleUid, "registration lease lifecycleUid");
  for (let attempt = 0; attempt < 4; attempt++) {
    const gate = await gateAt(kv, args.endpoint, args.instanceId);
    if (gate.row.principal !== args.principal || gate.row.state === "retired"
      || (gate.row.state === "frozen" && gate.row.op.kind !== "registration"))
      throw new EpEnvelopeError("conflict", "registration lease does not match the current endpoint gate");
    const stored = await readEndpointRegistrationLease(kv, args.endpoint, args.instanceId);
    const prior = stored?.lease;
    const retry = prior?.requestId === args.requestId && prior.principal === args.principal
      && prior.executorNkey === args.executorNkey && prior.lifecycleUid === args.lifecycleUid;
    const renewing = args.leaseId !== undefined || retry;
    let lease: EndpointRegistrationLease;
    if (renewing) {
      if (!prior || prior.leaseId !== (args.leaseId ?? prior.leaseId) || prior.state !== "active" || prior.expiresAt <= Date.now()
        || prior.principal !== args.principal || prior.executorNkey !== args.executorNkey || prior.lifecycleUid !== args.lifecycleUid
        || (gate.row.generation !== prior.generation && !(gate.row.state === "open" && gate.row.generation === prior.generation + 1)))
        throw new EpEnvelopeError("conflict", "registration lease expired, was claimed for recovery, or belongs to another attempt");
      lease = { ...prior, expiresAt: Math.max(prior.expiresAt, args.expiresAt),
        // A definite pre-publication abort reopens unchanged coordinates. It is still this attempt.
        generation: gate.row.state === "open" && gate.row.registrationRevision === prior.registrationRevision
          ? gate.row.generation : prior.generation };
    } else {
      if (gate.row.state === "frozen" && (!prior || prior.state === "released" || prior.expiresAt <= Date.now()))
        throw lifecycleBlocked("conflict", "registration requires guarded recovery before a new host lease can be acquired", {
          blockedOp: "registration", gateState: "frozen", opId: gate.row.op.opId, remedy: "cotal reconcile-gate",
        });
      if (gate.row.state !== "open" || (prior && prior.state !== "released"
        && !((prior.state === "recovering" && gate.row.generation > prior.generation)
          || (prior.state === "active" && prior.expiresAt <= Date.now()))))
        throw new EpEnvelopeError("conflict", "registration already holds a host lease or requires frozen-gate recovery");
      lease = { v: 1, leaseId: mintLifecycleUid(), requestId: args.requestId, principal: args.principal,
        executorNkey: args.executorNkey, lifecycleUid: args.lifecycleUid, generation: gate.row.generation,
        registrationRevision: gate.row.registrationRevision,
        expiresAt: args.expiresAt, state: "active" };
    }
    const key = epRegistrationLeaseKey(args.endpoint, args.instanceId);
    try {
      if (stored) await kv.update(key, enc.encode(JSON.stringify(lease)), stored.revision);
      else await kv.put(key, enc.encode(JSON.stringify(lease)), { previousSeq: 0 });
      // A gate movement cannot silently bind the new lease to a different registration.
      const current = await gateAt(kv, args.endpoint, args.instanceId);
      if (current.row.principal !== lease.principal || current.row.state === "retired" || current.row.generation !== gate.row.generation)
        throw new EpEnvelopeError("conflict", "endpoint gate moved during registration lease issuance");
      return lease;
    } catch (error) { if (!isCasLoss(error)) throw error; }
  }
  throw new EpEnvelopeError("conflict", "registration lease kept losing its host CAS");
}

/** Claim an expired lease before any repair effect. Renewal and recovery contend on the same CAS.
 * A claim is durable until the frozen gate advances, including across a host crash. */
export async function claimEndpointRegistrationRecovery(kv: KV, args: {
  endpoint: string; instanceId: string; principal: string; generation: number; freezeToken: number;
}): Promise<"unleased" | "claimed" | "active"> {
  for (let attempt = 0; attempt < 4; attempt++) {
    const stored = await readEndpointRegistrationLease(kv, args.endpoint, args.instanceId);
    if (!stored || stored.lease.state === "released") return "unleased";
    const lease = stored.lease;
    if (lease.state === "active" && lease.expiresAt > Date.now()) return "active";
    if (lease.generation < args.generation) return "unleased";
    if (lease.generation !== args.generation || lease.principal !== args.principal)
      throw new EndpointRegistrationLeaseRefused("conflict", "registration recovery lease does not bind the frozen gate");
    if (lease.state === "recovering") {
      if (lease.freezeToken !== args.freezeToken) throw new EndpointRegistrationLeaseRefused("conflict", "registration recovery lease binds another freeze");
      return "claimed";
    }
    try {
      await kv.update(epRegistrationLeaseKey(args.endpoint, args.instanceId), enc.encode(JSON.stringify({ ...lease,
        state: "recovering", freezeToken: args.freezeToken })), stored.revision);
      return "claimed";
    } catch (error) { if (!isCasLoss(error)) throw error; }
  }
  throw new EndpointRegistrationLeaseRefused("conflict", "registration recovery lost its lease CAS");
}

/** Activation releases only the same attempt after its registration advanced the gate. */
export async function releaseEndpointRegistrationLease(kv: KV, args: {
  endpoint: string; instanceId: string; principal: string; executorNkey: string; lifecycleUid: string;
}): Promise<void> {
  for (let attempt = 0; attempt < 4; attempt++) {
    const stored = await readEndpointRegistrationLease(kv, args.endpoint, args.instanceId);
    if (!stored) return; // Legacy, unleased registrations remain activatable.
    const lease = stored.lease;
    const gate = await gateAt(kv, args.endpoint, args.instanceId);
    if (lease.principal !== args.principal || lease.executorNkey !== args.executorNkey || lease.lifecycleUid !== args.lifecycleUid
      || gate.row.state !== "open" || gate.row.generation !== lease.generation + 1 || gate.row.principal !== args.principal
      || gate.row.registrationRevision <= lease.registrationRevision
      || lease.state === "recovering" || (lease.state === "active" && lease.expiresAt <= Date.now()))
      throw new EpEnvelopeError("conflict", "activation does not hold the completed registration lease");
    if (lease.state === "released") return;
    try {
      await kv.update(epRegistrationLeaseKey(args.endpoint, args.instanceId), enc.encode(JSON.stringify({ ...lease, state: "released" })), stored.revision);
      return;
    } catch (error) { if (!isCasLoss(error)) throw error; }
  }
  throw new EpEnvelopeError("conflict", "registration activation lost its lease CAS");
}
