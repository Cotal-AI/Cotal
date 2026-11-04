import { randomUUID } from "node:crypto";
import { CommandFailure, isCommandFailure } from "@cotal-ai/workspace";
import { serviceDefinitionStore, type ServiceDefinitionSnapshot } from "./service-definitions.js";
import { prepareProcessService } from "./service-process.js";
import { processServiceHost, requireProcessIdentity, serviceInstances, serviceInstanceStore, type ServiceInstance } from "./service-instances.js";

/** Install with no existing instances first reserves one stopped full ID. This creates no
 *  process, unit or private store. A failed publication is never retried with another ID. */
export function reserveStoppedServiceInstance(definition: ServiceDefinitionSnapshot) {
  const space = definition.record.value.space, name = definition.name;
  if (definition.record.value.launch.type !== "process" || Object.keys(definition.record.value.envRefs ?? {}).length || definition.record.value.credentialRef) throw new CommandFailure("refused", "UNSUPPORTED", "a native unit needs a direct process without host environment or credential references; no instance was allocated");
  const hold = serviceDefinitionStore(space).pin(definition);
  try {
    if (!prepareProcessService(definition).program) throw new CommandFailure("refused", "UNSUPPORTED", "the native unit has no accepted direct executable; no instance was allocated");
    const existing = serviceInstances(space, name);
    if (existing.length) throw new CommandFailure("refused", existing.length === 1 ? "LIFECYCLE_BLOCKED" : "TARGET_AMBIGUOUS", "an instance already exists; select its full ID instead of allocating another service incarnation", { target: { space, name, candidates: existing.map((row) => row.name) } });
    hold.check();
    const id = randomUUID(), now = new Date().toISOString(), requestId = randomUUID();
    const value: ServiceInstance = { schemaVersion: 1, instanceId: id, definition: name, definitionRevision: definition.record.revision,
      space, host: processServiceHost(), requestId, launchRequestId: requestId, state: "stopped", launcher: requireProcessIdentity(process.pid),
      readiness: "not-checked", supervisor: "none", foreground: false, createdAt: now, updatedAt: now };
    const store = serviceInstanceStore(space);
    try {
      const saved = store.commit(id, undefined, value);
      const current = store.read(id);
      if (!saved || !current || current.record.revision !== saved.revision) throw new Error("stopped allocation publication did not confirm");
      return current;
    } catch (error) {
      if (isCommandFailure(error) && error.outcome === "refused" && error.code === "CONFLICT") throw error;
      throw new CommandFailure("unknown", "OPERATION_UNKNOWN", "the stopped service instance did not confirm publication; its full ID was retained and no second instance was allocated", { target: { space, name, instanceId: id } });
    }
  } finally { hold.release(); }
}
