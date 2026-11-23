import { principalKey } from "@cotal-ai/core";
import { existsSync } from "node:fs";
import {
  AguiEmitter, AguiEmitterHolder, DeltaJournal, DeltaMergedSource, EventWal, FileSubjectFrontier,
  ensureEventWalDir, resolveEventsStateRoot, streamSeed, type HeldEventWalLocation, type Merged, type MeshAgent, type PrincipalLock,
} from "@cotal-ai/connector-core";
import { createPiMapper, piStreamKey, type PiSessionEntry } from "./agui-map.js";
import { PiSessionSource } from "./agui-source.js";

const FIRST_FILE = "pi:first-file";

/** The fields of Pi's `message_update` event a delta is taken from. */
interface PiStreamUpdate {
  type: string;
  contentIndex?: number;
  delta?: string;
  partial?: { timestamp: number; content?: ReadonlyArray<{ type?: string; redacted?: boolean }> };
}

/** What one adopted native session reads: Pi's file merged with the deltas its replies streamed. */
interface Adopted {
  source: DeltaMergedSource<PiSessionEntry>;
  journalPath: string;
}

/** One holder per native session. The file is the source, while hooks only wake its reader. */
export class PiEvents {
  private holder?: AguiEmitterHolder<Merged<PiSessionEntry>>;
  private lock?: PrincipalLock;
  private deltas?: DeltaJournal;
  private sessionId?: string;
  private path?: string;
  private pending: Promise<void> = Promise.resolve();
  private closing = false;

  /** @param stopped Told of each failure that stopped this seat's event plane, with the delay before
   *  the holder re-establishes it (`0` for at once), or `null` for a failure of this adapter's own
   *  that no holder retries. */
  constructor(
    private readonly mesh: MeshAgent,
    private readonly space: string,
    private readonly stopped: (error: Error, retryInMs: number | null) => void,
    private readonly withholdPayloads = false,
    private readonly reasoning = false,
  ) {}

  async start(sessionId: string, path: string | undefined, freshSession = false): Promise<void> {
    if (this.closing) return;
    if (!path) {
      this.fail(new Error("Pi AG-UI: persistent native session file is required"));
      return;
    }
    const step = this.pending.then(async () => {
      if (this.sessionId === sessionId && this.path === path) return; // reload of the same native session
      await this.release();
      this.sessionId = sessionId;
      this.path = path;
      const existed = existsSync(path);
      const adopted = await this.adopt(sessionId, path);
      if (!existed && freshSession) await this.prepareFirstFile(sessionId, adopted.source);
      if (existed) await this.prepareExistingFile(sessionId, path, adopted.source);
      const holder = this.newHolder(sessionId, path, !existed && freshSession, adopted);
      this.holder = holder;
      holder.adopt(path);
      if (existsSync(path)) holder.flush(path);
    });
    this.pending = step.catch((error: Error) => this.fail(error));
    await this.pending;
  }

  flush(sessionId: string, path: string | undefined): void {
    if (this.closing) return;
    if (!path) {
      this.fail(new Error("Pi AG-UI: persistent native session file is required"));
      return;
    }
    const step = this.pending.then(async () => {
      if (this.sessionId !== sessionId || this.path !== path) throw new Error("Pi AG-UI: turn belongs to an unadopted session");
      if (!this.holder) throw new Error("Pi AG-UI: no emitter was adopted before the turn");
      // A failure inside the holder reaches `stopped` through the holder's own sink, and the holder
      // re-establishes the plane itself; it is not rethrown here, which would report it twice.
      this.holder.flush(path);
      await this.holder.settled();
    });
    this.pending = step.catch((error: Error) => this.fail(error));
  }

  /** A piece of the reply Pi is streaming. Thinking is journaled only when reasoning is published,
   *  and never once its block is redacted: Pi then streams a placeholder, not the model's reasoning. */
  delta(update: PiStreamUpdate): void {
    if (this.closing || !this.deltas || update.partial === undefined || update.contentIndex === undefined || update.delta === undefined) return;
    const at = (kind: "text" | "thinking") => piStreamKey(update.partial!.timestamp, kind, update.contentIndex!);
    if (update.type === "text_delta") this.deltas.append({ key: at("text"), kind: "text", text: update.delta });
    else if (update.type === "thinking_delta" && this.reasoning && !update.partial.content?.[update.contentIndex]?.redacted)
      this.deltas.append({ key: at("thinking"), kind: "reasoning", text: update.delta });
  }

  /** Pi is about to save a message: its record carries the text not journaled yet. */
  settle(): void {
    this.deltas?.settle();
  }

  async shutdown(): Promise<void> {
    this.closing = true;
    await this.pending;
    await this.release();
    this.closing = false;
  }

  private async release(): Promise<void> {
    const holder = this.holder;
    this.holder = undefined;
    if (holder) await holder.close();
    this.deltas?.close();
    this.deltas = undefined;
    const lock = this.lock;
    this.lock = undefined;
    if (lock) await lock.release();
    this.sessionId = undefined;
    this.path = undefined;
  }

