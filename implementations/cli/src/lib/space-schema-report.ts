import { diffSpaceResources, type SpaceInitializationDiffRow, type SpaceSchemaDiffRow } from "@cotal-ai/core";
import type { Report } from "@cotal-ai/workspace";
import type { inspectExistingSpaceSchema } from "./space-schema-inspection.js";

type Inspection = Awaited<ReturnType<typeof inspectExistingSpaceSchema>>;

/** Public projection: no config/registry values, raw native diagnostics, private patch data or
 *  unknown extra-field names. This remains observation metadata, never accepted apply authority. */
export function spaceSchemaInspectionSummary(inspection: Inspection) {
  const diff = diffSpaceResources(inspection.target.space, inspection.resources.observations);
  const observations = new Map(inspection.resources.observations.map((row) => [row.stream, row.state]));
  const initialization = inspection.initialization;
  const initializationRows = new Map(inspection.initializationComparison?.rows.map((row) => [row.key, row]));
  return {
    kind: "space-schema-inspection-summary" as const,
    completeness: "partial" as const,
    endedAt: inspection.endedAt, atomicSnapshot: false as const,
    target: inspection.target,
    resourceReadBudget: { deadlineMs: inspection.resources.deadlineMs, deadlineReached: inspection.resources.deadlineReached, requestCancellationEstablished: inspection.resources.readerRequestCancellationEstablished },
    connection: {
      identity: inspection.connection.identity, profile: inspection.connection.profile,
      recordedAccount: inspection.connection.recordedAccount, expiresAt: inspection.connection.expiresAt,
      localSignatureChecked: inspection.connection.localSignatureChecked,
      brokerConnectionEstablished: inspection.connection.brokerConnectionEstablished,
      nativeIdentityObservation: inspection.nativeConnectionIdentity?.state ?? "not-applicable-open" as const,
    },
    resources: diff.rows.map((row) => ({
      stream: row.stream, kind: row.kind, observation: observations.get(row.stream) ?? "not-observed" as const,
      comparison: row.state, nativeVerification: row.nativeVerification,
      declaredDifferenceFields: row.differences.map((item) => item.field), nativeInvariantFields: row.nativeInvariantFields,
      nondefaultUndeclaredFields: row.observedExtraFields.nondefaultUndeclared,
      unmodeledExtraFieldCount: row.observedExtraFields.unmodeled.length,
      unexpandedCreationOptionCount: row.unexpandedCreationOptions.length,
      uncomparedFieldCount: row.uncomparedFields.length,
      reconciliation: row.reconciliation,
    })),
    initialization: "observations" in initialization ? {
      state: "read-observations" as const, registry: initialization.registry,
      rows: initialization.observations.map((row) => {
        const comparison = initializationRows.get(row.key);
        return { key: row.key, state: row.state, revision: "revision" in row ? row.revision : null,
          comparison: comparison?.state ?? "not-compared" as const, changedFields: comparison?.changedFields ?? [],
          unmodeledFieldCount: comparison?.unmodeledFieldCount ?? 0, profileDefault: comparison?.profileDefault ?? "not-established" as const };
      }),
      deadlineReached: initialization.deadlineReached,
      requestCancellationEstablished: initialization.readerRequestCancellationEstablished,
    } : { state: initialization.state, operation: initialization.operation, rows: [] },
    readerCloseObserved: inspection.readerCloseObserved,
    credentialRevocationProven: false as const,
    scope: "non-atomic read metadata and partial policy; no complete schema, authoritative absence or accepted mutation plan" as const,
    connectionAuthorityCheckedForApply: false as const,
    fullFieldPolicyApplied: false as const,
    applyPermitted: false as const,
    writes: [] as const,
  };
}

const comparisonLabels: Record<SpaceSchemaDiffRow["state"], string> = {
  "declared-fields-match": "Declared fields match; policy incomplete",
  "incompatible-or-drifted": "Declared fields differ",
  "missing-requires-privileged-observation": "Absence not proved",
  "permission-denied": "Denied",
  "target-mismatch": "Target mismatch",
  "observation-failed": "Not established",
  "not-observed": "Not read",
  "native-store-verification-required": "Native checks required",
  "native-store-invariants-match": "Native checks match; policy incomplete",
  "native-store-verification-unconfirmed": "Native checks not confirmed",
  "unclassified-stream-settings": "Undeclared settings block apply",
  "creation-options-policy-required": "Creation option policy incomplete",
};

const initializationLabels: Record<SpaceInitializationDiffRow["state"] | "not-compared", string> = {
  "present": "Not compared",
  "observed-tombstone": "Deleted; creation not authorized",
  "reported-not-found": "Absence not proved",
  "registry-unavailable": "Registry unavailable",
  "permission-denied": "Denied",
  "target-mismatch": "Target mismatch",
  "observation-failed": "Not established",
  "not-observed-budget": "Read budget reached",
  "not-observed": "Not read",
  "field-policy-required": "Field policy blocks comparison",
  "observed-fields-match": "Observed fields match; no write",
  "patch-differs": "Proposed fields differ; no write",
  "not-compared": "Not compared",
};

