import {
  EpEnvelopeError, assertLifecycleToken, createRowByteIdempotent, epgateKey, isCasLoss, parseEndpointCapabilities,
  parseEndpointGate, parseServiceRegistrationWitness, principalKey, serviceEndpointActor,
  serviceGateApprovalLive, type EndpointGateRow, type EpCapability, type ServiceGateAuthority,
  type ServiceRegistrationWitness,
} from "@cotal-ai/core";
import { credRowKey, parseLedgerRow } from "./credential-ledger.js";
import { readLifecycleHeadForOperation, registryStores, type LifecycleRegistry } from "./lifecycle-registry.js";

interface ServiceAssignmentBinding {
  accountPublicKey: string;
  space: string;
  owner: string;
  endpoint: string;
  instanceId: string;
  lifecycleUid: string;
  assignmentDigest: string;
}
type ServiceRow = EndpointGateRow & { authorityFamily: "service"; serviceAuthority: ServiceGateAuthority };
interface ServiceGateRead { row: ServiceRow; revision: number }
const enc = new TextEncoder();
const bytes = (row: EndpointGateRow) => enc.encode(JSON.stringify(row));
const conflict = (message: string): never => { throw new EpEnvelopeError("conflict", message); };

function coordinates(reg: LifecycleRegistry, binding: ServiceAssignmentBinding) {
  const stores = registryStores(reg);
  if (stores.space !== binding.space) throw new EpEnvelopeError("permission-denied", "service assignment belongs to another space");
  const actor = serviceEndpointActor(binding);
  return { kv: stores.authKv, key: epgateKey(binding.endpoint, binding.instanceId), actor, principal: principalKey(binding.owner, actor).key };
}

/** Internal host storage seam. Consent and name authority are not established by a gate write. */
export async function readNativeServiceGate(reg: LifecycleRegistry, binding: ServiceAssignmentBinding): Promise<ServiceGateRead | undefined> {
  const { kv, key, principal } = coordinates(reg, binding);
  const entry = await kv.get(key);
  if (!entry) return undefined;
  if (entry.operation !== "PUT") throw new EpEnvelopeError("failed-precondition", "service gate is deleted; absence cannot be inferred from a tombstone");
  const row = parseEndpointGate(entry.value, key);
  if (row.authorityFamily !== "service" || !row.serviceAuthority || row.principal !== principal
    || row.serviceAuthority.assignmentDigest !== binding.assignmentDigest || row.serviceAuthority.lifecycleUid !== binding.lifecycleUid)
    conflict("service gate belongs to another immutable assignment");
  return { row: row as ServiceRow, revision: entry.revision };
}

function pendingRow(reg: LifecycleRegistry, binding: ServiceAssignmentBinding): ServiceRow {
  const { key, principal } = coordinates(reg, binding);
  const row: ServiceRow = {
    state: "open", generation: 0, processEpoch: 0, registrationRevision: 0, nameAuthorityRevision: 0,
    principal, authorityFamily: "service", serviceAuthority: {
      v: 1, assignmentDigest: binding.assignmentDigest, lifecycleUid: binding.lifecycleUid,
      state: "pending-root", rootCredentialId: null, rootExpiresAt: null, approvalDigest: null,
      approvalExpiresAt: null, callerCeiling: [], activationIssued: false,
    },
  };
  parseEndpointGate(bytes(row), key);
  return row;
}

/** Create the unmintable endpoint gate before native root activation. Never adopts a different assignment. */
export async function createPendingServiceGate(reg: LifecycleRegistry, binding: ServiceAssignmentBinding): Promise<ServiceGateRead> {
  const { kv, key } = coordinates(reg, binding);
  await createRowByteIdempotent(kv, key, pendingRow(reg, binding));
  const created = await readNativeServiceGate(reg, binding);
  if (!created) throw new EpEnvelopeError("unavailable", "created service gate is not readable; retain the operation identity");
  return created;
}

async function current(reg: LifecycleRegistry, binding: ServiceAssignmentBinding, expectedRevision: number): Promise<ServiceGateRead> {
  const found = await readNativeServiceGate(reg, binding);
  if (!found || found.revision !== expectedRevision) conflict("service gate revision changed");
  return found!;
}

async function replace(reg: LifecycleRegistry, binding: ServiceAssignmentBinding, before: ServiceGateRead, row: ServiceRow): Promise<ServiceGateRead> {
  const { kv, key } = coordinates(reg, binding);
  const encoded = bytes(row);
  parseEndpointGate(encoded, key);
  try { return { row, revision: await kv.update(key, encoded, before.revision) }; }
  catch (error) {
    if (isCasLoss(error)) conflict("service gate changed before its transition committed");
    throw new EpEnvelopeError("unavailable", "service gate transition outcome is unknown; retain the operation identity");
  }
}

async function rootExpiry(reg: LifecycleRegistry, binding: ServiceAssignmentBinding, rootCredentialId: string, nowMs: number): Promise<number> {
  const { kv, actor, principal } = coordinates(reg, binding);
  const head = await readLifecycleHeadForOperation(reg, binding.owner, actor);
  if (!head || head.mapping.state !== "active" || head.mapping.lifecycleUid !== binding.lifecycleUid
    || head.mapping.currentCredentialId !== rootCredentialId)
    throw new EpEnvelopeError("permission-denied", "service native root is not current");
  const key = credRowKey(binding.lifecycleUid, rootCredentialId);
  const entry = await kv.get(key);
  if (!entry || entry.operation !== "PUT") throw new EpEnvelopeError("permission-denied", "service native root has no durable credential");
  const row = parseLedgerRow(entry.value, key);
  if (row.state !== "active" || row.lifecycleUid !== binding.lifecycleUid || row.holderPrincipal !== principal
    || row.sourceChain.length !== 1 || row.sourceChain[0] !== "root" || row.exp <= nowMs)
    throw new EpEnvelopeError("permission-denied", "service native root credential is not live");
  return Math.floor(row.exp / 1000);
}

