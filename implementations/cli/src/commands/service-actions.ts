import * as prompts from "@clack/prompts";
import { lstatSync } from "node:fs";
import type { ParsedArgs } from "@cotal-ai/core";
import { CommandFailure, commandFailureReport, isCommandFailure, oneLine, presentationOf, protectedLocalDirectory, renderReport, terminalWidth, writeResult, type Report, type ServiceAdapterKernelStopPlan, type ServiceAdapterStopPlan } from "@cotal-ai/workspace";
import { observeRecordedSupervisor, systemdUserUnitDirectory } from "../lib/service-systemd.js";
import { observeSystemdAttempt } from "../lib/service-systemd-attempt-read.js";
import { inspectSystemdInstall } from "../lib/service-systemd-plan.js";
import { inspectLaunchdInstall } from "../lib/service-launchd-plan.js";
import { installSystemdService } from "../lib/service-systemd-install.js";
import { uninstallSystemdService } from "../lib/service-systemd-uninstall.js";
import { controlSystemdService } from "../lib/service-systemd-control.js";
import { reserveStoppedServiceInstance } from "../lib/service-stopped-allocation.js";
import { selfArgv } from "../lib/self-exec.js";
import { serviceInstallIntentFor, serviceInstallIntentProjection } from "../lib/service-install-intent.js";
import { serviceUninstallIntentFor, serviceUninstallIntentProjection } from "../lib/service-uninstall-intent.js";
import { serviceUnitActionFor } from "../lib/service-unit-action.js";
import { followServiceJournal, readServiceJournal } from "../lib/service-journal.js";
import { followServiceLog } from "./service-log-follow.js";
import { canPrompt } from "./meshes-wizard.js";
import { resolveServiceAdapter, sameServiceAdapterPin } from "../lib/service-adapters.js";
import { serviceDefinitionStore, type ServiceDefinitionSnapshot } from "../lib/service-definitions.js";
import { instanceProjection, observeServiceProcess, serviceInstances, serviceInstanceStore, type ServiceInstanceSnapshot } from "../lib/service-instances.js";
import { assertNoServiceUnitAttempts, assertRestartAdmitted, prepareKernelServiceStop, prepareNativeServiceStop, prepareProcessService, readServiceLog, selectServiceInstance, startProcessService, stopProcessService } from "../lib/service-process.js";
import { untilInputEnds } from "../lib/prompt-input.js";

function instanceView(row: ReturnType<typeof instanceProjection>, title: string): Report {
  return { sections: [{ title, blocks: [{ kind: "fields", rows: [["Definition", row.definition], ["Space", row.space], ["Instance", row.instanceId], ["Execution host", row.executionHost], ["Recorded state", row.recordedState], ["Process observation", row.observedProcess], ["PID", row.pid === null ? "not established" : String(row.pid)], ["Readiness observation", row.readinessObservation], ["Readiness as of", row.readinessAsOf], ["Stop policy", row.stopPolicy], ["Serving endpoint", !row.nativeEndpoint ? "not checked" : row.nativeEvidence === "local-process-receipt" ? "child-reported local receipt; not an attributed endpoint response" : "adapter-checked observation; not a fresh status query"], ["Adapter", row.adapter ? `${row.adapter.name} · ${row.adapter.package ?? "composition root"}@${row.adapter.version}` : "generic process"], ...(row.nativeEndpoint ? [["Endpoint class", row.nativeEndpoint.endpoint], ["Native instance", row.nativeEndpoint.instanceId], ["Native principal", `${row.nativeEndpoint.owner}.${row.nativeEndpoint.actor}`], ["Native lifecycle", row.nativeEndpoint.lifecycleUid], ["Native epoch", String(row.nativeEndpoint.epoch)], ["Adapter observed at", row.adapterObservedAt ?? "not recorded"]] as const : []), ...(row.nativeStop ? [["Native stop", "returned for the original request"], ["Native stop request", row.nativeStop.requestId], ["Native cleanup", row.nativeStop.cleanup]] as const : []), ...(row.stopPolicy === "process" ? row.processStop ? [["Process stop evidence", "recorded signal and original process exit"], ["Recorded stop signal", row.processStop.signal], ["Recorded stop request", row.processStop.requestId], ["Exit observed at", row.processStop.observedAt]] as const : [["Process stop evidence", "not recorded"]] as const : []), ...(row.reportedListener ? [["Reported listener", row.reportedListener.nats.join(", ")], ["Listener evidence", "the pinned child's own launch-bound ports file; not JetStream, trust or endpoint readiness"]] as const : []), ...(row.kernelStop ? [["Broker stop", "exact process exit observed"], ["Broker stop request", row.kernelStop.requestId], ["Broker shutdown trace", row.kernelStop.brokerShutdownTrace], ["Broker cleanup", row.kernelStop.cleanup]] as const : []), ["Recorded supervisor", row.supervisor], ["Supervisor discovery", row.supervisorObservation], ["Recorded unit", row.supervisorRecord.unit ?? "none recorded"], ["Unit file", row.supervisorRecord.fileObservation], ["OS unit state", row.supervisorRecord.osState], ["Autostart", row.supervisorRecord.autostart], ...(row.supervisorRecord.seededGeneration ? [["Private store generation", row.supervisorRecord.seededGeneration]] as const : []), ["Request", row.requestId], ["Original launch", row.launchRequestId]] }, { kind: "lines", lines: ["A process proof is not a serving endpoint. HTTP readiness proves reachability, not listener ownership. An adapter observation names only its checked native lifecycle as of the recorded time. Only the creation-pinned direct process is controlled; this is not a process sandbox or a claim that arbitrary descendants are gone. No recorded supervisor means none assigned by this controller, not a verified absence of external OS supervision. Matching recorded unit bytes prove neither active supervision nor enabled autostart; missing or modified files do not authorize direct-process fallback."] }] }] };
}

