import { existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import { acquireLock, globalConfigDir, token, writeSecretFileAtomic } from "@cotal-ai/core";
import { CommandFailure, isCommandFailure, type OutputWarning } from "./output.js";
import { localRecordAccess, protectedLocalDirectory } from "./protected-records.js";
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

/** The values `color` takes. */
export const COLOR_VALUES = ["auto", "always", "never"] as const;

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
    // FORCE_COLOR keeps the precedence over NO_COLOR it has always had: `0` or `false`, in any case,
    // is never and any other value always. NO_COLOR is a no-color preference when it is non-empty
    // (no-color.org).
    env: ["FORCE_COLOR", "NO_COLOR"],
    productDefault: "auto",
    check: (value) => ((COLOR_VALUES as readonly string[]).includes(value) ? undefined : `use ${COLOR_VALUES.join(", ")}`),
    fromEnv: (name, raw) => (name === "FORCE_COLOR" ? (raw === "0" || raw.toLowerCase() === "false" ? "never" : "always") : raw ? "never" : undefined),
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
  if (!spec) throw new CommandFailure("refused", "USAGE_INVALID", `unknown preference "${key}"; valid keys: ${PREFERENCE_KEYS.join(", ")}`, { remedy: "run `cotal config` to see each key and its value" });
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
    remedy: `fix or remove ${preferencesPath()}; nothing resets it`,
  });

const SPACE_NAME_REMEDY = "run `cotal space` for the names of the spaces this machine knows";

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

/** Refuse a preferences file that is a symbolic link, as every private record's link is, naming its
 *  target: `editor` runs as a shell command, and `harness` and `persona` choose what `spawn` launches,
 *  so the file is neither read through the link nor replaced by a write. */
function assertPreferencesNotLinked(path: string): void {
  if (localRecordAccess() === "posix" && lstatSync(path, { throwIfNoEntry: false })?.isSymbolicLink())
    throw new CommandFailure("refused", "PERMISSION_DENIED", `the preferences file ${path} is a symbolic link to ${readlinkSync(path)}; preferences are kept only in a regular file, so nothing was read or changed`, {
      target: { path },
      remedy: `replace the link ${path} with a regular copy of the file it names`,
    });
}

/** Refuse a preferences write into a folder another local account could write, by the rule every
 *  protected path follows (see {@link protectedLocalDirectory}): that account could replace the file,
 *  and `editor` runs as a shell command. A folder not made yet is checked from the nearest one above
 *  it that exists. */
export function assertPreferencesFolderProtected(): void {
  let dir = globalConfigDir();
  while (!lstatSync(dir, { throwIfNoEntry: false }) && dirname(dir) !== dir) dir = dirname(dir);
  try {
    protectedLocalDirectory(dir, "the preferences folder");
  } catch (e) {
    if (!isCommandFailure(e) || e.code !== "PERMISSION_DENIED") throw e;
    throw new CommandFailure(e.outcome, e.code, `${e.message}; nothing was changed`, { remedy: e.remedy, target: e.target });
  }
}

/** The warning a command gives when the preferences file it read sits in a folder another local
 *  account could write, and the change that fixes the folder; undefined when there is no file or the
 *  folder is protected. The saved values still apply, and a write is refused (see
 *  {@link assertPreferencesFolderProtected}). */
export function preferencesFolderWarning(): { warning: OutputWarning; remedy: string } | undefined {
  if (!lstatSync(preferencesPath(), { throwIfNoEntry: false })) return undefined;
  try {
    protectedLocalDirectory(globalConfigDir(), "the preferences folder");
    return undefined;
  } catch (e) {
    if (!isCommandFailure(e) || e.code !== "PERMISSION_DENIED") throw e;
    const remedy = e.remedy ?? `make ${globalConfigDir()} a folder only you can write`;
    return { warning: { code: "PREFERENCES_FOLDER_UNPROTECTED", target: e.target, message: `${e.message}; the saved preferences still apply, and a write to them is refused until this is fixed: ${remedy}` }, remedy };
  }
}

/** Refuse a preferences path that is a FIFO, a device or a folder: opening one would block or fail,
 *  and preferences are kept only in a regular file. */
function assertPreferencesRegular(path: string): void {
  const stat = lstatSync(path, { throwIfNoEntry: false });
  if (stat && !stat.isFile())
    throw new CommandFailure("refused", "PERMISSION_DENIED", `the preferences file ${path} is not a regular file, such as a FIFO or a device; preferences are kept only in a regular file, so nothing was read or changed`, {
      target: { path },
      remedy: `remove ${path}, or replace it with a regular file`,
    });
}

/** The saved preferences. A missing file is no preferences at revision 0; a file that does not
 *  validate refuses with `SCHEMA_INVALID`, and is never reset. A linked file refuses with
 *  `PERMISSION_DENIED` (see {@link assertPreferencesNotLinked}), and so does a FIFO or another file
 *  that is not regular (see {@link assertPreferencesRegular}). */
export function readPreferences(): Preferences {
  let text: string;
  try {
    assertPreferencesNotLinked(preferencesPath());
    assertPreferencesRegular(preferencesPath());
    text = readFileSync(preferencesPath(), "utf8");
  } catch (e) {
    if (isCommandFailure(e)) throw e;
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return EMPTY;
    throw invalid(`it could not be read (${(e as Error).message})`);
  }
  return parsePreferences(text);
}

