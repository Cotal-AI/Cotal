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

/** The seat's record of its fork (source, fork, title, transcript hash), which the manager reads
 *  as the fork's provenance. */
export function jcodeForkRecordPath(seatHome: string): string {
  return join(seatHome, MARKER);
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

/** `JSON.rawJSON`, from the JSON.parse source text access proposal that Node ships from 21 on.
 *  TypeScript's lib does not declare it yet. */
const RawJSON = JSON as JSON & {
  rawJSON(text: string): { readonly rawJSON: string };
  isRawJSON(value: unknown): value is { readonly rawJSON: string };
};
/** Parse a Jcode transcript without losing an integer a double cannot hold. Jcode's counts are
 *  u64, so a valid count can be above 2^53: it is kept as its source text, which `JSON.stringify`
 *  writes back unchanged into the fork. */
function parseTranscript(text: string): unknown {
  return JSON.parse(text, (_key, value: unknown, context?: { source?: string }) =>
    typeof value === "number" && !Number.isSafeInteger(value) && context?.source !== undefined && /^-?\d+$/.test(context.source)
      ? RawJSON.rawJSON(context.source)
      : value);
}

const U64_MAX = 2n ** 64n - 1n;
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value) && !RawJSON.isRawJSON(value);
const isString = (value: unknown): value is string => typeof value === "string";
/** A u64, Jcode's type for every count the fork carries (its usize counts are u64 on the 64-bit
 *  targets it ships for). */
const isCount = (value: unknown): boolean => RawJSON.isRawJSON(value)
  ? /^\d+$/.test(value.rawJSON) && BigInt(value.rawJSON) <= U64_MAX
  : Number.isInteger(value) && (value as number) >= 0;
const optional = (value: unknown, check: (value: unknown) => boolean): boolean =>
  value === undefined || value === null || check(value);

const RFC3339 = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d{1,9}))?(Z|[+-]\d{2}:\d{2})$/;
/** A chrono `DateTime<Utc>` as Jcode writes it, as [whole seconds in epoch ms, nanoseconds], so two
 *  times compare at the nanosecond Jcode records rather than the millisecond a Date keeps. */
function instant(value: unknown): [number, number] | undefined {
  const match = isString(value) ? RFC3339.exec(value) : null;
  const seconds = match ? Date.parse(`${match[1]}${match[3]}`) : NaN;
  return Number.isNaN(seconds) ? undefined : [seconds, Number((match![2] ?? "").padEnd(9, "0"))];
}
const notAfter = (a: [number, number], b: [number, number]): boolean => a[0] < b[0] || (a[0] === b[0] && a[1] <= b[1]);

/** Jcode's ContentBlock variants (serde tag `type`, snake_case) and the fields each one requires. */
const CONTENT_BLOCKS: Record<string, (block: Record<string, unknown>) => boolean> = {
  text: (b) => isString(b.text) && optional(b.cache_control, (c) => isRecord(c) && isString(c.type) && optional(c.ttl, isString)),
  reasoning: (b) => isString(b.text),
  reasoning_trace: (b) => isString(b.text),
  anthropic_thinking: (b) => isString(b.thinking) && isString(b.signature),
  open_a_i_reasoning: (b) => isString(b.id) && Array.isArray(b.summary) && b.summary.every(isString) &&
    optional(b.encrypted_content, isString) && optional(b.status, isString),
  tool_use: (b) => isString(b.id) && isString(b.name) && "input" in b && optional(b.thought_signature, isString),
  tool_result: (b) => isString(b.tool_use_id) && isString(b.content) && optional(b.is_error, (v) => typeof v === "boolean"),
  image: (b) => isString(b.media_type) && isString(b.data),
  open_a_i_compaction: (b) => isString(b.encrypted_content),
  tool_reference: (b) => isString(b.tool_use_id) && isString(b.tool_name),
  provider_native: (b) => isString(b.provider) && "item" in b,
};
const isTokenUsage = (u: unknown): boolean => isRecord(u) && isCount(u.input_tokens) && isCount(u.output_tokens) &&
  ["prompt_tokens", "cache_read_input_tokens", "cache_creation_input_tokens"].every((key) => optional(u[key], isCount));
/** Jcode's StoredCompactionState. */
const isCompaction = (value: unknown): boolean => isRecord(value) && isString(value.summary_text) &&
  optional(value.openai_encrypted_content, isString) && isCount(value.covers_up_to_turn) &&
  isCount(value.original_turn_count) && isCount(value.compacted_count);

