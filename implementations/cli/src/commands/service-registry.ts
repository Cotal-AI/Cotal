import { existsSync } from "node:fs";
import { resolve } from "node:path";
import * as prompts from "../lib/prompts.js";
import { parseCommandArgs, registry, type Command, type CompletionResult, type FlagSpec, type ParsedArgs } from "@cotal-ai/core";
import { ConfirmationRequired, CommandFailure, recordOperationSpace, isCommandFailure, hasUserAuthState, jsonFlag, loadMeshes, localProcessPath, localProcessVisible, oneLine, parsePid, plainFlag, presentationOf, probeLiveness, readPidfile, spaceFlag, writeResult, type LocalProcess, type LocalProcessContext, type Report, type ServiceDefinitionInput, type ServicePreset } from "@cotal-ai/workspace";
import { canPrompt } from "./meshes-wizard.js";
import { findServicePreset, presetMaterialPath, presetMissingOptions, presetStartFlags, resolveServicePreset, servicePresetDefinition, servicePresetFlags, servicePresets } from "../lib/service-presets.js";
import { forgetRefusedPresetService, presetDefinitions, recordedPresetProcess, resolvePresetService, type PresetServiceTarget } from "../lib/service-preset-target.js";
import { execWords } from "../lib/exec-words.js";
import { resolveServiceAdapter } from "../lib/service-adapters.js";
import { personaCatalog } from "../lib/persona-files.js";
import { definitionRootMatch, execServiceDefinition, importServiceDefinition, serviceDefinitionProjection, serviceDefinitionStore, validateServiceDefinition, type ServiceDefinitionSnapshot } from "../lib/service-definitions.js";
import { serviceAction } from "./service-actions.js";
import { followRecordedLog } from "./service-log-follow.js";
import { managerLogPath } from "../lib/manager-proc.js";
import { serviceInstanceId, serviceInstances, instanceProjection } from "../lib/service-instances.js";
import { readLocalServiceAttempts } from "../lib/service-census.js";
import { readOwnedLogTail, readinessAddressSurvivors, removableServiceInstances, removeServiceLogs, removeStoppedInstanceRecord, removeStoppedInstanceRecords } from "../lib/service-process.js";
import { addedDefinitionStep, STACK_ADAPTER, STACK_DEFINITION } from "../lib/stack-journal.js";
import { assertManagerLogin } from "./stack-user-auth.js";
import { localRecordName } from "../lib/protected-records.js";
import { brokerServerProblem, brokerService } from "../lib/broker-service.js";

export const serviceFlags = [spaceFlag, jsonFlag, plainFlag,
  { name: "preset", type: "string", value: "<name>", description: "add: use a declared preset and that adapter's schema-derived options; starts nothing" },
  { name: "file", short: "f", type: "string", value: "<definition.json>", description: "add: import the version-1 local service definition" },
  { name: "exec", type: "string", value: "<command>", description: "add: the program and its arguments, quoted as in a shell but run without one" },
  { name: "cwd", short: "C", type: "string", value: "<dir>", description: "add --exec: the folder it runs in (default: this folder)" },
  { name: "yes", short: "y", type: "boolean", description: "stop/restart/remove/uninstall: confirm the exact selected local target" },
  { name: "instance", type: "string", value: "<full-id>", description: "select one full owned service instance ID, not a prefix; remove: forget only that stopped instance record" },
  { name: "new-instance", type: "boolean", description: "start: explicitly allocate another process-driver instance" },
  { name: "foreground", type: "boolean", description: "start: keep the owned process in this terminal; not a detachable view" },
  { name: "with-agents", type: "boolean", description: "stop/restart: request the declared native agent-stop policy; never generic descendant signals" },
  { name: "dry-run", type: "boolean", description: "start/stop/restart: preview an effect; install/uninstall: inspect native unit impact without changing it" },
  { name: "tail", type: "string", value: "<1..1000>", description: "logs: last captured records (default 100; bounded read)" },
  { name: "follow", type: "boolean", description: "logs: follow bounded file chunks; JSON emits explicit log NDJSON records" },
] as const satisfies readonly FlagSpec[];

