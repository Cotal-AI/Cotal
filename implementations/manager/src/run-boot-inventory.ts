import type { KV, KvEntry } from "@nats-io/kv";
import { assertStatusValue, decodeEntry, endpointToken, lastKvEntries, parseRecordKey, type RunStatusValue } from "@cotal-ai/core";

/** Direct Get only selects candidates. Takeback must read their current records before acting. */
export async function bootRunCandidates(kv: KV, endpoint: string): Promise<string[]> {
  const token = endpointToken(endpoint);
  const specs = new Set<string>();
  const statuses = new Map<string, KvEntry>();
  for (const entry of await lastKvEntries(kv, `run.${token}.*.*`)) {
    if (entry.operation === "DEL" || entry.operation === "PURGE") continue;
    const parsed = parseRecordKey(entry.key);
    if (parsed?.def.kind !== "run" || parsed.qualifiers[0] !== token) continue;
    const runId = parsed.qualifiers[1]!;
    if (parsed.part === "spec") specs.add(runId);
    else statuses.set(runId, entry);
  }
  return [...specs].filter((runId) => {
    const entry = statuses.get(runId);
    return entry !== undefined && assertStatusValue(decodeEntry<Pick<RunStatusValue, "state">>(entry, entry.key)).state === "running";
  });
}
