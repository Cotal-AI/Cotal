import { explicitSpaceResourceFields, nativeKvScalarInputDefaults, spaceResourceDefinitions, type SpaceResourceDefinition } from "./space-resource-definitions.js";
import { assertAuthStoreConfig, assertContractStoreConfig, assertRecordsStoreConfig, assertSessionsStoreConfig, type EndpointStreamOptions } from "./endpoint-binding.js";
import { assertIssuedStoreConfig, WRITE_ONCE_PER_KEY } from "./issued-authority.js";
import { assertAdmissionStoreConfig } from "./run-admission.js";
import { authorityStreamShapeIssue } from "./authority-store-config.js";
import { assertArtifactStoreConfig, LEGACY_ARTIFACT_STORE_MAX_BYTES } from "./streams.js";
import { streamReadPolicyBaseline, validateCanonicalBackupStreamConfig } from "./backup-config.js";
import { canonicalJson } from "./canonical.js";
import { DiscardPolicy, type StreamConfig } from "@nats-io/jetstream";
import type { SpaceSchemaObservation } from "./space-schema-observation.js";
import { diffDeclaredStreamConfigs, type StreamSchemaObservation, type StreamSchemaRow } from "./stream-schema-diff.js";

export interface SpaceSchemaDiffRow extends Omit<StreamSchemaRow, "state" | "uninspectedFields"> {
  kind: SpaceResourceDefinition["kind"];
  state: StreamSchemaRow["state"] | "native-store-verification-required" | "native-store-invariants-match" | "native-store-verification-unconfirmed" | "unclassified-stream-settings" | "creation-options-policy-required";
  /** Outside the declarative field comparison; a separate native check can inspect more fields. */
  uncomparedFields: string[];
  /** A match covers that native check, not complete effective schema or connection authority. */
  nativeVerification: "not-checked" | "invariants-match" | "not-confirmed";
  nativeInvariantFields: readonly string[];
  unexpandedCreationOptions: readonly string[];
  reconciliation: {
    state: "not-evaluated" | "no-declared-change" | "native-guard-required" | "migration-required";
    nativeGuard: "ttl-enforcement" | "artifact-legacy-cap" | "contract-shadow" | null;
    fields: readonly string[];
    nonAllowlistedFields: readonly string[];
  };
  observedExtraFields: {
    status: "checked" | "not-modeled" | "failed";
    matchesPolicy: string[];
    nondefaultUndeclared: string[];
    unmodeled: string[];
  };
}


function observedExtraFields(resource: SpaceResourceDefinition, config: StreamConfig, declared: Partial<StreamConfig> & { name: string }): SpaceSchemaDiffRow["observedExtraFields"] {
  const result: SpaceSchemaDiffRow["observedExtraFields"] = { status: "not-modeled", matchesPolicy: [], nondefaultUndeclared: [], unmodeled: [] };
  try {
    if (!Array.isArray(declared.subjects)) throw new Error();
    const baseline = streamReadPolicyBaseline(resource.stream, declared.subjects) as Record<string, unknown>;
    if (resource.kind !== "stream") {
      baseline.discard = DiscardPolicy.New;
      baseline.allow_rollup_hdrs = true;
      baseline.allow_direct = true;
      if (resource.kind === "kv") {
        // Public input defaults supply only these scalar fields, not an effective stream
        // builder. Version-dependent/native invariants remain separately checked.
        Object.assign(baseline, nativeKvScalarInputDefaults());
      }
    }
    const actual = config as unknown as Record<string, unknown>;
    result.status = "checked";
    for (const field of Object.keys(actual).sort()) {
      if (Object.hasOwn(declared, field)) continue;
      // Native artifact verification deliberately permits either direct-read setting.
      if (resource.kind === "object-store" && field === "allow_direct" && typeof actual[field] === "boolean") { result.matchesPolicy.push(field); continue; }
      // Native TTL reconciliation preserves a smaller existing duplicate window.
      if (resource.kind === "kv" && field === "duplicate_window" && typeof declared.max_age === "number" && declared.max_age > 0) {
        const value = actual[field];
        if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= declared.max_age) result.matchesPolicy.push(field);
        else result.nondefaultUndeclared.push(field);
        continue;
      }
      if (!Object.hasOwn(baseline, field)) { result.unmodeled.push(field); continue; }
      let value = actual[field];
      if (field === "metadata" && value && typeof value === "object" && !Array.isArray(value) && Object.entries(value).every(([key, item]) => key.startsWith("_nats.") && typeof item === "string")) value = {};
      if (canonicalJson(value) === canonicalJson(baseline[field])) result.matchesPolicy.push(field);
      else result.nondefaultUndeclared.push(field);
    }
  } catch { result.status = "failed"; }
  return result;
}

