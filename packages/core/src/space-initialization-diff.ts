import { canonicalJson } from "./canonical.js";
import { validateChannelConfig, validateChannelDefaults } from "./channels.js";
import { CHANNEL_DEFAULTS_KEY } from "./subjects.js";
import { spaceInitializationDefinitions } from "./space-resource-definitions.js";
import { validateSpaceInitializationInputs, type SpaceInitializationObservation } from "./space-initialization-observation.js";
import type { ChannelRegistryFile } from "./channels.js";
import type { ChannelConfig, ChannelDefaults, DeliveryClass } from "./types.js";

const DEFAULT_FIELDS = { replay: true, replayWindow: true, deliveryClass: true } as const satisfies Record<keyof ChannelDefaults, true>;
const CHANNEL_FIELDS = { ...DEFAULT_FIELDS, description: true, instructions: true } as const satisfies Record<keyof ChannelConfig, true>;

type RegistryValue = ChannelConfig | ChannelDefaults;

export interface SpaceInitializationDiffRow {
  key: string;
  state: SpaceInitializationObservation["state"] | "not-observed" | "field-policy-required" | "observed-fields-match" | "patch-differs";
  observedRevision: number | null;
  seedRequested: boolean;
  profileDefault: "not-applicable" | "not-established" | "preserve-explicit" | "propose-profile";
  changedFields: readonly string[];
  unmodeledFieldCount: number;
  /** Private proposed data, not an accepted plan. The observed revision can already be stale. */
  candidate: { expectedRevision: number; value: RegistryValue } | null;
}

/** Reject unmodeled fields instead of dropping them from a proposed value. Native validators
 *  retain their existing compatibility behavior; this closed policy belongs to inspection. */
function registryValue(value: RegistryValue, key: string): { valid: boolean; unmodeledFieldCount: number } {
  let unmodeledFieldCount = 0;
  try {
    const encoded = canonicalJson(value);
    if (value === null || typeof value !== "object" || Array.isArray(value) || new TextEncoder().encode(encoded).byteLength > 65536) return { valid: false, unmodeledFieldCount };
    const fields = key === CHANNEL_DEFAULTS_KEY ? DEFAULT_FIELDS : CHANNEL_FIELDS;
    unmodeledFieldCount = Object.keys(value).filter((field) => !Object.hasOwn(fields, field)).length;
    if (unmodeledFieldCount) return { valid: false, unmodeledFieldCount };
    if (key === CHANNEL_DEFAULTS_KEY) validateChannelDefaults(value); else validateChannelConfig(value);
    return { valid: true, unmodeledFieldCount };
  } catch { return { valid: false, unmodeledFieldCount }; }
}

/** Compare native seed-before-profile semantics against observed existing rows. Only present,
 *  closed, valid values receive a private candidate pinned to their observed revision. Missing,
 *  deleted, unreadable or unvisited rows never become empty values or create requests. This
 *  pure result carries no connection, current authority, accepted write plan or apply port. */
export function diffSpaceInitialization(
  space: string,
  deliveryClass: DeliveryClass,
  observed: { space: string; registry: { bucket: string; stream: string }; observations: readonly SpaceInitializationObservation[] },
  seed?: ChannelRegistryFile,
) {
  validateSpaceInitializationInputs(deliveryClass, seed);
  const definitions = spaceInitializationDefinitions(space, deliveryClass, seed);
  if (observed.space !== space || observed.registry.bucket !== definitions.registry.bucket || observed.registry.stream !== definitions.registry.stream) throw new Error("initialization comparison requires observations of the selected registry; no different target was adopted");
  const patches = new Map(definitions.seed.entries.map((entry) => [entry.key, entry.patch]));
  const keys = [...new Set([...patches.keys(), definitions.profileDefault.key])];
  const requested = new Set(keys), observations = new Map<string, SpaceInitializationObservation>();
  for (const row of observed.observations) {
    if (!requested.has(row.key) || observations.has(row.key) || row.operation !== "kv-get") throw new Error("initialization comparison requires unique native observations of the requested keys; no foreign or duplicate row was adopted");
    observations.set(row.key, row);
  }
  const rows = keys.map((key): SpaceInitializationDiffRow => {
    const observation = observations.get(key), patch = patches.get(key);
    const row: SpaceInitializationDiffRow = {
      key, state: observation?.state ?? "not-observed", observedRevision: null,
      seedRequested: patches.has(key), profileDefault: key === CHANNEL_DEFAULTS_KEY ? "not-established" : "not-applicable",
      changedFields: [], unmodeledFieldCount: 0, candidate: null,
    };
    if (!observation) return row;
    if ("revision" in observation) {
      if (!Number.isSafeInteger(observation.revision) || observation.revision <= 0) return { ...row, state: "observation-failed" };
      row.observedRevision = observation.revision;
    }
    if (observation.state !== "present") return row;
    const currentPolicy = registryValue(observation.value, key), patchPolicy = registryValue(patch ?? {}, key);
    row.unmodeledFieldCount = currentPolicy.unmodeledFieldCount + patchPolicy.unmodeledFieldCount;
    if (!currentPolicy.valid || !patchPolicy.valid) return { ...row, state: "field-policy-required" };
    const current = observation.value as unknown as Record<string, unknown>;
    const value: RegistryValue = { ...observation.value, ...patch };
    if (key === CHANNEL_DEFAULTS_KEY) {
      if (value.deliveryClass === undefined) {
        Object.assign(value, definitions.profileDefault.patch);
        row.profileDefault = "propose-profile";
      } else row.profileDefault = "preserve-explicit";
    }
    if (!registryValue(value, key).valid) return { ...row, state: "field-policy-required" };
    const next = value as unknown as Record<string, unknown>;
    row.changedFields = Object.keys(key === CHANNEL_DEFAULTS_KEY ? DEFAULT_FIELDS : CHANNEL_FIELDS).filter((field) => {
      const before = Object.hasOwn(current, field), after = Object.hasOwn(next, field);
      return before !== after || (before && after && canonicalJson(current[field]) !== canonicalJson(next[field]));
    });
    if (row.changedFields.length === 0) return { ...row, state: "observed-fields-match" };
    return { ...row, state: "patch-differs", candidate: { expectedRevision: observation.revision, value } };
  });
  return {
    kind: "space-initialization-diff" as const,
    space, registry: definitions.registry, rows,
    scope: "existing-row native seed/profile comparison; private revision candidates are not accepted write plans" as const,
    registryFieldPolicy: "closed-native-fields" as const,
    revisionGuardsApplied: false as const,
    connectionAuthorityChecked: false as const,
    absenceAuthoritativelyProven: false as const,
    applyPermitted: false as const,
    writes: [] as const,
  };
}
