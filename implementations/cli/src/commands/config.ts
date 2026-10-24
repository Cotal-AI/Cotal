import { dirname, isAbsolute } from "node:path";
import { existsSync } from "node:fs";
import { agentFilePath, type CompletionResult, type FlagSpec, type FlagValues, type ParsedArgs, type Subcommand } from "@cotal-ai/core";
import {
  COLOR_VALUES,
  CommandFailure,
  PREFERENCE_KEYS,
  isCommandFailure,
  describeLayer,
  extensionProvides,
  findMesh,
  findPreparedSpace,
  getCurrent,
  jsonFlag,
  knownHarnesses,
  loadExtensionsManifest,
  loadMeshes,
  loadPreparedSpaces,
  plainFlag,
  preferenceInfo,
  preferenceSpaceProblem,
  preferenceValueProblem,
  preferencesPath,
  presentationOf,
  readPreferences,
  resolvePreference,
  writePreference,
  writeResult,
  type Cell,
  type OutputWarning,
  type PreferenceKey,
  type PreferenceLayer,
  type Preferences,
  type Report,
  type ResolvedPreference,
} from "@cotal-ai/workspace";
import { completingFlagValue, positionalsForCompletion } from "../lib/completion.js";
import { personaCatalog, personaNameProblem } from "../lib/persona-files.js";
import { launchSpace } from "../lib/spawn-defaults.js";

export const configFlags = [
  { name: "user", type: "boolean", description: "read or write your own defaults, with no space's values" },
  { name: "space", short: "s", type: "string", value: "<name>", description: "read or write your personal values for one space" },
  { name: "verbose", short: "v", type: "boolean", description: "include the preferences file and revision" },
  jsonFlag,
  plainFlag,
] as const satisfies readonly FlagSpec[];

export const configSubcommands = [
  { name: "get", summary: "show one key's value, where it comes from and what it outranks", usage: "cotal config get <key> [--user | --space <name>] [--json|--plain]", outputs: ["json", "plain"], reads: true },
  { name: "set", summary: "save a value for you, or for one space with --space", usage: "cotal config set <key> <value> [--user | --space <name>] [--json|--plain]", outputs: ["json", "plain"] },
  { name: "unset", summary: "remove a saved value", usage: "cotal config unset <key> [--user | --space <name>] [--json|--plain]", outputs: ["json", "plain"] },
] as const satisfies readonly Subcommand[];

/** Complete the subcommand, the key, and a value from the closed sets a write checks: color's and the
 *  known harnesses. The dispatcher completes `--space`. */
export function configComplete(argv: string[]): CompletionResult {
  const words = completingFlagValue(argv, configFlags) ? [] : positionalsForCompletion(argv, configFlags);
  if (words.length === 1) return { items: configSubcommands.map((sub) => ({ value: sub.name, description: sub.summary })), directive: "nofiles" };
  if (words.length === 2 && configSubcommands.some((sub) => sub.name === words[0])) return { items: PREFERENCE_KEYS.map((key) => ({ value: key, description: preferenceInfo(key).about })), directive: "nofiles" };
  if (words.length === 3 && words[0] === "set") return { items: (words[1] === "color" ? [...COLOR_VALUES] : words[1] === "harness" ? harnessNames() : []).map((value) => ({ value })), directive: "nofiles" };
  return { items: [], directive: "nofiles" };
}

const usage = (message: string): CommandFailure => new CommandFailure("refused", "USAGE_INVALID", message, { remedy: "run `cotal help config` for its keys and forms" });

/** The scope a run reads through or writes to: the user's defaults, or one space's values. */
interface Scope {
  readonly space: string | null;
  /** How the space was chosen: `--space`, the selected space (`cotal use`), or with nothing selected
   *  the space a launch here uses: this folder's, or the only running one. */
  readonly from: "flag" | "selected" | "folder" | "running" | null;
}

interface Setting extends ResolvedPreference {
  readonly about: string;
  readonly perSpace: boolean;
}

interface PreferencesResult {
  readonly kind: "preferences";
  readonly file: string;
  readonly revision: number;
  readonly scope: Scope;
  readonly settings: readonly Setting[];
}

interface PreferenceResult {
  readonly kind: "preference";
  readonly file: string;
  readonly revision: number;
  readonly scope: Scope;
  readonly setting: Setting;
}

interface PreferenceWrite {
  readonly kind: "preference-write";
  readonly file: string;
  readonly revision: number;
  readonly scope: Scope;
  readonly key: PreferenceKey;
  readonly previous: string | null;
  readonly value: string | null;
  /** The key as a command here now resolves it, from this shell: through `--space`, else the space a
   *  launch here uses, whichever scope was written. */
  readonly effective: Setting;
}

