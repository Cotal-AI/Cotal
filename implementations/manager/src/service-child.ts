import { createHash } from "node:crypto";
import { lstatSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import type { MeshLaunchSpec, ParsedArgs } from "@cotal-ai/core";
import {
  CommandFailure, MANAGER_PIDFILE, answerServiceObservations, assertRecordIdentity, canonicalLocalProcessPath,
  consumeManagerShutdownIntent, protectedCredentialReference, protectedLocalDirectory, publishServiceIdentity,
  publishServiceStopReceipt, readLocalRecordSource, readServiceIdentity,
  readServiceStopReceipts, readServiceStopRequest, resolveNativeServiceTarget,
  serviceMetadataDigest, serviceOperationId, serviceStopRequestPath, stopReservationPath,
  type NativeServiceStopRequest, type ServiceAdapterContext,
} from "@cotal-ai/workspace";
import type { Manager, ManagerOptions, ManagerServiceObservation, StartAgentOpts } from "./manager.js";
import { parseLaunchSpec } from "./launch.js";
import { loadRoster } from "./roster.js";

export interface ManagerServiceChild {
  readonly root: string;
  readonly context: Pick<ServiceAdapterContext, "space" | "instanceId" | "launchRequestId" | "stateDirectory">;
  readonly launchSpec?: MeshLaunchSpec;
  /** The roster's agents, parsed once here like the launch spec. */
  readonly roster?: readonly StartAgentOpts[];
}

/** Read one private, content-pinned manifest once. The child keeps these parsed bytes rather than
 *  reopening a path after asynchronous authority preparation. */
export function managerServiceLaunchSpec(path: string, digest: string, space: string): MeshLaunchSpec {
  if (!isAbsolute(path) || path.length > 4096 || /[\u0000-\u001f\u007f]/u.test(path) || !/^[0-9a-f]{64}$/.test(digest)) throw new CommandFailure("refused", "USAGE_INVALID", "an owned manager launch requires an absolute private spec and its full SHA-256");
  protectedCredentialReference(path);
  const bytes = readLocalRecordSource(path, 256 * 1024, true);
  if (!bytes || createHash("sha256").update(bytes).digest("hex") !== digest) throw new CommandFailure("refused", "CONFLICT", "the owned manager launch spec is absent or changed from its declared digest; no agent launch was selected");
  let spec: MeshLaunchSpec;
  try { spec = parseLaunchSpec(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)), "owned manager launch"); }
  catch { throw new CommandFailure("refused", "SCHEMA_INVALID", "the owned manager launch spec is not valid native launch data; document contents were not echoed"); }
  if (spec.space !== space) throw new CommandFailure("refused", "CONFLICT", "the owned manager launch spec names another space; no target was substituted");
  return spec;
}

