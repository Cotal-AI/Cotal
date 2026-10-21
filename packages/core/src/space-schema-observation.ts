import { JetStreamApiCodes, JetStreamApiError, type JetStreamManager, type StreamConfig } from "@nats-io/jetstream";
import { PermissionViolationError } from "@nats-io/transport-node";
import type { EndpointStreamOptions } from "./endpoint-binding.js";
import { isJetStreamMissing } from "./jetstream-missing.js";
import { spaceResourceDefinitions, type SpaceResourceDefinition } from "./space-resource-definitions.js";

/** The schema reader receives only stream-info. Connection custody, target validation and
 *  credentials stay with its caller; a read port is not evidence of bootstrap authority. */
export interface SpaceSchemaReadPort {
  readonly info: (stream: string) => Promise<{ config: StreamConfig }>;
}

/** Narrow an existing native manager to a frozen read-only facade. No connection is opened. */
export function spaceSchemaReadPort(manager: JetStreamManager): SpaceSchemaReadPort {
  return Object.freeze({ info: (stream: string) => manager.streams.info(stream) });
}

type ObservedResource = { kind: SpaceResourceDefinition["kind"]; stream: string; operation: "stream-info" };
export type SpaceSchemaObservation = ObservedResource & (
  | { state: "present"; config: StreamConfig }
  | { state: "reported-not-found" | "permission-denied" | "target-mismatch" | "observation-failed" | "not-observed-budget" }
);

/** Structured native stream-read failure classification. It establishes no absence or grant. */
export function spaceSchemaReadFailure(error: unknown): "permission-denied" | "reported-not-found" | "observation-failed" {
  if (error instanceof PermissionViolationError || error instanceof JetStreamApiError && error.status === 403) return "permission-denied";
  if (error instanceof JetStreamApiError && error.status === 404 && isJetStreamMissing(error, JetStreamApiCodes.StreamNotFound)) return "reported-not-found";
  return "observation-failed";
}

/** Read each declared resource once through the supplied port. Structured SDK errors are
 *  classified without message matching or raw diagnostics. A reported missing stream is not
 *  authoritative absence, even when a caller describes their connection as privileged. A shared
 *  five-second budget leaves later rows unvisited and does not cancel an in-flight request. */
export async function observeSpaceResources(reads: SpaceSchemaReadPort, space: string, options: EndpointStreamOptions = {}) {
  const definitions = spaceResourceDefinitions(space, options);
  const observations: SpaceSchemaObservation[] = [];
  const deadline = performance.now() + 5000;
  let deadlineReached = false;
  for (const definition of definitions.resources) {
    const resource: ObservedResource = { kind: definition.kind, stream: definition.stream, operation: "stream-info" };
    const remaining = deadline - performance.now();
    if (remaining <= 0) deadlineReached = true;
    if (deadlineReached) { observations.push({ ...resource, state: "not-observed-budget" }); continue; }
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const result = await Promise.race([
        reads.info(definition.stream).then((info) => ({ kind: "read" as const, info })),
        new Promise<{ kind: "deadline" }>((resolve) => { timer = setTimeout(() => resolve({ kind: "deadline" }), remaining); }),
      ]);
      if (result.kind === "deadline") { deadlineReached = true; observations.push({ ...resource, state: "observation-failed" }); continue; }
      const info = result.info;
      if (!info || !info.config || typeof info.config !== "object" || Array.isArray(info.config)) {
        observations.push({ ...resource, state: "observation-failed" });
      } else if (info.config.name !== definition.stream) {
        observations.push({ ...resource, state: "target-mismatch" });
      } else {
        observations.push({ ...resource, state: "present", config: info.config });
      }
    } catch (error) {
      observations.push({ ...resource, state: spaceSchemaReadFailure(error) });
    } finally { clearTimeout(timer); }
  }
  return {
    kind: "space-resource-observations" as const,
    space,
    observations,
    deadlineMs: 5000, deadlineReached,
    readerRequestCancellationEstablished: false as const,
    scope: "declared resources through the supplied read port; server/account/mode binding is not established" as const,
    completeSpaceSchema: false as const,
    connectionAuthorityChecked: false as const,
    absenceAuthoritativelyProven: false as const,
    applyPermitted: false as const,
    writes: [] as const,
  };
}