export function validateServiceArguments(args: ParsedArgs): void {
  presentationOf(args.values);
  const [mode = "list", name, ...extra] = args.positionals;
  if (!["list", "show", "add", "remove", "start", "stop", "restart", "status", "logs", "install", "uninstall"].includes(mode) || extra.length || (mode === "list" ? name !== undefined : mode !== "add" && name === undefined)) throw new CommandFailure("refused", "USAGE_INVALID", "use service, or service show/add/remove/start/stop/restart/status/logs/install/uninstall with a definition name");
  if (name !== undefined) localRecordName(name);
  if (args.values.preset !== undefined) {
    if (mode !== "add" || args.values.file !== undefined) throw new CommandFailure("refused", "USAGE_INVALID", "--preset belongs to service add and cannot combine with --file");
    const preset = resolveServicePreset(String(args.values.preset));
    const allowed = new Set(["space", "json", "plain", "preset", ...servicePresetFlags(preset).map((flag) => flag.name)]);
    if (Object.keys(args.values).some((name) => !allowed.has(name))) throw new CommandFailure("refused", "USAGE_INVALID", "a supplied flag does not belong to the selected service preset");
  }
  if (args.values.file !== undefined && mode !== "add") throw new CommandFailure("refused", "USAGE_INVALID", "--file belongs to service add");
  if (args.values.exec !== undefined && (mode !== "add" || args.values.file !== undefined || args.values.preset !== undefined)) throw new CommandFailure("refused", "USAGE_INVALID", "--exec belongs to service add and cannot combine with --file or --preset");
  if (args.values.cwd !== undefined && args.values.exec === undefined) throw new CommandFailure("refused", "USAGE_INVALID", "--cwd belongs to service add --exec");
  if (mode === "start" && name !== undefined && (args.values.instance !== undefined || args.values["new-instance"]) && presetStartFlags(name).some((flag) => args.values[flag] !== undefined)) throw new CommandFailure("refused", "USAGE_INVALID", "a preset's options on start cannot be combined with --instance or --new-instance");
  if (args.values.yes !== undefined && !["remove", "stop", "restart", "uninstall"].includes(mode)) throw new CommandFailure("refused", "USAGE_INVALID", "--yes belongs to service stop, restart, remove or uninstall");
  if (args.values.instance !== undefined) { if (!["start", "stop", "restart", "status", "logs", "install", "uninstall", "remove"].includes(mode)) throw new CommandFailure("refused", "USAGE_INVALID", "--instance belongs to a service instance operation or remove"); serviceInstanceId(String(args.values.instance)); }
  if (args.values["new-instance"] && (mode !== "start" || args.values.instance !== undefined)) throw new CommandFailure("refused", "USAGE_INVALID", "--new-instance belongs to start and cannot be combined with --instance");
  if (args.values.foreground && (mode !== "start" || args.values.json)) throw new CommandFailure("refused", "USAGE_INVALID", "--foreground belongs to start and cannot produce a JSON receipt stream");
  if (args.values["with-agents"] !== undefined && !["stop", "restart"].includes(mode)) throw new CommandFailure("refused", "USAGE_INVALID", "--with-agents belongs to service stop or restart with a declared native policy");
  if (args.values["dry-run"] && !["start", "stop", "restart", "install", "uninstall"].includes(mode)) throw new CommandFailure("refused", "USAGE_INVALID", "--dry-run belongs to service start, stop, restart, install or uninstall");
  if (mode === "uninstall" && args.values["dry-run"] && args.values.yes) throw new CommandFailure("refused", "USAGE_INVALID", "--yes cannot confirm a read-only native uninstall inspection");
  if ((args.values.tail !== undefined || args.values.follow !== undefined) && mode !== "logs") throw new CommandFailure("refused", "USAGE_INVALID", "--tail and --follow belong to service logs");
  if (args.values.tail !== undefined && (!/^[1-9][0-9]*$/.test(String(args.values.tail)) || Number(args.values.tail) > 1000)) throw new CommandFailure("refused", "USAGE_INVALID", "--tail needs an integer from 1 to 1000");
  if (mode === "add" && (!name || args.values.file === undefined && args.values.preset === undefined && args.values.exec === undefined) && (!canPrompt() || args.values.json)) throw new CommandFailure("refused", "USAGE_INVALID", "scripted service add needs a name and --exec <command>, --preset <preset> or --file <definition.json>; guided input requires an interactive terminal", { remedy: `cotal service add ${name ?? "<name>"} --exec "<command>"` });
}

/** Whether a start of `name` would launch a manager: its saved definition, or the preset it names,
 *  runs the manager adapter, and no manager that `up` recorded by PID runs already. */
function launchesManager(space: string, root: string, name: string, store: ReturnType<typeof serviceDefinitionStore>): boolean {
  const saved = store.read(name)?.record.value.launch;
  if ((saved ? saved.type === "adapter" && saved.adapter : findServicePreset(name)?.adapter) !== STACK_ADAPTER.manager) return false;
  const manager = findServicePreset("manager");
  return manager === undefined || recordedPresetProcess(space, root, manager) === undefined;
}

function legacyProcesses(context: LocalProcessContext) {
  return registry.all<LocalProcess>("local-process").filter((provider) => localProcessVisible(provider, context)).map((provider) => {
    try {
      const raw = readPidfile(localProcessPath(provider.pidFile, context));
      const pid = raw === undefined ? undefined : parsePid(raw);
      const processState = raw === undefined ? "not-recorded" : pid === undefined ? "unattributable" : probeLiveness(pid);
      return { name: provider.name, component: provider.label, space: context.space, executionHost: "this-machine", generation: "legacy-local-process", processState, pid, ownership: "not-checked", readiness: "not-checked", supervisor: "not-checked", readable: true };
    } catch {
      return { name: provider.name, component: provider.label, space: context.space, executionHost: "this-machine", generation: "legacy-local-process", processState: "unreadable", ownership: "not-checked", readiness: "not-checked", supervisor: "not-checked", readable: false };
    }
  });
}