/** Prepared shared Screen Kit view. No public command invokes inspection or this view yet. */
export function spaceSchemaInspectionView(summary: ReturnType<typeof spaceSchemaInspectionSummary>): Report {
  return { sections: [
    { title: "Space schema inspection", blocks: [
      { kind: "fields", rows: [["Native connection identity", summary.connection.nativeIdentityObservation === "matched" ? "user/account matched by native self query" : summary.connection.nativeIdentityObservation === "not-applicable-open" ? "not applicable to explicit open mode" : "not established"], ["Coverage", "partial read/policy observations"], ["Space", summary.target.space], ["Registered broker", summary.target.server], ["Mode", summary.target.mode], ["Root", summary.target.root], ["Inspection ended", summary.endedAt], ["Snapshot", "non-atomic reads"], ["Connection profile", summary.connection.profile], ["Identity", summary.connection.identity ?? "none in explicit open mode"], ["Recorded account", summary.connection.recordedAccount ?? "none in explicit open mode"], ["Local reader", summary.readerCloseObserved ? "closure observed" : "closure unconfirmed"], ["Apply", "not authorized"]] },
      { kind: "lines", lines: ["A reported absence is not permission to create a store. Declared-field and store-invariant matches are not full schema or readiness. The separate native identity query does not verify an effective permission ceiling, lifecycle or accepted write plan."] },
    ] },
    { title: "Resource observations", blocks: [
      { kind: "table", columns: [{ key: "stream", label: "Resource" }, { key: "observation", label: "Read result" }, { key: "comparison", label: "Policy result" }, { key: "reconciliation", label: "Native migration gate" }, { key: "fields", label: "Attributed fields" }], rows: summary.resources.map((row) => ({
        stream: row.stream,
        observation: row.observation === "present" ? "Read" : row.observation.replaceAll("-", " "),
        comparison: { text: comparisonLabels[row.comparison], tone: row.comparison === "permission-denied" || row.comparison === "target-mismatch" || row.comparison === "incompatible-or-drifted" ? "failed" as const : "waiting" as const },
        reconciliation: { text: row.reconciliation.state === "native-guard-required" ? `${row.reconciliation.nativeGuard}; not accepted` : row.reconciliation.state.replaceAll("-", " "), tone: row.reconciliation.state === "migration-required" ? "failed" as const : "waiting" as const },
        fields: [...new Set([...row.declaredDifferenceFields, ...row.nativeInvariantFields, ...row.nondefaultUndeclaredFields])].join(", ") || (row.unmodeledExtraFieldCount ? `${row.unmodeledExtraFieldCount} unmodeled field(s); names withheld` : "none attributed"),
      })) },
      { kind: "lines", lines: [`Resource read budget: ${summary.resourceReadBudget.deadlineReached ? "reached; later resources were not read" : "not reported reached"}. A deadline does not establish cancellation.`, "Only field names from declared policy are shown. Unknown setting values/names, registry contents and native diagnostic bodies are omitted. Other observed fields remain outside the declared comparison. Native migration gates still require fresh privileged target checks, the native guard and readback; this report accepts no action."] },
    ] },
    { title: "Registry initialization", blocks: [
      { kind: "lines", lines: [summary.initialization.state === "read-observations" ? "Requested seed/default keys only; values omitted." : `Registry ${summary.initialization.operation}: ${summary.initialization.state.replaceAll("-", " ")}. No key absence was inferred.`] },
      { kind: "table", columns: [{ key: "key", label: "Key" }, { key: "state", label: "Read result" }, { key: "revision", label: "Observed revision" }, { key: "comparison", label: "Initialization result" }, { key: "fields", label: "Proposed fields" }], rows: summary.initialization.rows.map((row) => ({
        key: row.key, state: row.state.replaceAll("-", " "), revision: row.revision === null ? "not established" : String(row.revision),
        comparison: { text: initializationLabels[row.comparison], tone: row.comparison === "permission-denied" || row.comparison === "target-mismatch" || row.comparison === "field-policy-required" ? "failed" as const : "waiting" as const },
        fields: row.changedFields.join(", ") || (row.unmodeledFieldCount ? `${row.unmodeledFieldCount} unmodeled field(s); names withheld` : "none established"),
      })) },
      { kind: "lines", lines: ["A revision can become stale. Proposed fields follow seed-before-profile precedence; candidate values are withheld and no revision guard has run. Null reads and tombstones do not grant creation. A deadline does not establish cancellation; local reader closure does not prove credential revocation or store cleanup. No configuration write or service operation is authorized by this report."] },
    ] },
  ] };
}
