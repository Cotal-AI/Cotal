import { assertLifecycleToken, endpointToken, parseServiceSpec, parseServiceStatus, readSvcRecordLeader, recordsBucket } from "@cotal-ai/core";
import { jetstreamManager } from "@nats-io/jetstream";
import { CommandFailure, isCommandFailure, isConnectRefusal, type OutputWarning } from "@cotal-ai/workspace";
import { openEndpointConnection } from "./endpoint-client.js";

const MAX_REGISTRATION_READS = 1000;
export interface EndpointRegistration {
  endpoint: string;
  instanceId: string;
  owner: string;
  registrationRevision: number;
  epoch: number | null;
  reportedState: string | null;
  projection: "current" | "stale" | "changed-during-read" | "missing" | "unreadable";
  liveness: "not-checked";
  response: "not-checked";
}

/** Existing scoped svc metadata reads only. No consumer, service registration or broader grant. */
export async function readEndpointInventory(values: { space?: string; server?: string; creds?: string }) {
  const { nc, space } = await openEndpointConnection(values, "control-caller-privileged", "manager");
  const items: EndpointRegistration[] = [];
  const warnings: OutputWarning[] = [];
  let enumeratedKeys = 0;
  let omittedKeys = 0;
  try {
    const jsm = await jetstreamManager(nc, { checkAPI: false });
    const bucket = recordsBucket(space);
    const prefix = `$KV.${bucket}.`;
    // The locked SDK paginates filtered STREAM.INFO and merges its subject pages for this call.
    const info = await jsm.streams.info(`KV_${bucket}`, { subjects_filter: `${prefix}svc.*.*.spec` });
    const subjects = Object.keys(info.state.subjects ?? {}).sort();
    enumeratedKeys = subjects.length;
    omittedKeys = Math.max(0, subjects.length - MAX_REGISTRATION_READS);
    if (omittedKeys) warnings.push({ code: "REGISTRATION_READ_LIMIT", target: { space }, message: `${omittedKeys} enumerated registration keys were not read within this bounded snapshot; the live inventory is partial.` });
    for (const subject of subjects.slice(0, MAX_REGISTRATION_READS)) {
      if (!subject.startsWith(prefix)) throw new CommandFailure("refused", "SCHEMA_INVALID", "the registry enumeration returned an unexpected subject; a complete inventory was not inferred");
      const key = subject.slice(prefix.length);
      const [kind, endpoint, instanceId, part, extra] = key.split(".");
      if (kind !== "svc" || !endpoint || !instanceId || part !== "spec" || extra !== undefined) throw new CommandFailure("refused", "SCHEMA_INVALID", "the registry contains an invalid service key; it was not silently omitted");
      try { endpointToken(endpoint); assertLifecycleToken(instanceId, "instance"); }
      catch { throw new CommandFailure("refused", "SCHEMA_INVALID", "the registry contains a malformed native class or instance ID"); }
      const target = { space, endpoint, instanceId };
      try {
        const record = await readSvcRecordLeader(jsm, space, key);
        if (!record || "deleted" in record) continue;
        const spec = parseServiceSpec(record.value, { endpoint });
        const row: EndpointRegistration = { endpoint, instanceId, owner: spec.owner, registrationRevision: record.revision, epoch: null, reportedState: null, projection: "missing", liveness: "not-checked", response: "not-checked" };
        items.push(row);
        try {
          const statusRecord = await readSvcRecordLeader(jsm, space, `svc.${endpoint}.${instanceId}.status`);
          if (statusRecord && !("deleted" in statusRecord)) {
            const status = parseServiceStatus(statusRecord.value);
            row.epoch = status.epoch; row.reportedState = status.state;
            row.projection = status.observedSpecRevision === record.revision ? "current" : status.observedSpecRevision < record.revision ? "stale" : "changed-during-read";
            if (row.projection === "changed-during-read") warnings.push({ code: "REGISTRATION_CHANGED", target, message: "The status names a newer registration than the spec read; the coordinates were not presented as one atomic current snapshot." });
          }
        } catch {
          row.projection = "unreadable";
          warnings.push({ code: "REGISTRATION_STATUS_UNREADABLE", target, message: "The registered instance's status could not be read or validated; serving readiness was not inferred." });
        }
      } catch {
        warnings.push({ code: "REGISTRATION_SPEC_UNREADABLE", target, message: "An enumerated registration could not be read or validated; an absent or stopped endpoint was not inferred." });
      }
    }
    return { space, items, enumeratedKeys, omittedKeys, warnings, observedAt: new Date().toISOString(), enumeration: "bounded-lag-list" as const, coordinateReads: "leader-served" as const, liveness: "not-checked" as const, response: "not-checked" as const };
  } catch (error) {
    if (isCommandFailure(error)) throw error;
    if (isConnectRefusal(error)) throw error.failure();
    throw new CommandFailure("refused", "TARGET_UNAVAILABLE", "the authorized service registry could not be enumerated; an empty complete inventory was not inferred", { target: { space } });
  } finally { await nc.close(); }
}
