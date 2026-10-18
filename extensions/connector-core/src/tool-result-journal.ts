/**
 * The private tool-result journal: the one place a connector keeps the tool outputs its harness
 * reported, for a reader that holds a redeemed capability handle on this agent.
 *
 * WHY IT EXISTS. The event plane withholds `TOOL_CALL_ARGS` and `TOOL_CALL_RESULT` from
 * `events.<owner>.<actor>` (agui.ts, EGRESS_FORBIDDEN_TYPES), because that channel has a broader
 * read ACL than the tool ran under. That fence is unchanged. This journal keeps the RESULT (never
 * the arguments) out of every channel and serves it only through the `tool-result` command
 * (tool-result-command.ts), whose authority is a holder-bound `handle`-mode grant on this exact
 * target, so the audience is the one principal the grant names and nobody else in the space.
 *
 * WHAT IT IS NOT.
 * - Not complete history. It is in-process, bounded by entry count, content bytes and age, and it
 *   is empty after a restart; an id it does not hold is `missing`, never inferred.
 * - Not redaction. A result is kept byte-for-byte up to the content bound, and a tool that printed
 *   a secret returns that secret to the holder. Sharing is the owner's explicit choice, and the
 *   default is `off`: nothing is captured and every lookup answers `not-shared`.
 * - Not a correlation engine. Entries are keyed by the native `(threadId, toolCallId)` pair the
 *   harness wrote; nothing is matched by time, order or name.
 */

import { AGUI_EVENT_TYPE, type AguiEvent } from "./agui.js";
import type { RecordMapper } from "./agui-emitter.js";

/** Who may read captured results. Closed. `off` (the default) captures nothing;
 *  `handle-holders` captures and serves only to a redeemed `handle`-mode grant on this target. */
export type ToolResultSharing = "off" | "handle-holders";

export const TOOL_RESULT_DEFAULTS = Object.freeze({
  maxEntries: 256,
  maxContentBytes: 65_536,
  ttlMs: 3_600_000,
});

/** One lookup's answer. Every state is distinct and none is inferred from another:
 *  - `available`: the harness reported a result; `content` is its text, possibly `""`.
 *  - `pending`: the call started and no result has arrived yet.
 *  - `not-shared`: sharing is off, so nothing was captured.
 *  - `missing`: no call or result with this id was observed by this process.
 *  - `expired`: a result was held and the retention bound (age or capacity) dropped it. */
export type ToolResultAnswer =
  | { state: "available"; threadId: string; toolCallId: string; content: string; truncated: boolean; bytes: number; isError: boolean; capturedAt: number }
  | { state: "pending"; threadId: string; toolCallId: string }
  | { state: "not-shared" }
  | { state: "missing" }
  | { state: "expired" };

type Entry =
  | { kind: "pending"; at: number }
  | { kind: "result"; at: number; content: string; truncated: boolean; bytes: number; isError: boolean };

const encoder = new TextEncoder();

/** Cut `text` to at most `max` UTF-8 bytes on a code-point boundary. */
function bounded(text: string, max: number): { content: string; truncated: boolean; bytes: number } {
  const bytes = encoder.encode(text).length;
  if (bytes <= max) return { content: text, truncated: false, bytes };
  let used = 0;
  let end = 0;
  for (const ch of text) {
    const size = encoder.encode(ch).length;
    if (used + size > max) break;
    used += size;
    end += ch.length;
  }
  return { content: text.slice(0, end), truncated: true, bytes };
}

export class ToolResultJournal {
  readonly sharing: ToolResultSharing;
  private readonly maxEntries: number;
  private readonly maxContentBytes: number;
  private readonly ttlMs: number;
  private readonly now: () => number;
  /** Insertion-ordered, so the oldest entry is evicted first. */
  private readonly entries = new Map<string, Entry>();
  /** Keys a retention bound dropped, so a later lookup says `expired` instead of `missing`. */
  private readonly dropped = new Map<string, number>();
  private retiredFlag = false;

