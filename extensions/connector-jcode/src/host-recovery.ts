/**
 * Bridge recovery for a jcode host session: one clean replacement of a lost Harness connection
 * over the same private session. createHostTurns creates it once over the shared `hostState`.
 */
import { type JcodeClient } from "@1jehuang/jcode-sdk";
import { type InboxItem } from "@cotal-ai/connector-core";
import { connectSteerClient } from "./steer-replies.js";
import { writeJcodeDiagnostic } from "./startup-diagnostics.js";
import { BRIDGE_RECOVERY_WINDOW_MS, permanentBridgeRecoveryFailure } from "./host-support.js";
import type { HostTurnDeps, HostTurnState } from "./host-turns.js";

/** What bridge recovery reads from createHostTurns: host deps plus three of its sibling closures. */
export type BridgeRecoveryDeps = Pick<HostTurnDeps, "agent" | "BRIDGE_RECOVERY_RETRY_MS" | "hasDriveWork" | "heldReservations" | "launchPrivateJcode" | "publishInboundHealth" | "releaseUnansweredSteers" | "shutdown" | "sleep" | "stopPrivateJcode"> & {
  drive: () => Promise<void>;
  unservedAutomatic: () => InboxItem[];
  watchClient: (connected: JcodeClient) => void;
};

/** Create the bridge recovery of one host session over its shared state. */
export function createBridgeRecovery(hostState: HostTurnState, deps: BridgeRecoveryDeps) {
  const { agent, BRIDGE_RECOVERY_RETRY_MS, hasDriveWork, heldReservations, launchPrivateJcode, publishInboundHealth, releaseUnansweredSteers, shutdown, sleep, stopPrivateJcode, drive, unservedAutomatic, watchClient } = deps;

  /** A connector line that ends the seat, naming the last turn error while no turn has succeeded
   *  since it. Put that error before the recovery error so it remains visible if the manager cuts
   *  the end of the line. */
  const endingLine = (reason: string, recoveryError?: string): string =>
    hostState.lastTurnError === undefined
      ? `[cotal-jcode] ${reason}${recoveryError === undefined ? "" : `: ${recoveryError}`}\n`
      : `[cotal-jcode] ${reason}; last turn error: ${hostState.lastTurnError}` +
        `${recoveryError === undefined ? "" : `; recovery error: ${recoveryError}`}\n`;

  /**
   * A provider stall can take down Jcode's bridge while leaving the private session and its inbox
   * batch intact. Give that owned instance one clean replacement: the failed turn remains unacked,
   * we attach the exact session rather than creating a blank one, and only then let the normal
   * inbox driver see the pending work again. A second close is terminal — retry pacing belongs to
   * the turn policy, not an unbounded connector relaunch loop.
   */
  const recoverBridge = async (lost: JcodeClient, preserveInstance = false): Promise<void> => {
    if (hostState.stopping || lost !== hostState.client || hostState.reconnecting) return;
    if (hostState.bridgeRecoveryUsed) {
      if (preserveInstance) {
        hostState.queuedTurnTierStopped = true;
        writeJcodeDiagnostic(
          `[cotal-jcode] queued-turn acknowledgement remains ambiguous after its one connection recovery; ` +
            `preserving the private Jcode tree and stopping queued-turn attempts; ` +
            `${unservedAutomatic().length} automatic message(s) stay queued and UN-ACKED for redelivery\n`,
        );
        publishInboundHealth();
        return;
      }
      writeJcodeDiagnostic(endingLine("private Harness connection closed after its one recovery attempt"));
      await shutdown(1);
      return;
    }
    hostState.bridgeRecoveryUsed = true;
    hostState.reconnecting = true;
    hostState.turnActive = false;
    hostState.driving = false;
    hostState.nativeTreePreserved = preserveInstance;
    releaseUnansweredSteers();
    if (!preserveInstance) {
      agent.releaseInFlight(hostState.surfacedIds);
      hostState.surfacedIds = []; // a new tree redrives the durable batch, unlike a client-only replacement
    }
    // Same reasoning: the replacement redrives the durable batch, so reservations held against the
    // lost bridge must not keep those items unselectable on the new one.
    //
    // This one IS a true wholesale wipe, unlike the new-turn boundary, and the difference is the
    // point. Here the bridge itself is gone, so every outstanding handover is dead by definition:
    // each one's own release checks `client !== current` and returns without promoting, so nothing
    // is in flight that could still land. At the new-turn boundary the bridge is alive and the
    // handover may still be awaiting acceptance, which is why that site re-derives instead.
    for (const batch of heldReservations) agent.releaseInFlight([...batch]);
    heldReservations.clear();
    hostState.reservedIds = new Set();
    void agent.setStatus("waiting").catch(() => {});
    let lastError: unknown;
    const deadline = Date.now() + BRIDGE_RECOVERY_WINDOW_MS;
    try {
      // The connector owns the private instance. Stop the whole broken tree before replacing it:
      // a surviving daemon still holds the private home's registry and socket, so a replacement
      // cannot own the same home until it is gone. The lost client's close listener is ignored
      // because reconnecting is already true, and the relaunch goes through the same
      // identity-capturing path as startup so teardown targets the replacement tree, not the corpse.
      if (preserveInstance) {
        // A connected client does not own the SDK instance. Closing it retires only this
        // connection's ambiguous replies, while the TUI keeps the native turn alive.
        await lost.close();
        hostState.client = undefined;
      } else await stopPrivateJcode();
      if (!hostState.sessionId) throw new Error("jcode connector: Harness connection closed before a session was established");
      for (;;) {
        let replacement: JcodeClient | undefined;
        try {
          replacement = preserveInstance
            ? await connectSteerClient(hostState.instance!.socketPath, Math.max(1, deadline - Date.now()))
            : await launchPrivateJcode(deadline);
          const attachRemaining = Math.max(1, deadline - Date.now());
          let attachDeadline: ReturnType<typeof setTimeout> | undefined;
          let attached: Awaited<ReturnType<JcodeClient["attachSession"]>>;
          try {
            attached = await Promise.race([
              replacement.attachSession(hostState.sessionId),
              new Promise<never>((_, reject) => {
                attachDeadline = setTimeout(() => reject(new Error("jcode connector: recovery attach exceeded its bounded window")), attachRemaining);
              }),
            ]);
          } finally {
            if (attachDeadline !== undefined) clearTimeout(attachDeadline);
          }
          hostState.client = replacement;
          // A new connection cannot deliver an event for a request made on the old one, so whatever
          // lapsed sends were still outstanding there can no longer emit into this session's
          // listeners. That is the only boundary in this protocol that genuinely restores
          // attributability, and crossing it is what lets acceptance be trusted again.
          hostState.acceptanceSuspectUntilBridgeReplaced = false;
          hostState.bridgeReplacementRequestedForSuspicion = false;
          hostState.unsettledLapsedDispatches = 0;
          // The deferral clock belongs to the connection whose run held attribution open. That
          // connection is gone, so a stale age must not make the replacement's first deferral look
          // already exhausted and force a second boundary on arrival.
          hostState.deferralStartedAt = undefined;
          hostState.deferralAnnounced = false;
          hostState.queuedTurnTierStopped = false;
          watchClient(replacement);
          // The initial native state event can arrive before watchClient is installed.
          // Do not redrive into a TUI turn that is still running.
          if (preserveInstance) hostState.turnActive = attached.status !== "idle";
          writeJcodeDiagnostic(`[cotal-jcode] recovered private Harness connection for session ${hostState.sessionId}\n`);
          void agent.setStatus(hostState.turnActive ? "working" : "idle").catch(() => {});
          break;
        } catch (error) {
          lastError = error;
          await replacement?.close().catch(() => {});
          if (!preserveInstance) await stopPrivateJcode();
          if (hostState.stopping) return;
          if (permanentBridgeRecoveryFailure(error)) throw error;
          const remaining = deadline - Date.now();
          if (remaining <= 0) throw error;
          writeJcodeDiagnostic(
            `[cotal-jcode] private Harness replacement not ready yet; retrying inside its one recovery window: ${(error as Error).message}\n`,
          );
          await sleep(Math.min(BRIDGE_RECOVERY_RETRY_MS, remaining));
        }
      }
    } catch (error) {
      const failure = lastError ?? error;
      const reason = preserveInstance
        ? `same-bridge recovery ${permanentBridgeRecoveryFailure(failure)
          ? "permanently refused"
          : Date.now() >= deadline
            ? `window expired after ${BRIDGE_RECOVERY_WINDOW_MS}ms`
            : "failed"}; ending seat and stopping private Jcode tree`
        : "private Harness connection closed and recovery failed";
      writeJcodeDiagnostic(
        endingLine(reason, (failure as Error).message),
      );
      await shutdown(1);
    } finally {
      hostState.reconnecting = false;
      if (!hostState.stopping && hasDriveWork()) void drive();
    }
  };

  return { recoverBridge };
}
