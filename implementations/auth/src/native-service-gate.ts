import {
  EpEnvelopeError, SERVICE_ACCESS_TTL_SECONDS, assertLifecycleToken, createRowByteIdempotent, epgateKey, isCasLoss, parseEndpointCapabilities,
  parseEndpointGate, parseServiceRegistrationWitness, principalKey, serviceEndpointActor,
  serviceGateApprovalLive, type EndpointGateRow, type EpCapability, type ServiceGateAuthority,
  type ServiceRegistrationWitness,
} from "@cotal-ai/core";
import type { ConnectReader } from "./connect-reader.js";
import { readNativeServiceName } from "./native-service-name.js";
import type { ValidatedUserToken } from "./token.js";
import { registryStores, type LifecycleRegistry } from "./lifecycle-registry.js";
import { readConnectServiceRoot, readRegistryServiceRoot } from "./service-root-reader.js";

export interface ServiceAssignmentBinding {
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

function parseFor(binding: ServiceAssignmentBinding, key: string, principal: string, value: Uint8Array): ServiceRow {
  const row = parseEndpointGate(value, key);
  if (row.authorityFamily !== "service" || !row.serviceAuthority || row.principal !== principal
    || row.serviceAuthority.assignmentDigest !== binding.assignmentDigest || row.serviceAuthority.lifecycleUid !== binding.lifecycleUid)
    conflict("service gate belongs to another immutable assignment");
  return row as ServiceRow;
}

/** Internal host storage seam. Consent and name authority are not established by a gate write. */
export async function readNativeServiceGate(reg: LifecycleRegistry, binding: ServiceAssignmentBinding): Promise<ServiceGateRead | undefined> {
  const { kv, key, principal } = coordinates(reg, binding);
  const entry = await kv.get(key);
  if (!entry) return undefined;
  if (entry.operation !== "PUT") throw new EpEnvelopeError("failed-precondition", "service gate is deleted; absence cannot be inferred from a tombstone");
  return { row: parseFor(binding, key, principal, entry.value), revision: entry.revision };
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

function deniedRow(row: ServiceRow, operationId: string): ServiceRow | undefined {
  assertLifecycleToken(operationId, "operationId");
  if (row.serviceAuthority.state === "revoked") return undefined;
  const authority = { ...row.serviceAuthority, state: "revoked" as const };
  return row.state === "open"
    ? { ...row, state: "frozen", op: { opId: operationId, kind: "retirement" }, serviceAuthority: authority }
    : { ...row, serviceAuthority: authority };
}

function uncreatedFenceRow(reg: LifecycleRegistry, binding: ServiceAssignmentBinding, operationId: string): ServiceRow {
  assertLifecycleToken(operationId, "operationId");
  const { key } = coordinates(reg, binding), pending = pendingRow(reg, binding);
  const row: ServiceRow = { ...pending, state: "frozen", op: { opId: operationId, kind: "retirement" },
    serviceAuthority: { ...pending.serviceAuthority, state: "revoked" } };
  parseEndpointGate(bytes(row), key);
  return row;
}

/** Package-internal pure endpoint-gate rows for a writer that issues, bounds and re-checks every
 *  request itself. No I/O: the same rows and checks the helpers below write and read. */
export interface ServiceGateRows {
  readonly key: string;
  /** Parse bytes read at `key`; `conflict` when they belong to another immutable assignment. */
  parse(value: Uint8Array): ServiceRow;
  /** Bytes of the pending-root row that a zero-history create writes. */
  readonly pending: Uint8Array;
  /** Bytes of the frozen revoked row that a zero-history create writes before the gate exists. */
  uncreatedFence(operationId: string): Uint8Array;
  /** Bytes of the deny-new successor of `row`, or `undefined` when it is already revoked. */
  deny(row: ServiceRow, operationId: string): Uint8Array | undefined;
}

/** The pure endpoint-gate rows of one assignment in this registry's space. */
export function serviceGateRows(reg: LifecycleRegistry, binding: ServiceAssignmentBinding): ServiceGateRows {
  const { key, principal } = coordinates(reg, binding), frozenBinding = { ...binding };
  return Object.freeze({
    key, pending: bytes(pendingRow(reg, frozenBinding)),
    parse: (value: Uint8Array) => parseFor(frozenBinding, key, principal, value),
    uncreatedFence: (operationId: string) => bytes(uncreatedFenceRow(reg, frozenBinding, operationId)),
    deny: (row: ServiceRow, operationId: string) => {
      const next = deniedRow(row, operationId);
      if (next === undefined) return undefined;
      const encoded = bytes(next);
      parseEndpointGate(encoded, key);
      return encoded;
    },
  });
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
  return (await readRegistryServiceRoot(reg, binding, rootCredentialId, nowMs)).expiresAt;
}

/** Current native access prerequisites, not a serving grant or an issuance release fence.
 * The host supplies an already signature-validated token and fixes expiresAt before its first
 * authority read. Final issuance still needs a fresh check and the native serving gate CAS.
 */
export async function readNativeServiceAccess(reg: LifecycleRegistry, reader: ConnectReader,
  expected: ServiceAssignmentBinding, raw: ValidatedUserToken, expiresAt: number): Promise<{
    witness: ServiceRegistrationWitness; gateRevision: number; expiresAt: number;
  }> {
  const binding = { ...expected }, now = Math.floor(Date.now() / 1000);
  if (raw.act.view !== "service-endpoint" || raw.act.service?.duty !== "serve")
    throw new EpEnvelopeError("permission-denied", "native service access requires a validated service bearer");
  const witness = parseServiceRegistrationWitness(raw.act.service.witness);
  const token: ValidatedUserToken = { ...raw, scope: [...raw.scope], act: { ...raw.act,
    scope: raw.act.scope === undefined ? undefined : [...raw.act.scope], service: { duty: "serve", witness } } };
  const { actor } = coordinates(reg, binding);
  if (reader.space !== binding.space || token.space !== binding.space || token.owner !== binding.owner
    || token.act.owner !== binding.owner || token.act.actor !== actor || token.act.lifecycleUid !== binding.lifecycleUid
    || token.act.credentialId !== witness.rootCredentialId || token.credentialId !== witness.rootCredentialId
    || token.scope.length || token.act.scope?.length || witness.accountPublicKey !== binding.accountPublicKey
    || witness.space !== binding.space || witness.endpoint !== binding.endpoint || witness.instanceId !== binding.instanceId
    || witness.principal.owner !== binding.owner || witness.principal.actor !== actor || witness.principal.lifecycleUid !== binding.lifecycleUid)
    throw new EpEnvelopeError("permission-denied", "service bearer does not bind the native assignment");
  if (!Number.isSafeInteger(expiresAt) || !Number.isSafeInteger(token.exp) || expiresAt <= now
    || expiresAt > token.exp || expiresAt > now + SERVICE_ACCESS_TTL_SECONDS)
    throw new EpEnvelopeError("expired", "service access requires its original bounded expiry");
  // The native cred root and the endpoint's epcred issuance family are distinct authorities.
  const connectRoot = await readConnectServiceRoot(reader, binding, witness.rootCredentialId, Date.now());
  const rootExpiresAt = await rootExpiry(reg, binding, witness.rootCredentialId, Date.now());
  const found = await readNativeServiceGate(reg, binding);
  if (!found) throw new EpEnvelopeError("permission-denied", "service assignment has no native gate");
  const { row } = found, authority = row.serviceAuthority, stamp = authority.registration;
  if (row.state !== "open" || !authority.activationIssued || authority.pendingRegistration !== undefined
    || !serviceGateApprovalLive(authority, Math.floor(Date.now() / 1000)) || !stamp
    || authority.rootCredentialId !== witness.rootCredentialId || authority.approvalDigest !== witness.approvalDigest
    || row.processEpoch !== witness.processEpoch || row.registrationRevision !== witness.registrationRevision
    || row.nameAuthorityRevision !== witness.nameAuthorityRevision || stamp.processEpoch !== witness.processEpoch
    || stamp.registrationRevision !== witness.registrationRevision || stamp.nameAuthorityRevision !== witness.nameAuthorityRevision
    || stamp.requestId !== witness.registrationRequestId || stamp.registrationProof !== witness.registrationProof)
    throw new EpEnvelopeError("permission-denied", "service access does not match the current activated registration");
  if (expiresAt > connectRoot.expiresAt || expiresAt > rootExpiresAt || expiresAt > authority.rootExpiresAt!
    || (authority.approvalExpiresAt !== null && expiresAt > authority.approvalExpiresAt))
    throw new EpEnvelopeError("expired", "service access outlives its native root or approval");
  const name = await readNativeServiceName(reg, binding, binding.endpoint);
  if (!name || name.owner !== binding.owner || name.revision !== witness.nameAuthorityRevision)
    throw new EpEnvelopeError("permission-denied", "service access does not match the native name binding");
  const finalGate = await readNativeServiceGate(reg, binding);
  if (!finalGate || finalGate.revision !== found.revision)
    throw new EpEnvelopeError("conflict", "service authority changed during the access read");
  const finalRoot = await readConnectServiceRoot(reader, binding, witness.rootCredentialId, Date.now());
  if (finalRoot.uidRevision !== connectRoot.uidRevision || finalRoot.headRevision !== connectRoot.headRevision
    || finalRoot.gateRevision !== connectRoot.gateRevision || finalRoot.rootRevision !== connectRoot.rootRevision)
    throw new EpEnvelopeError("conflict", "service native root authority changed during the access read");
  if (expiresAt <= Math.floor(Date.now() / 1000))
    throw new EpEnvelopeError("expired", "service access expired during native authorization");
  return { witness, gateRevision: found.revision, expiresAt };
}

/** The approval content of a first-approval gate CAS. */
export interface ServiceApprovalArgs {
  rootCredentialId: string; approvalDigest: string; nameAuthorityRevision: number;
  approvalExpiresAt: number | null; callerCeiling: EpCapability[];
}

/** Pure first-approval precondition on a read gate row, in the approval CAS's own order. */
export function assertApprovableServiceGate(row: ServiceRow, args: Pick<ServiceApprovalArgs, "nameAuthorityRevision">): void {
  if (row.state !== "open" || row.serviceAuthority.state !== "pending-root")
    conflict("only the pending root assignment can receive its first approval");
  if (!Number.isSafeInteger(args.nameAuthorityRevision) || args.nameAuthorityRevision <= 0)
    throw new EpEnvelopeError("failed-precondition", "service approval requires its native name binding revision");
}

/** Pure approved successor of `row`. `rootExpiresAt` comes from the live root proof read at
 *  `nowMs`; `expired` when the approval is not live then. */
export function approvedServiceGateRow(row: ServiceRow, args: ServiceApprovalArgs, rootExpiresAt: number, nowMs: number): ServiceRow {
  const authority: ServiceGateAuthority = {
    ...row.serviceAuthority, state: "approved", rootCredentialId: args.rootCredentialId,
    rootExpiresAt, approvalDigest: args.approvalDigest,
    approvalExpiresAt: args.approvalExpiresAt, callerCeiling: parseEndpointCapabilities(args.callerCeiling),
  };
  if (!serviceGateApprovalLive(authority, Math.floor(nowMs / 1000)))
    throw new EpEnvelopeError("expired", "service approval has already expired");
  return { ...row, nameAuthorityRevision: args.nameAuthorityRevision, serviceAuthority: authority };
}

/** Final approval CAS. The host must first verify the proposal, owner consent and operator target policy. */
export async function approveNativeServiceGate(reg: LifecycleRegistry, binding: ServiceAssignmentBinding, args: ServiceApprovalArgs & {
  expectedRevision: number;
}): Promise<ServiceGateRead> {
  const found = await current(reg, binding, args.expectedRevision);
  assertApprovableServiceGate(found.row, args);
  const now = Date.now();
  const rootExpiresAt = await rootExpiry(reg, binding, args.rootCredentialId, now);
  return replace(reg, binding, found, approvedServiceGateRow(found.row, args, rootExpiresAt, now));
}

/** Pure activation precondition and successor on a read gate row: `undefined` when the row is
 *  already activated at this witness. The caller still proves the native root live before the CAS. */
export function activatedServiceGateRow(row: ServiceRow, binding: ServiceAssignmentBinding, raw: ServiceRegistrationWitness, nowMs: number): ServiceRow | undefined {
  const witness = parseServiceRegistrationWitness(raw), authority = row.serviceAuthority;
  const actor = serviceEndpointActor(binding);
  if (witness.accountPublicKey !== binding.accountPublicKey || witness.space !== binding.space
    || witness.endpoint !== binding.endpoint || witness.instanceId !== binding.instanceId
    || witness.principal.owner !== binding.owner || witness.principal.actor !== actor
    || witness.principal.lifecycleUid !== binding.lifecycleUid || witness.rootCredentialId !== authority.rootCredentialId
    || witness.approvalDigest !== authority.approvalDigest || witness.processEpoch !== row.processEpoch
    || witness.registrationRevision !== row.registrationRevision || witness.nameAuthorityRevision !== row.nameAuthorityRevision
    || !authority.registration || witness.registrationRequestId !== authority.registration.requestId || witness.registrationProof !== authority.registration.registrationProof)
    conflict("activation witness does not match the current service registration");
  if (row.state !== "open" || !serviceGateApprovalLive(authority, Math.floor(nowMs / 1000)))
    throw new EpEnvelopeError("expired", "service approval no longer permits activation");
  return authority.activationIssued ? undefined : { ...row, serviceAuthority: { ...authority, activationIssued: true } };
}

/** The host withholds both access and renewal material until this monotonic activation CAS wins. */
export async function markNativeServiceActivated(reg: LifecycleRegistry, binding: ServiceAssignmentBinding, args: {
  expectedRevision: number; witness: ServiceRegistrationWitness;
}): Promise<ServiceGateRead> {
  const found = await current(reg, binding, args.expectedRevision), now = Date.now();
  coordinates(reg, binding);
  const next = activatedServiceGateRow(found.row, binding, args.witness, now);
  await rootExpiry(reg, binding, args.witness.rootCredentialId, now);
  return next === undefined ? found : replace(reg, binding, found, next);
}

/** Durable deny-new only. This is never a terminal retirement result or broker absence proof. */
export async function denyNativeServiceGate(reg: LifecycleRegistry, binding: ServiceAssignmentBinding, args: {
  expectedRevision: number; operationId: string;
}): Promise<ServiceGateRead> {
  assertLifecycleToken(args.operationId, "operationId");
  const found = await current(reg, binding, args.expectedRevision);
  const next = deniedRow(found.row, args.operationId);
  return next === undefined ? found : replace(reg, binding, found, next);
}

/** Fence cancellation before the endpoint gate exists. Native UID cancellation remains a separate required barrier. */
export async function fenceUncreatedServiceGate(reg: LifecycleRegistry, binding: ServiceAssignmentBinding, operationId: string): Promise<ServiceGateRead> {
  assertLifecycleToken(operationId, "operationId");
  const { kv, key } = coordinates(reg, binding), row = uncreatedFenceRow(reg, binding, operationId);
  await createRowByteIdempotent(kv, key, row);
  const created = await readNativeServiceGate(reg, binding);
  if (!created) throw new EpEnvelopeError("unavailable", "created service gate is not readable; retain the operation identity");
  return created;
}
