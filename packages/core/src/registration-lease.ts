import type { KV } from "@nats-io/kv";
import { EpEnvelopeError } from "./endpoint-error.js";
import { assertLifecycleToken, endpointToken } from "./endpoint-subjects.js";
import { assertHolderPrincipal, epgateKey, parseEndpointGate } from "./lifecycle-state.js";
import { isCasLoss } from "./endpoint-records.js";

/** Host time bound, longer than the five-minute registration executor credential. */
export const REGISTRATION_LEASE_MS = 360_000;
export const REGISTRATION_LEASE_RENEW_MS = 30_000;

export interface RegistrationLease {
  v: 1;
  id: string;
  principal: string;
  state: "active" | "released" | "reconciling";
  until: number;
  /** Recovery owns this exact frozen gate revision once it claims an expired lease. */
  freezeToken?: number;
}

export function registrationLeaseKey(endpoint: string, instanceId: string): string {
  return `epreglease.${endpointToken(endpoint)}.${assertLifecycleToken(instanceId)}`;
}

/** Never-reused registration attempt reservation, written only by the host issuer. */
export function registrationLeaseIdKey(endpoint: string, instanceId: string, id: string): string {
  return `epregid.${endpointToken(endpoint)}.${assertLifecycleToken(instanceId)}.${assertLifecycleToken(id)}`;
}

export function parseRegistrationLease(raw: Uint8Array, key: string): RegistrationLease {
  let value: unknown;
  try { value = JSON.parse(new TextDecoder().decode(raw)); }
  catch { throw new EpEnvelopeError("failed-precondition", `invalid registration lease at ${key}`); }
  const row = value as RegistrationLease;
  if (!row || typeof row !== "object" || Array.isArray(row)
    || Object.keys(row).some(k => !["v", "id", "principal", "state", "until", "freezeToken"].includes(k))
    || row.v !== 1 || !["active", "released", "reconciling"].includes(row.state)
    || !Number.isSafeInteger(row.until) || row.until <= 0
    || (row.state === "reconciling" ? !Number.isSafeInteger(row.freezeToken) || row.freezeToken! < 1 : row.freezeToken !== undefined))
    throw new EpEnvelopeError("failed-precondition", `invalid registration lease at ${key}`);
  assertLifecycleToken(row.id, "registration lease id");
  assertHolderPrincipal(row.principal, "registration lease principal");
  return row;
}

async function readLease(kv: KV, key: string) {
  const entry = await kv.get(key);
  if (!entry) return null;
  if (entry.operation !== "PUT") throw new EpEnvelopeError("failed-precondition", `registration lease ${key} was deleted`);
  return { row: parseRegistrationLease(entry.value, key), revision: entry.revision };
}
const encode = (row: RegistrationLease) => new TextEncoder().encode(JSON.stringify(row));

/** Host-only acquire/renew. Expiry is terminal for an id, even before recovery claims it. */
export async function renewRegistrationLease(kv: KV, args: {
  endpoint: string; instanceId: string; principal: string; id: string; acquire: boolean;
}): Promise<RegistrationLease> {
  const key = registrationLeaseKey(args.endpoint, args.instanceId);
  assertLifecycleToken(args.id, "registration lease id");
  assertHolderPrincipal(args.principal, "registration lease principal");
  let reserved = false;
  for (let attempt = 0; attempt < 4; attempt++) {
    const current = await readLease(kv, key);
    const now = Date.now();
    if (current && current.row.principal !== args.principal)
      throw new EpEnvelopeError("permission-denied", "registration lease belongs to another principal");
    if (current?.row.id === args.id) {
      if (current.row.state !== "active" || current.row.until <= now)
        throw new EpEnvelopeError("conflict", "registration lease expired or was fenced by recovery; this registration cannot resume");
    } else {
      let recovered = false;
      if (args.acquire && current && (current.row.state === "reconciling" || (current.row.state === "active" && current.row.until <= now))) {
        const gateKey = epgateKey(args.endpoint, args.instanceId), gate = await kv.get(gateKey);
        recovered = gate === null ? current.row.state === "active"
          : gate.operation === "PUT" && (current.row.state !== "reconciling" || gate.revision > current.row.freezeToken!)
            && parseEndpointGate(gate.value, gateKey).state === "open";
      }
      if (!args.acquire || (current && current.row.state !== "released" && !recovered))
        throw new EpEnvelopeError("conflict", "registration lease is held by another operation; reconcile an abandoned registration first");
      if (!reserved) {
        try {
          await kv.put(registrationLeaseIdKey(args.endpoint, args.instanceId, args.id), new TextEncoder().encode(args.principal), { previousSeq: 0 });
          reserved = true;
        } catch (error) {
          if (isCasLoss(error)) throw new EpEnvelopeError("conflict", "registration lease id has already been used; an ended registration cannot acquire again");
          throw error;
        }
      }
    }
    const row: RegistrationLease = { v: 1, id: args.id, principal: args.principal, state: "active", until: now + REGISTRATION_LEASE_MS };
    try {
      await kv.put(key, encode(row), { previousSeq: current?.revision ?? 0 });
      return row;
    } catch (error) { if (!isCasLoss(error)) throw error; }
  }
  throw new EpEnvelopeError("conflict", "registration lease renewal lost its compare-and-set");
}

