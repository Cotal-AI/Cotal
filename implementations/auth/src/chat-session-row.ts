/**
 * The CHAT-SESSION ROW space: the third ledger row space, `chat-sessions/<owner>.<actor>.json`,
 * beside the interactive `actors/` and managed `managed-actors/` spaces. One file per user-mode chat
 * session, written by chat admission and retirement only, read by the connect file arm, the chat
 * exchange and the sweep.
 *
 * This is a NEW, CLOSED reader contract. The existing `readRow` (`ledger.ts`) validates its known
 * fields and returns any extras; it is deliberately NOT reused or changed here. {@link readChatSessionRow}
 * refuses every field outside the closed set, so a hand-added or partially written field never
 * authorizes.
 *
 * The directory decides the kind. A row authorizes nothing by itself: exchange and connect also
 * require the holder index `chatholder.<owner>.<holderHash>` to read `active` at the row's UID on a
 * leader read (`chat-session-store.ts`). `pending` authorizes nothing.
 *
 * Writes are whole-file. The first version is create-only (a no-overwrite publish), every later
 * version is an atomic tmp-and-rename, the `writeRow` shape. A file carries no store revision, so two
 * writers can race a rename; the row is therefore never the fence. The holder index CAS is, and the
 * sweep repairs a row whose state lags its retired index (named residual in HANDOFF).
 */
import { closeSync, constants, fstatSync, lstatSync, openSync, readdirSync, readFileSync, renameSync, type Stats } from "node:fs";
import { join } from "node:path";
import {
  EpEnvelopeError,
  MAX_CHANNEL_LENGTH,
  assertDerivedOwnerToken,
  assertLifecycleToken,
  assertValidChannel,
  mkSecretDir,
  writeSecretFile,
  writeSecretFileCreateOnly,
} from "@cotal-ai/core";

export const CHAT_SESSIONS_DIR = "chat-sessions";
const CHAT_ROW_VER = 1;

/** Request bounds, enforced at admission and re-asserted by the reader. */
export const CHAT_LABEL_MAX = 128;
export const CHAT_LIST_MAX = 64;
/** The absolute session cap, never extended. */
export const CHAT_SESSION_MAX_TTL_MS = 8 * 60 * 60 * 1000;

/** The server-drawn chat actor alias: `chat_` + 26 lowercase base32 characters (130 bits). */
export const CHAT_ACTOR = /^chat_[a-z2-7]{26}$/;
const HEX64 = /^[0-9a-f]{64}$/;

export type ChatSessionState = "pending" | "active" | "retired";
/** Outcomes a RETIRED row can record. `failed` is never recorded: a failed retirement leaves the
 *  row non-retired and is reported as pending. */
export type ChatRetireOutcome = "retired" | "alreadyRetired" | "notStarted";
const RETIRE_OUTCOMES: ReadonlySet<string> = new Set(["retired", "alreadyRetired", "notStarted"]);

/** The parent pin: the parent `cli` row's UID, the leader-read revision of its head, and the
 *  RFC 8785 digest of the row's authority fields (`chat-parent-pin.ts`). */
export interface ChatParentPin {
  actor: "cli";
  lifecycleUid: string;
  headRevision: number;
  rowDigest: string;
}

/** The full (uncompacted) row. */
export interface ChatSessionRow {
  owner: string;
  actor: string;
  lifecycleUid: string;
  holderHash: string;
  allowSubscribe: string[];
  allowPublish: string[];
  /** Always `[]`: no spawn, run, admin, view, role or capability rides a chat session. */
  scope: [];
  label?: string;
  admittedAt: number;
  expiresAt: number;
  parentPin: ChatParentPin;
  state: ChatSessionState;
  retiredAt?: number;
  retireOutcome?: ChatRetireOutcome;
}

/** The permanent tombstone left by compaction. Never deleted. */
export interface ChatSessionTombstone {
  owner: string;
  actor: string;
  lifecycleUid: string;
  holderHash: string;
  state: "retired";
  retiredAt: number;
  expiresAt: number;
}

export type ChatSessionRecord = { form: "row"; row: ChatSessionRow } | { form: "tombstone"; row: ChatSessionTombstone };

