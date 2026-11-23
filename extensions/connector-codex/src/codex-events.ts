/**
 * The Codex seat's event plane: one binding per bound rollout. Its holder reads the rollout with
 * the thread's delta journal, where the host journals an agent message's text as Codex streams it,
 * so a reply streams on the seat's events channel before Codex saves it.
 */
import { randomUUID } from "node:crypto";
import { principalKey } from "@cotal-ai/core";
import {
  AguiEmitter,
  AguiEmitterHolder,
  DeltaJournal,
  DeltaMergedSource,
  eventPlaneStopped,
  EventWal,
  FileSubjectFrontier,
  JsonlFileSource,
  ensureEventWalDir,
  resolveEventsStateRoot,
  streamSeed,
  type configFromEnv,
  type DurableSource,
  type Merged,
  type MeshAgent,
  type SourceRead,
} from "@cotal-ai/connector-core";
import { codexStreamKey, createCodexMapper, type CodexMapper, type CodexRecord } from "./agui-map.js";

/**
 * The rollout source, positioned where the BIND was taken rather than where the emitter's own
 * setup finished.
 *
 * A log with no cursor means "start at the current end", and for this connector the current end is
 * the wrong end. The emitter is built lazily inside `adopt`, and between the bind and its first
 * read sit the write-ahead log's directory, the subject frontier, the log itself, a channel
 * resolve and a single-replica preflight: filesystem and broker work, measured at 17ms and 36ms on
 * an idle machine. Every record the session appends while that runs would land behind the later
 * end and be treated as already published, so a turn completing inside the window is dropped,
 * permanently and silently, under a line that has already announced the stream as started.
 *
 * So the boundary is captured at the bind, before the announcement, and substituted HERE, on the
 * one read that would otherwise ask the file where it currently ends.
 *
 * THE LIMIT, stated once and in one place: this positions the first read of a log that has no
 * cursor. A log that already carries one is a resume and passes through untouched, because a
 * cursor written by a live emitter is the honest one. Each bind builds its own source with its own
 * boundary, so a later bind never reuses an older one.
 */
class BoundStartSource<T> implements DurableSource<T> {
  readonly kind: string;

  /** The boundary this wrapper captured, exposed so its OWNER can persist the boundary the SOURCE
   *  itself substitutes rather than a copy captured beside it. Two sources of truth would
   *  drift exactly when one of them is removed. */
  readonly start: string;

  constructor(
    private readonly inner: DurableSource<T>,
    start: string,
  ) {
    this.kind = inner.kind;
    this.start = start;
  }

  read(cursor: string | undefined): Promise<SourceRead<T>> {
    return this.inner.read(cursor ?? this.start);
  }

  end(): Promise<string> {
    return this.inner.end();
  }
}

interface BindingOptions {
  agent: MeshAgent;
  config: ReturnType<typeof configFromEnv>;
  log: (msg: string) => void;
  meshReadyTimeoutMs: number;
  /** Test-only waits, zero outside a test; see {@link codexEventBindings}. */
  startDelayMs: number;
  postStartHoldMs: number;
}

/** One bound rollout: the holder that publishes it, and the journal its agent messages stream into. */
export class CodexEventBinding {
  readonly holder: AguiEmitterHolder<Merged<CodexRecord>>;
  private readonly harness: JsonlFileSource<CodexRecord>;
  private journal?: DeltaJournal;
  private merged?: DeltaMergedSource<CodexRecord>;
  private mapper?: CodexMapper;
  /** Agent messages and reasoning summaries with text in the journal that Codex has not finished. */
  private readonly streaming = new Set<string>();
  /** Messages that began before the journal opened. None of their text is journaled, so no stream
   *  opens partway through a message. */
  private readonly unjournaled = new Set<string>();

  constructor(
    rolloutPath: string,
    private readonly startCursor: string,
    private readonly o: BindingOptions,
  ) {
    this.harness = new JsonlFileSource<CodexRecord>(rolloutPath);
    this.holder = new AguiEmitterHolder<Merged<CodexRecord>>((path: string) => this.start(path), {
      onError: eventPlaneStopped({ log: o.log }),
      // Before the first start opens the journal, nothing is journaled, so the rollout's end is
      // the whole position. The merged source reads a rollout cursor alone as that position.
      sourceEnd: () => this.merged?.end() ?? this.harness.end(),
      // A turn terminal closes a run the record stream never described. Without this the mapper
      // would attribute the next records to a run the published stream has already finished.
      onRunClosed: (runId: string) => this.mapper?.forgetOpenRun(runId),
    });
  }