export function nativeImpactView(plan: ServiceAdapterStopPlan): Report {
  return { sections: [{ title: "Native service stop impact", blocks: [
    { kind: "fields", rows: [["Scope", plan.evidence === "local-process-receipt" ? "the pinned child's own local receipt; not an attributed endpoint response and not reserved" : "complete native impact observation; not reserved"], ["Native instance", plan.native.instanceId], ["Lifecycle", plan.native.lifecycleUid], ["Epoch", String(plan.native.epoch)], ["Observed at", plan.observedAt], ["Agent policy", plan.withAgents ? "request all native agent stops" : "native runtime default"], ["Scope fingerprint", plan.scopeSha256]] },
    plan.subjects.length ? { kind: "table", columns: [{ key: "name", label: "Agent" }, { key: "id", label: "Full identity" }, { key: "uid", label: "Lifecycle" }, { key: "action", label: "Requested seat action" }], rows: plan.subjects.map((row) => ({ name: row.name, id: row.id, uid: row.lifecycleUid, action: { text: row.action, tone: row.action === "release-custody" ? "waiting" : "failed" } })) } : { kind: "lines", lines: ["No managed agent rows in this complete observation."] },
    { kind: "lines", lines: ["The child rechecks this scope and native incarnation before stopping. Changed scope refuses without a broader policy. A returned native stop and original process exit do not establish authority, lease or descendant cleanup."] },
  ] }] };
}

export function kernelImpactView(plan: ServiceAdapterKernelStopPlan): Report {
  return { sections: [{ title: "Broker stop scope", blocks: [
    { kind: "fields", rows: [["Scope", "exact pinned broker process; not reserved"], ["Space", plan.binding.space], ["Root", plan.binding.root], ["Broker", plan.binding.server], ["Configuration digest", plan.binding.configSha256], ["Observed at", plan.observedAt], ["Scope fingerprint", plan.scopeSha256]] },
    { kind: "lines", lines: ["Stopping the broker disconnects every client of this space. The stop rechecks this scope and the exact process before one SIGTERM, then waits for that process to exit. An observed exit is not a broker acknowledgement or store, registry or credential cleanup. A process that does not exit is retained as unknown, with no force kill or restart."] },
  ] }] };
}

function previewNativeInstall(definition: ServiceDefinitionSnapshot, selected: ServiceInstanceSnapshot | undefined, presentation: ReturnType<typeof presentationOf>, commandName: string): void {
  if (!selected) {
    if (process.platform !== "linux" && process.platform !== "darwin") throw new CommandFailure("refused", "UNSUPPORTED", "native user-unit installation inspection requires Linux or macOS; no instance was allocated");
    if (definition.record.value.launch.type !== "process" || Object.keys(definition.record.value.envRefs ?? {}).length || definition.record.value.credentialRef) throw new CommandFailure("refused", "UNSUPPORTED", "native unit allocation requires a direct process without host environment or credential references");
    prepareProcessService(definition);
    if (process.platform === "linux") systemdUserUnitDirectory();
    let cli: string[];
    try { cli = selfArgv(); }
    catch { throw new CommandFailure("refused", "UNSUPPORTED", "the native unit inspection needs a durable installed Cotal executable before any instance can be allocated"); }
    if (cli.length !== 2) throw new CommandFailure("refused", "UNSUPPORTED", "the native unit cannot be installed from a transient loader or extra Node launch flags");
    const target = { space: definition.record.value.space, name: definition.name, instanceId: null };
    writeResult(presentation, { command: commandName, target, result: { kind: "service-install-inspection", dryRun: true, ...target, wouldAllocateStoppedInstance: true, unit: null, unitPath: null, privateSeed: "not-created", autostart: "not-enabled", serviceStarted: false }, completeness: "partial", partial: { message: "No instance exists. Apply would need to allocate one stopped full ID before rendering a unit; no ID, source digest or ownership was inferred by this preview." } }, (): Report => ({ sections: [{ title: "Proposed native service allocation", blocks: [{ kind: "fields", rows: [["Space", target.space], ["Definition", target.name], ["Instance", "not allocated"], ["Unit", "not rendered"], ["Start", "not attempted"]] }, { kind: "lines", lines: ["Install would reserve a stopped full instance ID first. This inspection created no instance, unit, private state or native autostart link; preview is not installation authority."] }] }] }));
    return;
  }
  if (process.platform === "darwin") {
    const planned = inspectLaunchdInstall(definition, selected);
    const { target, unit, unitPath, privateHome, directoryState, existing } = planned;
    const result = { kind: "service-install-inspection" as const, dryRun: true, ...target, unit: unit.unit, unitPath, unitSha256: unit.sha256, privateHome, directoryState, existing,
      unitSource: "rendered-not-written", privateSeed: "not-created", receipt: "not-created", autostart: "not-enabled", serviceStarted: false };
    writeResult(presentation, { command: commandName, target, result, completeness: "partial", partial: { message: "The read-only LaunchAgent candidate does not establish a user domain, parent ownership, native registration, private seed or receipt. macOS install apply remains unavailable." } }, (data): Report => ({ sections: [{ title: "Proposed native LaunchAgent", blocks: [
      { kind: "fields", rows: [["Space", data.space], ["Definition", data.name], ["Instance", data.instanceId], ["Label", data.unit], ["Plist", data.unitPath], ["LaunchAgents directory", data.directoryState], ["Existing file", data.existing], ["Source digest", data.unitSha256], ["Private state candidate", data.privateHome], ["Install", "not attempted"], ["Autostart", "not enabled"]] },
      { kind: "lines", lines: ["The plist was rendered but not written. No user domain or existing job was queried, and no job was loaded or started. A matching path alone would not prove ownership."] },
    ] }] }));
    return;
  }
  if (process.platform !== "linux") throw new CommandFailure("refused", "UNSUPPORTED", "this platform has no native service installation preview; no supervisor was substituted");
  const planned = inspectSystemdInstall(definition, selected);
  const { target, unit, unitPath, privateHome, environmentFile, environment, existing } = planned;
  const { space, name } = target;
  const result = { kind: "service-install-inspection" as const, dryRun: true, ...target, unit: unit.unit, unitPath, unitSha256: unit.sha256, privateHome, environmentFile, environmentSha256: environment.sha256, existing,
    managerEnvironment: "read-only", unitSource: "rendered-not-written", privateSeed: "not-created", receipt: "not-created", daemonReload: "not-requested", autostart: "not-enabled", serviceStarted: false };
  writeResult(presentation, { command: commandName, target, result, completeness: "partial", partial: { message: "This read-only unit candidate is not an installation plan: parent ownership, existing unit provenance, private seed, receipt intent and native enable state are not established." } }, (data): Report => ({ sections: [{ title: "Proposed native service unit", blocks: [
    { kind: "fields", rows: [["Space", space], ["Definition", name], ["Instance", data.instanceId ?? "not established"], ["Unit", data.unit], ["Unit file", data.unitPath], ["Existing file", data.existing], ["Source digest", data.unitSha256], ["Private state candidate", data.privateHome], ["Environment file candidate", data.environmentFile], ["Environment digest", data.environmentSha256], ["Install", "not attempted"], ["Autostart", "not enabled"]] },
    { kind: "lines", lines: ["The user manager supplied its config directory, but the unit's parents, existing file, private seed and supervisor receipt are not installation authority. No file was written, unit enabled or process started. Bare install still refuses."] },
  ] }] }));
}

