/**
 * The connector's bounded result journal for SPEC §13.19.
 *
 * This is NOT a public event log, and it is not the consent or revocation record family: those
 * live in the space auth store and are the host's. This holds only what a consented holder may
 * later look up, for as long as §13.19 lets it, and answers the closed `tool-result` states.
 *
 * Two rules here are the ones that leak if they are written loosely, so they are enforced in the
 * types rather than left to a caller:
 *
 * 1. **A RESULT never creates an entry** (§13.19.2). Only a START does. A result that arrives for
 *    an unknown call is dropped and said so, because an entry minted by a RESULT would carry no
 *    frontier decision and therefore no eligible consent set — it would be a result nobody
 *    established a right to read, sitting in a store whose whole purpose is that right.
 * 2. **The eligible consent set is fixed at START and may never grow** (§13.19.3). `start` takes
 *    it once; nothing else writes it. Growth is the shape of the bug where a consent granted
 *    after a result was captured reaches back and reads it, which §13.19.3 forbids in the same
 *    sentence that forbids a newly consented holder reading before its own frontier.
 *
 * Revocation runs the other way and is allowed to shrink any set, including to nothing, at which
 * point the entry is deleted rather than kept unreadable: a retained entry whose audience is empty
 * is bytes nobody can read, so holding them is cost without purpose.
 *
 * The frontier itself (§13.19.2's durable position `P`) is decided before `start` is called and is
 * not this type's business; it arrives already resolved as the consent ids the caller computed as
 * eligible. Keeping placement out of here is deliberate — it is the emitter's position algebra,
 * and mixing it with storage is how a position comparison ends up being made against wall-clock
 * capture time, which §13.19.2 explicitly forbids.
 */
import {
  TOOL_RESULT_MAX_CONTENT_BYTES,
  TOOL_RESULT_MAX_ENTRIES,
  TOOL_RESULT_MAX_RETENTION_MS,
  type ToolResultAnswer,
} from "@cotal-ai/core";

export interface ToolResultJournalOptions {
  /** Injectable clock. Retention is the only time input; capture order never decides eligibility. */
  now?: () => number;
  maxEntries?: number;
  maxContentBytes?: number;
  retentionMs?: number;
}

export interface ToolResultStart {
  threadId: string;
  toolCallId: string;
  /** The fixed eligible set, decided at START against the frontier. Empty means nobody, so no entry. */
  consentIds: readonly string[];
}

export interface ToolResultCapture {
  threadId: string;
  toolCallId: string;
  content: string;
  error: boolean;
}

/** Why a capture did not land. `no-entry` is the §13.19.2 refusal, not an error condition. */
export type ToolResultCaptureOutcome = "captured" | "no-entry" | "already-captured";

interface Entry {
  threadId: string;
  toolCallId: string;
  consentIds: Set<string>;
  startedAt: number;
  result?: { content: string; truncated: boolean; byteCount: number; error: boolean; capturedAt: number };
}

const key = (threadId: string, toolCallId: string): string => `${threadId}\u0000${toolCallId}`;

/**
 * Cut `content` to at most `max` BYTES without splitting a character.
 *
 * Byte-exact truncation matters because the limit is a byte limit, and a naive `slice` on the
 * string cuts code units, which can both overshoot the byte budget and split an astral character
 * into lone surrogates. Walking back off UTF-8 continuation bytes (`10xxxxxx`) lands the cut on a
 * lead byte, so the decoded prefix is always well-formed. `byteCount` reports the FULL size, not
 * the kept size: a reader needs to know how much there was to know what truncation cost.
 */
function cutToBytes(content: string, max: number): { kept: string; truncated: boolean; byteCount: number } {
  const bytes = new TextEncoder().encode(content);
  if (bytes.length <= max) return { kept: content, truncated: false, byteCount: bytes.length };
  let cut = max;
  while (cut > 0 && (bytes[cut]! & 0xc0) === 0x80) cut--;
  return { kept: new TextDecoder().decode(bytes.subarray(0, cut)), truncated: true, byteCount: bytes.length };
}

export class ToolResultJournal {
  readonly #entries = new Map<string, Entry>();
  readonly #now: () => number;
  readonly #maxEntries: number;
  readonly #maxContentBytes: number;
  readonly #retentionMs: number;

