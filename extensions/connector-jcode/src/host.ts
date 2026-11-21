import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { join, resolve } from "node:path";
import { JcodeClient, launchInstance, type ApiEvent } from "@1jehuang/jcode-sdk";
import { loadAgentFile, type PresenceCondition } from "@cotal-ai/core";
import { mirrorJcodeCredentials, removeJcodeCredentials, shortSocketHome, type ShortSocketHome } from "./private-state.js";
import { captureProcessIdentity, launchIdentityEnv, recordLaunch, recordOnceLaunch, stopOrphanedTree, stopPrivateTree, type ProcessIdentity } from "./private-lifecycle.js";
import { connectSteerClient } from "./steer-replies.js";
import { chooseSessionToResume, type ResumeCandidate } from "./session-resume.js";
import { forkJcodeSession, markJcodeForkBriefed, type JcodeFork } from "./session-fork.js";
import { activeModelRoute, bareModelId, describeRoute, effectiveProvider } from "./route-identity.js";
import {
  classifyReadinessFailure,
  classifyReadinessProviderRefusal,
  installJcodeDiagnosticLog,
  JcodeConnectorError,
  JcodeModelMismatch,
  JcodeCursorStateUnreadable,
  JcodeSessionsEnumerationFailure,
  JcodeSessionsUnwritableFailure,
  jcodeEffortRefusal,
  writeJcodeDiagnostic,
} from "./startup-diagnostics.js";
import {
  boundStoredSessionCause,
  classifyStoredSessionPanic,
  inspectStoredSessions,
  isEmptyStoredSessionsDirectory,
  storedSessionsPath,
  unwritableStoredSessions,
} from "./stored-sessions.js";
import {
  MeshAgent,
  AguiEmitter,
  AguiEmitterHolder,
  eventPlaneStopped,
  EventWal,
  FileSubjectFrontier,
  configFromEnv,
  controlFromEnv,
  envFlag,
  eventPlaneArmed,
  fmtChannel,
  fmtFrom,
  registerOnceExit,
  scrubLaunchMaterial,
  startControlServer,
  ensureEventWalDir,
  resolveEventsStateRoot,
  type InboxItem,
  type PrincipalLock,
} from "@cotal-ai/connector-core";
import { principalKey } from "@cotal-ai/core";
import { createJcodeMapper, type JcodeMapper, type PositionedJcodeJournalRecord } from "./agui-map.js";
import { initializeJcodeEventBoundary, JcodeJournalSource, jcodeJournalPath, positionedJcodeJournalSource } from "./agui-source.js";
import {
  TUI_STOP_GRACE_MS,
  readinessTurnTimeoutMs,
  requestTimeoutOverrideMs,
  privateAgentHome,
  assertNoProjectMcpConfig,
  writeMcpConfig,
  relayEndpoint,
  instructions,
  startRelay,
  retireRelay,
  SEAT_ATTRIBUTION_ENV,
  noCotalEnv,
} from "./host-support.js";
import { createHostTurns, type HostTurnState } from "./host-turns.js";
export {
  BRIDGE_RECOVERY_WINDOW_MS,
  PERMANENT_BRIDGE_RECOVERY_CODES,
  PERMANENT_BRIDGE_CONNECT_CAUSE_CODES,
  permanentBridgeRecoveryFailure,
  isJcodeBusyRefusal,
} from "./host-support.js";

