import { localProcessPath } from "@cotal-ai/workspace";
import { pidfileState } from "../commands/down.js";
import { localProcessSurface } from "../ext-loader.js";
import { observeServiceProcess, serviceInstances } from "./service-instances.js";
import { processGone, readStackJournal, STACK_ADAPTER, STACK_DEFINITION } from "./stack-journal.js";

/** The members of this machine's stack for `space` in `root`, other than its broker, whose process
 *  is not proven gone: on a controller root its service instances, on a legacy root its recorded
 *  daemons. `controller` says which, and `services` lists the instances among them that are not the
 *  stack's own members, such as a service the user added. Throws when those records cannot be read. */
export function runningStackMembers(root: string, space: string): { controller: boolean; members: string[]; services: { definition: string; instanceId: string }[] } {
  const controller = readStackJournal(root)?.journal.space === space;
  if (!controller) {
    const members = localProcessSurface().filter((component) => !component.stopLast && pidfileState(localProcessPath(component.pidFile, { root, space })).liveness !== "dead").map((component) => component.label);
    return { controller, members: [...new Set(members)], services: [] };
  }
  const running = serviceInstances(space).filter((row) => row.record.value.adapter?.name !== STACK_ADAPTER.broker && !processGone(observeServiceProcess(row.record.value)));
  const stack = new Set(Object.values(STACK_DEFINITION));
  return {
    controller,
    members: [...new Set(running.map((row) => row.record.value.definition))],
    services: running.filter((row) => !stack.has(row.record.value.definition)).map((row) => ({ definition: row.record.value.definition, instanceId: row.name })),
  };
}
