import { accessSync, constants, lstatSync, realpathSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { agentFilePath, oneLine, personaDir, personaLinkTarget } from "@cotal-ai/core";
import { cachedPreferences, canonicalRoot, codeSpan, CommandFailure, describeLayer, isWorkspaceTargetError, loadLaunchPersonaFile, OFFICIAL_CONNECTORS, preparedNeverStarted, pruneStaleMeshes, resolveMeshTarget, resolveOnPath, resolvePreference, resolveReadsLiveness, shellPath, type MeshTarget, type PreferenceContext, type Presentation } from "@cotal-ai/workspace";
import { localDiagnostic } from "../telemetry.js";
import { defaultPersonaFix } from "./default-persona.js";

/** Persona selection shared by foreground and detached spawn: `--config`, then the positional, then
 *  the `persona` preference (`COTAL_DEFAULT_PERSONA`, the space's saved value, the user's, then
 *  `default`). `from` names where an implicit choice came from; it is absent for an explicit one and
 *  for the product default. */
export function spawnPersona(configFlag: string | undefined, positionals: readonly string[], ctx: PreferenceContext = {}): { ref: string; from?: string } {
  const explicit = configFlag ?? positionals[0];
  if (explicit !== undefined) return { ref: explicit };
  const winner = resolvePreference("persona", ctx).winner!;
  return winner.source === "default" ? { ref: winner.value } : { ref: winner.value, from: describeLayer(winner) };
}

/** Resolve the directory a foreground child will enter. Listing its contents is not required. */
export function directSpawnCwd(value: string, space?: string): string {
  let path = value, reason = "is not a directory";
  try {
    path = resolve(value);
    const cwd = realpathSync(path);
    if (statSync(cwd).isDirectory()) {
      accessSync(cwd, constants.X_OK);
      return cwd;
    }
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "EACCES" || code === "EPERM") throw new CommandFailure("refused", "PERMISSION_DENIED", `this account cannot enter --cwd ${JSON.stringify(path)}. Nothing was launched.`, {
      target: { space, path }, native: { code }, remedy: "choose a directory your account can enter, or restore search access and retry",
    });
    reason = code === "ENOENT" ? "does not exist" : code === "ENOTDIR" ? "is not a directory" : `cannot be used (${oneLine((error as Error).message)})`;
  }
  throw new CommandFailure("refused", "TARGET_UNAVAILABLE", `--cwd ${JSON.stringify(path)} ${reason}. Nothing was launched.`, {
    target: { space, path }, remedy: "pass an existing directory to --cwd, or omit --cwd to use the current directory",
  });
}

/** A positional or preferred catalog entry takes precedence over a same-named legacy path. */
export function directPersonaPath(root: string, ref: string, catalogFirst = true): string {
  if (catalogFirst && ref.endsWith(".md") && !isAbsolute(ref) && !/[\\/]/.test(ref)) {
    const catalogPath = join(personaDir(root), `${ref}.md`);
    if (lstatSync(catalogPath, { throwIfNoEntry: false })) return catalogPath;
  }
  return agentFilePath(root, ref);
}

