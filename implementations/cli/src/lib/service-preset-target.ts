import { registry, type ParsedArgs } from "@cotal-ai/core";
import { CommandFailure, canonicalRoot, hasUserAuthState, localProcessPath, localProcessVisible, oneLine, parsePid, probeLiveness, readPidfile, type LocalProcess, type ServiceDefinitionInput, type ServicePreset } from "@cotal-ai/workspace";
import { serviceDefinitionStore, validateServiceDefinition, type ServiceDefinitionSnapshot } from "./service-definitions.js";
import { observeServiceProcess, serviceInstances } from "./service-instances.js";
import { resolveServiceAdapter } from "./service-adapters.js";
import { findServicePreset, presetStartFlags, servicePresetDefinition } from "./service-presets.js";
import { selfArgv } from "./self-exec.js";
import { removableServiceInstances, removeStoppedInstanceRecords } from "./service-process.js";
import { addedDefinitionStep, STACK_DEFINITION } from "./stack-journal.js";

/** A preset name a service command resolved to the definition it acts on. `saved` says what this
 *  command saved first: a definition from the preset's defaults, or one saved again with the
 *  options the start named. */
export interface PresetServiceTarget {
  readonly requested: string;
  readonly name: string;
  readonly preset: string;
  readonly saved: { readonly kind: "created" | "redefined"; readonly options: readonly string[] } | null;
  /** A process of the preset's name that `up` or a daemon entry started and recorded by PID alone,
   *  with no saved service: the service controller does not own it and starts none beside it. */
  readonly recorded?: { readonly pid: number; readonly label: string };
}

/** The live PID record a local process of the preset's own name keeps in `root`, if any. A record
 *  that cannot be read is left to the adapter, which refuses an unresolved one at launch. */
export function recordedPresetProcess(space: string, root: string, preset: ServicePreset): { pid: number; label: string } | undefined {
  const provider = registry.all<LocalProcess>("local-process").find((row) => row.name === preset.name && row.pidFile !== undefined);
  if (!provider) return undefined;
  try {
    const context = { root, space, userAuth: hasUserAuthState(root, space, { readOnly: true }) };
    if (!localProcessVisible(provider, context)) return undefined;
    const raw = readPidfile(localProcessPath(provider.pidFile, context));
    const pid = raw === undefined ? undefined : parsePid(raw);
    return pid !== undefined && probeLiveness(pid) === "alive" ? { pid, label: provider.label } : undefined;
  } catch { return undefined; }
}

const isStackDefinition = (name: string) => (Object.values(STACK_DEFINITION) as string[]).includes(name);
const running = (space: string, name: string) => serviceInstances(space, name).some((row) => observeServiceProcess(row.record.value) === "running");

/** The definitions of `space` built on `preset`'s adapter in `root`: the one a start of the preset
 *  saved, the stack member `up` saved, and any a person added with `--preset`. */
export function presetDefinitions(space: string, root: string, preset: ServicePreset): ServiceDefinitionSnapshot[] {
  const here = canonicalRoot(root);
  return serviceDefinitionStore(space, addedDefinitionStep).list().filter((row) => {
    const value = row.record.value, launch = value.launch;
    if (launch.type !== "adapter" || launch.adapter !== preset.adapter) return false;
    const added = value.root ?? (typeof launch.options.root === "string" ? launch.options.root : undefined);
    return added !== undefined && canonicalRoot(added) === here;
  });
}

/** The option names a start named on its own line, as their preset option (`--no-x` names `x`). */
function namedOptions(name: string, values: ParsedArgs["values"]): string[] {
  const flags = new Set(presetStartFlags(name));
  return [...new Set(Object.keys(values).filter((key) => flags.has(key) && values[key] !== undefined).map((key) => key.startsWith("no-") && flags.has(key.slice(3)) ? key.slice(3) : key))];
}

