import { localProcessPath } from "@cotal-ai/workspace";
import { pidfileState } from "../commands/down.js";
import { localProcessSurface } from "../ext-loader.js";
import { observeServiceProcess, serviceInstances } from "./service-instances.js";
import { processGone, readStackJournal, STACK_ADAPTER } from "./stack-journal.js";

/** The members of this machine's stack for `space` in `root`, other than its broker, whose process
 *  is not proven gone: on a controller root its service instances, on a legacy root its recorded
 *  daemons. `controller` says which. Throws when those records cannot be read. */
export function runningStackMembers(root: string, space: string): { controller: boolean; members: string[] } {
  const controller = readStackJournal(root)?.journal.space === space;
  const members = controller
    ? serviceInstances(space).filter((row) => row.record.value.adapter?.name !== STACK_ADAPTER.broker && !processGone(observeServiceProcess(row.record.value))).map((row) => row.record.value.definition)
    : localProcessSurface().filter((component) => !component.stopLast && pidfileState(localProcessPath(component.pidFile, { root, space })).liveness !== "dead").map((component) => component.label);
  return { controller, members: [...new Set(members)] };
}