/** Hidden runner inputs contain public coordinates only, never credentials or console URLs. */
export function managerServiceChild(args: ParsedArgs): ManagerServiceChild {
  const values = args.values;
  for (const key of ["root", "space", "server", "runtime", "service-instance", "launch-request", "state-directory"]) {
    if (typeof values[key] !== "string" || !values[key] || values[key].length > 4096 || /[\u0000-\u001f\u007f]/u.test(values[key])) throw new CommandFailure("refused", "USAGE_INVALID", "the native manager child requires its explicit public target, runtime and full launch coordinates");
  }
  if (args.positionals.length) throw new CommandFailure("refused", "USAGE_INVALID", "the native manager child takes no positional targets");
  const root = String(values.root), stateDirectory = String(values["state-directory"]);
  if (process.platform !== "linux" || !isAbsolute(root) || !isAbsolute(stateDirectory)) throw new CommandFailure("refused", "UNSUPPORTED", "the native manager child requires protected absolute paths and Linux process creation identity");
  protectedLocalDirectory(root);
  protectedLocalDirectory(join(root, ".cotal"));
  protectedLocalDirectory(stateDirectory);
  const directory = lstatSync(stateDirectory);
  if (directory.uid !== process.getuid!() || (directory.mode & 0o077) !== 0) throw new CommandFailure("refused", "PERMISSION_DENIED", "the native manager launch state must be an owned private directory");
  const target = resolveNativeServiceTarget(root, String(values.space), String(values.server));
  const context = Object.freeze({ space: target.space, instanceId: serviceOperationId(values["service-instance"]), launchRequestId: serviceOperationId(values["launch-request"]), stateDirectory });
  for (const [field, minimum, maximum] of [["console-port", 0, 65535], ["ws-port", 1, 65535], ["max-sessions", 1, Number.MAX_SAFE_INTEGER]] as const) {
    const value = values[field];
    if (value !== undefined && (typeof value !== "string" || !/^(0|[1-9][0-9]*)$/.test(value) || !Number.isSafeInteger(Number(value)) || Number(value) < minimum || Number(value) > maximum)) throw new CommandFailure("refused", "USAGE_INVALID", "the native manager child requires valid explicit ports and a positive session ceiling");
  }
  if (values["console-host"] !== undefined && (typeof values["console-host"] !== "string" || !values["console-host"] || values["console-host"].length > 253 || /[\u0000- \u007f]/u.test(values["console-host"]))) throw new CommandFailure("refused", "USAGE_INVALID", "the native manager child requires a bounded explicit console host without controls");
  let launchSpec: MeshLaunchSpec | undefined;
  if (values.launch !== undefined || values["launch-sha256"] !== undefined) {
    if (typeof values.launch !== "string" || typeof values["launch-sha256"] !== "string") throw new CommandFailure("refused", "USAGE_INVALID", "the native manager child requires both its private launch spec and full digest");
    launchSpec = managerServiceLaunchSpec(values.launch, values["launch-sha256"], target.space);
  }
  if (values["resume-attempt"] !== undefined && (typeof values["resume-attempt"] !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(values["resume-attempt"]))) throw new CommandFailure("refused", "USAGE_INVALID", "the native manager child requires a safe resume attempt token");
  if ((values["resume-commit-file"] !== undefined || values["resume-commit-sha256"] !== undefined) && (values["resume-attempt"] === undefined || typeof values["resume-commit-file"] !== "string" || !isAbsolute(values["resume-commit-file"]) || values["resume-commit-file"].length > 4096 || /[\u0000-\u001f\u007f]/u.test(values["resume-commit-file"]) || typeof values["resume-commit-sha256"] !== "string" || !/^[0-9a-f]{64}$/.test(values["resume-commit-sha256"]))) throw new CommandFailure("refused", "USAGE_INVALID", "the native manager child requires its resume attempt, an absolute resume commit file and its full digest together");
  if ((values["resume-attempt"] !== undefined) && (values.launch !== undefined || values["launch-sha256"] !== undefined)) throw new CommandFailure("refused", "USAGE_INVALID", "a resumed native manager takes no launch spec; retained agents resume through the attempt-bound control operation");
  let roster: StartAgentOpts[] | undefined;
  if (values.roster !== undefined) {
    if (typeof values.roster !== "string" || !isAbsolute(values.roster) || values.roster.length > 4096 || /[\u0000-\u001f\u007f]/u.test(values.roster)) throw new CommandFailure("refused", "USAGE_INVALID", "the native manager child requires an absolute roster file path without controls");
    if (values["resume-attempt"] !== undefined) throw new CommandFailure("refused", "USAGE_INVALID", "a resumed native manager boots no roster; retained agents resume through the attempt-bound control operation");
    try { roster = loadRoster(values.roster); }
    catch (error) { throw new CommandFailure("refused", "SCHEMA_INVALID", `the manager roster was not loaded: ${(error as Error).message}`); }
  }
  serviceStopRequestPath(context);
  return Object.freeze({ root: target.root, context, ...(launchSpec ? { launchSpec } : {}), ...(roster ? { roster } : {}) });
}

/** Shared by the native child and its caller-attributed controller preflight. Dynamic
 *  observation time is excluded; identity, policy, agents and pending work remain bound. */
