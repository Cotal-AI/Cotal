import {
  AUTH_ENDPOINT, BASELINE_DELIVERY_ENDPOINT, BASELINE_LIFECYCLE_ENDPOINT, EpEnvelopeError,
  assertDerivedOwnerToken, contractDigest, createRowByteIdempotent, endpointToken, isAccountNkey,
  isContractDigest, spacePrefix, type ServiceNameAuthority,
} from "@cotal-ai/core";
import { registryStores, type LifecycleRegistry } from "./lifecycle-registry.js";
import { parseServiceHostRequest, type ServiceHostRequest, type ServiceNameView } from "./service-host-contract.js";

interface NameContext { accountPublicKey: string; space: string }
interface NameRow extends NameContext {
  v: 1;
  kind: "service-name";
  endpoint: string;
  owner: string;
  claimReference: string;
  requestId: string;
  requestDigest: string;
}
const reserved = new Set([AUTH_ENDPOINT, BASELINE_DELIVERY_ENDPOINT, BASELINE_LIFECYCLE_ENDPOINT]);
const decoder = new TextDecoder("utf-8", { fatal: true });
function nameKey(endpoint: string): string {
  const token = endpointToken(endpoint);
  if (reserved.has(endpoint)) throw new EpEnvelopeError("permission-denied", "native control endpoint names cannot be service bindings");
  return `servicename.${token}`;
}
function context(reg: LifecycleRegistry, expected: NameContext): NameContext {
  const stores = registryStores(reg);
  if (typeof expected.accountPublicKey !== "string" || !isAccountNkey(expected.accountPublicKey)
    || typeof expected.space !== "string" || stores.space !== expected.space)
    throw new EpEnvelopeError("permission-denied", "service name context does not bind this native registry");
  spacePrefix(expected.space);
  return { accountPublicKey: expected.accountPublicKey, space: expected.space };
}
function parseRow(bytes: Uint8Array): NameRow {
  const raw: unknown = JSON.parse(decoder.decode(bytes));
  const fields = ["v", "kind", "accountPublicKey", "space", "endpoint", "owner", "claimReference", "requestId", "requestDigest"];
  if (!raw || typeof raw !== "object" || Array.isArray(raw) || fields.some((k) => !Object.hasOwn(raw, k))
    || Object.keys(raw).some((k) => !fields.includes(k)))
    throw new EpEnvelopeError("failed-precondition", "invalid native service name record");
  const row = raw as Record<string, unknown>;
  if (row.v !== 1 || row.kind !== "service-name" || typeof row.accountPublicKey !== "string" || !isAccountNkey(row.accountPublicKey)
    || typeof row.space !== "string" || typeof row.endpoint !== "string" || typeof row.owner !== "string"
    || typeof row.claimReference !== "string" || !row.claimReference || row.claimReference.length > 512 || /[\u0000-\u001f]/.test(row.claimReference)
    || typeof row.requestId !== "string" || !/^[0-9a-f]{32}$/.test(row.requestId)
    || typeof row.requestDigest !== "string" || !isContractDigest(row.requestDigest))
    throw new EpEnvelopeError("failed-precondition", "invalid native service name record");
  spacePrefix(row.space); nameKey(row.endpoint); assertDerivedOwnerToken(row.owner);
  return { v: 1, kind: "service-name", accountPublicKey: row.accountPublicKey, space: row.space,
    endpoint: row.endpoint, owner: row.owner, claimReference: row.claimReference, requestId: row.requestId, requestDigest: row.requestDigest };
}

/** One leader snapshot binds owner and revision. Missing is distinct from corrupt or deleted. */
export async function readNativeServiceName(reg: LifecycleRegistry, expected: NameContext, endpoint: string): Promise<ServiceNameView | undefined> {
  const binding = context(reg, expected), key = nameKey(endpoint);
  const entry = await registryStores(reg).authKv.get(key);
  if (!entry) return undefined;
  if (entry.operation !== "PUT") throw new EpEnvelopeError("failed-precondition", "native service name has deletion history");
  const row = parseRow(entry.value);
  if (row.accountPublicKey !== binding.accountPublicKey || row.space !== binding.space || row.endpoint !== endpoint)
    throw new EpEnvelopeError("conflict", "native service name belongs to another account, space or endpoint");
  return { endpoint: row.endpoint, owner: row.owner, claimReference: row.claimReference,
    requestId: row.requestId, requestDigest: row.requestDigest, revision: entry.revision };
}

/** Internal storage after host authentication and claim verification. No transfer or release exists. */
export async function bindNativeServiceName(reg: LifecycleRegistry, expected: NameContext,
  raw: Extract<ServiceHostRequest, { operation: "name-bind" }>): Promise<ServiceNameView> {
  const binding = context(reg, expected), request = parseServiceHostRequest(raw);
  if (request.operation !== "name-bind") throw new EpEnvelopeError("bad-request", "expected a service name binding request");
  if (request.input.expectedRevision !== 0)
    throw new EpEnvelopeError("failed-precondition", "service names are create-only; transfer and release are unsupported");
  const row: NameRow = { v: 1, kind: "service-name", ...binding, endpoint: request.input.endpoint, owner: request.input.owner,
    claimReference: request.input.claimReference, requestId: request.requestId, requestDigest: contractDigest(request) };
  await createRowByteIdempotent(registryStores(reg).authKv, nameKey(row.endpoint), row);
  const found = await readNativeServiceName(reg, binding, row.endpoint);
  if (!found || found.requestId !== row.requestId || found.requestDigest !== row.requestDigest
    || found.owner !== row.owner || found.claimReference !== row.claimReference)
    throw new EpEnvelopeError("unavailable", "service name write is not confirmed; retain its request identity");
  return found;
}

/** Application-service name decisions only. Native control endpoints retain their own authority. */
export function nativeServiceNameAuthority(reg: LifecycleRegistry, expected: NameContext): ServiceNameAuthority {
  const binding = context(reg, expected);
  return { authorize: async (endpoint, owner) => {
    const found = await readNativeServiceName(reg, binding, endpoint);
    return { authorized: found !== undefined && found.owner === owner, revision: found?.revision ?? 0 };
  } };
}
