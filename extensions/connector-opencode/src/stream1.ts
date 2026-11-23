/**
 * OpenCode 1.x's live text and reasoning, journaled so a reply streams on the event plane before
 * OpenCode saves it. OpenCode creates a text or reasoning part empty, sends its text as
 * `message.part.delta` events, and then saves it whole with an end mark (measured on 1.19.6), so
 * each part streams under a key of its own id and its own saved record closes the stream.
 *
 * **A line is anchored at the start of the streaming part's message**, the `<message>:<message>`
 * position the source also gives a failed message's stand-in record. The session store holds the
 * part from its first delta, so the store's end would place every line after the part, where its
 * saved record has already closed the stream. The merged source places a line before the first
 * record after its anchor, or where its read starts when it has read past it, so the text arrives
 * after whatever of the message is already published and before the part's saved record.
 */
import { DeltaJournal, type DeltaJournalOptions, type StreamDelta } from "@cotal-ai/connector-core";
import { compareCursors } from "./agui-source.js";

/** The key a part streams under. It differs from the part id, which a part mapped whole is published
 *  under. */
export const streamKey1 = (partId: string): string => `stream:${partId}`;

interface PartEvent {
  part?: { id?: string; messageID?: string; sessionID?: string; type?: string; text?: string; time?: { end?: number } };
}
interface DeltaEvent {
  sessionID?: string;
  partID?: string;
  field?: string;
  delta?: string;
}

export class OpenCode1DeltaStream {
  private journal: DeltaJournal | undefined;
  private sessionID: string | undefined;
  /** Text and reasoning parts created while the journal was open and not saved yet: their kind and
   *  the start of their message. A part created earlier never streams, so no stream opens partway
   *  through its text. */
  private readonly parts = new Map<string, { kind: StreamDelta["kind"]; anchor: string }>();
  /** The parts with text in the journal that OpenCode has not saved: their anchors. */
  private readonly streaming = new Map<string, string>();
  /** The parts streamed this turn, ended at the turn's end. */
  private readonly turn = new Set<string>();
  /** The session's end while the turn's end is journaled. */
  private endedAt: string | undefined;

  /** @param reasoning Whether reasoning is published, and so streamed. */
  constructor(private readonly reasoning: boolean) {}

  /** Journal the session's parts from now on, once. A written line should wake the emitter. */
  open(sessionID: string, opts: Omit<DeltaJournalOptions, "anchor">): void {
    if (this.journal) return;
    this.journal = DeltaJournal.open({ ...opts, anchor: () => this.anchor() });
    this.sessionID = sessionID;
  }

  /** Follow one bus event. */
  event(type: string, properties: unknown): void {
    if (type === "message.part.updated") this.part((properties as PartEvent).part);
    else if (type === "message.part.delta") this.delta(properties as DeltaEvent);
  }

  /**
   * The turn ended with the session at `end`: end every part it streamed there, before the run
   * closes, because a run cannot close while a streamed message is open. Anchored at the session's
   * end, the line follows every saved part of the turn, and the reader leaves alone a part its saved
   * record closed.
   */
  turnEnded(end: string): void {
    const keys = [...this.turn].map(streamKey1);
    this.turn.clear();
    this.streaming.clear();
    this.parts.clear();
    if (!this.journal || keys.length === 0) return;
    this.endedAt = end;
    try {
      this.journal.abandon(keys);
    } finally {
      this.endedAt = undefined;
    }
  }

  close(): void {
    this.journal?.close();
    this.journal = undefined;
  }

  private anchor(): string {
    let at = this.endedAt;
    for (const a of this.streaming.values()) if (at === undefined || compareCursors(a, at) < 0) at = a;
    return at ?? "";
  }

  private part(part: PartEvent["part"]): void {
    if (this.sessionID === undefined || part?.sessionID !== this.sessionID || !part.id || !part.messageID) return;
    if (part.time?.end !== undefined) {
      this.parts.delete(part.id);
      // OpenCode is saving the part: its record carries the text not journaled yet.
      if (this.streaming.delete(part.id)) this.journal?.settle();
      return;
    }
    const kind = part.type === "text" ? "text" : part.type === "reasoning" && this.reasoning ? "reasoning" : undefined;
    if (kind && this.journal && !part.text && !this.parts.has(part.id)) this.parts.set(part.id, { kind, anchor: `${part.messageID}:${part.messageID}` });
  }

  private delta(d: DeltaEvent): void {
    if (d.sessionID !== this.sessionID || d.field !== "text" || !d.partID || !d.delta || !this.journal) return;
    const part = this.parts.get(d.partID);
    if (!part) return;
    if (!this.streaming.has(d.partID)) this.streaming.set(d.partID, part.anchor);
    this.turn.add(d.partID);
    this.journal.append({ key: streamKey1(d.partID), kind: part.kind, text: d.delta });
  }
}
