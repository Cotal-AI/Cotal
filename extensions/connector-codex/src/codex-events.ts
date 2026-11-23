/**
 * The Codex seat's event-plane holders: one per bound rollout, each reading the rollout through
 * the mapper and publishing on the seat's events channel.
 */
import { randomUUID } from "node:crypto";
import { principalKey } from "@cotal-ai/core";
import {
  AguiEmitter,
  AguiEmitterHolder,
  eventPlaneStopped,
  EventWal,
  FileSubjectFrontier,
  JsonlFileSource,
  ensureEventWalDir,
  resolveEventsStateRoot,
  type configFromEnv,
  type DurableSource,
  type MeshAgent,
  type SourceRead,
} from "@cotal-ai/connector-core";
import { createCodexMapper, type CodexMapper, type CodexRecord } from "./agui-map.js";

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

/** Builds a new holder for each bind. `startCursor` is the boundary the bind captured. */
export function codexEventHolders(
  agent: MeshAgent,
  config: ReturnType<typeof configFromEnv>,
  o: { log: (msg: string) => void; meshReadyTimeoutMs: number },
): (startCursor: string) => AguiEmitterHolder<CodexRecord> {
  const { log } = o;
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
  let mapper: CodexMapper | undefined;
  return (startCursor: string): AguiEmitterHolder<CodexRecord> => {
    // The widening belongs to the first bind only: a restart's holder must exercise the ordinary
    // startup path, and repeating the test delay there adds no coverage.
    const holderStartDelayMs = startDelayMs;
    startDelayMs = 0;
    const holderPostStartHoldMs = postStartHoldMs;
    postStartHoldMs = 0;
    return new AguiEmitterHolder<CodexRecord>(
      async (rolloutPath: string) => {
        // The test-only widening of this setup, at the top of it so a fixture's write lands in the
        // real window rather than beside it. Zero unless a test set it, and zero does not await.
        if (holderStartDelayMs > 0) await new Promise<void>((r) => setTimeout(r, holderStartDelayMs));
        // The launch binds while `agent.start()` is still connecting in the background, and a start
        // against an unconnected endpoint is terminal for the holder, so it waits for the mesh as
        // the OpenCode and Claude Code holders do.
        await agent.whenConnected(o.meshReadyTimeoutMs);
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
        const { walPath, subjectPath } = await ensureEventWalDir({ workspaceRoot, space: config.space, principal, threadId });
        const subjectFrontier = await FileSubjectFrontier.open(subjectPath, { space: config.space, principal });
        const wal = await EventWal.open(walPath, { space: config.space, threadId, principal, subjectMayExist: false });
        // `AguiEmitter.start` settles `pending` before the first pump. Seed the mapper from the
        // bracket state that will exist AFTER that recovery, not from the folded state before it:
        // a pending terminal closes the WAL's run without passing through this new mapper.
        const resumeRunId = wal.pending === null ? wal.brackets?.run : wal.pending.brackets.run;
        mapper = createCodexMapper({ threadId, mintRunId: () => randomUUID(), resumeRunId });
        // `startCursor` is the boundary this bind captured before it announced itself. Nothing
        // above writes it into the log: see `BoundStartSource` for what that buys and what it
        // costs. The wrapper is held in a variable rather than inlined because the persist below
        // keys on IT, so removing the boundary substitution removes the persist with it
        // instead of leaving an outer copy that keeps writing the same value.
        const source = new BoundStartSource<CodexRecord>(new JsonlFileSource<CodexRecord>(rolloutPath), startCursor);
        const em = await AguiEmitter.start<CodexRecord>({
          withholdPayloads: config.eventPayloadsWithheld,
          endpoint: agent.ep,
          wal,
          subjectFrontier,
          source,
          map: mapper.map,
          onUnreadable: (gap) => log(`AG-UI source: skipped an unreadable rollout record at offset ${gap.offset} (${gap.bytes} bytes): ${gap.reason}`),
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
        if (holderPostStartHoldMs > 0)
          await new Promise<void>((r) => setTimeout(r, holderPostStartHoldMs));
        return em;
      },
      {
        onError: eventPlaneStopped({ log }),
        sourceEnd: (rolloutPath: string) => new JsonlFileSource<CodexRecord>(rolloutPath).end(),
        // A turn terminal closes a run the record stream never described. Without this the mapper
        // would attribute the next records to a run the published stream has already finished.
        onRunClosed: (runId: string) => mapper?.forgetOpenRun(runId),
      },
    );
  };
}
