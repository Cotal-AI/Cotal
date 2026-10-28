import { registry, type Command, type FlagSpec, type ParsedArgs } from "@cotal-ai/core";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { cacheServicePreset, CommandFailure, extensionProvides, findMesh, loadExtensionsManifest, oneLine, segmentedKey, serviceMetadataDigest, spaceMaterialKey, verifiedExtensionServicePresets, type ServiceDefinitionInput, type ServicePreset, type ServicePresetDefault } from "@cotal-ai/workspace";
import { installedExtensionsEnabled } from "../ext-loader.js";
import { resolveServiceAdapter } from "./service-adapters.js";
import { cliVersion } from "./version.js";

const reserved = new Set(["help", "no-color", "no-input", "space", "json", "plain", "file", "preset", "exec", "cwd", "yes", "instance", "new-instance", "foreground", "with-agents", "dry-run", "tail", "follow"]);

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

/** The registered or installed preset of this name, or undefined; nothing is refused or loaded. */
export function findServicePreset(name: string): ServicePreset | undefined {
  if (!/^[a-z][a-z0-9-]{0,63}$/.test(name)) return undefined;
  try { return servicePresets().find((row) => row.preset.name === name)?.preset; }
  catch { return undefined; }
}

export function resolveServicePreset(name: string): ServicePreset {
  if (!/^[a-z][a-z0-9-]{0,63}$/.test(name)) throw new CommandFailure("refused", "USAGE_INVALID", "--preset needs one declared lower-case preset name");
  const row = servicePresets().find((row) => row.preset.name === name);
  if (!row) throw new CommandFailure("refused", "DEPENDENCY_UNAVAILABLE", `no registered or installed service preset is named "${name}"; install its provider explicitly or use a supported --file definition`, { remedy: name === "web" ? "bare `cotal svc` lists the installed presets; add the dashboard provider with `cotal ext add @cotal-ai/web`" : "bare `cotal svc` lists the installed presets; add the extension that provides this one with `cotal ext add <package>`" });
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

/** The flag an adapter option takes: its name with each capital letter as a dash and that letter in
 *  lower case, so `logFile` is `--log-file`, as `cotal up` spells the same option. */
export function presetFlagName(option: string): string {
  return option.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`);
}

/** A declared path option shows the kind of path it takes; any other value shows its schema type. */
function placeholder(kind: string | undefined, type: unknown): string {
  return kind === "directory" ? "<dir>" : kind === "file" || kind === "private-file" ? "<file>" : `<${type === "object" || type === "array" ? "json" : String(type)}>`;
}

/** One source for parsing, help, completion and option collection. Complex options use bounded
 *  JSON strings; scalar fields are parsed according to their declared type, without coercion. */
export function servicePresetFlags(preset: ServicePreset): FlagSpec[] {
  const { adapter, properties, required } = optionProperties(preset);
  const flags: FlagSpec[] = [], names = new Set(Object.keys(properties).map(presetFlagName));
  if (names.size !== Object.keys(properties).length) throw new CommandFailure("refused", "UNSUPPORTED", "the preset option names cannot be represented without shadowing CLI flags; use a validated --file definition instead");
  for (const [option, schema] of Object.entries(properties)) {
    const name = presetFlagName(option);
    if (!/^[a-z][a-z0-9-]{0,63}$/.test(name) || reserved.has(name) || schema.type === "boolean" && (reserved.has(`no-${name}`) || names.has(`no-${name}`))) throw new CommandFailure("refused", "UNSUPPORTED", "the preset option names cannot be represented without shadowing CLI flags; use a validated --file definition instead");
    const description = typeof schema.description === "string" ? schema.description : `add --preset ${preset.name}: declared ${option} option`;
    const fallback = preset.defaults?.[option];
    const marked = fallback ? `${description} (default: ${describeDefault(fallback)})` : required.has(option) && !description.includes("(required)") ? `${description} (required)` : description;
    flags.push({ name, type: schema.type === "boolean" ? "boolean" : "string", ...(schema.type === "boolean" ? {} : { value: placeholder(adapter.declaration.paths?.[option], schema.type) }), description: marked });
    // A boolean whose schema admits only true, such as an explicit intent, has no valid negative form.
    if (schema.type === "boolean" && schema.const !== true && !(Array.isArray(schema.enum) && !schema.enum.includes(false))) flags.push({ name: `no-${name}`, type: "boolean", description: `add --preset ${preset.name}: set ${option} to false` });
  }
  return flags;
}

/** The first string in an array option longer than its declared `items.maxLength`, counted in
 *  characters as the adapter's schema counts them. Its own error names only the field. */
function overLongItem(value: unknown, schema: Record<string, unknown>): { index: number; length: number; max: number } | undefined {
  const items = schema.type === "array" ? schema.items as { type?: unknown; maxLength?: unknown } | undefined : undefined;
  if (!Array.isArray(value) || items?.type !== "string" || typeof items.maxLength !== "number") return undefined;
  for (const [index, item] of value.entries()) {
    const length = typeof item === "string" ? [...item].length : 0;
    if (length > items.maxLength) return { index, length, max: items.maxLength };
  }
  return undefined;
}

/** How a default reads in help and in a receipt. */
export function describeDefault(fallback: ServicePresetDefault): string {
  if ("value" in fallback) return JSON.stringify(fallback.value);
  if (fallback.space === "material") return `this space's ${fallback.kind}`;
  return fallback.space === "root" ? "this space's root" : "this space's broker";
}

/** Where a material default lives for `space` under `root`. `migrate` resolves it as `up` does, which
 *  moves a legacy root-scoped copy into the space's folder first; a read only computes the path. */
export function presetMaterialPath(kind: string, space: string, root: string, migrate: boolean): string {
  return join(root, ".cotal", migrate ? spaceMaterialKey(kind, space, { injected: false, root }) : segmentedKey(kind, space));
}

/** The options a preset needs that have no default and were not given, by their flag names. */
export function presetMissingOptions(preset: ServicePreset, values: ParsedArgs["values"]): string[] {
  const { required } = optionProperties(preset);
  return [...required].filter((option) => values[presetFlagName(option)] === undefined && values[`no-${presetFlagName(option)}`] === undefined && preset.defaults?.[option] === undefined).map(presetFlagName);
}

/** The option values a preset's defaults supply in `space`, for the options the person did not give.
 *  A default that cannot be resolved refuses with the flag that replaces it; nothing is invented. */
export function presetDefaultOptions(preset: ServicePreset, space: string, root: string, values: ParsedArgs["values"], migrate = true): Record<string, string | boolean> {
  const filled: Record<string, string | boolean> = {};
  for (const [option, fallback] of Object.entries(preset.defaults ?? {})) {
    const name = presetFlagName(option);
    if (values[name] !== undefined || values[`no-${name}`] !== undefined) continue;
    // A number goes through the same JSON parse a typed flag value does.
    if ("value" in fallback) { filled[name] = typeof fallback.value === "number" ? JSON.stringify(fallback.value) : fallback.value; continue; }
    if (fallback.space === "root") { filled[name] = root; continue; }
    if (fallback.space !== "material") {
      const server = findMesh(space)?.server;
      if (!server) throw new CommandFailure("refused", "DEPENDENCY_UNAVAILABLE", `space ${oneLine(space)} has no registered broker for the ${preset.name} preset's --${name}`, { target: { space }, remedy: `pass --${name} <url>, or register the space with \`cotal up\` or \`cotal space add\`` });
      filled[name] = server;
      continue;
    }
    const path = presetMaterialPath(fallback.kind, space, root, migrate);
    if (!existsSync(path)) throw new CommandFailure("refused", "DEPENDENCY_UNAVAILABLE", `the ${preset.name} preset uses this space's ${fallback.kind} for --${name}, and ${path} does not exist yet; nothing was saved or started`, { target: { space, path }, remedy: `cotal up writes it for this space; or pass --${name} <file>` });
    filled[name] = path;
  }
  return filled;
}

/** `verb` is the command a refusal for a missing option repeats: `add <name>` or `start`. */
export function servicePresetDefinition(preset: ServicePreset, space: string, given: ParsedArgs["values"], root: string, verb = "add <name>", migrate = true): ServiceDefinitionInput {
  const { properties } = optionProperties(preset), options: Record<string, unknown> = {};
  const flags = servicePresetFlags(preset);
  const missing = presetMissingOptions(preset, given);
  const line = verb === "start" ? `cotal service start ${preset.name}` : `cotal service ${verb} --preset ${preset.name}`;
  if (missing.length) throw new CommandFailure("refused", "USAGE_INVALID", `the ${preset.name} preset needs ${missing.map((name) => `--${name}`).join(", ")}, which ${missing.length === 1 ? "has" : "have"} no default; nothing was saved or started`, { remedy: `${line} ${missing.map((name) => `--${name} ${flags.find((flag) => flag.name === name)?.value ?? ""}`.trimEnd()).join(" ")}`, selfContained: true, remedyIsCommand: true });
  const values: ParsedArgs["values"] = { ...presetDefaultOptions(preset, space, root, given, migrate), ...given };
  for (const [option, schema] of Object.entries(properties)) {
    const name = presetFlagName(option), value = values[name], negative = values[`no-${name}`];
    if (value !== undefined && negative !== undefined) throw new CommandFailure("refused", "USAGE_INVALID", "a preset boolean option and its negative form cannot both be supplied");
    if (schema.type === "boolean") {
      if (value !== undefined && typeof value !== "boolean" || negative !== undefined && typeof negative !== "boolean") throw new CommandFailure("refused", "USAGE_INVALID", "a preset boolean option requires its declared flag form");
      if (value !== undefined || negative !== undefined) options[option] = negative === undefined ? value : !negative;
      continue;
    }
    if (value === undefined) continue;
    if (typeof value !== "string" || Buffer.byteLength(value, "utf8") > 256 * 1024) throw new CommandFailure("refused", "USAGE_INVALID", "a preset option exceeds its bounded string input; the value was not printed");
    if (schema.type === "string") options[option] = value;
    else {
      try { options[option] = JSON.parse(value); }
      catch { throw new CommandFailure("refused", "USAGE_INVALID", `--${name} is not valid JSON for its declared ${String(schema.type)} type; numeric values use JSON number syntax and bodies are not echoed`); }
      const over = overLongItem(options[option], schema);
      if (over) throw new CommandFailure("refused", "USAGE_INVALID", `--${name} argument ${over.index + 1} has ${over.length} characters, and each holds at most ${over.max}; the value was not printed`);
    }
  }
  resolveServiceAdapter(preset.adapter, options);
  return { schemaVersion: 1, space, launch: { type: "adapter", adapter: preset.adapter, options }, readiness: { type: "adapter", timeoutMs: preset.timeoutMs } };
}

/** The preset a service invocation names: `--preset <name>` on add, or the name a start gives when
 *  that name is a preset's, so `service start web --creds <file>` takes the web preset's flags. */
function requestedPreset(cmd: Command, argv: readonly string[]): { name: string; verb: "add" | "start" } | undefined {
  let name: string | undefined;
  const positionals: string[] = [];
  for (let index = 0; index < argv.length; index++) {
    const word = argv[index]!;
    if (word === "--") { positionals.push(...argv.slice(index + 1)); break; }
    if (word === "--preset" || word.startsWith("--preset=")) {
      if (name !== undefined) throw new CommandFailure("refused", "USAGE_INVALID", "--preset cannot be supplied more than once");
      name = word === "--preset" ? argv[++index] : word.slice("--preset=".length);
      if (!name || name.startsWith("-")) throw new CommandFailure("refused", "USAGE_INVALID", "--preset needs one declared preset name");
      continue;
    }
    if (word.startsWith("-")) {
      const flag = cmd.flags?.find((flag) => word === `--${flag.name}` || flag.short && word === `-${flag.short}`);
      if (flag?.type === "string") index++;
      continue;
    }
    positionals.push(word);
  }
  if (name !== undefined) return { name, verb: "add" };
  const [mode, service] = positionals;
  return mode === "start" && service !== undefined && findServicePreset(service) ? { name: service, verb: "start" } : undefined;
}

/** The service command's selected preset contributes metadata-only flags before strict parsing.
 *  Library composition roots use their registered providers, never an implicit prefix install. */
export function servicePresetCommand(cmd: Command, argv: readonly string[]): Command {
  if (cmd.name !== "service") return cmd;
  const requested = requestedPreset(cmd, argv);
  if (requested === undefined) return cmd;
  const { name, verb } = requested;
  const preset = resolveServicePreset(name), flags = servicePresetFlags(preset);
  const metadata = serviceMetadataDigest({ preset, adapter: optionProperties(preset).adapter.pin });
  const check = () => {
    const current = resolveServicePreset(name);
    if (serviceMetadataDigest({ preset: current, adapter: optionProperties(current).adapter.pin }) !== metadata) throw new CommandFailure("refused", "CONFLICT", "the selected preset or adapter metadata changed during parsing; no changed definition was silently substituted");
  };
  return { ...cmd, flags: [...(cmd.flags ?? []), ...flags], subcommands: cmd.subcommands?.map((sub) => sub.name === verb ? { ...sub, flagNames: [...(sub.flagNames ?? []), ...flags.map((flag) => flag.name)] } : sub), validate(args) { check(); cmd.validate?.(args); }, async run(args) { check(); await cmd.run(args); } };
}

/** The option flags a start of this preset-named service may carry, as `servicePresetCommand` adds them. */
export function presetStartFlags(name: string): string[] {
  const preset = findServicePreset(name);
  return preset ? servicePresetFlags(preset).map((flag) => flag.name) : [];
}
