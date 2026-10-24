import { Kvm, type KvEntry } from "@nats-io/kv";
import type { NatsConnection } from "@nats-io/transport-node";
import { CHANNEL_DEFAULTS_KEY, channelBucket, isConcreteChannel } from "./subjects.js";
import { validateChannelConfig, validateChannelDefaults, type ChannelRegistryFile } from "./channels.js";
import type { ChannelConfig, ChannelDefaults, DeliveryClass } from "./types.js";
import { spaceInitializationDefinitions } from "./space-resource-definitions.js";
import { spaceSchemaReadFailure } from "./space-schema-observation.js";

export interface SpaceInitializationReadPort {
  readonly bucket: string;
  readonly stream: string;
  readonly get: (key: string) => Promise<KvEntry | null>;
}

/** Bind the selected existing registry on this connection through the public native API.
 *  No bucket creation or stream override. Names are not server/account or write authority. */
export async function spaceInitializationReadPort(nc: NatsConnection, space: string): Promise<SpaceInitializationReadPort> {
  const bucket = channelBucket(space), stream = `KV_${bucket}`;
  const kv = await new Kvm(nc).open(bucket);
  return Object.freeze({ bucket, stream, get: (key: string) => kv.get(key) });
}

/** Values are private planning data and can contain model-facing text. Never serialize these
 *  rows wholesale into public diagnostics, operation receipts or an authority artifact. */
export type SpaceInitializationObservation = { key: string; operation: "kv-get" } & (
  | { state: "present"; revision: number; value: ChannelConfig | ChannelDefaults }
  | { state: "observed-tombstone"; revision: number; marker: "DEL" | "PURGE" }
  | { state: "reported-not-found" | "registry-unavailable" | "permission-denied" | "target-mismatch" | "observation-failed" | "not-observed-budget" }
);

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function validateSpaceInitializationInputs(deliveryClass: DeliveryClass, seed?: ChannelRegistryFile): void {
  try {
    if (deliveryClass !== "live" && deliveryClass !== "durable") throw new Error();
    validateChannelDefaults({ deliveryClass });
    if (seed === undefined) return;
    if (!object(seed) || Object.keys(seed).some((key) => key !== "defaults" && key !== "channels")) throw new Error();
    if (seed.defaults !== undefined) {
      if (!object(seed.defaults)) throw new Error();
      validateChannelDefaults(seed.defaults);
    }
    if (seed.channels !== undefined) {
      if (!object(seed.channels) || Object.keys(seed.channels).length > 1024) throw new Error();
      for (const [key, patch] of Object.entries(seed.channels)) {
        if (key === CHANNEL_DEFAULTS_KEY || !isConcreteChannel(key) || !object(patch)) throw new Error();
        validateChannelConfig(patch);
      }
    }
  } catch { throw new Error("initialization observation requires valid native profile/patch inputs and at most 1024 concrete nonreserved channel keys; no registry read was attempted"); }
}

/** Observe only the requested seed keys and defaults. Native validation precedes reads. The
 *  five-second/8 MiB budget leaves unvisited rows explicit; expiry does not cancel an in-flight
 *  request. The caller retains connection custody. No row absence authorizes creation. */
export async function observeSpaceInitialization(reads: SpaceInitializationReadPort, space: string, deliveryClass: DeliveryClass, seed?: ChannelRegistryFile) {
  validateSpaceInitializationInputs(deliveryClass, seed);
  const definitions = spaceInitializationDefinitions(space, deliveryClass, seed);
  if (reads.bucket !== definitions.registry.bucket || reads.stream !== definitions.registry.stream) throw new Error("initialization read-port target does not match the selected registry; no key was read");
  const keys = [...new Set([...definitions.seed.entries.map((entry) => entry.key), definitions.profileDefault.key])];
  const observations: SpaceInitializationObservation[] = [];
  const deadline = performance.now() + 5000, decoder = new TextDecoder("utf-8", { fatal: true });
  let bytes = 0, deadlineReached = false;
  for (const key of keys) {
    const row = { key, operation: "kv-get" as const }, remaining = deadline - performance.now();
    if (remaining <= 0) deadlineReached = true;
    if (deadlineReached || bytes >= 8 * 1024 * 1024) { observations.push({ ...row, state: "not-observed-budget" }); continue; }
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const result = await Promise.race([
        reads.get(key).then((entry) => ({ kind: "read" as const, entry })),
        new Promise<{ kind: "deadline" }>((resolve) => { timer = setTimeout(() => resolve({ kind: "deadline" }), remaining); }),
      ]);
      if (result.kind === "deadline") { deadlineReached = true; observations.push({ ...row, state: "observation-failed" }); continue; }
      const entry = result.entry;
      if (entry === null) { observations.push({ ...row, state: "reported-not-found" }); continue; }
      if (entry.bucket !== reads.bucket || entry.key !== key) { observations.push({ ...row, state: "target-mismatch" }); continue; }
      if (!Number.isSafeInteger(entry.revision) || entry.revision <= 0) { observations.push({ ...row, state: "observation-failed" }); continue; }
      if (entry.operation === "DEL" || entry.operation === "PURGE") { observations.push({ ...row, state: "observed-tombstone", revision: entry.revision, marker: entry.operation }); continue; }
      if (entry.operation !== "PUT" || !(entry.value instanceof Uint8Array)) { observations.push({ ...row, state: "observation-failed" }); continue; }
      bytes += entry.value.byteLength;
      if (entry.value.byteLength > 65536 || bytes > 8 * 1024 * 1024) { observations.push({ ...row, state: "observation-failed" }); continue; }
      const value: unknown = JSON.parse(decoder.decode(entry.value));
      if (!object(value)) { observations.push({ ...row, state: "observation-failed" }); continue; }
      if (key === CHANNEL_DEFAULTS_KEY) validateChannelDefaults(value); else validateChannelConfig(value);
      observations.push({ ...row, state: "present", revision: entry.revision, value });
    } catch (error) {
      const state = spaceSchemaReadFailure(error);
      observations.push({ ...row, state: state === "reported-not-found" ? "registry-unavailable" : state });
    } finally { clearTimeout(timer); }
  }
  return {
    kind: "space-initialization-observations" as const,
    space, registry: definitions.registry, observations,
    scope: "provided registry handle and requested keys; observations can be stale and are not a revision-guarded write plan" as const,
    byteBudget: 8 * 1024 * 1024, deadlineMs: 5000, deadlineReached,
    fullFieldPolicyApplied: false as const,
    readerRequestCancellationEstablished: false as const,
    connectionAuthorityChecked: false as const,
    absenceAuthoritativelyProven: false as const,
    applyPermitted: false as const,
    writes: [] as const,
  };
}
