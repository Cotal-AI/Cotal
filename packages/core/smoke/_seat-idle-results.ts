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

/** Retain fixed categories only. Inspect at most four error causes; messages, stacks, subjects and unknown names never enter diagnostics. */
export function nativeErrorClass(error: unknown): string {
  if (!(error instanceof Error)) return "unknown";
  let current: unknown = error;
  const seen = new Set<Error>();
  for (let depth = 0; depth < 4 && current instanceof Error && !seen.has(current); depth++) {
    seen.add(current);
    if (current.name === "AuthorizationError" && current.message.toLowerCase().includes("authentication timeout"))
      return "AuthenticationTimeout";
    if (errorNames.has(current.name)) return current.name;
    if (current.name === "Error" && current.message.toLowerCase() === "timeout") return "TimeoutError";
    current = current.cause;
  }
  return "other";
}

export type NativeErrorContext = "presence-write" | "unclassified";

/** Recognize only the stock presence-write wrapper or structured stuck-write condition. Never emit their text or fields. */
export function nativeErrorContext(error: unknown): NativeErrorContext {
  let current: unknown = error;
  const seen = new Set<Error>();
  for (let depth = 0; depth < 4 && current instanceof Error && !seen.has(current); depth++) {
    seen.add(current);
    if ((current.name === "PresenceWriteStuckError" && "code" in current && current.code === "presence-write-stuck")
      || (current.name === "Error" && current.cause instanceof Error && nativeErrorClass(current.cause) === "TimeoutError"
        && current.message.endsWith(". The presence write outcome is unknown: the broker may have stored the update. Read the roster before retrying.")))
      return "presence-write";
    current = current.cause;
  }
  return "unclassified";
}

/** Bound diagnostic rows per child while counting every observed event and every dropped row. */
export function nativeErrorObserver(emit: (row: { epochMs: number; source: NativeErrorSource; category: string; context: NativeErrorContext }) => void, limit = 200) {
  if (!Number.isSafeInteger(limit) || limit < 0) throw new Error("native error observation limit must be nonnegative");
  let total = 0, emitted = 0;
  const counts = new Map<string, number>();
  const contexts = new Map<NativeErrorContext, number>();
  return {
    note(source: NativeErrorSource, error: unknown) {
      const category = nativeErrorClass(error), context = nativeErrorContext(error), key = `${source}:${category}`;
      total++; counts.set(key, (counts.get(key) ?? 0) + 1);
      contexts.set(context, (contexts.get(context) ?? 0) + 1);
      if (emitted < limit) { emitted++; emit({ epochMs: Date.now(), source, category, context }); }
    },
    summary() { return { total, emitted, dropped: total - emitted, counts: Object.fromEntries(counts), contexts: Object.fromEntries(contexts) }; },
  };
}

/** Watch a process's own event loop with a 100 ms timer and report every tick that arrives late by
 *  `stallMs` or more (a stall), at most `limit` times; returns the stop function. The loop delay
 *  histogram gives the size of the worst stall, this gives its time. */
export function loopStallWatch(emit: (row: { epochMs: number; stallMs: number }) => void, stallMs = 1000, limit = 50, intervalMs = 100): () => void {
  if (!Number.isSafeInteger(limit) || limit < 0) throw new Error("loop stall row limit must be nonnegative");
  let emitted = 0, last = performance.now();
  const timer = setInterval(() => {
    const now = performance.now(), late = now - last - intervalMs;
    last = now;
    if (late >= stallMs && emitted < limit) { emitted++; emit({ epochMs: Date.now(), stallMs: Math.round(late) }); }
  }, intervalMs);
  return () => clearInterval(timer);
}