const ROW_FIELDS = new Set([
  "ver", "owner", "actor", "lifecycleUid", "holderHash", "allowSubscribe", "allowPublish", "scope", "label",
  "admittedAt", "expiresAt", "parentPin", "state", "retiredAt", "retireOutcome",
]);
const ROW_REQUIRED = ["ver", "owner", "actor", "lifecycleUid", "holderHash", "allowSubscribe", "allowPublish", "scope", "admittedAt", "expiresAt", "parentPin", "state"];
const TOMBSTONE_FIELDS = ["ver", "owner", "actor", "lifecycleUid", "holderHash", "state", "retiredAt", "expiresAt"];
const PIN_FIELDS = ["actor", "lifecycleUid", "headRevision", "rowDigest"];

const isRec = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);
const epochMs = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v) && v > 0;

function refuse(path: string, why: string): never {
  throw new EpEnvelopeError("failed-precondition", `${path}: chat-session row ${why} - a chat row outside the closed contract never authorizes`);
}

export function assertChatActor(actor: unknown): string {
  if (typeof actor !== "string" || !CHAT_ACTOR.test(actor))
    throw new EpEnvelopeError("bad-request", `chat actor ${JSON.stringify(actor)} is not chat_<26 lowercase base32>`);
  return actor;
}

export function assertHolderHash(v: unknown): string {
  if (typeof v !== "string" || !HEX64.test(v))
    throw new EpEnvelopeError("bad-request", "holderHash must be a lowercase sha256 hex digest");
  return v;
}

/** Validate one ACL list against the request bounds and the channel grammar. */
export function assertChatList(list: unknown, what: string): string[] {
  if (!Array.isArray(list)) throw new EpEnvelopeError("bad-request", `${what} must be an explicit list`);
  if (list.length > CHAT_LIST_MAX) throw new EpEnvelopeError("bad-request", `${what} has ${list.length} entries; at most ${CHAT_LIST_MAX}`);
  const seen = new Set<string>();
  for (const ch of list) {
    if (typeof ch !== "string" || ch.length === 0 || ch.length > MAX_CHANNEL_LENGTH)
      throw new EpEnvelopeError("bad-request", `${what} carries a non-channel entry`);
    try { assertValidChannel(ch); } catch (e) { throw new EpEnvelopeError("bad-request", `${what}: ${(e as Error).message}`); }
    if (seen.has(ch)) throw new EpEnvelopeError("bad-request", `${what} repeats ${ch}`);
    seen.add(ch);
  }
  return list as string[];
}

/** Validate a closed parent pin (shared with the holder index digest). */
export function parseChatParentPin(v: unknown, what: string): ChatParentPin {
  if (!isRec(v) || Object.keys(v).length !== PIN_FIELDS.length || !PIN_FIELDS.every((k) => k in v))
    throw new EpEnvelopeError("failed-precondition", `${what} is not the closed {actor, lifecycleUid, headRevision, rowDigest} pin`);
  if (v.actor !== "cli" || typeof v.lifecycleUid !== "string" || typeof v.rowDigest !== "string" || !HEX64.test(v.rowDigest) ||
    typeof v.headRevision !== "number" || !Number.isSafeInteger(v.headRevision) || v.headRevision < 1)
    throw new EpEnvelopeError("failed-precondition", `${what} does not validate`);
  try { assertLifecycleToken(v.lifecycleUid); } catch { throw new EpEnvelopeError("failed-precondition", `${what} carries a malformed lifecycleUid`); }
  return { actor: "cli", lifecycleUid: v.lifecycleUid, headRevision: v.headRevision, rowDigest: v.rowDigest };
}

function sessionsDir(dir: string): string {
  return join(dir, CHAT_SESSIONS_DIR);
}

/** The row's filename is its principal dot-form; both tokens are grammar-asserted first. */
export function chatSessionRowFilename(owner: string, actor: string): string {
  assertDerivedOwnerToken(owner);
  assertChatActor(actor);
  return `${owner}.${actor}.json`;
}

function chatRowPath(dir: string, owner: string, actor: string): string {
  return join(sessionsDir(dir), chatSessionRowFilename(owner, actor));
}

