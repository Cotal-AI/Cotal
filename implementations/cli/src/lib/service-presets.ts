import { registry, type Command, type FlagSpec, type ParsedArgs } from "@cotal-ai/core";
import { cacheServicePreset, CommandFailure, extensionProvides, loadExtensionsManifest, serviceMetadataDigest, verifiedExtensionServicePresets, type ServiceDefinitionInput, type ServicePreset } from "@cotal-ai/workspace";
import { installedExtensionsEnabled } from "../ext-loader.js";
import { resolveServiceAdapter } from "./service-adapters.js";
import { cliVersion } from "./version.js";

const reserved = new Set(["help", "no-color", "no-input", "space", "json", "plain", "file", "preset", "yes", "instance", "new-instance", "foreground", "with-agents", "dry-run", "tail", "follow"]);

export function servicePresets(): { preset: ServicePreset; package: string | null; version: string; validation: "not-checked" }[] {
  const rows = registry.all<ServicePreset>("service-preset").map((preset) => ({ preset: cacheServicePreset(preset), package: null as string | null, version: cliVersion(), validation: "not-checked" as const }));
  if (installedExtensionsEnabled()) for (const extension of loadExtensionsManifest().extensions) {
    const refs = extensionProvides(extension).filter((ref) => ref.kind === "service-preset");
    for (const ref of refs) {
      const preset = extension.servicePresets?.find((preset) => preset.name === ref.name);
      if (!preset) throw new CommandFailure("refused", "CONFLICT", "an installed service preset has no cached declaration; update or re-add its extension");
      const live = rows.find((row) => row.preset.name === preset.name);
      if (live) {
        if (live.package !== null || serviceMetadataDigest(live.preset) !== serviceMetadataDigest(cacheServicePreset(preset))) throw new CommandFailure("refused", "CONFLICT", "several providers claim different service presets under one name");
        live.package = extension.pkg; live.version = extension.version;
      } else rows.push({ preset: cacheServicePreset(preset), package: extension.pkg, version: extension.version, validation: "not-checked" });
    }
  }
  return rows.sort((a, b) => a.preset.name < b.preset.name ? -1 : a.preset.name > b.preset.name ? 1 : 0);
}

export function resolveServicePreset(name: string): ServicePreset {
  if (!/^[a-z][a-z0-9-]{0,63}$/.test(name)) throw new CommandFailure("refused", "USAGE_INVALID", "--preset needs one declared lower-case preset name");
  const row = servicePresets().find((row) => row.preset.name === name);
  if (!row) throw new CommandFailure("refused", "DEPENDENCY_UNAVAILABLE", `no registered or installed service preset is named "${name}"; install its provider explicitly or use a supported --file definition`, { remedy: name === "web" ? "bare cotal svc lists the installed presets; add the dashboard provider with cotal ext add @cotal-ai/web" : "bare cotal svc lists the installed presets; add the extension that provides this one with cotal ext add <package>" });
  if (row.package !== null) {
    const owner = loadExtensionsManifest().extensions.find((extension) => extension.pkg === row.package);
    const checked = owner && verifiedExtensionServicePresets(owner).find((preset) => preset.name === name);
    if (!checked || serviceMetadataDigest(checked) !== serviceMetadataDigest(row.preset) || row.package.startsWith("@cotal-ai/") && row.version !== cliVersion()) throw new CommandFailure("refused", "CONFLICT", "the service preset package/version or cached declaration changed; no provider code was imported");
  }
  return row.preset;
}

function optionProperties(preset: ServicePreset) {
  const adapter = resolveServiceAdapter(preset.adapter, {}, false);
  return { adapter, properties: adapter.declaration.optionsSchema.properties as Record<string, Record<string, unknown>>, required: new Set((adapter.declaration.optionsSchema.required ?? []) as string[]) };
}

/** A declared path option shows the kind of path it takes; any other value shows its schema type. */
function placeholder(kind: string | undefined, type: unknown): string {
  return kind === "directory" ? "<dir>" : kind === "file" || kind === "private-file" ? "<file>" : `<${type === "object" || type === "array" ? "json" : String(type)}>`;
}

/** One source for parsing, help, completion and option collection. Complex options use bounded
 *  JSON strings; scalar fields are parsed according to their declared type, without coercion. */
