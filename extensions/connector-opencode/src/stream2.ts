/**
 * OpenCode 2.x's live text and reasoning, journaled so a reply streams on the event plane before the
 * step's message list carries it. 2.x keeps a streaming element empty in that list until its step
 * ends, and sends its text as `session.text.delta` and `session.reasoning.delta` events, each naming
 * the step's message and the element's ordinal among the message's elements of its kind (measured on
 * 2.0.24). So an element streams under a key of its message, kind and ordinal, and the mapper finds
 * the same key from the element's position when its saved record arrives.
 *
 * **A line is anchored at the session's last record before the step's message.** The step's message
 * is in the list, unsettled, from its first element, so a position inside it would hold every line
 * until the step ends. That record is read when the step starts; until it answers, a line takes the
 * furthest position a read of the session has reached, which is never past it. Either way the
 * records before the step come before the line and the step's saved elements after it.
 */
import { DeltaJournal, type DeltaJournalOptions, type StreamDelta } from "@cotal-ai/connector-core";

/** The key the element of `kind` at `ordinal` among a message's elements of that kind streams under.
 *  It differs from the `<message>#<index>` id an element mapped whole is published under. */
export const streamKey2 = (messageId: string, kind: StreamDelta["kind"], ordinal: number): string => `stream:${messageId}:${kind}:${ordinal}`;

/** The fields of a 2.x event this stream reads. */
export interface StreamEvent2 {
  type: string;
  created?: number;
  data?: { sessionID?: unknown; assistantMessageID?: unknown; ordinal?: unknown; delta?: unknown };
}

/** What the stream reads of the session's source: the furthest position a read has reached, read
 *  synchronously, and the session's last record before a message. */
interface StreamSource2 {
  readonly reached: string;
  before(messageId: string): Promise<string>;
}

const KINDS: Record<string, { kind: StreamDelta["kind"]; step: "started" | "delta" }> = {
  "session.text.started": { kind: "text", step: "started" },
  "session.text.delta": { kind: "text", step: "delta" },
  "session.reasoning.started": { kind: "reasoning", step: "started" },
  "session.reasoning.delta": { kind: "reasoning", step: "delta" },
};

export class OpenCode2DeltaStream {
  private journal: DeltaJournal | undefined;
  private sessionID: string | undefined;
  private openedAt = Infinity;
  /** Elements that started while the journal was open: their keys. One that started earlier, or
   *  whose start is a replay, never streams, so no stream opens partway through its text. */
  private readonly started = new Set<string>();
  /** The elements streamed this turn, ended at the turn's end. */
  private readonly turn = new Set<string>();
  /** The session's end while the turn's end is journaled. */
  private endedAt: string | undefined;
  /** The running step's message, and the session's last record before it once that is read. */
  private step: { message: string; before?: string } | undefined;
  private session: StreamSource2 | undefined;
  private onError: (error: Error) => void = () => {};

  /** @param reasoning Whether reasoning is published, and so streamed. */
  constructor(private readonly reasoning: boolean) {}

  /** Journal the elements of the session `source` reads from now on, once. A written line should
   *  wake the emitter. */
  open(sessionID: string, source: StreamSource2, opts: Omit<DeltaJournalOptions, "anchor">): void {
    if (this.journal) return;
    this.journal = DeltaJournal.open({ ...opts, anchor: () => this.endedAt ?? this.step?.before ?? source.reached });
    this.sessionID = sessionID;
    this.session = source;
    this.openedAt = Date.now();
    this.onError = opts.onError;
  }

  /** Follow one event of the session's event stream. */
  event(ev: StreamEvent2): void {
    if (ev.type === "session.step.started") return this.stepStarted(ev);
    // A turn that ends with its `idle` record closes its streams there, so its keys need no end of
    // their own.
    if ((ev.type === "session.execution.succeeded" || ev.type === "session.execution.failed") && ev.data?.sessionID === this.sessionID) {
      this.turn.clear();
      this.started.clear();
      return;
    }
    const arm = KINDS[ev.type];
    const d = ev.data ?? {};
    if (!arm || !this.journal || d.sessionID !== this.sessionID || typeof d.assistantMessageID !== "string" || typeof d.ordinal !== "number") return;
    if (arm.kind === "reasoning" && !this.reasoning) return;
    const key = streamKey2(d.assistantMessageID, arm.kind, d.ordinal);
    if (arm.step === "started") {
      if ((ev.created ?? 0) >= this.openedAt) this.started.add(key);
      return;
    }
    if (!this.started.has(key) || typeof d.delta !== "string" || d.delta.length === 0) return;
    this.turn.add(key);
    this.journal.append({ key, kind: arm.kind, text: d.delta });
  }

  /**
   * The turn ended with the session at `end`: end every element it streamed there, before the run
   * closes, because a run cannot close while a streamed message is open. Anchored at the session's
   * end, the line follows every saved element of the turn, and the reader leaves alone an element its
   * saved record closed.
   */
  turnEnded(end: string): void {
    const keys = [...this.turn];
    this.turn.clear();
    this.started.clear();
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

  private stepStarted(ev: StreamEvent2): void {
    const message = ev.data?.assistantMessageID;
    if (!this.session || ev.data?.sessionID !== this.sessionID || typeof message !== "string" || (ev.created ?? 0) < this.openedAt) return;
    const step: { message: string; before?: string } = { message };
    this.step = step;
    this.session.before(message).then(
      (at) => {
        step.before = at;
      },
      (e: Error) => this.onError(new Error(`the position before step ${message} could not be read: ${e.message}`)),
    );
  }
}
