/**
 * Claude's streamed reply text on the event plane. The command mod relays the lines Claude Code
 * shows while a reply streams (its `MessageDisplay` event), and the seat journals them in the
 * thread's delta journal.
 *
 * **The tie is order.** A flush names its prompt (`prompt_id`) and a display id of its own, and the
 * transcript records neither the display id nor the turn id. The prompt id is on the prompt's user
 * entry as `promptId`. So the mod numbers each prompt's main-thread messages in the order they
 * stream, and the mapper numbers that prompt's saved text blocks the same way. A saved text that
 * does not begin with what streamed under its number is the mismatch case of {@link StreamedParts}:
 * the streamed part ends, and the saved text is published as a message of its own.
 */
import { createReadStream, existsSync } from "node:fs";
import { basename } from "node:path";
import { createInterface } from "node:readline";
import {
  DeltaJournal, JsonlFileSource, StreamedParts, textMessageContent, textMessageEnd, textMessageStart,
  type AguiEvent, type CotalMeta, type DurableSource, type Merged, type OrderedSource, type SourceRead,
} from "@cotal-ai/connector-core";
import type { ClaudeEntry } from "./agui-map.js";

/** The journal key of the `n`-th main-thread text message, from 1, of the prompt `promptId`. The
 *  prefix keeps it apart from the `<uuid>#<i>` id a message mapped without streaming gets. */
export function claudeStreamKey(promptId: string, n: number): string {
  return `stream:${promptId}:${n}`;
}

/** Numbers each prompt's saved text blocks as the mod numbers its streamed messages. */
export class ClaudeStreamOrder {
  constructor(
    private prompt: string | undefined = undefined,
    private n = 0,
  ) {}

  /** A main-thread user entry names the prompt its turn belongs to; a tool result names it again. */
  observe(entry: ClaudeEntry): void {
    if (entry.type !== "user" || entry.isSidechain || typeof entry.promptId !== "string" || entry.promptId === this.prompt) return;
    this.prompt = entry.promptId;
    this.n = 0;
  }

  /** The key of a saved text block, or undefined for one that never streamed: a subagent's, an
   *  empty one, or one before any prompt this order saw. */
  next(entry: ClaudeEntry, text: string): string | undefined {
    if (entry.isSidechain || text === "" || this.prompt === undefined) return undefined;
    return claudeStreamKey(this.prompt, ++this.n);
  }
}

/** Number every main-thread text block the transcript holds before `cursor`, so a mapper built for
 *  a re-established plane goes on numbering where the last one stopped. The file is read a line at a
 *  time, so a long transcript is never held whole. */
export async function primeStreamOrder(path: string, cursor: string | undefined): Promise<ClaudeStreamOrder> {
  const order = new ClaudeStreamOrder();
  const offset = cursor === undefined ? 0 : JsonlFileSource.offsetOf(cursor);
  if (offset === 0) return order;
  const lines = createInterface({ input: createReadStream(path, { start: 0, end: offset - 1 }), crlfDelay: Infinity });
  for await (const line of lines) {
    let entry: ClaudeEntry;
    try {
      entry = JSON.parse(line) as ClaudeEntry;
    } catch {
      continue;
    }
    order.observe(entry);
    const content = entry.type === "assistant" ? entry.message?.content : undefined;
    if (Array.isArray(content)) for (const b of content) if (b.type === "text" && typeof b.text === "string") order.next(entry, b.text);
  }
  return order;
}

/** The transcript source in the order a delta journal is anchored to: its cursors compared by
 *  offset, and the anchor its end read in one synchronous step. */
export class OrderedTranscript implements OrderedSource<ClaudeEntry> {
  readonly kind: string;
  private readonly file: JsonlFileSource<ClaudeEntry>;

  constructor(
    private readonly inner: DurableSource<ClaudeEntry>,
    readonly path: string,
  ) {
    this.kind = inner.kind;
    this.file = new JsonlFileSource(path);
  }

  read(cursor: string | undefined): Promise<SourceRead<ClaudeEntry>> {
    return this.inner.read(cursor);
  }

  end(): Promise<string> {
    return this.inner.end();
  }

  compare(a: string, b: string): number {
    return this.file.compare(a, b);
  }

