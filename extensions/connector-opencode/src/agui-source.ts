/**
 * A {@link DurableSource} over an OpenCode session, read through the SDK's own
 * `session.messages()` surface rather than the SQLite file behind it.
 *
 * **Why not the database.** `~/.local/share/opencode/opencode.db` is OpenCode's private store: its
 * schema migrates, and reading it would couple this plane to internals no contract covers. The
 * measurements in this file's comments were taken from a copy of that store because it is the only
 * corpus large enough to answer the questions honestly; the SHIPPED read path is the API.
 *
 * **The cursor is the PAIR `messageId:partId`, and the pair is not decoration.** Part ids are
 * monotonic within a message (measured: 0 inversions over 14 915 parts). They are NOT monotonic
 * across a session: ordering every part by (message creation, message id, part id) produces 16
 * inversions over 14 759 ordered pairs, every one of them the first part of a USER message whose id
 * is lower than the last part of the assistant message before it, because the prompt's text part is
 * created while the assistant's final part is still being written. Restricted to the assistant-only
 * stream that §3.2's authorship ruling leaves us with, the count is 0 over 14 084. So a bare
 * `part.id` cursor would be sound only for as long as an unrelated safety ruling keeps user parts
 * out, which is a dependency nobody would remember. The pair is sound either way and costs nothing.
 *
 * **Removal is tolerated by construction.** The cursor is compared as an ORDER, never looked up as
 * an identity, so a session whose parts were reverted away resumes from the same position without
 * the record it names having to still exist. That is what makes the ruling implementable: publish
 * on finality, and treat a later removal as a logged divergence rather than a halt.
 */
import type { DurableSource, SourceRead } from "@cotal-ai/connector-core";

/** The message fields the mapper needs. Deliberately not the whole `Message`: the source hands on
 *  identity, authorship and the turn-level completion mark, and nothing it does not read. */
export interface OpenCodeMessageInfo {
  id: string;
  role: string;
  time?: { created?: number; completed?: number };
}

/** One record: a part, plus the message that owns it. The mapper needs both, because authorship and
 *  the turn-level finality backstop live on the message, not on the part. */
export interface OpenCodeRecord {
  part: OpenCodePart;
  message: OpenCodeMessageInfo;
}

/**
 * The part shape this source reads. It is a STRUCTURAL subset of the SDK's `Part` union, declared
 * here rather than imported, for the same reason the Claude mapper declares its own entry type: the
 * SDK's type describes what OpenCode may write, and this describes what we actually read. Importing
 * the union would make an SDK bump a compile error in a file that does not care about the fields
 * that changed.
 */
export interface OpenCodePart {
  id: string;
  messageID: string;
  type: string;
  text?: string;
  synthetic?: boolean;
  ignored?: boolean;
  callID?: string;
  tool?: string;
  state?: { status?: string; input?: unknown; output?: string; error?: string; time?: { start?: number; end?: number } };
  time?: { start?: number; end?: number };
  cost?: number;
  tokens?: unknown;
}

/** One entry of `session.messages()`: the message and its parts. */
export interface OpenCodeMessageWithParts {
  info: OpenCodeMessageInfo;
  parts: OpenCodePart[];
}

/** Reads the whole session. Injected so the source can be exercised without a live server. */
export type ReadSessionMessages = () => Promise<OpenCodeMessageWithParts[]>;

/**
 * The part types this source may hand to the mapper as EMITTABLE, meaning a frame depends on them.
 * Everything else is passed through and never gates the cursor: a part that produces no frame
 * cannot be the reason a frame is wrong.
 */
const EMITTING_TYPES = new Set(["text", "reasoning", "tool"]);

/**
 * Is this part settled, so that emitting from it now cannot be contradicted later?
 *
 * The question matters because parts are mutated in place long after they appear: 11 518 of 14 915
 * carry `time_updated > time_created`, and 1 657 of the 11 298 that have a successor were updated
 * AFTER their successor already existed, by up to 29.5 minutes. "A later part exists" therefore
 * does NOT mean an earlier one is done, which is the design this measurement killed.
 *
 * The turn-level backstop is what stops a stream from wedging on a part that never gets its own end
 * mark. It is sound in normal operation: the only parts in the corpus updated after their message
 * reported completed are 830 rows rewritten inside a single 150 ms window, ~16 to 20 per
 * millisecond, which is a bulk write rather than session behaviour. It matches no timestamp in the
 * store's migration tables, so it is provably bulk and NOT attributable to a named process.
 */
export function isSettled(record: OpenCodeRecord): boolean {
  const { part, message } = record;
  // AUTHORSHIP FIRST, AND IT IS NOT AN OPTIMISATION. §3.2 rules that no user-authored text is ever
  // emitted, so a user message produces no frame and cannot gate one. Testing the part type first
  // would WEDGE EVERY SESSION AT ITS FIRST PROMPT: `UserMessage.time` carries only `created` (no
  // `completed` field exists on the type, and 0 of 634 user messages carry one), and 659 of 668
  // user text parts carry no `time` object at all, so neither settle signal can ever arrive for
  // them. The safety ruling and the liveness of this stream are the same line.
  if (message.role !== "assistant") return true;
  if (!EMITTING_TYPES.has(part.type)) return true; // emits nothing, so it gates nothing
  if (message.time?.completed !== undefined) return true; // the turn ended: nothing more is coming
  if (part.type === "tool") return part.state?.status === "completed" || part.state?.status === "error";
  return part.time?.end !== undefined; // text and reasoning
}