export async function service(args: ParsedArgs, commandName = "service"): Promise<void> {
  validateServiceArguments(args);
  const presentation = presentationOf(args.values);
  // Only --space selects the space: a preset's own options, such as the broker's --server and --root,
  // describe the service and never the target.
  const catalog = personaCatalog({ space: args.values.space as string | undefined });
  const { space, root } = catalog;
  recordOperationSpace(space);
  const store = serviceDefinitionStore(space, addedDefinitionStep);
  const [mode = "list", suppliedName] = args.positionals;
  const target = { space, executionHost: "this-machine" };
  if (["start", "stop", "restart", "status", "logs", "install", "uninstall"].includes(mode)) {
    // A user-auth space's manager is read as your signed-in, granted login, so a start without one
    // is refused here, before a definition is saved or a child launched.
    if ((mode === "start" || mode === "restart") && launchesManager(space, root, suppliedName!, store))
      await assertManagerLogin(root, space, commandName === "manager" ? `\`cotal manager ${mode}\`` : `\`cotal service ${mode} ${suppliedName}\``);
    const resolved = resolvePresetService(space, root, suppliedName!, mode, args.values);
    if (resolved?.recorded) return mode === "logs" && resolved.preset === "manager" ? recordedManagerLogs(resolved.requested, { ...resolved.recorded, state: "running" }, space, root, args.values, presentation, commandName) : recordedPresetProcessReport(resolved, resolved.recorded, space, mode, presentation, commandName);
    if (resolved?.stopped) return recordedManagerLogs(resolved.requested, { ...resolved.stopped, state: "stopped" }, space, root, args.values, presentation, commandName);
    if (resolved) announcePresetTarget(resolved, space, presentation);
    if (resolved?.saved === null && mode === "start" && args.values["dry-run"] && !store.read(resolved.name)) return previewPresetStart(resolved, space, root, args, presentation, commandName);
    try { return await serviceAction(resolved ? { ...args, positionals: [mode, resolved.name] } : args, space, root, commandName, resolved); }
    catch (error) {
      // A definition this start saved goes again when the start was refused before any launch.
      if (resolved?.saved?.kind === "created" && isCommandFailure(error) && error.outcome === "refused" && presentation !== "json")
        process.stderr.write(forgetRefusedPresetService(space, resolved.name) ? `forgot ${resolved.name} again, since its start was refused\n` : `kept the saved ${resolved.name}; forget it with \`cotal service remove ${resolved.name} --yes\`\n`);
      else if (resolved?.saved?.kind === "created" && isCommandFailure(error) && error.outcome === "refused") forgetRefusedPresetService(space, resolved.name);
      throw error;
    }
  }
  if (mode === "list") {
    const definitions = store.list().map((row) => ({ ...serviceDefinitionProjection(row), rootMatch: definitionRootMatch(row.record.value, root) }));
    let catalog: ReturnType<typeof servicePresets> = [];
    let catalogFailure: { code: string; message: string; target: { space: string } } | undefined;
    try { catalog = servicePresets(); }
    catch (error) { catalogFailure = { code: isCommandFailure(error) ? error.code : "SCHEMA_INVALID", target: { space }, message: "The installed preset catalog could not be read consistently. No empty or complete catalog was inferred." }; }
    const presets = catalog.map((row) => {
      const common = { name: row.preset.name, adapter: row.preset.adapter, summary: row.preset.summary, package: row.package, version: row.version };
      try {
        const selected = resolveServicePreset(row.preset.name);
        const declaration = resolveServiceAdapter(selected.adapter, {}, false).declaration;
        return { ...common, validation: "cached-metadata-checked" as const, capabilities: declaration.capabilities, readiness: declaration.readiness, stopPolicy: declaration.stop === "native" ? "native-request-bound" : "creation-pinned-process", requiresCli: declaration.requiresCli === true, osInstall: "not-supported-by-this-controller" as const, problem: null };
      } catch (error) {
        return { ...common, validation: "unavailable" as const, capabilities: null, readiness: null, stopPolicy: null, requiresCli: null, osInstall: "not-supported-by-this-controller" as const, problem: { code: isCommandFailure(error) ? error.code : "SCHEMA_INVALID", message: "The selected installed preset/adapter metadata could not be validated. No provider was imported or substituted." } };
      }
    });
    const instances = serviceInstances(space).map(instanceProjection);
    const instanceIds = new Set(instances.map((row) => row.instanceId));
    const attempts = readLocalServiceAttempts(space).map((row) => ({ ...row, instanceRecordPresent: instanceIds.has(row.instanceId) }));
    const processes = legacyProcesses({ root, space, userAuth: hasUserAuthState(root, space, { readOnly: true }) });
    const unread = processes.filter((row) => !row.readable).map((row) => ({ code: "LOCAL_PROCESS_UNREADABLE", target: { space, name: row.name }, message: "The local process record could not be read; no absent or stopped state was inferred." }));
    const presetWarnings = presets.filter((row) => row.problem).map((row) => ({ ...row.problem!, target: { space, name: row.name, adapter: row.adapter } }));
    const supervisorWarnings = instances.filter((row) => ["missing", "modified", "unreadable", "foreign-host"].includes(row.supervisorRecord.fileObservation)).map((row) => ({ code: "SUPERVISOR_OBSERVATION_UNAVAILABLE", target: { space, instanceId: row.instanceId, unit: row.supervisorRecord.unit }, message: "The recorded supervisor file is missing, modified, unreadable or on another host. It was not treated as uninstalled, stopped or safe for direct process control." }));
    const warnings = [...unread, ...presetWarnings, ...supervisorWarnings, ...(catalogFailure ? [catalogFailure] : []), ...(attempts.length ? [{ code: "RETAINED_NATIVE_ATTEMPT", target: { space, count: attempts.length }, message: "Retained native attempts may have changed service state; inspect their exact instance IDs before any new action." }] : [])];
    const services = serviceRows(space, root, catalog.map((row) => row.preset), store.list(), instances);
    writeResult(presentation, { command: "service", target, result: { kind: "service-inventory", services, definitions, instances, attempts, processes, presets, presetCompleteness: catalogFailure ? "unavailable" : presetWarnings.length ? "partial" : "complete-cached-inventory", presetCatalogUnavailable: catalogFailure?.message ?? null, instanceCompleteness: "complete-local-process-records", remoteRegistrations: "not-checked" }, ...(warnings.length ? { completeness: "partial", partial: { message: "Some local component records, preset metadata or supervisor-file observations were unavailable, or a native attempt remains unsettled. The inventory is not a settled service state." } } : {}), warnings: [...warnings, ...await readinessAddressSurvivors(space)] }, (result): Report => ({ sections: [
      { title: "Services", blocks: [
        { kind: "fields", rows: [["Space", space], ["Folder", root]] },
        result.services.length ? { kind: "table", columns: [{ key: "name", label: "Service" }, { key: "kind", label: "Kind" }, { key: "state", label: "State" }, { key: "next", label: "Next" }], rows: result.services.map((row) => ({ name: { text: row.name, tone: "command" }, kind: row.preset ? row.preset === row.name ? "built-in" : `built-in ${row.preset}` : "yours", state: { text: row.state, tone: row.state.startsWith("running") ? "ok" : row.state === "not started" || row.state === "stopped" ? "waiting" : "failed" }, next: { text: row.next, tone: "command" } })) } : { kind: "lines", lines: [result.presetCatalogUnavailable ?? "No service is saved or built in here."] },
        { kind: "lines", lines: [{ text: "A built-in service needs no add: its start saves it from its defaults. A start never starts another service for it.", tone: "hint" }, ...(result.presets.some((row) => row.name === "web") ? [] : [{ text: "The web dashboard is an extension: add it with `cotal ext add @cotal-ai/web`.", tone: "hint" as const }])] },
      ] },
      ...(result.services.some((row) => row.preset) ? [{ title: "What the built-in services do", blocks: [{ kind: "table" as const, columns: [{ key: "name", label: "Service" }, { key: "summary", label: "What it does" }], rows: result.presets.map((row) => ({ name: row.name, summary: row.summary })) }] }] : []),
      ...(result.instances.length ? [{ title: "Owned process instances", blocks: [{ kind: "table" as const, columns: [{ key: "definition", label: "Definition" }, { key: "instance", label: "Full instance" }, { key: "host", label: "Execution host" }, { key: "process", label: "Process observation" }, { key: "supervisor", label: "Recorded supervisor" }, { key: "ready", label: "Readiness as recorded" }], rows: result.instances.map((row) => ({ definition: row.definition, instance: row.instanceId, host: row.executionHost, process: row.observedProcess, supervisor: row.supervisor, ready: `${row.readinessObservation} · ${row.readinessAsOf}` })) }, { kind: "lines" as const, lines: ["Instance control does not adopt legacy PID records or grant control over remote registrations."] }] }] : []),
      ...(result.attempts.length ? [{ title: "Retained native attempts", blocks: [{ kind: "table" as const, columns: [{ key: "kind", label: "Action" }, { key: "definition", label: "Definition" }, { key: "instance", label: "Full instance" }, { key: "step", label: "Step" }, { key: "position", label: "Position" }, { key: "record", label: "Instance record" }], rows: result.attempts.slice(0, 100).map((row) => ({ kind: row.kind, definition: row.definition, instance: row.instanceId, step: row.step, position: row.position, record: row.instanceRecordPresent ? "present" : "absent" })) }, { kind: "lines" as const, lines: [...(result.attempts.length > 100 ? ["Additional retained attempts are in JSON."] : []), "A submitted or unknown step may have affected the original unit. An absent instance record does not settle its attempt. No native action was retried or reconciled."] }] }] : []),
      ...(recordedOnly(result.processes, result.instances).length ? [{ title: "Processes `cotal up` recorded by PID", blocks: [{ kind: "table" as const, columns: [{ key: "name", label: "Component" }, { key: "process", label: "PID observation" }], rows: recordedOnly(result.processes, result.instances).map((row) => ({ name: row.component, process: { text: row.processState === "alive" ? `PID present · ${row.pid}` : row.processState, tone: row.processState === "unreadable" || row.processState === "unattributable" ? "failed" as const : "waiting" as const } })) }, { kind: "lines" as const, lines: [{ text: "These are not saved services: `cotal down` stops them with their stack. A PID record proves neither ownership nor a serving endpoint.", tone: "hint" as const }] }] }] : []),
      ...(result.presets.some((row) => row.problem) ? [{ title: "Preset problems", blocks: [{ kind: "lines" as const, lines: result.presets.filter((row) => row.problem).map((row) => `${row.name}: ${row.problem!.message}`) }] }] : []),
      { title: "Next", blocks: [{ kind: "commands", items: [{ command: "cotal manager start", description: "Start the manager that runs your agents here" }, { command: "cotal service start <service>", description: "Start a built-in service from its defaults" }, { command: "cotal service add <name> --exec \"<command>\"", description: "Save your own program as a service, then start it by name" }] }] },
    ] }));
    return;
  }
  if (mode === "show") {
    const row = store.read(suppliedName!);
    if (!row) throw new CommandFailure("refused", "TARGET_NOT_FOUND", "no saved service definition has this full name in the selected space", { target: { ...target, name: suppliedName }, remedy: "see the saved definitions with `cotal service`" });
    writeResult(presentation, { command: "service", target: { ...target, name: row.name }, result: { ...serviceDefinitionProjection(row), rootMatch: definitionRootMatch(row.record.value, root) } }, (result): Report => ({ sections: [
      { title: "Service definition", blocks: [{ kind: "fields", rows: [["Name", result.name], ["Space", result.space], ["Execution host", "this machine"], ["Revision", result.revision], ["Launch", result.launch.type], ...(result.launch.type === "process" ? [["Executable", result.launch.executable], ["Arguments", `${result.launch.argumentCount} declared; values omitted`], ["Working directory", result.launch.cwd]] as const : [["Adapter", result.launch.adapter], ["Options", `${result.launch.optionCount} declared; values omitted`]] as const), ["Readiness policy", result.readiness.type], ["Readiness deadline", `${result.readiness.timeoutMs} ms`], ["Environment references", Object.entries(result.environmentReferences).map(([destination, source]) => `${destination} from ${source}`).join(", ") || "none"], ["Caller reference", result.credentialRef ? "protected file reference; not checked" : "none"], ["Added in", result.root === null ? "root not recorded" : result.rootMatch === "inherited" ? `${result.root}, not this space's root; it does not start here` : result.root], ["Live state", "not checked"]] }, { kind: "lines", lines: [{ text: "Saved policy is not proof of process ownership, OS supervision or endpoint registration. Argument bodies, adapter option values and credential contents are omitted.", tone: "hint" }] }] },
    ] }));
    return;
  }
  if (mode === "remove") {
    const row = store.read(suppliedName!);
    if (!row) throw new CommandFailure("refused", "TARGET_NOT_FOUND", "no saved service definition has this full name in the selected space", { target: { ...target, name: suppliedName }, remedy: "see the saved definitions with `cotal service`" });
    if (args.values.instance !== undefined) {
      // One stopped instance record goes; the definition, its other instances and the logs stay.
      const id = String(args.values.instance), at = { ...target, name: row.name, instanceId: id };
      if ((Object.values(STACK_DEFINITION) as string[]).includes(row.name)) throw new CommandFailure("refused", "UNSUPPORTED", "a controller stack member's instance records stay with its stack; nothing was removed", { target: at, remedy: `they go with the stack: \`cotal down --yes\`, then \`cotal space forget ${space}\`` });
      removableServiceInstances(space, row.name, id);
      if (!args.values.yes) {
        if (!canPrompt() || presentation === "json") throw new ConfirmationRequired("removing an instance record outside interactive input requires --yes", { target: at, remedy: `confirm with \`cotal svc remove ${row.name} --instance ${id} --yes\`` });
        const answer = await prompts.confirm({ message: `Forget stopped instance ${id} of ${oneLine(row.name)}? No process or OS unit will be removed.`, initialValue: false });
        if (prompts.isCancel(answer) || !answer) return cancelled("Instance record kept");
      }
      removeStoppedInstanceRecord(row, id);
      writeResult(presentation, { command: "service", target: at, result: { kind: "service-instance-record-removed", name: row.name, instanceId: id, processesChanged: false, supervisorChanged: false } }, (): Report => ({ sections: [{ title: "Instance record forgotten", blocks: [{ kind: "fields", rows: [["Name", row.name], ["Instance", id], ["Space", space]] }, { kind: "lines", lines: ["Only this stopped instance record was removed. Its logs, the definition and the other instances were kept, and no process or OS unit was changed."] }] }] }));
      return;
    }
    // A stack member's definition is the stack's: `up` and `down` read it, so it goes with the space.
    if ((Object.values(STACK_DEFINITION) as string[]).includes(row.name)) throw new CommandFailure("refused", "UNSUPPORTED", "a controller stack member's definition stays with its stack, whose up and down read it; nothing was removed", { target: { ...target, name: row.name }, remedy: `it goes with the stack: \`cotal down --yes\`, then \`cotal space forget ${space}\`` });
    removableServiceInstances(space, row.name);
    if (!args.values.yes) {
      if (!canPrompt() || presentation === "json") throw new ConfirmationRequired("removing a service definition outside interactive input requires --yes", { target: { ...target, name: row.name }, remedy: `confirm with \`cotal svc remove ${row.name} --yes\`` });
      const answer = await prompts.confirm({ message: `Forget ${oneLine(row.name)} in ${oneLine(space)} and delete its instances' logs? No process or OS unit will be removed.`, initialValue: false });
      if (prompts.isCancel(answer) || !answer) return cancelled("Service definition kept");
    }
    removableServiceInstances(space, row.name);
    let instances: string[] = [];
    store.commit(row.name, row, undefined, () => { instances = removeStoppedInstanceRecords(space, row.name); });
    // The logs go once the definition and records are gone, so a refused removal keeps every log.
    const logsRemoved = removeServiceLogs(space, instances);
    writeResult(presentation, { command: "service", target: { ...target, name: row.name }, result: { kind: "service-definition-removed", name: row.name, removedRevision: row.record.revision, logsRemoved, processesChanged: false, supervisorChanged: false } }, (result): Report => ({ sections: [{ title: "Service definition forgotten", blocks: [{ kind: "fields", rows: [["Name", row.name], ["Space", space]] }, { kind: "lines", lines: [...(result.logsRemoved.length ? ["Deleted logs:", ...result.logsRemoved.map((path) => `  ${path}`)] : ["No instance log was found to delete."]), "The unchanged local definition and its stopped instances' records were removed. No process, OS unit, native registration or credential was changed."] }] }] }));
    return;
  }
  let name = suppliedName;
  if (!name) {
    const answer = await prompts.text({ message: "Local service name", validate: (value) => { try { localRecordName(value ?? ""); } catch { return "Use 1 to 64 letters, digits, underscores or dashes, beginning with a letter or digit."; } } });
    if (prompts.isCancel(answer)) return cancelled("Service creation cancelled");
    name = localRecordName(answer);
  }
  const named = { ...target, name };
  /** A refusal while the definition is built names the space and name it was for. */
  const forName = <T>(build: () => T): T => {
    try { return build(); }
    catch (error) { throw isCommandFailure(error) && error.target === null ? new CommandFailure(error.outcome, error.code, error.message, { target: named, remedy: error.remedy, native: error.native, changed: error.changed }) : error; }
  };
  // A file names its space, so a definition for another space is refused before its name is looked
  // up in the selected one, whose service of that name it does not concern.
  const file = args.values.file;
  const imported = typeof file === "string" ? forName(() => importServiceDefinition(resolve(file), space)) : undefined;
  if (store.read(name)) throw new CommandFailure("refused", "CONFLICT", "this service definition already exists; it was not overwritten", { target: named, remedy: `to change it, stop its instances, forget it with \`cotal service remove ${name} --space ${oneLine(space)} --yes\`, then add it again` });
  let definition: ServiceDefinitionInput, chosenPreset: string | undefined;
  /** The broker's address is checked before a definition is saved, as its paths are, so a start does
   *  not record a failed instance for an address the broker cannot serve. */
  const refuseBrokerServer = (built: ServiceDefinitionInput): void => {
    const problem = built.launch.type === "adapter" && built.launch.adapter === brokerService.name ? brokerServerProblem(String(built.launch.options.server)) : undefined;
    if (!problem) return;
    throw chosenPreset !== undefined
      ? new CommandFailure("refused", "USAGE_INVALID", `--server ${problem}; nothing was saved`, { target: named, remedy: "pass the one address its configuration serves, for example --server nats://127.0.0.1:<port>", selfContained: true })
      : new CommandFailure("refused", "SCHEMA_INVALID", `the definition's launch.options.server ${problem}; nothing was saved`, { target: named, remedy: "set launch.options.server to the one address its configuration serves, such as nats://127.0.0.1:<port>" });
  };
  if (typeof args.values.preset === "string") {
    chosenPreset = args.values.preset;
    const preset = chosenPreset;
    definition = forName(() => servicePresetDefinition(resolveServicePreset(preset), space, args.values, root, `add ${name}`));
  } else if (typeof args.values.exec === "string") {
    const line = args.values.exec, cwd = resolve(typeof args.values.cwd === "string" ? args.values.cwd : process.cwd());
    definition = forName(() => execServiceDefinition(execWords(line), cwd, space));
  } else if (imported !== undefined) definition = imported;
  else {
    const available = servicePresets();
    const choice = available.length ? await prompts.select({ message: "Definition source", options: [{ value: "file:", label: "Import a version-1 definition file" }, ...available.map((row) => ({ value: `preset:${row.preset.name}`, label: oneLine(row.preset.name), hint: oneLine(row.preset.summary) }))] }) : "file:";
    if (prompts.isCancel(choice)) return cancelled("Service creation cancelled");
    if (choice.startsWith("preset:")) {
      const presetName = chosenPreset = choice.slice("preset:".length);
      const preset = forName(() => resolveServicePreset(presetName));
      const guided = await guidedPreset(preset);
      if (!guided) return cancelled("Service creation cancelled");
      const values = guided;
      definition = forName(() => servicePresetDefinition(preset, space, values, root, `add ${name}`));
    } else {
      const file = await prompts.text({ message: "Version-1 service definition file", placeholder: "./reviews.service.json" });
      if (prompts.isCancel(file)) return cancelled("Service creation cancelled");
      definition = forName(() => importServiceDefinition(resolve(file), space));
    }
    refuseBrokerServer(definition);
    const answer = await prompts.confirm({ message: `Save ${oneLine(name)} in ${oneLine(space)}? Its program will not be started.`, initialValue: false });
    if (prompts.isCancel(answer) || !answer) return cancelled("Service creation cancelled");
  }
  // The root it is added in, so a later space of this name in another folder does not start it.
  const checked: ServiceDefinitionInput = { ...definition, root };
  forName(() => validateServiceDefinition(checked, space));
  refuseBrokerServer(checked);
  const record = store.commit(name, undefined, checked)!;
  // The executable as saved: a bare name in the input is saved as the absolute path add found for it.
  const executable = definition.launch.type === "process" ? definition.launch.executable : null;
  writeResult(presentation, { command: "service", target: { ...target, name }, result: { kind: "service-definition-added", name, revision: record.revision, space, preset: chosenPreset ?? null, executable, started: false, authorityGranted: false } }, (): Report => ({ sections: [{ title: "Service definition saved", blocks: [{ kind: "fields", rows: [["Name", name], ["Space", space], ["Execution host", "this machine"], ...(executable ? [["Executable", executable] as [string, string]] : []), ["Revision", record.revision], ["Process", "not started"], ["Authority", "not granted"]] }, { kind: "lines", lines: [{ text: "Only the owner-private definition was saved. Referenced credential contents were not read. This declaration is not a process sandbox.", tone: "hint" }] }] },
    { title: "Next", blocks: [{ kind: "commands", items: [{ command: `cotal svc start ${name}`, description: "Start it; dependencies are not started for it" }, { command: `cotal svc show ${name}`, description: "Read its saved launch and readiness policy" }] }] }] }));
  function cancelled(title: string): void { writeResult(presentation, { command: "service", target, result: { kind: "service-definition-change", changed: false }, noOp: true }, () => ({ sections: [{ title, blocks: [{ kind: "lines", lines: ["No service definition, process or OS unit was changed."] }] }] })); }
}

