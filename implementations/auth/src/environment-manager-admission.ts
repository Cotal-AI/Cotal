import {
  assertDerivedOwnerToken, assertLifecycleToken, endpointRegistrationBarrier, endpointToken,
  environmentBootstrapActor, EpEnvelopeError, isCasLoss, provisionEndpointGateOpen, remoteManagerActors,
  serveIssuanceGateKv, type EnvironmentManagerGrantPin,
} from "@cotal-ai/core";
import { activateLifecycleAtUid, registryStores, type LifecycleRegistry } from "./lifecycle-registry.js";

/** Coordinates already reserved in the trusted host's immutable environment index. This internal
 * pre-issuance step creates no credential and is not the environment admission or bootstrap door. */
export interface EnvironmentManagerAdmissionCoordinates extends EnvironmentManagerGrantPin {
  environmentId: string;
  /** Immutable host-selected data account, not a guest signing choice. */
  accountPublicKey: string;
  admissionRevision: number;
  operationId: string;
}

/** Stage the native registration reservation under the host's original operation. The caller must
 * have validated the external admission and required host policies before reaching this step. */
export async function stageEnvironmentManagerAdmission(
  reg: LifecycleRegistry,
  input: EnvironmentManagerAdmissionCoordinates,
): Promise<{ gateRevision: number }> {
  const pin = structuredClone(input);
  assertDerivedOwnerToken(pin.owner);
  for (const field of ["instanceId", "lifecycleUid", "authorityInstanceId", "operationId"] as const)
    assertLifecycleToken(pin[field], field);
  endpointToken(pin.authorityEndpoint);
  const fields = ["owner", "instanceId", "lifecycleUid", "authorityEndpoint", "authorityInstanceId",
    "expiresAt", "environmentId", "accountPublicKey", "admissionRevision", "operationId"];
  if (Object.keys(pin).length !== fields.length || Object.keys(pin).some(key => !fields.includes(key)) ||
    !/^A[A-Z2-7]{55}$/.test(pin.accountPublicKey) || !/^[0-9a-f]{64}$/.test(pin.environmentId) ||
    !Number.isSafeInteger(pin.admissionRevision) || pin.admissionRevision < 1 ||
    !Number.isSafeInteger(pin.expiresAt) || pin.expiresAt <= Math.floor(Date.now() / 1000))
    throw new EpEnvelopeError("failed-precondition", "environment manager admission coordinates are invalid or expired");
  const { space, authKv } = registryStores(reg);
  const principal = `${pin.owner}.${remoteManagerActors(pin.instanceId).serve}`;
  const gate = serveIssuanceGateKv(authKv, space, { endpoint: "manager", instanceId: pin.instanceId });
  const eligible = async () => {
    const observed = await gate.observe();
    if (observed && (observed.authorityFamily !== "environment-manager" || observed.principal !== principal))
      throw new EpEnvelopeError("permission-denied", "environment admission cannot adopt an ordinary or foreign manager instance");
    if (observed && (observed.state === "retired" || observed.registrationRevision !== 0 ||
      (observed.state === "frozen" && (observed.op.kind !== "registration" || observed.op.opId !== pin.operationId))))
      throw new EpEnvelopeError("conflict", "environment admission cannot adopt a completed or foreign registration operation");
    return observed;
  };
  await eligible();
  const key = `stage.${pin.operationId}.environment-manager`;
  // Explicit ordering makes a same-input retry byte-identical regardless of input property order.
  const bytes = new TextEncoder().encode(JSON.stringify({
    v: 1, kind: "environment-manager-admission", space,
    owner: pin.owner, environmentId: pin.environmentId, accountPublicKey: pin.accountPublicKey,
    admissionRevision: pin.admissionRevision, instanceId: pin.instanceId, lifecycleUid: pin.lifecycleUid, authorityEndpoint: pin.authorityEndpoint,
    authorityInstanceId: pin.authorityInstanceId, expiresAt: pin.expiresAt, operationId: pin.operationId,
  }));
  try {
    // KV.create can resurrect a tombstone. An operation never acquires a second binding.
    await authKv.put(key, bytes, { previousSeq: 0 });
  } catch (error) {
    if (!isCasLoss(error)) throw new EpEnvelopeError("unavailable", "environment admission staging outcome is unknown");
    const existing = await authKv.get(key);
    if (!existing || existing.operation !== "PUT" || Buffer.compare(existing.value, bytes) !== 0)
      throw new EpEnvelopeError("conflict", "environment admission operation has foreign content or a deletion marker");
  }
  await activateLifecycleAtUid(reg, { owner: pin.owner, actor: environmentBootstrapActor(pin.instanceId),
    lifecycleUid: pin.lifecycleUid, managerInstance: pin.instanceId });
  if (await eligible() === null)
    await provisionEndpointGateOpen(authKv, { endpoint: "manager", instanceId: pin.instanceId,
      principal, authorityFamily: "environment-manager" });
  // An abort may preserve every counter; its changed KV revision is the durable distinction.
  const birthKey = `stage.${pin.operationId}.environment-manager-gate`;
  let birth = await authKv.get(birthKey);
  if (!birth) {
    const opened = await eligible();
    if (opened?.state === "open" && opened.generation === 0) {
      const value = JSON.stringify({ instanceId: pin.instanceId, principal, openRevision: opened.revision });
      try { await authKv.put(birthKey, value, { previousSeq: 0 }); }
      catch (error) {
        if (!isCasLoss(error)) throw new EpEnvelopeError("unavailable", "environment manager initial gate reservation outcome is unknown");
      }
    }
    birth = await authKv.get(birthKey);
  }
  if (!birth || birth.operation !== "PUT")
    throw new EpEnvelopeError("failed-precondition", "environment manager initial gate reservation is absent or deleted");
  let initial: unknown;
  try { initial = birth.json(); }
  catch { throw new EpEnvelopeError("failed-precondition", "environment manager initial gate reservation is not JSON"); }
  const row = initial as { instanceId?: unknown; principal?: unknown; openRevision?: unknown };
  if (!row || typeof row !== "object" || Object.keys(row).length !== 3 || row.instanceId !== pin.instanceId ||
    row.principal !== principal || !Number.isSafeInteger(row.openRevision) || Number(row.openRevision) < 1)
    throw new EpEnvelopeError("failed-precondition", "environment manager initial gate reservation has foreign coordinates");
  const barrier = endpointRegistrationBarrier(authKv, space, { endpoint: "manager", instanceId: pin.instanceId,
    opId: pin.operationId });
  for (let attempt = 0; attempt < 3; attempt++) {
    const current = await eligible();
    if (!current) throw new EpEnvelopeError("failed-precondition", "environment manager gate disappeared");
    if (current.state === "frozen") return { gateRevision: current.revision };
    if (current.revision !== row.openRevision)
      throw new EpEnvelopeError("conflict", "environment manager registration was aborted; its reopened gate cannot be re-frozen");
    const revision = await barrier.freeze(current.revision);
    if (revision !== null) return { gateRevision: revision };
  }
  throw new EpEnvelopeError("conflict", "environment registration reservation kept losing its native freeze CAS");
}