/**
 * `cotal config [get <key> | set <key> <value> | unset <key>]`: personal preferences. Bare `config`
 * and `get` show the value each key resolves to, where it came from and what it shadows. `set` and
 * `unset` change the user's defaults, or one space's with `--space`.
 */
export async function config(args: ParsedArgs): Promise<void> {
  const v = args.values as FlagValues<typeof configFlags>;
  const presentation = presentationOf(v);
  const [sub, ...rest] = args.positionals;
  if (v.user && v.space !== undefined) throw usage("--user and --space choose different scopes - pass one");
  if (v.space !== undefined) {
    const problem = preferenceSpaceProblem(v.space);
    if (problem) throw usage(problem);
  }
  const prefs = readPreferences();

  if (sub === undefined) {
    if (rest.length) throw usage("usage: cotal config [--user | --space <name>]");
    if (v.space !== undefined) assertKnownSpace(v.space, prefs, true);
    const scope = readScope(v);
    const result: PreferencesResult = { kind: "preferences", file: preferencesPath(), revision: prefs.revision, scope, settings: PREFERENCE_KEYS.map((key) => setting(key, scope, prefs)) };
    writeResult(presentation, { command: "config", target: target(scope), result, warnings: invalidEnvironmentValues(result.settings) }, (value) => preferencesView(value, Boolean(v.verbose)));
    return;
  }
  if (sub === "get") {
    if (rest.length !== 1) throw usage("usage: cotal config get <key> [--user | --space <name>]");
    const key = keyOf(rest[0]!);
    if (v.space !== undefined) assertKnownSpace(v.space, prefs, true);
    const scope = readScope(v);
    const result: PreferenceResult = { kind: "preference", file: preferencesPath(), revision: prefs.revision, scope, setting: setting(key, scope, prefs) };
    writeResult(presentation, { command: "config", target: target(scope), result, warnings: invalidEnvironmentValues([result.setting]) }, preferenceView);
    return;
  }
  if (sub === "set" || sub === "unset") {
    const want = sub === "set" ? 2 : 1;
    if (rest.length !== want) throw usage(sub === "set" ? "usage: cotal config set <key> <value> [--user | --space <name>]" : "usage: cotal config unset <key> [--user | --space <name>]");
    const key = keyOf(rest[0]!);
    const value = sub === "set" ? rest[1]! : undefined;
    if (key === "harness" && value !== undefined) checkHarness(value);
    // A blank persona is left to the key's own check, which names it empty.
    if (key === "persona" && value?.trim()) checkPersona(value);
    const scope: Scope = v.space !== undefined ? { space: v.space, from: "flag" } : { space: null, from: null };
    // A value saved for a space that is neither registered nor prepared would never apply, so a typo
    // is refused with the spaces there are, once the write's own checks pass. Unset also takes a space
    // that still holds a saved value, so a value left for a gone space can go.
    if (scope.space !== null && preferenceInfo(key).perSpace && (sub === "unset" || !preferenceValueProblem(key, value!))) assertKnownSpace(scope.space, prefs, sub === "unset");
    const previous = (scope.space === null ? prefs.defaults[key] : prefs.spaces[scope.space]?.[key]) ?? null;
    const { changed, revision, replacedMode } = writePreference(scope.space === null ? {} : { space: scope.space }, key, value, prefs.revision);
    // The write replaces the file with a private one, so a mode someone set on it, such as read-only, is named as gone.
    const modeChanged: OutputWarning[] = replacedMode === undefined ? [] : [{ code: "PREFERENCES_MODE_CHANGED", target: { path: preferencesPath() }, message: `${preferencesPath()} was mode ${replacedMode.toString(8).padStart(4, "0")}, and this write replaced it with a new file at mode 0600; a file's mode does not stop config set or unset` }];
    // What a command here uses next, whichever scope was written: through `--space`, else the space a
    // launch here uses, as `spawn` resolves it. `--user` chooses where the value is saved, not that.
    const here = readScope({ ...v, user: undefined });
    const effective = setting(key, here, readPreferences());
    const result: PreferenceWrite = { kind: "preference-write", file: preferencesPath(), revision, scope, key, previous, value: value ?? null, effective };
    const missing = key === "persona" && value?.trim() ? missingPersona(value, here) : undefined;
    writeResult(presentation, { command: "config", target: target(scope), result, warnings: [...modeChanged, ...shadowedWrite(result), ...(missing ? [missing] : [])], noOp: !changed }, writeView);
    return;
  }
  throw usage(`cotal config has no subcommand "${sub}" - run \`cotal help config\``);
}

/** Refuse a `--space` this machine does not know, naming the spaces it does. A registered or prepared
 *  space is known. With `saved`, for a read or an unset, so is a space that still holds a saved value,
 *  so a value left for a removed space can be read and removed. */