/** Serialise the ordering key. Ids carry no `:`, so the first one separates the halves. */
export function cursorOf(record: OpenCodeRecord): string {
  return `${record.message.id}:${record.part.id}`;
}

function parseCursor(cursor: string): { messageId: string; partId: string } {
  const i = cursor.indexOf(":");
  if (i <= 0 || i === cursor.length - 1) {
    throw new Error(`OpenCodeSessionSource: malformed cursor ${JSON.stringify(cursor)} (want <messageId>:<partId>)`);
  }
  return { messageId: cursor.slice(0, i), partId: cursor.slice(i + 1) };
}

/** Strictly after the cursor, comparing the pair rather than either half alone. */
function isAfter(record: OpenCodeRecord, at: { messageId: string; partId: string }): boolean {
  if (record.message.id !== at.messageId) return record.message.id > at.messageId;
  return record.part.id > at.partId;
}

export interface OpenCodeSessionSourceOptions {
  /** Reads the session. */
  read: ReadSessionMessages;
  /**
   * Called ONCE per read in which the cursor's own record is no longer present, with the cursor
   * that vanished. This is the divergence a revert produces, and it is reported rather than thrown:
   * a user pressing revert is a legitimate session action, and an emitter that died on it would
   * fail the deliverable. Ordering makes the read itself correct without this; the callback exists
   * so the divergence is visible instead of silent.
   */
  onVanished?: (cursor: string) => void;
}

export class OpenCodeSessionSource implements DurableSource<OpenCodeRecord> {
  readonly kind = "opencode-session";
  private readonly read0: ReadSessionMessages;
  private readonly onVanished?: (cursor: string) => void;
  /** The last cursor already reported as vanished. A revert leaves the cursor absent on EVERY read
   *  until it advances past the removed region, so reporting per read would turn one divergence
   *  into a log flood and bury the next, different one. */
  private reportedVanished?: string;

  constructor(opts: OpenCodeSessionSourceOptions) {
    this.read0 = opts.read;
    this.onVanished = opts.onVanished;
  }

  async read(cursor: string | undefined): Promise<SourceRead<OpenCodeRecord>> {
    const messages = await this.read0();

    // Session order: messages by id (measured monotonic with creation time, 0 disagreements over
    // the corpus), parts by id within a message.
    const ordered: OpenCodeRecord[] = [];
    for (const m of [...messages].sort((a, b) => (a.info.id < b.info.id ? -1 : a.info.id > b.info.id ? 1 : 0))) {
      for (const part of [...m.parts].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))) {
        ordered.push({ part, message: m.info });
      }
    }

    // A fresh adopt must not rebroadcast the session's history, so it returns no records and the
    // position of the end. An empty session yields the empty cursor, which `isAfter` never has to
    // interpret because the next read with it takes the same branch as `undefined`.
    if (cursor === undefined) {
      const last = ordered.at(-1);
      return { records: [], cursor: last ? cursorOf(last) : "" };
    }
    if (cursor === "") {
      const settled = this.settledPrefix(ordered);
      return settled.records.length ? settled : { records: [], cursor: "" };
    }

    const at = parseCursor(cursor);
    if (this.onVanished && this.reportedVanished !== cursor
        && !ordered.some((r) => r.message.id === at.messageId && r.part.id === at.partId)) {
      this.reportedVanished = cursor;
      this.onVanished(cursor);
    }
    const after = ordered.filter((r) => isAfter(r, at));
    const settled = this.settledPrefix(after);
    return settled.records.length ? settled : { records: [], cursor };
  }

  /**
   * The contiguous run of settled records from the front, and the cursor of the last of them.
   *
   * **STOPPING AT THE FIRST UNSETTLED RECORD IS THE WHOLE POINT**, and it is the same rule
   * `JsonlFileSource` applies to a half-written line: consume up to the last complete unit, leave
   * the rest for the next read. Emitting AROUND a part that is still filling would publish frames
   * out of the order the brackets require, and advancing past it would drop it for good, because
   * nothing ever revisits a cursor. The cost is head-of-line blocking within a session, which is
   * the honest price of ordered brackets rather than an oversight.
   */
  private settledPrefix(records: OpenCodeRecord[]): SourceRead<OpenCodeRecord> {
    const out: { value: OpenCodeRecord; cursor: string }[] = [];
    for (const r of records) {
      if (!isSettled(r)) break;
      out.push({ value: r, cursor: cursorOf(r) });
    }
    return { records: out, cursor: out.length ? out[out.length - 1]!.cursor : "" };
  }
}
