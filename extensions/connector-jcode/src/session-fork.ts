/**
 * Operator resume (`cotal spawn --resume <id>`) for Jcode: fork a session out of the operator's own
 * Jcode home into the seat's private home before the seat's Harness API instance starts.
 *
 * The Harness API has no fork call, so this mirrors Jcode's own split fork (`clone_split_session`):
 * a new session whose parent is the source, carrying the source's messages, compaction state, system
 * prompt and model. The fork is written as one snapshot with no journal, because a journal line
 * re-applies the source's metadata on load, its provider session id and working dir included. The
 * source files are only read, so the source transcript is never appended to.
 */
import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,199}$/;
const MARKER = "cotal-resume.json";
/** Reads of a session that keeps changing under the fork before it is refused as unstable. */
const STABLE_READ_ATTEMPTS = 5;

/** The seat's private Jcode home under `root` (the launch's COTAL_JCODE_HOME), keyed by space and
 *  name. host.ts claims it; buildLaunch reads it to see whether the seat already owns its fork. */
export function jcodeSeatHome(root: string, space: string, name: string): string {
  const slug = `${space}-${name}`.toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40);
  const key = createHash("sha256").update(`${space}\0${name}`).digest("hex").slice(0, 12);
  return join(root, ".cotal", "jcode", `${slug || "agent"}-${key}`);
}

export interface JcodeForkSource {
  sessionId: string;
  title?: string;
  /** sha256 over the source snapshot bytes followed by its journal bytes, as read. */
  transcriptSha256: string;
  messages: unknown[];
  compaction?: unknown;
  systemPrompt?: unknown;
  model?: unknown;
}