  /** Journal a piece of the agent message or reasoning summary `itemId` that Codex is streaming. */
  delta(itemId: string, text: string, kind: "text" | "reasoning"): void {
    if (this.journal === undefined) this.unjournaled.add(itemId);
    if (this.journal === undefined || this.unjournaled.has(itemId)) return;
    this.streaming.add(itemId);
    this.journal.append({ key: codexStreamKey(itemId), kind, text });
  }

  /** Codex finished the item `itemId`: the record it saves carries the text not journaled yet. */
  settle(itemId: string): void {
    this.unjournaled.delete(itemId);
    if (this.streaming.delete(itemId)) this.journal?.settle();
  }

  /** End the streams that no saved record will close. Call it before closing the run out of band,
   *  because a run cannot close while a streamed message is open. */
  abandon(): void {
    if (this.journal !== undefined && this.streaming.size > 0) this.journal.abandon([...this.streaming].map(codexStreamKey));
    this.streaming.clear();
  }

  /** Release the journal once the holder is drained. */
  close(): void {
    this.journal?.close();
    this.journal = undefined;
  }

  /** The thread's journal, opened once per binding. A written line wakes the emitter. */
  private openJournal(path: string, rolloutPath: string): DeltaMergedSource<CodexRecord> {
    this.journal ??= DeltaJournal.open({
      path,
      anchor: () => this.harness.endSync(),
      onWrite: () => this.holder.flush(rolloutPath),
      onError: (e) => this.o.log(`AG-UI: streamed text could not be journaled, the saved message carries it: ${e.message}`),
    });
    this.merged ??= new DeltaMergedSource(this.harness, path);
    return this.merged;
  }

  private async start(rolloutPath: string): Promise<AguiEmitter<Merged<CodexRecord>>> {
    const { agent, config, log } = this.o;
    // The test-only widening of this setup, at the top of it so a fixture's write lands in the
    // real window rather than beside it. Zero unless a test set it, and zero does not await.
    if (this.o.startDelayMs > 0) await new Promise<void>((r) => setTimeout(r, this.o.startDelayMs));
    // The launch binds while `agent.start()` is still connecting in the background, and a start
    // against an unconnected endpoint is terminal for the holder, so it waits for the mesh as
    // the OpenCode and Claude Code holders do.
    await agent.whenConnected(this.o.meshReadyTimeoutMs);
    // Throws rather than defaulting to the working directory: a write-ahead log written
    // somewhere no later start looks is a silent loss.
    const workspaceRoot = resolveEventsStateRoot(process.env);
    // The thread id is the rollout filename key, MEASURED equal to `session_meta.payload.id`
    // and to the `thread/start` id on a real app-server thread. Taken from the path this
    // emitter actually reads, so the log cannot be keyed to one thread while consuming
    // another's bytes.
    const threadId = (rolloutPath.match(/rollout-.*?-([0-9a-f-]{36})\.jsonl$/)?.[1]) ?? "";
    if (threadId === "") throw new Error(`cannot derive a thread id from rollout path ${rolloutPath}`);
    const principal = principalKey(agent.ep.principal.owner, agent.ep.principal.actor).key;
    const { walPath, subjectPath, deltaJournalPath } = await ensureEventWalDir({ workspaceRoot, space: config.space, principal, threadId });
    const subjectFrontier = await FileSubjectFrontier.open(subjectPath, { space: config.space, principal });
    const wal = await EventWal.open(walPath, { space: config.space, threadId, principal, subjectMayExist: false });
    const merged = this.openJournal(deltaJournalPath, rolloutPath);
    // `AguiEmitter.start` settles `pending` before the first pump. Seed the mapper from the
    // bracket state that will exist AFTER that recovery, not from the folded state before it:
    // a pending terminal closes the WAL's run without passing through this new mapper.
    const brackets = wal.pending === null ? wal.brackets : wal.pending.brackets;
    const at = wal.pending === null ? wal.frontier.sourceCursor : wal.pending.sourceCursor;
    const seed = await streamSeed(deltaJournalPath, at, brackets);
    const mapper = createCodexMapper({ threadId, mintRunId: () => randomUUID(), resumeRunId: brackets?.run, seed });
    this.mapper = mapper;
    // `startCursor` is the boundary this bind captured before it announced itself. Nothing
    // above writes it into the log: see `BoundStartSource` for what that buys and what it
    // costs. The wrapper is held in a variable rather than inlined because the persist below
    // keys on IT, so removing the boundary substitution removes the persist with it
    // instead of leaving an outer copy that keeps writing the same value.
    const source = new BoundStartSource<Merged<CodexRecord>>(merged, merged.start(this.startCursor));
    const em = await AguiEmitter.start<Merged<CodexRecord>>({
      withholdPayloads: config.eventPayloadsWithheld,
      endpoint: agent.ep,
      wal,
      subjectFrontier,
      source,
      map: mapper.mapMerged,
      onUnreadable: (gap) =>
        log(`AG-UI source: skipped an unreadable ${gap.file ? "delta journal line" : "rollout record"} at offset ${gap.offset} (${gap.bytes} bytes): ${gap.reason}`),
    });
    // Persist the boundary THE SOURCE SUBSTITUTES into the log right after a successful
    // start, and only when the log still has no cursor. Keyed on the wrapper itself, never on
    // the outer `startCursor`, because the invariant that matters is "what the emitter will
    // read is what the log now says", and only the source object knows the first half.
    // After start is safe because `AguiEmitter.start` awaits `recover()`, which settles any
    // pending frame before returning, so `advanceCursorOnly` never races a pending write.
    // Without this, a host killed between this line and the emitter's first pump leaves a
    // virgin log, and the next bind takes its boundary at the file's later end, dropping
    // whatever the thread appended in between.
    if (source instanceof BoundStartSource && wal.frontier.sourceCursor === undefined)
      await wal.advanceCursorOnly(source.start);
    // Test-only: holds the window between the persist above and the first pump open so a
    // fixture can read the log there. Unset is no wait and no call.
    if (this.o.postStartHoldMs > 0) await new Promise<void>((r) => setTimeout(r, this.o.postStartHoldMs));
    return em;
  }
}

