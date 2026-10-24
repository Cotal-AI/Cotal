import type { StreamConfig } from "@nats-io/jetstream";
import { canonicalJson } from "./canonical.js";

/** Input observations are data, not a credential, target proof or permission to create a store. */
export type StreamSchemaObservation =
  | { stream: string; state: "present"; config: Partial<StreamConfig> }
  | { stream: string; state: "not-found" | "permission-denied" | "target-mismatch" | "observation-failed" };

export interface StreamSchemaFieldDifference {
  field: string;
  observedPresent: boolean;
  expected: unknown;
  observed: unknown;
}

export interface StreamSchemaRow {
  stream: string;
  state: "declared-fields-match" | "incompatible-or-drifted" | "missing-requires-privileged-observation" | "permission-denied" | "target-mismatch" | "observation-failed" | "not-observed";
  differences: StreamSchemaFieldDifference[];
  comparedFields: string[];
  /** Server defaults and undeclared fields were not normalized or silently accepted as canonical. */
  uninspectedFields: string[];
}

/** Pure, conservative diff of the directly declared native stream fields. No broker read/write,
 *  absent-store proof, migration allowlist or full-space canonicality is manufactured here.
 *  Subject ordering is irrelevant; a different literal subject set remains a difference. */
export function diffDeclaredStreamConfigs(expected: ReadonlyArray<Partial<StreamConfig> & { name: string }>, observations: readonly StreamSchemaObservation[]): StreamSchemaRow[] {
  const names = new Set(expected.map((definition) => definition.name));
  const found = new Map<string, StreamSchemaObservation>();
  for (const observation of observations) {
    if (!names.has(observation.stream) || found.has(observation.stream)) throw new Error("stream schema diff requires unique observations of the selected stream set; no foreign or duplicate observation was adopted");
    found.set(observation.stream, observation);
  }
  const comparable = (field: string, value: unknown): string => {
    if (field === "subjects") {
      if (!Array.isArray(value) || value.some((subject) => typeof subject !== "string")) throw new Error();
      return canonicalJson([...new Set(value)].sort());
    }
    return canonicalJson(value);
  };
  return expected.map((definition): StreamSchemaRow => {
    const observation = found.get(definition.name), fields = Object.keys(definition).sort();
    const base = { stream: definition.name, differences: [] as StreamSchemaFieldDifference[], comparedFields: [] as string[], uninspectedFields: [] as string[] };
    if (!observation) return { ...base, state: "not-observed" };
    if (observation.state !== "present") return { ...base, state: observation.state === "not-found" ? "missing-requires-privileged-observation" : observation.state };
    if (observation.config.name !== definition.name) return { ...base, state: "target-mismatch" };
    const current = observation.config as Record<string, unknown>, desired = definition as Record<string, unknown>;
    const differences: StreamSchemaFieldDifference[] = [];
    try {
      for (const field of fields) {
        const present = Object.hasOwn(current, field);
        if (!present || comparable(field, current[field]) !== comparable(field, desired[field])) differences.push({ field, observedPresent: present, expected: desired[field], observed: present ? current[field] : null });
      }
    } catch { return { ...base, state: "observation-failed" }; }
    return { stream: definition.name, state: differences.length ? "incompatible-or-drifted" : "declared-fields-match", differences, comparedFields: fields, uninspectedFields: Object.keys(current).filter((field) => !fields.includes(field)).sort() };
  });
}
