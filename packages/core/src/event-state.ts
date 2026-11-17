import { createHash } from "node:crypto";
import { constants, type Dirent } from "node:fs";
import { lstat, open, readdir } from "node:fs/promises";
import { dirname, join, relative, sep } from "node:path";
import { eventChannel } from "./event-channel.js";
import { ensureDirNoSymlink } from "./fs-safe.js";
import { principalKey } from "./subjects.js";

/** The acknowledged subject record shared by all threads of a principal. */
export interface EventSubjectRecord {
  v: number;
  space: string;
  principal: string;
  tip: number;
}

/** Version written by frontier owners and accepted by the shared reader. */
export const EVENT_SUBJECT_RECORD_VERSION = 1;

/** A local acknowledged record cannot be safely interpreted. */
export class SubjectFrontierCorruptError extends Error {
  constructor(readonly path: string, readonly invariant: string, detail: string) {
    super(`subject frontier ${path}: expected ${invariant} — ${detail}`);
    this.name = "SubjectFrontierCorruptError";
  }
}

/** The selected state cannot safely start a transcript under this principal. */
export class EventStateConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EventStateConflictError";
  }
}

/** Compute the principal's shared event-state paths without touching disk. */
export function eventPrincipalLocation(opts: {
  workspaceRoot: string;
  space: string;
  principal: string;
}): { principalDir: string; lockPath: string; subjectPath: string } {
  const h = (value: string) => createHash("sha256").update(value).digest("hex").slice(0, 16);
  const principalDir = join(opts.workspaceRoot, ".cotal", "events", h(opts.space), h(opts.principal));
  return { principalDir, lockPath: join(principalDir, ".lock"), subjectPath: join(principalDir, "subject.json") };
}

const isSafeNonNegInt = (n: unknown): n is number => typeof n === "number" && Number.isSafeInteger(n) && n >= 0;

/**
 * Read without following the record's final component. Absence is distinct from an explicit zero.
 * The caller validates the parent chain. O_NOFOLLOW narrows final-component replacement races
 * where supported; lstat supplies the portable symlink refusal.
 */
export async function readEventSubjectRecord(path: string, opts: { space: string; principal: string }): Promise<EventSubjectRecord | undefined> {
  let st;
  try {
    st = await lstat(path);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw e;
  }
  if (st.isSymbolicLink())
    throw new SubjectFrontierCorruptError(path, "a real subject record, never a symlink", "the writer never wrote a symlink");
  let bytes: Buffer;
  try {
    const fh = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    try {
      bytes = await fh.readFile();
    } finally {
      await fh.close();
    }
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return undefined;
    if (code === "ELOOP")
      throw new SubjectFrontierCorruptError(path, "a real subject record, never a symlink", "the record became a symlink between the check and the open");
    throw e;
  }
  let raw: string;
  try {
    raw = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new SubjectFrontierCorruptError(path, "valid UTF-8", "invalid UTF-8 bytes; refusing rather than substituting U+FFFD");
  }
  if (raw.length === 0)
    throw new SubjectFrontierCorruptError(path, "a non-empty file", "the file is zero bytes — distinct from missing, and never treated as virgin");
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    throw new SubjectFrontierCorruptError(path, "parseable JSON", (e as Error).message);
  }
  const d = parsed as Partial<EventSubjectRecord>;
  if (d?.v !== EVENT_SUBJECT_RECORD_VERSION) throw new SubjectFrontierCorruptError(path, `v === ${EVENT_SUBJECT_RECORD_VERSION}`, String(d?.v));
  if (d.space !== opts.space) throw new SubjectFrontierCorruptError(path, "space matches", `file=${String(d.space)} caller=${opts.space}`);
  if (d.principal !== opts.principal)
    throw new SubjectFrontierCorruptError(path, "principal matches", `file=${String(d.principal)} caller=${opts.principal}`);
  if (!isSafeNonNegInt(d.tip) || d.tip >= Number.MAX_SAFE_INTEGER)
    throw new SubjectFrontierCorruptError(path, "tip is a safe non-negative integer below Number.MAX_SAFE_INTEGER", String(d.tip));
  return { v: d.v, space: d.space, principal: d.principal, tip: d.tip };
}

/**
 * Recover only observed acknowledgements from sibling thread records, without writing a record.
 * Call only when the subject record is absent. An explicit zero records abandonment and must not
 * be reseeded. Unreadable or foreign records refuse rather than silently undercounting the tip.
 */
