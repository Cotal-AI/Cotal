/**
 * A {@link DurableSource} over an OpenCode 2.x session, read through `GET /api/session/:id/message`,
 * the server's supported message list. The shapes below were measured against OpenCode 2.2.5; the
 * redacted captures are `smoke/fixtures/opencode2-sessions.json`.
 *
 * **What 2.x writes, and why it decides the record and the settle rule.** Each model step is one
 * `assistant` message whose `content` holds its elements in the order they started: `text` and
 * `reasoning` carry no id and no end mark of their own, and a `tool` carries its call id and a state
 * that moves from `streaming` to `running` to `completed` or `error`. Streamed deltas never reach
 * the list: a text element holds `""` until it ends and then its whole text. The message gets
 * `time.streamed` once the step's output has ended and `time.completed` once its tools have too.
 * Each turn closes with an `idle` message carrying the turn's `outcome`, so the end of a turn and how
 * it ended are records in order. A prompt sent while a turn runs waits in the session inbox and
 * enters the list only when it is delivered at a step boundary.
 *
 * So a record is one element, keyed by its message id and its position, and the cursor is that pair
 * compared as an order. Message ids sort by creation (measured on every captured session). A message
 * with no element is one record of its own: a user prompt, a turn end, and a step that has not
 * written anything yet, which must hold the read like any unsettled element does.
 */
import type { DurableSource, SourceRead } from "@cotal-ai/connector-core";

/** The fields of a 2.x message this source and its mapper read. */
export interface OpenCode2Message {
  id: string;
  /** `assistant`, `user`, `idle`, `synthetic`, `system`, `skill`, `shell`, `compaction`, or a
   *  `*-switched` setting change. */
  type: string;
  time: { created: number; streamed?: number; completed?: number };
  /** An assistant message's elements, in the order they started. */
  content?: OpenCode2Element[];
  /** How the turn an `idle` message closes ended. */
  outcome?: "succeeded" | "failed" | "interrupted";
  error?: { type?: string; message?: string };
}

export type OpenCode2Element =
  | { type: "text"; text: string }
  | { type: "reasoning"; text: string; time?: { created: number; completed?: number } }
  | {
      type: "tool";
      id: string;
      name: string;
      state: {
        status: "streaming" | "running" | "completed" | "error";
        input?: unknown;
        content?: Array<{ type: string; text?: string }>;
        error?: { type?: string; message?: string };
      };
      time: { created: number; ran?: number; completed?: number };
    };

/** One page of the message list, newest first, with the keyset cursor of the page after it. */
export interface OpenCode2MessagePage {
  data: OpenCode2Message[];
  cursor: { next?: string | null };
}

/** Fetches the newest page, or the page after the one whose `cursor.next` is passed. Injected so the
 *  source can be read without a server. */
export type FetchMessagePage = (next: string | undefined) => Promise<OpenCode2MessagePage>;

/** One element of an assistant message at its position, or a message with no element at `-1`. */
export interface OpenCode2Record {
  message: OpenCode2Message;
  index: number;
  element?: OpenCode2Element;
}

function cursorOf(record: OpenCode2Record): string {
  return `${record.message.id}:${record.index}`;
}

function parseCursor(cursor: string): { messageId: string; index: number } {
  const i = cursor.indexOf(":");
  const index = cursor.slice(i + 1);
  if (i <= 0 || !/^(?:-1|0|[1-9]\d*)$/.test(index)) {
    throw new Error(`OpenCode2SessionSource: malformed cursor ${JSON.stringify(cursor)} (want <messageId>:<index>)`);
  }
  return { messageId: cursor.slice(0, i), index: Number(index) };
}

function isAfter(record: OpenCode2Record, at: { messageId: string; index: number }): boolean {
  if (record.message.id !== at.messageId) return record.message.id > at.messageId;
  return record.index > at.index;
}

/**
 * Whether emitting from this record now cannot be contradicted later. A record of a turn that has
 * ended is settled whatever its own marks say, because nothing more is written for it.
 */
