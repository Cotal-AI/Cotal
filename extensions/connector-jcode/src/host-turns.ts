/**
 * The closures that drive a jcode host session's turns: the inbox driver, mid-turn steering, the
 * level-triggered queue fallback, bridge recovery, and the client watcher. runJcodeHost creates
 * them once, after everything they read is bound, and they share its state through `hostState`.
 */
import { type ChildProcess } from "node:child_process";
import { HarnessError, type JcodeClient, type ApiEvent, type LaunchedInstance } from "@1jehuang/jcode-sdk";
import { type PresenceCondition } from "@cotal-ai/core";
import { connectSteerClient, softInterruptWithLateReply } from "./steer-replies.js";
import { writeJcodeDiagnostic } from "./startup-diagnostics.js";
import {
  FALLBACK_INITIAL_MS,
  fallbackStillOwed,
  nextFallbackAction,
  attributionBlockedByOpenRun,
  deferralExhausted,
  exhaustedDeferralAction,
  nextFallbackDelay,
  type FallbackState,
} from "./queue-fallback.js";
import { type MeshAgent, type AguiEmitterHolder, formatInjection, type InboxItem } from "@cotal-ai/connector-core";
import { type PositionedJcodeJournalRecord } from "./agui-map.js";
import {
  RUN_ACCEPT_WINDOW_MS,
  jcodeTurnCondition,
  BRIDGE_RECOVERY_WINDOW_MS,
  permanentBridgeRecoveryFailure,
  isJcodeBusyRefusal,
} from "./host-support.js";

/** Turn state of one jcode host session, shared by the closures that drive its turns. */
export interface HostTurnState {
  pendingKickoff: string | undefined;
  eventJournal: string | undefined;
  instance: LaunchedInstance | undefined;
  client: JcodeClient | undefined;
  tui: ChildProcess | undefined;
  stopping: boolean;
  reconnecting: boolean;
  bridgeRecoveryUsed: boolean;
  sessionId: string | undefined;
  driving: boolean;
  turnActive: boolean;
  briefed: boolean;
  initialized: boolean;
  wakeQueued: boolean;
  pendingMentionWake: { hint: string } | undefined;
  surfacedIds: string[];
  plainSends: number;
  nativeTreePreserved: boolean;
  unsettledLapsedDispatches: number;
  acceptanceSuspectUntilBridgeReplaced: boolean;
  deferralStartedAt: number | undefined;
  deferralAnnounced: boolean;
  queuedTurnTierStopped: boolean;
  bridgeReplacementRequestedForSuspicion: boolean;
  reservedIds: Set<string>;
  steering: boolean;
  softInterruptFailed: boolean;
  steerSettled: Promise<unknown>;
  errorRetryMs: number;
  consecutiveFailures: number;
  turnConditionPublished: boolean;
  lastTurnError: string | undefined;
  fallbackDelayMs: number;
  fallbackRunning: boolean;
  fallbackTimer: ReturnType<typeof setTimeout> | undefined;
}

/** What the turn closures read from the host that owns them, bound before they are created. */
export interface HostTurnDeps {
  agent: MeshAgent;
  events: AguiEmitterHolder<PositionedJcodeJournalRecord> | undefined;
  closeEventRun: (error?: Error) => void;
  ensureEventsBound: () => Promise<void>;
  unansweredSteers: Set<() => void>;
  releaseUnansweredSteers: () => void;
  oweAcceptanceDebt: (settledWhenHarnessDone: Promise<unknown>) => void;
  withExclusiveDispatch: <T>(operation: () => Promise<T>) => Promise<T>;
  onceAccepted: (on: JcodeClient, session: string, withinMs: number) => Promise<void>;
  heldReservations: Set<Set<string>>;
  releaseUnheldReservations: () => void;
  promoteToSurfaced: (keys: string[]) => void;
  reserveForHandover: (keys: string[]) => (() => void) | undefined;
  stopPrivateJcode: (opts?: { skipClientClose?: boolean }) => Promise<void>;
  launchPrivateJcode: (deadline?: number) => Promise<JcodeClient>;
  shutdown: (code?: number, signal?: "SIGINT" | "SIGTERM" | "SIGHUP") => Promise<void>;
  ERROR_RETRY_INITIAL_MS: number;
  ERROR_RETRY_GIVE_UP: number;
  relayTurnCondition: (condition: PresenceCondition | null) => void;
  BRIDGE_RECOVERY_RETRY_MS: number;
  sleep: (ms: number) => Promise<void>;
  hasDriveWork: () => boolean;
  scheduleErrorRetry: () => void;
  sessionBusy: () => boolean;
  publishInboundHealth: () => void;
  finishHostIdleTurn: () => Promise<void>;
}

