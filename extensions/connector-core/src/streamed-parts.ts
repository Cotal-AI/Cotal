/**
 * What a record mapper keeps to publish streamed message parts: the parts open on the wire, the text
 * each streamed, and the parts already closed. A part that streamed nothing is not here at all, so
 * its saved record maps exactly as it did before the connector streamed.
 */
import {
  reasoningMessageContent, reasoningMessageEnd, reasoningMessageStart, textMessageContent, textMessageEnd, textMessageStart,
  type AguiEvent,
} from "./agui.js";
import type { StreamDelta } from "./delta-journal.js";

/** The state {@link streamSeed} rebuilds for a restarted mapper. */
export interface StreamSeed {
  open: Array<{ key: string; kind: StreamDelta["kind"]; text: string }>;
  closed: string[];
}

const start = (kind: StreamDelta["kind"], messageId: string, timestamp: number): AguiEvent =>
  kind === "text" ? textMessageStart({ messageId, timestamp }) : reasoningMessageStart({ messageId, timestamp });
const content = (kind: StreamDelta["kind"], messageId: string, delta: string, timestamp: number): AguiEvent =>
  kind === "text" ? textMessageContent({ messageId, delta, timestamp }) : reasoningMessageContent({ messageId, delta, timestamp });
const end = (kind: StreamDelta["kind"], messageId: string, timestamp: number): AguiEvent =>
  kind === "text" ? textMessageEnd({ messageId, timestamp }) : reasoningMessageEnd({ messageId, timestamp });

export class StreamedParts {
  private readonly open = new Map<string, { kind: StreamDelta["kind"]; text: string }>();
  private readonly closed = new Set<string>();

  constructor(seed?: StreamSeed) {
    for (const s of seed?.open ?? []) this.open.set(s.key, { kind: s.kind, text: s.text });
    for (const key of seed?.closed ?? []) this.closed.add(key);
  }

  /** START under the key at its first delta, then CONTENT. Nothing for a part already closed: its
   *  saved record carried the text. */
  delta(d: StreamDelta, timestamp: number): AguiEvent[] {
    if (this.closed.has(d.key)) return [];
    const s = this.open.get(d.key);
    if (s && s.kind !== d.kind) throw new Error(`streamed part ${d.key} is ${s.kind}, not ${d.kind}`);
    if (s) s.text += d.text;
    else this.open.set(d.key, { kind: d.kind, text: d.text });
    return [...(s ? [] : [start(d.kind, d.key, timestamp)]), content(d.kind, d.key, d.text, timestamp)];
  }

  /**
   * Close a part at its saved record. A part that never streamed answers `mapAsNew` with nothing to
   * publish, and the mapper maps it as it always did. A saved text that begins with what streamed
   * sends the rest and END. Any other saved text, as a provider retry leaves, ends the streamed part
   * and answers `mapAsNew`: the saved text is published as a message of its own, so a reader sees
   * the abandoned partial once and then the text of record.
   */
  saved(key: string, text: string, timestamp: number): { events: AguiEvent[]; mapAsNew: boolean } {
    const s = this.open.get(key);
    this.closed.add(key);
    if (!s) return { events: [], mapAsNew: true };
    this.open.delete(key);
    if (!text.startsWith(s.text)) return { events: [end(s.kind, key, timestamp)], mapAsNew: true };
    const rest = text.slice(s.text.length);
    return { events: [...(rest ? [content(s.kind, key, rest, timestamp)] : []), end(s.kind, key, timestamp)], mapAsNew: false };
  }

  /** END for each of `keys` still open: the harness abandoned those streams, and no saved record will
   *  close them. A key already closed, or one that never streamed, sends nothing and stays closed. */
  end(keys: readonly string[], timestamp: number): AguiEvent[] {
    const events: AguiEvent[] = [];
    for (const key of keys) {
      const s = this.open.get(key);
      this.closed.add(key);
      if (!s) continue;
      this.open.delete(key);
      events.push(end(s.kind, key, timestamp));
    }
    return events;
  }

  /** END for every part still open, as a saved message whose record names none of them leaves. */
  endAll(timestamp: number): AguiEvent[] {
    const events = [...this.open].map(([key, s]) => end(s.kind, key, timestamp));
    for (const key of this.open.keys()) this.closed.add(key);
    this.open.clear();
    return events;
  }
}
