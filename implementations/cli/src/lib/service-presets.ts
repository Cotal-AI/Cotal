import { brokerUrlHasUserinfo, registry, type Command, type FlagSpec, type ParsedArgs } from "@cotal-ai/core";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { assertManagerName, brokerUrlCredentialRefusal, cacheServicePreset, codeSpan, CommandFailure, extensionProvides, findMesh, hasUserAuthState, installedExtensionPackage, isCommandFailure, loadExtensionsManifest, loadRoster, oneLine, presentationOf, recordOperationWarning, resolveNativeServiceTarget, runtimeInstallHint, segmentedKey, serviceMetadataDigest, spaceMaterialKey, validateServiceAdapterOptions, validateServiceAdapterPaths, verifiedExtensionServicePresets, WEB_SERVICE_ADAPTER, type ServiceDefinitionInput, type ServicePreset, type ServicePresetDefault } from "@cotal-ai/workspace";
import { localDiagnostic } from "../telemetry.js";
import { showSpaceCommand } from "./space-show-command.js";
import { installedExtensionsEnabled } from "../ext-loader.js";
import { metadataPositionals } from "./command-path.js";
import { shellWord } from "./endpoint-errors.js";
import { resolveServiceAdapter } from "./service-adapters.js";
import { STACK_ADAPTER } from "./stack-journal.js";
import { cliVersion } from "./version.js";

/** Check the manager's launch coordinates, name and runtime metadata without importing a provider. */
export function assertManagerStartOptions(space: string, options: Record<string, unknown>): void {
  const server = options.server as string | undefined;
  if (server !== undefined && brokerUrlHasUserinfo(server)) throw brokerUrlCredentialRefusal("--server");
  if (server !== undefined || findMesh(space)) resolveNativeServiceTarget(String(options.root), space, server);
  if (options.name !== undefined) assertManagerName(String(options.name));

  const runtime = String(options.runtime);
  if (runtime === "pty" || registry.has("runtime", runtime)) return;
  const extension = installedExtensionsEnabled() ? loadExtensionsManifest().extensions.find((row) => extensionProvides(row).some((ref) => ref.kind === "runtime" && ref.name === runtime)) : undefined;
  const target = { space, runtime };
  if (!extension) throw new CommandFailure("refused", "DEPENDENCY_UNAVAILABLE", runtimeInstallHint(runtime), { target });
  if (installedExtensionPackage(extension.pkg)?.version !== extension.version || extension.pkg.startsWith("@cotal-ai/") && extension.version !== cliVersion())
    throw new CommandFailure("refused", "DEPENDENCY_UNAVAILABLE", `the installed package for runtime ${JSON.stringify(runtime)} is missing or does not match the required version`, { target, remedy: `check it with \`cotal runtimes\`` });
}

/** Check the contents of a roster whose path the adapter has already validated. */
export function checkManagerStartRoster(roster: unknown, target: { space: string; name: string }, preview: boolean): boolean {
  if (typeof roster !== "string") return true;
  try { loadRoster(roster); }
  catch (error) {
    const message = `the manager roster was not loaded: ${(error as Error).message}`;
    if (!preview) throw new CommandFailure("failed", "OPERATION_FAILED", message, { target, remedy: "correct the roster and rerun the command" });
    recordOperationWarning({ code: "SCHEMA_INVALID", target, message: `the real start would fail: ${message}` });
    return false;
  }
  return true;
}

const reserved = new Set(["help", "no-color", "no-input", "space", "json", "plain", "file", "preset", "exec", "cwd", "yes", "instance", "new-instance", "foreground", "no-open", "with-agents", "dry-run", "tail", "follow"]);

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

function optionProperties(preset: ServicePreset, registeredOnly = false) {
  const adapter = resolveServiceAdapter(preset.adapter, {}, false, undefined, registeredOnly);
  return { adapter, properties: adapter.declaration.optionsSchema.properties as Record<string, Record<string, unknown>>, required: new Set((adapter.declaration.optionsSchema.required ?? []) as string[]) };
}

/** Options a preset takes as `cotal up --log-file` takes its path, by adapter: made absolute against
 *  the folder the command runs in. They are not declared paths, so the file need not exist yet and a
 *  stop never checks it. */
const resolvedPaths: Readonly<Record<string, readonly string[]>> = { "nats-broker": ["logFile"] };

