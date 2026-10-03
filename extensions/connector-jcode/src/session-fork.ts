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

/**
 * Read the named session from `sourceHome`, folding its journal the way Jcode's loader does. Every
 * failure is a named refusal, so `buildLaunch` can call this to refuse before anything launches.
 */
export function readJcodeForkSource(sourceHome: string, sessionId: string): JcodeForkSource {
  if (!SESSION_ID.test(sessionId) || sessionId.includes(".."))
    throw new Error(`jcode connector: cannot resume ${JSON.stringify(sessionId)}: not a Jcode session id`);
  const snapshotPath = join(sourceHome, "sessions", `${sessionId}.json`);
  const journalPath = join(sourceHome, "sessions", `${sessionId}.journal.jsonl`);
  const refuse = (why: string): never => {
    throw new Error(`jcode connector: cannot resume session ${sessionId}: ${why}`);
  };
  let snapshot: Buffer;
  try {
    snapshot = readFileSync(snapshotPath);
  } catch (error) {
    return refuse(`no readable transcript at ${snapshotPath} (${code(error)})`);
  }
  let journal: Buffer | undefined;
  try {
    journal = readFileSync(journalPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") refuse(`its journal ${journalPath} could not be read (${code(error)})`);
  }
  let session: Record<string, unknown>;
  try {
    session = JSON.parse(snapshot.toString("utf8"));
  } catch (error) {
    return refuse(`${snapshotPath} is not valid JSON (${(error as Error).message})`);
  }
  if (!session || typeof session !== "object" || session.id !== sessionId || !Array.isArray(session.messages))
    refuse(`${snapshotPath} is not a Jcode session snapshot for that id`);
  const messages = [...(session.messages as unknown[])];
  // Jcode's apply_journal_entry: each line replaces the metadata wholesale and appends its messages.
  // Only the fields the fork carries are folded.
  const lines = journal ? journal.toString("utf8").split("\n").filter((line) => line.trim()) : [];
  for (const [index, line] of lines.entries()) {
    let entry: { meta?: Record<string, unknown>; append_messages?: unknown };
    try {
      entry = JSON.parse(line);
    } catch (error) {
      return refuse(`line ${index + 1} of ${journalPath} is not valid JSON (${(error as Error).message})`);
    }
    if (!entry?.meta || typeof entry.meta !== "object") refuse(`line ${index + 1} of ${journalPath} has no metadata`);
    for (const key of ["title", "system_prompt", "compaction", "model"]) session[key] = entry.meta![key] ?? null;
    if (Array.isArray(entry.append_messages)) messages.push(...entry.append_messages);
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
}

/**
 * Give the seat its fork of `sessionId`. A seat home that already forked the same source keeps that
 * fork, the same way a restarted seat continues its own session rather than starting over (#789).
 */
export function forkJcodeSession(opts: { sourceHome: string; sessionId: string; seatHome: string; cwd: string }): JcodeFork {
  const sessions = join(opts.seatHome, "sessions");
  const markerPath = join(opts.seatHome, MARKER);
  try {
    const marker = JSON.parse(readFileSync(markerPath, "utf8")) as { source?: unknown; fork?: unknown };
    if (marker.source === opts.sessionId && typeof marker.fork === "string" && SESSION_ID.test(marker.fork) &&
        existsSync(join(sessions, `${marker.fork}.json`)))
      return { forkId: marker.fork, created: false };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
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
  writeFileSync(markerPath, JSON.stringify({ source: opts.sessionId, fork: forkId, transcriptSha256: source.transcriptSha256 }), { mode: 0o600 });
  return { forkId, created: true };
}
