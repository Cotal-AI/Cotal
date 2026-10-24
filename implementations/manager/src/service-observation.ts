import {
  dialerFor, invokeCommand, issuedUserCaller, resolveService, standaloneConnectOpts,
} from "@cotal-ai/core";
import {
  CommandFailure, assertRecordIdentity, canonicalRoot, observeServiceStartup,
  readServiceIdentity, readServiceStopRequest, requestServiceObservation, resolveControlTarget,
  resolveNativeServiceTarget, resolveSeatControlTarget, serviceMetadataDigest,
  type NativeServiceIdentity, type ServiceAdapterContext, type ServiceAdapterNativeEvidence,
  type ServiceAdapterReadiness,
} from "@cotal-ai/workspace";
import type { ManagerServiceObservation } from "./manager.js";
import { MANAGER_ENDPOINT, type ManagerStatus, type ManagerStopImpact } from "./manager-service-contract.js";

export type ManagerObservationContext = ServiceAdapterContext & {
  readonly process: { pid: number; token: string };
  readonly signal: AbortSignal;
};

export type ManagerServiceEvidence = ManagerServiceObservation & { readonly evidence?: ServiceAdapterNativeEvidence };

const plain = (value: unknown): value is Record<string, unknown> => Boolean(value && typeof value === "object" && !Array.isArray(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value)));
const closed = (value: unknown, keys: readonly string[]): value is Record<string, unknown> => plain(value) && Object.keys(value).length === keys.length && Object.keys(value).every((key) => keys.includes(key));
const text = (value: unknown): value is string => typeof value === "string" && value.length > 0 && value.length <= 200 && !/[\u0000-\u001f\u007f]/u.test(value);
const count = (value: unknown): boolean => Number.isSafeInteger(value) && Number(value) >= 0;
const impactKeys = ["agentScope", "observedAt", "maintenance", "resumeRequired", "stopping", "lifecycleInFlight", "reservedLaunches", "retirementsPending", "deprovisioningInFlight", "staticReconciliationInFlight", "agents"] as const;
const rowKeys = ["name", "id", "lifecycleUid", "mode", "defaultAction", "withAgentsAction"] as const;

function localImpact(input: unknown): ManagerStopImpact | undefined {
  if (!closed(input, impactKeys) || !["manager", "owner-filtered"].includes(String(input.agentScope)) || !["active", "preserving", "preserved"].includes(String(input.maintenance)) || typeof input.resumeRequired !== "boolean" || typeof input.stopping !== "boolean" || typeof input.observedAt !== "string" || input.observedAt.length > 100 || !Number.isFinite(Date.parse(input.observedAt)) || ![input.lifecycleInFlight, input.reservedLaunches, input.retirementsPending, input.deprovisioningInFlight, input.staticReconciliationInFlight].every(count) || !Array.isArray(input.agents) || input.agents.length > 4096) return undefined;
  for (const row of input.agents) if (!closed(row, rowKeys) || ![row.name, row.id, row.lifecycleUid, row.mode].every(text) || !["release-custody", "stop", "stop-retaining-state"].includes(String(row.defaultAction)) || !["stop", "stop-retaining-state"].includes(String(row.withAgentsAction))) return undefined;
  return input as unknown as ManagerStopImpact;
}

/** Open spaces have no authenticated caller. The pinned child answers one request-bound local
 *  receipt with its own registration, which must equal the PID-bound launch identity. This is
 *  same-UID custody evidence, never an attributed endpoint response. */
async function observeOpenManager(context: ManagerObservationContext, native: NativeServiceIdentity): Promise<ManagerServiceEvidence | undefined> {
  const answer = await requestServiceObservation(context, context.process, { timeoutMs: 3000, signal: context.signal });
  if (!answer) return undefined;
  const payload = answer.payload;
  const mismatch = () => new CommandFailure("unknown", "OPERATION_UNKNOWN", "the pinned manager's local receipt does not match its protected launch identity; readiness or stop impact was not inferred");
  if (!closed(payload, ["registration", "stopImpact"]) || !closed(payload.registration, ["endpoint", "instanceId", "principal", "epoch"]) || !Number.isSafeInteger(payload.registration.epoch) || Number(payload.registration.epoch) < 0) throw mismatch();
  const { epoch, ...registration } = payload.registration;
  const stopImpact = localImpact(payload.stopImpact);
  if (!stopImpact || serviceMetadataDigest(registration) !== serviceMetadataDigest(native) || assertRecordIdentity(context.process).kind !== "match") throw mismatch();
  return { registration: { ...native, epoch: Number(epoch) }, stopImpact, evidence: "local-process-receipt" };
}

/** A fresh instance-pinned native read as the invoking caller. Neither a managed seat nor an
 *  owner-filtered response is replaced by a wider operator/admin identity. An open space uses
 *  the pinned child's local receipt instead and says so in `evidence`. */
