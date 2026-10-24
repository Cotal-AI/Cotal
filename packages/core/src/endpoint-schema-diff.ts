import { endpointDataStreamConfigs, type EndpointStreamOptions } from "./endpoint-binding.js";
import { diffDeclaredStreamConfigs, type StreamSchemaObservation, type StreamSchemaFieldDifference, type StreamSchemaRow } from "./stream-schema-diff.js";

export type EndpointDataStreamObservation = StreamSchemaObservation;
export type EndpointSchemaFieldDifference = StreamSchemaFieldDifference;
export type EndpointDataSchemaRow = StreamSchemaRow;

/** Conservative endpoint-data subset diff; no observation, migration or apply authority. */
export function diffEndpointDataStreams(space: string, observations: readonly EndpointDataStreamObservation[], options: EndpointStreamOptions = {}) {
  const rows = diffDeclaredStreamConfigs(endpointDataStreamConfigs(space, options), observations);
  return {
    kind: "endpoint-data-schema-diff" as const, space,
    scope: "directly declared endpoint/workflow streams; contract/authority/KV/TTL/artifact/default/seed resources are not included" as const,
    rows, completeSpaceSchema: false as const, serverDefaultsNormalized: false as const,
    targetScope: "provided space and stream names only; server/account/mode authority is not checked" as const,
    connectionAuthorityChecked: false as const, absenceAuthoritativelyProven: false as const, applyPermitted: false as const,
    writes: [] as const,
  };
}
