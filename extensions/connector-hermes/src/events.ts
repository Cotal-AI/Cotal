import { randomUUID } from "node:crypto";
import { basename } from "node:path";
import { principalKey } from "@cotal-ai/core";
import {
  AguiEmitter,
  AguiEmitterHolder,
  DeltaJournal,
  DeltaMergedSource,
  EventWal,
  FileSubjectFrontier,
  JsonlFileSource,
  ensureEventWalDir,
  eventPlaneStopped,
  resolveEventsStateRoot,
  streamSeed,
  type AgentConfig,
  type Merged,
  type MeshAgent,
  type PrincipalLock,
} from "@cotal-ai/connector-core";
import { createHermesMapper, type HermesJournalRecord } from "./agui-map.js";

function log(line: string): void {
  process.stderr.write(`[cotal-hermes/events] ${line}\n`);
}

/** The merged records from `beginning` up to and including the one at `cursor`: what the event plane
 *  consumed. */
async function consumedRecords(source: DeltaMergedSource<HermesJournalRecord>, beginning: string, cursor: string): Promise<Merged<HermesJournalRecord>[]> {
  if (cursor === beginning) return [];
  const read = await source.read(beginning);
  const at = read.records.findIndex((r) => r.cursor === cursor);
  if (at < 0) throw new Error("Hermes AG-UI: the turn journal does not hold the record the event plane acknowledged");
  return read.records.slice(0, at + 1).map((r) => r.value);
}

/** What {@link startHermesEvents} returns: the holder to wake, the stream writer, and the release
 *  for a stop. */
export interface HermesEvents {
  holder: AguiEmitterHolder<Merged<HermesJournalRecord>>;
  /** Text a reply added under stream `key`; with no text, the end of a stream no saved response
   *  closes. Dropped before the plane first started: the saved response carries the text. */
  delta(key: string, text?: string): void;
  close(): Promise<void>;
}

/**
 * Publish the seat's AG-UI event plane from the plugin's turn journal (plugin/cotal/journal.py).
 *
 * The journal is new for each launch, created empty by the launcher before the gateway starts, so
 * the plane reads it from its first record and its name is the thread id. The text a reply streams
 * before it is saved goes to a delta journal beside the plane's log, anchored at the turn journal's
 * end, and the plane reads the two merged. A wake (any hook event, any delta line) flushes the
 * holder; the files are the data path.
 */
export function startHermesEvents(agent: MeshAgent, config: AgentConfig, journal: string): HermesEvents {
  const threadId = basename(journal, ".jsonl");
  const harness = new JsonlFileSource<HermesJournalRecord>(journal);
  let lock: PrincipalLock | undefined;
  let deltas: DeltaJournal | undefined;
  let merged: DeltaMergedSource<HermesJournalRecord> | undefined;
  // The merged cursor before any record, taken when the delta journal is opened, empty.
  let beginning: string | undefined;
  const holder = new AguiEmitterHolder<Merged<HermesJournalRecord>>(
    async () => {
      await agent.waitUntilConnected();
      const workspaceRoot = resolveEventsStateRoot(process.env);
      const principal = principalKey(agent.ep.principal.owner, agent.ep.principal.actor).key;
      const location = await ensureEventWalDir({ workspaceRoot, space: config.space, principal, threadId });
      lock = location.lock;
      if (!merged) {
        deltas = DeltaJournal.open({
          path: location.deltaJournalPath,
          anchor: () => harness.endSync(),
          onWrite: () => holder.flush(journal),
          onError: (e) => log(`streamed text could not be journaled, so it arrives with the saved response: ${e.message}`),
        });
        merged = new DeltaMergedSource(harness, location.deltaJournalPath);
        beginning = merged.start(await harness.cursorAtBeginning());
      }
      const subjectFrontier = await FileSubjectFrontier.open(location.subjectPath, { space: config.space, principal });
      const wal = await EventWal.open(location.walPath, { space: config.space, principal, threadId, subjectMayExist: false });
      if (wal.frontier.sourceCursor === undefined) await wal.advanceCursorOnly(beginning!);
      // A pending frame is settled by start(), so the plane resumes after it, with its brackets.
      const resume = wal.pending ?? { sourceCursor: wal.frontier.sourceCursor!, brackets: wal.brackets };
      const map = createHermesMapper({
        threadId,
        mintRunId: () => randomUUID(),
        consumed: await consumedRecords(merged, beginning!, resume.sourceCursor),
        resumeRunId: resume.brackets?.run,
        seed: await streamSeed(location.deltaJournalPath, resume.sourceCursor, resume.brackets ?? null),
        reasoning: config.reasoningEvents,
      });
      return AguiEmitter.start({
        endpoint: agent.ep,
        withholdPayloads: config.eventPayloadsWithheld,
        wal,
        subjectFrontier,
        source: merged,
        map,
        onUnreadable: (gap) => log(`skipped an unreadable journal record at offset ${gap.offset} (${gap.bytes} bytes): ${gap.reason}`),
      });
    },
    {
      onError: eventPlaneStopped({ log }),
      sourceEnd: () => {
        if (!merged) throw new Error("Hermes AG-UI: the event plane has not started");
        return merged.end();
      },
    },
  );
  holder.adopt(journal);
  holder.flush(journal);
  return {
    holder,
    delta(key, text) {
      if (text === undefined) deltas?.abandon([key]);
      else deltas?.append({ key, kind: "text", text });
    },
    async close() {
      await holder.close();
      deltas?.close();
      deltas = undefined;
      await lock?.release();
    },
  };
}