export async function recoverEventSubjectTip(principalDir: string, principal: string): Promise<number> {
  let entries: Dirent[];
  try {
    entries = await readdir(principalDir, { withFileTypes: true });
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return 0;
    throw e;
  }
  let best = 0;
  for (const ent of entries) {
    if (ent.isSymbolicLink())
      throw new SubjectFrontierCorruptError(join(principalDir, ent.name), "a real directory beside the record, never a symlink", "following it would carry this scan outside the principal directory, and the writer that creates these directories refuses a symlinked component for the same reason");
    if (!ent.isDirectory()) continue;
    const walPath = join(principalDir, ent.name, "wal.json");
    // Check both the directory and record. O_NOFOLLOW protects only the final component, not a
    // directory swapped after readdir. This preserves the existing non-atomic parent-chain guard.
    let st;
    try {
      st = await lstat(walPath);
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (code === "ENOENT" || code === "ENOTDIR") continue;
      throw e;
    }
    if (st.isSymbolicLink())
      throw new SubjectFrontierCorruptError(walPath, "a real thread log, never a symlink", "following it would read a log this principal's writer never wrote");
    if (st.nlink > 1)
      throw new SubjectFrontierCorruptError(walPath, "a thread log with exactly one name", `it has ${st.nlink}, so the same file is reachable from outside this principal's directory and its tip is not this principal's to read`);
    let raw: Buffer;
    try {
      const fh = await open(walPath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
      try {
        raw = await fh.readFile();
      } finally {
        await fh.close();
      }
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (code === "ENOENT" || code === "ENOTDIR") continue;
      if (code === "ELOOP")
        throw new SubjectFrontierCorruptError(walPath, "a real thread log, never a symlink", "the file became a symlink between the check and the open");
      throw e;
    }
    let doc: { principal?: unknown; frontier?: { lastSubjectSeq?: unknown }; pending?: { state?: unknown; ackSeq?: unknown } | null };
    try {
      doc = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(raw)) as typeof doc;
    } catch (e) {
      throw new SubjectFrontierCorruptError(walPath, "a readable thread log while recovering the subject tip", (e as Error).message);
    }
    if (doc.principal !== principal)
      throw new SubjectFrontierCorruptError(walPath, `a thread log for principal ${principal}`, `found ${String(doc.principal)}`);
    const seq = doc.frontier?.lastSubjectSeq;
    if (!isSafeNonNegInt(seq))
      throw new SubjectFrontierCorruptError(walPath, "frontier.lastSubjectSeq is a safe non-negative integer", String(seq));
    if (seq > best) best = seq;
    // An acked pending can be ahead of the persisted frontier after a crash. A sent_unacked
    // record has no observed assignment: never guess, even when that leaves a later CAS refusal.
    const pending = doc.pending;
    if (pending && pending.state === "acked") {
      const acked = pending.ackSeq;
      if (!isSafeNonNegInt(acked))
        throw new SubjectFrontierCorruptError(walPath, "an acked pending carries a safe non-negative ackSeq", String(acked));
      if (!(acked > seq))
        throw new SubjectFrontierCorruptError(walPath, "an acked pending is ahead of the frontier it will fold into", `ackSeq=${acked} frontier.lastSubjectSeq=${seq}`);
      if (acked > best) best = acked;
    }
  }
  return best;
}

/** Inspect acknowledged state without locking or persisting recovery. Explicit zero never recovers. */
export async function recordedEventTip(path: string, opts: { space: string; principal: string }): Promise<number> {
  const record = await readEventSubjectRecord(path, opts);
  return record === undefined ? recoverEventSubjectTip(dirname(path), opts.principal) : record.tip;
}

/** Check startup compatibility with counts, never message bodies or a guessed append tip. */
export async function checkEventStartup(opts: {
  workspaceRoot: string;
  space: string;
  principal: { owner: string; actor: string };
  retainedMessages: () => Promise<readonly { channel: string; sender: string; messages: number }[]>;
}): Promise<void> {
  const principal = principalKey(opts.principal.owner, opts.principal.actor).key;
  const loc = eventPrincipalLocation({ ...opts, principal });
  // Preserve the existing connector's parent-chain check. Record inspection itself never writes.
  ensureDirNoSymlink(opts.workspaceRoot, ...relative(opts.workspaceRoot, loc.principalDir).split(sep));
  if (await recordedEventTip(loc.subjectPath, { space: opts.space, principal }) !== 0) return;
  const rows = await opts.retainedMessages();
  if (rows.some((row) => row.sender === principal && row.channel === eventChannel(opts.principal) && row.messages > 0)) {
    throw new EventStateConflictError(
      `Cannot start events for ${principal}: this state root has no acknowledged transcript frontier, ` +
      `but the broker retains events for this principal. Reuse the previous state root or launch with a new principal. ` +
      `Refusing before work; the existing transcript and local logs are unchanged.`,
    );
  }
}
