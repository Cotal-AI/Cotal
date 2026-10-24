import { randomUUID } from "node:crypto";
import { isAbsolute } from "node:path";
import { MANAGED_HANDOFF_FILE_ENV, token, type Command, type ParsedArgs } from "@cotal-ai/core";
import { CommandFailure, canonicalRoot, localRecordName, protectedLocalDirectory, serviceOperationId } from "@cotal-ai/workspace";
import { seedGeneration } from "../seed/paths.js";
import { selfArgv } from "../lib/self-exec.js";
import { assertPrivateSystemdGeneration } from "../lib/service-private-seed.js";
import { serviceDefinitionStore } from "../lib/service-definitions.js";
import { serviceInstallIntentFor } from "../lib/service-install-intent.js";
import { serviceUninstallIntentFor } from "../lib/service-uninstall-intent.js";
import { serviceUnitActionFor } from "../lib/service-unit-action.js";
import { observeServiceProcess, processServiceHost, requireProcessIdentity, serviceInstanceStore, type ServiceInstance } from "../lib/service-instances.js";
import { prepareProcessService } from "../lib/service-process.js";
import { observeRecordedSupervisor } from "../lib/service-systemd.js";
import { serviceSupervisorProjection, serviceSupervisorStore } from "../lib/service-supervision.js";

type Execve = (file: string, args: string[], env: NodeJS.ProcessEnv) => never;

function validate(args: ParsedArgs): void {
  if (args.positionals.length || ["control-home", "space", "definition", "instance"].some((name) => typeof args.values[name] !== "string" || !args.values[name])) throw new CommandFailure("refused", "USAGE_INVALID", "the unit entry requires its complete recorded controller home, space, definition and full instance");
  if (Object.keys(process.env).some((key) => key.toUpperCase() === MANAGED_HANDOFF_FILE_ENV)) throw new CommandFailure("refused", "CONFLICT", "the unit entry cannot consume a managed spawn handoff; its file was not read or removed");
  const home = String(args.values["control-home"]), space = String(args.values.space);
  if (!isAbsolute(home) || home.length > 4096 || /[\u0000-\u001f\u007f]/u.test(home) || !process.env.COTAL_HOME) throw new CommandFailure("refused", "USAGE_INVALID", "the unit entry needs its bounded explicit controller home; no other service store was selected");
  if (space.length > 200 || token(space) !== space) throw new CommandFailure("refused", "USAGE_INVALID", "the unit entry needs one exact recorded space token");
  localRecordName(String(args.values.definition));
  serviceOperationId(args.values.instance);
  try {
    protectedLocalDirectory(home);
    if (canonicalRoot(home) !== canonicalRoot(process.env.COTAL_HOME)) throw new Error();
  } catch { throw new CommandFailure("refused", "CONFLICT", "the unit entry did not retain its protected explicit controller home; no other service store was selected"); }
}

/** Unit boot is a native process replacement, not a detached child plus a supervisor wrapper.
 *  No seed/install/reconcile runs here. Native adapter units need their own stop/caller handoff. */