function previewSystemdUninstall(definition: ServiceDefinitionSnapshot, selected: ServiceInstanceSnapshot, presentation: ReturnType<typeof presentationOf>, commandName: string): void {
  const { space } = definition.record.value, target = { space, name: definition.name, instanceId: selected.name };
  const pending = serviceInstallIntentFor(space, selected.name), removal = serviceUninstallIntentFor(space, selected.name);
  if (pending || removal) throw new CommandFailure("refused", "LIFECYCLE_BLOCKED", "an installation or removal attempt is retained; its unit, private store or native enable effect may be incomplete", { target: { ...target, attemptId: (pending ?? removal)!.record.value.attemptId, step: (pending ?? removal)!.record.value.step, position: (pending ?? removal)!.record.value.position } });
  const action = serviceUnitActionFor(space, selected.name);
  if (action) throw new CommandFailure("refused", "LIFECYCLE_BLOCKED", "an earlier native unit action has not settled; its process and user-manager effects were not treated as stopped", { target: { ...target, attemptId: action.record.value.attemptId, operation: action.record.value.operation, position: action.record.value.position } });
  const row = instanceProjection(selected), recorded = row.supervisorRecord;
  if (recorded.mechanism === "none-recorded") throw new CommandFailure("refused", "TARGET_NOT_FOUND", "this exact instance has no owned supervisor receipt; no native unit was inferred from its name", { target });
  if (recorded.mechanism !== "systemd-user") throw new CommandFailure("refused", "UNSUPPORTED", "this source has no native removal inspection for the recorded supervisor mechanism", { target: { ...target, mechanism: recorded.mechanism } });
  if (recorded.fileObservation !== "matches-recorded-bytes") throw new CommandFailure("refused", "CONFLICT", "the recorded unit is missing, modified, unreadable or belongs to another host; it was not considered removable", { target: { ...target, unit: recorded.unit, fileObservation: recorded.fileObservation } });
  const native = observeRecordedSupervisor(selected.record.value, recorded);
  let privateStore: "owned-private" | "missing" | "unavailable-or-unattributed" = "unavailable-or-unattributed";
  try {
    const stat = lstatSync(recorded.privateHome!);
    protectedLocalDirectory(recorded.privateHome!);
    if (process.getuid !== undefined && stat.isDirectory() && !stat.isSymbolicLink() && stat.uid === process.getuid() && (stat.mode & 0o077) === 0) privateStore = "owned-private";
  } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") privateStore = "missing"; }
  const result = { kind: "service-uninstall-inspection" as const, dryRun: true, ...target, unit: recorded.unit, unitPath: recorded.unitPath, fileObservation: recorded.fileObservation,
    native, privateStore, process: row.observedProcess, storedDefinition: true, receiptRetained: true, unitDisabled: false, unitRemoved: false, serviceStopped: false, autostart: "not-proven" as const };
  writeResult(presentation, { command: commandName, target, result, completeness: "partial", partial: { message: "The unchanged owned unit and one native status snapshot do not reserve a stopped unit or authorize a disable/remove. Bare uninstall is not integrated." } }, (data): Report => ({ sections: [{ title: "Owned unit removal inspection", blocks: [
    { kind: "fields", rows: [["Space", space], ["Definition", definition.name], ["Instance", selected.name], ["Unit", data.unit ?? "not recorded"], ["Recorded file", data.unitPath ?? "not recorded"], ["File", data.fileObservation], ["Private store", data.privateStore], ["User manager", data.native.state], ["Active state", data.native.activeState ?? "not established"], ["Unit file state", data.native.unitFileState ?? "not established"], ["Process", data.process], ["Receipt", "retained"], ["Removal", "not attempted"]] },
    { kind: "lines", lines: ["Only the recorded unit and its private-store directory were inspected. An owned directory is not proof that every child is unchanged. This moment's systemd status does not reserve a stopped unit or safe removal. No unit, instance or definition was changed."] },
  ] }] }));
}