/** The row-space directory, or undefined ONLY when nothing at all exists at its path. `lstat`
 *  (never `existsSync`, which follows links and reads a dangling symlink as absent) decides: ENOENT
 *  alone is absence; a symlink (dangling or not), a non-directory, or any other stat failure
 *  refuses, so a planted link can never make a present row read as missing. */
function assertSessionsDirectory(dir: string): string | undefined {
  const path = sessionsDir(dir);
  let stat: Stats;
  try {
    stat = lstatSync(path);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw new EpEnvelopeError("failed-precondition", `${path}: the chat-session row space cannot be inspected (${(e as Error).message}); an unreadable authority directory never reads as empty`);
  }
  if (stat.isSymbolicLink() || !stat.isDirectory())
    throw new EpEnvelopeError("failed-precondition", `${path}: the chat-session row space must be a real directory, not a symlink or non-directory`);
  return path;
}

/** Validate parsed JSON against the closed contract. Exported for the reader smoke; never a
 *  substitute for {@link readChatSessionRow}, which also binds the file name. */
export function parseChatSessionRecord(raw: unknown, path: string): ChatSessionRecord {
  if (!isRec(raw)) refuse(path, "is not an object");
  if (raw.ver !== CHAT_ROW_VER) refuse(path, `has unknown version ${String(raw.ver)}`);
  const keys = Object.keys(raw);
  try {
    assertDerivedOwnerToken(raw.owner as string);
    assertChatActor(raw.actor);
    assertLifecycleToken(raw.lifecycleUid as string);
    assertHolderHash(raw.holderHash);
  } catch (e) {
    refuse(path, `has a malformed identity (${(e as Error).message})`);
  }
  if (!epochMs(raw.expiresAt)) refuse(path, "has a malformed expiresAt");

  // Tombstone form: exactly its closed set, nothing else.
  if (!("parentPin" in raw) && !("allowSubscribe" in raw)) {
    if (keys.length !== TOMBSTONE_FIELDS.length || !TOMBSTONE_FIELDS.every((k) => keys.includes(k)))
      refuse(path, `tombstone fields ${JSON.stringify(keys.sort())} are not the closed tombstone set`);
    if (raw.state !== "retired" || !epochMs(raw.retiredAt)) refuse(path, "tombstone is not a retired record");
    return { form: "tombstone", row: raw as unknown as ChatSessionTombstone };
  }

  for (const k of keys) if (!ROW_FIELDS.has(k)) refuse(path, `carries the unknown field "${k}"`);
  for (const k of ROW_REQUIRED) if (!(k in raw)) refuse(path, `is missing "${k}"`);
  if (!Array.isArray(raw.scope) || raw.scope.length !== 0) refuse(path, "scope must be []");
  try {
    assertChatList(raw.allowSubscribe, "allowSubscribe");
    assertChatList(raw.allowPublish, "allowPublish");
  } catch (e) {
    refuse(path, (e as Error).message);
  }
  if (raw.label !== undefined && (typeof raw.label !== "string" || raw.label.length > CHAT_LABEL_MAX)) refuse(path, "label is malformed");
  if (!epochMs(raw.admittedAt) || (raw.expiresAt as number) <= raw.admittedAt || (raw.expiresAt as number) - raw.admittedAt > CHAT_SESSION_MAX_TTL_MS)
    refuse(path, "admittedAt/expiresAt do not form a bounded session (<= 8 h)");
  try { parseChatParentPin(raw.parentPin, "parentPin"); } catch (e) { refuse(path, (e as Error).message); }
  if (raw.state !== "pending" && raw.state !== "active" && raw.state !== "retired") refuse(path, `has unknown state ${String(raw.state)}`);
  if (raw.state === "retired") {
    if (!epochMs(raw.retiredAt) || typeof raw.retireOutcome !== "string" || !RETIRE_OUTCOMES.has(raw.retireOutcome))
      refuse(path, "is retired without retiredAt and a recorded outcome");
  } else if (raw.retiredAt !== undefined || raw.retireOutcome !== undefined) {
    refuse(path, `is ${raw.state} but carries retirement fields`);
  }
  const { ver: _ver, ...row } = raw;
  return { form: "row", row: row as unknown as ChatSessionRow };
}

