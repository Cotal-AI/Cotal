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
 *   a secret returns that secret to the holder. Sharing is off until a verified human consent
 *   (core `verifyToolResultConsent`) is applied: before that nothing is captured and every lookup
 *   answers `not-shared`. When the last consent lapses or is revoked, every held result is
 *   discarded. Lapse is checked on the next capture or lookup, so it is bounded by the consent's
 *   `exp`, not instantaneous.
 * - Not a correlation engine. Entries are keyed by the native `(threadId, toolCallId)` pair the
 *   harness wrote; nothing is matched by time, order or name.
 */

import { AGUI_EVENT_TYPE, type AguiEvent } from "./agui.js";
import type { RecordMapper } from "./agui-emitter.js";

/** Whether the journal is capturing: `off` until a verified consent is applied, `consented` while
 *  at least one applied consent is unexpired and unrevoked. */
export type ToolResultSharing = "off" | "consented";

/** The parts of a VERIFIED consent the journal keeps. Verification is the caller's job. */
export interface AppliedToolResultConsent {
  id: string;
  holder: { id: string };
  exp: number;
}

export const TOOL_RESULT_DEFAULTS = Object.freeze({
  maxEntries: 256,
  maxContentBytes: 65_536,
  ttlMs: 3_600_000,
});

/** One lookup's answer. Every state is distinct and none is inferred from another:
 *  - `available`: the harness reported a result; `content` is its text, possibly `""`.
 *  - `pending`: the call started and no result has arrived yet.
 *  - `not-shared`: no applied consent names this reader, so nothing is shown.
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
  private readonly maxEntries: number;
  private readonly maxContentBytes: number;
  private readonly ttlMs: number;
  private readonly now: () => number;
  /** Insertion-ordered, so the oldest entry is evicted first. */
  private readonly entries = new Map<string, Entry>();
  /** Keys a retention bound dropped, so a later lookup says `expired` instead of `missing`. */
  private readonly dropped = new Map<string, number>();
  private retiredFlag = false;
  /** Applied consents by id: holder and expiry. */
  private readonly consents = new Map<string, { holder: string; exp: number }>();

  constructor(opts: { maxEntries?: number; maxContentBytes?: number; ttlMs?: number; now?: () => number } = {}) {
    this.maxEntries = opts.maxEntries ?? TOOL_RESULT_DEFAULTS.maxEntries;
    this.maxContentBytes = opts.maxContentBytes ?? TOOL_RESULT_DEFAULTS.maxContentBytes;
    this.ttlMs = opts.ttlMs ?? TOOL_RESULT_DEFAULTS.ttlMs;
    this.now = opts.now ?? Date.now;
    for (const [name, value] of [["maxEntries", this.maxEntries], ["maxContentBytes", this.maxContentBytes], ["ttlMs", this.ttlMs]] as const)
      if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`tool-result ${name} must be a positive integer`);
  }

  /** True once the lifecycle this journal served ended. */
  get retired(): boolean {
    return this.retiredFlag;
  }

  get sharing(): ToolResultSharing {
    return this.active(this.now()) ? "consented" : "off";
  }

  /** Start (or extend) sharing for one holder under a consent the caller has VERIFIED. Capture
   *  begins with the next mapped batch; nothing before it is recovered. */
  applyConsent(consent: AppliedToolResultConsent): void {
    if (this.retiredFlag) throw new Error("tool-result journal is retired");
    const at = this.now();
    if (!(consent.exp > at)) return;
    this.consents.set(consent.id, { holder: consent.holder.id, exp: consent.exp });
  }

  /** Withdraw one consent. Only its holder may withdraw it; true when it was active. The last
   *  withdrawal discards every held result. */
  revokeConsent(id: string, holder: string): boolean {
    const c = this.consents.get(id);
    if (!c || c.holder !== holder) return false;
    this.consents.delete(id);
    this.active(this.now());
    return true;
  }

  /** Record what one mapped batch says about tool calls on `threadId`: a `TOOL_CALL_START` opens a
   *  pending entry and a `TOOL_CALL_RESULT` fills it. A result already held is kept as first seen,
   *  so a replayed transcript cannot rewrite it. Arguments are never read. */
  observe(threadId: string, events: readonly AguiEvent[]): void {
    const at = this.now();
    if (this.retiredFlag || !this.active(at)) return;
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

  /** Look up one result for `holder`, who must hold an applied, unexpired consent. */
  answer(threadId: string, toolCallId: string, holder: string): ToolResultAnswer {
    const at = this.now();
    if (this.retiredFlag || !this.active(at) || ![...this.consents.values()].some((c) => c.holder === holder)) return { state: "not-shared" };
    this.sweep(at);
    const key = this.key(threadId, toolCallId);
    const entry = this.entries.get(key);
    if (!entry) return this.dropped.has(key) ? { state: "expired" } : { state: "missing" };
    if (entry.kind === "pending") return { state: "pending", threadId, toolCallId };
    return { state: "available", threadId, toolCallId, content: entry.content, truncated: entry.truncated, bytes: entry.bytes, isError: entry.isError, capturedAt: entry.at };
  }

  /** End sharing for good: the lifecycle retired. Every consent and held result is discarded at
   *  once and later lookups answer `not-shared`. */
  retire(): void {
    this.retiredFlag = true;
    this.consents.clear();
    this.entries.clear();
    this.dropped.clear();
  }

  /** Drop lapsed consents; when none is left, discard everything held. */
  private active(at: number): boolean {
    for (const [id, c] of this.consents) if (c.exp <= at) this.consents.delete(id);
    if (this.consents.size > 0) return true;
    this.entries.clear();
    this.dropped.clear();
    return false;
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
  return (record) => {
    const out = map(record);
    if (out && "events" in out) journal.observe(threadId, out.events);
    return out;
  };
}