/** The PID records no running service instance accounts for: a saved service's own process can
 *  keep the record its component always writes, and is listed with its service instead. */
function recordedOnly<T extends { processState: string; pid?: number }>(processes: readonly T[], instances: readonly { pid: number | null; observedProcess: string }[]): T[] {
  return processes.filter((row) => row.processState !== "not-recorded" && !instances.some((instance) => instance.observedProcess === "running" && instance.pid === row.pid));
}

/** One row per service a person can name here: each saved definition, and each built-in preset no
 *  saved definition of this folder runs yet. `next` is the one command that moves it forward. */
function serviceRows(space: string, root: string, catalog: readonly ServicePreset[], saved: readonly ServiceDefinitionSnapshot[], instances: readonly ReturnType<typeof instanceProjection>[]) {
  const byAdapter = new Map(catalog.map((preset) => [preset.adapter, preset.name] as const));
  const rows: { name: string; preset: string | null; definition: string | null; state: string; needs: string[]; next: string }[] = [];
  const presetOf = (row: ServiceDefinitionSnapshot) => row.record.value.launch.type === "adapter" ? byAdapter.get(row.record.value.launch.adapter) ?? null : null;
  // The manager's own commands name it when it is this space's one manager.
  const managers = saved.filter((row) => presetOf(row) === "manager").length;
  for (const row of saved) {
    const preset = presetOf(row);
    const own = instances.filter((instance) => instance.definition === row.name);
    const state = own.some((instance) => instance.observedProcess === "running") ? "running" : own.length ? "stopped" : "not started";
    const action = state === "running" ? "status" : "start";
    // One a forgotten space of this name left in another root does not start here; forgetting it is the step.
    if (state !== "running" && definitionRootMatch(row.record.value, root) === "inherited") {
      rows.push({ name: row.name, preset, definition: row.name, state: `inherited from ${row.record.value.root}`, needs: [], next: `cotal service remove ${row.name} --space ${space} --yes` });
      continue;
    }
    rows.push({ name: row.name, preset, definition: row.name, state, needs: [], next: preset === "manager" && managers === 1 ? `cotal manager ${action}` : `cotal service ${action} ${row.name}` });
  }
  for (const preset of catalog) {
    let covered = false;
    try { covered = presetDefinitions(space, root, preset).length > 0; } catch { covered = false; }
    if (covered) continue;
    const recorded = recordedPresetProcess(space, root, preset);
    let needs: string[] = [], several = false;
    try {
      const flags = servicePresetFlags(preset), missing = new Set(presetMissingOptions(preset, {}));
      for (const [name, fallback] of Object.entries(preset.defaults ?? {})) if ("space" in fallback && fallback.space === "material" && !existsSync(presetMaterialPath(fallback.kind, space, root, false))) missing.add(name);
      needs = flags.filter((flag) => missing.has(flag.name)).map((flag) => `--${flag.name}${flag.value ? ` ${flag.value}` : ""}`);
      several = resolveServiceAdapter(preset.adapter, {}, false).declaration.capabilities.multiInstance;
    } catch { needs = ["its options"]; }
    // A preset that runs many instances is added under a name of your own; any other starts by its name.
    const line = several ? `cotal service add <name> --preset ${preset.name}` : preset.name === "manager" ? "cotal manager start" : `cotal service start ${preset.name}`;
    rows.push({ name: preset.name, preset: preset.name, definition: null, state: recorded ? `running, pid ${recorded.pid}, started by \`cotal up\`` : "not started", needs,
      next: recorded ? "cotal status" : [line, ...needs].join(" ") });
  }
  return rows;
}