  constructor(options: ToolResultJournalOptions = {}) {
    this.#now = options.now ?? Date.now;
    this.#maxEntries = options.maxEntries ?? TOOL_RESULT_MAX_ENTRIES;
    this.#maxContentBytes = options.maxContentBytes ?? TOOL_RESULT_MAX_CONTENT_BYTES;
    this.#retentionMs = options.retentionMs ?? TOOL_RESULT_MAX_RETENTION_MS;
  }

  /** Entries currently held, after dropping anything past retention. Bounded by `maxEntries`. */
  size(): number {
    this.#purge();
    return this.#entries.size;
  }

  /**
   * Open an entry for a call the frontier admitted. A second START for the same call does NOT
   * reopen or re-audience it: the set is fixed at the first one, and a repeat is the connector
   * saying the same thing twice rather than a new decision.
   */
  start(o: ToolResultStart): boolean {
    this.#purge();
    const ids = new Set(o.consentIds);
    // An empty eligible set is the deleted state (§13.19.3), so it is never the created state.
    if (ids.size === 0) return false;
    const k = key(o.threadId, o.toolCallId);
    if (this.#entries.has(k)) return false;
    this.#entries.set(k, { threadId: o.threadId, toolCallId: o.toolCallId, consentIds: ids, startedAt: this.#now() });
    // Oldest-first eviction. Map preserves insertion order, and entries are inserted at START, so
    // the first key is the oldest START. Bounding by START rather than by capture keeps a long-
    // running call from being evicted by younger calls that finished before it.
    while (this.#entries.size > this.#maxEntries) {
      const oldest = this.#entries.keys().next();
      if (oldest.done === true) break;
      this.#entries.delete(oldest.value);
    }
    return true;
  }

  /** Record the result of a started call. Never creates an entry (§13.19.2). */
  capture(o: ToolResultCapture): ToolResultCaptureOutcome {
    this.#purge();
    const entry = this.#entries.get(key(o.threadId, o.toolCallId));
    if (entry === undefined) return "no-entry";
    if (entry.result !== undefined) return "already-captured";
    const { kept, truncated, byteCount } = cutToBytes(o.content, this.#maxContentBytes);
    entry.result = { content: kept, truncated, byteCount, error: o.error, capturedAt: this.#now() };
    return "captured";
  }

  /**
   * Drop `consentId` from every entry, deleting any entry it empties. Answers how many entries
   * were deleted, which is what a caller reports; the count of entries merely narrowed is not
   * interesting, because narrowing changes no reader's answer except that holder's.
   */
  revoke(consentId: string): number {
    let deleted = 0;
    for (const [k, entry] of this.#entries) {
      if (!entry.consentIds.delete(consentId)) continue;
      if (entry.consentIds.size === 0) {
        this.#entries.delete(k);
        deleted++;
      }
    }
    return deleted;
  }

  /**
   * Answer a lookup for a holder presenting `consentIds`, which the caller has already checked are
   * active, unexpired and unrevoked for that holder — this type does not know holders and must not
   * guess at one. Eligibility is set intersection and nothing else.
   *
   * `not-shared` and `missing` are deliberately distinct: `missing` says no such call was recorded,
   * `not-shared` says it was and this holder is not in its audience. Collapsing them would be
   * friendlier to a caller and would also tell an unconsented reader which tool calls exist.
   */
  read(o: { threadId: string; toolCallId: string; consentIds: readonly string[] }): ToolResultAnswer {
    const k = key(o.threadId, o.toolCallId);
    const entry = this.#entries.get(k);
    if (entry === undefined) return { state: "missing" };
    if (this.#expired(entry)) {
      this.#entries.delete(k);
      return { state: "expired" };
    }
    if (!o.consentIds.some((id) => entry.consentIds.has(id))) return { state: "not-shared" };
    const result = entry.result;
    if (result === undefined) return { state: "pending", threadId: entry.threadId, toolCallId: entry.toolCallId };
    return {
      state: "available",
      threadId: entry.threadId,
      toolCallId: entry.toolCallId,
      content: result.content,
      truncated: result.truncated,
      byteCount: result.byteCount,
      error: result.error,
      capturedAt: result.capturedAt,
    };
  }

  /** Retention runs from START, so an entry whose call never returns cannot be held forever. */
  #expired(entry: Entry): boolean {
    return this.#now() - entry.startedAt > this.#retentionMs;
  }

  #purge(): void {
    for (const [k, entry] of this.#entries) if (this.#expired(entry)) this.#entries.delete(k);
  }
}