export function managerServiceStopScope(observation: ManagerServiceObservation, withAgents: boolean): string {
  const impact = observation.stopImpact;
  const pending = { lifecycleInFlight: impact.lifecycleInFlight, reservedLaunches: impact.reservedLaunches, retirementsPending: impact.retirementsPending, deprovisioningInFlight: impact.deprovisioningInFlight, staticReconciliationInFlight: impact.staticReconciliationInFlight };
  const blockers = [
    ...(impact.agentScope !== "manager" ? ["owner-filtered-visibility"] : []),
    ...(impact.maintenance !== "active" ? ["maintenance"] : []),
    ...(impact.resumeRequired ? ["resume-required"] : []),
    ...(impact.stopping ? ["stop-in-progress"] : []),
    ...Object.entries(pending).filter(([, count]) => count !== 0).map(([name]) => name),
  ];
  if (blockers.length) throw new CommandFailure("refused", "LIFECYCLE_BLOCKED", impact.agentScope !== "manager" ? "the native manager returned owner-filtered impact; no whole-manager stop policy was accepted" : "the native manager did not meet its full-scope quiescence checks; no stop policy was accepted", {
    target: { managerInstanceId: observation.registration.instanceId },
    native: { detail: { phase: "manager-stop-preflight", blockers, agentScope: impact.agentScope, maintenance: impact.maintenance, resumeRequired: impact.resumeRequired, stopping: impact.stopping, pending } },
    remedy: impact.agentScope !== "manager" ? "ask the stack operator to stop this shared manager, or use an authorized admin-scoped caller; no wider caller was substituted" : "inspect the reported blockers and this manager's native status before another stop; no stop was submitted",
  });
  const agents = impact.agents.map((row) => ({ ...row })).sort((a, b) => {
    const first = JSON.stringify([a.name, a.id, a.lifecycleUid]), second = JSON.stringify([b.name, b.id, b.lifecycleUid]);
    return first < second ? -1 : first > second ? 1 : 0;
  });
  const { observedAt: _observedAt, ...policy } = impact;
  return serviceMetadataDigest({ registration: observation.registration, withAgents, impact: { ...policy, agents } });
}

/** The preserved-exit counterpart of {@link managerServiceStopScope}, shared by the native child and
 *  the controller. It accepts only a fully preserved, whole-manager, quiescent embedding whose
 *  preservation binding is the requested attempt and inventory. The ordinary scope is unchanged. */
export function managerServicePreservedExitScope(observation: ManagerServiceObservation, preserved: { attemptId: string; inventorySha256: string }, held: { attemptId: string; inventorySha256: string } | undefined): string {
  const impact = observation.stopImpact;
  const pending = { lifecycleInFlight: impact.lifecycleInFlight, reservedLaunches: impact.reservedLaunches, retirementsPending: impact.retirementsPending, deprovisioningInFlight: impact.deprovisioningInFlight, staticReconciliationInFlight: impact.staticReconciliationInFlight };
  const blockers = [
    ...(impact.agentScope !== "manager" ? ["owner-filtered-visibility"] : []),
    ...(impact.maintenance !== "preserved" ? ["not-preserved"] : []),
    ...(impact.stopping ? ["stop-in-progress"] : []),
    ...Object.entries(pending).filter(([, count]) => count !== 0).map(([name]) => name),
    ...(!held || held.attemptId !== preserved.attemptId || held.inventorySha256 !== preserved.inventorySha256 ? ["preservation-mismatch"] : []),
  ];
  if (blockers.length) throw new CommandFailure("refused", "LIFECYCLE_BLOCKED", "the native manager is not the fully preserved, quiescent embedding this preserved-exit stop names; no stop policy was accepted", {
    target: { managerInstanceId: observation.registration.instanceId },
    native: { detail: { phase: "manager-preserved-exit-preflight", blockers, agentScope: impact.agentScope, maintenance: impact.maintenance, stopping: impact.stopping, pending } },
    remedy: "inspect this manager's native status and the maintenance journal before another preserved stop; no stop was submitted",
  });
  const agents = impact.agents.map((row) => ({ ...row })).sort((a, b) => {
    const first = JSON.stringify([a.name, a.id, a.lifecycleUid]), second = JSON.stringify([b.name, b.id, b.lifecycleUid]);
    return first < second ? -1 : first > second ? 1 : 0;
  });
  // The binding is named once, outside the impact, so both sides digest the same shape whether or
  // not their observation carried it.
  const { observedAt: _observedAt, preservation: _preservation, ...policy } = impact;
  return serviceMetadataDigest({ registration: observation.registration, kind: "preserved-exit", attemptId: preserved.attemptId, inventorySha256: preserved.inventorySha256, impact: { ...policy, agents } });
}

