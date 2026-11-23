/**
 * The Jcode seat's event plane: the emitter holder over the seat's session journal, the lock on its
 * WAL directory, and the wait that rides out a mesh rebuild.
 */
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import {
  AguiEmitter,
  AguiEmitterHolder,
  eventPlaneStopped,
  EventWal,
  FileSubjectFrontier,
  ensureEventWalDir,
  type AgentConfig,
  type MeshAgent,
  type PrincipalLock,
} from "@cotal-ai/connector-core";
import { principalKey } from "@cotal-ai/core";
import { createJcodeMapper, type JcodeMapper, type PositionedJcodeJournalRecord } from "./agui-map.js";
import { initializeJcodeEventBoundary, JcodeJournalSource, jcodeJournalPath, positionedJcodeJournalSource } from "./agui-source.js";
import type { HostTurnState } from "./host-turns.js";
import type { ShortSocketHome } from "./private-state.js";
import { writeJcodeDiagnostic } from "./startup-diagnostics.js";

export function createJcodeEventPlane(opts: {
  agent: MeshAgent;
  config: AgentConfig;
  hostState: HostTurnState;
  socketHome: ShortSocketHome;
  eventsArmed: boolean;
  eventsWorkspaceRoot: string | undefined;
}) {
  const { agent, config, hostState, socketHome, eventsArmed, eventsWorkspaceRoot } = opts;
  let eventLock: PrincipalLock | undefined;
  let mapper: JcodeMapper | undefined;
  /** Aborted by `shutdown()`, so an event step waiting out a rebuild window cannot hold a stop. */
  const eventWaitStop = new AbortController();
  const events = eventsArmed
    ? new AguiEmitterHolder<PositionedJcodeJournalRecord>(
        async (journalPath: string) => {
          const workspaceRoot = eventsWorkspaceRoot!;
          if (!hostState.sessionId) throw new Error("jcode connector: cannot start AG-UI without a Harness session id");
          const threadId = hostState.sessionId;
          const expectedPath = jcodeJournalPath(socketHome.jcodeHome, threadId);
          if (resolve(journalPath) !== resolve(expectedPath))
            throw new Error(`jcode connector: event source ${journalPath} does not belong to session ${threadId}`);
          const principal = principalKey(agent.ep.principal.owner, agent.ep.principal.actor).key;
          const { walPath, subjectPath, lock } = await ensureEventWalDir({ workspaceRoot, space: config.space, principal, threadId });
          eventLock = lock;
          const subjectFrontier = await FileSubjectFrontier.open(subjectPath, { space: config.space, principal });
          const wal = await EventWal.open(walPath, { space: config.space, threadId, principal, subjectMayExist: false });
          // Persist the pre-public boundary before start returns. drive() waits for this factory, so
          // no requested turn can append past an unacknowledged boundary. On restart an existing WAL
          // wins over the current journal end and replays everything appended after that cursor.
          await initializeJcodeEventBoundary(journalPath, wal);
          const resumeBrackets = wal.pending === null ? wal.brackets : wal.pending.brackets;
          mapper = createJcodeMapper({ threadId, mintRunId: () => randomUUID(), resumeRunId: resumeBrackets?.run, resumeTools: resumeBrackets?.tools });
          return AguiEmitter.start<PositionedJcodeJournalRecord>({
            endpoint: agent.ep,
            withholdPayloads: config.eventPayloadsWithheld,
            wal,
            subjectFrontier,
            source: positionedJcodeJournalSource(new JcodeJournalSource(journalPath)),
            map: mapper.map,
            onUnreadable: (gap) =>
              writeJcodeDiagnostic(`[cotal-jcode] AG-UI source: skipped an unreadable journal record at offset ${gap.offset} (${gap.bytes} bytes): ${gap.reason}\n`),
          });
        },
        {
          onError: eventPlaneStopped({ log: (line) => writeJcodeDiagnostic(`[cotal-jcode] ${line}\n`) }),
          sourceEnd: (journalPath: string) => new JcodeJournalSource(journalPath).end(),
          onRunClosed: (runId: string) => mapper?.forgetOpenRun(runId),
          // A flush landing in a mesh rebuild window measured `max_payload` off a connection
          // that was not there and killed the seat. The holder now rides the window out on this
          // wait instead. TWO edges are required, and the difference is measured rather than
          // assumed: `connection` covers the Cotal bind (initial start, manual reconnect, the
          // endpoint's own background rebuild), while `transport` covers the window INSIDE nats.js's
          // own reconnect, where `this.nc` still exists but its `info` is already cleared, so
          // `maxPayload` throws while every Cotal-side flag still says live. Waiting on
          // `connection` alone resolves immediately in exactly that window (measured: the
          // reproduced death kept `agent.connected === true`). Both getters are re-checked after
          // the listeners are attached, so a bind landing between check and listen cannot be missed.
          // No time bound: the endpoint's re-establish loop owns retry and backoff, and a bound here
          // would reintroduce the terminal death under a standing outage, just slower. The one
          // other exit is the seat stopping: `shutdown()` aborts `eventWaitStop`, and the wait
          // rejects into the holder's terminal path so a stop during an outage is not held open.
          // The step stays queued meanwhile — no event is dropped, reordered or duplicated, because
          // the WAL's cursor has not moved and the chain serializes everything behind this await.
          waitLive: () =>
            new Promise<void>((resolve, reject) => {
              const live = (): boolean => agent.connected && agent.transportConnected;
              const release = (): void => {
                agent.off("connection", onConnection);
                agent.off("transport", onTransport);
                eventWaitStop.signal.removeEventListener("abort", onStop);
              };
              const finish = (): void => {
                release();
                resolve();
              };
              const onStop = (): void => {
                release();
                reject(new Error("seat stopping while the mesh connection is down; unpublished events stay in the journal"));
              };
              const onConnection = (e: { connected: boolean }): void => {
                if (e.connected && agent.transportConnected) finish();
              };
              const onTransport = (e: { connected: boolean }): void => {
                if (e.connected && agent.connected) finish();
              };
              agent.on("connection", onConnection);
              agent.on("transport", onTransport);
              eventWaitStop.signal.addEventListener("abort", onStop);
              if (live()) finish();
              else if (eventWaitStop.signal.aborted) onStop();
            }),
        },
      )
    : undefined;

  const releaseEventLock = async (): Promise<void> => {
    const lock = eventLock;
    eventLock = undefined;
    if (!lock) return;
    try {
      await lock.release();
    } catch (error) {
      writeJcodeDiagnostic(`[cotal-jcode] event WAL lock release failed: ${(error as Error).message}\n`);
    }
  };

  return { events, eventWaitStop, releaseEventLock };
}
