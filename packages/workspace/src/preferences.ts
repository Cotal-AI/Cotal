import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { acquireLock, globalConfigDir, token, writeSecretFileAtomic } from "@cotal-ai/core";
import { CommandFailure } from "./output.js";
import { DEFAULT_CONNECTOR, OFFICIAL_CONNECTORS } from "./official-connectors.js";

/**
 * Personal workstation preferences: defaults a person sets for their own commands, saved for the
 * user and optionally per space. They never hold credentials, and they change future commands, not
 * running agents. One resolver decides every key, so `cotal config` shows the same winner the command
 * that reads the key uses.
 */

export const PREFERENCES_SCHEMA_VERSION = 1;

export type PreferenceKey = "harness" | "persona" | "detach-key" | "color" | "editor";

/** Where a value came from, in the order a launch setting is decided: a flag, a persona pin, a named
 *  environment variable, the per-space preference, the user preference, then the product default. */
export type PreferenceSource = "flag" | "pin" | "environment" | "space" | "user" | "default";

export interface PreferenceLayer {
  readonly source: PreferenceSource;
  /** The flag, environment variable or space the value came from. */
  readonly name?: string;
  readonly value: string;
}

export interface ResolvedPreference {
  readonly key: PreferenceKey;
  /** The value the command uses, or `null` when no layer sets one. */
  readonly value: string | null;
  readonly winner: PreferenceLayer | null;
  /** Every other layer that also set the key, highest first. */
  readonly shadowed: readonly PreferenceLayer[];
}

interface KeySpec {
  readonly key: PreferenceKey;
  readonly about: string;
  /** A key that may also be saved for one space. */
  readonly perSpace: boolean;
  /** The environment variables that supply it, highest first. */
  readonly env: readonly string[];
  readonly productDefault?: string;
  /** Why `value` is not a valid value for the key, or undefined. */
  check(value: string): string | undefined;
  /** The value an environment variable supplies, or undefined when it supplies none. */
  fromEnv?(name: string, raw: string): string | undefined;
}

const COLOR_VALUES = ["auto", "always", "never"] as const;

/** A detach key spelled `ctrl-<char>` or `^<char>`: a letter, or one of `@ [ \ ] ^ _`. */
export function parseDetachKey(spec: string): { byte: number; label: string } | undefined {
  const m = /^(?:ctrl-|\^)([a-z@[\\\]^_])$/i.exec(spec.trim());
  if (!m) return undefined;
  const ch = m[1]!.toUpperCase();
  return { byte: ch.charCodeAt(0) & 0x1f, label: `Ctrl-${ch}` };
}

const nonEmpty = (value: string) => (value.trim() ? undefined : "it cannot be empty");
const fromNonEmpty = (_name: string, raw: string) => raw.trim() || undefined;

const KEYS: readonly KeySpec[] = [
  {
    key: "harness",
    about: "the agent harness a launch uses when neither a flag nor the persona names one",
    perSpace: true,
    env: ["COTAL_DEFAULT_AGENT"],
    productDefault: DEFAULT_CONNECTOR,
    check: nonEmpty,
    fromEnv: fromNonEmpty,
  },
  {
    key: "persona",
    about: "the persona a launch uses when none is named",
    perSpace: true,
    env: ["COTAL_DEFAULT_PERSONA"],
    productDefault: "default",
    check: nonEmpty,
    fromEnv: fromNonEmpty,
  },
  {
    key: "detach-key",
    about: "the key that detaches from an attached agent",
    perSpace: false,
    env: ["COTAL_DETACH_KEY"],
    productDefault: "ctrl-]",
    check: (value) => (parseDetachKey(value) ? undefined : "use ctrl-<char> or ^<char>, where <char> is a letter or one of @ [ \\ ] ^ _"),
    // A set but unparseable variable is reported where the key is used, so it still wins here.
    fromEnv: (_name, raw) => raw,
  },
  {
    key: "color",
    about: "whether output is colored: auto (on a terminal), always or never",
    perSpace: false,
    // FORCE_COLOR keeps the precedence over NO_COLOR it has always had: `0` or `false` is never and
    // any other value always. NO_COLOR is a no-color preference when it is non-empty (no-color.org).
    env: ["FORCE_COLOR", "NO_COLOR"],
    productDefault: "auto",
    check: (value) => ((COLOR_VALUES as readonly string[]).includes(value) ? undefined : `use ${COLOR_VALUES.join(", ")}`),
    fromEnv: (name, raw) => (name === "FORCE_COLOR" ? (raw === "0" || raw === "false" ? "never" : "always") : raw ? "never" : undefined),
  },
  {
    key: "editor",
    about: "the editor command `personas edit` opens",
    perSpace: false,
    env: ["VISUAL", "EDITOR"],
    check: nonEmpty,
    fromEnv: fromNonEmpty,
  },
];

/** Every preference key, in display order. */
export const PREFERENCE_KEYS: readonly PreferenceKey[] = KEYS.map((k) => k.key);

