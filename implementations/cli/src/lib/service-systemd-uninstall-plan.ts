import { lstatSync } from "node:fs";
import { CommandFailure, protectedLocalDirectory } from "@cotal-ai/workspace";
import { type ServiceDefinitionSnapshot } from "./service-definitions.js";
import { serviceInstallIntentFor } from "./service-install-intent.js";
import { serviceUninstallIntentFor } from "./service-uninstall-intent.js";
import { fingerprintPrivateSystemdTree } from "./service-private-tree.js";
import { instanceProjection, processServiceHost, type ServiceInstanceSnapshot } from "./service-instances.js";
import { assertSystemdSource } from "./service-systemd-files.js";
import { observeRecordedSupervisor } from "./service-systemd.js";
import { serviceSupervisorStore } from "./service-supervision.js";
import { serviceUnitActionFor } from "./service-unit-action.js";

/** A read-only exact-unit removal candidate. The private directory observation confers no
 *  authority over its children. A writer must recheck every fact under its retained intent. */
export function inspectSystemdUninstall(definition: ServiceDefinitionSnapshot, selected: ServiceInstanceSnapshot) {
  const space = definition.record.value.space, target = { space, definition: definition.name, instanceId: selected.name };
  if (serviceInstallIntentFor(space, selected.name) || serviceUninstallIntentFor(space, selected.name) || serviceUnitActionFor(space, selected.name)) throw new CommandFailure("refused", "LIFECYCLE_BLOCKED", "a native installation, removal or control attempt is retained; no safe unit-removal state was inferred", { target });
  const saved = serviceSupervisorStore(space).read(selected.name);
  const receipt = saved?.record.value, host = processServiceHost();
  if (!saved || !receipt || receipt.mechanism !== "systemd-user" || receipt.instanceId !== selected.name || receipt.definition !== definition.name || receipt.definitionRevision !== definition.record.revision || receipt.machine !== host.machine || receipt.uid !== host.uid || selected.record.value.host.machine !== host.machine || selected.record.value.host.uid !== host.uid) throw new CommandFailure("refused", "CONFLICT", "the selected unit has no exact same-host supervisor receipt at the current definition revision", { target });
  const row = instanceProjection(selected);
  if (row.supervisorRecord.fileObservation !== "matches-recorded-bytes" || !["stopped", "failed"].includes(row.recordedState) || !["gone", "previous-boot"].includes(row.observedProcess)) throw new CommandFailure("refused", "LIFECYCLE_BLOCKED", "the original service incarnation or unit file is not settled and unchanged; no OS removal was authorized", { target });
  try { assertSystemdSource(receipt.unitPath, receipt.unitSha256); }
  catch { throw new CommandFailure("refused", "CONFLICT", "the recorded unit source could not be read as the same private physical bytes; no removal effect was submitted", { target }); }
  try {
    protectedLocalDirectory(receipt.privateHome);
    const stat = lstatSync(receipt.privateHome);
    if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== host.uid || (stat.mode & 0o077) !== 0) throw new Error("private store ownership changed");
  } catch { throw new CommandFailure("refused", "CONFLICT", "the recorded private store is missing, modified or unreadable; no owned cleanup was inferred", { target }); }
  if (!receipt.privateTreeSha256) throw new CommandFailure("refused", "UNSUPPORTED", "this supervisor receipt predates exact private-store ownership; no automatic deletion was inferred", { target });
  let privateTreeSha256: string;
  try { privateTreeSha256 = fingerprintPrivateSystemdTree(receipt.privateHome); }
  catch { throw new CommandFailure("refused", "CONFLICT", "the private unit tree could not be read as a bounded unchanged owned store; no native disable was submitted", { target }); }
  if (privateTreeSha256 !== receipt.privateTreeSha256) throw new CommandFailure("refused", "CONFLICT", "the private unit tree differs from its install receipt; no changed private content was marked removable", { target });
  const native = observeRecordedSupervisor(selected.record.value, row.supervisorRecord);
  if (native.state !== "observed" || native.loadState !== "loaded" || native.activeState !== "inactive" || native.mainPid !== null || native.unitFileState !== "enabled" || native.daemonReloadRequired || native.dropInsReported) throw new CommandFailure("refused", "LIFECYCLE_BLOCKED", "the unchanged exact unit is not loaded, inactive and enabled without drop-ins; no disable or removal was authorized", { target });
  return { target, receipt: saved, native };
}