function code(error: unknown): string {
  return (error as NodeJS.ErrnoException).code ?? (error as Error).message;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
/** Jcode's StoredMessage requires a string id and role and an array of content blocks. */
const isStoredMessage = (value: unknown): boolean =>
  isRecord(value) && typeof value.id === "string" && typeof value.role === "string" && Array.isArray(value.content);
const isOptional = (value: unknown, kind: "string" | "object"): boolean =>
  value === undefined || value === null || (kind === "string" ? typeof value === "string" : isRecord(value));

function readOptional(path: string, refuse: (why: string) => never): Buffer | undefined {
  try {
    return readFileSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") refuse(`${path} could not be read (${code(error)})`);
    return undefined;
  }
}

/**
 * Read the named session from `sourceHome`, folding its journal the way Jcode's loader does. Every
 * failure is a named refusal, so `buildLaunch` can call this to refuse before anything launches.
 *
 * The source may be live. Jcode checkpoints by writing the folded snapshot and then unlinking the
 * journal, so two reads can straddle it and lose the journal's messages or count them twice. The
 * pair is therefore read until two consecutive reads agree and no journal message is already in
 * the snapshot, and refused as unstable when that does not happen.
 */
export function readJcodeForkSource(sourceHome: string, sessionId: string): JcodeForkSource {
  if (!SESSION_ID.test(sessionId) || sessionId.includes(".."))
    throw new Error(`jcode connector: cannot resume ${JSON.stringify(sessionId)}: not a Jcode session id`);
  const snapshotPath = join(sourceHome, "sessions", `${sessionId}.json`);
  const journalPath = join(sourceHome, "sessions", `${sessionId}.journal.jsonl`);
  const refuse = (why: string): never => {
    throw new Error(`jcode connector: cannot resume session ${sessionId}: ${why}`);
  };
  const readSnapshot = (): Buffer => {
    try {
      return readFileSync(snapshotPath);
    } catch (error) {
      return refuse(`no readable transcript at ${snapshotPath} (${code(error)})`);
    }
  };
  let previous: { snapshot: Buffer; journal?: Buffer } | undefined;
  for (let attempt = 0; attempt < STABLE_READ_ATTEMPTS; attempt++) {
    const read = { snapshot: readSnapshot(), journal: readOptional(journalPath, refuse) };
    const same = previous !== undefined && read.snapshot.equals(previous.snapshot) &&
      (read.journal === undefined ? previous.journal === undefined : previous.journal !== undefined && read.journal.equals(previous.journal));
    previous = read;
    if (!same) continue;
    const parsed = parseJcodeSource(sessionId, snapshotPath, journalPath, read.snapshot, read.journal, refuse);
    if (parsed) return parsed;
    previous = undefined;
  }
  return refuse(`${snapshotPath} kept changing while it was read, or its journal repeats messages the snapshot already holds (a Jcode checkpoint in progress); retry the resume`);
}

/** Parse one coherent snapshot + journal read, or undefined when the journal was already folded
 *  into the snapshot (a checkpoint caught before its journal unlink). */
function parseJcodeSource(
  sessionId: string,
  snapshotPath: string,
  journalPath: string,
  snapshot: Buffer,
  journal: Buffer | undefined,
  refuse: (why: string) => never,
): JcodeForkSource | undefined {
  let session: Record<string, unknown>;
  try {
    session = JSON.parse(snapshot.toString("utf8"));
  } catch (error) {
    return refuse(`${snapshotPath} is not valid JSON (${(error as Error).message})`);
  }
  if (!isRecord(session) || session.id !== sessionId || !Array.isArray(session.messages))
    refuse(`${snapshotPath} is not a Jcode session snapshot for that id`);
  // The fields the fork carries must be what Jcode's own serde accepts, or the seat would fail on
  // them after it launched instead of here.
  const checkFields = (where: string, fields: Record<string, unknown>) => {
    for (const key of ["title", "system_prompt", "model"])
      if (!isOptional(fields[key], "string")) refuse(`${where} has a non-string ${key}`);
    if (!isOptional(fields.compaction, "object")) refuse(`${where} has a compaction that is not an object`);
  };
  checkFields(snapshotPath, session);
  const messages = [...(session.messages as unknown[])];
  const badMessage = messages.findIndex((message) => !isStoredMessage(message));
  if (badMessage >= 0) refuse(`message ${badMessage + 1} of ${snapshotPath} is not a Jcode message`);
  const seen = new Set(messages.map((message) => (message as { id: string }).id));
  // Jcode's apply_journal_entry: each line replaces the metadata wholesale and appends its messages.
  // Only the fields the fork carries are folded.
  const lines = journal ? journal.toString("utf8").split("\n").filter((line) => line.trim()) : [];
  for (const [index, line] of lines.entries()) {
    const where = `line ${index + 1} of ${journalPath}`;
    let entry: { meta?: Record<string, unknown>; append_messages?: unknown };
    try {
      entry = JSON.parse(line);
    } catch (error) {
      return refuse(`${where} is not valid JSON (${(error as Error).message})`);
    }
    if (!isRecord(entry) || !isRecord(entry.meta)) return refuse(`${where} has no metadata`);
    checkFields(where, entry.meta);
    const appended = entry.append_messages ?? [];
    if (!Array.isArray(appended) || !appended.every(isStoredMessage)) refuse(`${where} has append_messages that are not Jcode messages`);
    for (const message of appended as { id: string }[]) {
      if (seen.has(message.id)) return undefined;
      seen.add(message.id);
    }
    for (const key of ["title", "system_prompt", "compaction", "model"]) session[key] = entry.meta[key] ?? null;
    messages.push(...(appended as unknown[]));
  }
  const hash = createHash("sha256").update(snapshot);
  if (journal) hash.update(journal);
  return {
    sessionId,
    ...(typeof session.title === "string" ? { title: session.title } : {}),
    transcriptSha256: hash.digest("hex"),
    messages,
    compaction: session.compaction ?? undefined,
    systemPrompt: session.system_prompt ?? undefined,
    model: session.model ?? undefined,
  };
}

export interface JcodeFork {
  forkId: string;
  /** False when this seat home already holds the fork of the same source from an earlier launch. */
  created: boolean;
  /** Whether a launch has appended the seat's briefing to the fork. A first launch that failed
   *  before its briefing leaves this false, so the retry still briefs the seat. */
  briefed: boolean;
}

export interface ForkMarker {
  source: string;
  fork: string;
  title?: string;
  transcriptSha256: string;
  briefed: boolean;
}

/** Publish the marker by rename, so a write cut short never leaves partial JSON behind. */
function writeMarker(seatHome: string, marker: ForkMarker): void {
  const path = join(seatHome, MARKER);
  const tmp = `${path}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  writeFileSync(tmp, JSON.stringify(marker), { mode: 0o600, flag: "wx" });
  renameSync(tmp, path);
}

/** The seat's fork of `sessionId` when it already owns one, else undefined. A marker that names
 *  another source, or that cannot be parsed, is a named refusal rather than a silent re-fork. */
export function ownedJcodeFork(seatHome: string, sessionId: string): ForkMarker | undefined {
  const markerPath = join(seatHome, MARKER);
  let raw: string;
  try {
    raw = readFileSync(markerPath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw new Error(`jcode connector: ${markerPath} could not be read (${code(error)})`);
  }
  let marker: Partial<ForkMarker>;
  try {
    marker = JSON.parse(raw);
  } catch (error) {
    throw new Error(`jcode connector: ${markerPath} is not valid JSON (${(error as Error).message}); remove it to fork session ${sessionId} again`);
  }
  if (marker.source !== sessionId || typeof marker.fork !== "string" || !SESSION_ID.test(marker.fork) ||
      !existsSync(join(seatHome, "sessions", `${marker.fork}.json`)))
    return undefined;
  return { source: marker.source, fork: marker.fork, ...(typeof marker.title === "string" ? { title: marker.title } : {}),
    transcriptSha256: String(marker.transcriptSha256 ?? ""), briefed: marker.briefed === true };
}

/** Record that the seat's briefing is now in its fork, so a later relaunch does not repeat it. */
export function markJcodeForkBriefed(seatHome: string, sessionId: string): void {
  const marker = ownedJcodeFork(seatHome, sessionId);
  if (!marker) throw new Error(`jcode connector: the seat's fork of ${sessionId} is gone from ${seatHome}`);
  if (!marker.briefed) writeMarker(seatHome, { ...marker, briefed: true });
}

/**
 * Give the seat its fork of `sessionId`. A seat home that already forked the same source keeps that
 * fork, the same way a restarted seat continues its own session rather than starting over (#789).
 */
export function forkJcodeSession(opts: { sourceHome: string; sessionId: string; seatHome: string; cwd: string }): JcodeFork {
  const sessions = join(opts.seatHome, "sessions");
  const owned = ownedJcodeFork(opts.seatHome, opts.sessionId);
  if (owned) return { forkId: owned.fork, created: false, briefed: owned.briefed };
  const source = readJcodeForkSource(opts.sourceHome, opts.sessionId);
  const now = new Date().toISOString();
  const word = /^session_([^_]+)_/.exec(opts.sessionId)?.[1] ?? "fork";
  const forkId = `session_${word}_${Date.now()}_${randomBytes(8).toString("hex")}`;
  const fork = {
    id: forkId,
    parent_id: opts.sessionId,
    title: null,
    created_at: now,
    updated_at: now,
    messages: source.messages,
    ...(source.systemPrompt !== undefined ? { system_prompt: source.systemPrompt } : {}),
    ...(source.compaction !== undefined ? { compaction: source.compaction } : {}),
    ...(source.model !== undefined ? { model: source.model } : {}),
    working_dir: opts.cwd,
    status: "Closed",
  };
  mkdirSync(sessions, { recursive: true, mode: 0o700 });
  const target = join(sessions, `${forkId}.json`);
  writeFileSync(`${target}.tmp`, JSON.stringify(fork), { mode: 0o600, flag: "wx" });
  renameSync(`${target}.tmp`, target);
  writeMarker(opts.seatHome, {
    source: opts.sessionId,
    fork: forkId,
    ...(source.title !== undefined ? { title: source.title } : {}),
    transcriptSha256: source.transcriptSha256,
    briefed: false,
  });
  return { forkId, created: true, briefed: false };
}