/** Say on stderr which saved service a preset name acts on, and what this command saved for it,
 *  before the action's own report. JSON carries the same in its target and result. */
export function announcePresetTarget(resolved: PresetServiceTarget, space: string, presentation: ReturnType<typeof presentationOf>): void {
  if (presentation === "json") return;
  const notes: string[] = [];
  if (resolved.name !== resolved.requested) notes.push(`${resolved.requested} in space ${space} is the saved service ${resolved.name}${resolved.name.startsWith("stack-") ? ", which `cotal up` started" : ""}`);
  if (resolved.saved?.kind === "created") notes.push(`saved ${resolved.name} in space ${space} from the ${resolved.preset} preset${resolved.saved.options.length ? ` with ${resolved.saved.options.map((name) => `--${name}`).join(", ")}` : " with its defaults"}; \`cotal service show ${resolved.name}\` reads it`);
  if (resolved.saved?.kind === "redefined") notes.push(`saved ${resolved.name} again with the new ${resolved.saved.options.map((name) => `--${name}`).join(", ")}`);
  for (const note of notes) process.stderr.write(`${note}\n`);
}

/** A preset's process that `up` or a daemon entry started, recorded by PID alone. A start or a
 *  status reports it and starts nothing beside it, and a manager's log is read by
 *  {@link recordedManagerLogs}; any other action refuses, since no saved service owns it, and names
 *  where it is stopped. */