  anchor(): string {
    return this.file.endSync();
  }
}

/** What the mapper keeps for streaming: the numbering and the parts open on the wire. */
export interface ClaudeStreamState {
  order: ClaudeStreamOrder;
  parts: StreamedParts;
}

/** A journal line under the open run: the parts it streams, and the end of the parts it abandons.
 *  With no run open, a line maps to nothing and opens no part. */
export function mapStreamLine(s: ClaudeStreamState, open: string | null, line: Exclude<Merged<ClaudeEntry>, { harness: unknown }>): { runId: string; events: AguiEvent[] } | null {
  if (open === null) return null;
  const events = [...line.deltas.flatMap((d) => s.parts.delta(d, line.timestamp)), ...s.parts.end(line.ends ?? [], line.timestamp)];
  return events.length === 0 ? null : { runId: open, events };
}

/** A saved assistant text block: the close of what streamed under its number, then the block as a
 *  message of its own when nothing streamed or the saved text does not continue what did. */
export function savedText(
  s: ClaudeStreamState | undefined, entry: ClaudeEntry, messageId: string, text: string, ts: number, meta: { cotal?: CotalMeta },
): AguiEvent[] {
  const key = s?.order.next(entry, text);
  const closed = key === undefined ? { events: [], mapAsNew: true } : s!.parts.saved(key, text, ts);
  if (!closed.mapAsNew) return closed.events;
  return [
    ...closed.events,
    textMessageStart({ messageId, timestamp: ts, role: "assistant", ...meta }),
    textMessageContent({ messageId, delta: text, timestamp: ts }),
    textMessageEnd({ messageId, timestamp: ts }),
  ];
}

/** One line of reply text the command mod relayed: the journal key it numbered, and the text. */
export interface ClaudeTextDelta {
  key: string;
  text: string;
}

/** The delta journal of the transcript the plane adopted. The text the mod relays goes in, and a
 *  turn's end abandons the streams no saved entry closed. */
export class StreamJournal {
  private current?: { transcript: OrderedTranscript; journal: DeltaJournal; journalPath: string; keys: Set<string> };
  private closed = false;

  constructor(private readonly opts: {
    /** The thread's journal path, in its WAL directory. */
    path: (threadId: string) => Promise<string>;
    /** A line was written for the transcript at `path`. */
    wake: (path: string) => void;
  }) {}

  /** Open the journal of the transcript at `path`, once, before anything positions on it, so every
   *  read and every terminal's position is a merged cursor. */
  async open(path: string): Promise<{ transcript: OrderedTranscript; journalPath: string }> {
    if (this.current?.transcript.path === path) return this.current;
    const journalPath = await this.opts.path(basename(path, ".jsonl"));
    if (this.current?.transcript.path === path) return this.current;
    this.current?.journal.close();
    const transcript = new OrderedTranscript(new JsonlFileSource(path), path);
    const journal = DeltaJournal.open({
      path: journalPath,
      anchor: () => transcript.anchor(),
      onWrite: () => this.opts.wake(path),
      onError: (error) => warn(`streamed reply text could not be journaled; the saved text carries it: ${error.message}`),
    });
    this.current = { transcript, journal, journalPath, keys: new Set() };
    return this.current;
  }

  /** Journal reply text the mod relayed. Dropped before the transcript exists or was adopted. */
  deltas(list: readonly ClaudeTextDelta[]): void {
    const c = this.current;
    if (!c || this.closed || !existsSync(c.transcript.path)) return;
    for (const d of list) {
      c.keys.add(d.key);
      c.journal.append({ key: d.key, kind: "text", text: d.text });
    }
  }

  /** End the streams of the turn that no saved entry closed. */
  endStreams(): void {
    const c = this.current;
    if (!c || this.closed || c.keys.size === 0) return;
    const keys = [...c.keys];
    c.keys.clear();
    try {
      c.journal.abandon(keys);
    } catch (e) {
      warn(`the turn's streamed reply text could not be ended: ${(e as Error).message}`);
    }
  }

  close(): void {
    this.closed = true;
    this.current?.journal.close();
  }
}

const warn = (msg: string): void => void process.stderr.write(`[cotal-connector] ${msg}\n`);