export async function runJcodeHost(): Promise<void> {
  const config = configFromEnv();
  config.connector = "jcode";
  const control = controlFromEnv();
  if (!control) throw new Error("jcode connector: managed session has no control endpoint");
  const binary = process.env.COTAL_JCODE_BIN?.trim() || "jcode";
  const tuiOverride = envFlag(process.env, "COTAL_JCODE_TUI");
  const bootPrompt = process.env.COTAL_JCODE_PROMPT?.trim();
  // A once seat records each native launch under its uid, and stops its Jcode tree before anything
  // else when it exits, so neither a stalled teardown nor its own death leaves the task running.
  const onceUid = process.env.COTAL_JCODE_ONCE === "1" ? config.lifecycleUid : undefined;
  if (process.env.COTAL_JCODE_ONCE === "1" && !onceUid) throw new Error("jcode connector: a once seat has no lifecycle uid");
  // Startup owns the kickoff until the Harness request is invoked. Any return before that boundary
  // is provably unsent and safe to defer; after invocation acceptance is not knowable, so it is
  // consumed and never guessed back into the queue.
  const hostState = {} as HostTurnState;
  hostState.pendingKickoff = bootPrompt;
  const readinessBudgetMs = readinessTurnTimeoutMs();
  // Read BEFORE the COTAL_ scrub below, for the same reason the readiness bound is: the endpoint is
  // the sole reader of Cotal material and every COTAL_ key is deleted from the environment before
  // the private instance is launched, so a value read at launch time would always be absent.
  const requestTimeoutMs = requestTimeoutOverrideMs();
  const eventsArmed = eventPlaneArmed(config);
  const eventsWorkspaceRoot = eventsArmed ? resolveEventsStateRoot(process.env) : undefined;
  const def = process.env.COTAL_AGENT_FILE?.trim() ? loadAgentFile(process.env.COTAL_AGENT_FILE.trim()) : undefined;
  const cwd = process.cwd();
  assertNoProjectMcpConfig(cwd);
  const home = privateAgentHome(config.space, config.name);
  installJcodeDiagnosticLog(home);
  // A lifecycle killed without its teardown leaves its Jcode server holding this seat's runtime
  // dir for five more minutes. Adopt and stop it before claiming the home; a tree whose connector
  // is still alive is a live seat and is left to Jcode's own runtime-dir lock (#1211).
  try {
    const stopped = await stopOrphanedTree({ home });
    if (stopped.length)
      writeJcodeDiagnostic(`[cotal-jcode] stopped ${stopped.length} Jcode process(es) left running by a previous lifecycle of this seat\n`);
  } catch (error) {
    // Connector-owned text naming only PIDs. Launch anyway: Jcode's own lock refuses next, and it
    // names the runtime directory it is refusing on in the seat's private log.
    writeJcodeDiagnostic(`[cotal-jcode] ${(error as Error).message}\n`);
  }
  // SDK 1.1.0 has no socket-path launch option: it derives `run/jcode-api.sock` below jcodeHome.
  // The managed home stays in the workspace, but this private short alias keeps that fixed API
  // path below AF_UNIX's platform limit. Failure is fatal; a long-path fallback is the reported bug.
  let socketHome: ShortSocketHome;
  const resumeSource = process.env.COTAL_JCODE_RESUME?.trim();
  let fork: JcodeFork | undefined;
  try {
    mirrorJcodeCredentials(home);
    // `cotal spawn --resume`: the fork is on disk before the seat's instance first reads its sessions.
    if (resumeSource) {
      const sourceHome = process.env.COTAL_JCODE_RESUME_HOME?.trim();
      if (!sourceHome) throw new Error("COTAL_JCODE_RESUME_HOME is not set — the launch must name the home it validated the source in");
      fork = forkJcodeSession({ sourceHome, sessionId: resumeSource, seatHome: home, cwd });
    }
    socketHome = shortSocketHome(home);
  } catch (error) {
    // Cursor's refusal carries its own public code and connector-owned text.
    if (error instanceof JcodeCursorStateUnreadable) throw error;
    // These refusals name local paths, which the public startup diagnostic never renders, so
    // without their own code they all reported as `(unknown)` and an operator could not tell a
    // wedged seat from a broken connector (#1211).
    throw new JcodeConnectorError("private_state", "jcode connector: the seat's private Jcode state could not be prepared", { cause: error });
  }
  /** Only after a verified stop: nothing of this lifecycle can read the seat's credential copies any
   *  more, and the next launch mirrors them afresh (#5641). The home itself stays for its resume record. */
  const removeCredentials = (): void => {
    try {
      removeJcodeCredentials(home);
    } catch (error) {
      writeJcodeDiagnostic(`[cotal-jcode] the seat's credential copies could not be removed: ${(error as Error).message}\n`);
    }
  };
  const relay = relayEndpoint(config.space, config.name);

  // The endpoint is the sole reader of Cotal material. Once it has parsed config/control, neither
  // Jcode itself nor the MCP child can inherit the material pointer or its broker credential; only
  // the non-secret seat attribution variables (`cotal stop --self`) are carried into Jcode.
  scrubLaunchMaterial();
  const seatEnv: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined && SEAT_ATTRIBUTION_ENV.has(key)) seatEnv[key] = value;
    if (key.startsWith("COTAL_")) delete process.env[key];
  }

  // The card reports the captured event-plane decision because COTAL_EVENTS is stripped above.
  const agent = new MeshAgent(config, undefined, { eventsArmed, eventsWorkspaceRoot });
  const relayServer = await startRelay(agent, config, relay);
  writeMcpConfig(home, relay, config);

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
          // #1868: a flush landing in a mesh rebuild window measured `max_payload` off a connection
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
  hostState.eventJournal = undefined;

  const closeEventRun = (error?: Error): void => {
    if (!events?.running || !hostState.eventJournal) return;
    events.flush(hostState.eventJournal);
    events.closeRun(Date.now(), error ? { message: error.message, code: error.name } : undefined);
  };

  const ensureEventsBound = async (): Promise<void> => {
    if (!events || !hostState.eventJournal || events.running) return;
    events.adopt(hostState.eventJournal);
    await events.settled();
  };

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

  hostState.instance = undefined;
  let launchIdentity: ProcessIdentity | undefined;
  let launchIdentityValue: string | undefined;
  hostState.client = undefined;
  let bridgeStderr = "";
  hostState.tui = undefined;
  hostState.stopping = false;
  hostState.reconnecting = false;
  hostState.bridgeRecoveryUsed = false;
  hostState.sessionId = undefined;
  hostState.driving = false;
  hostState.turnActive = false;
  hostState.briefed = false;
  hostState.initialized = false;
  hostState.wakeQueued = false;
  // Focus mentions have no automatic inbox item. Keep their wake-only hint until a turn succeeds.
  hostState.pendingMentionWake = undefined;
  /** Exact Cotal deliveries the active Harness turn has accepted, either in its initial prompt or
   *  through Jcode's session-owned soft-interrupt queue. They commit only when that containing turn
   *  finishes cleanly. A soft_interrupt `ok` proves the live recipient session queued the text; it
   *  does not prove the model consumed it yet, so the turn boundary remains the sole ack site. */
  hostState.surfacedIds = [];
  /** Plain sends written on the host's connection. Jcode reports a busy refusal as a session error
   *  with no request id, and that error also ends the run already in flight. A run can attribute
   *  the refusal to its own send only when no later plain send was written. */
  hostState.plainSends = 0;
  // A client-only recovery leaves accepted work owned by the same native session.
  // In particular an old run() rejecting on client close must not discard that ledger.
  hostState.nativeTreePreserved = false;
  const unansweredSteers = new Set<() => void>();
  const releaseUnansweredSteers = (): void => {
    for (const release of unansweredSteers) release();
    unansweredSteers.clear();
  };
  /**
   * Serialises everything that can make this session emit `message_accepted`.
   *
   * Found in review at 0a0bf255a, and the root cause is in the PROTOCOL, not in our bookkeeping:
   * `message_accepted` carries a `session_id` and nothing else. There is no request id, no sequence
   * number, no echo of the content. So an acceptance event is attributable to a specific send ONLY
   * if exactly one send for that session is outstanding when it arrives. A reviewer measured the
   * consequence end to end: the fallback's A is swallowed and left waiting; an unrelated B is later
   * dispatched on the same client and session; B's perfectly ordinary acknowledgement flipped A's
   * listener, so A was promoted, acked out of the durable inbox, never run and never retried. That
   * is silent loss caused by a NORMAL event rather than by a missing one, which makes it worse than
   * the no-ack case it was meant to fix.
   *
   * The SDK has the same session-only predicate, so one event resolves both its promises too. It
   * cannot be fixed by reading the event more carefully: the information is not in it.
   *
   * So the invariant is established rather than inferred. Every dispatch that can produce an
   * acceptance for this session runs inside this gate, one at a time, and the acceptance window
   * closes before the next dispatch may open. Then "an acceptance arrived while my send was the
   * only one outstanding" is a fact about the system, not a guess about interleaving.
   *
   * This serialises HANDOVERS, not the seat. Nothing here holds the provider or delays the model.
   */
  let sessionDispatch: Promise<unknown> = Promise.resolve();
  /**
   * How many dispatches left the gate WITHOUT ever seeing their own acknowledgement, and have not
   * settled since.
   *
   * This exists because the gate alone is not sufficient, which a reviewer proved against the real
   * SDK: the run gate releases on a 10s lapse so a silent Harness cannot starve the queue, and the
   * next send then enters a session where the LAPSED send is still open and can still acknowledge
   * later. The measured result was `bAcknowledgedWithoutBAcceptance: true` from a single late
   * `message_accepted` belonging to A. A timeout proves only that A has not acknowledged YET, never
   * that it can no longer do so, and with no correlation in the event there is nothing to tell the
   * two apart when it arrives.
   *
   * So exclusivity is necessary and not sufficient, and the missing half is this: an acceptance is
   * attributable only when no OTHER send on this session could still be the one emitting it. A send
   * that lapsed and is still open is exactly such a sender, and it stays one until its own promise
   * settles, at which point the Harness has finished with that request and can no longer answer it.
   *
   * THE ASYMMETRY IS WHY THIS IS SAFE RATHER THAN MERELY CAUTIOUS. Refusing to trust an acceptance
   * that was genuinely ours costs one redelivery, because the batch stays owed and the
   * level-triggered loop re-attempts it. Trusting one that was not ours acks a message the session
   * never ran. The first is late delivery, the second is loss, and this issue exists because they
   * were treated as interchangeable.
   */
  hostState.unsettledLapsedDispatches = 0;
  /** Note a dispatch that is leaving the gate unacknowledged, and clear the debt when it settles.
   *
   *  Only pass a promise whose settlement PROVES the Harness is finished with the request. A turn's
   *  `run()` qualifies: it resolves when the turn is over. `sendMessage` does NOT, because the SDK
   *  resolves it on its own accept timeout while the request is still live at the Harness and can
   *  still emit; that case uses `suspectUntilBridgeReplaced` below. */
  const oweAcceptanceDebt = (settledWhenHarnessDone: Promise<unknown>): void => {
    hostState.unsettledLapsedDispatches += 1;
    void settledWhenHarnessDone.then(
      () => { hostState.unsettledLapsedDispatches -= 1; },
      () => { hostState.unsettledLapsedDispatches -= 1; },
    );
  };
  /**
   * A send lapsed with no acknowledgement and NOTHING can prove the Harness has finished with it.
   *
   * The SDK's `sendMessage` resolves on its own 10s accept wait, so its promise settling says only
   * that we stopped waiting. The request is still live and may still emit the session-only event.
   * There is no timeout that fixes this, because the event carries no correlation and the protocol
   * offers no ordering guarantee we could substitute for one, which a reviewer looked for and did
   * not find.
   *
   * The one boundary that genuinely holds is the CONNECTION: a replaced bridge cannot deliver an
   * event for a request made on the old one. So after such a lapse, acceptance on this client is no
   * longer attributable, and every later batch stays owed and retried rather than being acked on an
   * event that might belong to the lapsed send. Cleared when the bridge is replaced, which is the
   * same path that redrives the durable batch, so delivery still happens: it is late, not lost.
   */
  hostState.acceptanceSuspectUntilBridgeReplaced = false;
  /** When the current run-debt deferral began, so it can be bounded. Cleared whenever no run debt is
   *  outstanding, so an ordinary sequence of turns never accumulates a deferral age across them. */
  hostState.deferralStartedAt = undefined;
  /** Announce a deferral episode once, not once per level-triggered tick. Cleared with the clock. */
  hostState.deferralAnnounced = false;
  /** The queued-turn tier has stopped attempting: an unsettleable run with no recovery left. Latched
   *  so the terminal diagnostic is written once rather than on every fallback tick. Cleared on bridge
   *  replacement, where attribution and the recovery budget are both restored. */
  hostState.queuedTurnTierStopped = false;
  /** One boundary request per suspicion, so a lapsing Harness cannot become a reconnect loop. */
  hostState.bridgeReplacementRequestedForSuspicion = false;
  const withExclusiveDispatch = async <T>(operation: () => Promise<T>): Promise<T> => {
    const previous = sessionDispatch;
    let release!: () => void;
    sessionDispatch = new Promise<void>((resolve) => { release = resolve; });
    // Never inherit a prior failure: this is a mutual-exclusion gate, not an error channel.
    await previous.catch(() => {});
    try {
      return await operation();
    } finally {
      release();
    }
  };
  /** Resolve when this session acknowledges a send, or when the window lapses. Never rejects: the
   *  caller uses it only to bound how long the dispatch gate is held, and a lapse is a legitimate
   *  outcome (a Harness that never acknowledges must not be able to hold the gate open). */
  const onceAccepted = (on: JcodeClient, session: string, withinMs: number): Promise<void> =>
    new Promise<void>((resolve) => {
      const done = (): void => {
        clearTimeout(timer);
        on.off("message_accepted", listener);
        resolve();
      };
      const listener = (event: ApiEvent): void => {
        if ("session_id" in event && event.session_id === session) done();
      };
      const timer = setTimeout(done, withinMs);
      timer.unref?.();
      on.on("message_accepted", listener);
    });
  /**
   * Deliveries a handover is CURRENTLY writing to the session, which are not accepted yet (#1233).
   *
   * Deliberately NOT `surfacedIds`. That list is the accepted ledger and it is what
   * `drainInboxDeliveries` acks at the turn boundary, so putting an in-flight item there would risk
   * acking a message the session never took. This is the weaker claim, and the only one an in-flight
   * item can honestly make: "another path is already handing this over, so do not select it."
   *
   * Why it must exist at all, found in review. Both handover paths `await` acceptance, and both used
   * to append to the ledger only after that await. The window between the write and the resolution is
   * observable: a newly arriving directed message calls `steerPending()` from the `incoming` handler,
   * which recomputed "unserved" from a ledger the in-flight batch was not in yet and offered the SAME
   * items again. Reproduced in the fixture log: an accepted `send_message` carrying the marker,
   * followed by a `soft_interrupt` carrying that same marker.
   *
   * Released on every outcome that is not verified acceptance, so a failed handover leaves the item
   * owed and un-acked rather than silently dropped.
   *
   * A reservation is owned by the IN-FLIGHT HANDOVER, not by the turn that happened to be running
   * when it started, and this is the correction for the second duplicate a reviewer reproduced
   * (#1233). The first version cleared this set wholesale at the new-turn boundary, on the stated
   * assumption that "any in-flight handover belonged to the turn that just ended". That assumption
   * is false: the queued-turn fallback reserves a batch and then awaits `message_accepted`, and the
   * OLD turn can go idle inside that await. The idle edge ran `drive`, which selected the whole
   * automatic inbox including the reserved batch, wiped the reservation, and dispatched the same
   * items as a fresh turn while the fallback's own acceptance was still pending. Both then landed:
   * two `send_message` frames carrying one message, measured as `deliveries: 2`.
   *
   * So the lifetime is the handover's, and a reset may only drop keys no handover still holds.
   * `heldReservations` is the live set of outstanding handovers; clearing "wholesale" now means
   * re-deriving this set from them, which keeps a stale key from leaking (the leak would look
   * exactly like the stall this PR repairs) without stranding a live one.
   */
  hostState.reservedIds = new Set<string>();
  /** Outstanding handovers, each owning the keys it reserved. The identity of the set is what makes
   *  "still in flight" answerable at a reset point, rather than assumed from the current turn. */
  const heldReservations = new Set<Set<string>>();
  /** Re-derive the reservation set from the handovers still in flight. Called wherever ownership is
   *  re-derived from scratch: it drops keys nothing holds and preserves keys a live handover does. */
  const releaseUnheldReservations = (): void => {
    const held = new Set<string>();
    for (const batch of heldReservations) for (const key of batch) held.add(key);
    hostState.reservedIds = held;
  };
  /** Promote accepted keys into the acked ledger WITHOUT ever recording one twice.
   *
   *  Review found the shape that needs this: with a handover in flight across a new-turn boundary,
   *  `drive` could put a key into `surfacedIds` and the fallback's own acceptance could then push
   *  the same key again. `drainInboxDeliveries` is what consumes this list at the boundary, so a
   *  duplicate key is a duplicate ack of one delivery. The reservation fix stops the two paths from
   *  both owning an item, and this makes the ledger unable to represent the error regardless. */
  const promoteToSurfaced = (keys: string[]): void => {
    const known = new Set(hostState.surfacedIds);
    for (const key of keys) if (!known.has(key)) hostState.surfacedIds.push(key);
  };
  /** Reserve a batch for the duration of one handover, returning its release. Idempotent per key:
   *  a key already reserved by another path is not selected, so double reservation cannot arise. */
  const reserveForHandover = (keys: string[]): (() => void) | undefined => {
    // Keep the native deliveries owned while the host hands them over and waits for turn success.
    // Refusing the hold must defer the whole handover, never surface an unprotected batch.
    if (!agent.holdInFlight(keys)) return undefined;
    const batch = new Set(keys);
    heldReservations.add(batch);
    for (const key of keys) hostState.reservedIds.add(key);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      // Recovery or stop may already have released this handover, before a new one took its keys.
      if (!heldReservations.delete(batch)) return;
      // Accepted keys transfer this hold to the containing turn's ledger. A failed handover
      // releases its keys without acknowledging them, so the broker can redeliver.
      agent.releaseInFlight([...batch].filter((key) => !hostState.surfacedIds.includes(key)));
      // Delete only what no OTHER live handover also holds, so releasing one batch cannot unreserve
      // a key another in-flight handover is still relying on.
      const stillHeld = new Set<string>();
      for (const other of heldReservations) for (const key of other) stillHeld.add(key);
      for (const key of keys) if (!stillHeld.has(key)) hostState.reservedIds.delete(key);
    };
  };
  hostState.steering = false;
  /** A `soft_interrupt` has failed since the last accepted handoff (#1233).
   *
   *  The measured failure is the SDK's 30s request timeout, but this is deliberately set for ANY
   *  rejection: the connector cannot tell a timeout from a refusal it has not seen before, and the
   *  consequence is an unacknowledged handover, not proof the native session rejected it. Cleared on the
   *  next accepted handoff, so a seat that recovers goes back to the cheap mid-turn path. */
  hostState.softInterruptFailed = false;
  /** The last in-flight steer request. `drive()` waits for it before deciding which ids the clean
   *  boundary owns, so a soft_interrupt reply racing turn_done can never be recorded after the ack. */
  hostState.steerSettled = Promise.resolve();
  const receivedAt = new Map<string, number>();

  // The SDK trusts mutable servers.json PIDs and can signal a stale foreign process. Remove its
  // exit hook once the launch handle exists and own teardown here instead: every record is checked
  // against the immutable bridge identity captured at spawn, then the scan stays quiescent after
  // bridge exit so a late daemon record cannot land behind a single empty pass.
  const stopPrivateJcode = async (opts?: { skipClientClose?: boolean }): Promise<void> => {
    if (!opts?.skipClientClose) await hostState.client?.close().catch(() => {});
    else void hostState.client?.close().catch(() => {});
    hostState.client = undefined;
    if (launchIdentity && launchIdentityValue)
      await stopPrivateTree({ jcodeHome: socketHome.jcodeHome, launch: launchIdentity, identityValue: launchIdentityValue });
  };

  // Launched in two steps rather than JcodeClient.launch() so the connector holds the instance
  // handle itself: the bridge PID for teardown, and a shutdown it can follow with verification.
  // Bridge recovery relaunches through here too, so the identity slots always name the live tree
  // that stopPrivateJcode must target.
  const launchPrivateJcode = async (deadline?: number): Promise<JcodeClient> => {
    const remaining = (): number | undefined => deadline === undefined ? undefined : Math.max(1, deadline - Date.now());
    const exitListenersBefore = new Set(process.listeners("exit"));
    const launchBound = launchIdentityEnv();
    launchIdentityValue = launchBound.value;
    // Written before the tree exists so a launch that dies mid-spawn still names what it may have
    // created. The next launch of this home reads it to tell an orphan from a live seat (#1211).
    recordLaunch(home, { identity: launchBound.value, host: captureProcessIdentity(process.pid) });
    if (onceUid) recordOnceLaunch(home, onceUid, { identity: launchBound.value, host: captureProcessIdentity(process.pid) });
    hostState.instance = await launchInstance({
      binary,
      jcodeHome: socketHome.jcodeHome,
      workingDir: cwd,
      // Re-copied above on every launch. Do not call the SDK default: it links rotating provider
      // auth files, while current jcode correctly refuses external auth paths that are symlinks.
      inheritLogins: false,
      // A managed seat never updates its own binary. Jcode's background updater restarts the
      // process tree when it lands a release, which SIGTERMs the TUI — the only connection the
      // server counts as a client — and nothing re-attaches afterwards, so the server's idle
      // reaper takes the whole seat down five minutes later, mid-turn. Measured 2026-08-26: three
      // seats, three identical chains, "Updated to v0.81.1. Restarting..." then a shutdown exactly
      // 300s after the client was lost, one of them two seconds after starting a tool call. The
      // seat's version is the operator's choice at spawn time; it must not change under a running
      // agent.
      env: {
        ...seatEnv,
        JCODE_DISABLE_CLAUDE_MCP: "1",
        JCODE_NO_AUTO_UPDATE: "1",
        [launchBound.key]: launchBound.value,
      },
      ...(remaining() !== undefined ? { startupTimeoutMs: remaining() } : {}),
    });
    const sdkExitListeners = process.listeners("exit").filter((listener) => !exitListenersBefore.has(listener));
    for (const listener of sdkExitListeners) process.removeListener("exit", listener);
    if (sdkExitListeners.length !== 1)
      throw new Error(`jcode connector: expected one SDK instance exit hook, found ${sdkExitListeners.length} — refusing unsafe lifecycle ownership`);
    launchIdentity = captureProcessIdentity(hostState.instance.process.pid!);
    bridgeStderr = "";
    hostState.instance.process.stderr?.on("data", (chunk: Buffer | string) => {
      bridgeStderr += String(chunk);
      if (bridgeStderr.length > 16_384) bridgeStderr = bridgeStderr.slice(-8000);
    });
    // The recovery deadline still wins when one is set: it bounds the whole replacement window, and
    // a fixture knob must not be able to extend it past that.
    const perRequestMs = remaining() ?? requestTimeoutMs;
    return connectSteerClient(hostState.instance.socketPath, perRequestMs);
  };

  const onTuiExit = (code: number | null): void => void shutdown(code ?? 0);
  const launchTui = (): void => {
    const runtime = join(socketHome.jcodeHome, "run");
    hostState.tui = spawn(binary, ["--socket", join(runtime, "jcode.sock"), "--resume", hostState.sessionId!], {
      cwd,
      // From Jcode 1.0 a TUI starts a detached desktop companion that opens URLs and terminals and
      // listens for global push-to-talk. It outlives the seat, and a managed seat has no use for it.
      env: {
        ...noCotalEnv(),
        ...seatEnv,
        JCODE_HOME: socketHome.jcodeHome,
        JCODE_RUNTIME_DIR: runtime,
        JCODE_SOCKET: join(runtime, "jcode.sock"),
        JCODE_COMPANION_AUTOSTART: "0",
      },
      stdio: "inherit",
    });
    hostState.tui.once("exit", onTuiExit);
  };

  /** Stop the TUI and wait for it to exit before stopping the private tree. A TUI that loses its
   *  server can start a replacement on the seat's socket and block the next launch. */
  const stopTui = async (): Promise<void> => {
    const viewer = hostState.tui;
    if (!viewer || viewer.exitCode !== null || viewer.signalCode !== null) return;
    viewer.off("exit", onTuiExit);
    const exited = new Promise<boolean>((resolve) => viewer.once("exit", () => resolve(true)));
    const grace = (): Promise<boolean> => new Promise((resolve) => setTimeout(() => resolve(false), TUI_STOP_GRACE_MS).unref());
    viewer.kill("SIGTERM");
    if (await Promise.race([exited, grace()])) return;
    viewer.kill("SIGKILL");
    await Promise.race([exited, grace()]);
  };

  const shutdown = async (code = 0, signal?: "SIGINT" | "SIGTERM" | "SIGHUP"): Promise<void> => {
    if (hostState.stopping) return;
    hostState.stopping = true;
    // The private tree goes first for every seat, right after the TUI that would restart it. A
    // runtime stop SIGTERMs the seat and SIGKILLs it after a short grace, and the event drain or the
    // broker close can use that whole grace. What this misses, its manager's retireAfterExit finds.
    let exit = code;
    await stopTui();
    try {
      await stopPrivateJcode({ skipClientClose: true });
    } catch (error) {
      writeJcodeDiagnostic(`[cotal-jcode] ${(error as Error).message}\n`);
      exit = 1;
    }
    agent.releaseInFlight(hostState.surfacedIds);
    hostState.surfacedIds = [];
    for (const batch of heldReservations) agent.releaseInFlight([...batch]);
    heldReservations.clear();
    eventWaitStop.abort();
    if (hostState.fallbackTimer !== undefined) {
      clearTimeout(hostState.fallbackTimer);
      hostState.fallbackTimer = undefined;
    }
    await retireRelay(relayServer, relay);
    try {
      closeEventRun();
      await events?.settled();
      await events?.close();
    } catch (error) {
      writeJcodeDiagnostic(`[cotal-jcode] AG-UI shutdown failed: ${(error as Error).message}\n`);
      exit = 1;
    }
    await releaseEventLock();
    try {
      await stopPrivateJcode();
      removeCredentials();
    } catch (error) {
      writeJcodeDiagnostic(`[cotal-jcode] ${(error as Error).message}\n`);
      exit = 1;
    }
    socketHome.dispose();
    await agent.stop().catch(() => {});
    // Keep the initiating signal last: closing a busy harness can print a turn failure during
    // teardown, and the runtime retains the final connector diagnostic for its reap line.
    if (signal)
      writeJcodeDiagnostic(`[cotal-jcode] received ${signal}; shutting down; signal sender unavailable from Node.js\n`);
    process.exit(exit);
  };

  /** Retry pacing for a failed turn. A turn's batch is acked only on success, so a failure leaves
   *  `pendingWake()` positive and the naive re-drive is instantaneous and unbounded. */
  const ERROR_RETRY_INITIAL_MS = 1_000;
  const ERROR_RETRY_MAX_MS = 60_000;
  /** After this many consecutive failures the seat stops re-driving and stays visibly degraded,
   *  rather than burning tokens forever against a provider that is not answering. */
  const ERROR_RETRY_GIVE_UP = 8;
  hostState.errorRetryMs = ERROR_RETRY_INITIAL_MS;
  let errorRetryTimer: ReturnType<typeof setTimeout> | undefined;
  hostState.consecutiveFailures = 0;
  /** Whether this host published a failed-turn condition that the next turn has to clear. */
  hostState.turnConditionPublished = false;
  /** The Harness error the last failed turn reported, kept until a turn succeeds, whether this host or
   *  the TUI owns it. The manager's `seat reaped:` line carries only the seat's last connector line,
   *  so a line that ends the seat names this error rather than leave it on an earlier `turn failed`
   *  line alone (#785). */
  hostState.lastTurnError = undefined;
  /** Relay a failed turn's Harness error as the presence condition, or clear a relayed one. The next
   *  turn clears it when it starts, whether this host or the TUI owns that turn. */
  const relayTurnCondition = (condition: PresenceCondition | null): void => {
    if (condition) hostState.lastTurnError = condition.message;
    if (!condition && !hostState.turnConditionPublished) return;
    hostState.turnConditionPublished = condition !== null;
    void agent.setCondition(condition).catch(() => {});
  };
  const BRIDGE_RECOVERY_RETRY_MS = 1_000;
  const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
  // pendingKickoff implies consecutiveFailures === 0: it is cleared before the only run() that can
  // increment failures and is never re-armed. The error-retry timer therefore never owns kickoff
  // liveness; idle and bridge recovery below are the reachable pre-dispatch triggers.
  const hasDriveWork = (): boolean => hostState.pendingKickoff !== undefined || hostState.pendingMentionWake !== undefined || agent.pendingWake() > 0 || hostState.wakeQueued;

  /** Re-drive after a growing delay, at most one timer in flight, never while shutting down. */
  const scheduleErrorRetry = (): void => {
    if (hostState.stopping || errorRetryTimer) return;
    if (hostState.consecutiveFailures >= ERROR_RETRY_GIVE_UP) {
      writeJcodeDiagnostic(
        `[cotal-jcode] giving up after ${hostState.consecutiveFailures} consecutive failed turns - the batch stays ` +
          `un-acked and will redeliver; the seat stays degraded until a new wake arrives\n`,
      );
      return;
    }
    if (agent.pendingWake() === 0 && !hostState.wakeQueued && !hostState.pendingMentionWake) return;
    const delay = hostState.errorRetryMs;
    hostState.errorRetryMs = Math.min(hostState.errorRetryMs * 2, ERROR_RETRY_MAX_MS);
    errorRetryTimer = setTimeout(() => {
      errorRetryTimer = undefined;
      if (hostState.stopping || hostState.driving || hostState.turnActive) return;
      if (hasDriveWork()) void drive();
    }, delay);
    // Never hold the process open on a pending retry.
    errorRetryTimer.unref?.();
  };

  const sessionBusy = (): boolean => hostState.driving || hostState.turnActive;

  const publishInboundHealth = (): void => {
    // Keys only: a health line shows no body, so it must not ask for a role request's take.
    const pending = agent.inboxKeys("automatic").map((recvKey) => ({ recvKey }));
    const live = new Set(pending.map((item) => item.recvKey));
    for (const key of receivedAt.keys()) if (!live.has(key)) receivedAt.delete(key);
    const queued = pending.length;
    if (queued === 0) {
      void agent.setStatus(sessionBusy() ? "working" : "idle", "").catch(() => {});
      return;
    }
    let oldest: number | undefined;
    for (const item of pending) {
      const at = receivedAt.get(item.recvKey);
      if (at === undefined) continue;
      if (oldest === undefined || at < oldest) oldest = at;
    }
    const ageS = oldest === undefined ? 0 : Math.max(0, Math.round((Date.now() - oldest) / 1000));
    const activity = `inbound: ${queued} automatic queued, oldest ${ageS}s`;
    void agent.setStatus(sessionBusy() ? "working" : "waiting", activity).catch(() => {});
  };

  /** Commit ids the live session already accepted when the host does not own `run()`. A Cotal-owned
   *  `drive()` still commits only in its own try path, so a TUI-owned turn cannot ack that batch. */
  const commitSteeredIfHostIdle = async (): Promise<void> => {
    if (hostState.driving) return;
    await hostState.steerSettled;
    if (hostState.driving || !hostState.surfacedIds.length) return;
    const committed = hostState.surfacedIds;
    hostState.surfacedIds = [];
    agent.drainInboxDeliveries(committed);
    agent.releaseInFlight(committed);
    publishInboundHealth();
  };

  const finishHostIdleTurn = async (): Promise<void> => {
    await hostState.steerSettled;
    if (!sessionBusy()) releaseUnansweredSteers();
    await commitSteeredIfHostIdle();
    if (!sessionBusy() && !hostState.reconnecting && hasDriveWork()) void drive();
  };

  const { drive, steerPending, armQueueFallback, watchClient } = createHostTurns(hostState, {
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
  });

  // A run turn arriving on a quiet seat has no "incoming" item to ride — the intake poll asks
  // for a wake instead. drive()'s own head guards re-entry and a busy session.
  agent.on("wake", () => {
    if (!sessionBusy() && !hostState.reconnecting && !hostState.stopping) void drive();
  });

  // Focus ack-drops a channel mention before "incoming". Wake with attribution only, never its body.
  agent.on("mention-wake", (item: InboxItem) => {
    hostState.pendingMentionWake = {
      hint: `You were mentioned by ${fmtFrom(item)} on #${fmtChannel(item.channel)}. Pull it with cotal_inbox.`,
    };
    if (!sessionBusy() && !hostState.reconnecting && !hostState.stopping) void drive();
  });

  agent.on("incoming", (item: InboxItem) => {
    const automatic = agent.inboxScope(item.recvKey) === "automatic";
    if (!automatic) return;
    hostState.wakeQueued = true;
    if (!receivedAt.has(item.recvKey)) receivedAt.set(item.recvKey, Date.now());
    const directed = item.kind !== "channel" || item.mentionsMe;
    if (sessionBusy()) {
      if (directed) void steerPending();
      // Ambient that is NOT directed gets no steer, so before #1233 nothing was watching it either:
      // it waited for an idle transition that a permanently busy seat never makes. Arming here is
      // what gives every automatic arrival a server, not only the directed ones.
      else armQueueFallback();
      publishInboundHealth();
      return;
    }
    if (directed || agent.attention === "open") void drive();
  });

  let startControl: ReturnType<typeof startControlServer> | undefined;
  const shutdownControl = async (): Promise<void> => {
    startControl?.close();
    await shutdown();
  };
  startControl = startControlServer(agent, control, async () => ({ ok: false, error: "jcode has no lifecycle hook relay" }), {
    fatalBind: true,
    onShutdown: () => void shutdownControl(),
  });

  process.on("SIGINT", () => void shutdown(0, "SIGINT"));
  process.on("SIGTERM", () => void shutdown(0, "SIGTERM"));
  process.on("SIGHUP", () => void shutdown(0, "SIGHUP"));
  // A once seat that must end itself, because its task's handoff could not be reported.
  registerOnceExit(() => void shutdown(1));

  try {
    hostState.client = await launchPrivateJcode();
    // A restart must come back to the session it left. Calling createSession unconditionally forked
    // a blank session and orphaned the real transcript, so a restarted seat reported for duty looking
    // healthy while remembering nothing - and the TUI, spawned with --resume below, showed a human the
    // very history the agent could not recall (#789). listSessions failing is not fatal: a seat that
    // cannot enumerate still deserves to start, it just starts fresh and says so.
    let prior: ResumeCandidate | undefined;
    const sessionsPath = storedSessionsPath(socketHome.jcodeHome);
    const stored = inspectStoredSessions(socketHome.jcodeHome);
    let listingFailed = false;
    if (fork) {
      // An operator fork names its session. It is never chosen by size among the home's others,
      // which may be left from an earlier seat of the same name.
      prior = { session_id: fork.forkId };
    } else if (onceUid !== undefined) {
      // A once seat is never restarted, so it has no session of its own to come back to. A session
      // in its home is an earlier seat's of the same name, and that seat's task is not this one.
      writeJcodeDiagnostic(`[cotal-jcode] a once seat starts a fresh session, never an earlier seat's\n`);
    } else if (isEmptyStoredSessionsDirectory(stored)) {
      writeJcodeDiagnostic(
        `[cotal-jcode] stored sessions directory is empty (${stored.path}); starting fresh without listing\n`,
      );
    } else {
      // A directory the connector cannot read is not fatal by itself, but it is a fact worth
      // naming: the harness reads and WRITES the same path, so if startup fails afterwards this
      // is very likely why, and the operator should not have to infer it from a harness message.
      // Carrying it further, so that a later harness death is renamed from `unknown`, is #1538:
      // that failure lands outside any guard this connector owns and main behaves identically.
      if (stored.kind === "unreadable")
        writeJcodeDiagnostic(
          `[cotal-jcode] stored sessions directory could not be read (${stored.path}: ${stored.code}); asking the harness anyway\n`,
        );
      try {
        prior = chooseSessionToResume(await hostState.client.listSessions(), cwd);
      } catch (error) {
        listingFailed = true;
        const panic =
          classifyStoredSessionPanic(bridgeStderr) ??
          classifyStoredSessionPanic(String((error as Error).message ?? ""));
        const cause = boundStoredSessionCause(panic ?? (error as Error).message);
        writeJcodeDiagnostic(
          `[cotal-jcode] could not list prior sessions at ${sessionsPath}: ${cause}; starting fresh on a new harness\n`,
        );
        await stopPrivateJcode();
        hostState.client = await launchPrivateJcode();
      }
    }
    // The harness accepts create_session on a sessions/ it cannot write and dies only while
    // persisting the session during the first turn, outside every guard this connector owns, so
    // the seat renders as `startup failed (unknown)` (#1538). Ask the kernel what the harness
    // will need, not what a readdir reports: a readable-but-unwritable directory is the same
    // defect as an unreadable one. A missing directory is a first launch and stays untouched;
    // permissions are never repaired or widened here — the refusal names them for the operator.
    const unwritable = unwritableStoredSessions(stored);
    if (unwritable) throw new JcodeSessionsUnwritableFailure(unwritable.path, unwritable.code);
    let session;
    try {
      if (prior) {
        session = await hostState.client.attachSession(prior.session_id);
        writeJcodeDiagnostic(
          fork
            ? `[cotal-jcode] ${fork.created ? "forked" : "continued its fork of"} session ${resumeSource}${fork.title ? ` ${JSON.stringify(fork.title)}` : ""} (transcript sha256:${fork.transcriptSha256}) as ${prior.session_id}\n`
            : `[cotal-jcode] resumed session ${prior.session_id} (${prior.transcript_bytes} bytes of transcript)\n`,
        );
      } else {
        session = await hostState.client.createSession(cwd);
        writeJcodeDiagnostic(`[cotal-jcode] started a fresh session (no resumable prior session in this home)\n`);
      }
    } catch (error) {
      // The seat could not get a session, and the stored-sessions path is the known suspect:
      // listing died on it. Name that path and the bounded cause; `unknown` is what sent
      // operators to rename the seat (#1293).
      if (!listingFailed) throw error;
      const panic =
        classifyStoredSessionPanic(bridgeStderr) ??
        classifyStoredSessionPanic(String((error as Error).message ?? ""));
      throw new JcodeSessionsEnumerationFailure(
        sessionsPath,
        boundStoredSessionCause(panic ?? `${(error as Error).message ?? ""}\n${bridgeStderr}`),
      );
    }
    // A fork carries the source's history but not this seat's briefing until a launch has sent it.
    // That is tracked on its own, because a first launch can fork and then fail before briefing.
    const resumed = prior !== undefined && (fork ? fork.briefed : true);
    hostState.sessionId = session.session_id;
    agent.setContextId(hostState.sessionId);
    if (events) {
      hostState.eventJournal = jcodeJournalPath(socketHome.jcodeHome, hostState.sessionId);
    }
    // A `provider/model` specifier was forwarded verbatim to an endpoint that wants a bare id, and
    // the refusal came back as `model_not_found` naming neither the connector nor the prefix as the
    // cause. Refuse it here, where the accepted form can actually be named (#785).
    if (config.model) {
      const spec = bareModelId(config.model);
      if (!spec.ok)
        throw new JcodeConnectorError(
          "model_prefix_rejected",
          `jcode connector: model ${JSON.stringify(config.model)} carries a provider prefix, but the Harness API expects a bare model id — pass ${JSON.stringify(spec.bare)} (the ${JSON.stringify(spec.prefix)} provider is selected by configuration, not by the model id)`,
        );
    }
    if (config.model) {
      try {
        await hostState.client.setModel(hostState.sessionId, config.model);
      } catch (error) {
        throw new JcodeConnectorError("model_refused", "Jcode refused the requested model", { cause: error });
      }
    }
    // RuntimeInfo's active provider and routes are the Harness authority for the route setModel
    // selected. RuntimeInfo.model can lag behind the persisted session pin, so a requested model is
    // identified by that pin plus its active route. Variant-only launches still use RuntimeInfo.model.
    // Verify the route before applying a variant, not after a provider-backed readiness turn. A
    // duplicated model id can appear on several routes, so the active provider disambiguates it.
    const runtime = config.model || config.variant ? await hostState.client.getRuntimeInfo(hostState.sessionId) : undefined;
    const effectiveModel = config.model ?? runtime?.model;
    const route = effectiveModel ? activeModelRoute(runtime, effectiveModel) : undefined;
    if (config.variant && (!effectiveModel || !route || !route.provider))
      throw new JcodeModelMismatch(config.model, config.variant, runtime);
    if (effectiveModel && runtime) {
      writeJcodeDiagnostic(`[cotal-jcode] ${describeRoute(runtime, effectiveModel)}\n`);
      const provider = effectiveProvider(runtime, effectiveModel);
      if (provider) await agent.setModel(effectiveModel, undefined, provider);
    }
    // The Cotal variant is Jcode's per-session reasoning effort. Apply it after model selection
    // and before any instructions or readiness turn, so no served turn uses an unrequested tier.
    // Jcode owns the provider/model ladder and validates the requested tier at this API boundary.
    if (config.variant) {
      try {
        await hostState.client.setReasoningEffort(hostState.sessionId, config.variant);
      } catch (error) {
        throw jcodeEffortRefusal(error, config.variant, {
          model: effectiveModel!,
          provider: route!.provider,
          apiMethod: route!.api_method,
        });
      }
    }
    // On a resume the persona/instructions are already the first thing in this transcript. Re-sending
    // them would replay the whole briefing on every restart and grow the context without adding to it.
    if (!resumed) {
      await hostState.client.sendMessage(hostState.sessionId, instructions(config, def?.persona || undefined), { noReply: true });
      if (fork) markJcodeForkBriefed(home, resumeSource!);
    }
    const useTui = tuiOverride ?? Boolean(process.stdout.isTTY);
    // The viewer needs only the fresh session's socket. Start it before the readiness LLM turn so
    // a foreground operator sees boot activity while presence remains gated on readiness below.
    if (useTui) launchTui();
    // Jcode registers MCP tools asynchronously. Its first turn can lock the pre-MCP tool snapshot
    // just before cotal connects, then rebuild that snapshot. Repeat the exact proof once for this
    // measured race; a second absence is terminal, never a polling loop or a guessed success.
    // The proof is the orientation tool_done event as it arrives. Waiting for turn_done kills a
    // seat that already called the tool and then kept working (#1440).
    const readinessPrompt = "Call the cotal_orientation tool exactly once now. Do not perform any other work and do not write a response.";
    type ToolCall = Awaited<ReturnType<JcodeClient["run"]>>["toolCalls"][number];
    // Jcode's deferred MCP surface reaches orientation through a wrapper whose tool_done names only
    // the wrapper: `mcp_call` up to Jcode 0.99.0, and `mcp` with action "call" from 0.99.1, where
    // `mcp_call` no longer exists. Its arguments are the call's streamed input, which the Harness
    // API sends with no call id between that call's tool_start and tool_exec.
    const deferredOrientationCalls = new Set<string>();
    let streamingCall: { callId: string; input: string } | undefined;
    const isDeferredWrapper = (name: string): boolean => name === "mcp_call" || name === "mcp";
    const isDeferredOrientation = (wrapper: string, input: string): boolean => {
      try {
        const args: unknown = JSON.parse(input);
        return typeof args === "object" && args !== null &&
          (wrapper === "mcp_call" || ("action" in args && args.action === "call")) &&
          "server" in args && args.server === "cotal" && "tool" in args && args.tool === "cotal_orientation";
      } catch {
        return false;
      }
    };
    // Jcode reports an MCP error result as successful output prefixed `Error: `; it proves nothing.
    const isOrientationCall = (call: ToolCall) =>
      call.error === undefined &&
      !call.output.startsWith("Error: ") &&
      (/(?:^|__)cotal_orientation$/.test(call.name) || (isDeferredWrapper(call.name) && deferredOrientationCalls.has(call.callId)));
    const hasOrientation = (run: Awaited<ReturnType<JcodeClient["run"]>>) => run.toolCalls.some(isOrientationCall);
    writeJcodeDiagnostic(
      `[cotal-jcode] pre-join readiness: waiting for one cotal_orientation call (bound ${readinessBudgetMs}ms; not on the roster yet)\n`,
    );
    const readinessClient = hostState.client;
    const readinessSessionId = hostState.sessionId;
    if (!readinessClient || !readinessSessionId)
      throw new Error("jcode connector: readiness proof reached without a live Harness session");
    let readiness: Awaited<ReturnType<JcodeClient["run"]>> | undefined;
    let observedOrientation = false;
    let readinessTurnOpen = false;
    let resolveOrientation = (): void => {};
    const orientationObserved = new Promise<void>((resolve) => {
      resolveOrientation = resolve;
    });
    const onReadinessEvent = (event: ApiEvent): void => {
      if (event.ev === "turn_done") readinessTurnOpen = false;
      if (event.ev === "tool_start") {
        // A restarted call id names a new call; an earlier call's arguments must not prove it.
        deferredOrientationCalls.delete(event.call_id);
        streamingCall = { callId: event.call_id, input: "" };
      }
      if (event.ev === "tool_input_delta" && streamingCall) streamingCall.input += event.delta;
      if (event.ev === "tool_exec") {
        if (isDeferredWrapper(event.name) && streamingCall?.callId === event.call_id && isDeferredOrientation(event.name, streamingCall.input))
          deferredOrientationCalls.add(event.call_id);
        streamingCall = undefined;
      }
      if (event.ev !== "tool_done") return;
      const call: ToolCall = { callId: event.call_id, name: event.name, output: event.output, error: event.error };
      if (!isOrientationCall(call)) return;
      observedOrientation = true;
      if (!readiness) {
        readiness = { text: "", reasoning: "", toolCalls: [call], usage: undefined };
      } else if (!hasOrientation(readiness)) {
        readiness.toolCalls.push(call);
      }
      resolveOrientation();
    };
    const runReadinessTurn = () => {
      readinessTurnOpen = true;
      const turn = readinessClient.run(readinessSessionId, readinessPrompt, {
        autoApprove: true,
        onEvent: onReadinessEvent,
      });
      void turn.then(
        (run) => {
          readinessTurnOpen = false;
          readiness = run;
        },
        () => {
          readinessTurnOpen = false;
        },
      );
      return turn;
    };
    const proveReadiness = async (): Promise<void> => {
      // Prove on the orientation call itself; do not wait for this turn to end (#1440).
      const firstTurn = runReadinessTurn();
      await Promise.race([orientationObserved, firstTurn]);
      if (!observedOrientation && !(readiness && hasOrientation(readiness))) {
        writeJcodeDiagnostic(
          `[cotal-jcode] pre-join readiness: first cotal_orientation turn missed the tool; retrying once inside the same bound\n`,
        );
        const secondTurn = runReadinessTurn();
        await Promise.race([orientationObserved, secondTurn]);
      }
    };
    try {
      let timeout: ReturnType<typeof setTimeout> | undefined;
      try {
        const proof = proveReadiness();
        const timedOut = await Promise.race([
          proof.then(() => "ready" as const),
          new Promise<"timeout">((resolve) => {
            timeout = setTimeout(() => resolve("timeout"), readinessBudgetMs);
          }),
        ]);
        if (timedOut === "timeout") {
          // The bound is a call-observation deadline, not a turn-completion deadline. A seat that
          // already emitted orientation tool_done is functional; destroying it because the proof's
          // own turn is still open is the #1440 kill.
          if (observedOrientation || (readiness && hasOrientation(readiness))) {
            writeJcodeDiagnostic(
              `[cotal-jcode] pre-join readiness outcome: timeout after ${readinessBudgetMs}ms; cotal_orientation was observed; joining without waiting for that turn to end\n`,
            );
          } else {
            writeJcodeDiagnostic(
              `[cotal-jcode] pre-join readiness outcome: timeout after ${readinessBudgetMs}ms; no cotal_orientation call observed; killing the private Jcode tree and discarding that in-flight turn; never joined\n`,
            );
            throw new JcodeConnectorError(
              "readiness_timeout",
              `jcode connector: the mandatory cotal_orientation readiness turn exceeded its ${readinessBudgetMs}ms bound — refusing to stay invisible past that window`,
            );
          }
        }
      } finally {
        if (timeout !== undefined) clearTimeout(timeout);
      }
    } catch (error) {
      // A readiness-turn provider refusal is different from arbitrary Harness API failure: Jcode
      // supplied an invalid-request code and a rejected model/effort value the connector can safely
      // classify. Preserve only those bounded fields; all other message bytes stay scrubbed (#828).
      const classified = classifyReadinessProviderRefusal(error, config.model);
      if (classified) {
        writeJcodeDiagnostic(
          `[cotal-jcode] pre-join readiness outcome: provider refusal of ${classified.parameter} ${JSON.stringify(classified.value)} (${classified.providerCode}); never joined\n`,
        );
        throw classified;
      }
      const failure = classifyReadinessFailure(error);
      if (failure) throw failure;
      throw error;
    }
    if (!readiness || !hasOrientation(readiness)) {
      writeJcodeDiagnostic(
        `[cotal-jcode] pre-join readiness outcome: cotal_orientation never became callable; never joined\n`,
      );
      throw new Error(
        "jcode connector: the cotal MCP bridge did not become callable during its two mandatory readiness turns — refusing to join a mesh seat without its tool surface",
      );
    }
    writeJcodeDiagnostic(
      bootPrompt
        ? `[cotal-jcode] pre-join readiness outcome: orientation proved; joining, then submitting the spawn --prompt\n`
        : `[cotal-jcode] pre-join readiness outcome: orientation proved; joining with no spawn --prompt\n`,
    );
    // The proof may have returned on tool_done while run() is still awaiting turn_done. Keep that
    // Harness turn marked busy so a later drive() cannot steal the same event stream. A completed
    // proof turn must look idle, or the first mesh DM never drives.
    watchClient(hostState.client);
    hostState.turnActive = readinessTurnOpen;
    await agent.start();
    // A readiness proof may join on tool_done while its native turn is still open. Binding there
    // would publish the pre-join orientation tool records and merge the next requested turn into the
    // same AG-UI run. A completed proof can bind now; an open one binds in drive() after turn_done.
    if (!readinessTurnOpen) await ensureEventsBound();
    // A space that requires events has already stopped a seat whose event plane failed to bind, and
    // that shutdown owns the exit.
    if (hostState.stopping) return;
    // The readiness proof necessarily precedes mesh join. Tell the session that its bootstrap
    // orientation card was pre-join so it cannot later mistake that truthful old snapshot for its
    // current connection state (#778).
    // The seat has already joined by the time this runs, so the notice is the last cosmetic step of
    // a launch that has otherwise succeeded. A resumed session whose saved transcript ends mid-turn
    // is legitimately busy, the server refuses a context_message while it is, and the no-reply path
    // reports that refusal by throwing — which killed the seat over one undelivered sentence, and
    // took the session's accumulated memory with it. Record the refusal and carry on: no failure to
    // deliver this notice is worth the seat it would otherwise cost. Any cause is tolerated here,
    // not just a busy agent, because the thrown code is `internal` for every one of them.
    // drive() is gated on initialized. Leave that false until this notice has been attempted so a
    // turn_done from the still-open proof cannot dispatch the spawn kickoff first (#1440).
    const joinNotice = `You are now connected to the Cotal mesh as "${config.name}". The earlier cotal_orientation result was captured before this join; use cotal_orientation again for live context.`;
    if (bootPrompt) {
      try {
        await hostState.client.sendMessage(hostState.sessionId, joinNotice, { noReply: true });
      } catch (notice) {
        writeJcodeDiagnostic(`[cotal-jcode] post-join notice not delivered: ${(notice as Error).message}\n`);
      }
    } else {
      // No spawn prompt means nothing else schedules a turn after join: a persona that subscribes
      // to nothing would otherwise sit on this notice as an unread append forever, never woken
      // except by a directed mesh message (#1199). Route it through the same pendingKickoff/
      // drive() dispatch boundary the spawn prompt uses instead of a noReply append, so it gets
      // exactly one scheduled turn under the same one-shot rule (consumed at the request, never
      // retried on an ambiguous error) and the same initialized gate and steering rules. A resumed
      // session that is legitimately busy at this moment fails this turn the same way any other
      // turn fails (drive()'s own catch logs it and schedules a retry) rather than killing the seat.
      hostState.pendingKickoff = joinNotice;
    }
    hostState.initialized = true;
    // The startup kickoff is the first requested turn after the pre-join readiness boundary. Bind
    // its durable journal before dispatch so its first output opens an AG-UI run rather than being
    // adopted as retained history. A still-open readiness turn remains excluded above.
    if (!readinessTurnOpen) await ensureEventsBound();
    // Kickoff is not the only work that can arrive during that gate: a restart DM is parked until
    // this drain, or the replacement never observes it (#1440 / #910).
    if (hasDriveWork()) await drive();
  } catch (error) {
    // A shutdown requested mid-startup closes the client and rejects whatever startup step was in
    // flight. That is the shutdown completing, not a startup failure: let its teardown own the
    // process exit code instead of racing it to process.exit with a failure report.
    if (hostState.stopping) return;
    startControl?.close();
    await retireRelay(relayServer, relay);
    // The refusal is only safe once the launch it abandons is provably dead: returning non-zero
    // hands the manager a retired seat while an unverified daemon would keep running (#839). The
    // TUI started before readiness goes first, so it cannot start a replacement server.
    await stopTui();
    try {
      await stopPrivateJcode({ skipClientClose: error instanceof JcodeConnectorError && error.code === "readiness_timeout" });
      removeCredentials();
    } catch (teardown) {
      writeJcodeDiagnostic(`[cotal-jcode] ${(teardown as Error).message}\n`);
    }
    socketHome.dispose();
    await agent.stop().catch(() => {});
    throw error;
  }
}