function recordedPresetProcessReport(resolved: PresetServiceTarget, recorded: { pid: number; label: string }, space: string, mode: string, presentation: ReturnType<typeof presentationOf>, commandName: string): void {
  const target = { space, name: resolved.requested, executionHost: "this-machine", pid: recorded.pid };
  const stop = "it stops with its stack through `cotal down`, or where `cotal supervise` runs it";
  if (mode !== "start" && mode !== "status") throw recordedProcessRefusal(resolved.requested, recorded, space, `${commandName} ${mode}`);
  writeResult(presentation, { command: commandName, target, result: { kind: mode === "start" ? "service-start" : "service-status", name: resolved.requested, preset: resolved.preset, recordedProcess: { pid: recorded.pid, label: recorded.label, startedBy: "cotal up or cotal supervise", savedService: false }, started: false }, noOp: mode === "start" }, (): Report => ({ sections: [
    { title: mode === "start" ? `The ${recorded.label} is already running; nothing was started` : `The ${recorded.label} is running`, blocks: [{ kind: "fields", rows: [["Space", space], ["PID", String(recorded.pid)], ["Started by", "cotal up or `cotal supervise`, not as a saved service"], ["Stop", stop]] }] },
    { title: "Next", blocks: [{ kind: "commands", items: [{ command: "cotal status", description: "See it with the rest of this space" }, { command: "cotal ps", description: "List the agents it runs" }] }] },
  ] }));
}

