import type { Extension } from "@cotal-ai/core";
import { CommandFailure } from "./output.js";
import { serviceMetadataDigest } from "./service-adapter.js";

/** Where a preset option's value comes from when the person names none: a literal, or a fact of
 *  the selected space. `root` is its registered root, `server` its registered broker, and
 *  `material` the space's own private file of that kind under the root's `.cotal`. A default never
 *  names a secret value; a file default names where the space already keeps one. */
export type ServicePresetDefault =
  | { readonly value: string | number | boolean }
  | { readonly space: "root" | "server" }
  | { readonly space: "material"; readonly kind: string };

/** A declarative factory for an adapter definition. It starts nothing and supplies no credentials.
 *  Options and their CLI flags derive from the adapter's one closed schema, not another copy.
 *  `defaults` lets `service start <preset>` and `service add --preset` fill an option the person
 *  did not give; an option with no default that the schema requires is still asked for by name. */
export interface ServicePreset extends Extension {
  readonly kind: "service-preset";
  readonly name: string;
  readonly summary: string;
  readonly adapter: string;
  readonly timeoutMs: number;
  readonly defaults?: Readonly<Record<string, ServicePresetDefault>>;
}

const controls = /[\u0000-\u001f\u007f]/u;

function cacheDefault(input: unknown): ServicePresetDefault {
  const row = input as Record<string, unknown> | null;
  if (row && typeof row === "object" && !Array.isArray(row)) {
    const keys = Object.keys(row).sort().join(",");
    const value = row.value;
    if (keys === "value" && (typeof value === "boolean" || typeof value === "number" && Number.isFinite(value) || typeof value === "string" && value.length <= 4096 && !controls.test(value))) return { value };
    if (keys === "space" && (row.space === "root" || row.space === "server")) return { space: row.space };
    if (keys === "kind,space" && row.space === "material" && typeof row.kind === "string" && /^[a-z0-9][a-z0-9.-]{0,63}$/.test(row.kind)) return { space: "material", kind: row.kind };
  }
  throw new CommandFailure("refused", "SCHEMA_INVALID", "a service preset declares an unsupported option default; no provider was loaded to repair it");
}

export function cacheServicePreset(input: ServicePreset): ServicePreset {
  if (!input || input.kind !== "service-preset" || !/^[a-z][a-z0-9-]{0,63}$/.test(input.name) || typeof input.summary !== "string" || !input.summary || input.summary.length > 300 || controls.test(input.summary) || typeof input.adapter !== "string" || !input.adapter || input.adapter.length > 200 || controls.test(input.adapter) || !Number.isSafeInteger(input.timeoutMs) || input.timeoutMs <= 0 || input.timeoutMs > 120000 || Object.keys(input).some((key) => !["kind", "name", "summary", "adapter", "timeoutMs", "defaults"].includes(key))) throw new CommandFailure("refused", "SCHEMA_INVALID", "a service preset has an unsupported closed declaration; no provider was loaded to repair it");
  let defaults: Record<string, ServicePresetDefault> | undefined;
  if (input.defaults !== undefined) {
    if (!input.defaults || typeof input.defaults !== "object" || Array.isArray(input.defaults) || Object.keys(input.defaults).length > 64 || Object.keys(input.defaults).some((name) => !/^[a-z][a-z0-9-]{0,63}$/.test(name))) throw new CommandFailure("refused", "SCHEMA_INVALID", "a service preset declares an unsupported option default; no provider was loaded to repair it");
    defaults = Object.fromEntries(Object.keys(input.defaults).sort().map((name) => [name, cacheDefault(input.defaults![name])]));
  }
  const value = { kind: "service-preset" as const, name: input.name, summary: input.summary, adapter: input.adapter, timeoutMs: input.timeoutMs, ...(defaults ? { defaults } : {}) };
  serviceMetadataDigest(value);
  return value;
}
