import type { KV, KvEntry } from "@nats-io/kv";
import { decodeRecordJson, endpointNameOf, parseRecordKey, parseRunSpec, parseRunStatus, readCheckpointSpec, readCheckpointStatus,
  readRunProgram, recordAtomicKey, recordSpecKey, recordStatusKey, RECORD_KINDS, walkKvLatest } from "@cotal-ai/core";

export interface WorkflowQuiescenceObservation {
  unknown: boolean;
  recordsEnumerated: number;
  activeRuns: number;
  waitingCheckpoints: number;
}

/** Internal workflow-only census. The caller binds this KV with allow_direct:false, checks its
 * canonical stream and brackets the read with stream-stability observations. No rows are written. */
export async function observeWorkflowQuiescence(records: KV): Promise<WorkflowQuiescenceObservation> {
  const result: WorkflowQuiescenceObservation = { unknown: false, recordsEnumerated: 0, activeRuns: 0, waitingCheckpoints: 0 };
  let entries: KvEntry[];
  try { entries = await walkKvLatest(records, ">"); }
  catch { return { ...result, unknown: true }; }
  result.recordsEnumerated = entries.length;
  const byKey = new Map(entries.map(entry => [entry.key, entry]));
  const runs = new Map<string, [string, string]>();
  const checkpoints = new Map<string, [string, string]>();
  const kinds = [RECORD_KINDS.run.kind, RECORD_KINDS.program.kind, RECORD_KINDS.cp.kind];
  for (const entry of entries) {
    if (!kinds.some(kind => entry.key.startsWith(`${kind}.`))) continue;
    try {
      const parsed = parseRecordKey(entry.key);
      if (!parsed || parsed.qualifiers.length !== 2 || entry.operation !== "PUT") throw new Error("invalid workflow record");
      const coordinates: [string, string] = [endpointNameOf(parsed.qualifiers[0]!), parsed.qualifiers[1]!];
      const rebuilt = parsed.part === "atomic" ? recordAtomicKey(parsed.def, coordinates)
        : parsed.part === "spec" ? recordSpecKey(parsed.def, coordinates) : recordStatusKey(parsed.def, coordinates);
      if (rebuilt !== entry.key) throw new Error("workflow record key mismatch");
      (parsed.def.kind === RECORD_KINDS.cp.kind ? checkpoints : runs).set(coordinates.join("\u0000"), coordinates);
    } catch { result.unknown = true; }
  }
  for (const [endpoint, runId] of runs.values()) {
    try {
      const specKey = recordSpecKey(RECORD_KINDS.run, [endpoint, runId]);
      const statusKey = recordStatusKey(RECORD_KINDS.run, [endpoint, runId]);
      const specEntry = byKey.get(specKey), statusEntry = byKey.get(statusKey);
      const programEntry = byKey.get(recordAtomicKey(RECORD_KINDS.program, [endpoint, runId]));
      if (!specEntry || !statusEntry || !programEntry || [specEntry, statusEntry, programEntry].some(entry => entry.operation !== "PUT"))
        throw new Error("incomplete workflow record");
      const spec = parseRunSpec(decodeRecordJson(specEntry.value, specKey, true), specKey);
      const status = parseRunStatus(decodeRecordJson(statusEntry.value, statusKey, true), statusKey);
      const program = await readRunProgram(records, endpoint, runId);
      if (!program || program.run !== runId || spec.run !== runId || status.observedSpecRevision !== specEntry.revision)
        throw new Error("inconsistent workflow record");
      if (status.state !== "completed" && status.state !== "failed") result.activeRuns++;
    } catch { result.unknown = true; }
  }
  for (const [endpoint, token] of checkpoints.values()) {
    try {
      const qualifiers = [endpoint, token];
      const specEntry = byKey.get(recordSpecKey(RECORD_KINDS.cp, qualifiers));
      const statusEntry = byKey.get(recordStatusKey(RECORD_KINDS.cp, qualifiers));
      if (!specEntry || !statusEntry || specEntry.operation !== "PUT" || statusEntry.operation !== "PUT")
        throw new Error("incomplete checkpoint record");
      const spec = await readCheckpointSpec(records, { endpoint, token });
      const status = await readCheckpointStatus(records, { endpoint, token });
      if (!spec || !status || status.revision !== statusEntry.revision || status.value.observedSpecRevision !== specEntry.revision)
        throw new Error("inconsistent checkpoint record");
      if (status.value.state === "waiting") result.waitingCheckpoints++;
    } catch { result.unknown = true; }
  }
  return result;
}
