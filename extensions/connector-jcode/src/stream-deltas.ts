/**
 * Jcode's live text and reasoning, journaled so a reply streams on the event plane before Jcode saves
 * it. Jcode saves one assistant message per provider call and reports the call's usage just before,
 * so each kind streams under one key per call, which the mapper pairs with that message's first part
 * of the kind. A provider retry inside the call keeps the key: the saved text then does not continue
 * the stream, and it publishes as a message of its own.
 */
import { randomUUID } from "node:crypto";
import type { ApiEvent, JcodeClient } from "@1jehuang/jcode-sdk";
import { DeltaJournal, type DeltaJournalOptions, type StreamDelta } from "@cotal-ai/connector-core";

export class JcodeDeltaStream {
  private journal: DeltaJournal | undefined;
  private threadId = "";
  private keys: Partial<Record<StreamDelta["kind"], string>> = {};
  private readonly turn = new Set<string>();

  /** Journal from now on, under keys of `threadId`. The event plane calls it each time it binds; the
   *  journal opens once. */
  open(threadId: string, opts: DeltaJournalOptions): void {
    if (this.journal) return;
    this.journal = DeltaJournal.open(opts);
    this.threadId = threadId;
  }

  /** Journal the deltas `client` reports for the seat's session. */
  watch(client: JcodeClient, session: () => string | undefined): void {
    const mine = (event: ApiEvent): boolean => "session_id" in event && event.session_id === session();
    client.on("text_delta", (event: ApiEvent) => {
      if (mine(event) && event.ev === "text_delta") this.delta("text", event.text);
    });
    client.on("reasoning_delta", (event: ApiEvent) => {
      if (mine(event) && event.ev === "reasoning_delta") this.delta("reasoning", event.text);
    });
    client.on("token_usage", (event: ApiEvent) => {
      if (mine(event)) this.keys = {};
    });
  }

  private delta(kind: StreamDelta["kind"], text: string): void {
    if (!this.journal || text.length === 0) return;
    const key = (this.keys[kind] ??= `${this.threadId}:stream:${randomUUID()}`);
    this.turn.add(key);
    this.journal.append({ key, kind, text });
  }

  /**
   * The turn ended: end every part it streamed, before the run closes. Jcode saves no reply for a
   * provider call that failed, so nothing else would close that part, and the run cannot close while
   * it is open. A part a saved reply closed is left alone by the reader.
   */
  turnEnded(): void {
    const keys = [...this.turn];
    this.keys = {};
    this.turn.clear();
    if (this.journal && keys.length > 0) this.journal.abandon(keys);
  }

  close(): void {
    this.journal?.close();
    this.journal = undefined;
  }
}
