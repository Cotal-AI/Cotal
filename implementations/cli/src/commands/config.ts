import type { FlagSpec, FlagValues, ParsedArgs } from "@cotal-ai/core";
import {
  CommandFailure,
  PREFERENCE_KEYS,
  describeLayer,
  extensionProvides,
  getCurrent,
  jsonFlag,
  knownHarnesses,
  loadExtensionsManifest,
  plainFlag,
  preferenceInfo,
  preferenceSpaceProblem,
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

export const configFlags = [
  { name: "user", type: "boolean", description: "read or write your own defaults, with no space's values" },
  { name: "space", type: "string", value: "<name>", description: "read or write your personal values for one space" },
  jsonFlag,
  plainFlag,
] as const satisfies readonly FlagSpec[];

const usage = (message: string): CommandFailure => new CommandFailure("refused", "USAGE_INVALID", message);

/** The scope a run reads through or writes to: the user's defaults, or one space's values. */
interface Scope {
  readonly space: string | null;
  /** How the space was chosen: `--space`, or the selected space (`cotal use`) for a read. */
  readonly from: "flag" | "selected" | null;
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
  /** The key as a command in this scope now resolves it, from this shell. */
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
    const scope = readScope(v);
    const result: PreferencesResult = { kind: "preferences", file: preferencesPath(), revision: prefs.revision, scope, settings: PREFERENCE_KEYS.map((key) => setting(key, scope, prefs)) };
    writeResult(presentation, { command: "config", target: target(scope), result }, preferencesView);
    return;
  }
  if (sub === "get") {
    if (rest.length !== 1) throw usage("usage: cotal config get <key> [--user | --space <name>]");
    const key = keyOf(rest[0]!);
    const scope = readScope(v);
    const result: PreferenceResult = { kind: "preference", file: preferencesPath(), revision: prefs.revision, scope, setting: setting(key, scope, prefs) };
    writeResult(presentation, { command: "config", target: target(scope), result }, preferenceView);
    return;
  }
  if (sub === "set" || sub === "unset") {
    const want = sub === "set" ? 2 : 1;
    if (rest.length !== want) throw usage(sub === "set" ? "usage: cotal config set <key> <value> [--user | --space <name>]" : "usage: cotal config unset <key> [--user | --space <name>]");
    const key = keyOf(rest[0]!);
    const value = sub === "set" ? rest[1]! : undefined;
    if (key === "harness" && value !== undefined) checkHarness(value);
    const scope: Scope = v.space !== undefined ? { space: v.space, from: "flag" } : { space: null, from: null };
    const previous = (scope.space === null ? prefs.defaults[key] : prefs.spaces[scope.space]?.[key]) ?? null;
    const { changed, revision } = writePreference(scope.space === null ? {} : { space: scope.space }, key, value, prefs.revision);
    // What a command here uses next: through the written space, or the selected one for a default.
    const effective = setting(key, readScope(v), readPreferences());
    const result: PreferenceWrite = { kind: "preference-write", file: preferencesPath(), revision, scope, key, previous, value: value ?? null, effective };
    writeResult(presentation, { command: "config", target: target(scope), result, warnings: shadowedWrite(result), noOp: !changed }, writeView);
    return;
  }
  throw usage(`cotal config has no subcommand "${sub}" - run \`cotal help config\``);
}

/** A read looks through `--space`, or the selected space when neither scope flag is given. */
function readScope(v: FlagValues<typeof configFlags>): Scope {
  if (v.space !== undefined) return { space: v.space, from: "flag" };
  if (v.user) return { space: null, from: null };
  const selected = getCurrent();
  return selected ? { space: selected, from: "selected" } : { space: null, from: null };
}

const target = (scope: Scope) => (scope.space === null ? null : { space: scope.space });

function keyOf(word: string): PreferenceKey {
  return preferenceInfo(word).key;
}

function setting(key: PreferenceKey, scope: Scope, prefs: Preferences): Setting {
  const info = preferenceInfo(key);
  return { ...resolvePreference(key, { space: scope.space ?? undefined, preferences: prefs }), about: info.about, perSpace: info.perSpace };
}

/** A harness must name a connector this workstation knows, so a typo is refused at the write. */
function checkHarness(value: string): void {
  const installed = loadExtensionsManifest().extensions.flatMap((ext) => extensionProvides(ext).filter((ref) => ref.kind === "connector").map((ref) => ref.name));
  const known = knownHarnesses(installed);
  if (!known.includes(value)) throw usage(`no harness "${value}"; known harnesses: ${known.join(", ")}`);
}

/** A write that a higher layer still outranks in this shell says so, so the edit is not mistaken for
 *  the value a command will use. */
function shadowedWrite(w: PreferenceWrite): OutputWarning[] {
  if (w.value === null) return [];
  const winner = w.effective.winner;
  if (!winner || winner.source === (w.scope.space === null ? "user" : "space")) return [];
  return [{ code: "PREFERENCE_SHADOWED", target: target(w.scope), message: `${describeLayer(winner)} (${winner.value}) outranks this value in this shell` }];
}

const scopeText = (scope: Scope): string =>
  scope.space === null ? "your defaults" : `space ${scope.space}${scope.from === "selected" ? " (selected)" : ""}`;

const layerText = (layer: PreferenceLayer): string => `${describeLayer(layer)}: ${layer.value}`;

const valueCell = (s: Setting): Cell => (s.value === null ? { text: "not set", tone: "hint" } : s.value);

function preferencesView(r: PreferencesResult): Report {
  return {
    sections: [
      { blocks: [{ kind: "fields", rows: [["File", r.file], ["Scope", scopeText(r.scope)]] }] },
      {
        blocks: [{
          kind: "table",
          columns: [{ key: "key", label: "KEY" }, { key: "value", label: "VALUE" }, { key: "from", label: "FROM" }, { key: "shadowed", label: "ALSO SET" }],
          rows: r.settings.map((s) => ({
            key: { text: s.key, tone: "command" },
            value: valueCell(s),
            from: s.winner ? describeLayer(s.winner) : { text: "nothing", tone: "hint" },
            shadowed: { text: s.shadowed.map(layerText).join("; "), tone: "hint" },
          })),
        }],
      },
      { blocks: [{ kind: "lines", lines: [{ text: "Change one with `cotal config set <key> <value>`; add `--space <name>` to save it for one space.", tone: "hint" }] }] },
    ],
  };
}

function preferenceView(r: PreferenceResult): Report {
  const s = r.setting;
  return {
    sections: [{
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
        : { text: `✓ ${w.key} removed from ${where} (it was ${w.previous})`, tone: "ok" }
      : w.previous === w.value
        ? { text: `${w.key} is already ${w.value} in ${where}`, tone: "hint" }
        : { text: `✓ ${w.key} = ${w.value} in ${where}${w.previous === null ? "" : ` (it was ${w.previous})`}`, tone: "ok" };
  const now = w.effective;
  return {
    sections: [{
      blocks: [
        { kind: "lines", lines: [line] },
        { kind: "lines", lines: [{ text: `A command here now uses ${now.value ?? "nothing"} for ${w.key}, from ${now.winner ? describeLayer(now.winner) : "nothing"}.`, tone: "hint" }] },
      ],
    }],
  };
}
