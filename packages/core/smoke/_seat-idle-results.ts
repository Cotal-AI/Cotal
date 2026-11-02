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

export type NativeErrorSource = "start" | "error" | "warning" | "roster-read";
const errorNames = new Set([
  "AuthorizationError", "UserAuthenticationExpiredError", "TimeoutError", "RequestError",
  "NoResponders", "PermissionViolationError", "ConnectionError", "ClosedConnectionError",
  "DrainingConnectionError", "ProtocolError", "JetStreamApiError", "JetStreamStatusError",
  "ConsumerNotFoundError", "StreamNotFoundError",
]);

/** Retain fixed categories only. Messages, stacks, subjects and unknown names never enter diagnostics. */
export function nativeErrorClass(error: unknown): string {
  if (!(error instanceof Error)) return "unknown";
  if (error.name === "AuthorizationError" && error.message.toLowerCase().includes("authentication timeout"))
    return "AuthenticationTimeout";
  if (errorNames.has(error.name)) return error.name;
  if (error.name === "Error" && error.message.toLowerCase() === "timeout") return "TimeoutError";
  return "other";
}

/** Bound diagnostic rows per child while counting every observed event and every dropped row. */
export function nativeErrorObserver(emit: (row: { epochMs: number; source: NativeErrorSource; category: string }) => void, limit = 200) {
  if (!Number.isSafeInteger(limit) || limit < 0) throw new Error("native error observation limit must be nonnegative");
  let total = 0, emitted = 0;
  const counts = new Map<string, number>();
  return {
    note(source: NativeErrorSource, error: unknown) {
      const category = nativeErrorClass(error), key = `${source}:${category}`;
      total++; counts.set(key, (counts.get(key) ?? 0) + 1);
      if (emitted < limit) { emitted++; emit({ epochMs: Date.now(), source, category }); }
    },
    summary() { return { total, emitted, dropped: total - emitted, counts: Object.fromEntries(counts) }; },
  };
}
