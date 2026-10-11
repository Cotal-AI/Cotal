import type { KV } from "@nats-io/kv";
import { canonicalJson, contractDigest } from "./canonical.js";
import { EpEnvelopeError } from "./endpoint-envelope.js";
import { endpointToken, assertLifecycleToken } from "./endpoint-subjects.js";
import { isCasLoss } from "./endpoint-records.js";
const enc = new TextEncoder(), dec = new TextDecoder();
export interface EndpointPolicyHead { v: 2; endpoint: string; policyRevision: number; state: "open" | "held" | "revoking"; operation?: { id: string; digest: string } }
function parse(value: Uint8Array, endpoint: string): EndpointPolicyHead {
  const row = JSON.parse(dec.decode(value)) as EndpointPolicyHead;
  if (!row || row.v !== 2 || row.endpoint !== endpoint || !Number.isSafeInteger(row.policyRevision) || row.policyRevision < 1 || !["open", "held", "revoking"].includes(row.state)
    || Object.keys(row).some(k => !["v", "endpoint", "policyRevision", "state", "operation"].includes(k))) throw new EpEnvelopeError("failed-precondition", "endpoint policy head does not validate");
  if (row.state === "open" ? row.operation !== undefined : !row.operation) throw new EpEnvelopeError("failed-precondition", "policy operation binding disagrees with state");
  if (row.operation) {
    assertLifecycleToken(row.operation.id, "policy operationId");
    if (!/^sha256:[a-f0-9]{64}$/.test(row.operation.digest) || Object.keys(row.operation).length !== 2) throw new EpEnvelopeError("failed-precondition", "invalid policy operation intent");
  }
  return row;
}
export function endpointPolicyKey(endpoint: string): string { return `endpoint-policy.${endpointToken(endpoint)}`; }
export async function provisionEndpointPolicyHead(kv: KV, endpoint: string, policyRevision: number): Promise<void> {
  const key = endpointPolicyKey(endpoint), row: EndpointPolicyHead = { v: 2, endpoint, policyRevision, state: "open" };
  const bytes = enc.encode(canonicalJson(row)); parse(bytes, endpoint);
  try { await kv.create(key, bytes); } catch (e) {
    if (!isCasLoss(e)) throw e;
    const existing = await kv.get(key);
    if (!existing || existing.operation !== "PUT" || dec.decode(existing.value) !== dec.decode(bytes)) throw new EpEnvelopeError("conflict", "endpoint policy already exists with another state");
  }
}
export interface EndpointPolicyHold {
  readonly endpoint: string;
  readonly operationId: string;
  readonly digest: string;
  readonly policyRevision: number;
  release(): Promise<void>;
}
const HOLDS = new WeakMap<EndpointPolicyHold, { active: boolean; endpoint: string; policyRevision: number }>();
export function assertEndpointPolicyHold(value: EndpointPolicyHold | undefined, endpoint: string, policyRevision: number): void {
  const held = value && HOLDS.get(value);
  if (!held || !held.active || held.endpoint !== endpoint || held.policyRevision !== policyRevision)
    throw new EpEnvelopeError("permission-denied", "delegated operation requires its live native policy-head hold before instance fencing");
}
/** Trusted issuer primitive. All barriers and material release acquire this BEFORE instance CAS.
 * Ambiguous work retains its operation. Only identical durable operation content may resume. */
export async function acquireEndpointPolicyHold(kv: KV, args: { endpoint: string; policyRevision: number; operationId: string; content: unknown; reconcileHeld?: true }): Promise<EndpointPolicyHold> {
  const key = endpointPolicyKey(args.endpoint), operationId = assertLifecycleToken(args.operationId, "operationId"), digest = contractDigest(args.content);
  const entry = await kv.get(key);
  if (!entry || entry.operation !== "PUT") throw new EpEnvelopeError("failed-precondition", "endpoint policy head is absent or deleted");
  const row = parse(entry.value, args.endpoint);
  if (row.policyRevision !== args.policyRevision || row.state === "revoking") throw new EpEnvelopeError("permission-denied", "endpoint policy changed or is revoking");
  if (row.state === "held" && (row.operation!.id !== operationId || row.operation!.digest !== digest)) throw new EpEnvelopeError("conflict", "another durable endpoint policy operation holds release");
  if (row.state === "held" && !args.reconcileHeld) throw new EpEnvelopeError("conflict", "held endpoint operation needs authenticated single-writer reconciliation, never an overlapping retry");
  let revision = entry.revision;
  if (row.state === "open") {
    try { revision = await kv.update(key, enc.encode(canonicalJson({ ...row, state: "held", operation: { id: operationId, digest } })), entry.revision); }
    catch (e) { if (isCasLoss(e)) throw new EpEnvelopeError("conflict", "endpoint policy acquisition CAS lost"); throw e; }
  }
  let released = false;
  const state = { active: true, endpoint: args.endpoint, policyRevision: row.policyRevision };
  const hold: EndpointPolicyHold = Object.freeze({ endpoint: args.endpoint, operationId, digest, policyRevision: row.policyRevision,
    async release() {
      if (released) return;
      const current = await kv.get(key);
      if (!current || current.operation !== "PUT" || current.revision !== revision) throw new EpEnvelopeError("conflict", "endpoint policy release lost its durable operation fence");
      const head = parse(current.value, args.endpoint);
      if (head.state !== "held" || head.operation!.id !== operationId || head.operation!.digest !== digest || head.policyRevision !== row.policyRevision) throw new EpEnvelopeError("conflict", "endpoint policy release coordinates changed");
      await kv.update(key, enc.encode(canonicalJson({ v: 2, endpoint: head.endpoint, policyRevision: head.policyRevision, state: "open" })), revision);
      released = true;
      state.active = false;
    },
  });
  HOLDS.set(hold, state);
  return hold;
}