export const serviceUnitEntry: Command = {
  kind: "command", name: "__service-unit", hidden: true, prepareMeshTarget: false,
  summary: "versioned owned user-unit entry for a recorded direct process definition",
  flags: ["control-home", "space", "definition", "instance"].map((name) => ({ name, type: "string" as const })),
  validate,
  async run(args) {
    validate(args);
    const replace = (process as NodeJS.Process & { execve?: Execve }).execve;
    if (process.platform !== "linux" || typeof replace !== "function") throw new CommandFailure("refused", "UNSUPPORTED", "this unit entry requires Linux and native process replacement from Node 22.15 or newer; no detached wrapper was substituted");
    const space = String(args.values.space), id = serviceOperationId(args.values.instance);
    const definitions = serviceDefinitionStore(space), definition = definitions.read(String(args.values.definition));
    if (!definition || definition.record.value.launch.type !== "process") throw new CommandFailure("refused", "UNSUPPORTED", "this unit entry requires its exact saved direct-process definition; native adapter/caller semantics were not substituted");
    const hold = definitions.pin(definition);
    const instances = serviceInstanceStore(space);
    let prepared: ReturnType<typeof prepareProcessService>;
    try {
      const original = instances.read(id);
      if (!original || original.record.value.definition !== definition.name || original.record.value.definitionRevision !== definition.record.revision) throw new CommandFailure("refused", "CONFLICT", "the unit's instance and definition revision no longer agree");
      if (serviceInstallIntentFor(space, id) || serviceUninstallIntentFor(space, id)) throw new CommandFailure("refused", "LIFECYCLE_BLOCKED", "the original unit installation or removal attempt has not settled; no service process was replaced");
      const action = serviceUnitActionFor(space, id)?.record.value;
      if (action && (action.operation !== "start" || action.position !== "submitted")) throw new CommandFailure("refused", "LIFECYCLE_BLOCKED", "an unresolved native service action is retained; no later unit invocation replaced its process");
      const host = processServiceHost(), self = requireProcessIdentity(process.pid);
      if (host.machine !== original.record.value.host.machine || host.uid !== original.record.value.host.uid) throw new CommandFailure("refused", "CONFLICT", "the unit's instance belongs to another execution host or OS user");
      const recorded = serviceSupervisorProjection(original.record.value, host);
      if (action && (action.definition !== definition.name || action.definitionRevision !== definition.record.revision || action.machine !== host.machine || action.uid !== host.uid || action.unit !== recorded.unit || action.unitPath !== recorded.unitPath || action.unitSha256 !== serviceSupervisorStore(space).read(id)?.record.value.unitSha256)) throw new CommandFailure("refused", "CONFLICT", "the retained native start action does not match this exact owned unit and host");
      const unit = observeRecordedSupervisor(original.record.value, recorded);
      if (recorded.mechanism !== "systemd-user" || unit.state !== "observed" || unit.mainPid !== self.pid || !unit.invocationId || unit.invocationId !== process.env.INVOCATION_ID || unit.daemonReloadRequired || unit.dropInsReported) throw new CommandFailure("refused", "LIFECYCLE_BLOCKED", "the native user manager did not bind this process to the unchanged recorded unit invocation; no process replacement was attempted");
      const receipt = serviceSupervisorStore(space).read(id)?.record.value;
      let cli: string[];
      try { cli = selfArgv(); }
      catch { throw new CommandFailure("refused", "UNSUPPORTED", "the native unit entry is not a durable Cotal executable"); }
      if (!receipt || receipt.seededGeneration !== seedGeneration() || cli.length !== 2) throw new CommandFailure("refused", "LIFECYCLE_BLOCKED", "the unit's private store generation does not match this executable; no process replacement was attempted");
      assertPrivateSystemdGeneration(receipt.privateHome, receipt.seededGeneration, cli[1]!);
      if (["starting", "stopping", "unknown"].includes(original.record.value.state)) throw new CommandFailure("refused", "LIFECYCLE_BLOCKED", "the original unit attempt has no settled lifecycle outcome; no later invocation replaced its retained request");
      const prior = observeServiceProcess(original.record.value);
      if (!["gone", "previous-boot", "foreign-pid"].includes(prior) && !(prior === "running" && original.record.value.process?.pid === self.pid && original.record.value.process.token === self.token)) throw new CommandFailure("refused", "LIFECYCLE_BLOCKED", "a live or unresolved prior service incarnation is retained; the unit entry did not launch beside it");
      prepared = prepareProcessService(definition);
      if (!prepared.program || prepared.adapter) throw new CommandFailure("refused", "UNSUPPORTED", "the unit entry did not resolve an accepted direct executable; no adapter was loaded");
      hold.check();
      const requestId = randomUUID(), now = new Date().toISOString();
      const value: ServiceInstance = { schemaVersion: 1, instanceId: id, definition: definition.name, definitionRevision: definition.record.revision, space, host, requestId, launchRequestId: requestId, state: "starting", launcher: self, process: self, readiness: "not-checked", supervisor: "none", supervisorInvocationId: unit.invocationId, foreground: false, createdAt: original.record.value.createdAt, updatedAt: now };
      instances.commit(id, original, value);
    } finally { hold.release(); }
    try {
      // There are no package loads or awaits between cwd selection and native replacement.
      process.chdir(definition.record.value.launch.cwd);
      replace.call(process, prepared.program!, [prepared.program!, ...definition.record.value.launch.args], prepared.env);
    } catch {
      // Older supported Node versions can abort on exec failure; absence of this report must
      // therefore remain an unknown starting attempt, never proof that nothing happened.
      throw new CommandFailure("unknown", "OPERATION_UNKNOWN", "the original unit process replacement did not confirm execution; its starting request was retained and no executable was retried");
    }
  },
};