function isSettled(record: OpenCode2Record, turnEnded: boolean): boolean {
  const { message, element } = record;
  if (message.type !== "assistant") return true; // written whole
  if (message.time.completed !== undefined || turnEnded) return true;
  if (element === undefined) return false; // a step that has not written anything yet
  if (element.type === "tool") return element.state.status === "completed" || element.state.status === "error";
  return message.time.streamed !== undefined;
}

export interface OpenCode2SessionSourceOptions {
  page: FetchMessagePage;
  /** Called once per cursor whose record is no longer in the session, which is what a revert does.
   *  The read stays correct without it, because the cursor is compared as an order. */
  onVanished?: (cursor: string) => void;
}

export class OpenCode2SessionSource implements DurableSource<OpenCode2Record> {
  readonly kind = "opencode2-session";
  private readonly page: FetchMessagePage;
  private readonly onVanished?: (cursor: string) => void;
  private reportedVanished?: string;

  constructor(opts: OpenCode2SessionSourceOptions) {
    this.page = opts.page;
    this.onVanished = opts.onVanished;
  }

  /** Every message at or after `from`, or the whole session when `from` is absent. Pages run newest
   *  first, so the read stops at the first page that reaches back to `from`. */
  private async messages(from: string | undefined): Promise<OpenCode2Message[]> {
    const out: OpenCode2Message[] = [];
    let next: string | undefined;
    for (;;) {
      const page = await this.page(next);
      out.push(...page.data);
      const oldest = page.data.at(-1);
      if (oldest === undefined || !page.cursor.next || (from !== undefined && oldest.id <= from)) return out;
      next = page.cursor.next;
    }
  }

  /** The records in session order, each with whether a later `idle` has ended its turn. */
  private async ordered(from: string | undefined): Promise<Array<{ record: OpenCode2Record; turnEnded: boolean }>> {
    const messages = (await this.messages(from)).sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    const lastIdle = messages.findLast((m) => m.type === "idle")?.id;
    const ordered: Array<{ record: OpenCode2Record; turnEnded: boolean }> = [];
    for (const message of messages) {
      const turnEnded = lastIdle !== undefined && message.id < lastIdle;
      const content = message.type === "assistant" ? (message.content ?? []) : [];
      if (content.length === 0) ordered.push({ record: { message, index: -1 }, turnEnded });
      content.forEach((element, index) => ordered.push({ record: { message, index, element }, turnEnded }));
    }
    return ordered;
  }

  async end(): Promise<string> {
    const newest = (await this.page(undefined)).data[0];
    if (newest === undefined) return "";
    const count = newest.type === "assistant" ? (newest.content?.length ?? 0) : 0;
    return `${newest.id}:${count - 1}`;
  }

  async read(cursor: string | undefined): Promise<SourceRead<OpenCode2Record>> {
    // A fresh adopt must not rebroadcast the session's history, so it returns the end and nothing else.
    if (cursor === undefined) return { records: [], cursor: await this.end() };
    const at = cursor === "" ? undefined : parseCursor(cursor);
    const ordered = await this.ordered(at?.messageId);
    if (at !== undefined && this.onVanished && this.reportedVanished !== cursor
        && !ordered.some(({ record }) => record.message.id === at.messageId && record.index === at.index)) {
      this.reportedVanished = cursor;
      this.onVanished(cursor);
    }
    // The settled run from the front, stopping at the first record that is not: emitting around one
    // would publish out of order, and advancing past it would drop it for good.
    const records: SourceRead<OpenCode2Record>["records"] = [];
    for (const { record, turnEnded } of ordered) {
      if (at !== undefined && !isAfter(record, at)) continue;
      if (!isSettled(record, turnEnded)) break;
      records.push({ value: record, cursor: cursorOf(record) });
    }
    return { records, cursor: records.at(-1)?.cursor ?? cursor };
  }
}
