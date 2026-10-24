import { randomUUID } from "node:crypto";
import { basename } from "node:path";
import { principalKey } from "@cotal-ai/core";
import {
  AguiEmitter, AguiEmitterHolder, EventWal, FileSubjectFrontier, JsonlFileSource, ensureEventWalDir,
  eventPlaneStopped, resolveEventsStateRoot, type AgentConfig, type DurableSource, type MeshAgent,
} from "@cotal-ai/connector-core";
import { createClaudeMapper, type ClaudeEntry, type ClaudeMapper } from "./agui-map.js";
import { createBoundClaudeTranscriptSource } from "./agui-source.js";

/** The managed and personal native paths use the same transcript, WAL and recovery semantics. */
export function createClaudeEventPlane(agent: MeshAgent, config: AgentConfig, env: NodeJS.ProcessEnv,
  initialSource?: DurableSource<ClaudeEntry>): { events: AguiEmitterHolder<ClaudeEntry, unknown>; stop(): void } {
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
  let source = initialSource;
  let mapper: ClaudeMapper | undefined;
  const events = new AguiEmitterHolder<ClaudeEntry, unknown>(async (transcriptPath, sessionSource) => {
    const boundSource = source ??= await createBoundClaudeTranscriptSource(transcriptPath, sessionSource);
    await waitLive();
    const workspaceRoot = resolveEventsStateRoot(env);
    const threadId = basename(transcriptPath, ".jsonl");
    const principal = principalKey(agent.ep.principal.owner, agent.ep.principal.actor).key;
    const { walPath, subjectPath } = await ensureEventWalDir({ workspaceRoot, space: config.space, principal, threadId });
    const subjectFrontier = await FileSubjectFrontier.open(subjectPath, { space: config.space, principal });
    const wal = await EventWal.open(walPath, { space: config.space, threadId, principal, subjectMayExist: false });
    const resumeRunId = wal.pending === null ? wal.brackets?.run : wal.pending.brackets.run;
    mapper = createClaudeMapper({ threadId, mintRunId: () => randomUUID(), resumeRunId });
    return AguiEmitter.start<ClaudeEntry>({ endpoint: agent.ep, wal, subjectFrontier, source: boundSource, map: mapper.map,
      onUnreadable: (gap) => process.stderr.write(
        `[cotal-connector] AG-UI source: skipped an unreadable transcript record at offset ${gap.offset} ` +
        `(${gap.bytes} bytes): ${gap.reason}\n`,
      ),
    });
  }, {
    onError: eventPlaneStopped({ log: (line) => process.stderr.write(`[cotal-connector] ${line}\n`) }),
    sourceEnd: (path: string) => new JsonlFileSource(path).end(),
    onRunClosed: (runId) => mapper?.forgetOpenRun(runId),
    waitLive,
  });
  return { events, stop: () => stop.abort() };
}
