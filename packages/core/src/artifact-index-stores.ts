/**
 * The three artifact index stores (artifact plane 4.0): the attachment index, the possession rows and
 * the commit reservations. The delivery daemon's artifacts service is their only writer; no agent,
 * operator or provisioning credential holds a value grant on any of them.
 *
 * Every read of these buckets gates an effect (a possession row gates an attachment, an attachment
 * gates bytes, a missing reservation gates a delete), so every read is fencing and must be
 * leader-served (SPEC 13.12). The buckets are created `allow_direct: false`, which makes a keyed get a
 * `STREAM.MSG.GET`, and setup refuses a bucket that allows Direct Get rather than adopting it.
 */
import { jetstreamManager, type JetStreamManager, type StreamConfig } from "@nats-io/jetstream";
import { Kvm } from "@nats-io/kv";
import { drainAndClose } from "./connection-cleanup.js";
import { dialerFor } from "./endpoint-dial.js";
import { standaloneConnectOpts } from "./standalone-connect.js";
import { isStreamNotFound } from "./jetstream-missing.js";
import { artifactAttachBucket, artifactPossessBucket, artifactReserveBucket } from "./subjects.js";

/** Largest serialized index row. A row is one small JSON record keyed by digest, channel and
 *  principal, so this native per-message bound refuses a runaway write without reserving storage. */
export const ARTIFACT_INDEX_MAX_VALUE_SIZE = 4 * 1024;

/** The bucket names, in the order setup creates them. */
export function artifactIndexBuckets(space: string): string[] {
  return [artifactAttachBucket(space), artifactPossessBucket(space), artifactReserveBucket(space)];
}

/** The backing stream of each index bucket, for the provisioning, deletion, backup and restore lists. */
export function artifactIndexStreamNames(space: string): string[] {
  return artifactIndexBuckets(space).map((bucket) => `KV_${bucket}`);
}

/** Native creation inputs for one index bucket. */
export function artifactIndexStoreDefinition(bucket: string) {
  return {
    bucket,
    createOptions: { history: 1, max_bytes: -1, maxValueSize: ARTIFACT_INDEX_MAX_VALUE_SIZE, allow_direct: false, storage: "file" as const },
  };
}

/** Pure invariant check for one index bucket's stream config; it never widens or repairs. */
export function assertArtifactIndexStoreConfig(config: StreamConfig, bucket: string): void {
  const drift: string[] = [];
  const subjects = JSON.stringify(config.subjects ?? []);
  if (subjects !== JSON.stringify([`$KV.${bucket}.>`])) drift.push(`subjects are ${subjects}, expected exactly ["$KV.${bucket}.>"]`);
  if (config.allow_direct !== false) drift.push("allow_direct is not false (every read of this store is a fencing read and must be leader-served)");
  if (String(config.storage) !== "file") drift.push(`storage is ${config.storage}, expected file`);
  if (config.max_msgs_per_subject !== 1) drift.push(`max_msgs_per_subject is ${config.max_msgs_per_subject}, expected 1`);
  if (config.max_bytes !== -1) drift.push(`max_bytes is ${config.max_bytes}, expected -1 (a positive cap reserves broker storage)`);
  if (config.max_age !== 0) drift.push(`max_age is ${config.max_age}, expected 0 (the sweep owns expiry)`);
  if (config.max_msg_size !== ARTIFACT_INDEX_MAX_VALUE_SIZE) drift.push(`max_msg_size is ${config.max_msg_size}, expected ${ARTIFACT_INDEX_MAX_VALUE_SIZE} (one index row is small; an unbounded row is a storage lever)`);
  if (config.mirror || config.sources?.length) drift.push("it mirrors or sources another stream");
  if (drift.length) throw new Error(`artifact index store KV_${bucket} has drifted: ${drift.join("; ")} - refusing to adopt it`);
}

/** Create the three index buckets, or verify existing ones. Idempotent; drift fails loud. */
export async function ensureArtifactIndexStores(jsm: JetStreamManager, kvm: Kvm, space: string): Promise<void> {
  for (const bucket of artifactIndexBuckets(space)) {
    const definition = artifactIndexStoreDefinition(bucket);
    await kvm.create(definition.bucket, definition.createOptions);
    const { config } = await jsm.streams.info(`KV_${bucket}`);
    assertArtifactIndexStoreConfig(config, bucket);
  }
}

/** The running-space upgrade path: `cotal up` on a space that is already running never reaches
 *  setup, so a space created before these stores existed gets them here. Returns the backing
 *  streams it created, so the caller can say so; a store that already exists is only verified. */
export async function reconcileArtifactIndexStores(opts: { servers: string; space: string; creds?: string }): Promise<string[]> {
  const nc = await dialerFor(opts.servers)({ servers: opts.servers, ...standaloneConnectOpts({ creds: opts.creds, tls: false }) });
  try {
    const jsm = await jetstreamManager(nc);
    const created: string[] = [];
    for (const stream of artifactIndexStreamNames(opts.space)) {
      try { await jsm.streams.info(stream); } catch (e) { if (!isStreamNotFound(e)) throw e; created.push(stream); }
    }
    await ensureArtifactIndexStores(jsm, new Kvm(nc), opts.space);
    return created;
  } finally {
    await drainAndClose(nc);
  }
}