export function servicePresetFlags(preset: ServicePreset): FlagSpec[] {
  const { adapter, properties, required } = optionProperties(preset);
  const flags: FlagSpec[] = [], names = new Set(Object.keys(properties));
  for (const [name, schema] of Object.entries(properties)) {
    if (!/^[a-z][a-z0-9-]{0,63}$/.test(name) || reserved.has(name) || schema.type === "boolean" && (reserved.has(`no-${name}`) || names.has(`no-${name}`))) throw new CommandFailure("refused", "UNSUPPORTED", "the preset option names cannot be represented without shadowing CLI flags; use a validated --file definition instead");
    const description = typeof schema.description === "string" ? schema.description : `add --preset ${preset.name}: declared ${name} option`;
    flags.push({ name, type: schema.type === "boolean" ? "boolean" : "string", ...(schema.type === "boolean" ? {} : { value: placeholder(adapter.declaration.paths?.[name], schema.type) }), description: required.has(name) && !description.includes("(required)") ? `${description} (required)` : description });
    // A boolean whose schema admits only true, such as an explicit intent, has no valid negative form.
    if (schema.type === "boolean" && schema.const !== true && !(Array.isArray(schema.enum) && !schema.enum.includes(false))) flags.push({ name: `no-${name}`, type: "boolean", description: `add --preset ${preset.name}: set ${name} to false` });
  }
  return flags;
}

export function servicePresetDefinition(preset: ServicePreset, space: string, values: ParsedArgs["values"]): ServiceDefinitionInput {
  const { properties, required } = optionProperties(preset), options: Record<string, unknown> = {};
  servicePresetFlags(preset);
  const missing = [...required].filter((name) => values[name] === undefined && values[`no-${name}`] === undefined);
  if (missing.length) throw new CommandFailure("refused", "USAGE_INVALID", `the ${preset.name} preset requires ${missing.map((name) => `--${name}`).join(", ")}`, { remedy: `cotal svc add <name> --preset ${preset.name} --help lists its options` });
  for (const [name, schema] of Object.entries(properties)) {
    const value = values[name], negative = values[`no-${name}`];
    if (value !== undefined && negative !== undefined) throw new CommandFailure("refused", "USAGE_INVALID", "a preset boolean option and its negative form cannot both be supplied");
    if (schema.type === "boolean") {
      if (value !== undefined && typeof value !== "boolean" || negative !== undefined && typeof negative !== "boolean") throw new CommandFailure("refused", "USAGE_INVALID", "a preset boolean option requires its declared flag form");
      if (value !== undefined || negative !== undefined) options[name] = negative === undefined ? value : !negative;
      continue;
    }
    if (value === undefined) continue;
    if (typeof value !== "string" || Buffer.byteLength(value, "utf8") > 256 * 1024) throw new CommandFailure("refused", "USAGE_INVALID", "a preset option exceeds its bounded string input; the value was not printed");
    if (schema.type === "string") options[name] = value;
    else {
      try { options[name] = JSON.parse(value); }
      catch { throw new CommandFailure("refused", "USAGE_INVALID", `--${name} is not valid JSON for its declared ${String(schema.type)} type; numeric values use JSON number syntax and bodies are not echoed`); }
    }
  }
  resolveServiceAdapter(preset.adapter, options);
  return { schemaVersion: 1, space, launch: { type: "adapter", adapter: preset.adapter, options }, readiness: { type: "adapter", timeoutMs: preset.timeoutMs } };
}

function requestedPreset(cmd: Command, argv: readonly string[]): string | undefined {
  let name: string | undefined;
  for (let index = 0; index < argv.length; index++) {
    const word = argv[index]!;
    if (word === "--") break;
    if (word === "--preset" || word.startsWith("--preset=")) {
      if (name !== undefined) throw new CommandFailure("refused", "USAGE_INVALID", "--preset cannot be supplied more than once");
      name = word === "--preset" ? argv[++index] : word.slice("--preset=".length);
      if (!name || name.startsWith("-")) throw new CommandFailure("refused", "USAGE_INVALID", "--preset needs one declared preset name");
      continue;
    }
    const flag = cmd.flags?.find((flag) => word === `--${flag.name}` || flag.short && word === `-${flag.short}`);
    if (flag?.type === "string") index++;
  }
  return name;
}

/** The service command's selected preset contributes metadata-only flags before strict parsing.
 *  Library composition roots use their registered providers, never an implicit prefix install. */
export function servicePresetCommand(cmd: Command, argv: readonly string[]): Command {
  if (cmd.name !== "service") return cmd;
  const name = requestedPreset(cmd, argv);
  if (name === undefined) return cmd;
  const preset = resolveServicePreset(name), flags = servicePresetFlags(preset);
  const metadata = serviceMetadataDigest({ preset, adapter: optionProperties(preset).adapter.pin });
  const check = () => {
    const current = resolveServicePreset(name);
    if (serviceMetadataDigest({ preset: current, adapter: optionProperties(current).adapter.pin }) !== metadata) throw new CommandFailure("refused", "CONFLICT", "the selected preset or adapter metadata changed during parsing; no changed definition was silently substituted");
  };
  return { ...cmd, flags: [...(cmd.flags ?? []), ...flags], subcommands: cmd.subcommands?.map((sub) => sub.name === "add" ? { ...sub, flagNames: [...(sub.flagNames ?? []), ...flags.map((flag) => flag.name)] } : sub), validate(args) { check(); cmd.validate?.(args); }, async run(args) { check(); await cmd.run(args); } };
}
