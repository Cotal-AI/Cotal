import { CommandFailure, assertRecordIdentity, logicalExecutionEntry, resolveControlTarget } from "@cotal-ai/workspace";
import { askManager } from "@cotal-ai/workspace/control";
import { recordedUpdateManagers } from "../lib/update-managers.js";
import { entryScript } from "./paths.js";

/** Automatic migration cannot replace a live older Manager's home-local connector graph. */
export async function assertAutomaticSeedManagers(generation: string): Promise<void> {
  for (const manager of recordedUpdateManagers({}, logicalExecutionEntry() ?? entryScript())) {
    if (!manager.process || assertRecordIdentity(manager.process).kind !== "match")
      throw new CommandFailure("refused", "LIFECYCLE_BLOCKED", "a local Manager changed before connector reconciliation; no connectors were changed");
    const target = await resolveControlTarget({ space: manager.space, server: manager.server }, "control-caller-admin", manager.instanceId, { onRefusal: "throw", readOnly: true });
    const { cliControl } = await import("../lib/control.js");
    const reply = await askManager(cliControl, target.space, target.server, "managerStatus", undefined, target.auth, "owner", undefined, { instanceId: manager.instanceId });
    if (!reply.ok || assertRecordIdentity(manager.process).kind !== "match")
      throw new CommandFailure("refused", "LIFECYCLE_BLOCKED", `Manager ${manager.instanceId} could not confirm its running generation; no connectors were changed`);
    const version = (reply.data as { version?: unknown } | undefined)?.version;
    if (version !== generation)
      throw new CommandFailure("refused", "LIFECYCLE_BLOCKED", `Manager ${manager.instanceId} in ${manager.space} still runs Cotal ${typeof version === "string" ? version : "an unidentified version"}; automatic connector reconciliation left this home's extensions unchanged`);
  }
}