/** Release only after the participant has closed its registration executor and settled its work. */
export async function releaseRegistrationLease(kv: KV, args: {
  endpoint: string; instanceId: string; principal: string; id: string;
}): Promise<RegistrationLease> {
  const key = registrationLeaseKey(args.endpoint, args.instanceId);
  for (let attempt = 0; attempt < 4; attempt++) {
    const current = await readLease(kv, key);
    if (!current || current.row.id !== args.id || current.row.principal !== args.principal || current.row.state === "reconciling")
      throw new EpEnvelopeError("conflict", "registration lease release no longer owns the operation");
    if (current.row.state === "released") return current.row;
    const row: RegistrationLease = { ...current.row, state: "released" };
    try { await kv.update(key, encode(row), current.revision); return row; }
    catch (error) { if (!isCasLoss(error)) throw error; }
  }
  throw new EpEnvelopeError("conflict", "registration lease release lost its compare-and-set");
}

/** Claim before any repair mutation. This CAS excludes a racing host renewal on the same key. */
export async function claimRegistrationRecovery(kv: KV, args: {
  endpoint: string; instanceId: string; principal: string; freezeToken: number; required?: boolean;
}): Promise<"claimed" | "live" | "raced" | "absent"> {
  const key = registrationLeaseKey(args.endpoint, args.instanceId);
  const current = await readLease(kv, key);
  if (!current) {
    if (args.required) throw new EpEnvelopeError("failed-precondition", "remote registration has no host-owned lease");
    return "absent";
  }
  if (current.row.principal !== args.principal)
    throw new EpEnvelopeError("failed-precondition", "registration lease principal disagrees with the frozen gate");
  if (current.row.state === "reconciling")
    return current.row.freezeToken === args.freezeToken ? "claimed" : "raced";
  if (current.row.state === "active" && current.row.until > Date.now()) return "live";
  try {
    await kv.update(key, encode({ ...current.row, state: "reconciling", freezeToken: args.freezeToken }), current.revision);
    return "claimed";
  } catch (error) { if (isCasLoss(error)) return "raced"; throw error; }
}

/** Mark the repair complete without releasing a foreign or later claim. */
export async function finishRegistrationRecovery(kv: KV, args: {
  endpoint: string; instanceId: string; freezeToken: number;
}): Promise<void> {
  const key = registrationLeaseKey(args.endpoint, args.instanceId);
  const current = await readLease(kv, key);
  if (!current) throw new EpEnvelopeError("failed-precondition", "registration recovery lease disappeared before completion");
  if (current.row.state !== "reconciling" || current.row.freezeToken !== args.freezeToken)
    throw new EpEnvelopeError("conflict", "registration recovery lost its lease claim");
  const { freezeToken: _freezeToken, ...row } = current.row;
  await kv.update(key, encode({ ...row, state: "released" }), current.revision);
}
