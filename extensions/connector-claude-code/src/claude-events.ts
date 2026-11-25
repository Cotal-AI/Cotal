import { randomUUID } from "node:crypto";
import { basename } from "node:path";
import { principalKey } from "@cotal-ai/core";
import {
  AguiEmitter, AguiEmitterHolder, DeltaMergedSource, EventWal, FileSubjectFrontier, StreamedParts, ensureEventWalDir,
  eventPlaneStopped, resolveEventsStateRoot, streamSeed, type AgentConfig, type DurableSource, type Merged, type MeshAgent,
} from "@cotal-ai/connector-core";
import { createClaudeMapper, type ClaudeEntry, type ClaudeMapper } from "./agui-map.js";
import { createBoundClaudeTranscriptSource } from "./agui-source.js";
import { OrderedTranscript, StreamJournal, primeStreamOrder, type ClaudeTextDelta } from "./claude-stream.js";

/** The session's AG-UI emitter holder, over the transcript merged with the delta journal. Before it
 *  closes a turn's run, it ends the streams of the turn no saved entry closed, so their end is read
 *  ahead of the terminal: a run does not close while a streamed part is open. */
export class ClaudeEventHolder extends AguiEmitterHolder<Merged<ClaudeEntry>, unknown> {
  /** Set by the plane that owns the journal. */
  endStreams: () => void = () => {};

  override closeRun(timestamp: number, error?: { message: string; code?: string }): Promise<void> {
    this.endStreams();
    return super.closeRun(timestamp, error);
  }
}

export interface ClaudeEventPlane {
  events: ClaudeEventHolder;
  /** Journal reply text the mod relayed. Dropped until the plane has adopted its transcript. */
  deltas(list: readonly ClaudeTextDelta[]): void;
  stop(): void;
}

/** The managed and personal native paths use the same transcript, WAL and recovery semantics. */
export function createClaudeEventPlane(agent: MeshAgent, config: AgentConfig, env: NodeJS.ProcessEnv,
  initialSource?: DurableSource<ClaudeEntry>): ClaudeEventPlane {
  const stop = new AbortController();
  const waitLive = (): Promise<void> => new Promise((resolve, reject) => {
    const release = () => {
      agent.off("connection", connected);
      agent.off("transport", connected);
      stop.signal.removeEventListener("abort", stopped);
    };
    const connected = () => { if (agent.connected && agent.transportConnected) { release(); resolve(); } };
    const stopped = () => { release(); reject(new Error("seat stopping while the mesh connection is down; unpublished events stay in the transcript")); };
    agent.on("connection", connected);
    agent.on("transport", connected);
    stop.signal.addEventListener("abort", stopped);
    if (stop.signal.aborted) stopped();
    else connected();
  });
  const principal = principalKey(agent.ep.principal.owner, agent.ep.principal.actor).key;
  const workspaceRoot = resolveEventsStateRoot(env);
  let source = initialSource;
  let mapper: ClaudeMapper | undefined;
  const journal = new StreamJournal({
    path: async (threadId) => (await ensureEventWalDir({ workspaceRoot, space: config.space, principal, threadId })).deltaJournalPath,
    wake: (path) => events.flush(path),
  });
  stop.signal.addEventListener("abort", () => journal.close());
  const events = new ClaudeEventHolder(async (transcriptPath, sessionSource) => {
    const s = await journal.open(transcriptPath);
    const merged = new DeltaMergedSource(new OrderedTranscript(source ??= await createBoundClaudeTranscriptSource(transcriptPath, sessionSource), transcriptPath), s.journalPath);
    await waitLive();
    const threadId = basename(transcriptPath, ".jsonl");
    const { walPath, subjectPath } = await ensureEventWalDir({ workspaceRoot, space: config.space, principal, threadId });
    const subjectFrontier = await FileSubjectFrontier.open(subjectPath, { space: config.space, principal });
    const wal = await EventWal.open(walPath, { space: config.space, threadId, principal, subjectMayExist: false });
    const brackets = wal.pending === null ? wal.brackets : wal.pending.brackets;
    const cursor = wal.frontier.sourceCursor;
    const stream = {
      order: await primeStreamOrder(transcriptPath, cursor === undefined ? undefined : merged.harnessOf(cursor)),
      parts: new StreamedParts(await streamSeed(s.journalPath, cursor, brackets ?? null)),
    };
    mapper = createClaudeMapper({ threadId, mintRunId: () => randomUUID(), resumeRunId: brackets?.run, reasoning: config.reasoningEvents, stream });
    return AguiEmitter.start<Merged<ClaudeEntry>>({ endpoint: agent.ep, withholdPayloads: config.eventPayloadsWithheld, wal, subjectFrontier, source: merged, map: mapper.mapMerged,
      onUnreadable: (gap) => process.stderr.write(
        `[cotal-connector] AG-UI source: skipped an unreadable transcript record at offset ${gap.offset} ` +
        `(${gap.bytes} bytes): ${gap.reason}\n`,
      ),
    });
  }, {
    onError: eventPlaneStopped({ log: (line) => process.stderr.write(`[cotal-connector] ${line}\n`) }),
    sourceEnd: async (path: string) => {
      const s = await journal.open(path);
      return new DeltaMergedSource(s.transcript, s.journalPath).end();
    },
    onRunClosed: (runId) => mapper?.forgetOpenRun(runId),
    waitLive,
  });
  events.endStreams = () => journal.endStreams();
  return {
    events,
    deltas: (list) => journal.deltas(list),
    stop: () => stop.abort(),
  };
}