  /** The thread's WAL directory, holding this principal's lock. */
  private async walDir(threadId: string): Promise<HeldEventWalLocation> {
    const workspaceRoot = resolveEventsStateRoot(process.env);
    const principal = principalKey(this.mesh.ep.principal.owner, this.mesh.ep.principal.actor).key;
    const loc = await ensureEventWalDir({ workspaceRoot, space: this.space, principal, threadId });
    this.lock = loc.lock;
    return loc;
  }

  /** Open the session's delta journal before anything positions on it. A written line wakes the
   *  emitter, and a line that cannot be written stops the plane by name. */
  private async adopt(sessionId: string, path: string): Promise<Adopted> {
    const harness = new PiSessionSource(path);
    const { deltaJournalPath } = await this.walDir(sessionId);
    this.deltas = DeltaJournal.open({
      path: deltaJournalPath,
      anchor: () => harness.anchor(),
      onWrite: () => this.flush(sessionId, path),
      onError: (error) => this.fail(new Error(`Pi AG-UI: streamed text could not be journaled: ${error.message}`)),
    });
    return { source: new DeltaMergedSource(harness, deltaJournalPath), journalPath: deltaJournalPath };
  }

  private async openWal(threadId: string): Promise<{ wal: EventWal; subjectPath: string }> {
    const { walPath, subjectPath } = await this.walDir(threadId);
    const principal = principalKey(this.mesh.ep.principal.owner, this.mesh.ep.principal.actor).key;
    return { wal: await EventWal.open(walPath, { space: this.space, principal, threadId, subjectMayExist: false }), subjectPath };
  }

  /** A file-free native session needs its durable start cursor before Pi may save its first answer.
   * This is local filesystem work only: no broker dial or AG-UI preflight blocks the host hook. */
  private async prepareFirstFile(threadId: string, source: DeltaMergedSource<PiSessionEntry>): Promise<void> {
    const { wal } = await this.openWal(threadId);
    if (wal.frontier.sourceCursor === undefined) await wal.advanceCursorOnly(source.start(FIRST_FILE));
    if (source.harnessOf(wal.frontier.sourceCursor!) !== FIRST_FILE && wal.frontier.seq === 0)
      throw new Error("Pi AG-UI: fresh native session has a different source boundary");
  }

  /** A resumed/forked native file can already contain history. Capture its end before allowing
   * the next turn to append. An acknowledged WAL cursor takes precedence on a process restart. */
  private async prepareExistingFile(threadId: string, path: string, source: DeltaMergedSource<PiSessionEntry>): Promise<void> {
    const { wal } = await this.openWal(threadId);
    if (wal.frontier.sourceCursor === undefined)
      await wal.advanceCursorOnly(source.start((await new PiSessionSource(path).read(undefined)).cursor));
  }

  private newHolder(sessionId: string, path: string, freshFile: boolean, adopted: Adopted): AguiEmitterHolder<Merged<PiSessionEntry>> {
    const { source, journalPath } = adopted;
    return new AguiEmitterHolder<Merged<PiSessionEntry>>(async () => {
      await this.mesh.waitUntilConnected();
      if (!freshFile && !existsSync(path))
        throw new Error("Pi AG-UI: resumed native session file does not exist; refusing to classify copied history as a fresh turn");
      const principal = principalKey(this.mesh.ep.principal.owner, this.mesh.ep.principal.actor).key;
      const { wal, subjectPath } = await this.openWal(sessionId);
      const subjectFrontier = await FileSubjectFrontier.open(subjectPath, { space: this.space, principal });
      // A re-establish starts this factory again with the cursor the first turns acknowledged, so
      // an acknowledged cursor alone no longer says the file vanished; the file does (Sol, review
      // of 2026-10-12: the first cut threw here on every re-establish of a new session).
      const acknowledged = wal.frontier.sourceCursor;
      if (freshFile && acknowledged !== undefined && source.harnessOf(acknowledged) !== FIRST_FILE && !existsSync(path))
        throw new Error("Pi AG-UI: native session file vanished after an event cursor was acknowledged");
      // For an existing transcript, capture its boundary before subsequent turns. A restart keeps
      // its acknowledged cursor. A new file is read from its beginning to retain the first turn.
      if (acknowledged === undefined)
        await wal.advanceCursorOnly(source.start(freshFile ? FIRST_FILE : (await new PiSessionSource(path).read(undefined)).cursor));
      // Seeded from the pending frame when there is one: `start` settles that frame, and its
      // brackets are the run, tool calls and streamed parts the wire will have open once it has.
      const brackets = wal.pending === null ? wal.brackets : wal.pending.brackets;
      const at = wal.pending === null ? wal.frontier.sourceCursor : wal.pending.sourceCursor;
      const map = createPiMapper(sessionId, brackets?.run, brackets?.tools, this.reasoning, await streamSeed(journalPath, at, brackets));
      return AguiEmitter.start({
        withholdPayloads: this.withholdPayloads,
        endpoint: this.mesh.ep, wal, subjectFrontier, source, map,
        onUnreadable: (gap) =>
          console.error(`Pi AG-UI source: skipped an unreadable ${gap.file ? "delta journal line" : "session record"} at offset ${gap.offset} (${gap.bytes} bytes): ${gap.reason}`),
      });
    }, { onError: (error, retryInMs) => this.stopped(error, retryInMs), sourceEnd: () => source.end() });
  }

  private fail(error: Error): void {
    this.stopped(error, null);
  }
}