/** Builds a new binding for each bind. `startCursor` is the rollout boundary the bind captured. */
export function codexEventBindings(
  agent: MeshAgent,
  config: ReturnType<typeof configFromEnv>,
  o: { log: (msg: string) => void; meshReadyTimeoutMs: number },
): (rolloutPath: string, startCursor: string) => CodexEventBinding {
  /** TEST ONLY, and the reason it exists rather than a fixture doing this from outside.
   *
   *  The window this whole boundary rule is about is the emitter's own asynchronous setup: the
   *  bind captures where the stream starts, announces it, and only then does the setup below run
   *  and the first read happen. That window is a few tens of milliseconds wide, which is not a
   *  window a test can put a completed turn inside on purpose, so the only cell that could grade
   *  the rule was one that raced it and therefore graded nothing reliably. This widens the same
   *  window instead of simulating a different one, so what a fixture writes into it is what the
   *  running seat would have written into it.
   *
   *  Nothing outside a test sets this, and unset is not a shorter wait, it is no wait and no call:
   *  absent, empty, zero, negative, and unparseable all resolve to 0 and the branch below is not
   *  taken. */
  let startDelayMs = ((): number => {
    const ms = Number(process.env.COTAL_EVENTS_TEST_START_DELAY_MS ?? "");
    return Number.isFinite(ms) && ms > 0 ? ms : 0;
  })();
  // Test-only: holds the window between the persist and the first pump open so a fixture can
  // read the log there. Unset is no wait and no call.
  let postStartHoldMs = ((): number => {
    const ms = Number(process.env.COTAL_EVENTS_TEST_POST_START_HOLD_MS ?? "");
    return Number.isFinite(ms) && ms > 0 ? ms : 0;
  })();
  return (rolloutPath: string, startCursor: string): CodexEventBinding => {
    // The widening belongs to the first bind only: a restart's holder must exercise the ordinary
    // startup path, and repeating the test delay there adds no coverage.
    const binding = new CodexEventBinding(rolloutPath, startCursor, { agent, config, ...o, startDelayMs, postStartHoldMs });
    startDelayMs = 0;
    postStartHoldMs = 0;
    return binding;
  };
}