function nativeVerification(resource: SpaceResourceDefinition, config: StreamConfig, space: string): { status: SpaceSchemaDiffRow["nativeVerification"]; fields: readonly string[] } {
  try {
    if (resource.kind === "kv" && resource.verification !== "native-runtime-check-required") {
      const issue = authorityStreamShapeIssue(config, resource.bucket);
      if (issue) return { status: "not-confirmed", fields: issue.fields };
    }
    switch (resource.verification) {
      case "canonical-backup": validateCanonicalBackupStreamConfig(space, resource.stream, config as unknown as Record<string, unknown>); break;
      case "contract": assertContractStoreConfig(config, space); break;
      case "records": assertRecordsStoreConfig(config, space); break;
      case "auth": assertAuthStoreConfig(config, space); break;
      case "sessions": assertSessionsStoreConfig(config, space); break;
      case "issued":
        if (resource.kind !== "kv") return { status: "not-confirmed", fields: [] };
        assertIssuedStoreConfig(config, space, resource.bucket); break;
      case "admission": assertAdmissionStoreConfig(config, space); break;
      case "artifact": assertArtifactStoreConfig(config, space); break;
      case "declared-fields":
      case "native-runtime-check-required": return { status: "not-checked", fields: [] };
      default: throw new Error("unrecognized native schema verification policy");
    }
    return { status: "invariants-match", fields: [] };
  } catch {
    // Native diagnostics may contain broker values. They are not public schema-report text.
    return { status: "not-confirmed", fields: [] };
  }
}

/** This allowlist names existing native guard families, never accepted actions. It does not
 *  call creators/migrations, prove a shadow-free stream or inspect a leftover TTL canary. */
function reconciliationPolicy(resource: SpaceResourceDefinition, observation: SpaceSchemaObservation | undefined, row: StreamSchemaRow, extras: SpaceSchemaDiffRow["observedExtraFields"], unexpanded: readonly string[], space: string): SpaceSchemaDiffRow["reconciliation"] {
  const fields = [...new Set([...row.differences.map((difference) => difference.field), ...extras.nondefaultUndeclared])];
  const blocked: SpaceSchemaDiffRow["reconciliation"] = { state: "migration-required", nativeGuard: null, fields, nonAllowlistedFields: fields };
  if (!observation || observation.state !== "present" || !["declared-fields-match", "incompatible-or-drifted"].includes(row.state)) return { ...blocked, state: "not-evaluated" };
  if (unexpanded.length || extras.status !== "checked" || extras.unmodeled.length) return blocked;
  if (resource.kind === "kv" && typeof resource.createOptions.ttl === "number" && resource.createOptions.ttl > 0) {
    const nonAllowlistedFields = fields.filter((field) => field !== "max_age" && field !== "duplicate_window");
    if (nonAllowlistedFields.length) return { ...blocked, nonAllowlistedFields };
    return { state: "native-guard-required", nativeGuard: "ttl-enforcement", fields, nonAllowlistedFields: [] };
  }
  if (fields.length === 0) return { state: "no-declared-change", nativeGuard: null, fields, nonAllowlistedFields: [] };
  if (resource.kind === "object-store" && fields.length === 1 && fields[0] === "max_bytes" && observation.config.max_bytes === LEGACY_ARTIFACT_STORE_MAX_BYTES) {
    try { assertArtifactStoreConfig({ ...observation.config, max_bytes: -1 }, space); }
    catch { return blocked; }
    return { state: "native-guard-required", nativeGuard: "artifact-legacy-cap", fields, nonAllowlistedFields: [] };
  }
  if (resource.kind === "stream" && resource.verification === "contract") {
    const allowed = new Set(Object.keys(WRITE_ONCE_PER_KEY));
    const nonAllowlistedFields = fields.filter((field) => !allowed.has(field));
    if (nonAllowlistedFields.length) return { ...blocked, nonAllowlistedFields };
    try { assertContractStoreConfig({ ...observation.config, ...WRITE_ONCE_PER_KEY }, space); }
    catch { return blocked; }
    return { state: "native-guard-required", nativeGuard: "contract-shadow", fields, nonAllowlistedFields: [] };
  }
  return blocked;
}