/** Options a preset takes as a broker URL, by adapter, so help names the value as the refusal does. */
const urlOptions: Readonly<Record<string, readonly string[]>> = { "nats-broker": ["server"] };

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
export function servicePresetFlags(preset: ServicePreset, registeredOnly = false): FlagSpec[] {
  const { adapter, properties, required } = optionProperties(preset, registeredOnly);
  const flags: FlagSpec[] = [], names = new Set(Object.keys(properties).map(presetFlagName));
  if (names.size !== Object.keys(properties).length) throw new CommandFailure("refused", "UNSUPPORTED", "the preset option names cannot be represented without shadowing CLI flags; use a validated --file definition instead");
  for (const [option, schema] of Object.entries(properties)) {
    const name = presetFlagName(option);
    if (!/^[a-z][a-z0-9-]{0,63}$/.test(name) || reserved.has(name) || schema.type === "boolean" && (reserved.has(`no-${name}`) || names.has(`no-${name}`))) throw new CommandFailure("refused", "UNSUPPORTED", "the preset option names cannot be represented without shadowing CLI flags; use a validated --file definition instead");
    const description = typeof schema.description === "string" ? schema.description : `add --preset ${preset.name}: declared ${option} option`;
    const fallback = preset.defaults?.[option];
    const marked = fallback ? `${description} (default: ${describeDefault(fallback)})` : required.has(option) && !description.includes("(required)") ? `${description} (required)` : description;
    const value = resolvedPaths[preset.adapter]?.includes(option) ? "<path>" : urlOptions[preset.adapter]?.includes(option) ? "<url>" : placeholder(adapter.declaration.paths?.[option], schema.type);
    flags.push({ name, type: schema.type === "boolean" ? "boolean" : "string", ...(schema.type === "boolean" ? {} : { value }), description: marked });
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

/** The defaults `space` cannot fill yet for the options the person did not give, by flag name, with
 *  the value each takes and why: no registered broker, or a file the space does not keep yet. It only
 *  reads, so a listing or a refusal can name them before {@link presetDefaultOptions} refuses one. */
export function presetUnfilledDefaults(preset: ServicePreset, space: string, root: string, values: ParsedArgs["values"]): { name: string; value: string; reason: string }[] {
  const unfilled: { name: string; value: string; reason: string }[] = [];
  for (const [option, fallback] of Object.entries(preset.defaults ?? {})) {
    const name = presetFlagName(option);
    if (values[name] !== undefined || values[`no-${name}`] !== undefined || "value" in fallback || fallback.space === "root") continue;
    if (fallback.space !== "material") { if (!findMesh(space)?.server) unfilled.push({ name, value: "<url>", reason: `space ${oneLine(space)} has no registered broker` }); }
    else if (!existsSync(presetMaterialPath(fallback.kind, space, root, false))) unfilled.push({ name, value: "<file>", reason: `space ${oneLine(space)} keeps no ${fallback.kind} yet` });
  }
  return unfilled;
}

/** The flag forms a new preset definition needs in this space, with value placeholders. */
export function presetRequiredInputs(preset: ServicePreset, space: string, root: string): string[] {
  const flags = servicePresetFlags(preset), missing = new Set(presetMissingOptions(preset, {}));
  return [...flags.filter((flag) => missing.has(flag.name)).map((flag) => `--${flag.name}${flag.value ? ` ${flag.value}` : ""}`), ...presetUnfilledDefaults(preset, space, root, {}).map((row) => `--${row.name} ${row.value}`)];
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
    if (!existsSync(path)) {
      if (preset.adapter === WEB_SERVICE_ADAPTER && fallback.kind === "web.creds" && findMesh(space)?.mode === "open") {
        throw new CommandFailure("refused", "DEPENDENCY_UNAVAILABLE", "the web dashboard requires a registered static-auth space, and the selected space is open; nothing was saved or started", { target: { space, path }, remedy: "select or create a registered static-auth space, then rerun the command for that space" });
      }
      throw localDiagnostic(new CommandFailure("refused", "DEPENDENCY_UNAVAILABLE", `the ${preset.name} preset uses this space's ${fallback.kind} for --${name}, and ${path} does not exist yet; nothing was saved or started`, {
        target: { space, path }, remedy: `inspect the intended project with ${showSpaceCommand(space, presentationOf(values))}; to supply the file for that space, pass --${name} <file> on the original command, keeping the other options unchanged`,
      }));
    }
    filled[name] = path;
  }
  return filled;
}

/** The option values `values` names, parsed as the preset declares them. A value that is not its
 *  declared JSON, or that is too long, is the same usage refusal either caller reports. */
function parsedPresetOptions(preset: ServicePreset, values: ParsedArgs["values"]): Record<string, unknown> {
  const { properties } = optionProperties(preset), options: Record<string, unknown> = {};
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
    if (resolvedPaths[preset.adapter]?.includes(option)) {
      if (!value.trim() || /[\u0000-\u001f\u007f]/u.test(value)) throw new CommandFailure("refused", "USAGE_INVALID", `--${name} must be a non-empty file path without control characters`);
      options[option] = resolve(value);
    } else if (schema.type === "string") options[option] = value;
    else {
      try { options[option] = JSON.parse(value); }
      catch { throw new CommandFailure("refused", "USAGE_INVALID", `--${name} is not valid JSON for its declared ${String(schema.type)} type; numeric values use JSON number syntax and bodies are not echoed`, { selfContained: true }); }
      const over = overLongItem(options[option], schema);
      if (over) throw new CommandFailure("refused", "USAGE_INVALID", `--${name} argument ${over.index + 1} has ${over.length} characters, and each holds at most ${over.max}; the value was not printed`, { selfContained: true });
    }
  }
  return options;
}

