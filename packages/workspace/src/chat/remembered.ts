import { existsSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { acquireLock, assertLifecycleToken, ensureDirNoSymlink, hardenPrivate, parsePrincipalKey, unlinkFileNoFollow, writeSecretFileAtomic } from "@cotal-ai/core";
import { spaceSegment } from "../auth-paths.js";
import { homeCotalDir } from "../cotal-home.js";
import type { MeshTarget } from "../mesh-target.js";
import { decodeLocalJson, localRecordObject, localRecordText, prepareCotalHomeForWrite, protectedLocalDirectory, readLocalRecordSource } from "../protected-records.js";
import type { SessionIdentity } from "./session.js";

/** A chat session the terminal app opened on this machine. A later run counts it as the human's and
 *  reads its direct messages. It holds no credential. */
export interface RememberedChatSession {
  readonly space: string;
  /** The broker it was opened at. A space of the same name at another broker reads none of it. */
  readonly server: string;
  /** The principal `<owner>.<actor>` it joined under. */
  readonly principal: string;
  readonly lifecycleUid: string;
  /** The name it joined under. */
  readonly label: string;
  /** When it opened, in epoch milliseconds. */
  readonly openedAt: number;
}

/** A space's remembered sessions at one broker, newest first, and each record that was skipped
 *  because it could not be read or trusted, with why. */
export interface RememberedChatSessions {
  readonly sessions: readonly RememberedChatSession[];
  readonly skipped: readonly { readonly path: string; readonly reason: string }[];
}

/** How many sessions a space keeps. Remembering one more removes the oldest. */
export const REMEMBERED_CHAT_SESSIONS = 20;

const VERSION = 1;
const FIELDS = ["v", "space", "server", "principal", "lifecycleUid", "label", "openedAt"];
const RECORD_LIMIT = 4096;
const FOLDER = "the folder of remembered chat sessions";

/** How many read marks a space keeps, the newest messages first. The app loads a few hundred direct
 *  messages at most, and fewer read ones than this are newer than any of those. */
export const READ_MARKS = 1000;

const READ_FILE = "read.json";
const READ_FIELDS = ["v", "space", "read"];
const READ_LIMIT = 256 * 1024;
const ID_LIMIT = 128;

const folder = (space: string) => join(homeCotalDir(), "chat-sessions", spaceSegment(space));
// A name without `.json` is a write in progress or a lock. The read marks share the folder, so
// forgetting a space forgets them too.
const sessionFiles = (dir: string) => readdirSync(dir).filter((name) => name.endsWith(".json") && name !== READ_FILE);

/** The space's folder, made private when it is new. */
function prepareFolder(space: string): string {
  prepareCotalHomeForWrite();
  const dir = folder(space);
  const created = [join(homeCotalDir(), "chat-sessions"), dir].filter((path) => !existsSync(path));
  ensureDirNoSymlink(homeCotalDir(), "chat-sessions", spaceSegment(space));
  for (const path of created) hardenPrivate(path, "dir");
  protectedLocalDirectory(dir, FOLDER);
  return dir;
}

/** Records `identity`, a session just opened at `target`, then removes the space's oldest records past
 *  {@link REMEMBERED_CHAT_SESSIONS}. Each session has its own file, which a rename writes whole, so two
 *  app runs on one space never write the same file and a reader never sees half of one. */
export function rememberChatSession(target: Pick<MeshTarget, "space" | "server">, identity: SessionIdentity): void {
  const dir = prepareFolder(target.space);
  const record = { v: VERSION, space: target.space, server: target.server, principal: identity.principal, lifecycleUid: identity.lifecycleUid, label: identity.label, openedAt: Date.now() };
  writeSecretFileAtomic(join(dir, `${assertLifecycleToken(identity.lifecycleUid)}.json`), `${JSON.stringify(record, null, 2)}\n`);
  for (const { path } of scan(target.space).records.slice(REMEMBERED_CHAT_SESSIONS)) {
    try {
      unlinkFileNoFollow(path);
    } catch (e) {
      // Another run removed it first.
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    }
  }
}

/** The sessions remembered for `target`'s space at its broker. A record is skipped when it does not
 *  parse, as a newer release's may not, or when its file is not owned and private. A folder that is a
 *  link or that another account could write throws: a record planted there would make the app read
 *  that principal's direct messages as the human's. */
export function rememberedChatSessions(target: Pick<MeshTarget, "space" | "server">): RememberedChatSessions {
  const { records, skipped } = scan(target.space);
  return { sessions: records.map((r) => r.record).filter((r) => r.server === target.server), skipped };
}

/** The ids of the direct messages the terminal app showed the human on `space`, in any run. Message
 *  ids are unique across brokers, so the marks are the space's. A record that does not parse throws,
 *  as does a folder or file another account could write. */
export function readMarks(space: string): ReadonlySet<string> {
  return new Set(loadMarks(space).keys());
}

/** Adds `messages` to `space`'s read marks and keeps the newest {@link READ_MARKS}. A lock holds the
 *  read and the write together, so two app runs on one space never drop each other's marks. An id
 *  longer than 128 characters throws, and nothing is written. */
export function markRead(space: string, messages: readonly { readonly id: string; readonly ts: number }[]): void {
  if (messages.some((m) => !m.id || m.id.length > ID_LIMIT)) throw new Error(`a message id is empty or longer than ${ID_LIMIT} characters`);
  const path = join(prepareFolder(space), READ_FILE);
  const lock = acquireLock(`${path}.lock`, { label: "a read-marks write", waitMs: 10_000 });
  try {
    const marks = loadMarks(space);
    for (const m of messages) marks.set(m.id, m.ts);
    const read = Object.fromEntries([...marks].sort((a, b) => b[1] - a[1]).slice(0, READ_MARKS));
    writeSecretFileAtomic(path, `${JSON.stringify({ v: VERSION, space, read })}\n`);
  } finally {
    lock.release();
  }
}

function loadMarks(space: string): Map<string, number> {
  const dir = folder(space);
  if (!existsSync(dir)) return new Map();
  protectedLocalDirectory(dir, FOLDER);
  const path = join(dir, READ_FILE);
  const bytes = readLocalRecordSource(path, READ_LIMIT, true);
  if (!bytes) return new Map();
  try {
    const value = decodeLocalJson(bytes);
    const v = (value as { v?: unknown } | null)?.v;
    if (v !== VERSION) throw new Error(`it is record version ${JSON.stringify(v)}, and this release reads version ${VERSION}`);
    const r = localRecordObject(value, READ_FIELDS);
    if (r.space !== space) throw new Error("it names another space");
    if (!r.read || typeof r.read !== "object" || Array.isArray(r.read)) throw new Error("its marks are not an object");
    return new Map(Object.entries(r.read).map(([id, ts]) => {
      if (!id || id.length > ID_LIMIT || typeof ts !== "number" || !Number.isFinite(ts)) throw new Error("a mark is not a message id with its time");
      return [id, ts];
    }));
  } catch (e) {
    throw new Error(`${path} was not read: ${(e as Error).message}`);
  }
}

/** Removes every session remembered for `space`, and its read marks, so a later space of the same name
 *  starts with none. Returns how many sessions there were. */
export function forgetChatSessions(space: string): number {
  const dir = folder(space);
  if (!existsSync(dir)) return 0;
  protectedLocalDirectory(dir, FOLDER);
  const count = sessionFiles(dir).length;
  rmSync(dir, { recursive: true, force: true });
  return count;
}

function scan(space: string): { records: { record: RememberedChatSession; path: string }[]; skipped: { path: string; reason: string }[] } {
  const dir = folder(space);
  if (!existsSync(dir)) return { records: [], skipped: [] };
  protectedLocalDirectory(dir, FOLDER);
  const records: { record: RememberedChatSession; path: string }[] = [];
  const skipped: { path: string; reason: string }[] = [];
  for (const name of sessionFiles(dir)) {
    const path = join(dir, name);
    try {
      const bytes = readLocalRecordSource(path, RECORD_LIMIT, true);
      if (bytes) records.push({ record: parse(decodeLocalJson(bytes), space, name), path });
    } catch (e) {
      skipped.push({ path, reason: (e as Error).message });
    }
  }
  records.sort((a, b) => b.record.openedAt - a.record.openedAt || b.record.lifecycleUid.localeCompare(a.record.lifecycleUid));
  return { records, skipped };
}

function parse(value: unknown, space: string, file: string): RememberedChatSession {
  const v = (value as { v?: unknown } | null)?.v;
  if (v !== VERSION) throw new Error(`it is record version ${JSON.stringify(v)}, and this release reads version ${VERSION}`);
  const r = localRecordObject(value, FIELDS);
  if (r.space !== space) throw new Error("it names another space");
  const principal = localRecordText(r.principal, 256);
  if (!parsePrincipalKey(principal)) throw new Error("its principal is not <owner>.<actor>");
  const lifecycleUid = assertLifecycleToken(localRecordText(r.lifecycleUid, 32));
  if (file !== `${lifecycleUid}.json`) throw new Error("its file is not named after its lifecycle UID");
  if (typeof r.openedAt !== "number" || !Number.isFinite(r.openedAt)) throw new Error("its opening time is not a number");
  return { space, server: localRecordText(r.server, 2048), principal, lifecycleUid, label: localRecordText(r.label, 128), openedAt: r.openedAt };
}
