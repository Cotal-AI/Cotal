import { assertIdToken, decodeEntry, endpointToken, lastKvEntries, recordsBucket, type RunHostPlanes } from "@cotal-ai/core";

/** Discovery only. The caller re-reads a candidate's record before attempting takeback. */
export async function findRunningRunIds({ jsm, kv, space }: RunHostPlanes, endpoint: string): Promise<string[]> {
  const prefix = `run.${endpointToken(endpoint)}`;
  const filter = `${prefix}.*.*`;
  const bucket = recordsBucket(space);
  // The leader pins the tail before we scan. A replica may serve Direct Get, but a clean end
  // below this revision is not evidence that the scan saw all matching writes.
  const tail = await jsm.streams.getMessage(`KV_${bucket}`, { last_by_subj: `$KV.${bucket}.${filter}` });
  if (tail === null) return [];
  const entries = await lastKvEntries(kv, filter);
  if (!entries.some((entry) => entry.revision >= tail.seq))
    throw new Error(`the batched scan did not reach the leader's run inventory revision ${tail.seq} for ${endpoint}`);
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