/** Create the turn closures of one host session over its shared state. */
export function createHostTurns(hostState: HostTurnState, deps: HostTurnDeps) {
  const {
    agent,
    events,
    closeEventRun,
    ensureEventsBound,
    unansweredSteers,
    releaseUnansweredSteers,
    oweAcceptanceDebt,
    withExclusiveDispatch,
    onceAccepted,
    heldReservations,
    releaseUnheldReservations,
    promoteToSurfaced,
    reserveForHandover,
    stopPrivateJcode,
    launchPrivateJcode,
    shutdown,
    ERROR_RETRY_INITIAL_MS,
    ERROR_RETRY_GIVE_UP,
    relayTurnCondition,
    BRIDGE_RECOVERY_RETRY_MS,
    sleep,
    hasDriveWork,
    scheduleErrorRetry,
    sessionBusy,
    publishInboundHealth,
    finishHostIdleTurn,
  } = deps;

  const drive = async (): Promise<void> => {
    if (hostState.stopping || hostState.reconnecting || !hostState.initialized || hostState.driving || hostState.turnActive || !hostState.client || !hostState.sessionId) return;
    if (events) {
      await ensureEventsBound();
      await events.settled();
      if (hostState.stopping) return;
    }
    hostState.driving = true;
    if (hostState.pendingKickoff !== undefined && hostState.steering)
      writeJcodeDiagnostic("[cotal-jcode] startup kickoff waiting for in-flight steering\n");
    await hostState.steerSettled;
    // A role request is shown only once its take is recorded (SPEC §8.1). This turn carries every
    // unreserved automatic message, so it takes every held one here, before the session checks
    // below, which then cover this await too.
    if (hostState.pendingKickoff === undefined)
      await agent.takeChosen("automatic", (preview) => preview.filter((item) => !hostState.reservedIds.has(item.recvKey)));
    if (hostState.stopping || hostState.reconnecting || hostState.turnActive || !hostState.client || !hostState.sessionId) {
      hostState.driving = false;
      writeJcodeDiagnostic("[cotal-jcode] deferred turn after steering: native session unavailable\n");
      return;
    }
    releaseUnansweredSteers();
    if (hostState.surfacedIds.length) {
      const committed = hostState.surfacedIds;
      hostState.surfacedIds = [];
      agent.drainInboxDeliveries(committed);
      agent.releaseInFlight(committed);
    }
    // Kickoff excludes the automatic inbox. Preserve that deferred work even when ordinary
    // dnd traffic contributes nothing to pendingWake(). Pull-only traffic stays excluded.
    hostState.wakeQueued = hostState.pendingKickoff !== undefined && agent.peekInbox("automatic").length > 0;
    const parts: string[] = [];
    let ids: string[] = [];
    let turnIds: string[] = [];
    const mentionWake = hostState.pendingKickoff === undefined ? hostState.pendingMentionWake : undefined;
    // Run turns ride the same composed injection; their ids commit as surfaced once the Harness
    // verifiably accepted it (two-phase — an unaccepted send re-surfaces them, never a lie).
    const turnPeek = agent.peekPendingTurns();
    if (hostState.pendingKickoff !== undefined) parts.push(hostState.pendingKickoff);
    else {
      // Excludes reserved keys for the same reason the steer and fallback readers do: an item whose
      // handover is in flight is already being delivered, and selecting it here delivers it twice.
      // This reader was the one that still selected them, which is how the reproduced duplicate got
      // its second copy even though every other reader was correct.
      const inbox = agent.peekInbox("automatic").filter((item) => !hostState.reservedIds.has(item.recvKey));
      const injection = formatInjection(inbox);
      if (!injection && !turnPeek && !mentionWake) {
        hostState.driving = false;
        return;
      }
      if (injection) {
        ids = inbox.map((item) => item.recvKey);
        parts.push(injection);
      }
    }
    if (mentionWake) parts.push(mentionWake.hint);
    if (turnPeek) {
      turnIds = turnPeek.goalIds;
      parts.push(turnPeek.text);
    }
    if (!hostState.briefed) {
      hostState.briefed = true;
      const briefing = agent.channelBriefing();
      if (briefing) parts.unshift(briefing);
    }
    // The prompt is not dispatched unless every selected delivery can remain owned until its
    // containing turn settles. MeshAgent renews these holds with JetStream in-progress acks.
    if (!agent.holdInFlight(ids)) {
      hostState.driving = false;
      return;
    }
    hostState.turnActive = true;
    hostState.surfacedIds = [...ids];
    // A new turn re-derives ownership from its own prompt, so no STALE reservation may survive into
    // it. But a reservation whose handover is still in flight is not stale, and clearing those here
    // is the duplicate a reviewer reproduced: the fallback reserves a batch, the old turn goes idle
    // inside the acceptance await, this boundary wipes the reservation, the selection above re-reads
    // the same item, and both deliveries land. Drop only what no live handover holds.
    releaseUnheldReservations();
    relayTurnCondition(null);
    publishInboundHealth();
    let turnClient: JcodeClient | undefined;
    let ownSend = 0;
    try {
      turnClient = hostState.client;
      // This is the dispatch boundary. A return above leaves the kickoff owned and unsent. Once
      // run() is invoked, a close or timeout cannot prove the model rejected it, so never retry it.
      hostState.pendingKickoff = undefined;
      // The RUN's own acceptance window is gated, but not the run itself, and the distinction is
      // load-bearing in both directions.
      //
      // It must be gated at all because `run()` calls `sendMessage()` internally, which waits on the
      // same session-scoped `message_accepted` (jcode-sdk client.js:317). A run dispatched while a
      // handover awaits its acknowledgement adds a second listener, making one event ambiguous.
      //
      // It must NOT hold the gate for the whole turn, because `run()` does not return until the turn
      // is over, and a gate held that long would block every mid-turn soft interrupt, which is the
      // #910 delivery this connector exists to provide. So the gate is released as soon as the send
      // has been acknowledged, while the turn keeps streaming outside it.
      //
      // THE HANDLE IS WRAPPED IN AN OBJECT AND THAT IS LOAD-BEARING, NOT STYLE. Returning the run
      // promise bare from an async callback assimilates it: `return await operation()` would adopt
      // it and wait for the TURN, silently extending this gate from one acceptance round trip to the
      // entire run. A reviewer measured exactly that on the bare form, observing no fallback send for
      // 95 seconds while a swallowed run stayed open, which recreates the starvation #1233 is about.
      // An object is not a thenable, so it crosses both async boundaries as a value and the turn is
      // awaited below, outside the gate.
      const { dispatched: runTurn } = await withExclusiveDispatch(async () => {
        // Read before this send exists: while a lapsed send is still open, an acknowledgement may
        // be that send's, and it cannot prove the Harness took these run turns.
        const attributable = hostState.unsettledLapsedDispatches === 0 && !hostState.acceptanceSuspectUntilBridgeReplaced;
        // The turns' permit, after the gate's wait and right before the send: a once task its
        // manager settled meanwhile, or a seat that began stopping, sends nothing.
        if (hostState.stopping || !agent.claimTurns(turnIds))
          throw new Error("the once task ended, or the seat began stopping, while its send waited at the dispatch gate; nothing was sent");
        ownSend = ++hostState.plainSends;
        const dispatched = turnClient!.run(hostState.sessionId!, parts.join("\n\n"), { autoApprove: true });
        // Keep a failed dispatch from surfacing as an unhandled rejection while it is only being
        // raced below; the handle returned from this gate is what actually reports it.
        dispatched.catch(() => {});
        // Surfaced at acceptance, not at turn end: the model's own cotal_yield runs inside this
        // turn, and yieldTurn refuses a turn that is not surfaced yet. Heard until the turn settles,
        // not only inside the window below: while this run is open with its acceptance lapsed, the
        // queue fallback defers and nothing else sends this session a message it could acknowledge,
        // so a late acceptance is still this send's.
        if (attributable && turnIds.length) {
          const surface = (event: ApiEvent): void => {
            if (!("session_id" in event && event.session_id === hostState.sessionId)) return;
            stopSurfacing();
            agent.commitSurfacedTurns(turnIds);
          };
          const stopSurfacing = (): void => { turnClient!.off("message_accepted", surface); };
          turnClient!.on("message_accepted", surface);
          void dispatched.then(stopSurfacing, stopSurfacing);
        }
        // Hold the gate for ONE acceptance round trip, then hand the turn back to run outside it.
        // Whichever happens first ends the window: the acknowledgement, the turn itself finishing,
        // or the SDK's own 10s acceptance timeout, so the gate cannot be held by a silent Harness.
        let acknowledgedHere = false;
        const noteAccepted = (event: ApiEvent): void => {
          if ("session_id" in event && event.session_id === hostState.sessionId) acknowledgedHere = true;
        };
        turnClient!.on("message_accepted", noteAccepted);
        try {
          await Promise.race([
            dispatched.then(() => undefined, () => undefined),
            onceAccepted(turnClient!, hostState.sessionId!, RUN_ACCEPT_WINDOW_MS),
          ]);
        } finally {
          turnClient!.off("message_accepted", noteAccepted);
        }
        // A once task this send cannot show the Harness took is never offered again: it is sealed
        // and reported, and a late acceptance confirms nothing.
        if (!attributable || !acknowledgedHere) agent.releaseTurns(turnIds);
        // LEAVING THE GATE UNACKNOWLEDGED IS A DEBT, NOT A CLEAN EXIT. This send is still open and
        // can still emit its acceptance after the next dispatch has begun, which is precisely how a
        // reviewer produced an acknowledgement for a send that never received one. Releasing the
        // gate is still right, because a silent Harness must not be able to starve the queue, but
        // the NEXT send must know that an unattributable event is possible until this one settles.
        //
        // `dispatched` is the TURN, and its settling does prove the Harness is finished with this
        // request, so the debt clears itself on the ordinary path. It is not a timeout standing in
        // for a proof.
        if (!acknowledgedHere) oweAcceptanceDebt(dispatched);
        return { dispatched };
      });
      await runTurn;
      closeEventRun();
      await events?.settled();
      // The SDK's event iterator returns normally when its socket closes. That is not a successful
      // turn: the model may never have received the injection, so preserving the inbox batch is the
      // only safe outcome. The reconnect path redrives it after it reattaches the owned session.
      if (hostState.reconnecting || hostState.client !== turnClient)
        throw new Error("Jcode Harness connection closed during the turn; leaving the inbox batch unacknowledged");
      // A directed DM can be accepted into Jcode's persistent soft-interrupt queue while this run is
      // active. Wait for that request to settle before reading the exact containing-turn ledger.
      await hostState.steerSettled;
      const committed = hostState.surfacedIds;
      hostState.surfacedIds = [];
      if (committed.length) agent.drainInboxDeliveries(committed);
      agent.releaseInFlight(committed);
      publishInboundHealth();
      // A turn that SUCCEEDS clears the backoff: the next failure starts from the short delay again
      // rather than inheriting a penalty the seat has already recovered from.
      hostState.errorRetryMs = ERROR_RETRY_INITIAL_MS;
      hostState.consecutiveFailures = 0;
      hostState.lastTurnError = undefined;
      if (mentionWake && hostState.pendingMentionWake === mentionWake) hostState.pendingMentionWake = undefined;
    } catch (error) {
      closeEventRun(error as Error);
      await events?.settled();
      // Jcode acknowledged this send before refusing it, so the acceptance marked its run turns
      // surfaced although the model never saw them. Offer them again; left surfaced, they would end
      // on a `done` for work nobody did, or wait out their deadline (#5918).
      if (isJcodeBusyRefusal(error) && ownSend === hostState.plainSends) agent.unsurfaceTurns(turnIds);
      if (!hostState.nativeTreePreserved || (!hostState.reconnecting && hostState.client === turnClient)) {
        agent.releaseInFlight(hostState.surfacedIds);
        hostState.surfacedIds = [];
      }
      hostState.consecutiveFailures++;
      const condition = jcodeTurnCondition(error);
      if (condition) relayTurnCondition(condition);
      writeJcodeDiagnostic(
        `[cotal-jcode] turn failed (${hostState.consecutiveFailures} in a row): ${(error as Error).message}\n`,
      );
    } finally {
      hostState.turnActive = false;
      // Keep dispatch owned until the terminal presence write has selected this turn's yields.
      // Otherwise the next message can be accepted before that queued idle settles its goals.
      // The recovering client owns the one post-close redrive. An old turn that finishes after
      // replacement must not race it and make the recovery look successful while its own work is
      // merely retried — or re-paced — by a stale finally block.
      if (!hostState.reconnecting && hostState.client === turnClient) {
        // The ack lives inside the try, so a failed turn leaves its batch UN-acked and pendingWake()
        // stays positive. Re-driving immediately therefore re-sends the same batch to the same
        // provider with no delay and no limit - one deterministic failure became a hot loop that
        // re-paid the full injection in tokens on every pass (#790, measured at 62 resends).
        //
        // The codex host already solved this with scheduleErrorRetry; this is the same shape.
        if (hostState.consecutiveFailures > 0) {
          // "waiting", not "idle": PresenceStatus has no degraded state, and idle is a lie here - the
          // seat is not ready for work, it is holding an un-acked batch and pacing a retry. An idle
          // label is exactly what made a hot-looping seat look healthy in the roster.
          await agent.setStatus("waiting").catch(() => {});
          hostState.driving = false;
          scheduleErrorRetry();
        } else {
          await agent.setStatus("idle").catch(() => {});
          hostState.driving = false;
          if (hasDriveWork()) void drive();
        }
        // Both branches, and after both, because a turn that ended with work still owed is the
        // other way this queue is left unserved: `scheduleErrorRetry` gives up after eight failures
        // (#790) and `hasDriveWork()` reads false for automatic items the previous turn already
        // accepted but never committed. The server re-checks the ledger itself.
        armQueueFallback();
      } else {
        hostState.driving = false;
      }
    }
  };

  /** The automatic deliveries among `items` the live session has not accepted yet. `surfacedIds` is
   *  the accepted ledger, so subtracting it is what makes "unserved" mean unserved rather than
   *  merely queued. */
  const unserved = (items: readonly InboxItem[]): InboxItem[] => {
    const surfaced = new Set(hostState.surfacedIds);
    return items.filter((item) => !surfaced.has(item.recvKey) && !hostState.reservedIds.has(item.recvKey));
  };

  /** Queue directed automatic traffic in Jcode's live session while a turn owns the provider. Jcode
   *  incorporates soft interrupts at its documented safe points (after provider streaming / tools),
   *  including a persisted fallback across a private bridge replacement. Ambient channel chatter
   *  stays buffered for the next turn. Exact-id accounting makes the accepted set independent of
   *  physical inbox order, and the containing turn's clean completion remains the only commit. */
  const steerPending = async (): Promise<void> => {
    if (hostState.steering || !sessionBusy() || !hostState.client || !hostState.sessionId) return;
    hostState.steering = true;
    try {
      for (;;) {
        const items = await agent.takeChosen("automatic", (preview) =>
          unserved(preview).filter((item) => item.kind !== "channel" || item.mentionsMe));
        if (!items.length || !sessionBusy()) return;
        const injection = formatInjection(items);
        if (!injection) return;
        const current: JcodeClient = hostState.client;
        // Reserve BEFORE the write, and reserve in the RESERVATION set rather than the accepted
        // ledger. `surfacedIds` is what the turn boundary acks. Resolving `sendMessage`/`softInterrupt`
        // does not by itself prove the session took the text (the SDK's acceptance wait RESOLVES on
        // timeout). Reserving here makes the batch unselectable by concurrent paths without claiming
        // acceptance.
        const keys = items.map((item) => item.recvKey);
        const releaseReservation = reserveForHandover(keys);
        if (!releaseReservation) return;
        let dispose = (): void => {};
        const release = (): void => {
          dispose();
          unansweredSteers.delete(release);
          releaseReservation();
        };
        // NOT gated, and this is a correctness point rather than an optimisation. The soft interrupt
        // goes out via the SDK's `requestOk`, whose reply is matched by `reply_to` against the
        // request's own id, so its acceptance is ALREADY correlated and cannot be satisfied by
        // another send's event. Only the uncorrelated `message_accepted` path needs exclusivity.
        //
        // A run can hold the dispatch gate for its acceptance window. Gating a steer behind it
        // would delay mid-turn delivery, so this already-correlated path must remain ungated.
        const pending = softInterruptWithLateReply(current, hostState.sessionId, injection, (accepted) => {
          // The SDK emits a correlated reply as an event after its waiter times out. Only this
          // still-owned request's positive reply promotes it; the normal turn boundary still acks.
          if (!unansweredSteers.has(release) || hostState.client !== current) return;
          if (accepted) promoteToSurfaced(keys);
          release();
        });
        dispose = pending.dispose;
        const request = pending.request;
        hostState.steerSettled = request.catch(() => {});
        try {
          await request;
        } catch (error) {
          // A request timeout drops only the SDK waiter. The same native session can apply the
          // interrupt later, so do not hand these keys over again during this busy turn.
          // A boundary or connection replacement releases the hold without claiming acceptance.
          if (hostState.client === current && sessionBusy()
            && error instanceof HarnessError && error.code === "timeout") {
            unansweredSteers.add(release);
          } else release();
          throw error;
        }
        // The live session took it. Whatever made a previous handoff fail is over, so the fallback
        // tier stands down and the next batch uses the cheap mid-turn path again.
        hostState.softInterruptFailed = false;
        // If the turn closed or the client was replaced while acceptance was in flight, retain the
        // inbox copy. Jcode may also have queued it, so this deliberately chooses at-least-once.
        if (!sessionBusy() || hostState.client !== current) {
          release();
          return;
        }
        // Accepted by the live session: promote the reservation into the accepted ledger, which the
        // containing turn's clean boundary will ack. Promotion and release are exclusive.
        promoteToSurfaced(keys);
        release();
      }
    } catch (error) {
      // #1233. This catch used to be the whole story: it logged, `steering` was cleared below, and
      // nothing ever looked at this queue again unless a NEW message arrived while the session was
      // still busy, or the session went idle. Neither is guaranteed, and on the measured seat
      // neither happened for 13.8 hours. Recording the failure and arming the level-triggered
      // server is what makes the queue served by something other than luck.
      hostState.softInterruptFailed = true;
      writeJcodeDiagnostic(`[cotal-jcode] soft interrupt failed: ${(error as Error).message}\n`);
    } finally {
      hostState.steering = false;
      // In the `finally`, so it also arms after a `return` from the loop's own guards: any exit that
      // leaves items unserved must leave the server armed, or the guard becomes the new stall.
      armQueueFallback();
    }
  };

  /** What is still owed, counting the held role requests that may be taken now. */
  const unservedAutomatic = (): InboxItem[] => unserved(agent.inboxPreview("automatic"));

  const fallbackState = (): FallbackState => ({
    stopping: hostState.stopping,
    queuedTurnTierStopped: hostState.queuedTurnTierStopped,
    reconnecting: hostState.reconnecting,
    initialized: hostState.initialized,
    hasSession: Boolean(hostState.client) && Boolean(hostState.sessionId),
    sessionBusy: sessionBusy(),
    steering: hostState.steering,
    softInterruptFailed: hostState.softInterruptFailed,
    unserved: unservedAutomatic().length,
    driveWork: hasDriveWork(),
    consecutiveFailures: hostState.consecutiveFailures,
    giveUpAfter: ERROR_RETRY_GIVE_UP,
  });

  /**
   * The fallback delivery itself: hand the unserved batch to the Harness as an ordinary message.
   *
   * This is the path that does not depend on a `soft_interrupt` reply. The Harness accepts a plain
   * `send_message` while the agent is busy, acknowledges it with `message_accepted`, and runs it as
   * its own turn when the current one ends — measured against jcode 0.81.5, which is also why the
   * no-reply (context_message) form is NOT used here: that one is refused outright while busy.
   *
   * Acceptance is recorded in the same ledger the soft-interrupt path uses, so the containing turn's
   * clean boundary remains the sole ack site and a message delivered this way is committed exactly
   * once. If this send itself fails, nothing is recorded and nothing is dropped: the loop re-arms
   * and the delivery is attempted again.
   */
  const queueTurnFallback = async (): Promise<void> => {
    const owed = unservedAutomatic();
    if (!owed.length) return;
    // A LAPSED SEND HAS POISONED ACCEPTANCE ON THIS CONNECTION, and the two obvious responses are
    // both unsafe.
    //
    // Keep re-delivering and every attempt is accepted and EXECUTED by a healthy Harness, so the
    // same non-idempotent instruction runs once a minute forever; a reviewer measured three
    // executions of one batch. Stand down entirely and an unacknowledged send is never retried at
    // all, which breaks the guarantee this tier exists for: late delivery beats loss, but silence
    // is not late delivery.
    //
    // So the response is neither. Re-delivery continues, because the batch is genuinely owed, and
    // what changes is that the connection is REPLACED first: the replacement attaches the same
    // session, the batch is still unacked, and it is redriven once on a connection where an
    // acknowledgement is attributable again. Recovery is requested at most once here, and the
    // existing one-shot guard governs it, so this cannot become a reconnect loop.
    if (hostState.acceptanceSuspectUntilBridgeReplaced && !hostState.bridgeReplacementRequestedForSuspicion) {
      hostState.bridgeReplacementRequestedForSuspicion = true;
      // A missing acknowledgement poisons this API connection, not the live native session.
      // Reconnect to the same owned bridge instead of killing a TUI-owned tool and its server.
      if (hostState.tui && sessionBusy()) {
        const suspect = hostState.client;
        writeJcodeDiagnostic(
          `[cotal-jcode] a queued turn lapsed without acknowledgement while the session is busy; ` +
            `replacing only the Harness API connection; preserving the private Jcode tree if ` +
            `the same bridge reconnects and attaches within ${BRIDGE_RECOVERY_WINDOW_MS}ms; ` +
            `otherwise ending the seat and stopping its tree\n`,
        );
        if (suspect) void recoverBridge(suspect, true);
        return;
      }
      const suspect = hostState.client;
      writeJcodeDiagnostic(
        `[cotal-jcode] a queued turn lapsed with no acknowledgement, so acceptance on this ` +
          `connection can no longer be attributed; replacing the Harness connection before ` +
          `re-delivering ${owed.length} queued automatic message(s)\n`,
      );
      if (suspect) void recoverBridge(suspect);
    }
    // Do not write into a connection that is being replaced. The send would fail on the closing
    // socket and burn an attempt without reaching the seat, which is how the first version of this
    // produced a `disconnected: harness connection closed` in place of a delivery. The batch stays
    // owed and the level-triggered loop re-arms, so the next tick delivers it on the replacement
    // where acceptance is attributable again: this defers one attempt rather than dropping it.
    if (hostState.acceptanceSuspectUntilBridgeReplaced || hostState.reconnecting) return;
    // DO NOT WRITE A FRAME THAT CANNOT BE ATTRIBUTED. While a run's acceptance window has lapsed,
    // any `message_accepted` may belong to that run, so a send issued now is refused on arrival no
    // matter how healthy it is, stays owed, and is re-sent every tick -- while the Harness accepts
    // and EXECUTES every copy. A reviewer measured 4 executions from 4 send frames that way.
    //
    // Deferring costs one turn of latency: the run's promise settles when the turn ends, and the
    // next tick sends ONCE and can attribute the answer. The batch stays owed and unacked, so this
    // defers delivery rather than dropping it.
    //
    // AND THE DEFERRAL IS BOUNDED, because a second reviewer showed that waiting on a run is waiting
    // on an edge that may never come: a turn that missed its acceptance and never completes settles
    // nothing, and an unbounded deferral would starve the queue exactly as the original stall did.
    // Past the bound the run is unsettleable rather than slow, which is the lapsed-send case, so it
    // takes that answer and the boundary is forced below.
    if (hostState.unsettledLapsedDispatches > 0) {
      if (hostState.deferralStartedAt === undefined) hostState.deferralStartedAt = Date.now();
      const blockedForMs = Date.now() - hostState.deferralStartedAt;
      if (attributionBlockedByOpenRun(hostState.unsettledLapsedDispatches, blockedForMs)) {
        // Say it ONCE per episode. A silent return is why an operator cannot tell this deferral
        // from the stall it replaces, and why a test could not witness that it engaged at all.
        // Once per episode rather than per tick: the fallback is level-triggered and would
        // otherwise print this every second for the life of the run.
        if (!hostState.deferralAnnounced) {
          hostState.deferralAnnounced = true;
          writeJcodeDiagnostic(
            `[cotal-jcode] a run has not acknowledged within its window; deferring ${owed.length} ` +
              `queued automatic message(s) until it settles, so delivery cannot be misattributed\n`,
          );
        }
        return;
      }
      if (deferralExhausted(hostState.unsettledLapsedDispatches, blockedForMs)) {
        // The run is unsettleable, so the connection boundary is the answer -- BUT ONLY IF THERE IS
        // ONE LEFT TO TAKE. `recoverBridge` is one-shot: once spent it does not replace anything, it
        // calls `shutdown(1)` and the seat exits. Forcing the boundary here on a spent recovery
        // would kill the seat rather than restore delivery. When no recovery remains, the branch
        // below stops the queued-turn tier and leaves the batch unacked for redelivery elsewhere.
        if (exhaustedDeferralAction(!hostState.bridgeRecoveryUsed) === "replace-bridge") {
          hostState.acceptanceSuspectUntilBridgeReplaced = true;
          writeJcodeDiagnostic(
            `[cotal-jcode] a run held acceptance unattributable for ${Math.round(blockedForMs / 1000)}s ` +
              `without settling, so it is treated as unsettleable; replacing the Harness connection ` +
              `before re-delivering ${owed.length} queued automatic message(s)\n`,
          );
          return;
        }
        // NO RECOVERY LEFT, AND NEITHER OBVIOUS ANSWER IS SAFE. Forcing the boundary calls into a
        // spent `recoverBridge`, which does not replace anything: it calls `shutdown(1)` and the
        // seat exits, answering a starvation report by killing the seat. Continuing to WRITE is no
        // better: the send is refused as unattributable, the batch stays owed, and the level-triggered
        // loop re-sends once a minute for as long as the run stays open, while the Harness accepts and
        // RUNS each copy. Nothing caps that at two. It is the measured 4-executions defect reached
        // through the last remaining door.
        //
        // So this takes the #790 give-up's answer, which is the precedent already in this module for
        // "cannot serve, must not pretend, must not discard": STOP ATTEMPTING, and leave the batch
        // OWED AND UN-ACKED. No frame is written, so the instruction cannot execute again. Nothing
        // is acked, so the durable copy survives and redelivers to a replacement seat. And the
        // connection state stops reporting `ready`, so a seat in this condition is visible as stalled
        // rather than silently healthy, which is the whole point of #1233's status work.
        //
        // This is a terminal state for the SEAT, not for the MESSAGE. That distinction is the one
        // the reviewer asked for: seat liveness is preserved (the process stays up, DMs still land,
        // the steer and drive tiers are untouched) while the queue's ownership passes on rather than
        // being executed repeatedly here.
        if (!hostState.queuedTurnTierStopped) {
          hostState.queuedTurnTierStopped = true;
          writeJcodeDiagnostic(
            `[cotal-jcode] a run held acceptance unattributable for ${Math.round(blockedForMs / 1000)}s ` +
              `and the one bridge recovery is already spent, so the queued-turn tier stops attempting; ` +
              `${owed.length} automatic message(s) stay queued and UN-ACKED for redelivery\n`,
          );
          // AND SAY SO WHERE AN OPERATOR LOOKS, not only in a log nobody tails. A reviewer accepted
          // that terminalization is not itself a `stalled` state (that verdict belongs to the queue's
          // own no-progress clock) ON THE CONDITION that queued depth and age stay visible meanwhile.
          // This is the one path that stops serving the queue without an ack, so it is exactly where
          // a silent roster row would misrepresent the seat: the depth is real, it is not moving, and
          // the seat must carry that in its presence rather than in a diagnostic.
          publishInboundHealth();
        }
        return;
      }
    } else { hostState.deferralStartedAt = undefined; hostState.deferralAnnounced = false; }
    // A role request is shown only once its take is recorded (SPEC §8.1), so the batch is taken here,
    // past every reason above to send nothing.
    const items = await agent.takeChosen("automatic", unserved);
    const injection = formatInjection(items);
    if (!injection) return;
    const current = hostState.client;
    const session = hostState.sessionId;
    if (!current || !session) return;
    const keys = items.map((item) => item.recvKey);
    // Reserve BEFORE the write, in the RESERVATION set rather than the accepted ledger.
    //
    // Found in review. `sendMessage` resolves on the Harness's `message_accepted`, so everything
    // after this await happens in a window the rest of the host can observe — and a newly arriving
    // directed message calls `steerPending()` straight from the `incoming` handler. When ownership was
    // recorded only after the await, that path recomputed "unserved" from a ledger this batch was not
    // in yet and offered the SAME items again as a soft interrupt. Reproduced in the fixture log: the
    // marker's accepted `send_message`, then the same marker in a following `soft_interrupt`.
    //
    // It is the reservation and not the accepted ledger because the SDK's acceptance wait RESOLVES on
    // timeout rather than rejecting, so a resolved send is not proof the session took the text.
    // Reserving makes the batch unselectable; only verified acceptance promotes it to the ledger the
    // turn boundary acks. Any other outcome releases, leaving the delivery owed and un-acked.
    const release = reserveForHandover(keys);
    if (!release) return;
    // Observe `message_accepted` OURSELVES rather than inferring acceptance from the await.
    //
    // Found in review, and it is the difference between a late delivery and a lost one. The SDK's
    // acceptance wait RESOLVES on its own timeout rather than rejecting ("the stream is the source of
    // truth", jcode-sdk client.js), so `await sendMessage(...)` returning proves only that the frame
    // was written and that we waited. A busy Harness that takes the frame and never acknowledges it
    // therefore looked, to the old code, exactly like a successful delivery: the batch was recorded
    // as accepted and the next clean turn boundary ACKED it, so a peer message the session never
    // accepted and never ran was dropped from the durable inbox. Measured by a reviewer as
    // swallowedSends=1, acceptedSends=0, turnsRunCarryingA=0, LOST=true.
    //
    // So acceptance is proved by the acknowledgement, not by the resolve. Without it the reservation
    // is released and the batch stays un-acked, which keeps it owed: the level-triggered loop will
    // re-attempt, and late delivery beats loss.
    // ...AND the acknowledgement is only attributable while this send is the ONLY one outstanding
    // for the session, which is what the dispatch gate below establishes. `message_accepted` carries
    // a session id and nothing more, so without exclusivity an unrelated send's ordinary
    // acknowledgement flips this flag and a swallowed delivery is recorded as accepted. A reviewer
    // measured exactly that: swallowedSends 1, aRuns 0, unrelatedRuns 1, A acked and never retried.
    //
    // The listener is attached and removed INSIDE the gate, so the window in which an acceptance can
    // be attributed to this send is exactly the window in which no other send can produce one.
    let acknowledged = false;
    // Captured INSIDE the gate, below, at the moment this send begins: if any earlier dispatch is
    // still open having never acknowledged, then an event arriving now may belong to it, and this
    // send's acceptance is not attributable no matter how exclusive the gate is.
    let attributable = false;
    try {
      await withExclusiveDispatch(async () => {
        attributable = hostState.unsettledLapsedDispatches === 0 && !hostState.acceptanceSuspectUntilBridgeReplaced;
        // The deferral above was read before the wait for this gate, and a run can lapse during it.
        // A frame written now could only be refused while the Harness still runs it, and its
        // acceptance would surface that run's turns, so nothing is written.
        if (!attributable) return;
        const onAccepted = (event: ApiEvent): void => {
          if ("session_id" in event && event.session_id === session) acknowledged = true;
        };
        current.on("message_accepted", onAccepted);
        try {
          writeJcodeDiagnostic(
            `[cotal-jcode] soft interrupt is not answering; delivering ${items.length} queued automatic ` +
              `message(s) as a queued Harness turn instead\n`,
          );
          hostState.plainSends++;
          await current.sendMessage(session, injection);
        } finally {
          current.off("message_accepted", onAccepted);
        }
      });
      // The client can be replaced while the send is in flight. A replacement redrives the durable
      // batch itself, so holding ownership would suppress a delivery the new session never saw —
      // release and let the redrive own it, the same at-least-once stance the steer path takes.
      if (hostState.client !== current) {
        release();
        return;
      }
      // Deferred, not refused: nothing was written, and the next tick defers on the run's debt.
      if (!attributable) {
        release();
        return;
      }
      if (!acknowledged) {
        // Written but never acknowledged. Recording it as accepted is what turned a stall into LOSS,
        // so it is refused: released, un-acked, still owed, retried by the loop.
        //
        // AND THIS SEND IS NOW ITSELF A LAPSED ONE. The SDK resolved
        // our `sendMessage` on its own accept wait, which proves only that we stopped listening: the
        // request is still live at the Harness and may emit its session-only acceptance at any
        // later point, when some other batch is the one waiting. Nothing settles that promise in a
        // way that proves otherwise, so the debt cannot be discharged by waiting.
        //
        // SO SUSPICION MUST FORCE THE BOUNDARY RATHER THAN WAIT FOR ONE. A reviewer measured what
        // happens if it merely waits: on a healthy bridge that never closes, nothing ever clears it,
        // the batch stays owed forever, and the level-triggered loop re-delivers it about once a
        // minute. Every one of those is ACCEPTED by the live Harness, so the same instruction
        // EXECUTES repeatedly, which is worse than the loss this refusal prevents. Non-idempotent
        // peer instructions run again and again, and the durable inbox cannot help because a
        // redelivery only refreshes the same pending entry.
        //
        // Replacing the bridge is the boundary, and it is a real repair rather than a reset: the
        // replacement attaches the SAME session, the batch is still owed and unacked, and the
        // redrive delivers it once on a connection where acceptance means something again. The
        // existing one-shot guard still governs how many times this may happen, and if recovery is
        // already spent the seat stops rather than pretending it can serve the queue.
        //
        // The request itself is made by the fallback's next tick rather than here, so it happens on
        // the retry path where the batch is still owed and can be redriven, instead of inside a
        // handover that is already unwinding.
        hostState.acceptanceSuspectUntilBridgeReplaced = true;
        release();
        writeJcodeDiagnostic(
          `[cotal-jcode] queued turn was not acknowledged (no message_accepted); ${items.length} ` +
            `automatic message(s) remain queued for redelivery\n`,
        );
        return;
      }
      promoteToSurfaced(keys);
      release();
      publishInboundHealth();
    } catch (error) {
      release();
      writeJcodeDiagnostic(`[cotal-jcode] queued-turn fallback failed: ${(error as Error).message}\n`);
    }
  };

  /** Pacing for the level-triggered server. Reset whenever a delivery is accepted, so a seat that
   *  recovers does not inherit a minute-long delay from the stall it just left. */
  hostState.fallbackDelayMs = FALLBACK_INITIAL_MS;
  hostState.fallbackTimer = undefined;
  hostState.fallbackRunning = false;

  /**
   * Arm the level-triggered server for the automatic queue (#1233).
   *
   * Every OTHER path that serves this queue is edge-triggered — an arriving message, an idle
   * transition — and the defect is that both edges can be absent forever while work is owed. This
   * one is armed by the state of the queue rather than by an event, so the question it answers is
   * "is anything still owed", which cannot be missed the way an edge can.
   *
   * At most one timer, never while stopping, and unref'd so it can never hold the process open.
   */
  const armQueueFallback = (): void => {
    if (hostState.stopping || hostState.fallbackTimer !== undefined) return;
    if (!fallbackStillOwed(fallbackState())) return;
    const delay = hostState.fallbackDelayMs;
    hostState.fallbackDelayMs = nextFallbackDelay(hostState.fallbackDelayMs);
    hostState.fallbackTimer = setTimeout(() => {
      hostState.fallbackTimer = undefined;
      void serveQueueFallback();
    }, delay);
    hostState.fallbackTimer.unref?.();
  };

  const serveQueueFallback = async (): Promise<void> => {
    if (hostState.fallbackRunning) return;
    hostState.fallbackRunning = true;
    try {
      const before = fallbackState();
      const decision = nextFallbackAction(before);
      if (decision.action === "stop") return;
      if (decision.action === "drive") await drive();
      else if (decision.action === "steer") await steerPending();
      else if (decision.action === "queue-turn") await queueTurnFallback();
      // A tick that delivered something resets the pacing; one that could not keeps backing off.
      // Measured on the ledger, not on the action taken: an attempt that returned without accepting
      // anything has not served the queue, and treating the call itself as progress is how a
      // retry loop keeps a fast cadence forever against a session that is taking nothing.
      if (unservedAutomatic().length < before.unserved) hostState.fallbackDelayMs = FALLBACK_INITIAL_MS;
    } finally {
      hostState.fallbackRunning = false;
      armQueueFallback();
    }
  };

  /** A connector line that ends the seat, naming the last turn error while no turn has succeeded
   *  since it. The manager's `seat reaped:` line keeps only the first 240 characters of this line, so
   *  that error goes ahead of the recovery error, whose length the Harness decides. */
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

  const watchClient = (connected: JcodeClient): void => {
    connected.on("close", () => void recoverBridge(connected));
    const flushNativeEvent = (event: ApiEvent): void => {
      if (!("session_id" in event) || event.session_id !== hostState.sessionId) return;
      // Every work event of this seat's session, host- or TUI-owned, is progress the Harness reported:
      // presence `activeAt`, so a turn that stopped advancing shows its age beside a live heartbeat (#618).
      agent.noteActivity();
      if (!events?.running || !hostState.eventJournal) return;
      events?.flush(hostState.eventJournal);
    };
    // The live API is only a wake signal. The holder serializes every flush and the source rereads
    // the append-only journal from its durable cursor, so several deltas may enqueue redundant
    // empty reads but can neither reorder nor duplicate a record.
    for (const kind of [
      "text_delta",
      "reasoning_delta",
      "reasoning_done",
      "tool_start",
      "tool_input_delta",
      "tool_exec",
      "tool_done",
      "token_usage",
    ] as const)
      connected.on(kind, flushNativeEvent);
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
  };

  return { drive, steerPending, armQueueFallback, watchClient };
}