function assertKnownSpace(space: string, prefs: Preferences, saved: boolean): void {
  const holdsValue = (name: string) => Object.keys(prefs.spaces[name] ?? {}).length > 0;
  if (findMesh(space) || findPreparedSpace(space) || (saved && holdsValue(space))) return;
  const known = [...new Set([...loadMeshes().map((mesh) => mesh.space), ...loadPreparedSpaces().map((prepared) => prepared.space), ...(saved ? Object.keys(prefs.spaces).filter(holdsValue) : [])])].sort();
  throw new CommandFailure("refused", "TARGET_NOT_FOUND", `no space named ${JSON.stringify(space)} is ${saved ? "registered, prepared or holding a saved value here" : "registered or prepared here"}${known.length ? `; known spaces: ${known.join(", ")}` : ""}`, {
    remedy: `name a known space with --space, or prepare it first with \`cotal space create ${space}\` or register it with \`cotal space add ${space} --server <url>\``,
  });
}

/** A read looks through `--space`, or when neither scope flag is given, the space a launch here uses:
 *  the selected one, else the one `spawn` resolves from this folder. */
function readScope(v: FlagValues<typeof configFlags>): Scope {
  if (v.space !== undefined) return { space: v.space, from: "flag" };
  if (v.user) return { space: null, from: null };
  const selected = getCurrent();
  if (selected) return { space: selected, from: "selected" };
  const here = launchSpace(process.cwd());
  return here ? { space: here.space, from: here.source === "registry" ? "running" : "folder" } : { space: null, from: null };
}

const target = (scope: Scope) => (scope.space === null ? null : { space: scope.space });

function keyOf(word: string): PreferenceKey {
  return preferenceInfo(word).key;
}

function setting(key: PreferenceKey, scope: Scope, prefs: Preferences): Setting {
  const info = preferenceInfo(key);
  return { ...resolvePreference(key, { space: scope.space ?? undefined, preferences: prefs }), about: info.about, perSpace: info.perSpace };
}

/** A harness must name a connector this workstation knows, so a typo is refused at the write.
 *  `persona create --harness` takes the same check. */
export function checkHarness(value: string): void {
  const problem = harnessProblem(value);
  if (problem) throw usage(problem);
}

function harnessProblem(value: string): string | undefined {
  const known = harnessNames();
  return known.includes(value) ? undefined : `no harness ${JSON.stringify(value)}; known harnesses: ${known.join(", ")}`;
}

/** The harnesses this workstation knows: the official connectors and the installed ones. */
function harnessNames(): string[] {
  return knownHarnesses(loadExtensionsManifest().extensions.flatMap((ext) => extensionProvides(ext).filter((ref) => ref.kind === "connector").map((ref) => ref.name)));
}

/** A persona default is a catalog name or a persona file path, the two forms a launch resolves (a path
 *  is absolute, holds a slash or ends in `.md`, as `agentFilePath` decides), so a value that can be
 *  neither is refused at the write. Whether it exists is decided at launch, in the space it runs in. */
function checkPersona(value: string): void {
  const problem = personaProblem(value);
  if (problem) throw usage(problem);
}

const isPersonaPath = (value: string): boolean => isAbsolute(value) || /[\\/]/.test(value) || value.endsWith(".md");

function personaProblem(value: string): string | undefined {
  const problem = !isPersonaPath(value)
    ? personaNameProblem(value)
    : /[\u0000-\u001f\u007f]/u.test(value) || value !== value.trim() ? "a persona file path cannot hold control characters or surrounding spaces" : undefined;
  return problem && `invalid persona ${JSON.stringify(value)}: ${problem}`;
}

/** A persona the catalog of the space a command here uses does not hold, as a warning. The value is
 *  still saved, since the file may be created later. A space this machine cannot resolve has no
 *  catalog here to check. */
function missingPersona(value: string, scope: Scope): OutputWarning | undefined {
  if (scope.space === null) return undefined;
  let catalog;
  try { catalog = personaCatalog({ space: scope.space }); }
  catch (error) { if (isCommandFailure(error)) return undefined; throw error; }
  const path = agentFilePath(catalog.root, value);
  if (existsSync(path)) return undefined;
  const missing = isPersonaPath(value) ? `no persona file ${path}` : `no persona "${value}" in space ${catalog.space}'s catalog ${dirname(path)}`;
  return { code: "PERSONA_NOT_FOUND", target: { space: catalog.space, path }, message: `${missing}; the preference was saved, and a launch there needs that file` };
}

/** A variable that wins with a value `config set` refuses still wins, as it always has. It is named
 *  in a warning, so the mistake shows before a launch or an attach reads it. */
