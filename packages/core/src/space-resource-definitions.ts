import { DiscardPolicy, type StreamConfig } from "@nats-io/jetstream";
import { defaultBucketOpts, type Kvm } from "@nats-io/kv";
import { nanos } from "@nats-io/transport-node";
import { spaceStreamCreationBase } from "./backup-config.js";
import type { Objm } from "@nats-io/obj";
import { CHANNEL_DEFAULTS_KEY, channelBucket, objectStoreStream } from "./subjects.js";
import { channelDeliveryDefaultPatch, channelRegistrySeedEntries, type ChannelRegistryFile } from "./channels.js";
import type { DeliveryClass } from "./types.js";
import {
  endpointAuthorityStoreDefinitions,
  endpointContractStreamConfig,
  endpointDataStreamConfigs,
  endpointSessionStoreDefinition,
  type EndpointStreamOptions,
} from "./endpoint-binding.js";
import { issuedStoreDefinitions } from "./issued-authority.js";
import { admissionStoreDefinition } from "./run-admission.js";
import {
  artifactStoreDefinition,
  membershipStoreDefinition,
  spaceMessageStreamConfigs,
  spaceRegistryStreamConfigs,
  ttlBuckets,
} from "./streams.js";

export type SpaceResourceDefinition =
  | { kind: "stream"; stream: string; config: Partial<StreamConfig> & { name: string }; verification: "canonical-backup" | "declared-fields" | "contract" }
  | { kind: "kv"; stream: string; bucket: string; createOptions: NonNullable<Parameters<Kvm["create"]>[1]>; hardenAfterCreate?: Partial<StreamConfig>; verification: "native-runtime-check-required" | "records" | "auth" | "sessions" | "issued" | "admission" }
  | { kind: "object-store"; stream: string; bucket: string; createOptions: NonNullable<Parameters<Objm["create"]>[1]>; verification: "artifact" };

/** Project only explicit public KV/object option fields used by native bootstrap. No SDK
 *  default, private constructor or unspecified option is expanded into an observed fact. */
export function explicitSpaceResourceFields(resource: SpaceResourceDefinition): { config: Partial<StreamConfig> & { name: string }; unexpanded: string[] } {
  if (resource.kind === "stream") return { config: resource.config, unexpanded: [] };
  const config: Record<string, unknown> = { name: resource.stream, subjects: resource.kind === "kv" ? [`$KV.${resource.bucket}.>`] : [`$O.${resource.bucket}.C.>`, `$O.${resource.bucket}.M.>`] };
  const unexpanded: string[] = [];
  for (const [field, value] of Object.entries(resource.createOptions)) {
    if (value === undefined) continue;
    if (field === "max_bytes" && typeof value === "number" && Number.isFinite(value)) { config.max_bytes = value; continue; }
    if (resource.kind === "kv") {
      if (field === "allow_direct" && typeof value === "boolean") { config.allow_direct = value; continue; }
      if (field === "storage" && (value === "file" || value === "memory")) { config.storage = value; continue; }
      if (field === "history" && typeof value === "number" && Number.isSafeInteger(value) && value > 0) { config.max_msgs_per_subject = value; continue; }
      if (field === "ttl" && typeof value === "number" && Number.isSafeInteger(value) && value >= 0) { config.max_age = nanos(value); continue; }
      if (field === "markerTTL" && typeof value === "number" && Number.isSafeInteger(value) && value > 0) { config.allow_msg_ttl = true; config.subject_delete_marker_ttl = nanos(value); continue; }
    }
    unexpanded.push(field);
  }
  return { config: { ...config, ...(resource.kind === "kv" ? resource.hardenAfterCreate : {}), name: resource.stream } as Partial<StreamConfig> & { name: string }, unexpanded };
}


/** Only public scalar KV input defaults. No constructor, server feature probe or effective
 *  stream-default expansion is performed. Unsupported public defaults fail closed. */
export function nativeKvScalarInputDefaults(): Partial<StreamConfig> {
  const defaults = defaultBucketOpts();
  if (typeof defaults.history !== "number" || !Number.isSafeInteger(defaults.history) || defaults.history <= 0 || typeof defaults.replicas !== "number" || !Number.isSafeInteger(defaults.replicas) || defaults.replicas <= 0 || typeof defaults.maxValueSize !== "number" || !Number.isFinite(defaults.maxValueSize) || typeof defaults.max_bytes !== "number" || !Number.isFinite(defaults.max_bytes) || defaults.storage !== "file" && defaults.storage !== "memory") throw new Error("native KV input defaults do not supply the required supported scalar fields");
  return { max_msgs_per_subject: defaults.history, num_replicas: defaults.replicas, max_msg_size: defaults.maxValueSize, max_bytes: defaults.max_bytes, storage: defaults.storage };
}

