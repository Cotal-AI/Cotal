import { resolve } from "node:path";
import * as prompts from "@clack/prompts";
import { parseCommandArgs, registry, type Command, type CompletionResult, type FlagSpec, type ParsedArgs } from "@cotal-ai/core";
import { CommandFailure, recordOperationSpace, isCommandFailure, hasUserAuthState, jsonFlag, loadMeshes, localProcessPath, localProcessVisible, oneLine, parsePid, plainFlag, presentationOf, probeLiveness, readPidfile, spaceFlag, writeResult, type LocalProcess, type LocalProcessContext, type Report, type ServiceDefinitionInput } from "@cotal-ai/workspace";
import { canPrompt } from "./meshes-wizard.js";
import { resolveServicePreset, servicePresetDefinition, servicePresetFlags, servicePresets } from "../lib/service-presets.js";
import { resolveServiceAdapter } from "../lib/service-adapters.js";
import { personaCatalog } from "../lib/persona-files.js";
import { importServiceDefinition, serviceDefinitionProjection, serviceDefinitionStore, validateServiceDefinition } from "../lib/service-definitions.js";
import { serviceAction } from "./service-actions.js";
import { serviceInstanceId, serviceInstances, instanceProjection } from "../lib/service-instances.js";
import { readLocalServiceAttempts } from "../lib/service-census.js";
import { removableServiceInstances, removeStoppedInstanceRecords } from "../lib/service-process.js";
import { localRecordName } from "../lib/protected-records.js";
import { untilInputEnds } from "../lib/prompt-input.js";