/** All guards and acceptance publication are synchronous. The caller invokes mgr.stop in the
 *  same event-loop turn, before another native lifecycle callback can change this scope. */
export function acceptManagerServiceStop(manager: Manager, service: ManagerServiceChild): NativeServiceStopRequest {
  const request = readServiceStopRequest(service.context);
  if (!request) throw new CommandFailure("refused", "LIFECYCLE_BLOCKED", "this managed manager has no request-bound native stop handoff; no stop was started");
  if (readServiceStopReceipts(service.context, request).length) throw new CommandFailure("unknown", "OPERATION_UNKNOWN", "this native manager stop request already has phase evidence; it was not replayed");
  const refuse = (): never => {
    publishServiceStopReceipt(service.context, request, "refused");
    throw new CommandFailure("refused", "LIFECYCLE_BLOCKED", "the native manager stop target, reservation or reviewed scope changed; no stop was started");
  };
  if (request.target.pid !== process.pid || assertRecordIdentity(request.target).kind !== "match") throw new CommandFailure("unknown", "OPERATION_UNKNOWN", "the native manager stop handoff does not name this process; no phase was attributed to it");
  const binding = readServiceIdentity(service.context, request.target);
  const observation = manager.localServiceObservation();
  if (!binding || !observation || serviceMetadataDigest(binding.native) !== serviceMetadataDigest({ endpoint: observation.registration.endpoint, instanceId: observation.registration.instanceId, principal: observation.registration.principal })) return refuse();
  const pidPath = canonicalLocalProcessPath(MANAGER_PIDFILE, { root: service.root, space: service.context.space });
  const pid = readLocalRecordSource(pidPath, 128, true)?.toString("utf8").trim();
  const stopper = readLocalRecordSource(stopReservationPath(pidPath), 128, true)?.toString("utf8");
  if (pid !== String(request.target.pid) || stopper !== String(request.stopper.pid) || assertRecordIdentity(request.stopper).kind !== "match") return refuse();
  let scope: string;
  // A preserved request selects the preserved-exit scope. A preserved request that also asks to
  // reap agents is refused, and so is any request the embedding's own state does not support.
  if (request.preserved && request.withAgents) return refuse();
  try { scope = request.preserved ? managerServicePreservedExitScope(observation, request.preserved, manager.localPreservation()) : managerServiceStopScope(observation, request.withAgents); } catch { return refuse(); }
  if (scope !== request.scopeSha256) return refuse();
  const decision = consumeManagerShutdownIntent({ root: service.root, space: service.context.space });
  if (decision.warning || decision.withAgents !== request.withAgents) return refuse();
  publishServiceStopReceipt(service.context, request, "accepted");
  return request;
}

export function bindManagerServiceIdentity(service: ManagerServiceChild): NonNullable<ManagerOptions["onServiceIdentity"]> {
  return (identity) => publishServiceIdentity(service.context, identity);
}

/** Answer request-bound local observations addressed to this exact process. Arm it only after the
 *  manager-serving startup is published. It answers nothing until the manager has its own serve
 *  registration, and stops on dispose. Errors leave the request unanswered, never ready. */
export function armManagerServiceObserver(manager: Manager, service: ManagerServiceChild): () => void {
  const timer = setInterval(() => {
    try {
      if (!manager.localServiceObservation()) return;
      answerServiceObservations(service.context, () => manager.localServiceObservation());
    } catch { /* unanswered: the controller times out with no evidence */ }
  }, 200);
  timer.unref();
  return () => clearInterval(timer);
}