/** Final approval CAS. The host must first verify the proposal, owner consent and operator target policy. */
export async function approveNativeServiceGate(reg: LifecycleRegistry, binding: ServiceAssignmentBinding, args: {
  expectedRevision: number; rootCredentialId: string; approvalDigest: string; nameAuthorityRevision: number;
  approvalExpiresAt: number | null; callerCeiling: EpCapability[];
}): Promise<ServiceGateRead> {
  const found = await current(reg, binding, args.expectedRevision);
  if (found.row.state !== "open" || found.row.serviceAuthority.state !== "pending-root")
    conflict("only the pending root assignment can receive its first approval");
  if (!Number.isSafeInteger(args.nameAuthorityRevision) || args.nameAuthorityRevision <= 0)
    throw new EpEnvelopeError("failed-precondition", "service approval requires its native name binding revision");
  const now = Date.now();
  const authority: ServiceGateAuthority = {
    ...found.row.serviceAuthority, state: "approved", rootCredentialId: args.rootCredentialId,
    rootExpiresAt: await rootExpiry(reg, binding, args.rootCredentialId, now), approvalDigest: args.approvalDigest,
    approvalExpiresAt: args.approvalExpiresAt, callerCeiling: parseEndpointCapabilities(args.callerCeiling),
  };
  if (!serviceGateApprovalLive(authority, Math.floor(now / 1000)))
    throw new EpEnvelopeError("expired", "service approval has already expired");
  return replace(reg, binding, found, { ...found.row, nameAuthorityRevision: args.nameAuthorityRevision, serviceAuthority: authority });
}

/** The host withholds both access and renewal material until this monotonic activation CAS wins. */
export async function markNativeServiceActivated(reg: LifecycleRegistry, binding: ServiceAssignmentBinding, args: {
  expectedRevision: number; witness: ServiceRegistrationWitness;
}): Promise<ServiceGateRead> {
  const witness = parseServiceRegistrationWitness(args.witness);
  const found = await current(reg, binding, args.expectedRevision), row = found.row, authority = row.serviceAuthority;
  const { actor } = coordinates(reg, binding);
  if (witness.accountPublicKey !== binding.accountPublicKey || witness.space !== binding.space
    || witness.endpoint !== binding.endpoint || witness.instanceId !== binding.instanceId
    || witness.principal.owner !== binding.owner || witness.principal.actor !== actor
    || witness.principal.lifecycleUid !== binding.lifecycleUid || witness.rootCredentialId !== authority.rootCredentialId
    || witness.approvalDigest !== authority.approvalDigest || witness.processEpoch !== row.processEpoch
    || witness.registrationRevision !== row.registrationRevision || witness.nameAuthorityRevision !== row.nameAuthorityRevision
    || !authority.registration || witness.registrationRequestId !== authority.registration.requestId || witness.registrationProof !== authority.registration.registrationProof)
    conflict("activation witness does not match the current service registration");
  const now = Date.now();
  if (row.state !== "open" || !serviceGateApprovalLive(authority, Math.floor(now / 1000)))
    throw new EpEnvelopeError("expired", "service approval no longer permits activation");
  await rootExpiry(reg, binding, witness.rootCredentialId, now);
  if (authority.activationIssued) return found;
  return replace(reg, binding, found, { ...row, serviceAuthority: { ...authority, activationIssued: true } });
}

/** Durable deny-new only. This is never a terminal retirement result or broker absence proof. */
export async function denyNativeServiceGate(reg: LifecycleRegistry, binding: ServiceAssignmentBinding, args: {
  expectedRevision: number; operationId: string;
}): Promise<ServiceGateRead> {
  assertLifecycleToken(args.operationId, "operationId");
  const found = await current(reg, binding, args.expectedRevision), row = found.row;
  if (row.serviceAuthority.state === "revoked") return found;
  const authority = { ...row.serviceAuthority, state: "revoked" as const };
  const next: ServiceRow = row.state === "open"
    ? { ...row, state: "frozen", op: { opId: args.operationId, kind: "retirement" }, serviceAuthority: authority }
    : { ...row, serviceAuthority: authority };
  return replace(reg, binding, found, next);
}

/** Fence cancellation before the endpoint gate exists. Native UID cancellation remains a separate required barrier. */
export async function fenceUncreatedServiceGate(reg: LifecycleRegistry, binding: ServiceAssignmentBinding, operationId: string): Promise<ServiceGateRead> {
  assertLifecycleToken(operationId, "operationId");
  const { kv, key } = coordinates(reg, binding), pending = pendingRow(reg, binding);
  const row: ServiceRow = { ...pending, state: "frozen", op: { opId: operationId, kind: "retirement" },
    serviceAuthority: { ...pending.serviceAuthority, state: "revoked" } };
  parseEndpointGate(bytes(row), key);
  await createRowByteIdempotent(kv, key, row);
  const created = await readNativeServiceGate(reg, binding);
  if (!created) throw new EpEnvelopeError("unavailable", "created service gate is not readable; retain the operation identity");
  return created;
}
