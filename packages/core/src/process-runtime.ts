import { randomUUID } from "node:crypto";
import type { PresenceRuntime } from "./types.js";

const startedAt = Math.floor(performance.timeOrigin);
const scopes = new Map<string | undefined, PresenceRuntime>();

/** This OS process's observation for one lifecycle scope. Each scope keeps one random id for the
 *  process lifetime, including after an endpoint disconnects. Every scope shares the process start,
 *  even when a lifecycle is registered later. It does not date a parent or model harness process. */
export function processRuntime(lifecycleUid?: string): PresenceRuntime {
  let own = scopes.get(lifecycleUid);
  if (!own) {
    own = Object.freeze({ id: randomUUID(), startedAt, source: "endpoint-process" });
    scopes.set(lifecycleUid, own);
  }
  return own;
}
