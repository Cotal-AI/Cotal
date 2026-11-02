import type { CotalEndpoint } from "../src/index.js";

/** Timestamp each roster after its read, so heartbeats received during the await are not future data. */
export async function readRosterSample(endpoint: Pick<CotalEndpoint, "readPresence">) {
  const roster = await endpoint.readPresence();
  return { roster, sampledAt: Date.now() };
}

interface NativeLoadCounters {
  requested: number; up: number; failed: number;
  missingMid: number; missingEnd: number; staleMid: number; staleEnd: number;
  endpointErrors: number; apiErrors: number; slowConsumers: number; brokerWarnings: number;
}

/** Fail measured native errors even when every child returns normally; keep the counters in the report. */
export function nativeLoadFailures(c: NativeLoadCounters): string[] {
  const failures: string[] = [];
  if (c.up !== c.requested || c.failed !== 0) failures.push(`starts ${c.up}/${c.requested}, failed ${c.failed}`);
  for (const key of ["missingMid", "missingEnd", "staleMid", "staleEnd", "endpointErrors", "apiErrors", "slowConsumers", "brokerWarnings"] as const)
    if (c[key] !== 0) failures.push(`${key}=${c[key]}`);
  return failures;
}
