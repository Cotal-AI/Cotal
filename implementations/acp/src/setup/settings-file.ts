/**
 * An ACP client's settings file, edited in place. Setup changes only the keys it names: comments,
 * key order and formatting stay as the application or the person left them. Before it changes a
 * file it copies the old one beside it, and it writes the new one atomically, through a temporary
 * file renamed over the old. A file it cannot parse is refused, never rewritten.
 */
import { randomBytes } from "node:crypto";
import { chmodSync, closeSync, constants, copyFileSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeSync } from "node:fs";
import { dirname } from "node:path";
import { applyEdits, modify, parse, printParseErrorCode, type JSONPath, type ParseError } from "jsonc-parser";

export interface SettingsFile {
  /** The path the application reads. */
  readonly path: string;
  /** The file's text, or undefined when there is no file yet. */
  readonly text: string | undefined;
  readonly value: Record<string, unknown>;
}

/** One key setup sets. */
export interface SettingsChange {
  readonly path: JSONPath;
  readonly value: unknown;
}

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

/** The settings at `path`, `{}` when there is none. `app` names the application in a refusal. */
export function readSettings(path: string, app: string): SettingsFile {
  if (!existsSync(path)) return { path, text: undefined, value: {} };
  const text = readFileSync(path, "utf8");
  const errors: ParseError[] = [];
  const value: unknown = text.trim() ? parse(text, errors, { allowTrailingComma: true }) : {};
  const first = errors[0];
  if (first) throw new Error(`${path} is not valid ${app} settings (${printParseErrorCode(first.error)} at offset ${first.offset}), so Cotal left it alone. Fix it, then run \`cotal setup\` again.`);
  if (!isObject(value)) throw new Error(`${path} does not hold a settings object, so Cotal left it alone. Fix it, then run \`cotal setup\` again.`);
  return { path, text, value };
}

/** The object at `key` of `value`: `{}` when the key is absent. Any other value is refused, naming the file. */
export function objectAt(file: SettingsFile, key: string): Record<string, unknown> {
  const found = file.value[key];
  if (found === undefined) return {};
  if (!isObject(found)) throw new Error(`${file.path} has a "${key}" that is not an object, so Cotal left it alone. Fix it, then run \`cotal setup\` again.`);
  return found;
}

/** The indentation the file already uses, so an added entry looks like its neighbours. */
function formatting(text: string): { insertSpaces: boolean; tabSize: number; eol: string } {
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  const indent = /^([ \t]+)\S/m.exec(text)?.[1];
  if (indent?.startsWith("\t")) return { insertSpaces: false, tabSize: 1, eol };
  return { insertSpaces: true, tabSize: indent ? indent.length : 2, eol };
}

/** Copy `path` to a new file beside it named for the UTC time, `<file>.cotal-backup-YYYYMMDDTHHMMSSZ`,
 *  numbered when an earlier backup has that name, and return where it went. */
function backUp(path: string, mode: number): string {
  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
  for (let n = 1; ; n++) {
    const backup = `${path}.cotal-backup-${stamp}${n === 1 ? "" : `-${n}`}`;
    try {
      copyFileSync(path, backup, constants.COPYFILE_EXCL);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "EEXIST") continue;
      throw e;
    }
    chmodSync(backup, mode);
    return backup;
  }
}

export interface SettingsWrite {
  /** Whether the file changed. A file that already holds every change is not written. */
  readonly changed: boolean;
  /** Where the old file was copied, when there was one to copy. */
  readonly backup?: string;
}

/**
 * Apply `changes` to the file and write it. A file reached through a symbolic link is written at its
 * target, so a settings file kept in a dotfiles folder stays linked. Nothing is written when every
 * change is already there. A file the application changed since it was read is refused rather than
 * overwritten, and so is one this account may not write.
 */
export function writeSettings(file: SettingsFile, changes: readonly SettingsChange[]): SettingsWrite {
  const before = file.text ?? "";
  let text = file.text?.trim() ? file.text : `{}${formatting(before).eol}`;
  const options = formatting(text);
  for (const change of changes) text = applyEdits(text, modify(text, change.path, change.value, { formattingOptions: options }));
  if (text === file.text) return { changed: false };
  const errors: ParseError[] = [];
  parse(text, errors, { allowTrailingComma: true });
  if (errors.length) throw new Error(`Cotal's edit of ${file.path} did not parse; the file was left as it was`);

  const target = file.text !== undefined && lstatSync(file.path).isSymbolicLink() ? realpathSync(file.path) : file.path;
  mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
  const mode = file.text !== undefined ? statSync(target).mode & 0o777 : 0o600;
  let backup: string | undefined;
  const tmp = `${target}.cotal-${process.pid}-${randomBytes(4).toString("hex")}`;
  try {
    if (file.text !== undefined) backup = backUp(target, mode);
    const fd = openSync(tmp, "wx", mode);
    try {
      writeSync(fd, text);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    const now = existsSync(target) ? readFileSync(target, "utf8") : undefined;
    if (now !== file.text) throw new Error(`${file.path} changed while Cotal was editing it, so Cotal left the new version alone. Run \`cotal setup\` again.`);
    renameSync(tmp, target);
  } catch (e) {
    rmSync(tmp, { force: true });
    const code = (e as NodeJS.ErrnoException).code;
    if (code === "EACCES" || code === "EPERM" || code === "EROFS") throw new Error(`Cotal may not write ${file.path} (${code}). Make it writable, then run \`cotal setup\` again.`);
    throw e;
  }
  return { changed: true, ...(backup ? { backup } : {}) };
}

/** {@link writeSettings}, reporting the file and its backup to setup's receipt. Returns whether it changed. */
export function writeReported(app: string, file: SettingsFile, changes: readonly SettingsChange[], wrote?: (what: string, path: string) => void): boolean {
  const written = writeSettings(file, changes);
  if (written.changed) wrote?.(`${app} settings`, file.path);
  if (written.backup) wrote?.(`${app} settings backup`, written.backup);
  return written.changed;
}