  constructor(opts: { sharing: ToolResultSharing; maxEntries?: number; maxContentBytes?: number; ttlMs?: number; now?: () => number }) {
    if (opts.sharing !== "off" && opts.sharing !== "handle-holders")
      throw new Error(`tool-result sharing must be "off" or "handle-holders", got ${JSON.stringify(opts.sharing)}`);
    this.sharing = opts.sharing;
    this.maxEntries = opts.maxEntries ?? TOOL_RESULT_DEFAULTS.maxEntries;
    this.maxContentBytes = opts.maxContentBytes ?? TOOL_RESULT_DEFAULTS.maxContentBytes;
    this.ttlMs = opts.ttlMs ?? TOOL_RESULT_DEFAULTS.ttlMs;
    this.now = opts.now ?? Date.now;
    for (const [name, value] of [["maxEntries", this.maxEntries], ["maxContentBytes", this.maxContentBytes], ["ttlMs", this.ttlMs]] as const)
      if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`tool-result ${name} must be a positive integer`);
  }

  /** True once the lifecycle this journal served ended or its sharing was revoked. */
  get retired(): boolean {
    return this.retiredFlag;
  }

  /** Record what one mapped batch says about tool calls on `threadId`: a `TOOL_CALL_START` opens a
   *  pending entry and a `TOOL_CALL_RESULT` fills it. A result already held is kept as first seen,
   *  so a replayed transcript cannot rewrite it. Arguments are never read. */
  observe(threadId: string, events: readonly AguiEvent[]): void {
    if (this.sharing === "off" || this.retiredFlag) return;
    const at = this.now();
    this.sweep(at);
    for (const event of events) {
      const e = event as { type?: unknown; toolCallId?: unknown; content?: unknown; cotal?: { isError?: unknown } };
      if (typeof e.toolCallId !== "string" || e.toolCallId === "") continue;
      const key = this.key(threadId, e.toolCallId);
      if (e.type === AGUI_EVENT_TYPE.TOOL_CALL_START) {
        if (!this.entries.has(key)) this.put(key, { kind: "pending", at });
      } else if (e.type === AGUI_EVENT_TYPE.TOOL_CALL_RESULT && typeof e.content === "string") {
        if (this.entries.get(key)?.kind === "result") continue;
        this.put(key, { kind: "result", at, ...bounded(e.content, this.maxContentBytes), isError: e.cotal?.isError === true });
      }
    }
  }

  answer(threadId: string, toolCallId: string): ToolResultAnswer {
    if (this.sharing === "off" || this.retiredFlag) return { state: "not-shared" };
    this.sweep(this.now());
    const key = this.key(threadId, toolCallId);
    const entry = this.entries.get(key);
    if (!entry) return this.dropped.has(key) ? { state: "expired" } : { state: "missing" };
    if (entry.kind === "pending") return { state: "pending", threadId, toolCallId };
    return { state: "available", threadId, toolCallId, content: entry.content, truncated: entry.truncated, bytes: entry.bytes, isError: entry.isError, capturedAt: entry.at };
  }

  /** End sharing for good: the lifecycle retired, or the owner revoked sharing. Every held result
   *  is discarded at once and later lookups answer `not-shared`. */
  retire(): void {
    this.retiredFlag = true;
    this.entries.clear();
    this.dropped.clear();
  }

  private key(threadId: string, toolCallId: string): string {
    return `${threadId}\u0000${toolCallId}`;
  }

  private put(key: string, entry: Entry): void {
    this.entries.delete(key);
    this.entries.set(key, entry);
    this.dropped.delete(key);
    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next().value as string;
      this.drop(oldest);
    }
  }

  private drop(key: string): void {
    this.entries.delete(key);
    this.dropped.set(key, this.now());
    while (this.dropped.size > this.maxEntries) this.dropped.delete(this.dropped.keys().next().value as string);
  }

  private sweep(at: number): void {
    for (const [key, entry] of this.entries) {
      if (at - entry.at <= this.ttlMs) break;
      this.drop(key);
    }
  }
}

/** Wrap a connector's record mapper so every batch it maps is also shown to `journal`, unchanged.
 *  The emitter still receives the same events and still withholds the result kinds from the
 *  event channel; the journal only reads them. */
export function captureToolResults<T>(map: RecordMapper<T>, journal: ToolResultJournal, threadId: string): RecordMapper<T> {
  if (journal.sharing === "off") return map;
  return (record) => {
    const out = map(record);
    if (out && "events" in out) journal.observe(threadId, out.events);
    return out;
  };
}
