import {
  EpEnvelopeError,
  eptStreamName,
  eptSubject,
  handleCheckpointFire,
  heartbeatCheckpoint,
  mintCheckpoint,
  readCheckpointAnswer,
  readCheckpointSettle,
  readCheckpointSpec,
  readCheckpointStatus,
  reconcileCheckpointSchedule,
  resumeCheckpoint,
  type CheckpointAnswerValue,
  type CheckpointSettleFact,
  type RunHostPlanes,
} from "@cotal-ai/core";
import { RunScopeAuthority } from "./run-scope-authority.js";

export interface RunPauseHost {
  arm(token: string, deadline: number): Promise<void>;
  heartbeat(token: string, deadline: number): Promise<void>;
  readSettle(token: string): Promise<CheckpointSettleFact | undefined>;
  readAnswer(token: string): Promise<CheckpointAnswerValue | undefined>;
  takeFire(token: string): Promise<boolean>;
  claim(token: string): Promise<void>;
  rearm(): Promise<readonly string[]>;
}

/** The trusted host owns these planes. Its returned methods derive every subject from the
 *  bound endpoint and attempt, and authorize tokens against its own broker journal. */
export function createRunPauseHost(
  broker: RunHostPlanes,
  binding: {
    endpoint: string;
    instanceId: string;
    epoch: number;
    holder: { id: string; lifecycleUid: string };
  },
  authority: RunScopeAuthority,
  clock: () => number = Date.now,
): RunPauseHost {
  const { kv, js, jsm, space } = broker;
  const pinned = structuredClone(binding);
  const ref = (token: string) => ({ endpoint: pinned.endpoint, token });
  return Object.freeze({
    async arm(token: string, deadline: number): Promise<void> {
      await authority.pause(token, "mint");
      const pause = ref(token);
      if (await readCheckpointSettle(jsm, space, pause)) return;
      const prior = await readCheckpointSpec(kv, pause);
      const now = clock();
      if (prior === undefined) {
        await mintCheckpoint(kv, js, space, { ref: pause, ...pinned, deadline, now });
        return;
      }
      const mine = prior.holder.id === pinned.holder.id && prior.holder.lifecycleUid === pinned.holder.lifecycleUid;
      if (mine && prior.initialDeadline > now) {
        await mintCheckpoint(kv, js, space, { ref: pause, ...pinned, deadline: prior.initialDeadline, now });
        return;
      }
      const status = await readCheckpointStatus(kv, pause);
      if (status === undefined)
        throw new Error(`checkpoint ${token} has a spec without status; only its recorded holder can complete the identical mint`);
      if (status.value.state !== "waiting") return;
      await authority.pause(token, "attach");
      await reconcileCheckpointSchedule(kv, js, jsm, space, { ref: pause, instanceId: pinned.instanceId, epoch: pinned.epoch });
    },
    async heartbeat(token: string, deadline: number): Promise<void> {
      await authority.pause(token, "heartbeat");
      await heartbeatCheckpoint(kv, js, jsm, space, {
        ref: ref(token), instanceId: pinned.instanceId, epoch: pinned.epoch, deadline, now: clock(),
      });
    },
    async readSettle(token: string): Promise<CheckpointSettleFact | undefined> {
      await authority.pause(token, "read");
      return readCheckpointSettle(jsm, space, ref(token));
    },
    async readAnswer(token: string): Promise<CheckpointAnswerValue | undefined> {
      await authority.pause(token, "read");
      const settled = await readCheckpointSettle(jsm, space, ref(token));
      if (settled?.answerId === undefined) return undefined;
      return readCheckpointAnswer(kv, pinned.endpoint, token, settled.answerId);
    },
    async takeFire(token: string): Promise<boolean> {
      await authority.pause(token, "fire");
      const subject = eptSubject(space, pinned.endpoint, pinned.instanceId, pinned.epoch, token, "fire");
      const fired = await jsm.streams.getMessage(eptStreamName(space), { last_by_subj: subject }).catch((error: unknown) => {
        if ((error as { code?: unknown })?.code === 10037) return null;
        throw error;
      });
      if (fired === null || fired === undefined) return false;
      const result = await handleCheckpointFire(kv, js, jsm, space, {
        ref: ref(token), instanceId: pinned.instanceId, epoch: pinned.epoch,
        msg: { subject, ...(fired.header === undefined ? {} : { headers: fired.header }), data: fired.data },
        now: clock(),
      });
      return result.acted;
    },
    async claim(token: string): Promise<void> {
      await authority.pause(token, "claim");
      const pause = ref(token);
      const status = await readCheckpointStatus(kv, pause);
      if (status?.value.state !== "waiting") return;
      const spec = await readCheckpointSpec(kv, pause);
      if (spec === undefined) throw new Error(`checkpoint ${token} is waiting without its spec`);
      try {
        await resumeCheckpoint(kv, js, jsm, space, { ref: pause, presenter: spec.holder, now: clock() });
      } catch (error) {
        if (!(error instanceof EpEnvelopeError && (error.code === "conflict" || error.code === "failed-precondition"))) throw error;
      }
    },
    async rearm(): Promise<readonly string[]> {
      const rearmed: string[] = [];
      for (const token of await authority.rearmTokens()) {
        await authority.pause(token, "rearm");
        const result = await reconcileCheckpointSchedule(kv, js, jsm, space, {
          ref: ref(token), instanceId: pinned.instanceId, epoch: pinned.epoch,
        });
        if (result.reEmitted) rearmed.push(token);
      }
      return rearmed;
    },
  });
}