/** The shipped implicit default has no pin. An absent explicit persona is a failed read. */
export function defaultPersonaPin(path: string, implicit: boolean): string | undefined {
  try { return loadLaunchPersonaFile(path).agent; }
  catch (error) {
    if (!implicit || (error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    return undefined;
  }
}

export function missingHarnessExecutables(requires: readonly string[]): string[] {
  const pins: Record<string, string | undefined> = { opencode: process.env.COTAL_OPENCODE_BIN, codex: process.env.COTAL_CODEX_BIN };
  return requires.filter((bin) => !resolveOnPath(pins[bin]?.trim() || bin));
}

/** The harness a launch falls back to when neither `--agent` nor the persona names one, as this
 *  caller sets it: `COTAL_DEFAULT_AGENT`, then the space's saved value, then the user's. Undefined
 *  when none is set, so a manager applies its own default before the product's. */
export function callerHarness(space: string): string | undefined {
  const winner = resolvePreference("harness", { space, preferences: cachedPreferences() }).winner;
  return winner && winner.source !== "default" ? winner.value : undefined;
}

/** Whether a spawn runs through a manager: only when the caller asks for one with `--detach` or
 *  `--on`. Any other spawn runs the application in this terminal, on every kind of mesh. */
export const spawnUsesManager = (values: { detach?: boolean; on?: string }): boolean => values.detach === true || values.on !== undefined;

/** Only a static mesh's seat carries an issuance whose expiry the caller sets. */
export function checkSpawnExpiryTarget(values: { "expires-in"?: string; "expires-at"?: string }, target: Pick<MeshTarget, "space" | "mode" | "auth">): void {
  if ((values["expires-in"] !== undefined || values["expires-at"] !== undefined) && (target.mode === "user" || !target.auth))
    throw new CommandFailure("refused", "USAGE_INVALID", `--expires-in and --expires-at set the expiry of a seat's issued credential on a static mesh, and mesh "${target.space}" is ${target.mode === "user" ? "a user-auth mesh, where the seat's bearer comes from your login" : "open and mints no credential"}`, { remedy: "drop the flag" });
}

/** The refusal for a harness with no installed connector, naming the package when it is official. */
export function missingConnector(name: string, target: object): CommandFailure {
  const pkg = OFFICIAL_CONNECTORS[name];
  return new CommandFailure("refused", "DEPENDENCY_UNAVAILABLE", `no connector "${name}" is installed`, { target,
    remedy: pkg ? `add it with \`cotal ext add ${pkg}\`` : "install its integration with `cotal ext add <npm-package>`, or check the name" });
}

/** After ENOENT or ENOTDIR loading a persona, check whether a link still occupies its path. */
export function brokenPersonaLink(path: string, target: object, shippedDefault = false): CommandFailure | undefined {
  const link = personaLinkTarget(path);
  if (link === undefined) return undefined;
  const subject = shippedDefault ? "the default persona" : "the persona";
  return new CommandFailure("refused", "TARGET_NOT_FOUND", `${subject} at ${path} is a symbolic link to a missing target: ${link}${shippedDefault ? ". The shipped default cannot replace the link" : ""}`, {
    target, remedy: shippedDefault ? "restore the link's target or move the broken link aside, then retry"
      : "restore the link's target, or move the link aside and put a regular persona file in its place",
  });
}

/** If ENOTDIR is not from the persona link's target, name the parent that blocks traversal. */
export function nonDirectoryPersonaPath(path: string, target: object): CommandFailure {
  const broken = brokenPersonaLink(path, target);
  if (broken) return broken;
  let parent: string | undefined;
  for (let dir = dirname(path); dir !== dirname(dir); dir = dirname(dir)) {
    try {
      if (!statSync(dir).isDirectory()) parent = dir;
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOTDIR") break;
    }
  }
  const problem = parent === undefined ? "a parent is not a directory" : `${parent} is not a directory`;
  return new CommandFailure("refused", "TARGET_NOT_FOUND", `cannot reach persona ${path}: ${problem}`, {
    target, remedy: "pass the correct persona file path with `--file`",
  });
}

/** The space a launch from `cwd` targets when no `--space` or `--server` names one: the space the mesh
 *  target resolves to, or the space prepared in this folder that no `up` has started, which
 *  `spawn --dry-run` previews. A selected space that is only prepared somewhere else is not one.
 *  Undefined when nothing here resolves to one space. */
export async function launchSpace(cwd: string): Promise<{ space: string; source: MeshTarget["source"] | "prepared" } | undefined> {
  try {
    const sweep = resolveReadsLiveness(cwd) ? await pruneStaleMeshes(undefined, "targets") : {};
    const target = resolveMeshTarget(cwd, { readOnly: true, ...sweep });
    return { space: target.space, source: target.source };
  } catch (error) {
    if (!isWorkspaceTargetError(error)) throw error;
    if (error.code !== "not-started" || !preparedNeverStarted(error.details)) return undefined;
    const inside = relative(canonicalRoot(error.details.root), canonicalRoot(cwd));
    return inside === "" || (!inside.startsWith("..") && !isAbsolute(inside)) ? { space: error.details.space, source: "prepared" } : undefined;
  }
}

/** The mesh a persona was looked for in. A preview of a space that is not started has no broker. */
export type PersonaSite = Pick<MeshTarget, "space" | "root" | "personaRoot"> & Partial<Pick<MeshTarget, "server" | "source" | "origin">>;

export function missingPersonaFailure(site: PersonaSite, ref: string, from: string | undefined, path: string, target = { space: site.space, path }, presentation: Presentation = "rich"): CommandFailure {
  const broken = brokenPersonaLink(path, target);
  if (broken) return broken;
  const { message, remedy } = missingPersona(site, ref, from, path, presentation);
  return localDiagnostic(new CommandFailure("refused", "TARGET_NOT_FOUND", message, { target, remedy }));
}

/** The refusal for a launch persona that is not there, which the launch and its preview both give. A
 *  path reference opened that one file and never read the catalog, so it names the file. A catalog
 *  name names the directory checked and the mesh that root came from, so a launch that read a
 *  different root than the one set up shows it in one read. A missing default also names the command
 *  that writes one. */
export function missingPersona(site: PersonaSite, ref: string, from: string | undefined, path: string, presentation: Presentation = "rich"): { message: string; remedy: string } {
  const fromText = from === undefined ? "" : ` from ${from}`;
  if (path !== join(site.personaRoot, `${ref}.md`)) return { message: `no persona "${ref}"${fromText}: ${path} was not found`, remedy: "check the path, or name a persona from the catalog" };
  const where = `${site.personaRoot} (mesh "${site.space}"${site.server ? ` at ${site.server}` : ""}${site.source === "current" ? ", your current mesh" : site.source === "registry" ? ", the only mesh running" : ""})`;
  if (ref === "default" && from === undefined) {
    const fix = defaultPersonaFix(site);
    const write = fix.cwd ? `run \`${fix.command}\` in ${fix.cwd} to write one` : `create one with \`${fix.command}\``;
    return { message: `no default persona in ${where}`, remedy: `${write}, name a persona with \`cotal spawn <name>\`, or pass a persona file with \`cotal spawn --file <persona.md>\`` };
  }
  const message = `no persona "${ref}"${fromText} in ${where}`;
  // An unregistered raw address or unnamed folder need not have a catalog reachable by --space.
  if (!site.origin && (!site.source || site.source === "flag-server" || site.source === "local-space"))
    return { message, remedy: "pass a catalog name, or a persona file elsewhere with `--file <persona.md>`" };
  const inspect = codeSpan(`cotal persona --space${site.space.startsWith("-") ? "=" : " "}${shellPath(site.space)}${presentation === "rich" ? "" : ` --${presentation}`}`);
  return { message, remedy: `list the catalog with ${inspect}, then pass a name from it, or a persona file with \`--file <persona.md>\`` };
}