function ambiguous(space: string, requested: string, rows: readonly ServiceDefinitionSnapshot[], mode: string): CommandFailure {
  const names = rows.map((row) => row.name);
  return new CommandFailure("refused", "TARGET_AMBIGUOUS", `${names.length} saved services in space ${oneLine(space)} run the ${requested} preset (${names.join(", ")}); nothing was ${mode === "start" ? "started" : "changed"}`, {
    target: { space, name: requested, candidates: names },
    remedy: names.map((name) => `cotal service ${mode} ${name}`).join(", or "),
  });
}

/** Resolve a preset name given to a service action to the one definition of this space it means.
 *  A saved definition of that exact name always wins and is returned as itself. Otherwise a start
 *  with no definition saves one from the preset's defaults and the options it named; a start of an
 *  existing, stopped one with other options saves it again. A log read of `stack-manager` with no
 *  such definition reaches the manager `up` recorded by PID. Undefined when the name is no preset. */
export function resolvePresetService(space: string, root: string, requested: string, mode: string, values: ParsedArgs["values"]): PresetServiceTarget | undefined {
  const store = serviceDefinitionStore(space, addedDefinitionStep);
  const exact = store.read(requested);
  const preset = findServicePreset(requested);
  const options = mode === "start" && preset ? namedOptions(requested, values) : [];
  if (exact) {
    // A definition that is not this preset's takes no preset options on its start line.
    if (!options.length) return undefined;
    const launch = exact.record.value.launch;
    if (launch.type !== "adapter" || launch.adapter !== preset!.adapter) throw new CommandFailure("refused", "USAGE_INVALID", `${requested} is a saved service of your own, not the ${requested} preset; its options are fixed when it is added`, { target: { space, name: requested }, remedy: `cotal service start ${requested}` });
    return redefine(space, root, preset!, exact, requested, options, values);
  }
  if (!preset) {
    // `up`'s retained launcher saves no stack-manager, so for a log read that name means the manager it started.
    const manager = mode === "logs" && requested === STACK_DEFINITION.manager ? findServicePreset("manager") : undefined;
    const recorded = manager && recordedPresetProcess(space, root, manager);
    return recorded ? { requested, name: requested, preset: manager.name, saved: null, recorded } : undefined;
  }
  const rows = presetDefinitions(space, root, preset);
  const live = rows.filter((row) => running(space, row.name));
  const chosen = live.length === 1 ? live[0] : live.length > 1 ? undefined : rows.length === 1 ? rows[0] : undefined;
  if (rows.length > 1 && !chosen) throw ambiguous(space, requested, live.length > 1 ? live : rows, mode);
  if (chosen) return options.length ? redefine(space, root, preset, chosen, requested, options, values) : { requested, name: chosen.name, preset: preset.name, saved: null };
  const recorded = recordedPresetProcess(space, root, preset);
  if (recorded) return { requested, name: requested, preset: preset.name, saved: null, recorded };
  if (mode === "install") throw adapterInstallRefusal(space, requested, preset.adapter, {}, requested === "manager" ? "manager" : undefined, { space, name: requested });
  if (mode !== "start") throw new CommandFailure("refused", "TARGET_NOT_FOUND", `no ${requested} has been started in space ${oneLine(space)}; nothing was ${mode === "status" || mode === "logs" ? "read" : "changed"}`, {
    target: { space, name: requested },
    remedy: requested === "manager" ? "start it with cotal manager start" : `start it with cotal service start ${requested}`,
  });
  if (values["dry-run"]) return { requested, name: requested, preset: preset.name, saved: null };
  const definition: ServiceDefinitionInput = { ...servicePresetDefinition(preset, space, values, root, "start"), root };
  store.commit(requested, undefined, validateServiceDefinition(definition, space));
  return { requested, name: requested, preset: preset.name, saved: { kind: "created", options } };
}

/** Save `row` again with the options a start named, when they differ from the saved ones. Only a
 *  definition with no running, supervised or retained instance is saved again, as `service remove`
 *  requires; the stack's own definitions keep the options `up` gave them. */