/** Compare only explicit native stream fields and post-create hardening. KV/object-store
 *  creation options are not expanded into guessed SDK/server defaults. Pure native invariant
 *  checks run where declared; runtime checks and complete field policy stay separate. No
 *  mutating create-or-verify helper, canary, repair or migration is invoked. */
export function diffSpaceResources(space: string, observations: readonly SpaceSchemaObservation[], options: EndpointStreamOptions = {}) {
  const definitions = spaceResourceDefinitions(space, options);
  const resources = new Map(definitions.resources.map((resource) => [resource.stream, resource]));
  const found = new Map<string, SpaceSchemaObservation>();
  for (const observation of observations) {
    if (!resources.has(observation.stream) || found.has(observation.stream)) throw new Error("space schema diff requires unique observations of the declared resource set; no foreign or duplicate observation was adopted");
    found.set(observation.stream, observation);
  }
  const rows: SpaceSchemaDiffRow[] = definitions.resources.map((resource): SpaceSchemaDiffRow => {
    const observation = found.get(resource.stream);
    const fields = explicitSpaceResourceFields(resource), desired = fields.config;
    const input: StreamSchemaObservation[] = observation && observation.state !== "not-observed-budget" ? [
      observation.kind !== resource.kind ? { stream: resource.stream, state: "target-mismatch" }
        : observation.state === "present" ? { stream: resource.stream, state: "present", config: observation.config }
          : { stream: resource.stream, state: observation.state === "reported-not-found" ? "not-found" : observation.state },
    ] : [];
    const row = diffDeclaredStreamConfigs([desired], input)[0]!;
    const checked = observation?.state === "present" && row.state !== "target-mismatch" && row.state !== "observation-failed"
      ? nativeVerification(resource, observation.config, space) : { status: "not-checked" as const, fields: [] };
    const verification = checked.status;
    const extras = observation?.state === "present" && row.state !== "target-mismatch" && row.state !== "observation-failed"
      ? observedExtraFields(resource, observation.config, desired) : { status: "not-modeled" as const, matchesPolicy: [], nondefaultUndeclared: [], unmodeled: [] };
    const state = row.state === "declared-fields-match"
      ? fields.unexpanded.length ? "creation-options-policy-required"
        : extras.status === "failed" ? "observation-failed"
          : extras.nondefaultUndeclared.length || extras.unmodeled.length ? "unclassified-stream-settings"
          : verification === "not-confirmed" ? "native-store-verification-unconfirmed"
        : resource.kind !== "stream" ? verification === "invariants-match" ? "native-store-invariants-match" : "native-store-verification-required"
          : row.state
      : row.state;
    const reconciliation = reconciliationPolicy(resource, observation, row, extras, fields.unexpanded, space);
    const { uninspectedFields, ...comparison } = row;
    return { ...comparison, kind: resource.kind, state, uncomparedFields: uninspectedFields, nativeVerification: verification, nativeInvariantFields: checked.fields, unexpandedCreationOptions: fields.unexpanded, observedExtraFields: extras, reconciliation };
  });
  return {
    kind: "space-resource-schema-diff" as const,
    space,
    rows,
    scope: "explicit stream/public store-option fields, hardening and pure native invariants; unspecified SDK defaults, runtime checks and full field policy remain unestablished" as const,
    pendingPolicy: definitions.pendingPolicy,
    completeSpaceSchema: false as const,
    sdkDefaultsExpanded: false as const,
    sdkInputDefaultsUsedForReadPolicy: true as const,
    connectionAuthorityChecked: false as const,
    absenceAuthoritativelyProven: false as const,
    applyPermitted: false as const,
    writes: [] as const,
  };
}
