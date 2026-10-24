import { lstatSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { realDirNoSymlink } from "@cotal-ai/core";
import { CommandFailure, homeCotalDir } from "@cotal-ai/workspace";
import { serviceInstallIntentFor } from "./service-install-intent.js";
import { serviceUninstallIntentFor } from "./service-uninstall-intent.js";
import { serviceUnitActionFor } from "./service-unit-action.js";
import { type ServiceDefinitionSnapshot } from "./service-definitions.js";
import { instanceProjection, processServiceHost, type ServiceInstanceSnapshot } from "./service-instances.js";
import { prepareProcessService } from "./service-process.js";
import { selfArgv } from "./self-exec.js";
import { launchdServiceLabel, renderLaunchdServiceUnit } from "./service-launchd-unit.js";

/** Read-only LaunchAgent candidate. Neither its source bytes nor its path establish native ownership. */
export function inspectLaunchdInstall(definition: ServiceDefinitionSnapshot, selected: ServiceInstanceSnapshot) {
  const { space, launch } = definition.record.value, target = { space, name: definition.name, instanceId: selected.name };
  if (process.platform !== "darwin") throw new CommandFailure("refused", "UNSUPPORTED", "LaunchAgent inspection requires macOS; no other supervisor was substituted", { target });
  if (serviceInstallIntentFor(space, selected.name) || serviceUninstallIntentFor(space, selected.name) || serviceUnitActionFor(space, selected.name))
    throw new CommandFailure("refused", "LIFECYCLE_BLOCKED", "a native service operation remains unsettled; no fresh LaunchAgent candidate was adopted", { target });
  if (launch.type !== "process" || Object.keys(definition.record.value.envRefs ?? {}).length || definition.record.value.credentialRef)
    throw new CommandFailure("refused", "UNSUPPORTED", "LaunchAgent inspection needs a direct process without host environment or credential references", { target });
  const prepared = prepareProcessService(definition);
  if (!prepared.program || prepared.adapter) throw new CommandFailure("refused", "UNSUPPORTED", "this definition has no accepted direct executable for a LaunchAgent", { target });
  const host = processServiceHost(), value = selected.record.value, row = instanceProjection(selected);
  if (value.host.machine !== host.machine || value.host.uid !== host.uid || value.definitionRevision !== definition.record.revision || row.supervisorRecord.mechanism !== "none-recorded" || !["stopped", "failed"].includes(value.state) || !["gone", "previous-boot"].includes(row.observedProcess))
    throw new CommandFailure("refused", "LIFECYCLE_BLOCKED", "this instance is not an unowned, settled, stopped direct-process incarnation on this host", { target });
  let cli: string[];
  try { cli = selfArgv(); }
  catch { throw new CommandFailure("refused", "UNSUPPORTED", "the current command has no durable installed Cotal entry for a LaunchAgent", { target }); }
  const home = homedir();
  let homeStat: ReturnType<typeof lstatSync>;
  try { homeStat = lstatSync(home); }
  catch { throw new CommandFailure("refused", "TARGET_UNAVAILABLE", "the macOS account home could not be inspected; no LaunchAgent location was adopted", { target }); }
  if (!homeStat.isDirectory() || homeStat.isSymbolicLink() || homeStat.uid !== host.uid)
    throw new CommandFailure("refused", "CONFLICT", "the macOS account home is not a real directory owned by this service user; no LaunchAgent location was adopted", { target });
  let existingDirectory: string | null;
  try {
    const library = realDirNoSymlink(home, "Library");
    existingDirectory = library ? realDirNoSymlink(library, "LaunchAgents") : null;
  } catch { throw new CommandFailure("refused", "CONFLICT", "a macOS LaunchAgents path component is not a real directory; no unit path was adopted", { target }); }
  const directory = join(home, "Library", "LaunchAgents"), label = launchdServiceLabel(space, definition.name, selected.name);
  const unitPath = join(directory, `${label}.plist`), privateHome = join(homeCotalDir(), "service-launchd", label);
  const unit = renderLaunchdServiceUnit({ space, definition: definition.name, instanceId: selected.name, controlHome: homeCotalDir(), privateHome, workingDirectory: launch.cwd, searchPath: process.env.PATH ?? "", cli });
  let existing: "not-found-at-read" | "regular-unattributed" | "nonregular-unattributed" = "not-found-at-read";
  if (existingDirectory) {
    try { existing = lstatSync(unitPath).isFile() ? "regular-unattributed" : "nonregular-unattributed"; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw new CommandFailure("refused", "TARGET_UNAVAILABLE", "the proposed LaunchAgent path could not be inspected; no absent unit was inferred", { target: { ...target, unitPath } }); }
  }
  return { target, directory, directoryState: existingDirectory ? "real-directory" as const : "missing-at-read" as const, unitPath, privateHome, existing, unit };
}