export async function observeManagerService(context: ManagerObservationContext): Promise<ManagerServiceEvidence | undefined> {
  context.signal.throwIfAborted();
  const root = context.options.root, server = context.options.server;
  if (typeof root !== "string" || server !== undefined && typeof server !== "string") throw new CommandFailure("refused", "SCHEMA_INVALID", "the manager service observation has no explicit registered root and broker");
  const selected = resolveNativeServiceTarget(root, context.space, server as string | undefined);
  const binding = readServiceIdentity(context, context.process);
  if (!binding) return undefined;
  if (binding.native.endpoint !== MANAGER_ENDPOINT) throw new CommandFailure("unknown", "OPERATION_UNKNOWN", "the protected launch binding names a different native endpoint; no class was substituted");
  if (observeServiceStartup(context, "manager-serving").state !== "ready") return undefined;
  if (selected.mode === "open") return observeOpenManager(context, binding.native);
  const flags = { space: selected.space, server: selected.server };
  const seat = await resolveSeatControlTarget(flags, binding.native.instanceId);
  const markedSeat = ["COTAL_NAME", "COTAL_ID", "COTAL_LIFECYCLE_UID", "COTAL_ACCEPTED_TOKEN"].some((key) => Boolean(process.env[key]));
  if (!seat && markedSeat && selected.mode !== "user") throw new CommandFailure("refused", "AUTH_REQUIRED", "the invoking managed seat has no supported caller handoff for this selected manager; no operator caller was substituted");
  const target = seat ?? await resolveControlTarget(flags, "control-caller-privileged", binding.native.instanceId, { endpoint: MANAGER_ENDPOINT, onRefusal: "throw" });
  if (!target.root || canonicalRoot(target.root) !== canonicalRoot(selected.root) || target.space !== selected.space || target.server !== selected.server || (target.auth.tls === true) !== selected.tlsRequired || !target.auth.epCaller || (!target.auth.creds && !(target.auth.bearer && target.auth.sentinelCreds))) throw new CommandFailure("refused", "CONFLICT", "the native manager caller did not resolve to the selected registered root, space, transport and broker; no alternate target was dialed");
  const auth = target.auth;
  const options = standaloneConnectOpts(auth.creds ? { creds: auth.creds, tls: selected.tlsRequired } : { bearer: auth.bearer!, sentinelCreds: auth.sentinelCreds!, tls: selected.tlsRequired });
  const nc = await dialerFor(selected.server)({ servers: selected.server, ...options, maxReconnectAttempts: 0 });
  try {
    context.signal.throwIfAborted();
    const caller = auth.bearer !== undefined && auth.managerInstanceId !== undefined
      ? await issuedUserCaller(nc, selected.space, String(options.name), auth.epCaller!)
      : auth.epCaller!;
    const service = await resolveService(nc, selected.space, MANAGER_ENDPOINT, caller, { instanceId: binding.native.instanceId, deadlineMs: 5000, signal: context.signal });
    const response = await invokeCommand(nc, selected.space, service, "status", undefined, { deadlineMs: 5000, signal: context.signal });
    if (!response.reply.ok) throw new CommandFailure("refused", "PERMISSION_DENIED", "the invoking caller did not receive the native manager status; no wider caller was tried");
    const status = response.reply.data as ManagerStatus;
    if (response.responder.endpoint !== MANAGER_ENDPOINT || response.responder.instanceId !== binding.native.instanceId || response.responder.epoch !== service.responder.epoch || service.owner !== binding.native.principal.owner || status.instanceId !== binding.native.instanceId || status.lifecycleUid !== binding.native.principal.uid || !status.stopImpact || assertRecordIdentity(context.process).kind !== "match") throw new CommandFailure("unknown", "OPERATION_UNKNOWN", "the attributed native response did not match this protected process/launch/instance/lifecycle; readiness or stop impact was not inferred");
    // The served status snapshot includes its own admitted control read. That read has returned
    // before this observation can become a stop plan; every other admitted operation stays counted.
    if (status.stopImpact.lifecycleInFlight < 1) throw new CommandFailure("unknown", "OPERATION_UNKNOWN", "the native status snapshot did not account for its own admitted read; no quiescent stop scope was inferred");
    return { registration: { ...binding.native, epoch: response.responder.epoch }, stopImpact: { ...status.stopImpact, lifecycleInFlight: status.stopImpact.lifecycleInFlight - 1 } };
  } finally { await nc.close(); }
}

/** An accepted or unresolved stop attempt blocks readiness adoption, even while the PID lives. */
export async function managerServiceReadiness(context: ManagerObservationContext): Promise<ServiceAdapterReadiness> {
  if (readServiceStopRequest(context)) throw new CommandFailure("refused", "LIFECYCLE_BLOCKED", "the native manager has a retained stop handoff; inspect that original request before treating it as a serving launch");
  const observation = await observeManagerService(context);
  if (!observation) return { state: "pending" };
  if (observation.stopImpact.stopping || readServiceStopRequest(context)) throw new CommandFailure("refused", "LIFECYCLE_BLOCKED", "the native manager entered a stop while readiness was observed; the launch was not adopted");
  return { state: "ready", process: { ...context.process }, observedAt: new Date().toISOString(), native: { endpoint: observation.registration.endpoint, instanceId: observation.registration.instanceId, owner: observation.registration.principal.owner, actor: observation.registration.principal.actor, lifecycleUid: observation.registration.principal.uid, epoch: observation.registration.epoch }, ...(observation.evidence ? { evidence: observation.evidence } : {}) };
}