export async function serviceAction(args: ParsedArgs, space: string, commandName = "service"): Promise<void> {
  const [mode, name] = args.positionals as [string, string];
  const values = args.values as { instance?: string; "new-instance"?: boolean; foreground?: boolean; "with-agents"?: boolean; "dry-run"?: boolean; yes?: boolean; tail?: string; follow?: boolean; json?: boolean };
  const presentation = presentationOf(args.values);
  const store = serviceDefinitionStore(space), definition = store.read(name);
  if (!definition) throw new CommandFailure("refused", "TARGET_NOT_FOUND", "no saved service definition resolves this name in the selected space; no process or extension was started", { target: { space, name }, remedy: name === "web" ? "save the dashboard explicitly with cotal service add web --preset web and its required registered root, protected credential file and read-only intent; if its provider is absent, use cotal ext add @cotal-ai/web" : "add a supported service definition explicitly before starting it" });
  const rows = serviceInstances(space, name);
  let id = values.instance;
  if (!id && rows.length > 1 && !values["new-instance"] && canPrompt() && presentation !== "json") {
    const selected = await untilInputEnds((signal) => prompts.select({ message: `Choose the full owned instance of ${oneLine(name)}`, options: rows.map((row) => ({ value: row.name, label: row.name, hint: `${row.record.value.host.name} · ${observeServiceProcess(row.record.value)}` })), signal }));
    if (prompts.isCancel(selected)) return cancelled();
    id = selected;
  }
  const selected = values["new-instance"] ? undefined : selectServiceInstance(rows, id, mode === "start" || mode === "install");
  const target = { space, name, instanceId: selected?.name ?? null };
  if (["start", "stop", "restart"].includes(mode)) assertNoServiceUnitAttempts(space, name);
  if (mode === "install" && values["dry-run"]) return previewNativeInstall(definition, selected, presentation, commandName);
  if (mode === "uninstall" && values["dry-run"]) return previewSystemdUninstall(definition, selected!, presentation, commandName);
  if (mode === "install") {
    if (process.platform !== "linux") throw new CommandFailure("refused", "UNSUPPORTED", "native service installation currently needs the supported Linux user manager; no detached process was substituted", { target });
    const allocated = selected === undefined;
    if (allocated) {
      systemdUserUnitDirectory();
      let cli: string[];
      try { cli = selfArgv(); }
      catch { throw new CommandFailure("refused", "UNSUPPORTED", "the native user unit requires a durable installed Cotal executable before allocating an instance"); }
      if (cli.length !== 2) throw new CommandFailure("refused", "UNSUPPORTED", "the native user unit cannot allocate from a transient loader or extra Node launch flags");
    }
    const owned = selected ?? reserveStoppedServiceInstance(definition);
    let installed: ReturnType<typeof installSystemdService>;
    try { installed = installSystemdService(definition, owned); }
    catch (error) {
      if (!allocated) throw error;
      const uncertain = !isCommandFailure(error) || error.outcome === "unknown";
      throw new CommandFailure(uncertain ? "unknown" : "partial", uncertain ? "OPERATION_UNKNOWN" : "OPERATION_PARTIAL", "a stopped full instance was allocated, but its native unit installation did not confirm completion; no second instance or unit attempt was made", { target: { ...target, instanceId: owned.name, installation: isCommandFailure(error) ? error.target : null }, changed: [{ kind: "stopped-instance-allocation", instanceId: owned.name }, ...(isCommandFailure(error) ? error.changed ?? [] : [])], ...(isCommandFailure(error) && error.native ? { native: error.native } : {}), remedy: "inspect the exact allocated instance and retained installation attempt before another action" });
    }
    writeResult(presentation, { command: commandName, target: { ...target, instanceId: owned.name }, result: { kind: "service-install", ...installed, allocatedStoppedInstance: allocated } }, (result): Report => ({ sections: [{ title: "Native service installed", blocks: [
      { kind: "fields", rows: [["Space", result.space], ["Definition", result.definition], ["Instance", result.instanceId], ["Unit", result.unit], ["Unit file", result.unitPath], ["Unit-file state", result.unitFileState], ["Service started", "no"], ["Private generation", result.generation], ["Attempt", result.attemptId]] },
      { kind: "lines", lines: ["The unit-file state was observed enabled without --now. Starting this exact instance is a separate service start action. Effective reboot activation depends on the user manager's login/linger policy and was not verified."] },
    ] }] }));
    return;
  }
  if (mode === "uninstall") {
    if (process.platform !== "linux") throw new CommandFailure("refused", "UNSUPPORTED", "native service removal currently needs the supported Linux user manager; no unit or private store was touched", { target });
    if (!values.yes && (!canPrompt() || presentation === "json")) throw new CommandFailure("refused", "USAGE_INVALID", "native uninstall requires --yes outside an interactive terminal", { target });
    if (!values.yes) {
      const answer = await untilInputEnds((signal) => prompts.confirm({ message: `Disable and remove the exact owned unit for ${oneLine(name)} instance ${selected!.name}? The saved definition remains.`, initialValue: false, signal }));
      if (prompts.isCancel(answer) || !answer) return cancelled();
    }
    const removed = uninstallSystemdService(definition, selected!);
    writeResult(presentation, { command: commandName, target: { ...target, instanceId: selected!.name }, result: { kind: "service-uninstall", ...removed } }, (result): Report => ({ sections: [{ title: "Native service uninstalled", blocks: [
      { kind: "fields", rows: [["Space", result.space], ["Definition", result.definition], ["Instance", result.instanceId], ["Unit", result.unit], ["Native load state", result.nativeLoadState], ["Unit removed", "yes"], ["Private store removed", "yes"], ["Definition retained", "yes"], ["Attempt", result.attemptId]] },
      { kind: "lines", lines: ["Only unchanged owned unit and private-store material was removed after the original service stopped. The saved definition and instance record remain."] },
    ] }] }));
    return;
  }
  if (mode === "status") {
    const result = instanceProjection(selected!);
    const pending = serviceInstallIntentFor(space, selected!.name)?.record.value;
    const installIntent = pending ? serviceInstallIntentProjection(pending) : null;
    const removal = serviceUninstallIntentFor(space, selected!.name)?.record.value;
    const uninstallIntent = removal ? serviceUninstallIntentProjection(removal) : null;
    const action = serviceUnitActionFor(space, selected!.name)?.record.value;
    const unitAction = action ? { attemptId: action.attemptId, unit: action.unit, unitPath: action.unitPath, operation: action.operation, position: action.position, targetGeneration: action.targetGeneration ?? null, updatedAt: action.updatedAt } : null;
    const installObservation = pending ? observeSystemdAttempt(pending) : null;
    const uninstallObservation = removal ? observeSystemdAttempt(removal) : null;
    const actionObservation = action ? observeSystemdAttempt(action) : null;
    const nativeSupervisor = observeRecordedSupervisor(selected!.record.value, result.supervisorRecord);
    const incomplete = installIntent !== null || uninstallIntent !== null || unitAction !== null || result.supervisorRecord.mechanism !== "none-recorded" && (nativeSupervisor.state !== "observed" || nativeSupervisor.daemonReloadRequired || nativeSupervisor.dropInsReported || nativeSupervisor.mainProcessAttribution === "different-or-unattributed" || nativeSupervisor.mainProcessAttribution === "not-reported" && result.observedProcess === "running");
    writeResult(presentation, { command: commandName, target, result: { kind: "service-status", ...result, nativeSupervisor, installIntent, uninstallIntent, unitAction, installObservation, uninstallObservation, actionObservation }, ...(incomplete ? { completeness: "partial" as const, partial: { message: installIntent ? "A service installation attempt is retained; its submitted or acknowledged effects are not a completed owned supervisor. Inspect its private store and native unit before any retry." : uninstallIntent ? "A native removal attempt is retained; a disabled or missing unit is not proof its private store and receipt were cleaned. Inspect each named step before reconciliation." : unitAction ? "A native service action is retained; its submission and unit state require reconciliation before a new control request." : "The recorded supervisor could not be established as the unchanged complete loaded configuration with an attributed main process. No direct-process fallback or readiness was inferred." } } : {}) }, (row): Report => ({ sections: [
      ...instanceView(row, "Service instance").sections,
      ...(row.installIntent ? [{ title: "Retained installation attempt", blocks: [{ kind: "fields" as const, rows: [["Attempt", row.installIntent.attemptId], ["Unit", row.installIntent.unit], ["Unit file", row.installIntent.unitPath], ["Private store", row.installIntent.privateHome], ["Environment file", row.installIntent.environmentFile], ["Generation", row.installIntent.generation], ["Step", row.installIntent.step], ["Position", row.installIntent.position], ["Last acknowledged", row.installIntent.lastAcknowledgedStep ?? "none"], ["Updated", row.installIntent.updatedAt]] as const }, { kind: "lines" as const, lines: ["A submitted step may have affected the private store or native user manager. No absent unit, safe retry or complete installation was inferred."] }] }] : []),
      ...(row.installObservation ? [{ title: "Installation unit observation", blocks: [{ kind: "fields" as const, rows: [["Unit source", row.installObservation.file], ["Private directory", row.installObservation.privateStore], ["User manager", row.installObservation.native], ["Load state", row.installObservation.loadState ?? "not checked"], ["Active state", row.installObservation.activeState ?? "not checked"], ["Unit-file state", row.installObservation.unitFileState ?? "not checked"], ["Fragment", row.installObservation.fragment], ["Reload needed", row.installObservation.daemonReloadRequired === null ? "not checked" : row.installObservation.daemonReloadRequired ? "reported yes" : "reported no"], ["Observed", row.installObservation.observedAt]] as const }, { kind: "lines" as const, lines: [row.installObservation.reason ?? "This exact-unit read is not an ownership grant or a reservation for another native action."] }] }] : []),
      ...(row.uninstallIntent ? [{ title: "Retained native removal", blocks: [{ kind: "fields" as const, rows: [["Attempt", row.uninstallIntent.attemptId], ["Unit", row.uninstallIntent.unit], ["Unit file", row.uninstallIntent.unitPath], ["Private store", row.uninstallIntent.privateHome], ["Step", row.uninstallIntent.step], ["Position", row.uninstallIntent.position], ["Last acknowledged", row.uninstallIntent.lastAcknowledgedStep ?? "none"], ["Updated", row.uninstallIntent.updatedAt]] as const }, { kind: "lines" as const, lines: ["A disabled or missing unit cannot clear this removal attempt without verifying the private store and final receipt. No native effect was retried."] }] }] : []),
      ...(row.uninstallObservation ? [{ title: "Removal unit observation", blocks: [{ kind: "fields" as const, rows: [["Unit source", row.uninstallObservation.file], ["Private directory", row.uninstallObservation.privateStore], ["User manager", row.uninstallObservation.native], ["Load state", row.uninstallObservation.loadState ?? "not checked"], ["Active state", row.uninstallObservation.activeState ?? "not checked"], ["Unit-file state", row.uninstallObservation.unitFileState ?? "not checked"], ["Fragment", row.uninstallObservation.fragment], ["Reload needed", row.uninstallObservation.daemonReloadRequired === null ? "not checked" : row.uninstallObservation.daemonReloadRequired ? "reported yes" : "reported no"], ["Observed", row.uninstallObservation.observedAt]] as const }, { kind: "lines" as const, lines: [row.uninstallObservation.reason ?? "This exact-unit read is not proof that the private store or supervisor receipt was removed."] }] }] : []),
      ...(row.unitAction ? [{ title: "Retained native action", blocks: [{ kind: "fields" as const, rows: [["Attempt", row.unitAction.attemptId], ["Unit", row.unitAction.unit], ["Unit file", row.unitAction.unitPath], ["Operation", row.unitAction.operation], ["Position", row.unitAction.position], ["Target generation", row.unitAction.targetGeneration ?? "not applicable"], ["Updated", row.unitAction.updatedAt]] as const }, { kind: "lines" as const, lines: ["A returned native request and settled service process are separate observations. This retained action does not authorize a retry."] }] }] : []),
      ...(row.actionObservation ? [{ title: "Action unit observation", blocks: [{ kind: "fields" as const, rows: [["Unit source", row.actionObservation.file], ["Private directory", row.actionObservation.privateStore], ["User manager", row.actionObservation.native], ["Load state", row.actionObservation.loadState ?? "not checked"], ["Active state", row.actionObservation.activeState ?? "not checked"], ["Unit-file state", row.actionObservation.unitFileState ?? "not checked"], ["Fragment", row.actionObservation.fragment], ["Reload needed", row.actionObservation.daemonReloadRequired === null ? "not checked" : row.actionObservation.daemonReloadRequired ? "reported yes" : "reported no"], ["Observed", row.actionObservation.observedAt]] as const }, { kind: "lines" as const, lines: [row.actionObservation.reason ?? "This read does not establish whether a submitted start, stop or reseed committed its own terminal result."] }] }] : []),
      ...(row.supervisorRecord.mechanism === "none-recorded" ? [] : [{ title: "Native supervisor observation", blocks: [{ kind: "fields" as const, rows: [["Observation", row.nativeSupervisor.state], ["Observed at", row.nativeSupervisor.observedAt], ["Unit", row.nativeSupervisor.unit ?? "not established"], ["Load state", row.nativeSupervisor.loadState ?? "not established"], ["Active state", row.nativeSupervisor.activeState ?? "not established"], ["Substate", row.nativeSupervisor.subState ?? "not established"], ["Unit-file state", row.nativeSupervisor.unitFileState ?? "not established"], ["Main PID", row.nativeSupervisor.mainPid === null ? "not reported or not established" : String(row.nativeSupervisor.mainPid)], ["Main process attribution", row.nativeSupervisor.mainProcessAttribution], ["Invocation", row.nativeSupervisor.invocationId ?? "not reported"], ["Reload required", row.nativeSupervisor.daemonReloadRequired === null ? "not checked" : row.nativeSupervisor.daemonReloadRequired ? "reported yes" : "reported no"], ["Drop-ins", row.nativeSupervisor.dropInsReported === null ? "not checked" : row.nativeSupervisor.dropInsReported ? "reported; contents not verified" : "none reported"]] as const }, { kind: "lines" as const, lines: [row.nativeSupervisor.reason ?? "This is one native user-manager observation, not a process/endpoint readiness response or a reservation. Unit-file state is reported as received; it is not independently proved login/reboot autostart. No reload, unit action or process signal was performed."] }] }]),
    ] }));
    return;
  }
  if (mode === "logs") {
    const recorded = instanceProjection(selected!).supervisorRecord;
    if (recorded.mechanism !== "none-recorded") {
      const tail = values.tail === undefined ? 100 : Number(values.tail);
      if (values.follow) return followServiceJournal(selected!, recorded, presentation, tail);
      const result = readServiceJournal(selected!, recorded, tail);
      writeResult(presentation, { command: commandName, target, result, ...(result.partial ? { completeness: "partial" as const, partial: { message: "Only bounded readable records from the original invocation are shown; a native query, diagnostic, record or byte boundary remains incomplete. Native diagnostic bodies were withheld." } } : {}) }, (row): Report => ({ sections: [{ title: "Original service invocation journal", blocks: [
        { kind: "fields", rows: [["Definition", name], ["Space", space], ["Instance", selected!.name], ["Unit", row.unit], ["Invocation", row.invocationId], ["Boot", row.boot], ["Original launch", row.launchRequestId], ["Scope", row.scope], ["Records", String(row.entries.length)], ["Requested tail", String(row.requestedTail)]] },
        { kind: "lines", lines: row.entries.length ? row.entries.map((item) => `${item.realtimeUs}  ${item.cursor}  ${(typeof item.message === "string" ? item.message : JSON.stringify(item.message)).split("\n").map(oneLine).join("\n")}`) : ["No matching records in this bounded readable query. This is not proof that the invocation produced no output."] },
        { kind: "lines", lines: ["Journal retention and access completeness are not established. Messages may contain secrets; this is a local authorized read, not a redacted log or upload. No current or replacement invocation was adopted, no direct-child file was read, and the service was not controlled."] },
      ] }] }));
      return;
    }
    if (definition.record.value.launch.type === "adapter") {
      const launch = definition.record.value.launch, adapter = resolveServiceAdapter(launch.adapter, launch.options);
      if (!sameServiceAdapterPin(selected!.record.value.adapter, adapter.pin) || !adapter.declaration.capabilities.logs) throw new CommandFailure("refused", "UNSUPPORTED", "the pinned adapter does not declare log access through this controller, or its declaration changed; no different provider was loaded", { target });
    }
    if (values.follow) return followServiceLog(selected!, presentation, values.tail === undefined ? 100 : Number(values.tail));
    const row = instanceProjection(selected!), log = readServiceLog(space, selected!.name, values.tail === undefined ? 100 : Number(values.tail));
    writeResult(presentation, { command: commandName, target, result: { kind: "service-logs", instance: row, ...log, encoding: "utf8-with-replacement", collection: row.foreground ? "foreground output is not captured in this log" : "owned background stdout/stderr" }, ...(log.omittedBytes ? { completeness: "partial", partial: { message: "The bounded log tail does not contain the complete file; earlier or partial leading bytes were omitted." } } : {}) }, (result): Report => ({ sections: [{ title: "Service log tail", blocks: [{ kind: "fields", rows: [["Definition", name], ["Instance", row.instanceId], ["Host", row.executionHost], ["Collection", result.collection], ["Encoding", result.encoding]] }, { kind: "lines", lines: result.lines.length ? result.lines : ["No captured log lines in this bounded read."] }, { kind: "lines", lines: [{ text: "Service-produced output may contain secrets. This is a local authorized read, not a secret-redacted log or an upload.", tone: "hint" }] }] }] }));
    return;
  }
  const supervisor = selected ? instanceProjection(selected).supervisorRecord : null;
  if (supervisor && supervisor.mechanism !== "none-recorded" && ["start", "stop", "restart"].includes(mode)) {
    if (supervisor.mechanism !== "systemd-user" || process.platform !== "linux") throw new CommandFailure("refused", "UNSUPPORTED", "this recorded supervisor has no supported native controller on this platform; no direct process fallback was used", { target: { ...target, mechanism: supervisor.mechanism } });
    if (values.foreground || values["with-agents"] || values["new-instance"]) throw new CommandFailure("refused", "USAGE_INVALID", "a recorded native direct-process unit does not accept foreground, agent-reap or new-instance options", { target });
    if (values["dry-run"]) {
      const row = instanceProjection(selected!);
      const native = observeRecordedSupervisor(selected!.record.value, row.supervisorRecord);
      writeResult(presentation, { command: commandName, target, result: { kind: "service-native-operation-preview", operation: mode, dryRun: true, instance: row, native, changed: false }, completeness: "partial", partial: { message: "This exact-unit status read reserves no native state or process identity. A real action rechecks its receipt, source and native invocation before submission." } }, (): Report => ({ sections: [{ title: "Native service operation preview", blocks: [{ kind: "fields", rows: [["Action", mode], ["Definition", name], ["Instance", selected!.name], ["Unit", row.supervisorRecord.unit ?? "not recorded"], ["Unit state", native.activeState ?? native.state], ["Autostart", native.unitFileState ?? "not checked"], ["Process", row.observedProcess]] }, { kind: "lines", lines: ["No native request, process signal or private-store seed ran. This observation does not authorize a later action without fresh checks."] }] }] }));
      return;
    }
    if ((mode === "stop" || mode === "restart") && !values.yes && (!canPrompt() || presentation === "json")) throw new CommandFailure("refused", "USAGE_INVALID", `${mode} requires --yes outside an interactive terminal`, { target });
    if ((mode === "stop" || mode === "restart") && !values.yes) {
      const answer = await untilInputEnds((signal) => prompts.confirm({ message: `${mode === "stop" ? "Stop" : "Restart"} the exact owned unit ${supervisor.unit} for ${oneLine(name)} instance ${selected!.name}?`, initialValue: false, signal }));
      if (prompts.isCancel(answer) || !answer) return cancelled();
    }
    let stopped: Awaited<ReturnType<typeof controlSystemdService>> | undefined;
    let result: Awaited<ReturnType<typeof controlSystemdService>>;
    if (mode === "restart") {
      stopped = await controlSystemdService(definition, selected!, "stop");
      try { result = await controlSystemdService(definition, stopped.instance, "start"); }
      catch (error) {
        const uncertain = !isCommandFailure(error) || error.outcome === "unknown";
        throw new CommandFailure(uncertain ? "unknown" : "partial", uncertain ? "OPERATION_UNKNOWN" : "OPERATION_PARTIAL", "the original owned unit was stopped, but its replacement did not confirm startup; neither unit action was retried", { target: { ...target, unit: supervisor.unit, stoppedAttemptId: stopped.attemptId, next: isCommandFailure(error) ? error.target : null }, changed: stopped.noOp ? isCommandFailure(error) ? error.changed ?? [] : [] : [{ kind: "native-unit-stopped", instanceId: selected!.name, attemptId: stopped.attemptId }, ...(isCommandFailure(error) ? error.changed ?? [] : [])], ...(isCommandFailure(error) && error.native ? { native: error.native } : {}), remedy: "inspect the exact original unit and both retained native action attempts before another start" });
      }
    } else result = await controlSystemdService(definition, selected!, mode as "start" | "stop");
    const row = instanceProjection(result.instance), native = observeRecordedSupervisor(result.instance.record.value, row.supervisorRecord);
    writeResult(presentation, { command: commandName, target, result: { kind: `service-${mode}`, ...row, nativeSupervisor: native, nativeAttemptId: result.attemptId, originalStopAttemptId: stopped?.attemptId ?? null, reseed: result.reseed ?? null }, noOp: result.noOp }, (data): Report => ({ sections: [
      ...instanceView(data, mode === "stop" ? "Owned native unit stopped" : "Owned native unit started").sections,
      { title: "Native unit result", blocks: [{ kind: "fields", rows: [["Unit", supervisor.unit ?? "not recorded"], ["Active state", data.nativeSupervisor.activeState ?? "not checked"], ["Autostart", data.nativeSupervisor.unitFileState ?? "not checked"], ["Native attempt", data.nativeAttemptId ?? "no-op"], ["Private reseed", data.reseed?.noOp === false ? `completed ${data.reseed.generation}` : "not requested"]] }] },
    ] }));
    return;
  }
  const prepared = mode === "start" || mode === "restart" ? prepareProcessService(definition) : undefined;
  if (prepared?.adapter) {
    const adapter = prepared.adapter;
    if (values["new-instance"] && !adapter.declaration.capabilities.multiInstance || values.foreground && !adapter.declaration.capabilities.foreground) throw new CommandFailure("refused", "UNSUPPORTED", "the adapter does not declare the requested multi-instance or foreground capability; no provider code was loaded", { target });
    if (selected && !sameServiceAdapterPin(selected.record.value.adapter, adapter.pin)) throw new CommandFailure("refused", "CONFLICT", "the selected instance pins a different adapter declaration or package version; it was not stopped or adopted", { target });
  }
  const declaredStop = prepared?.adapter ?? (definition.record.value.launch.type === "adapter" ? resolveServiceAdapter(definition.record.value.launch.adapter, definition.record.value.launch.options) : undefined);
  if (values["with-agents"] && declaredStop?.declaration.stop !== "native") throw new CommandFailure("refused", "UNSUPPORTED", "--with-agents requires this selected adapter's native stop policy; generic descendant signals are not supported", { target });
  if (values["dry-run"]) {
    const row = selected ? instanceProjection(selected) : null;
    if (row && !["running", "gone", "previous-boot", "foreign-pid"].includes(row.observedProcess)) throw new CommandFailure("refused", "LIFECYCLE_BLOCKED", "the selected instance is unresolved or foreign; a safe process effect cannot be previewed", { target });
    writeResult(presentation, { command: commandName, target, result: { kind: "service-operation-preview", operation: mode, dryRun: true, instance: row, newInstanceWouldBeAllocated: mode === "start" && !selected, allocated: false, signalled: false, launch: definition.record.value.launch.type, readiness: definition.record.value.readiness.type, osSupervisor: "not-checked", recordedSupervisor: row?.supervisor ?? null, adapter: prepared?.adapter?.pin ?? selected?.record.value.adapter ?? null, providerCodeLoaded: false } }, (result): Report => ({ sections: [{ title: "Service operation preview", blocks: [{ kind: "fields", rows: [["Action", result.operation], ["Definition", name], ["Space", space], ["Instance", row?.instanceId ?? "would be assigned; not allocated"], ["Process observation", row?.observedProcess ?? "no instance selected"], ["Readiness policy", result.readiness], ["Recorded supervisor", result.recordedSupervisor ?? "no instance selected"], ["Supervisor discovery", result.osSupervisor]] }, { kind: "lines", lines: ["No provider code was imported, no process was launched or signalled and no instance record was created. Cached adapter metadata is not a resolved executable launch plan. No native endpoint readiness, manager-impact query or descendant cleanup was inferred. A native stop still requires its live caller-scoped preflight and confirmation."] }] }] }));
    return;
  }
  // A restart whose original process is already gone stops nothing, so it asks for nothing.
  const confirmStop = mode === "stop" || mode === "restart" && !["gone", "previous-boot", "foreign-pid"].includes(observeServiceProcess(selected!.record.value));
  if (confirmStop && !values.yes && (!canPrompt() || presentation === "json")) throw new CommandFailure("refused", "USAGE_INVALID", `${mode} requires --yes outside an interactive terminal`, { target, remedy: `confirm with cotal svc ${mode} ${name} --yes, or preview it with --dry-run` });
  if (mode === "restart") assertRestartAdmitted(definition);
  const nativePlan = mode === "stop" || mode === "restart" ? await prepareNativeServiceStop(definition, selected!, values["with-agents"] === true) : undefined;
  const kernelPlan = mode === "stop" || mode === "restart" ? await prepareKernelServiceStop(definition, selected!) : undefined;
  // The impact is the first report the operation prints, so it carries the space's Mesh line.
  const impact = [...(nativePlan ? nativeImpactView(nativePlan).sections : []), ...(kernelPlan ? kernelImpactView(kernelPlan).sections : [])];
  if (impact.length && presentation !== "json") console.log(renderReport({ space, sections: impact }, presentation, terminalWidth(process.stdout)));
  if (confirmStop && !values.yes) {
    const answer = await untilInputEnds((signal) => prompts.confirm({ message: `${mode === "stop" ? "Stop" : "Restart"} ${oneLine(name)} instance ${selected!.name} on ${oneLine(selected!.record.value.host.name)}? ${nativePlan ? "Apply the displayed native seat policy only if its full scope is unchanged." : kernelPlan ? "Signal only the displayed broker process, only if its scope is unchanged." : "Only its pinned direct process is controlled."}`, initialValue: false, signal }));
    if (prompts.isCancel(answer) || !answer) return cancelled();
  }
  if (mode === "stop") {
    const stopped = await stopProcessService(definition, selected!, undefined, { plan: nativePlan, withAgents: values["with-agents"] === true }, { plan: kernelPlan });
    const result = instanceProjection(stopped.instance);
    writeResult(presentation, { command: commandName, target, result: { kind: "service-stop", ...result, originalIncarnationGone: true, impact: nativePlan ?? kernelPlan ?? null, cleanup: result.nativeStop?.cleanup ?? result.kernelStop?.cleanup ?? "not-checked" }, noOp: stopped.noOp }, (row) => instanceView(row, stopped.noOp ? "Service was not running; nothing was stopped" : row.kernelStop ? "Original broker process exited" : "Service stopped"));
    return;
  }
  if (values.foreground) console.log(renderReport({ space, sections: [{ title: "Foreground service lifetime", blocks: [
    { kind: "fields", rows: [["Definition", name], ["Space", space], ["Instance", selected?.name ?? "assigned once at launch"], ["Execution", "owned terminal-bound process; not a detachable view"], ["Output", "this terminal; not captured in the background log"]] },
    { kind: "lines", lines: ["Ctrl-C or terminal loss may end this process and its native in-process work. Controlled shutdown uses the selected process identity and declared stop policy. An external kill or interrupted startup is not a confirmed stop or proof of descendant, registration or authority cleanup."] },
  ] }] }, presentation === "plain" ? "plain" : "rich", terminalWidth(process.stdout)));
  let started: Awaited<ReturnType<typeof startProcessService>>;
  if (mode === "restart") {
    const hold = store.pin(definition);
    let stopped: Awaited<ReturnType<typeof stopProcessService>> | undefined;
    try {
      // Checked again after the confirmation, which can wait; still nothing has been stopped.
      assertRestartAdmitted(definition);
      stopped = await stopProcessService(definition, selected!, hold, { plan: nativePlan, withAgents: values["with-agents"] === true }, { plan: kernelPlan });
      started = await startProcessService(definition, { instance: stopped.instance.name }, hold);
    } catch (error) {
      if (!stopped) throw error;
      const uncertain = !isCommandFailure(error) || error.outcome === "unknown";
      throw new CommandFailure(uncertain ? "unknown" : "partial", uncertain ? "OPERATION_UNKNOWN" : "OPERATION_PARTIAL", "the original process is gone, but the replacement did not confirm readiness; it was not retried", { target, changed: [instanceProjection(stopped.instance)], ...(isCommandFailure(error) && error.native ? { native: error.native } : {}), remedy: "inspect the retained original instance ID and its latest launch request before another start" });
    } finally { hold.release(); }
  } else started = await startProcessService(definition, { ...(id ? { instance: id } : {}), newInstance: values["new-instance"] === true, foreground: values.foreground === true });
  const result = instanceProjection(started.instance);
  writeResult(presentation, { command: commandName, target: { ...target, instanceId: result.instanceId }, result: { kind: mode === "restart" ? "service-restart" : "service-start", ...result, ...(mode === "restart" ? { originalStopImpact: nativePlan ?? kernelPlan ?? null } : {}) }, noOp: started.noOp }, (row) => instanceView(row, started.noOp ? "Already running; nothing was started" : row.nativeEndpoint ? "Owned process running; native adapter readiness recorded" : row.reportedListener ? "Owned broker process reported its listener" : row.readinessObservation === "http-reachable" ? "Owned process running; HTTP reachable" : "Owned service process running"));
  if (values.foreground && started.child && started.exit) {
    let signal: "SIGINT" | "SIGTERM" | undefined;
    let finishShutdown!: () => void;
    const shutdownDone = new Promise<void>((resolve) => { finishShutdown = resolve; });
    let shutdown: Promise<void> | undefined;
    const close = (received: "SIGINT" | "SIGTERM") => {
      signal = received;
      shutdown ??= (async () => {
        try {
          const current = serviceInstanceStore(space).read(started.instance.name);
          if (!current || current.record.value.launchRequestId !== started.instance.record.value.launchRequestId) throw new CommandFailure("unknown", "OPERATION_UNKNOWN", "the foreground incarnation changed; its successor was not signalled");
          // A native adapter stops only through its request-bound handoff with the sparing default. The
          // signal this terminal-bound process received is the confirmation, as for a foreground stack.
          await stopProcessService(definition, current, undefined, { plan: await prepareNativeServiceStop(definition, current), withAgents: false });
        } catch (error) {
          const failure = isCommandFailure(error) ? error : new CommandFailure("unknown", "OPERATION_UNKNOWN", "foreground shutdown did not confirm the owned process exit; its record was retained");
          process.stderr.write(`${renderReport(commandFailureReport(failure), presentation === "plain" ? "plain" : "rich", terminalWidth(process.stderr))}\n`);
        } finally { finishShutdown(); }
      })();
    };
    const interrupt = () => close("SIGINT");
    const terminate = () => close("SIGTERM");
    process.on("SIGINT", interrupt); process.on("SIGTERM", terminate);
    try {
      await Promise.race([started.exit.done, shutdownDone]);
      if (shutdown) await shutdown;
      if (signal && !started.exit.observed()) { process.exitCode = signal === "SIGINT" ? 130 : 143; return; }
      const exit = started.exit.result(), current = serviceInstanceStore(space).read(started.instance.name);
      if (current && current.record.value.process?.pid === started.instance.record.value.process?.pid && current.record.value.process?.token === started.instance.record.value.process?.token) serviceInstanceStore(space).commit(current.name, current, { ...current.record.value, state: "stopped", readiness: "not-checked", exit, updatedAt: new Date().toISOString() });
      process.exitCode = signal === "SIGINT" ? 130 : signal === "SIGTERM" ? 143 : exit.code === 0 ? 0 : 5;
    } catch (error) {
      if (isCommandFailure(error)) process.stderr.write(`${renderReport(commandFailureReport(error), presentation === "plain" ? "plain" : "rich", terminalWidth(process.stderr))}\n`);
      throw error;
    } finally { process.off("SIGINT", interrupt); process.off("SIGTERM", terminate); }
  }
  function cancelled(): void { writeResult(presentation, { command: commandName, target: { space, name }, result: { kind: "service-operation", changed: false }, noOp: true }, (): Report => ({ sections: [{ title: "Service unchanged", blocks: [{ kind: "lines", lines: ["No service process or record was changed by this operation."] }] }] })); }
}