/** Why `action` refuses a preset's process recorded by PID alone: no saved service owns it. */
export function recordedProcessRefusal(name: string, recorded: { pid: number; label: string }, space: string, action: string): CommandFailure {
  return new CommandFailure("refused", "UNSUPPORTED", `the ${recorded.label} running in space ${oneLine(space)} (pid ${recorded.pid}) was started by \`cotal up\` or \`cotal supervise\`, not as a saved service, so ${action} does not control it; nothing was changed`, {
    target: { space, name, executionHost: "this-machine", pid: recorded.pid },
    remedy: "it stops with its stack through `cotal down`, or where `cotal supervise` runs it",
  });
}

/** The log `up` opened for the manager it started with no saved service, read as `service logs`
 *  reads a service's, while that manager runs or after it stopped. A read changes nothing, so it
 *  needs no control of the manager. */
async function recordedManagerLogs(name: string, recorded: { pid: number | null; label: string; state: "running" | "stopped" }, space: string, root: string, values: ParsedArgs["values"], presentation: ReturnType<typeof presentationOf>, commandName: string): Promise<void> {
  const target = { space, name, executionHost: "this-machine", pid: recorded.pid };
  const path = managerLogPath(space, root), tail = values.tail === undefined ? 100 : Number(values.tail);
  if (values.follow) return followRecordedLog(path, recorded.pid, target, presentation, tail);
  const log = readOwnedLogTail(path, tail), stopped = recorded.state === "stopped";
  writeResult(presentation, { command: commandName, target, result: { kind: "service-logs", name, recordedProcess: { pid: recorded.pid, label: recorded.label, state: recorded.state, startedBy: "cotal up or cotal supervise", savedService: false }, ...log, encoding: "utf8-with-replacement", collection: "the manager's output, in the log `cotal up` opened for it" }, ...(log.omittedBytes && log.lines.length < tail ? { completeness: "partial" as const, partial: { message: "The 16 MiB bounded read holds fewer lines than the requested tail; earlier bytes were omitted." } } : {}) }, (result): Report => ({ sections: [{ title: stopped ? "Manager log tail, from a stopped manager" : "Manager log tail", blocks: [
    { kind: "fields", rows: [["Space", space], ["State", recorded.state], ["PID", recorded.pid === null ? "no longer recorded" : stopped ? `${recorded.pid}, no longer running` : String(recorded.pid)], ["Started by", "cotal up or `cotal supervise`, not as a saved service"], ["Log", path]] },
    { kind: "lines", lines: result.lines.length ? result.lines : ["No captured log lines in this bounded read."] },
    { kind: "lines", lines: [{ text: "A manager that `cotal supervise` runs in a terminal writes there instead. Its output may contain secrets. This is a local authorized read, not a secret-redacted log or an upload.", tone: "hint" }] },
  ] }, ...(stopped ? [{ title: "Next", blocks: [{ kind: "commands" as const, items: [{ command: "cotal up", description: "Start the stack again" }] }] }] : [])] }));
}

