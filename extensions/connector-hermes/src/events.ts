import { randomUUID } from "node:crypto";
import { basename } from "node:path";
import { principalKey } from "@cotal-ai/core";
import {
  AguiEmitter,
  AguiEmitterHolder,
  EventWal,
  FileSubjectFrontier,
  JsonlFileSource,
  ensureEventWalDir,
  eventPlaneStopped,
  resolveEventsStateRoot,
  type AgentConfig,
  type MeshAgent,
  type PrincipalLock,
} from "@cotal-ai/connector-core";
import { createHermesMapper, type HermesJournalRecord } from "./agui-map.js";

function log(line: string): void {
  process.stderr.write(`[cotal-hermes/events] ${line}\n`);
}

/** The journal's records up to and including the one at `cursor`: what the event plane consumed. */
async function consumedRecords(source: JsonlFileSource<HermesJournalRecord>, cursor: string): Promise<HermesJournalRecord[]> {
  if (cursor === (await source.cursorAtBeginning())) return [];
  const read = await source.readFromBeginning();
  const at = read.records.findIndex((r) => r.cursor === cursor);
  if (at < 0) throw new Error("Hermes AG-UI: the turn journal does not hold the record the event plane acknowledged");
  return read.records.slice(0, at + 1).map((r) => r.value);
}

/** What {@link startHermesEvents} returns: the holder to wake, and the release for a stop. */
export interface HermesEvents {
  holder: AguiEmitterHolder<HermesJournalRecord>;
  close(): Promise<void>;
}

/**
 * Publish the seat's AG-UI event plane from the plugin's turn journal (plugin/cotal/journal.py).
 *
 * The journal is new for each launch, created empty by the launcher before the gateway starts, so
 * the plane reads it from its first record and its name is the thread id. A wake (any hook event)
 * flushes the holder; the file is the data path.
 */
export function startHermesEvents(agent: MeshAgent, config: AgentConfig, journal: string): HermesEvents {
  const threadId = basename(journal, ".jsonl");
  let lock: PrincipalLock | undefined;
  const holder = new AguiEmitterHolder<HermesJournalRecord>(
    async () => {
      await agent.waitUntilConnected();
      const workspaceRoot = resolveEventsStateRoot(process.env);
      const principal = principalKey(agent.ep.principal.owner, agent.ep.principal.actor).key;
      const location = await ensureEventWalDir({ workspaceRoot, space: config.space, principal, threadId });
      lock = location.lock;
      const subjectFrontier = await FileSubjectFrontier.open(location.subjectPath, { space: config.space, principal });
      const wal = await EventWal.open(location.walPath, { space: config.space, principal, threadId, subjectMayExist: false });
      const source = new JsonlFileSource<HermesJournalRecord>(journal);
      if (wal.frontier.sourceCursor === undefined) await wal.advanceCursorOnly(await source.cursorAtBeginning());
      // A pending frame is settled by start(), so the plane resumes after it, with its brackets.
      const resume = wal.pending ?? { sourceCursor: wal.frontier.sourceCursor!, brackets: wal.brackets };
      const map = createHermesMapper({
        threadId,
        mintRunId: () => randomUUID(),
        consumed: await consumedRecords(source, resume.sourceCursor),
        resumeRunId: resume.brackets?.run,
        reasoning: config.reasoningEvents,
      });
      return AguiEmitter.start({
        endpoint: agent.ep,
        withholdPayloads: config.eventPayloadsWithheld,
        wal,
        subjectFrontier,
        source,
        map,
        onUnreadable: (gap) => log(`skipped an unreadable journal record at offset ${gap.offset} (${gap.bytes} bytes): ${gap.reason}`),
      });
    },
    { onError: eventPlaneStopped({ log }), sourceEnd: (path) => new JsonlFileSource(path).end() },
  );
  holder.adopt(journal);
  holder.flush(journal);
  return {
    holder,
    async close() {
      await holder.close();
      await lock?.release();
    },
  };
}
