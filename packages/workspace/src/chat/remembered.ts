import { existsSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { assertLifecycleToken, ensureDirNoSymlink, hardenPrivate, parsePrincipalKey, unlinkFileNoFollow, writeSecretFileAtomic } from "@cotal-ai/core";
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

const folder = (space: string) => join(homeCotalDir(), "chat-sessions", spaceSegment(space));

/** Records `identity`, a session just opened at `target`, then removes the space's oldest records past
 *  {@link REMEMBERED_CHAT_SESSIONS}. Each session has its own file, which a rename writes whole, so two
 *  app runs on one space never write the same file and a reader never sees half of one. */
export function rememberChatSession(target: Pick<MeshTarget, "space" | "server">, identity: SessionIdentity): void {
  prepareCotalHomeForWrite();
  const dir = folder(target.space);
  const created = [join(homeCotalDir(), "chat-sessions"), dir].filter((path) => !existsSync(path));
  ensureDirNoSymlink(homeCotalDir(), "chat-sessions", spaceSegment(target.space));
  for (const path of created) hardenPrivate(path, "dir");
  protectedLocalDirectory(dir, FOLDER);
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

/** Removes every session remembered for `space`, so a later space of the same name starts with none.
 *  Returns how many there were. */
export function forgetChatSessions(space: string): number {
  const dir = folder(space);
  if (!existsSync(dir)) return 0;
  protectedLocalDirectory(dir, FOLDER);
  const count = readdirSync(dir).filter((name) => name.endsWith(".json")).length;
  rmSync(dir, { recursive: true, force: true });
  return count;
}

function scan(space: string): { records: { record: RememberedChatSession; path: string }[]; skipped: { path: string; reason: string }[] } {
  const dir = folder(space);
  if (!existsSync(dir)) return { records: [], skipped: [] };
  protectedLocalDirectory(dir, FOLDER);
  const records: { record: RememberedChatSession; path: string }[] = [];
  const skipped: { path: string; reason: string }[] = [];
  // A name without `.json` is a write in progress.
  for (const name of readdirSync(dir).filter((n) => n.endsWith(".json"))) {
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