/** Why `value` is not a StoredMessage Jcode can load, or undefined when it is one. */
function messageFault(value: unknown): string | undefined {
  if (!isRecord(value)) return "is not an object";
  if (!isString(value.id)) return "has no string id";
  if (value.role !== "user" && value.role !== "assistant") return `has role ${JSON.stringify(value.role)}, not user or assistant`;
  if (!Array.isArray(value.content)) return "has content that is not an array";
  for (const [index, block] of value.content.entries()) {
    const type = isRecord(block) ? block.type : undefined;
    if (!isString(type) || !Object.hasOwn(CONTENT_BLOCKS, type) || !CONTENT_BLOCKS[type]!(block as Record<string, unknown>))
      return `has a content block ${index + 1} that is not a Jcode ${isString(type) ? `${JSON.stringify(type)} block` : "content block"}`;
  }
  if (!optional(value.display_role, (v) => v === "system" || v === "background_task")) return "has an unknown display_role";
  if (!optional(value.timestamp, (v) => instant(v) !== undefined)) return "has a timestamp that is not an RFC 3339 time";
  if (!optional(value.tool_duration_ms, isCount)) return "has a tool_duration_ms that is not a count";
  if (!optional(value.token_usage, isTokenUsage)) return "has a token_usage Jcode cannot read";
  return undefined;
}

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
 * journal, so two reads can straddle it and lose the journal's messages or count them twice, and a
 * pair read between the two steps holds a journal the snapshot already folded. Every Jcode save
 * stamps `updated_at`, so such a journal is one whose lines are no newer than the snapshot. The pair
 * is therefore read until two consecutive reads agree and every journal line is newer than the
 * snapshot and adds no message it already holds, and refused as unstable when that does not happen.
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
  return refuse(`${snapshotPath} kept changing while it was read, or its journal predates the snapshot (a Jcode checkpoint in progress); retry the resume`);
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
    session = parseTranscript(snapshot.toString("utf8")) as Record<string, unknown>;
  } catch (error) {
    return refuse(`${snapshotPath} is not valid JSON (${(error as Error).message})`);
  }
  if (!isRecord(session) || session.id !== sessionId || !Array.isArray(session.messages))
    refuse(`${snapshotPath} is not a Jcode session snapshot for that id`);
  // The fields the fork carries must be what Jcode's own serde accepts, or the seat would fail on
  // them after it launched instead of here.
  const checkFields = (where: string, fields: Record<string, unknown>): [number, number] => {
    for (const key of ["title", "system_prompt", "model"])
      if (!optional(fields[key], isString)) refuse(`${where} has a non-string ${key}`);
    if (!optional(fields.compaction, isCompaction)) refuse(`${where} has a compaction Jcode cannot read`);
    return instant(fields.updated_at) ?? refuse(`${where} has no updated_at Jcode can read`);
  };
  const checkMessages = (where: string, list: unknown[]) => {
    for (const [index, message] of list.entries()) {
      const fault = messageFault(message);
      if (fault) refuse(`message ${index + 1} of ${where} ${fault}`);
    }
  };
  const snapshotAt = checkFields(snapshotPath, session);
  const messages = [...(session.messages as unknown[])];
  checkMessages(snapshotPath, messages);
  const seen = new Set(messages.map((message) => (message as { id: string }).id));
  // Jcode's apply_journal_entry: each line replaces the metadata wholesale and appends its messages.
  // Only the fields the fork carries are folded.
  const lines = journal ? journal.toString("utf8").split("\n").filter((line) => line.trim()) : [];
  for (const [index, line] of lines.entries()) {
    const where = `line ${index + 1} of ${journalPath}`;
    let entry: { meta?: Record<string, unknown>; append_messages?: unknown };
    try {
      entry = parseTranscript(line) as typeof entry;
    } catch (error) {
      return refuse(`${where} is not valid JSON (${(error as Error).message})`);
    }
    if (!isRecord(entry) || !isRecord(entry.meta)) return refuse(`${where} has no metadata`);
    // A line no newer than the snapshot was written before it, so the snapshot already folded it.
    if (notAfter(checkFields(where, entry.meta), snapshotAt)) return undefined;
    const appended = entry.append_messages ?? [];
    if (!Array.isArray(appended)) return refuse(`${where} has append_messages that are not a list`);
    checkMessages(`append_messages on ${where}`, appended);
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
  title?: string;
  transcriptSha256: string;
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
  if (!isRecord(marker)) throw new Error(`jcode connector: ${markerPath} is not a fork record; remove it to fork session ${sessionId} again`);
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
  if (owned)
    return { forkId: owned.fork, ...(owned.title !== undefined ? { title: owned.title } : {}), transcriptSha256: owned.transcriptSha256, created: false, briefed: owned.briefed };
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
  return { forkId, ...(source.title !== undefined ? { title: source.title } : {}), transcriptSha256: source.transcriptSha256, created: true, briefed: false };
}
