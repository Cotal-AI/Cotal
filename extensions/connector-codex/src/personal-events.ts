/**
 * A personal Codex conversation's activity on its own event channel. The source is the thread's
 * rollout, read through the same mapper, write-ahead log and emitter the managed host uses. It
 * starts where the rollout ended when the person's approval issued the identity, so nothing the
 * conversation recorded before then, including while the person decided, is published.
 */
import { randomUUID } from "node:crypto";
import { watch, type FSWatcher } from "node:fs";
import { principalKey } from "@cotal-ai/core";
import {
  AguiEmitter, AguiEmitterHolder, BoundStartSource, EventWal, FileSubjectFrontier, JsonlFileSource, ensureEventWalDir,
  eventPlaneStopped, resolveEventsStateRoot, type AgentConfig, type MeshAgent,
} from "@cotal-ai/connector-core";
import { createCodexMapper, type CodexMapper, type CodexRecord } from "./agui-map.js";

const log = (line: string) => process.stderr.write(`[cotal-codex] ${line}\n`);

export interface CodexPersonalEvents {
  stop(): Promise<void>;
}

/** Publish the thread's rollout from `start`, a position taken from the file itself. Codex appends
 *  to the rollout, so a change to the file is what asks the emitter to read. */
export function startCodexPersonalEvents(agent: MeshAgent, config: AgentConfig, env: NodeJS.ProcessEnv,
  threadId: string, rollout: string, start: string): CodexPersonalEvents {
  let mapper: CodexMapper | undefined;
  const events = new AguiEmitterHolder<CodexRecord>(async (path: string) => {
    await agent.whenConnected(20_000);
    const workspaceRoot = resolveEventsStateRoot(env);
    const principal = principalKey(agent.ep.principal.owner, agent.ep.principal.actor).key;
    const { walPath, subjectPath } = await ensureEventWalDir({ workspaceRoot, space: config.space, principal, threadId });
    const subjectFrontier = await FileSubjectFrontier.open(subjectPath, { space: config.space, principal });
    const wal = await EventWal.open(walPath, { space: config.space, threadId, principal, subjectMayExist: false });
    const resumeRunId = wal.pending === null ? wal.brackets?.run : wal.pending.brackets.run;
    mapper = createCodexMapper({ threadId, mintRunId: () => randomUUID(), resumeRunId });
    const source = new BoundStartSource<CodexRecord>(new JsonlFileSource<CodexRecord>(path), start);
    const emitter = await AguiEmitter.start<CodexRecord>({
      endpoint: agent.ep, withholdPayloads: config.eventPayloadsWithheld, wal, subjectFrontier, source, map: mapper.map,
      onUnreadable: (gap) => log(`AG-UI source: skipped an unreadable rollout record at offset ${gap.offset} (${gap.bytes} bytes): ${gap.reason}`),
    });
    // A log with no cursor would otherwise take its boundary from the file's later end.
    if (wal.frontier.sourceCursor === undefined) await wal.advanceCursorOnly(start);
    return emitter;
  }, {
    onError: eventPlaneStopped({ log }),
    sourceEnd: (path: string) => new JsonlFileSource<CodexRecord>(path).end(),
    onRunClosed: (runId: string) => mapper?.forgetOpenRun(runId),
  });
  events.adopt(rollout);
  events.flush(rollout);
  let watcher: FSWatcher | undefined = watch(rollout, () => events.flush(rollout));
  watcher.on("error", (e) => log(`the rollout watch stopped: ${e.message}`));
  return {
    async stop() {
      watcher?.close();
      watcher = undefined;
      events.flush(rollout);
      await events.settled();
      await events.close();
    },
  };
}
