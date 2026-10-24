/** Package-internal caller-policy resolver. Content records describe rights, never establish them:
 * every mint rechecks the exact grantee, current assignment/name/root and approval ceiling.
 * Unsupported delegation is refused, not interpreted as independent owner authority. */
import {
  EpEnvelopeError, canonicalJson, contractDigest, endpointCapabilitiesWithin, endpointToken, epAuthBucket, serviceGateApprovalLive,
  type EpCapability, type ServicePrincipal,
} from "@cotal-ai/core";
import { callerParentRefs } from "./service-caller-ancestry.js";
import { findActorUnified } from "./ledger.js";
import { registryStores, registryMaxPayload, type LifecycleRegistry } from "./lifecycle-registry.js";
import { readNativeServiceCallerPolicy } from "./service-caller-policy.js";
import { parseServiceAdmissionRecord, parseServiceAssignmentRecord } from "./service-host-ops.js";
import { readNativeServiceGate } from "./native-service-gate.js";
import { readNativeServiceName } from "./native-service-name.js";
import { readRegistryServiceRoot } from "./service-root-reader.js";
import { parseServiceCallerPayloadRecord, serviceCallerPayloadCheck, SERVICE_CALLER_PAYLOAD_KEY } from "./service-caller-payload.js";

const decoder = new TextDecoder("utf-8", { fatal: true });
export interface EffectiveEndpointCaller { capabilities: EpCapability[]; expiresAt?: number; evidenceDigest?: string }
export async function effectiveEndpointCaller(registry: LifecycleRegistry, accountPublicKey: string, ledgerDir: string,
  grantee: ServicePrincipal): Promise<EffectiveEndpointCaller> {
  const { space, authKv, jsm } = registryStores(registry);
  const current = findActorUnified(ledgerDir, grantee.owner, grantee.actor);
  if (!current || current.lifecycleUid !== grantee.lifecycleUid)
    throw new EpEnvelopeError("permission-denied", "endpoint caller lifecycle is not the current actor grant");
  const policy = await readNativeServiceCallerPolicy(registry, { accountPublicKey, space, grantee });
  if (!policy) return { capabilities: [] };
  // Eligibility is re-established from current exact ledger ancestry below for every grant.
  const read = async <T>(key: string, parse: (raw: unknown) => T): Promise<T | undefined> => {
    const entry = await authKv.get(key);
    if (!entry) return undefined;
    if (entry.operation !== "PUT") throw new EpEnvelopeError("failed-precondition", "endpoint caller authority has deletion history");
    return parse(JSON.parse(decoder.decode(entry.value)));
  };
  const admission = await read("svchost.admission", parseServiceAdmissionRecord);
  if (!admission || admission.state !== "open") throw new EpEnvelopeError("permission-denied", "endpoint caller admission is closed");
  const payload = await read(SERVICE_CALLER_PAYLOAD_KEY, parseServiceCallerPayloadRecord);
  const info = await jsm.streams.info(`KV_${epAuthBucket(space)}`);
  if (!serviceCallerPayloadCheck(payload, { maxPayload: registryMaxPayload(registry), authMaxMsgSize: info.config.max_msg_size }).holds)
    throw new EpEnvelopeError("failed-precondition", "endpoint caller payload precondition is not asserted and live");
  const capabilities: EpCapability[] = [];
  const evidence: unknown[] = [{ policyRevision: policy.revision, policy: policy.row }];
  let expiresAt = Number.MAX_SAFE_INTEGER;
  for (const grant of policy.row.grants) {
    if (grant.status.state !== "active") continue;
    const source = grant.source;
    if (source.kind !== "service-owner")
      throw new EpEnvelopeError("permission-denied", "delegated endpoint caller issuance is unsupported");
    const parents = await callerParentRefs({ space, ledgerDir, grantee, capabilities: grant.capabilities, expectedRefs: grant.parentRefs,
      service: { endpoint: grant.endpoint, instanceId: grant.instanceId, approvalDigest: grant.serviceApprovalDigest },
      readPolicy: async parent => (await readNativeServiceCallerPolicy(registry, { accountPublicKey, space, grantee: parent }))?.row });
    if (canonicalJson(parents) !== canonicalJson(grant.parentRefs))
      throw new EpEnvelopeError("permission-denied", "endpoint caller parent lifecycle or covering grants changed");
    const asg = await read(`svcasg.${endpointToken(grant.endpoint)}.${grant.instanceId}`, parseServiceAssignmentRecord);
    if (!asg || asg.state !== "bound" || asg.cancel !== null || asg.owner !== source.owner) continue;
    const binding = { accountPublicKey, space, owner: asg.owner, endpoint: grant.endpoint, instanceId: grant.instanceId,
      lifecycleUid: asg.reservation.native.lifecycleUid, assignmentDigest: asg.assignmentDigest };
    const gate = await readNativeServiceGate(registry, binding);
    if (!gate || gate.row.state !== "open") continue;
    const authority = gate.row.serviceAuthority;
    if (!authority.activationIssued || !authority.registration || authority.approvalDigest !== grant.serviceApprovalDigest
      || source.approvalDigest !== grant.serviceApprovalDigest || source.nameAuthorityRevision !== gate.row.nameAuthorityRevision
      || !serviceGateApprovalLive(authority, Math.floor(Date.now() / 1000))) continue;
    const name = await readNativeServiceName(registry, { accountPublicKey, space }, grant.endpoint);
    if (!name || name.owner !== source.owner || name.revision !== source.nameAuthorityRevision) continue;
    const root = await readRegistryServiceRoot(registry, binding, authority.rootCredentialId!, Date.now());
    if (grant.capabilities.some(c => c.endpoint !== grant.endpoint || c.instanceId !== grant.instanceId || c.instanceOnly !== true
      || c.journal || c.target?.mode === "any" || c.target?.mode === "ledger"))
      throw new EpEnvelopeError("permission-denied", "endpoint caller policy exceeds exact instance authority");
    const caller = { owner: grantee.owner, actor: grantee.actor, uid: grantee.lifecycleUid };
    if (!endpointCapabilitiesWithin({ space, child: { caller, capabilities: grant.capabilities }, parent: { caller, capabilities: authority.callerCeiling } })) continue;
    evidence.push({ assignmentDigest: asg.assignmentDigest, registration: authority.registration, nameRevision: name.revision,
      root: authority.rootCredentialId, rootExpiresAt: root.expiresAt, approval: authority.approvalDigest, parents });
    expiresAt = Math.min(expiresAt, root.expiresAt, authority.approvalExpiresAt ?? Number.MAX_SAFE_INTEGER);
    capabilities.push(...grant.capabilities);
    // The baseline describe grant is class-only. Generic resolve with an exact instance requires
    // the reserved describe row on that same instance, never another endpoint or command.
    capabilities.push({ endpoint: grant.endpoint, command: "describe", instanceId: grant.instanceId, instanceOnly: true });
  }
  // Reads are fresh observations, not a linearized revoke fence. Re-read the complete policy after
  // authority resolution so a revoke/append that landed during the walk never releases stale rows.
  const final = await readNativeServiceCallerPolicy(registry, { accountPublicKey, space, grantee });
  if (!final || final.revision !== policy.revision || canonicalJson(final.row) !== canonicalJson(policy.row))
    throw new EpEnvelopeError("permission-denied", "endpoint caller policy changed during issuance");
  const latest = findActorUnified(ledgerDir, grantee.owner, grantee.actor);
  if (!latest || latest.lifecycleUid !== grantee.lifecycleUid || latest.kind !== current.kind || latest.parent !== current.parent)
    throw new EpEnvelopeError("permission-denied", "endpoint caller lifecycle changed during issuance");
  return { capabilities, ...(capabilities.length ? { expiresAt } : {}), evidenceDigest: contractDigest(evidence) };
}