/** Desired first-party configuration for one explicit native STREAM.CREATE. Store subjects,
 *  public scalar options and hardening share the bootstrap definitions; hardening is present at
 *  creation, not applied after adopting an existing bucket. This is never a repair/update plan. */
export function spaceResourceCreationConfig(resource: SpaceResourceDefinition): Partial<StreamConfig> & { name: string } {
  const fields = explicitSpaceResourceFields(resource);
  if (fields.unexpanded.length || fields.config.name !== resource.stream || !Array.isArray(fields.config.subjects)) throw new Error("resource creation requires fully mapped native inputs; no unknown option was ignored");
  const base = spaceStreamCreationBase(resource.stream, fields.config.subjects);
  const config = resource.kind === "stream" ? { ...base, ...fields.config }
    : { ...base, discard: DiscardPolicy.New, allow_direct: true, allow_rollup_hdrs: true, ...(resource.kind === "kv" ? nativeKvScalarInputDefaults() : {}), ...fields.config };
  const age = config.max_age, window = config.duplicate_window;
  if (typeof age !== "number" || !Number.isFinite(age) || age < 0 || typeof window !== "number" || !Number.isFinite(window) || window < 0) throw new Error("resource creation requires explicit valid age and duplicate-window fields");
  if (age > 0) config.duplicate_window = Math.min(window, age);
  return config;
}

/** Collect the native bootstrap inputs without opening a connection or deriving SDK defaults.
 *  Definitions describe creation, not safe updates: authority and artifact verifiers still own
 *  their guards. Neither this value nor its hardening fields authorize provisioning or repair. */
export function spaceResourceDefinitions(space: string, options: EndpointStreamOptions = {}) {
  const streams = [
    ...[...spaceMessageStreamConfigs(space), ...spaceRegistryStreamConfigs(space)].map((config) => ({ config, verification: "canonical-backup" as const })),
    ...endpointDataStreamConfigs(space, options).map((config) => ({ config, verification: "declared-fields" as const })),
    { config: endpointContractStreamConfig(space), verification: "contract" as const },
  ];
  const authority = endpointAuthorityStoreDefinitions(space);
  const buckets = [
    ...ttlBuckets(space).map(([bucket, ttl, storage]) => ({ bucket, createOptions: { ttl, storage }, verification: "native-runtime-check-required" as const })),
    { ...membershipStoreDefinition(space), verification: "native-runtime-check-required" as const },
    { ...authority.records, verification: "records" as const },
    { ...authority.auth, verification: "auth" as const },
    ...issuedStoreDefinitions(space).map((definition) => ({ ...definition, verification: "issued" as const })),
    { ...admissionStoreDefinition(space), verification: "admission" as const },
    { ...endpointSessionStoreDefinition(space), verification: "sessions" as const },
  ];
  const artifact = artifactStoreDefinition(space);
  const resources: SpaceResourceDefinition[] = [
    ...streams.map(({ config, verification }): SpaceResourceDefinition => ({ kind: "stream", stream: config.name, config, verification })),
    ...buckets.map((definition): SpaceResourceDefinition => ({ kind: "kv", stream: `KV_${definition.bucket}`, ...definition })),
    { kind: "object-store", stream: objectStoreStream(artifact.bucket), ...artifact, verification: "artifact" },
  ];
  return {
    kind: "native-space-resource-definitions" as const,
    space,
    resources,
    scope: "native creation inputs; not an ordered mutation plan or full effective schema" as const,
    pendingPolicy: ["full-effective-field-policy", "registry-seed", "default-delivery", "observation-classification", "reconciliation-allowlist", "privileged-apply"] as const,
    completeSpaceSchema: false as const,
    sdkDefaultsExpanded: false as const,
    connectionAuthorityChecked: false as const,
    absenceAuthoritativelyProven: false as const,
    applyPermitted: false as const,
    writes: [] as const,
  };
}

/** Describe native seed/profile precedence without deciding that any row may be written.
 *  The caller supplies the deployment profile; no missing daemon or credential selects it.
 *  Revision-bound observation, validation and guarded application remain separate work. */
export function spaceInitializationDefinitions(space: string, deliveryClass: DeliveryClass, seed?: ChannelRegistryFile) {
  return {
    kind: "native-space-initialization-definitions" as const,
    space,
    registry: { bucket: channelBucket(space), stream: `KV_${channelBucket(space)}` },
    seed: { entries: channelRegistrySeedEntries(seed ?? {}), merge: "specified-fields-overwrite-existing" as const },
    profileDefault: { key: CHANNEL_DEFAULTS_KEY, patch: channelDeliveryDefaultPatch(deliveryClass), condition: "deliveryClass-is-absent" as const },
    order: "seed-before-profile-default; explicit-existing-class-wins" as const,
    scope: "native patch inputs and precedence; not observed rows or a revision-bound write plan" as const,
    observationsComplete: false as const,
    applyPermitted: false as const,
    writes: [] as const,
  };
}
