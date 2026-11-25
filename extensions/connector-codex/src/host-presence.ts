import type { MeshAgent } from "@cotal-ai/connector-core";
import type { PresenceCondition } from "@cotal-ai/core";

/** How often a presence update latched while the endpoint was still connecting is retried. */
const STATUS_FLUSH_MS = 500;

/** The host's presence writes over `agent`: each latches while the endpoint is still connecting and
 *  is replayed once it is up, and all of them go out in call order. */
export function hostPresence(agent: MeshAgent) {
  // Presence is best-effort and must never throw into the turn loop — but it must also never
  // LIE. The mesh connect runs in the background, so an auto-prompt (`--prompt`) can open a real
  // turn while the endpoint is still connecting; dropping that "working" would leave the roster
  // showing the default `idle` for the whole first turn. So the latest desired status is latched
  // and replayed once the endpoint is up (last write wins — a stale one is never resurrected).
  type Presence = { status: "idle" | "working" | "waiting" | "offline"; activity?: string; presenceOnly?: boolean };
  let desired: Presence | undefined;
  let desiredCondition: PresenceCondition | null | undefined;
  let flushTimer: ReturnType<typeof setInterval> | undefined;
  // Presence writes go out IN CALL ORDER. `agent.setStatus("working")` clears the condition before
  // it publishes, and it awaits the connection first, so two fire-and-forget writes from one tick
  // can land in either order. Measured: a turn that failed in the tick it started published its
  // failure condition and then its own start's clear one millisecond later, and the presence
  // bucket (history 1) dropped the condition revision before any watcher read it. The chain keeps
  // the start's clear ahead of the failure's condition, so the condition is what the roster shows
  // until the NEXT turn starts.
  let presenceChain: Promise<void> = Promise.resolve();
  const inOrder = (write: () => Promise<void>): Promise<void> => {
    const next = presenceChain.then(write, write);
    presenceChain = next.catch(() => {});
    return next;
  };
  function armStatusFlush(): void {
    if (flushTimer) return;
    flushTimer = setInterval(() => {
      if ((!desired && desiredCondition === undefined) || !agent.connected) {
        if (!desired && desiredCondition === undefined) {
          clearInterval(flushTimer);
          flushTimer = undefined;
        }
        return;
      }
      const want = desired;
      const wantCondition = desiredCondition;
      desired = undefined;
      desiredCondition = undefined;
      clearInterval(flushTimer);
      flushTimer = undefined;
      inOrder(async () => {
        if (wantCondition !== undefined) await agent.setCondition(wantCondition);
        if (want) {
          if (want.presenceOnly) await agent.resetStatus(want.status, want.activity);
          else await agent.setStatus(want.status, want.activity);
        }
      })
        .catch(() => {
          if (!desired) desired = want;
          if (desiredCondition === undefined) desiredCondition = wantCondition;
          armStatusFlush();
        });
    }, STATUS_FLUSH_MS);
    flushTimer.unref?.();
  }
  const safeStatus = async (status: Presence["status"], activity?: string, presenceOnly = false): Promise<void> => {
    desired = { status, activity, presenceOnly };
    if (!agent.connected) return armStatusFlush();
    const want = desired;
    desired = undefined;
    await inOrder(async () => {
      try {
        // Requests are answered by the driver, not host-turn boundaries. Keep their waiting
        // presence from disarming the working-to-idle completion of the same native turn.
        // A later command or MCP item is not required for a completed turn to yield done.
        if (presenceOnly) await agent.resetStatus(status, activity);
        else await agent.setStatus(status, activity);
      } catch {
        if (!desired) desired = want;
        armStatusFlush();
      }
    });
  };

  const safeCondition = async (condition: PresenceCondition | null): Promise<void> => {
    desiredCondition = condition;
    if (!agent.connected) return armStatusFlush();
    const want = desiredCondition;
    desiredCondition = undefined;
    await inOrder(async () => {
      try {
        await agent.setCondition(condition);
      } catch {
        if (desiredCondition === undefined) desiredCondition = want;
        armStatusFlush();
      }
    });
  };
  return { safeStatus, safeCondition };
}
