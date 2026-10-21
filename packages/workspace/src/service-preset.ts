import type { Extension } from "@cotal-ai/core";
import { CommandFailure } from "./output.js";
import { serviceMetadataDigest } from "./service-adapter.js";

/** A declarative factory for an adapter definition. It starts nothing and supplies no credentials.
 *  Options and their CLI flags derive from the adapter's one closed schema, not another copy. */
export interface ServicePreset extends Extension {
  readonly kind: "service-preset";
  readonly name: string;
  readonly summary: string;
  readonly adapter: string;
  readonly timeoutMs: number;
}

export function cacheServicePreset(input: ServicePreset): ServicePreset {
  if (!input || input.kind !== "service-preset" || !/^[a-z][a-z0-9-]{0,63}$/.test(input.name) || typeof input.summary !== "string" || !input.summary || input.summary.length > 300 || /[\u0000-\u001f\u007f]/u.test(input.summary) || typeof input.adapter !== "string" || !input.adapter || input.adapter.length > 200 || /[\u0000-\u001f\u007f]/u.test(input.adapter) || !Number.isSafeInteger(input.timeoutMs) || input.timeoutMs <= 0 || input.timeoutMs > 120000 || Object.keys(input).some((key) => !["kind", "name", "summary", "adapter", "timeoutMs"].includes(key))) throw new CommandFailure("refused", "SCHEMA_INVALID", "a service preset has an unsupported closed declaration; no provider was loaded to repair it");
  const value = { kind: "service-preset" as const, name: input.name, summary: input.summary, adapter: input.adapter, timeoutMs: input.timeoutMs };
  serviceMetadataDigest(value);
  return value;
}