/** The CLOSED reader. Fail-closed on every unreadable, unknown-version, unknown-
 *  field, symlinked or key-mismatched file. Undefined only for true absence. */
export function readChatSessionRow(dir: string, owner: string, actor: string): ChatSessionRecord | undefined {
  const path = chatRowPath(dir, owner, actor);
  if (!assertSessionsDirectory(dir)) return undefined;
  let present: boolean;
  try {
    lstatSync(path);
    present = true;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    present = false;
  }
  if (!present) return undefined;
  let raw: unknown;
  let fd: number | undefined;
  try {
    if (lstatSync(path).isSymbolicLink()) throw new Error("must be a regular non-symlink file");
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    if (!fstatSync(fd).isFile()) throw new Error("must be a regular non-symlink file");
    raw = JSON.parse(readFileSync(fd, "utf8"));
  } catch (e) {
    refuse(path, `is unreadable (${e instanceof Error ? e.message : String(e)})`);
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
  const rec = parseChatSessionRecord(raw, path);
  if (rec.row.owner !== owner || rec.row.actor !== actor)
    refuse(path, `names "${rec.row.owner}.${rec.row.actor}", not "${owner}.${actor}"`);
  return rec;
}

/** Reader isolation: is ANY entry present at this principal in the chat row space? A
 *  present-but-unreadable entry counts as present, so a corrupt chat row can never let the alias
 *  be read as an interactive or managed grant. */
export function chatSessionAliasPresent(dir: string, owner: string, actor: string): boolean {
  if (!CHAT_ACTOR.test(actor)) {
    // Non-chat aliases can never name a chat row file (the filename grammar requires the prefix).
    return false;
  }
  if (!assertSessionsDirectory(dir)) return false;
  try {
    lstatSync(chatRowPath(dir, owner, actor));
    return true;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw e;
  }
}

function serialize(rec: ChatSessionRow | ChatSessionTombstone): string {
  return JSON.stringify({ ver: CHAT_ROW_VER, ...rec }, null, 2);
}

/** a5: create the `pending` row, create-only. An existing file is returned for the caller's own
 *  identity comparison (a resumed admission at the same UID); it is never overwritten. */
export function createPendingChatSessionRow(dir: string, row: ChatSessionRow): { created: true } | { created: false; existing: ChatSessionRecord } {
  if (row.state !== "pending") throw new EpEnvelopeError("internal", "a chat-session row is born pending");
  const path = chatRowPath(dir, row.owner, row.actor);
  parseChatSessionRecord({ ver: CHAT_ROW_VER, ...row }, path);
  mkSecretDir(dir);
  mkSecretDir(sessionsDir(dir));
  try {
    writeSecretFileCreateOnly(path, serialize(row));
    return { created: true };
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
  }
  const existing = readChatSessionRow(dir, row.owner, row.actor);
  if (!existing) throw new EpEnvelopeError("internal", `${path}: create reported an existing row that a read cannot find`);
  return { created: false, existing };
}

const NEXT: Record<ChatSessionState, ReadonlySet<ChatSessionState>> = {
  pending: new Set(["active", "retired"]),
  active: new Set(["retired"]),
  retired: new Set(),
};

/**
 * Move a full row forward: `pending → active`, `pending → retired` or `active → retired`. Never
 * backwards. The caller names the UID it expects (so a write can never land on another
 * incarnation's row) and the state it observed. An already-retired row is returned unchanged (the
 * same-UID terminal is idempotent). Atomic whole-file replace, then read back.
 */
export function advanceChatSessionRow(
  dir: string,
  key: { owner: string; actor: string; lifecycleUid: string },
  to: { state: "active" } | { state: "retired"; retiredAt: number; retireOutcome: ChatRetireOutcome },
): ChatSessionRecord {
  const path = chatRowPath(dir, key.owner, key.actor);
  const current = readChatSessionRow(dir, key.owner, key.actor);
  if (!current) throw new EpEnvelopeError("failed-precondition", `${path}: no chat-session row to advance`);
  if (current.row.lifecycleUid !== key.lifecycleUid)
    throw new EpEnvelopeError("failed-precondition", `${path}: the row is at lifecycle ${current.row.lifecycleUid}, not ${key.lifecycleUid}`);
  if (current.row.state === "retired") {
    if (to.state === "retired") return current;
    throw new EpEnvelopeError("failed-precondition", `${path}: a retired chat session never becomes ${to.state}`);
  }
  if (current.form !== "row") throw new EpEnvelopeError("internal", `${path}: a non-retired tombstone is impossible`);
  if (!NEXT[current.row.state].has(to.state))
    throw new EpEnvelopeError("failed-precondition", `${path}: ${current.row.state} -> ${to.state} is not a chat-session transition`);
  const next: ChatSessionRow = to.state === "active"
    ? { ...current.row, state: "active" }
    : { ...current.row, state: "retired", retiredAt: to.retiredAt, retireOutcome: to.retireOutcome };
  replaceWhole(path, next);
  const back = readChatSessionRow(dir, key.owner, key.actor);
  if (!back || back.row.state !== to.state || back.row.lifecycleUid !== key.lifecycleUid)
    throw new EpEnvelopeError("unavailable", `${path}: the ${to.state} write did not read back (a concurrent writer moved the row); re-read and re-decide`);
  return back;
}

/** Retention: replace a RETIRED row's body with its permanent tombstone. The caller
 *  has already re-run the UID-exact deprovision. Idempotent on an existing tombstone. */
export function compactChatSessionRow(dir: string, key: { owner: string; actor: string; lifecycleUid: string }): ChatSessionTombstone {
  const path = chatRowPath(dir, key.owner, key.actor);
  const current = readChatSessionRow(dir, key.owner, key.actor);
  if (!current) throw new EpEnvelopeError("failed-precondition", `${path}: no chat-session row to compact`);
  if (current.row.lifecycleUid !== key.lifecycleUid)
    throw new EpEnvelopeError("failed-precondition", `${path}: the row is at lifecycle ${current.row.lifecycleUid}, not ${key.lifecycleUid}`);
  if (current.form === "tombstone") return current.row;
  if (current.row.state !== "retired" || current.row.retiredAt === undefined)
    throw new EpEnvelopeError("failed-precondition", `${path}: only a retired chat session is compacted`);
  const tomb: ChatSessionTombstone = {
    owner: current.row.owner, actor: current.row.actor, lifecycleUid: current.row.lifecycleUid,
    holderHash: current.row.holderHash, state: "retired", retiredAt: current.row.retiredAt, expiresAt: current.row.expiresAt,
  };
  replaceWhole(path, tomb);
  return tomb;
}

function replaceWhole(path: string, rec: ChatSessionRow | ChatSessionTombstone): void {
  const tmp = `${path}.${process.pid}.tmp`;
  writeSecretFile(tmp, serialize(rec));
  renameSync(tmp, path);
}

/**
 * Bounded, ordered discovery page for the sweep: file names strictly after `after`,
 * at most `limit`. The names are sorted so the cursor's `rowName` is a stable position. Only names
 * are returned; each row read is the caller's counted read.
 */
export function listChatSessionRowNames(dir: string, after: string, limit: number): string[] {
  if (!Number.isSafeInteger(limit) || limit < 1) throw new EpEnvelopeError("bad-request", "limit must be a positive integer");
  const d = assertSessionsDirectory(dir);
  if (!d) return [];
  return readdirSync(d)
    .filter((f) => f.endsWith(".json") && f > after)
    .sort()
    .slice(0, limit);
}

/** Parse a row filename back to its principal; anything else in the space refuses. */
export function parseChatSessionRowFilename(name: string): { owner: string; actor: string } {
  const m = /^(u_[a-z2-7]{26})\.(chat_[a-z2-7]{26})\.json$/.exec(name);
  if (!m) throw new EpEnvelopeError("failed-precondition", `${CHAT_SESSIONS_DIR}/${name} is not a chat-session row name`);
  return { owner: m[1], actor: m[2] };
}