/** A dry-run start of a preset no definition exists for yet: what the real start would save, from
 *  the same defaults and options, with nothing saved or launched. */
function previewPresetStart(resolved: PresetServiceTarget, space: string, root: string, args: ParsedArgs, presentation: ReturnType<typeof presentationOf>, commandName: string): void {
  const definition = servicePresetDefinition(resolveServicePreset(resolved.preset), space, args.values, root, "start", false);
  const launch = definition.launch as Extract<ServiceDefinitionInput["launch"], { type: "adapter" }>;
  writeResult(presentation, { command: commandName, target: { space, name: resolved.name, executionHost: "this-machine" }, result: { kind: "service-operation-preview", operation: "start", dryRun: true, definitionWouldBeSaved: true, preset: resolved.preset, adapter: launch.adapter, optionNames: Object.keys(launch.options).sort(), saved: false, allocated: false, providerCodeLoaded: false } }, (): Report => ({ sections: [{ title: "Service operation preview", blocks: [
    { kind: "fields", rows: [["Action", "start"], ["Service", resolved.name], ["Space", space], ["Definition", `would be saved from the ${resolved.preset} preset`], ["Options", Object.keys(launch.options).sort().map((name) => `--${name}`).join(", ") || "none"]] },
    { kind: "lines", lines: ["Nothing was saved, launched or loaded. The real start saves this definition first, then starts it."] },
  ] }] }));
}

export function serviceComplete(argv: string[]): CompletionResult {
  const last = argv.at(-1) ?? "";
  if (argv.at(-2) === "--preset" || last.startsWith("--preset=")) return { items: servicePresets().map((row) => ({ value: last.startsWith("--preset=") ? `--preset=${row.preset.name}` : row.preset.name, description: row.preset.summary })), directive: "nofiles" };
  if (argv.at(-2) === "--space" || argv.at(-2) === "-s" || last.startsWith("--space=")) return { items: loadMeshes().map((row) => ({ value: last.startsWith("--space=") ? `--space=${row.space}` : row.space })), directive: "nofiles" };
  if (argv.length <= 1) return { items: ["add", "show", "remove", "start", "stop", "restart", "status", "logs", "install", "uninstall"].map((value) => ({ value })), directive: "nofiles" };
  try {
    const prefix = parseCommandArgs(registry.resolve<Command>("command", "service"), argv.slice(0, -1));
    if (["show", "remove", "start", "stop", "restart", "status", "logs", "install", "uninstall"].includes(prefix.positionals[0] ?? "") && prefix.positionals.length === 1) {
      const { space } = personaCatalog(prefix.values as { space?: string });
      // A built-in preset is a service name too: its start saves it from its defaults.
      const saved = serviceDefinitionStore(space).list().map((row) => row.name);
      const builtIn = ["start", "status", "stop", "restart", "logs", "install", "uninstall"].includes(prefix.positionals[0]!) ? servicePresets().map((row) => row.preset.name).filter((name) => !saved.includes(name)) : [];
      return { items: [...saved, ...builtIn].map((value) => ({ value })), directive: "nofiles" };
    }
  } catch { return { items: [], directive: "nofiles" }; } // No alternative space or provider is consulted.
  return { items: [], directive: "nofiles" };
}

async function guidedPreset(preset: ReturnType<typeof resolveServicePreset>): Promise<ParsedArgs["values"] | undefined> {
  servicePresetFlags(preset);
  const schema = resolveServiceAdapter(preset.adapter, {}, false).declaration.optionsSchema;
  const properties = schema.properties as Record<string, Record<string, unknown>>;
  const required = schema.required as string[] | undefined;
  const values: ParsedArgs["values"] = {};
  for (const [name, option] of Object.entries(properties)) {
    if (!required?.includes(name)) {
      const set = await prompts.confirm({ message: `Set optional --${name}?`, initialValue: false });
      if (prompts.isCancel(set)) return undefined;
      if (!set) continue;
    }
    if (option.type === "boolean") {
      const answer = await prompts.confirm({ message: `Enable --${name}?`, initialValue: false });
      if (prompts.isCancel(answer)) return undefined;
      values[name] = answer;
    } else {
      const answer = await prompts.text({ message: option.type === "string" ? `Non-secret value for --${name}` : `JSON ${String(option.type)} for --${name}` });
      if (prompts.isCancel(answer)) return undefined;
      values[name] = answer;
    }
  }
  return values;
}
