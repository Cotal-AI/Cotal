import {
  agentIdentityKey, assertDerivedOwnerToken, canonicalJson, EpEnvelopeError, isAccountNkey, SERVICE_AUTHORITY_MAX_BYTES, spacePrefix,
} from "@cotal-ai/core";
import { registryStores, type LifecycleRegistry } from "./lifecycle-registry.js";
import type { ServiceCallerGrant } from "./service-host-contract.js";
import { parseServiceCallerGrant } from "./service-caller-policy.js";

interface StablePolicyBinding { accountPublicKey: string; space: string; owner: string; agentUid: string }
interface StableServiceCallerPolicy extends StablePolicyBinding { v: 1; grants: ServiceCallerGrant[] }
const decoder = new TextDecoder("utf-8", { fatal: true });

export function stableServicePolicyKey(agentUid: string): string {
  return `servicepolicy.${agentIdentityKey(agentUid).slice("agentid.".length)}`;
}

/** Closed storage format for trusted isolated composition. Ancestry is derived at mint. */
export function parseStableServiceCallerPolicy(raw: unknown): StableServiceCallerPolicy {
  const bad = (): never => { throw new EpEnvelopeError("failed-precondition", "invalid stable service caller policy"); };
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return bad();
  const fields = ["v", "accountPublicKey", "space", "owner", "agentUid", "grants"];
  if ((Object.getPrototypeOf(raw) !== Object.prototype && Object.getPrototypeOf(raw) !== null)
    || Reflect.ownKeys(raw).length !== fields.length || !fields.every(key => Object.hasOwn(raw, key))) return bad();
  const { v, accountPublicKey, space, owner, agentUid, grants } = raw as Record<string, unknown>;
  if (v !== 1 || typeof accountPublicKey !== "string" || !isAccountNkey(accountPublicKey)
    || typeof space !== "string" || typeof owner !== "string" || typeof agentUid !== "string" || !Array.isArray(grants)) return bad();
  spacePrefix(space);
  assertDerivedOwnerToken(owner);
  stableServicePolicyKey(agentUid);
  if (Buffer.byteLength(canonicalJson(raw), "utf8") > SERVICE_AUTHORITY_MAX_BYTES)
    throw new EpEnvelopeError("resource-exhausted", "stable service caller policy exceeds its byte bound");
  const parsed = grants.map(parseServiceCallerGrant);
  if (parsed.some(g => g.parentRefs.length || g.source.kind !== "service-owner"
    || g.capabilities.some(c => c.instanceId !== g.instanceId || c.instanceOnly !== true
      || c.journal || c.target?.mode === "any" || c.target?.mode === "ledger"))
    || new Set(parsed.map(g => g.grantId)).size !== parsed.length) return bad();
  return { v, accountPublicKey, space, owner, agentUid, grants: parsed };
}

export async function readStableServiceCallerPolicy(registry: LifecycleRegistry, binding: StablePolicyBinding) {
  const { space, authKv } = registryStores(registry);
  if (space !== binding.space) throw new EpEnvelopeError("permission-denied", "stable caller policy belongs to another registry space");
  const entry = await authKv.get(stableServicePolicyKey(binding.agentUid));
  if (!entry) return undefined;
  if (entry.operation !== "PUT") throw new EpEnvelopeError("failed-precondition", "stable caller policy carries a deletion marker");
  const row = parseStableServiceCallerPolicy(JSON.parse(decoder.decode(entry.value)));
  if (row.accountPublicKey !== binding.accountPublicKey || row.space !== binding.space
    || row.owner !== binding.owner || row.agentUid !== binding.agentUid)
    throw new EpEnvelopeError("conflict", "stable caller policy belongs to another immutable agent binding");
  return { row, revision: entry.revision };
}