export function invalidEnvironmentValues(settings: readonly ResolvedPreference[]): OutputWarning[] {
  return settings.flatMap(({ key, winner }) => {
    if (winner?.source !== "environment") return [];
    const problem = preferenceValueProblem(key, winner.value) ?? (key === "harness" ? harnessProblem(winner.value) : key === "persona" ? personaProblem(winner.value) : undefined);
    return problem ? [{ code: "PREFERENCE_INVALID", target: { variable: winner.name, key }, message: `${winner.name}: ${problem}; config set refuses this value, and the variable still wins in this shell` }] : [];
  });
}

/** A write that a higher layer still outranks in this shell says so, so the edit is not mistaken for
 *  the value a command will use. */
function shadowedWrite(w: PreferenceWrite): OutputWarning[] {
  if (w.value === null) return [];
  const winner = w.effective.winner;
  if (!winner || winner.source === (w.scope.space === null ? "user" : "space")) return [];
  return [{ code: "PREFERENCE_SHADOWED", target: target(w.scope), message: `${describeLayer(winner)} (${winner.value}) outranks this value in this shell` }];
}

const SCOPE_FROM: Partial<Record<NonNullable<Scope["from"]>, string>> = { selected: " (selected)", folder: " (this folder's)", running: " (the only running space)" };
const scopeText = (scope: Scope): string =>
  scope.space === null ? "your defaults" : `space ${scope.space}${scope.from ? SCOPE_FROM[scope.from] ?? "" : ""}`;

const layerText = (layer: PreferenceLayer): string => `${describeLayer(layer)}: ${layer.value}`;

const valueCell = (s: Setting): Cell => (s.value === null ? { text: "not set", tone: "hint" } : s.value);

function preferencesView(r: PreferencesResult, verbose = false): Report {
  const shadowed = r.settings.some((item) => item.shadowed.length > 0);
  return {
    sections: [
      { title: "Preferences", blocks: [{ kind: "lines", lines: [{ text: scopeText(r.scope), tone: "hint" }] }] },
      {
        blocks: [{
          kind: "table",
          columns: [{ key: "key", label: "Setting" }, { key: "value", label: "Value" }, { key: "from", label: "Source" }, ...(shadowed ? [{ key: "shadowed", label: "Also set" }] : [])],
          rows: r.settings.map((item) => ({
            key: item.key,
            value: valueCell(item),
            from: { text: item.winner ? describeLayer(item.winner) : "not set", tone: "hint" },
            shadowed: { text: item.shadowed.map(layerText).join("; "), tone: "hint" },
          })),
        }],
      },
      ...(verbose ? [{ title: "Storage", blocks: [{ kind: "fields" as const, rows: [["File", r.file] as const, ["Revision", String(r.revision)] as const] }] }] : []),
      { blocks: [{ kind: "lines", lines: [{ text: "These defaults affect future launches. Running agents are unchanged.", tone: "hint" }] }] },
      { title: "Next", blocks: [{ kind: "commands", items: [
        { command: "cotal cfg set <key> <value>", description: "Change your default" },
        { command: "cotal cfg set <key> <value> -s <space>", description: "Change it for one space" },
        { command: "cotal cfg get <key>", description: "See its source and overrides" },
      ] }] },
    ],
  };
}

function preferenceView(r: PreferenceResult): Report {
  const s = r.setting;
  return {
    sections: [{
      title: `Preference · ${s.key}`,
      blocks: [
        { kind: "fields", rows: [["Key", { text: s.key, tone: "command" }], ["Value", valueCell(s)], ["From", s.winner ? describeLayer(s.winner) : "nothing"], ["Scope", scopeText(r.scope)]] },
        ...(s.shadowed.length ? [{ kind: "lines" as const, lines: ["Also set, outranked:", ...s.shadowed.map((l) => ({ text: `  ${layerText(l)}`, tone: "hint" as const }))] }] : []),
        { kind: "lines", lines: [{ text: s.about, tone: "hint" }] },
      ],
    }],
  };
}

function writeView(w: PreferenceWrite): Report {
  const where = w.scope.space === null ? "your defaults" : `space ${w.scope.space}`;
  const line: Cell =
    w.value === null
      ? w.previous === null
        ? { text: `${w.key} was not set in ${where}`, tone: "hint" }
        : { text: `${w.key} removed from ${where} (it was ${w.previous})`, tone: "ok", mark: "✓" }
      : w.previous === w.value
        ? { text: `${w.key} is already ${w.value} in ${where}`, tone: "hint" }
        : { text: `${w.key} = ${w.value} in ${where}${w.previous === null ? "" : ` (it was ${w.previous})`}`, tone: "ok", mark: "✓" };
  const now = w.effective;
  return {
    sections: [{
      blocks: [
        { kind: "lines", lines: [line] },
        { kind: "fields", rows: [["Saved to", where], ["Effective value", now.value ?? "not set"], ["Source", now.winner ? describeLayer(now.winner) : "not set"], ["Running agents", "unchanged"]] },
      ],
    }],
  };
}