/** The refusal for one answer, from the same parse and closed schema {@link servicePresetDefinition}
 *  uses. The other options are absent, so only this answer is judged. */
export function presetOptionRefusal(preset: ServicePreset, name: string, value: string): string | undefined {
  const option = Object.keys(optionProperties(preset).properties).find((option) => presetFlagName(option) === name);
  if (!option) return `--${name} is not an option of the ${preset.name} preset`;
  let parsed: unknown;
  try { parsed = parsedPresetOptions(preset, { [name]: value })[option]; }
  catch (error) { return isCommandFailure(error) ? error.message : String(error); }
  const { adapter } = optionProperties(preset);
  const label = (key: string) => `--${presetFlagName(key)}`;
  try {
    validateServiceAdapterOptions({ ...adapter.declaration, optionsSchema: { ...adapter.declaration.optionsSchema, required: [] } }, { [option]: parsed }, label);
    if (adapter.declaration.paths?.[option]) validateServiceAdapterPaths(adapter.declaration, { [option]: parsed }, label);
  }
  catch (error) { return isCommandFailure(error) ? error.message : String(error); }
  return undefined;
}

/** `verb` is the command a refusal for a missing option repeats: `add <name>` or `start`. */
export function servicePresetDefinition(preset: ServicePreset, space: string, given: ParsedArgs["values"], root: string, verb = "add <name>", migrate = true): ServiceDefinitionInput {
  const flags = servicePresetFlags(preset);
  const missing = presetMissingOptions(preset, given);
  const line = verb === "start" ? `cotal service start ${preset.name}` : `cotal service ${verb} --preset ${preset.name}`;
  // Keep the caller's flags (including preview and output mode) without echoing option values.
  const fromCommand = verb === "start" || given.preset !== undefined;
  const retryWith = (additions: string) => `rerun the original command with ${codeSpan(additions)}, keeping all other arguments and flags unchanged`;
  if (missing.length) {
    const unfilled = presetUnfilledDefaults(preset, space, root, given);
    const additions = [...missing.map((name) => `--${name} ${flags.find((flag) => flag.name === name)?.value ?? ""}`.trimEnd()), ...unfilled.map((row) => `--${row.name} ${row.value}`)].join(" ");
    const onSpace = given.space === undefined ? "" : ` --space ${shellWord(space)}`;
    const showCommand = !fromCommand || Object.keys(given).every((name) => name === "space" || name === "preset");
    const retry = verb === "start" && given["new-instance"]
      ? `remove ${codeSpan("--new-instance")} and add ${codeSpan(additions)}, keeping the rest of the command unchanged`
      : retryWith(additions);
    throw new CommandFailure("refused", "USAGE_INVALID", `the ${preset.name} preset needs ${missing.map((name) => `--${name}`).join(", ")}, which ${missing.length === 1 ? "has" : "have"} no default${unfilled.map((row) => `, and --${row.name}, since ${row.reason}`).join("")}; nothing was saved or started`, { remedy: showCommand ? `${line} ${additions}${onSpace}` : retry, selfContained: true, ...(showCommand ? { remedyIsCommand: true } : {}) });
  }
  const values: ParsedArgs["values"] = { ...presetDefaultOptions(preset, space, root, given, migrate), ...given };
  const options = parsedPresetOptions(preset, values);
  // Check the manager launch flag pair before checking whether its file exists.
  if (preset.adapter === STACK_ADAPTER.manager && (options.launch === undefined) !== (options["launch-sha256"] === undefined)) {
    const supplied = options.launch === undefined ? "--launch-sha256" : "--launch";
    const needed = options.launch === undefined ? "--launch <file>" : "--launch-sha256 <digest>";
    throw new CommandFailure("refused", "USAGE_INVALID", `${supplied} requires ${needed}: a manager launch needs both its private native spec and its full SHA-256; nothing was saved or started`, { remedy: fromCommand ? retryWith(needed) : `${line} --launch <file> --launch-sha256 <digest>`, selfContained: true, ...(fromCommand ? {} : { remedyIsCommand: true }) });
  }
  // A refused option value is named by the flag the person typed, and the preset's help says what each takes.
  try { resolveServiceAdapter(preset.adapter, options, true, (option) => `--${presetFlagName(option)}`); }
  catch (error) {
    if (!isCommandFailure(error)) throw error;
    const launch = options.launch;
    if (preset.adapter === STACK_ADAPTER.manager && typeof launch === "string" && error.code === "TARGET_NOT_FOUND" && (error.target as { path?: string } | null)?.path === launch) {
      throw new CommandFailure(error.outcome, error.code, `the --launch specification ${launch} does not exist; nothing was saved or started`, {
        target: error.target,
        remedy: `rerun the original command with the absolute path to an existing resolved manager launch specification in ${codeSpan("--launch")} and its matching SHA-256 in ${codeSpan("--launch-sha256")}, keeping all other arguments and flags unchanged`,
        selfContained: true,
      });
    }
    if (error.code !== "SCHEMA_INVALID" || error.remedy !== undefined) throw error;
    throw new CommandFailure(error.outcome, error.code, error.message, { target: error.target, remedy: `see what each option takes with \`${line} --help\`` });
  }
  // The dashboard posts only with a separate posting credential, so each posting flag needs the other.
  // Its launch refuses one without the other, and a saved definition would offer a start that cannot run.
  if (preset.adapter === WEB_SERVICE_ADAPTER && (options["read-only"] === false) !== (typeof options["posting-creds"] === "string")) {
    const given = options["read-only"] === false ? "--no-read-only" : "--posting-creds";
    throw new CommandFailure("refused", "USAGE_INVALID", `${given} requires ${given === "--no-read-only" ? "--posting-creds <file>" : "--no-read-only"}: the dashboard posts only when it is not read-only, with a separate posting credential; nothing was saved or started`, { remedy: `${line} --no-read-only --posting-creds <file>`, selfContained: true, remedyIsCommand: true });
  }
  // Saving the native auth preset must not offer a start its hosting root cannot support.
  // Read only the existing marker, without preparing authority or importing provider code.
  if (preset.adapter === "auth-service" && (findMesh(space)?.mode !== "user" || !hasUserAuthState(String(options.root), space, { readOnly: true })))
    throw new CommandFailure("refused", "UNSUPPORTED", "the auth-service preset requires this root's prepared hosting user-auth state; nothing was saved or started, and no issuer or account was generated", {
      remedy: "prepare user-auth in the hosting root with `cotal up --user-auth --idp <url>`",
    });
  return { schemaVersion: 1, space, launch: { type: "adapter", adapter: preset.adapter, options }, readiness: { type: "adapter", timeoutMs: preset.timeoutMs } };
}

