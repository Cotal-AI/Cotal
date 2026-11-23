/**
 * How a Jcode seat follows its session's turns from the Harness events: busy and idle, an error frame
 * of a turn the TUI owns, and the end of every turn.
 */
import { HarnessError, type ApiEvent, type JcodeClient } from "@1jehuang/jcode-sdk";
import { jcodeTurnCondition } from "./host-support.js";
import type { HostTurnDeps, HostTurnState } from "./host-turns.js";

export function watchTurnEvents(
  connected: JcodeClient,
  hostState: HostTurnState,
  deps: Pick<HostTurnDeps, "agent" | "closeEventRun" | "relayTurnCondition" | "finishHostIdleTurn" | "publishInboundHealth">,
): void {
  const { agent, closeEventRun, relayTurnCondition, finishHostIdleTurn, publishInboundHealth } = deps;
  connected.on("session_status", (event: ApiEvent) => {
    if (!("session_id" in event) || event.session_id !== hostState.sessionId || event.ev !== "session_status") return;
    // Advisory idle between tool rounds does not mean the Cotal-owned run() has ended.
    // steerPending keys off sessionBusy() (driving || turnActive) so that pulse cannot drop a DM.
    const started = !hostState.turnActive && event.status !== "idle";
    hostState.turnActive = event.status !== "idle";
    if (started && !hostState.driving) relayTurnCondition(null);
    if (!hostState.turnActive) void finishHostIdleTurn();
    else publishInboundHealth();
  });
  // A turn the TUI owns fails only as an unsolicited error frame: no run() of this host is there to
  // throw it. A host-owned turn reports the same frame through drive()'s catch. Scoped like the
  // SDK's own run(): a frame naming another session is not this seat's.
  connected.on("harness_error", (event: ApiEvent) => {
    if (hostState.driving || event.ev !== "error" || ("session_id" in event && event.session_id !== hostState.sessionId)) return;
    agent.releaseInFlight(hostState.surfacedIds);
    hostState.surfacedIds = [];
    const condition = jcodeTurnCondition(new HarnessError(String(event.code ?? "internal"), String(event.message ?? "harness error")));
    if (condition) relayTurnCondition(condition);
  });
  connected.on("turn_done", (event: ApiEvent) => {
    if ("session_id" in event && event.session_id === hostState.sessionId) {
      // The SDK's run() takes turn_done as a turn's success. drive() clears the kept error for a
      // host-owned turn; a TUI-owned turn clears it here unless it relayed an error of its own.
      if (!hostState.driving && !hostState.turnConditionPublished) hostState.lastTurnError = undefined;
      closeEventRun();
      hostState.turnActive = false;
      void finishHostIdleTurn();
    }
  });
}