function specOf(key: string): KeySpec {
  const spec = KEYS.find((k) => k.key === key);
  if (!spec) throw new CommandFailure("refused", "USAGE_INVALID", `unknown preference "${key}"; valid keys: ${PREFERENCE_KEYS.join(", ")}`);
  return spec;
}

/** What `key` means, whether it may be saved per space, and the variables that supply it. */
export function preferenceInfo(key: string): { key: PreferenceKey; about: string; perSpace: boolean; env: readonly string[]; productDefault: string | null } {
  const spec = specOf(key);
  return { key: spec.key, about: spec.about, perSpace: spec.perSpace, env: spec.env, productDefault: spec.productDefault ?? null };
}

/** The saved preferences. `revision` counts the writes, so a writer can tell the file changed. */
export interface Preferences {
  readonly schemaVersion: typeof PREFERENCES_SCHEMA_VERSION;
  readonly revision: number;
  readonly defaults: Readonly<Partial<Record<PreferenceKey, string>>>;
  readonly spaces: Readonly<Record<string, Readonly<Partial<Record<PreferenceKey, string>>>>>;
}

const EMPTY: Preferences = { schemaVersion: PREFERENCES_SCHEMA_VERSION, revision: 0, defaults: {}, spaces: {} };

/** `<globalConfigDir()>/preferences.json`, private to its owner. */
export function preferencesPath(): string {
  return join(globalConfigDir(), "preferences.json");
}

const invalid = (problem: string): CommandFailure =>
  new CommandFailure("refused", "SCHEMA_INVALID", `the preferences file ${preferencesPath()} is invalid: ${problem}`, {
    remedy: `fix or remove ${preferencesPath()}; nothing reset it`,
  });

/** Why a space name cannot hold preferences, or undefined. */
export function preferenceSpaceProblem(space: string): string | undefined {
  return space && token(space) === space ? undefined : `"${space}" is not a space name: use letters, digits, - and _`;
}

function checkScope(where: string, value: unknown, perSpaceOnly: boolean): Partial<Record<PreferenceKey, string>> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw invalid(`${where} is not an object`);
  for (const [key, v] of Object.entries(value)) {
    const spec = KEYS.find((k) => k.key === key);
    if (!spec) throw invalid(`${where} has an unknown key "${key}"`);
    if (perSpaceOnly && !spec.perSpace) throw invalid(`${where} sets "${key}", which has no per-space value`);
    if (typeof v !== "string") throw invalid(`${where}.${key} is not a string`);
    const problem = spec.check(v);
    if (problem) throw invalid(`${where}.${key} ${JSON.stringify(v)}: ${problem}`);
  }
  return value as Partial<Record<PreferenceKey, string>>;
}

/** Validate a parsed preferences document. Anything unexpected refuses; nothing is dropped. */
function parsePreferences(text: string): Preferences {
  let doc: unknown;
  try {
    doc = JSON.parse(text);
  } catch (e) {
    throw invalid(`not JSON (${(e as Error).message})`);
  }
  if (typeof doc !== "object" || doc === null || Array.isArray(doc)) throw invalid("not an object");
  const { schemaVersion, revision, defaults, spaces, ...rest } = doc as Record<string, unknown>;
  const extra = Object.keys(rest);
  if (extra.length) throw invalid(`unknown field "${extra[0]}"`);
  if (schemaVersion !== PREFERENCES_SCHEMA_VERSION) throw invalid(`schemaVersion ${JSON.stringify(schemaVersion)} is not ${PREFERENCES_SCHEMA_VERSION}; this cotal reads version ${PREFERENCES_SCHEMA_VERSION}`);
  if (typeof revision !== "number" || !Number.isSafeInteger(revision) || revision < 1) throw invalid("revision is not a positive integer");
  checkScope("defaults", defaults, false);
  if (typeof spaces !== "object" || spaces === null || Array.isArray(spaces)) throw invalid("spaces is not an object");
  for (const [space, scope] of Object.entries(spaces)) {
    const problem = preferenceSpaceProblem(space);
    if (problem) throw invalid(`spaces: ${problem}`);
    checkScope(`spaces.${space}`, scope, true);
  }
  return doc as Preferences;
}

/** The saved preferences. A missing file is no preferences at revision 0; a file that does not
 *  validate refuses with `SCHEMA_INVALID`, and is never reset. */
