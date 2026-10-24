import { lstatSync } from "node:fs";
import { join } from "node:path";
import { CommandFailure, homeCotalDir } from "@cotal-ai/workspace";
import { serviceInstallIntentFor } from "./service-install-intent.js";
import { serviceUninstallIntentFor } from "./service-uninstall-intent.js";
import { serviceUnitActionFor } from "./service-unit-action.js";
import { type ServiceDefinitionSnapshot } from "./service-definitions.js";
import { instanceProjection, type ServiceInstanceSnapshot } from "./service-instances.js";
import { prepareProcessService } from "./service-process.js";
import { selfArgv } from "./self-exec.js";
import { systemdUserUnitDirectory } from "./service-systemd.js";
import { renderSystemdServiceEnvironment, renderSystemdServiceUnit, systemdServiceUnitName } from "./service-systemd-unit.js";

/** Read-only candidate. Source bytes never belong in the finite CLI report; an installer
 *  must re-inspect under its locks before using them, and retain an effect intent. */
export function inspectSystemdInstall(definition: ServiceDefinitionSnapshot, selected: ServiceInstanceSnapshot | undefined) {
  const { space } = definition.record.value, name = definition.name;
  const target = { space, name, instanceId: selected?.name ?? null };
  if (!selected) throw new CommandFailure("refused", "TARGET_NOT_FOUND", "a native install preview needs one previously allocated full instance; no instance ID was invented", { target, remedy: "start and stop a direct-process instance, then select its full ID with --instance" });
  const pending = serviceInstallIntentFor(space, selected.name), removal = serviceUninstallIntentFor(space, selected.name);
  if (pending || removal) throw new CommandFailure("refused", "LIFECYCLE_BLOCKED", "an earlier native unit installation or removal attempt is retained; no clean uninstalled state or safe retry was inferred", { target: { ...target, attemptId: (pending ?? removal)!.record.value.attemptId, step: (pending ?? removal)!.record.value.step, position: (pending ?? removal)!.record.value.position }, remedy: "inspect the retained unit, private store and native enable state before reconciling this attempt" });
  if (serviceUnitActionFor(space, selected.name)) throw new CommandFailure("refused", "LIFECYCLE_BLOCKED", "an earlier native start or stop action is retained; no clean uninstalled state was inferred", { target });
  const launch = definition.record.value.launch;
  if (launch.type !== "process" || Object.keys(definition.record.value.envRefs ?? {}).length || definition.record.value.credentialRef) throw new CommandFailure("refused", "UNSUPPORTED", "this proposed unit supports direct process definitions without host environment or credential references only; no adapter or ambient value was assumed", { target });
  const prepared = prepareProcessService(definition);
  if (!prepared.program || prepared.adapter) throw new CommandFailure("refused", "UNSUPPORTED", "the proposed unit has no accepted direct executable; no native supervisor was installed", { target });
  const row = instanceProjection(selected);
  if (selected.record.value.definitionRevision !== definition.record.revision || row.supervisorRecord.mechanism !== "none-recorded" || !["stopped", "failed"].includes(selected.record.value.state) || !["gone", "previous-boot"].includes(row.observedProcess)) throw new CommandFailure("refused", "LIFECYCLE_BLOCKED", "the selected instance is not an unowned, settled, stopped direct-process incarnation at this definition revision; no unit impact was inferred", { target });
  let cli: string[];
  try { cli = selfArgv(); }
  catch { throw new CommandFailure("refused", "UNSUPPORTED", "the current command is not a verified durable Cotal entry; no unit invocation was guessed", { target }); }
  const directory = systemdUserUnitDirectory(), unitName = systemdServiceUnitName(space, name, selected.name);
  const unitPath = join(directory, unitName), privateHome = join(directory, "cotal-service", unitName.slice(0, -".service".length));
  const environmentFile = join(privateHome, "environment"), controlHome = homeCotalDir(), searchPath = process.env.PATH ?? "";
  const unit = renderSystemdServiceUnit({ space, definition: name, instanceId: selected.name, controlHome, workingDirectory: launch.cwd, environmentFile, cli });
  const environment = renderSystemdServiceEnvironment({ controlHome, configHome: join(privateHome, "config"), searchPath });
  let existing: "not-found-at-read" | "regular-unattributed" | "nonregular-unattributed" = "not-found-at-read";
  try { existing = lstatSync(unitPath).isFile() ? "regular-unattributed" : "nonregular-unattributed"; }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw new CommandFailure("refused", "TARGET_UNAVAILABLE", "the proposed unit path could not be inspected; no absent unit was inferred", { target: { ...target, unitPath } }); }
  return { target, directory, unitPath, privateHome, environmentFile, controlHome, searchPath, existing, unit, environment };
}