export const serviceFlags = [spaceFlag, jsonFlag, plainFlag,
  { name: "preset", type: "string", value: "<name>", description: "add: use a declared preset and that adapter's schema-derived options; starts nothing" },
  { name: "file", short: "f", type: "string", value: "<definition.json>", description: "add: import the version-1 local service definition" },
  { name: "yes", short: "y", type: "boolean", description: "stop/restart/remove/uninstall: confirm the exact selected local target" },
  { name: "instance", type: "string", value: "<full-id>", description: "select one full owned service instance ID, not a prefix" },
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
  if (args.values.yes !== undefined && !["remove", "stop", "restart", "uninstall"].includes(mode)) throw new CommandFailure("refused", "USAGE_INVALID", "--yes belongs to service stop, restart, remove or uninstall");
  if (args.values.instance !== undefined) { if (!["start", "stop", "restart", "status", "logs", "install", "uninstall"].includes(mode)) throw new CommandFailure("refused", "USAGE_INVALID", "--instance belongs to a service instance operation"); serviceInstanceId(String(args.values.instance)); }
  if (args.values["new-instance"] && (mode !== "start" || args.values.instance !== undefined)) throw new CommandFailure("refused", "USAGE_INVALID", "--new-instance belongs to start and cannot be combined with --instance");
  if (args.values.foreground && (mode !== "start" || args.values.json)) throw new CommandFailure("refused", "USAGE_INVALID", "--foreground belongs to start and cannot produce a JSON receipt stream");
  if (args.values["with-agents"] !== undefined && !["stop", "restart"].includes(mode)) throw new CommandFailure("refused", "USAGE_INVALID", "--with-agents belongs to service stop or restart with a declared native policy");
  if (args.values["dry-run"] && !["start", "stop", "restart", "install", "uninstall"].includes(mode)) throw new CommandFailure("refused", "USAGE_INVALID", "--dry-run belongs to service start, stop, restart, install or uninstall");
  if (mode === "uninstall" && args.values["dry-run"] && args.values.yes) throw new CommandFailure("refused", "USAGE_INVALID", "--yes cannot confirm a read-only native uninstall inspection");
  if ((args.values.tail !== undefined || args.values.follow !== undefined) && mode !== "logs") throw new CommandFailure("refused", "USAGE_INVALID", "--tail and --follow belong to service logs");
  if (args.values.tail !== undefined && (!/^[1-9][0-9]*$/.test(String(args.values.tail)) || Number(args.values.tail) > 1000)) throw new CommandFailure("refused", "USAGE_INVALID", "--tail needs an integer from 1 to 1000");
  if (mode === "add" && (!name || args.values.file === undefined && args.values.preset === undefined) && (!canPrompt() || args.values.json)) throw new CommandFailure("refused", "USAGE_INVALID", "scripted service add needs a name and --file or --preset with declared options; guided input requires an interactive terminal");
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
  const catalog = personaCatalog(args.values as { space?: string });
  const { space, root } = catalog;
  recordOperationSpace(space);
  const store = serviceDefinitionStore(space);
  const [mode = "list", suppliedName] = args.positionals;
  const target = { space, executionHost: "this-machine" };
  if (["start", "stop", "restart", "status", "logs", "install", "uninstall"].includes(mode)) return serviceAction(args, space, commandName);
  if (mode === "list") {
    const definitions = store.list().map(serviceDefinitionProjection);
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
    writeResult(presentation, { command: "service", target, result: { kind: "service-inventory", definitions, instances, attempts, processes, presets, presetCompleteness: catalogFailure ? "unavailable" : presetWarnings.length ? "partial" : "complete-cached-inventory", presetCatalogUnavailable: catalogFailure?.message ?? null, instanceCompleteness: "complete-local-process-records", remoteRegistrations: "not-checked" }, ...(warnings.length ? { completeness: "partial", partial: { message: "Some local component records, preset metadata or supervisor-file observations were unavailable, or a native attempt remains unsettled. The inventory is not a settled service state." } } : {}), warnings }, (result): Report => ({ sections: [
      { title: "Local services", blocks: [{ kind: "fields", rows: [["Space", space], ["Execution host", "this machine"], ["Instance driver", "creation-pinned Linux processes; declared local-process adapters; OS supervision pending"], ["Remote registrations", "not checked"]] }, result.definitions.length ? { kind: "table", columns: [{ key: "name", label: "Definition" }, { key: "type", label: "Component" }, { key: "instances", label: "Instance records" }, { key: "supervisor", label: "Recorded supervisor" }, { key: "ready", label: "Readiness as recorded" }], rows: result.definitions.map((row) => {
        const owned = result.instances.filter((instance) => instance.definition === row.name);
        const one = owned.length === 1 ? owned[0] : undefined;
        return { name: { text: row.name, tone: "command" }, type: row.launch.type === "process" ? "process" : row.launch.adapter, instances: String(owned.length), supervisor: one?.supervisor ?? (owned.length ? "see instances below" : "none recorded"), ready: { text: one?.readinessObservation ?? (owned.length ? "see instances below" : "not checked"), tone: "waiting" } };
      }) } : { kind: "lines", lines: ["No saved definitions in this selected local space."] }] },
      ...(result.instances.length ? [{ title: "Owned process instances", blocks: [{ kind: "table" as const, columns: [{ key: "definition", label: "Definition" }, { key: "instance", label: "Full instance" }, { key: "host", label: "Execution host" }, { key: "process", label: "Process observation" }, { key: "supervisor", label: "Recorded supervisor" }, { key: "ready", label: "Readiness as recorded" }], rows: result.instances.map((row) => ({ definition: row.definition, instance: row.instanceId, host: row.executionHost, process: row.observedProcess, supervisor: row.supervisor, ready: `${row.readinessObservation} · ${row.readinessAsOf}` })) }, { kind: "lines" as const, lines: ["Instance control does not adopt legacy PID records or grant control over remote registrations."] }] }] : []),
      ...(result.attempts.length ? [{ title: "Retained native attempts", blocks: [{ kind: "table" as const, columns: [{ key: "kind", label: "Action" }, { key: "definition", label: "Definition" }, { key: "instance", label: "Full instance" }, { key: "step", label: "Step" }, { key: "position", label: "Position" }, { key: "record", label: "Instance record" }], rows: result.attempts.slice(0, 100).map((row) => ({ kind: row.kind, definition: row.definition, instance: row.instanceId, step: row.step, position: row.position, record: row.instanceRecordPresent ? "present" : "absent" })) }, { kind: "lines" as const, lines: [...(result.attempts.length > 100 ? ["Additional retained attempts are in JSON."] : []), "A submitted or unknown step may have affected the original unit. An absent instance record does not settle its attempt. No native action was retried or reconciled."] }] }] : []),
      { title: "Existing component records", blocks: [{ kind: "table", columns: [{ key: "name", label: "Component" }, { key: "process", label: "PID observation" }, { key: "owner", label: "Ownership" }, { key: "ready", label: "Readiness" }], rows: result.processes.map((row) => ({ name: row.component, process: { text: row.processState === "alive" ? `PID present · ${row.pid}` : row.processState, tone: row.processState === "unreadable" || row.processState === "unattributable" ? "failed" : "waiting" }, owner: "not checked", ready: "not checked" })) }, { kind: "lines", lines: [{ text: "Legacy records are not adopted service instances. A PID observation proves neither ownership nor a serving endpoint. No process was started, stopped or repaired.", tone: "hint" }] }] },
      { title: "Declared presets", blocks: [result.presets.length ? { kind: "table", columns: [{ key: "name", label: "Preset" }, { key: "provider", label: "Provider" }, { key: "readiness", label: "Readiness policy" }, { key: "foreground", label: "Foreground" }, { key: "instances", label: "Multiple instances" }, { key: "stop", label: "Stop policy" }], rows: result.presets.slice(0, 100).map((row) => ({ name: { text: row.name, tone: "command" }, provider: `${row.package ?? "composition root"}@${row.version}`, readiness: row.readiness ?? "metadata unavailable", foreground: row.capabilities ? row.capabilities.foreground ? "declared" : "unsupported" : "unknown", instances: row.capabilities ? row.capabilities.multiInstance ? "declared" : "one per definition" : "unknown", stop: row.stopPolicy ?? "unknown" })) } : { kind: "lines", lines: [result.presetCatalogUnavailable ?? "No service preset is declared by this composition or its installed extensions."] }, { kind: "lines", lines: [...(result.presets.length > 100 ? [`${result.presets.length - 100} preset rows omitted; --json retains the full cached inventory.`] : []), `Preset catalog: ${result.presetCompleteness}.`, "Checked metadata means the installed declaration passed its package/version/cache checks, not that its provider ran or its application is ready. Capabilities are declarations, not live observations. OS installation is not supported by this controller. Saving a preset starts nothing and supplies no credentials.", ...result.presets.filter((row) => row.problem).map((row) => `${row.name}: ${row.problem!.message}`)] }] },
      { title: "Next", blocks: [{ kind: "commands", items: [{ command: "cotal svc add <name> --preset <preset> --help", description: "Read the selected preset's declared option flags without loading code" }, { command: "cotal svc add <name> --file <definition.json>", description: "Save a local definition without launching it" }, { command: "cotal svc show <name>", description: "Read its declared launch and readiness policy" }] }] },
    ] }));
    return;
  }
  if (mode === "show") {
    const row = store.read(suppliedName!);
    if (!row) throw new CommandFailure("refused", "TARGET_NOT_FOUND", "no saved service definition has this full name in the selected space", { target: { ...target, name: suppliedName } });
    writeResult(presentation, { command: "service", target: { ...target, name: row.name }, result: serviceDefinitionProjection(row) }, (result): Report => ({ sections: [
      { title: "Service definition", blocks: [{ kind: "fields", rows: [["Name", result.name], ["Space", result.space], ["Execution host", "this machine"], ["Revision", result.revision], ["Launch", result.launch.type], ...(result.launch.type === "process" ? [["Executable", result.launch.executable], ["Arguments", `${result.launch.argumentCount} declared; values omitted`], ["Working directory", result.launch.cwd]] as const : [["Adapter", result.launch.adapter], ["Options", `${result.launch.optionCount} declared; values omitted`]] as const), ["Readiness policy", result.readiness.type], ["Readiness deadline", `${result.readiness.timeoutMs} ms`], ["Caller reference", result.credentialRef ? "protected file reference; not checked" : "none"], ["Live state", "not checked"]] }, { kind: "lines", lines: [{ text: "Saved policy is not proof of process ownership, OS supervision or endpoint registration. Argument bodies, adapter option values and credential contents are omitted.", tone: "hint" }] }] },
    ] }));
    return;
  }
  if (mode === "remove") {
    const row = store.read(suppliedName!);
    if (!row) throw new CommandFailure("refused", "TARGET_NOT_FOUND", "no saved service definition has this full name in the selected space", { target: { ...target, name: suppliedName } });
    removableServiceInstances(space, row.name);
    if (!args.values.yes) {
      if (!canPrompt() || presentation === "json") throw new CommandFailure("refused", "USAGE_INVALID", "removing a service definition outside interactive input requires --yes", { target: { ...target, name: row.name }, remedy: `confirm with cotal svc remove ${row.name} --yes` });
      const answer = await untilInputEnds((signal) => prompts.confirm({ message: `Forget ${oneLine(row.name)} in ${oneLine(space)}? No process or OS unit will be removed.`, initialValue: false, signal }));
      if (prompts.isCancel(answer) || !answer) return cancelled("Service definition kept");
    }
    removableServiceInstances(space, row.name);
    store.commit(row.name, row, undefined, () => removeStoppedInstanceRecords(space, row.name));
    writeResult(presentation, { command: "service", target: { ...target, name: row.name }, result: { kind: "service-definition-removed", name: row.name, removedRevision: row.record.revision, processesChanged: false, supervisorChanged: false } }, (): Report => ({ sections: [{ title: "Service definition forgotten", blocks: [{ kind: "fields", rows: [["Name", row.name], ["Space", space]] }, { kind: "lines", lines: ["Only the unchanged local definition was removed. No process, OS unit, native registration or credential was changed."] }] }] }));
    return;
  }
  let name = suppliedName;
  if (!name) {
    const answer = await untilInputEnds((signal) => prompts.text({ message: "Local service name", validate: (value) => { try { localRecordName(value ?? ""); } catch { return "Use 1 to 64 letters, digits, underscores or dashes, beginning with a letter or digit."; } }, signal }));
    if (prompts.isCancel(answer)) return cancelled("Service creation cancelled");
    name = localRecordName(answer);
  }
  if (store.read(name)) throw new CommandFailure("refused", "CONFLICT", "this service definition already exists; it was not overwritten", { target: { ...target, name } });
  const named = { ...target, name };
  /** A refusal while the definition is built names the space and name it was for. */
  const forName = <T>(build: () => T): T => {
    try { return build(); }
    catch (error) { throw isCommandFailure(error) && error.target === null ? new CommandFailure(error.outcome, error.code, error.message, { target: named, remedy: error.remedy, native: error.native, changed: error.changed }) : error; }
  };
  let definition: ServiceDefinitionInput, chosenPreset: string | undefined;
  if (typeof args.values.preset === "string") {
    chosenPreset = args.values.preset;
    const preset = chosenPreset;
    definition = forName(() => servicePresetDefinition(resolveServicePreset(preset), space, args.values));
  } else if (typeof args.values.file === "string") { const file = args.values.file; definition = forName(() => importServiceDefinition(resolve(file), space)); }
  else {
    const available = servicePresets();
    const choice = available.length ? await untilInputEnds((signal) => prompts.select({ message: "Definition source", options: [{ value: "file:", label: "Import a version-1 definition file" }, ...available.map((row) => ({ value: `preset:${row.preset.name}`, label: oneLine(row.preset.name), hint: oneLine(row.preset.summary) }))], signal })) : "file:";
    if (prompts.isCancel(choice)) return cancelled("Service creation cancelled");
    if (choice.startsWith("preset:")) {
      const presetName = chosenPreset = choice.slice("preset:".length);
      const preset = forName(() => resolveServicePreset(presetName));
      const guided = await guidedPreset(preset);
      if (!guided) return cancelled("Service creation cancelled");
      const values = guided;
      definition = forName(() => servicePresetDefinition(preset, space, values));
    } else {
      const file = await untilInputEnds((signal) => prompts.text({ message: "Version-1 service definition file", placeholder: "./reviews.service.json", signal }));
      if (prompts.isCancel(file)) return cancelled("Service creation cancelled");
      definition = forName(() => importServiceDefinition(resolve(file), space));
    }
    const answer = await untilInputEnds((signal) => prompts.confirm({ message: `Save ${oneLine(name)} in ${oneLine(space)}? Its program will not be started.`, initialValue: false, signal }));
    if (prompts.isCancel(answer) || !answer) return cancelled("Service creation cancelled");
  }
  const checked = definition;
  forName(() => validateServiceDefinition(checked, space));
  const record = store.commit(name, undefined, definition)!;
  writeResult(presentation, { command: "service", target: { ...target, name }, result: { kind: "service-definition-added", name, revision: record.revision, space, preset: chosenPreset ?? null, started: false, authorityGranted: false } }, (): Report => ({ sections: [{ title: "Service definition saved", blocks: [{ kind: "fields", rows: [["Name", name], ["Space", space], ["Execution host", "this machine"], ["Revision", record.revision], ["Process", "not started"], ["Authority", "not granted"]] }, { kind: "lines", lines: [{ text: "Only the owner-private definition was saved. Referenced credential contents were not read. This declaration is not a process sandbox.", tone: "hint" }] }] },
    { title: "Next", blocks: [{ kind: "commands", items: [{ command: `cotal svc start ${name}`, description: "Start it; dependencies are not started for it" }, { command: `cotal svc show ${name}`, description: "Read its saved launch and readiness policy" }] }] }] }));
  function cancelled(title: string): void { writeResult(presentation, { command: "service", target, result: { kind: "service-definition-change", changed: false }, noOp: true }, () => ({ sections: [{ title, blocks: [{ kind: "lines", lines: ["No service definition, process or OS unit was changed."] }] }] })); }
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
      return { items: serviceDefinitionStore(space).list().map((row) => ({ value: row.name })), directive: "nofiles" };
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
      const set = await untilInputEnds((signal) => prompts.confirm({ message: `Set optional --${name}?`, initialValue: false, signal }));
      if (prompts.isCancel(set)) return undefined;
      if (!set) continue;
    }
    if (option.type === "boolean") {
      const answer = await untilInputEnds((signal) => prompts.confirm({ message: `Enable --${name}?`, initialValue: false, signal }));
      if (prompts.isCancel(answer)) return undefined;
      values[name] = answer;
    } else {
      const answer = await untilInputEnds((signal) => prompts.text({ message: option.type === "string" ? `Non-secret value for --${name}` : `JSON ${String(option.type)} for --${name}`, signal }));
      if (prompts.isCancel(answer)) return undefined;
      values[name] = answer;
    }
  }
  return values;
}