function knownPresetFlags(): FlagSpec[] {
  const byName = new Map<string, FlagSpec>();
  try {
    for (const { preset } of servicePresets()) {
      try {
        for (const flag of servicePresetFlags(preset)) if (!byName.has(flag.name)) byName.set(flag.name, flag);
      } catch { /* resolved when selected */ }
    }
  } catch { /* resolved when selected */ }
  return [...byName.values()];
}

/** The preset a service invocation names: `--preset <name>` on add, or the name a start gives when
 *  that name is a preset's, so `service start web --creds <file>` takes the web preset's flags. */
function requestedPreset(cmd: Command, argv: readonly string[]): { name: string; verb: "add" | "start" } | undefined {
  const flags = [...(cmd.flags ?? []), ...knownPresetFlags()];
  const [mode, service] = metadataPositionals({ flags }, argv).positionals.map((item) => item.value);
  let name: string | undefined;
  let presetCount = 0;
  let missingPreset = false;
  for (let index = 0; index < argv.length; index++) {
    const word = argv[index]!;
    if (word === "--") break;
    if (word === "--preset" || word.startsWith("--preset=")) {
      presetCount++;
      const value = word === "--preset" ? argv[++index] : word.slice("--preset=".length);
      if (!value || value.startsWith("-")) missingPreset = true;
      else name = value;
      continue;
    }
    const flag = flags.find((item) => word === `--${item.name}` || (item.short && word === `-${item.short}`));
    if (flag?.type === "string") index++;
  }
  if (presetCount > 0) {
    if (mode !== "add") return undefined;
    if (presetCount > 1) throw new CommandFailure("refused", "USAGE_INVALID", "--preset cannot be supplied more than once");
    if (missingPreset || !name) throw new CommandFailure("refused", "USAGE_INVALID", "--preset needs one declared preset name");
    return { name, verb: "add" };
  }
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