export function readPreferences(): Preferences {
  let text: string;
  try {
    text = readFileSync(preferencesPath(), "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return EMPTY;
    throw invalid(`it could not be read (${(e as Error).message})`);
  }
  return parsePreferences(text);
}

/** The last preferences this process read or wrote, by file. */
let cached: { path: string; prefs: Preferences } | undefined;

/** Where a write goes: the user's defaults, or one space's personal overrides. */
export type PreferenceScope = { readonly space?: string };

/**
 * Set (`value` a string) or clear (`value` undefined) one key in one scope, and report whether the
 * file changed. The write holds the preferences lock, refuses with `CONFLICT` when the file is no
 * longer at `expectedRevision`, and replaces the file atomically, so a concurrent edit is never lost.
 */
export function writePreference(scope: PreferenceScope, key: string, value: string | undefined, expectedRevision: number): { changed: boolean; revision: number } {
  const spec = specOf(key);
  if (scope.space !== undefined) {
    const problem = preferenceSpaceProblem(scope.space);
    if (problem) throw new CommandFailure("refused", "USAGE_INVALID", problem);
    if (!spec.perSpace) throw new CommandFailure("refused", "USAGE_INVALID", `${key} has no per-space value; set it for the user`);
  }
  if (value !== undefined) {
    const problem = spec.check(value);
    if (problem) throw new CommandFailure("refused", "USAGE_INVALID", `invalid ${key} ${JSON.stringify(value)}: ${problem}`);
  }
  mkdirSync(globalConfigDir(), { recursive: true, mode: 0o700 });
  const lock = acquireLock(`${preferencesPath()}.lock`, { label: "a preferences write", waitMs: 10_000 });
  try {
    const current = readPreferences();
    if (current.revision !== expectedRevision)
      throw new CommandFailure("refused", "CONFLICT", `the preferences changed while this command ran (revision ${expectedRevision} became ${current.revision})`, {
        remedy: "run the command again",
      });
    const defaults = { ...current.defaults };
    const spaces: Record<string, Partial<Record<PreferenceKey, string>>> = { ...current.spaces };
    const target = scope.space === undefined ? defaults : { ...spaces[scope.space] };
    if (target[spec.key] === value) return { changed: false, revision: current.revision };
    if (value === undefined) delete target[spec.key];
    else target[spec.key] = value;
    if (scope.space !== undefined) {
      if (Object.keys(target).length) spaces[scope.space] = target;
      else delete spaces[scope.space];
    }
    const next: Preferences = { schemaVersion: PREFERENCES_SCHEMA_VERSION, revision: current.revision + 1, defaults, spaces };
    writeSecretFileAtomic(preferencesPath(), `${JSON.stringify(next, null, 2)}\n`);
    cached = { path: preferencesPath(), prefs: next };
    return { changed: true, revision: next.revision };
  } finally {
    lock.release();
  }
}

/** Context for one resolution: the flag and persona pin the command has, the space it acts on, and
 *  the environment and saved preferences to read. */
export interface PreferenceContext {
  readonly flag?: { readonly name: string; readonly value: string | undefined };
  readonly pin?: string;
  readonly space?: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly preferences?: Preferences;
}

/**
 * Decide `key`: an explicit flag, then the persona pin, then the named environment variables, the
 * per-space preference, the user preference and the product default. The first layer that sets the
 * key wins and every later one is reported as shadowed.
 */
export function resolvePreference(key: PreferenceKey, ctx: PreferenceContext = {}): ResolvedPreference {
  const spec = specOf(key);
  const env = ctx.env ?? process.env;
  const prefs = ctx.preferences ?? readPreferences();
  const layers: PreferenceLayer[] = [];
  if (ctx.flag?.value !== undefined) layers.push({ source: "flag", name: ctx.flag.name, value: ctx.flag.value });
  if (ctx.pin !== undefined) layers.push({ source: "pin", value: ctx.pin });
  for (const name of spec.env) {
    const raw = env[name];
    const value = raw === undefined ? undefined : spec.fromEnv!(name, raw);
    if (value !== undefined) layers.push({ source: "environment", name, value });
  }
  const spaceValue = ctx.space !== undefined && spec.perSpace ? prefs.spaces[ctx.space]?.[key] : undefined;
  if (spaceValue !== undefined) layers.push({ source: "space", name: ctx.space, value: spaceValue });
  const userValue = prefs.defaults[key];
  if (userValue !== undefined) layers.push({ source: "user", value: userValue });
  if (spec.productDefault !== undefined) layers.push({ source: "default", value: spec.productDefault });
  const [winner, ...shadowed] = layers;
  return { key, value: winner?.value ?? null, winner: winner ?? null, shadowed };
}

/** How a layer reads in a sentence: `COTAL_DEFAULT_AGENT`, `your preference for space x`. */
export function describeLayer(layer: PreferenceLayer): string {
  switch (layer.source) {
    case "flag":
      return `--${layer.name}`;
    case "pin":
      return "the persona's pin";
    case "environment":
      return layer.name!;
    case "space":
      return `your preference for space ${layer.name}`;
    case "user":
      return "your preference";
    case "default":
      return "the default";
  }
}

/** The harnesses this workstation knows: the official connectors and the ones `installed` names. */
export function knownHarnesses(installed: readonly string[]): string[] {
  return [...new Set([...Object.keys(OFFICIAL_CONNECTORS), ...installed])].sort();
}

/** The preferences, read once per file in this process and kept current by its own writes, for a
 *  reader on every output line (color). It throws as {@link readPreferences} does. */
export function cachedPreferences(): Preferences {
  const path = preferencesPath();
  if (cached?.path !== path) cached = { path, prefs: existsSync(path) ? readPreferences() : EMPTY };
  return cached.prefs;
}