function redefine(space: string, root: string, preset: ServicePreset, row: ServiceDefinitionSnapshot, requested: string, options: readonly string[], values: ParsedArgs["values"]): PresetServiceTarget {
  const launch = row.record.value.launch;
  if (launch.type !== "adapter") throw new CommandFailure("refused", "CONFLICT", "a preset service's saved definition is not an adapter launch; it was not changed");
  const fresh = servicePresetDefinition(preset, space, values, root, "start").launch as Extract<ServiceDefinitionInput["launch"], { type: "adapter" }>;
  const changed = options.filter((name) => JSON.stringify(fresh.options[name]) !== JSON.stringify(launch.options[name]));
  if (!changed.length) return { requested, name: row.name, preset: preset.name, saved: null };
  const shown = changed.map((name) => `--${name}`).join(", ");
  if (isStackDefinition(row.name)) throw new CommandFailure("refused", "CONFLICT", `${requested} here is ${row.name}, which cotal up saved with its own ${shown}; nothing was changed`, { target: { space, name: row.name }, remedy: `start it as cotal up saved it with cotal service start ${row.name}, or pass ${shown} to cotal up` });
  if (running(space, row.name)) throw new CommandFailure("refused", "LIFECYCLE_BLOCKED", `${row.name} is running with another ${shown}; nothing was changed`, { target: { space, name: row.name }, remedy: `stop it first with ${requested === "manager" ? "cotal manager stop" : `cotal service stop ${row.name}`}, then start it again with the new ${shown}` });
  removableServiceInstances(space, row.name);
  const next: ServiceDefinitionInput = { ...row.record.value, launch: { ...launch, options: Object.fromEntries(Object.entries({ ...launch.options, ...Object.fromEntries(changed.map((name) => [name, fresh.options[name]])) }).filter(([, value]) => value !== undefined)) } };
  const checked = validateServiceDefinition(next, space);
  const store = serviceDefinitionStore(space, addedDefinitionStep);
  store.commit(row.name, row, undefined, () => removeStoppedInstanceRecords(space, row.name));
  store.commit(row.name, undefined, checked);
  return { requested, name: row.name, preset: preset.name, saved: { kind: "redefined", options: changed } };
}

/** Forget a definition this command saved from a preset's defaults when its first start was refused
 *  before any launch, with the stopped instance record that start allocated, so a refused start
 *  leaves nothing behind. False when anything else holds it now; it is then kept as it is. */
export function forgetRefusedPresetService(space: string, name: string): boolean {
  try {
    const store = serviceDefinitionStore(space, addedDefinitionStep), row = store.read(name);
    if (!row) return true;
    store.commit(name, row, undefined, () => removeStoppedInstanceRecords(space, name));
    return store.read(name) === undefined;
  } catch { return false; }
}

/** Why `service install` refuses an adapter service. A Cotal-written unit replaces itself with one
 *  direct process, and an adapter's start and stop, such as the manager's native stop request, need
 *  their own handoff under the unit, which the unit entry does not do yet. The remedy names a unit
 *  line that works when the adapter runs in the foreground. `command` is `manager` when the person
 *  typed the manager's own command. */
export function adapterInstallRefusal(space: string, name: string, adapter: string, options: Readonly<Record<string, unknown>>, command: "manager" | undefined, target: Record<string, unknown>): CommandFailure {
  const declaration = resolveServiceAdapter(adapter, options, false).declaration;
  let entry = "cotal";
  try { entry = selfArgv().join(" "); } catch { /* the bare name stands for an unverified entry */ }
  const foreground = command === "manager" ? "manager start --foreground" : `service start ${name} --foreground`;
  return new CommandFailure("refused", "UNSUPPORTED", `${command === "manager" ? "cotal manager install" : `cotal service install ${name}`} is not supported yet: a Cotal-written unit runs only a direct-process service, and ${name} is a ${adapter} service whose stop is ${declaration.stop === "native" ? "a native request" : "its own"}; nothing was installed or allocated`, {
    target,
    remedy: declaration.capabilities.foreground
      ? `run it from your own systemd user unit with ExecStart=${entry} ${foreground} --space ${space} and KillMode=mixed${command === "manager" ? ", or keep an existing unit on cotal supervise for now" : ""}`
      : `start it with cotal service start ${name}`,
  });
}
