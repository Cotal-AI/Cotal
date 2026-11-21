import type { KV } from "@nats-io/kv";
import { assertIdToken, decodeEntry, endpointToken, lastKvEntries } from "@cotal-ai/core";

/** Discovery only. The caller re-reads a candidate's record before attempting takeback. */
export async function findRunningRunIds(kv: KV, endpoint: string): Promise<string[]> {
  const prefix = `run.${endpointToken(endpoint)}`;
  const entries = await lastKvEntries(kv, `${prefix}.*.*`);
  const live = new Set(entries.filter((entry) => entry.operation === "PUT").map((entry) => entry.key));
  const running: string[] = [];
  for (const entry of entries) {
    const [, , id, part] = entry.key.split(".");
    if (entry.operation !== "PUT" || part !== "status" || id === undefined || !live.has(`${prefix}.${id}.spec`)) continue;
    const status = decodeEntry<{ state?: unknown } | null>(entry, entry.key);
    if (status?.state === "running") running.push(assertIdToken(id, "runId"));
  }
  return running;
}
