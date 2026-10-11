import {
  assertDerivedOwnerToken, assertLifecycleToken, contractDigest, endpointRegistrationBarrier,
  endpointToken, environmentBootstrapActor, EpEnvelopeError, remoteManagerActors,
  retirementFrontierStreams, serveIssuanceGateKv,
} from "@cotal-ai/core";
import type { EnvironmentManagerAdmissionCoordinates } from "./environment-manager-admission.js";
import { registryStores, type LifecycleRegistry } from "./lifecycle-registry.js";
import { runAgentRetirementBarrier, type RetirementDeps } from "./retirement-barrier.js";

/** Retire an original pending bootstrap at the trusted host, including after admission expiry.
 *  The host must bar preparation and activation under its current admission before calling this
 *  step; a retained coordinate or gate snapshot alone is not that phase fence. Native lifecycle
 *  retirement precedes endpoint-family revocation, verified eviction and abort. This internal step
 *  neither authenticates external admission nor marks it ended, terminates a provider, stores
 *  results or supplies activated-manager cleanup. Same-op reconstruction is required. */
export async function retirePendingEnvironmentManager(
  reg: LifecycleRegistry,
  input: EnvironmentManagerAdmissionCoordinates,
  deps: RetirementDeps,
): Promise<{ lifecycleUid: string; operationId: string }> {
  const pin = structuredClone(input);
  const fields = ["owner", "instanceId", "lifecycleUid", "authorityEndpoint", "authorityInstanceId",
    "expiresAt", "environmentId", "admissionRevision", "operationId"];
  if (Object.keys(pin).length !== fields.length || Object.keys(pin).some(key => !fields.includes(key)) ||
      !/^[0-9a-f]{64}$/.test(pin.environmentId) || !Number.isSafeInteger(pin.admissionRevision) || pin.admissionRevision < 1 ||
      !Number.isSafeInteger(pin.expiresAt) || pin.expiresAt < 1)
    throw new EpEnvelopeError("failed-precondition", "pending environment retirement coordinates are invalid");
  assertDerivedOwnerToken(pin.owner);
  for (const field of ["instanceId", "lifecycleUid", "authorityInstanceId", "operationId"] as const)
    assertLifecycleToken(pin[field], field);
  endpointToken(pin.authorityEndpoint);
  for (const field of ["evictPrincipal", "drainTargetObligations", "openCleaner", "retireCleanerCredential",
    "openExecutor", "retireExecutorCredential", "now"] as const)
    if (typeof deps?.[field] !== "function")
      throw new EpEnvelopeError("failed-precondition", "pending environment retirement requires native retirement mechanics");
  const { space, authKv } = registryStores(reg);
  const stage = await authKv.get(`stage.${pin.operationId}.environment-manager`);
  if (!stage || stage.operation !== "PUT")
    throw new EpEnvelopeError("permission-denied", "pending environment retirement has no retained admission staging");
  let staged: unknown;
  try { staged = stage.json(); }
  catch { throw new EpEnvelopeError("failed-precondition", "pending environment retirement staging is not JSON"); }
  if (contractDigest(staged) !== contractDigest({ v: 1, kind: "environment-manager-admission", space, ...pin }))
    throw new EpEnvelopeError("permission-denied", "pending environment retirement does not match its original admission");
  const principal = `${pin.owner}.${remoteManagerActors(pin.instanceId).serve}`;
  const birth = await authKv.get(`stage.${pin.operationId}.environment-manager-gate`);
  if (!birth || birth.operation !== "PUT")
    throw new EpEnvelopeError("permission-denied", "pending environment retirement has no retained initial gate stamp");
  let initial: { instanceId?: unknown; principal?: unknown; openRevision?: unknown };
  try { initial = birth.json(); }
  catch { throw new EpEnvelopeError("failed-precondition", "pending environment retirement gate stamp is not JSON"); }
  if (!initial || typeof initial !== "object" || Object.keys(initial).length !== 3 || initial.instanceId !== pin.instanceId ||
      initial.principal !== principal || !Number.isSafeInteger(initial.openRevision) || Number(initial.openRevision) < 1)
    throw new EpEnvelopeError("permission-denied", "pending environment retirement gate stamp has foreign coordinates");
  const gate = serveIssuanceGateKv(authKv, space, { endpoint: "manager", instanceId: pin.instanceId });
  const pending = async () => {
    const row = await gate.observe();
    if (!row || row.authorityFamily !== "environment-manager" || row.principal !== principal)
      throw new EpEnvelopeError("permission-denied", "pending environment retirement cannot adopt an ordinary or foreign gate");
    if (row.state === "retired" || row.registrationRevision !== 0 || row.processEpoch !== 0 || row.nameAuthorityRevision !== 0 ||
        (row.state === "frozen" && (row.op.kind !== "registration" || row.op.opId !== pin.operationId)))
      throw new EpEnvelopeError("conflict", "pending environment retirement cannot adopt completed or foreign registration");
    return row;
  };
  await pending();
  // The existing native barrier owns its durable intent, freeze, family containment, frontiers
  // and head/gate terminals. Never reopen registration while any of those remain unconfirmed.
  await runAgentRetirementBarrier(reg, {
    owner: pin.owner, actor: environmentBootstrapActor(pin.instanceId), lifecycleUid: pin.lifecycleUid,
    opId: pin.operationId, frontierStreams: retirementFrontierStreams(space),
  }, deps);
  const barrier = endpointRegistrationBarrier(authKv, space, { endpoint: "manager", instanceId: pin.instanceId, opId: pin.operationId });
  const current = await pending();
  const rows = await barrier.enumerate();
  for (const row of rows) await barrier.revoke(row);
  for (const holder of new Set([principal, ...rows.map(row => row.holderPrincipal)])) {
    const result = await deps.evictPrincipal(holder);
    if (result.verifiedGone !== true)
      throw new EpEnvelopeError("unavailable", "pending environment retirement endpoint eviction is not verified");
  }
  if (current.state === "frozen") {
    if (!await barrier.reopen(current.revision, { generation: current.generation, processEpoch: current.processEpoch,
      registrationRevision: current.registrationRevision, nameAuthorityRevision: current.nameAuthorityRevision }))
      throw new EpEnvelopeError("conflict", "pending environment retirement lost its registration abort fence");
  }
  const aborted = await pending();
  if (aborted.state !== "open")
    throw new EpEnvelopeError("conflict", "pending environment retirement registration is still frozen");
  return { lifecycleUid: pin.lifecycleUid, operationId: pin.operationId };
}