/** The last preferences this process read or wrote, by file. */
let cached: { path: string; prefs: Preferences } | undefined;

/** Where a write goes: the user's defaults, or one space's personal overrides. */
export type PreferenceScope = { readonly space?: string };

/** Why a write refuses `value` for `key` on this key's own check, or undefined when it passes. */
export function preferenceValueProblem(key: string, value: string): string | undefined {
  const problem = specOf(key).check(value);
  return problem && `invalid ${key} ${JSON.stringify(value)}: ${problem}`;
}

/**
 * Set (`value` a string) or clear (`value` undefined) one key in one scope, and report whether the
 * file changed. The write holds the preferences lock, refuses with `CONFLICT` when the file is no
 * longer at `expectedRevision`, and replaces the file atomically, so a concurrent edit is never lost.
 * A folder another local account could write refuses it with `PERMISSION_DENIED` before anything is
 * written (see {@link assertPreferencesFolderProtected}).
 * The new file is private (`0600`); `replacedMode` is the old file's mode when it was another, such as
 * a read-only `0400`, so the caller can say the mode changed.
 */
export function writePreference(scope: PreferenceScope, key: string, value: string | undefined, expectedRevision: number): { changed: boolean; revision: number; replacedMode?: number } {
  const spec = specOf(key);
  if (scope.space !== undefined) {
    const problem = preferenceSpaceProblem(scope.space);
    if (problem) throw new CommandFailure("refused", "USAGE_INVALID", problem, { remedy: SPACE_NAME_REMEDY });
    if (!spec.perSpace) throw new CommandFailure("refused", "USAGE_INVALID", `${key} has no per-space value; set it for the user`, { remedy: "run it again without --space" });
  }
  if (value !== undefined) {
    const problem = preferenceValueProblem(key, value);
    const space = scope.space === undefined ? "" : ` --space ${scope.space}`;
    if (problem) throw new CommandFailure("refused", "USAGE_INVALID", problem, { remedy: `give ${key} a value of that form; \`cotal config unset ${key}${space}\` returns it to its default` });
  }
  const dir = globalConfigDir();
  assertPreferencesFolderProtected();
  let lock: ReturnType<typeof acquireLock>;
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    lock = acquireLock(`${preferencesPath()}.lock`, { label: "a preferences write", waitMs: 10_000 });
  } catch (e) {
    // Nothing is written before the lock is held, so a folder that cannot be written is a definite refusal.
    const code = (e as NodeJS.ErrnoException).code;
    if (code === "EACCES" || code === "EPERM" || code === "EROFS")
      throw new CommandFailure("refused", "PERMISSION_DENIED", `the preferences folder ${dir} cannot be ${existsSync(dir) ? "written" : "created"} (${code}); nothing was changed`, {
        target: { path: dir },
        remedy: existsSync(dir) ? `make ${dir} writable by you, for example with \`chmod u+w ${dir}\`` : `make ${dirname(dir)} writable by you, or create ${dir} yourself`,
      });
    throw e;
  }
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
    const old = localRecordAccess() === "posix" ? lstatSync(preferencesPath(), { throwIfNoEntry: false }) : undefined;
    writeSecretFileAtomic(preferencesPath(), `${JSON.stringify(next, null, 2)}\n`);
    cached = { path: preferencesPath(), prefs: next };
    const oldMode = old ? old.mode & 0o777 : undefined;
    return { changed: true, revision: next.revision, ...(oldMode !== undefined && oldMode !== 0o600 ? { replacedMode: oldMode } : {}) };
  } finally {
    lock.release();
  }
}

/**
 * Clear every value saved for `space`, under the same folder check, lock and `expectedRevision` check
 * as {@link writePreference}, in one atomic replace. Returns what was removed, empty when the space had none.
 */
export function removeSpacePreferences(space: string, expectedRevision: number): { removed: Partial<Record<PreferenceKey, string>>; revision: number } {
  const problem = preferenceSpaceProblem(space);
  if (problem) throw new CommandFailure("refused", "USAGE_INVALID", problem, { remedy: SPACE_NAME_REMEDY });
  // A space with nothing saved needs no write, so no lock and no configuration folder.
  const before = readPreferences();
  if (!Object.keys(before.spaces[space] ?? {}).length) return { removed: {}, revision: before.revision };
  assertPreferencesFolderProtected();
  const lock = acquireLock(`${preferencesPath()}.lock`, { label: "a preferences write", waitMs: 10_000 });
  try {
    const current = readPreferences();
    if (current.revision !== expectedRevision)
      throw new CommandFailure("refused", "CONFLICT", `the preferences changed while this command ran (revision ${expectedRevision} became ${current.revision})`, {
        remedy: "run the command again",
      });
    const removed = { ...current.spaces[space] };
    if (!Object.keys(removed).length) return { removed, revision: current.revision };
    const spaces: Record<string, Partial<Record<PreferenceKey, string>>> = { ...current.spaces };
    delete spaces[space];
    const next: Preferences = { schemaVersion: PREFERENCES_SCHEMA_VERSION, revision: current.revision + 1, defaults: { ...current.defaults }, spaces };
    writeSecretFileAtomic(preferencesPath(), `${JSON.stringify(next, null, 2)}\n`);
    cached = { path: preferencesPath(), prefs: next };
    return { removed, revision: next.revision };
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
