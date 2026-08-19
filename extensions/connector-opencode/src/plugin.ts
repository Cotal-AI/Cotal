/**
 * The Cotal OpenCode plugin — loaded in-process by `opencode serve` (via the inline config the
 * connector sets). The serve shim attaches a foreground `opencode` TUI to the session this plugin
 * owns, so the human watches (and can type into) the exact session the agent drives. It turns the
 * session into a first-class mesh peer, at parity with the Claude Code connector:
 *
 *  • holds the {@link MeshAgent} (NATS endpoint, inbox, presence) for the server's lifetime;
 *  • registers the cotal_* tools natively, rendered from the SHARED {@link cotalToolSpecs}
 *    (`./tools.ts`) — same surface as Claude Code, incl. channels / join / leave / channel_info;
 *  • maps OpenCode bus events to presence (idle | working | waiting | offline);
 *  • owns ONE session (created at boot) and drives it: it injects each inbox batch as a turn through
 *    the authenticated OpenCode server HTTP API (the same server the TUI is attached to), acking ON
 *    TURN COMPLETION (so a crash/error redelivers). Automatic pending messages are also injected
 *    into the next native prompt creation when a human/API prompt starts in the attached session;
 *    quiet ambient remains pull-only.
 *    Delivery is **attention-aware** (open/dnd/focus) and never interrupts a running turn.
 *
 * Identity comes from COTAL_* env (the plugin runs in the opencode process and inherits it).
 * No identity → inert, so an operator's own `opencode` never joins as a stray peer.
 */
import { loadAgentFile, type PresenceStatus } from "@cotal-ai/core";
import {
  configFromEnv,
  hasIdentity,
  MeshAgent,
  startControlServer,
  formatInjection,
  fmtFrom,
  ORIENTATION_BOOTSTRAP,
  MESH_FIRST_STEER,
  AguiEmitter,
  AguiEmitterHolder,
  EventWal,
  FileSubjectFrontier,
  ensureEventWalDir,
  resolveEventsStateRoot,
  type InboxItem,
} from "@cotal-ai/connector-core";
import { principalKey } from "@cotal-ai/core";
import { randomUUID } from "node:crypto";
import { OpenCodeSessionSource, type OpenCodeMessageWithParts, type OpenCodeRecord } from "./agui-source.js";
import { createOpenCodeMapper, type OpenCodeMapper } from "./agui-map.js";
import type { Plugin, Hooks, ToolDefinition } from "@opencode-ai/plugin";
import { buildCotalTools } from "./tools.js";

function log(msg: string): void {
  process.stderr.write(`[cotal-connector] ${msg}\n`);
}

/** Process-global guard: opencode loads the plugin once per app/worktree scope, so the function
 *  can run more than once in a single process. We want exactly one mesh endpoint — so the first
 *  call wires up the agent, and every call returns the *same* hooks (the same tools, bound to that
 *  one agent), whichever scope opencode ends up using. */
const guard = globalThis as { __cotalOpencodeHooks?: Hooks };
const ERROR_RETRY_INITIAL_MS = 1_000;
const ERROR_RETRY_MAX_MS = 30_000;
const INTERRUPT_INTENT_TTL_MS = 30_000;

/** The machine-stable half of the retirement line. The suite asserts on THIS, never on the sentence
 *  around it: a guard keyed on human prose dies the first time someone rewords a log message, and it
 *  dies silently, which is the failure mode a guard exists to prevent. Reword the sentence freely;
 *  do not change this token without updating the cells that import it. */
export const SESSION_RETIRED = "opencode-session-retired";
/** A bounded wait gave up. Exported so a cell keys on the token rather than on the sentence. */
export const SETTLE_ABANDONED = "opencode-settle-abandoned";
/**
 * How long one swap step may hold the chain, or a teardown may hold the process, before it is
 * abandoned out loud rather than waited on forever.
 *
 * A GENUINE-HANG BACKSTOP, deliberately far above normal settle latency, because a bound that can
 * fire on a step that would have finished would turn a slow publish into a dropped drain. The
 * measure comes from a cell rather than a guess: `reset:the /new drain puts the old session's tail
 * and its close ON THE WIRE` asserts that a whole drain, flush plus run close plus settle plus the
 * broker round trip, AND a read-back of the subject both complete inside the 2s the suite waits.
 * So a healthy settle is comfortably under two seconds and this is five times that. Reaching it
 * means the step is not slow, it is not coming back.
 */
const SWAP_SETTLE_MS = 10_000;
/**
 * How long teardown waits for interactive work it ALREADY ADMITTED before it attempts departure.
 *
 * DERIVED, NOT PICKED. It has to be under the shortest runtime grace window, which is 1.5s for tmux
 * and cmux against 3s for the built-in pty, because a stop that spends longer than that waiting is a
 * stop whose offline publish is killed before it lands. That is the failure the publish-before-join
 * ordering exists to prevent, so a bound above the grace window would reintroduce it here. 1s leaves
 * room for the publish itself, and what it waits on is one presence round trip or one tool call, not
 * an event drain: those are excluded and joined afterwards.
 */
const INTAKE_SETTLE_MS = 1_000;

export const cotal: Plugin = async () => {
  // No identity → a plain `opencode`, not a launcher-spawned agent. Stay inert.
  if (!hasIdentity()) {
    log("no COTAL_NAME — not a managed session; staying off the mesh");
    return {};
  }
  if (guard.__cotalOpencodeHooks) return guard.__cotalOpencodeHooks; // one agent; reuse the hooks
  const config = configFromEnv();
  config.connector = "opencode"; // advertise the host harness on our AgentCard (meta.connector)
  const serverUrl = process.env.COTAL_OPENCODE_SERVER_URL?.trim();
  const serverUsername = process.env.OPENCODE_SERVER_USERNAME?.trim() || "opencode";
  const serverPassword = process.env.OPENCODE_SERVER_PASSWORD?.trim();
  if (!serverUrl || !serverPassword) throw new Error("opencode connector: missing COTAL_OPENCODE_SERVER_URL/OPENCODE_SERVER_PASSWORD");
  const serverAuth = `Basic ${Buffer.from(`${serverUsername}:${serverPassword}`).toString("base64")}`;

  const agent = new MeshAgent(config);
  agent.start(); // background connect with retry — never blocks startup

  /**
   * Publishes this session's activity as AG-UI events on `events.<owner>.<actor>`, iff COTAL_EVENTS
   * is on. A personal `opencode` never publishes, because the launcher sets that variable only for
   * a managed session.
   */
  let events: AguiEmitterHolder<OpenCodeRecord> | undefined;
  /** Swaps run ONE AT A TIME (#600). The drain below suspends and the plugin bus does not await this
   *  handler (it dispatches `void hook.event(...)`), so without this a second top-level create lands
   *  mid-drain, reads the same holder to retire, and its replacement overwrites the first one. A
   *  rejected swap is absorbed here rather than propagated, so one failed drain cannot wedge every
   *  later swap and take the event plane down permanently. */
  let swapChain: Promise<void> = Promise.resolve();
  /**
   * A cutover is in progress. Read by `drive`, which is the ONE place a turn can start, so every
   * door is covered by this rather than each door carrying its own guard.
   *
   * Gating the drive inside `adoptSession` was not enough and that is the lesson here: adopting
   * also clears `busy` and `driving`, and the inbox, wake and mention-wake handlers all start a
   * turn on `!busy`. So closing the one door inside the adopt left three open beside it, and an
   * ordinary inbound message during a cutover would prompt the new session while its replacement
   * holder was not installed yet. Found by review, and it is the same shape as the defect this
   * whole change exists for: a window closed at one consumer rather than at the thing they share.
   */
  let swapping = false;
  /**
   * ONE HOLDER PER SESSION, built on demand rather than once per process.
   *
   * A holder binds to one thread for the life of its emitter and refuses a second, terminally: the
   * write-ahead log is keyed to the thread, so re-adopting would continue one session's epoch and
   * sequence against another session's bytes. That refusal is correct and stays. What it means here
   * is that `/new`, a second top-level session in the same OpenCode process, needs its own holder,
   * its own emitter and its own log, which is the sequential-sessions-one-principal case the shared
   * subject frontier exists for.
   */
  function newEventHolder(): AguiEmitterHolder<OpenCodeRecord> {
    // Scoped to this holder, not to the process: the run-closed callback below has to reach the
    // mapper, and the two are assigned at different times because the mapper is built inside the
    // factory, keyed on the session the bus names.
    let mapper: OpenCodeMapper | undefined;
    // Built LAZILY, on the first event that names a session: `start()` reaches the broker, and that
    // work must not run for a session that never emits.
    return new AguiEmitterHolder<OpenCodeRecord>(
      async (id: string) => {
        // Throws rather than defaulting to the working directory: a write-ahead log written
        // somewhere no later start looks for is a silent loss.
        const workspaceRoot = resolveEventsStateRoot(process.env);
        const threadId = id; // the native session IS the AG-UI thread
        const principal = principalKey(agent.ep.principal.owner, agent.ep.principal.actor).key;
        const { walPath, subjectPath } = await ensureEventWalDir({ workspaceRoot, space: config.space, principal, threadId });
        // Per PRINCIPAL, not per thread: without it a second session of this agent opens virgin,
        // expects an empty subject its own first session filled, and halts for good.
        const subjectFrontier = await FileSubjectFrontier.open(subjectPath, { space: config.space, principal });
        const wal = await EventWal.open(walPath, { space: config.space, threadId, principal, subjectMayExist: false });
        mapper = createOpenCodeMapper({ threadId, mintRunId: () => randomUUID() });
        return AguiEmitter.start<OpenCodeRecord>({
          endpoint: agent.ep,
          wal,
          subjectFrontier,
          source: new OpenCodeSessionSource({
            // The SUPPORTED surface. `opencodeApi` is the same authenticated HTTP client the rest of
            // this plugin uses, and `/session/{id}/message` is the endpoint the SDK's
            // `session.messages()` calls. The SQLite store behind it is OpenCode's private business
            // and its schema migrates, so nothing here reads it.
            read: () => opencodeApi<OpenCodeMessageWithParts[]>(`/session/${encodeURIComponent(id)}/message`, undefined, 30_000),
            // A revert is a legitimate user action, so the divergence is RECORDED and the stream
            // continues. The read itself is already correct without this, because the cursor is
            // compared as an order and never dereferenced as an identity.
            onVanished: (cursor) => log(`AG-UI: the resume cursor was removed from the session (revert): ${cursor}`),
          }),
          map: mapper.map,
        });
      },
      // Required, and not defaulted to a swallow: this runs behind a bus handler that must not
      // throw, so a failure reaches a human only if it is written somewhere. The holder is terminal
      // on error and does not retry, so this line is the whole record of why events stopped.
      (e: Error) => log(`AG-UI emitter stopped: ${e.message}`),
      // The turn terminal closes a run the record stream never described, so without this the mapper
      // would still believe that run is open, attribute the next records to it, and have the batch
      // refused. Keyed on the id, so a newer run opened in between is left alone.
      (runId: string) => mapper?.forgetOpenRun(runId),
    );
  }
  if (/^(1|true|yes|on)$/i.test(process.env.COTAL_EVENTS ?? "")) events = newEventHolder();

  async function opencodeApi<T>(path: string, init?: RequestInit, timeoutMs = 10_000): Promise<T> {
    const res = await fetch(`${serverUrl}${path}`, {
      ...init,
      signal: init?.signal ?? AbortSignal.timeout(timeoutMs),
      headers: {
        authorization: serverAuth,
        "content-type": "application/json",
        ...(init?.headers ?? {}),
      },
    });
    if (!res.ok) throw new Error(`OpenCode HTTP ${res.status} ${res.statusText} for ${path}`);
    if (res.status === 204) return undefined as T;
    return (await res.json()) as T;
  }

  const def = process.env.COTAL_AGENT_FILE?.trim() ? loadAgentFile(process.env.COTAL_AGENT_FILE.trim()) : undefined;
  const persona = def?.persona || undefined;

  // This agent OWNS one top-level OpenCode session at a time. The serve shim attaches the foreground
  // TUI to the boot session; if the human runs `/new` in that same TUI/process, OpenCode creates a
  // replacement top-level session. We adopt that as a context reset while keeping the same MeshAgent
  // and creds alive. Used to match our turn-end (idle) vs subagent idles.
  let sessionID: string | undefined;
  let busy = false; // a turn is running (ours via drive(), OR the human's via session.status) → don't
  // prompt: opencode would COALESCE onto it (no reject). Released at EVERY turn end (completeTurn).
  let driving = false; // re-entrancy guard around an in-flight server prompt
  let primed = false; // persona is prepended to the first turn's text once
  let briefed = false; // the boot channel briefing is prepended once, on the first turn
  let surfaced: string[] = []; // ids surfaced into the current turn, acked on completion (by id, not count)
  let awaitingTurnEnd = false; // a turn is in flight → ignore a duplicate idle that isn't its end
  let errorRetryTimer: ReturnType<typeof setTimeout> | undefined;
  let errorRetryMs = ERROR_RETRY_INITIAL_MS;
  let interruptIntent: { sessionID?: string; expires: number } | undefined;
  let stopping = false; // dispose/shutdown ran — stop waiting on anything that may never arrive
  // The auto-submitted first turn (`cotal spawn --prompt`), handed over by the connector in the
  // child env. Undelivered, it HOLDS THE FLOOR in drive(): peer traffic that lands during boot stays
  // buffered (completeTurn drives it when the boot turn ends), so the operator's prompt is genuinely
  // this session's first turn rather than a batch that raced it. Cleared by the one drive that
  // carries it, so no later readiness event can issue a second boot turn.
  let bootPrompt = process.env.COTAL_OPENCODE_PROMPT?.trim() || undefined;
  /**
   * Interactive work that has been admitted and has not finished. Teardown waits for THIS before it
   * attempts departure, which is a different thing from refusing new work: the fence closes the
   * door, and this covers whoever was already through it.
   *
   * It has to exist because a presence write is not atomic. `setStatus` assigns, awaits `setActivity`
   * and then awaits `setStatus`, so a teardown beginning in that gap publishes offline BETWEEN the
   * two and the parked call then puts the seat back to work after it has announced it left.
   * Reproduced on the real plugin and broker, not reasoned: the roster read `working` after offline.
   *
   * TRACKED HERE AND AT THE TOOL WRAPPER, which between them is every write that CHOOSES a status:
   * the hooks all go through this helper, and the tools bypass it and reach the agent directly, so
   * they are tracked whole. Tracking a list of the agent's presence-writing METHODS instead would be
   * the same enumeration this file has already got wrong twice, and it would miss a tool that sends
   * rather than publishes, which no amount of repairing presence afterwards can take back.
   *
   * THE PROMPT HOOK'S MODEL RECORD IS TRACKED TOO, at its own call site, because it publishes
   * presence without passing through this helper. An earlier version left it out and argued it was
   * harmless: it cannot choose a status, it republishes whichever one the endpoint holds, and its
   * record is submitted before departure's, so departure is the later write. That conclusion may
   * well be right, but it rests on how the endpoint's KV writes are ordered, which is an assumption
   * about a layer this file does not own. Tracking it costs one call and makes the ordering true by
   * construction, so nothing here depends on that assumption being correct.
   *
   * WHICH LEAVES A WEAKER PROPERTY THAN THE FENCE HAS, and the difference is worth being plain
   * about. Admission is closed by MEMBERSHIP: a door is fenced by being in the intake table, so one
   * added later cannot be forgotten. Presence tracking is by CALL SITE: these three are every place
   * this plugin writes presence today, and a fourth added later would not be covered automatically.
   *
   * EVENT WORK IS DELIBERATELY NOT IN HERE. A session create awaits its whole swap, drain included,
   * so waiting on it before publishing departure would queue offline behind exactly the drain that
   * ordering exists to get in front of. The swap chain and the holder are joined AFTER offline, as
   * before; this set is only ever one round trip or one tool call deep.
   */
  const inFlight = new Set<Promise<unknown>>();
  const track = async <T>(work: Promise<T>): Promise<T> => {
    inFlight.add(work);
    try {
      return await work;
    } finally {
      inFlight.delete(work);
    }
  };

  const safeStatus = async (status: PresenceStatus, activity?: string): Promise<void> => {
    try {
      if (agent.connected) await track(agent.setStatus(status, activity));
    } catch {
      /* presence is best-effort — never throw into opencode */
    }
  };

  // Cooperative shutdown. The manager sends an authenticated {op:"shutdown"} to this agent's local
  // control endpoint on a signal-less runtime (ConPTY/Windows), where a hard kill would skip cleanup
  // and leave the agent online until its presence TTL expires. We leave the mesh cleanly instead, then
  // exit (the runtime hard-kills as a backstop). The endpoint (path + token) is minted by the
  // connector's buildLaunch and arrives in the child env; the plugin runs inside the opencode server
  // process, so it reads it there. Hooks are in-process (no external relay connects), so only the
  // shutdown op is used — the handle path is inert. fatalBind: a managed agent MUST own its control
  // endpoint, so a squatter (or a runtime that can't host the pipe) fails loud rather than running a
  // hijacked or absent control plane.
  let controlServer: ReturnType<typeof startControlServer> | undefined;
  /**
   * THE ONE TEARDOWN, because there are two ways out and an invariant that holds on one of them
   * is not an invariant. `dispose` is the editor unloading the plugin; `shutdown` is the manager
   * stopping a supervised seat over the control socket, which is the path a managed agent
   * actually takes. Both must join the event work before the process stops, so the join lives
   * here and neither caller owns a copy of it.
   *
   * A queued swap still holds a drain that flushes and closes a run, and it runs on its own chain
   * rather than on this one, so without joining it a stop can be followed by frames for a session
   * the process no longer serves. Serializing the swap did not create that exposure but it does
   * lengthen it, because drains that used to overlap now finish one after another, so joining is
   * this change's own debt rather than a courtesy. Bounded for the same reason the drain is: a
   * teardown that waits forever on a drain is a worse outcome than one that says it gave up.
   *
   * LEAVING THE MESH COMES FIRST, AND THE ORDER IS THE WHOLE POINT OF IT. A supervised stop is
   * followed by a hard kill after the runtime's grace window, which is 3s for the built-in pty
   * runtime and 1.5s for the tmux and cmux ones. The join is bounded far above that on purpose,
   * because a backstop that fires on a healthy drain would turn a slow publish into a dropped one,
   * so this routine can be killed part way through and that is expected. What must NOT depend on
   * finishing is the cheap step: publishing offline presence. Behind the join it is lost whenever a
   * drain outlives the grace window; in front of it, it lands unless the kill arrives first, and the
   * queued work then gets whatever time the runtime allows. It used to say ALWAYS lands, which the
   * bounded intake wait added later made untrue: that wait sits in front of this publish, so a kill
   * inside it takes the publish with it.
   *
   * WHAT THAT BUYS IS DELIBERATELY UNDERSTATED HERE. Departure becomes an EXPLICIT publish rather
   * than something a reader has to infer, and that is the whole of the claim. It is NOT that a stale
   * live entry would otherwise survive: losing the connection purges the presence record on its own,
   * so that outcome is not this ordering's to take credit for. A cell built to grade the difference
   * passed with the order reversed, twice, which is how the overclaim was caught rather than shipped.
   *
   * So this is best effort by construction, and says so rather than claiming the work completes.
   * The endpoint stays up until `agent.stop()`, so a drain that finishes BEFORE that still publishes.
   * One that outlived the swap bound can finish after it instead, and then it has no endpoint left
   * to publish through.
   */
  const quiesce = async (): Promise<void> => {
    stopping = true;
    try {
      controlServer?.close();
    } catch {
      /* ignore */
    }
    // BEFORE DEPARTURE IS ATTEMPTED, so that work this seat already admitted is ordered ahead of the
    // departure it announces, for as long as the bound allows. NOT "nothing admitted can act after
    // it said it left": the bound is the honest part, and a straggler that outlives it is not
    // cancelled, so the teardown goes on to ATTEMPT the departure publish and that straggler can
    // still finish afterwards. Attempt is the accurate word throughout: safeStatus skips the write
    // outright when the connection is already gone and swallows its failure when it is not, so this
    // publish has no deadline of its own, no result anyone reads, and a kill inside it takes it.
    // Waiting unboundedly instead is the worse of the two, because departure would go back to being
    // inferred from a dropped connection.
    // EACH ONE ABSORBED SEPARATELY, which is the difference between waiting for the set and waiting
    // for the first thing to happen to it. The set holds the raw calls, and a bare Promise.all
    // rejects the moment ONE of them does, without waiting for the others; settleWithin then counts
    // any settlement including a rejection as done, so departure published while another call was
    // still parked. That is reachable rather than theoretical: setStatus begins with a connection
    // assertion, and this helper's own connection check is a read before an await, so a stop landing
    // in between produces exactly such a rejection. Absorbed per item, a failure removes one call
    // from the wait instead of ending it. Same idiom as settleWithin's own absorption, deliberately.
    const admitted = [...inFlight].map((work) => work.then(() => undefined, () => undefined));
    const settled = await settleWithin(Promise.all(admitted), INTAKE_SETTLE_MS, "admitted intake at teardown");
    // The generic line above already says the work is uncancelled and may land late. This adds the
    // part specific to THIS site: the teardown stops waiting and moves on to the departure publish,
    // so a straggler here can publish or SEND around it rather than merely out of order. An earlier
    // version of the generic line claimed the abandoned work was terminally silent, and this note
    // existed to contradict it; the contradiction is gone now that the line itself is accurate.
    if (!settled)
      log(
        `admitted work outlived the ${INTAKE_SETTLE_MS}ms intake bound: the teardown stops waiting and ` +
          `ATTEMPTS the departure publish next, which is best effort and may not land; that work is ` +
          `NOT cancelled either, so it may still publish or send afterwards`,
      );
    await safeStatus("offline");
    await settleWithin(swapChain, SWAP_SETTLE_MS, "swap chain at teardown");
    await settleWithin(events?.settled(), SWAP_SETTLE_MS, "event holder at teardown");
    clearErrorRetry(true);
    await agent.stop();
  };
  /**
   * The manager's cooperative stop. `process.exit` is deliberately AFTER the shared teardown and
   * not beside it: it used to sit in a `finally` around the presence and agent stop only, so it
   * ran even when those threw and it ran before any event work could finish. An exit that cannot
   * be delayed by the teardown is an exit that cannot honour it.
   */
  const shutdown = async (): Promise<void> => {
    try {
      await quiesce();
    } finally {
      process.exit(0);
    }
  };
  const controlPath = process.env.COTAL_CONTROL_SOCKET?.trim();
  const controlToken = process.env.COTAL_CONTROL_TOKEN?.trim();
  if (controlPath && controlToken) {
    const handle = async (): Promise<Record<string, unknown>> => ({
      ok: false,
      error: "opencode runs cotal hooks in-process; only the shutdown control op is supported",
    });
    controlServer = startControlServer(agent, { path: controlPath, token: controlToken }, handle, {
      fatalBind: true,
      onShutdown: () => void shutdown(),
    });
  }

  function pendingForWake(): number {
    return agent.pendingWake(); // mode-and-channel-aware: excludes held dnd/quiet ambient
  }

  function clearErrorRetry(resetDelay = false): void {
    if (errorRetryTimer) clearTimeout(errorRetryTimer);
    errorRetryTimer = undefined;
    if (resetDelay) errorRetryMs = ERROR_RETRY_INITIAL_MS;
  }

  function markInterruptIntent(sessionID?: string): void {
    if (!busy && !awaitingTurnEnd) return;
    interruptIntent = { sessionID, expires: Date.now() + INTERRUPT_INTENT_TTL_MS };
  }

  function clearInterruptIntent(): void {
    interruptIntent = undefined;
  }

  function consumeInterruptIntent(sessionID?: string): boolean {
    const intent = interruptIntent;
    interruptIntent = undefined;
    if (!intent || Date.now() > intent.expires) return false;
    return !intent.sessionID || !sessionID || intent.sessionID === sessionID;
  }

  function isMessageAbortedError(error: unknown): boolean {
    return typeof error === "object" && error !== null && (error as { name?: unknown }).name === "MessageAbortedError";
  }

  function scheduleErrorRetry(): void {
    if (errorRetryTimer || pendingForWake() === 0) return;
    const delay = errorRetryMs;
    errorRetryMs = Math.min(errorRetryMs * 2, ERROR_RETRY_MAX_MS);
    errorRetryTimer = setTimeout(() => {
      errorRetryTimer = undefined;
      if (!busy && pendingForWake() > 0) void drive();
    }, delay);
    errorRetryTimer.unref?.();
  }

  /**
   * EVENT-PLANE WORK IS ROUTED BY THE HOLDER'S OWN BINDING, NEVER BY THE AMBIENT SESSION ID (#600).
   *
   * The ambient id and the holder that serves it are two variables, and every attempt to ORDER them
   * left a nearer window: the id was assigned outside the swap, then inside it but before the drain,
   * and each time an event arriving in the remaining gap was routed by the NEW id into a holder
   * still bound to the OLD thread, whose re-adopt refusal is terminal and takes the plane down.
   * Ordering a two-variable race only moves its boundary, so this removes the second variable from
   * the decision: an event reaches the holder only if that holder is ALREADY bound to its thread, or
   * is not bound to anything yet and is free to take it. A holder bound elsewhere is not the route
   * for this event, whatever the ambient id currently says.
   *
   * THIS IS NOT ATOMIC WITH BINDING, and does not need to be. `flush` enqueues, and the binding is
   * taken on the holder's own chain, so two calls in one synchronous block could both read an
   * unbound holder and the second would be refused terminally. Nothing here would stop that. What
   * stops it is that every flush/close site is fed the AMBIENT id below, one variable holding one
   * value, so two events present the SAME path and a repeat for one path is allowed rather than
   * refused; the only site fed an event-carried id is the swap's adopt, which is serialized on the
   * swap chain. Feed a site an event-carried id off that chain and this becomes reachable.
   */
  function eventsFor(id: string | undefined): AguiEmitterHolder<OpenCodeRecord> | undefined {
    const holder = events;
    if (holder === undefined || id === undefined) return undefined;
    return holder.path === undefined || holder.path === id ? holder : undefined;
  }

  /**
   * A BOUNDED WAIT, and the bound is the whole point of it.
   *
   * Every swap queues behind the one before it, so a single step that never settles does not stall
   * one session, it stalls every session swap for the life of the process and the plane goes quiet
   * with nothing saying why. What is waited on ends in a broker publish, which is exactly the kind
   * of work that hangs rather than fails.
   *
   * Waiting forever and giving up quietly are both worse than this. Giving up is SAID: the caller
   * learns it did not settle, the line names the consequence rather than the timer, and it carries a
   * token a cell can key on, so a plane that degraded is distinguishable from one that worked.
   *
   * THROWING WAS THE OTHER CANDIDATE AND IT WAS MEASURED, not argued. The chain itself is protected,
   * `swapChain = swap.catch(...)` absorbs a rejection and the next swap still runs. But the same
   * promise is awaited again by the invocation that created it, and the bus dispatches this handler
   * as `void hook.event(...)`, so that second consumer turns the rejection into an UNHANDLED one.
   * On node 22 an unhandled rejection terminates the process, which here is the editor the plugin
   * is running inside. Reproduced in isolation with the same four lines: the process died and the
   * liveness line after it never printed. So a throw does not fail loudly, it takes the host with
   * it, and the repo's throw-rather-than-degrade rule does not ask for that.
   */
  async function settleWithin(work: Promise<unknown> | undefined, ms: number, what: string): Promise<boolean> {
    if (work === undefined) return true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const expired = new Promise<boolean>((resolve) => {
      timer = setTimeout(() => resolve(false), ms);
      timer.unref?.();
    });
    try {
      const settled = await Promise.race([work.then(() => true, () => true), expired]);
      if (!settled)
        log(
          `${SETTLE_ABANDONED} ${what} did not settle within ${ms}ms, so it is abandoned: the WAIT ` +
            `stopped, the work did not, and nothing here can cancel it. It may still publish, ` +
            `possibly after frames from whatever replaced it, and a run it had open may stay open. ` +
            `Ordering is guaranteed for a step that settles inside the bound, not for this one. The ` +
            `plane continues rather than wedging every later step behind it.`,
        );
      return settled;
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  /**
   * A swap must not prompt into the new session halfway through its own cutover. `drive` is a TURN
   * SUBMISSION rather than an event-plane consumer, so routing by the holder's binding does not
   * reach it: started mid-cutover it runs against the new id while the replacement holder is not
   * installed yet, and the records it produces can land before that holder adopts. A fresh adopt
   * takes the position of the END of the store, so anything written in between is passed over
   * rather than published.
   *
   * The guard for that is `swapping`, inside `drive`, NOT a parameter here. An earlier version took
   * a `drivePending` flag so the swap could ask this function not to drive, which closed this door
   * and left the inbox, wake and mention-wake doors open beside it, because adopting also clears
   * `busy`. One guard where the turn actually starts covers all of them.
   */
  function adoptSession(id: string, reason: string): void {
    if (sessionID === id) return;
    const previous = sessionID;
    sessionID = id;
    agent.setContextId(id);
    busy = false;
    driving = false;
    primed = false;
    briefed = false;
    surfaced = [];
    awaitingTurnEnd = false;
    clearInterruptIntent();
    clearErrorRetry(true);
    if (previous) {
      log(`adopted opencode session ${id} after ${reason}; mesh identity unchanged`);
      if (pendingForWake() > 0) void drive();
    }
  }

  /** Create the session this agent owns and announce its id to the serve shim, which attaches the
   *  foreground TUI to it. The handshake line on stderr (`[cotal-session] <id>`) is how the shim
   *  learns *which* session to open — by exact id, so a stale same-titled session from a prior run
   *  can't be picked. Awaited by ensureSession before the first drive. */
  const sessionReady: Promise<string | undefined> = (async () => {
    try {
      const res = await opencodeApi<{ id?: string }>("/session", {
        method: "POST",
        body: JSON.stringify({ title: `cotal:${config.space}:${config.name}` }),
      }, 10_000);
      const id = res.id;
      if (id) {
        adoptSession(id, "boot");
        process.stderr.write(`[cotal-session] ${id}\n`);
      } else log("session.create returned no id");
    } catch (e) {
      log(`session.create failed: ${(e as Error).message}`);
    }
    return sessionID;
  })();

  /** The session to drive — the one we created and the TUI is attached to. */
  async function ensureSession(): Promise<string | undefined> {
    return sessionID ?? (await sessionReady);
  }

  /** Drive a turn carrying the current inbox batch (and the boot briefing once) into the visible
   *  session via the server API — server-side, so it can't race like the TUI input box, and the TUI
   *  renders it live (it subscribes to that session's events). Surfaces the items but does NOT ack
   *  them — ackSurfaced runs on turn completion, so a crash/error redelivers. `override` replaces
   *  the body (a bare nudge, e.g. a focus @mention pull) and surfaces nothing to ack. Self-guards
   *  re-entrancy and never prompts into a running turn (opencode would COALESCE onto it). */
  async function drive(override?: string): Promise<void> {
    // THE REFUSALS LIVE HERE, at the one place a turn can start, rather than at each caller.
    //
    // Two of them are about WHEN rather than who, and the earlier version of this line named the
    // callers instead and so missed one. `swapping` refuses mid-cutover, because a turn started
    // then runs against a session whose replacement holder is not installed. `stopping` refuses
    // once teardown has begun: the swap's own deferred drive fires after its cutover completes,
    // which can be while `quiesce` is still joining the chain, so a stop that carefully drained the
    // old work would start NEW work behind its own back, after presence had already gone offline.
    // Listing which callers are covered is what let that through; the condition is the state, and
    // every caller is covered because there is nowhere else a turn begins.
    if (stopping || driving || busy || swapping) return;
    if (bootPrompt !== undefined) return; // the boot turn goes first; this batch waits in the inbox
    driving = true;
    try {
      const id = await ensureSession();
      if (!id) return; // no visible session yet — retry on the next event/wake
      const parts: { type: "text"; text: string }[] = [];
      let ids: string[] = [];
      if (override) {
        parts.push({ type: "text", text: override });
      } else {
        const items = agent.peekInbox("automatic");
        if (items.length === 0) return;
        ids = items.map((i) => i.id);
        const inj = formatInjection(items);
        if (inj) parts.push({ type: "text", text: inj });
      }
      if (!briefed) {
        briefed = true;
        const brief = agent.channelBriefing();
        if (brief) parts.unshift({ type: "text", text: brief });
      }
      if (parts.length === 0) return;
      const body: { parts: typeof parts; system?: string } = { parts };
      // persona once, as system (no --append-system-prompt). Append the orientation bootstrap so the
      // agent is told to orient first — gated on persona so we never replace OpenCode's default system.
      if (!primed && persona) body.system = `${persona}\n\n${ORIENTATION_BOOTSTRAP}\n\n${MESH_FIRST_STEER}`;
      busy = true;
      surfaced = ids;
      // Arm BEFORE the await: a turn-end signal can land before the server request resolves, and
      // completeTurn bails unless armed — arming after would drop it and wedge the agent.
      awaitingTurnEnd = true;
      await opencodeApi(`/session/${encodeURIComponent(id)}/prompt_async`, { method: "POST", body: JSON.stringify(body) }, 10_000);
      primed = true;
    } catch (e) {
      busy = false;
      surfaced = [];
      awaitingTurnEnd = false;
      log(`drive failed: ${(e as Error).message}`);
      scheduleErrorRetry();
    } finally {
      driving = false;
    }
  }

  /** Submit the boot prompt as this session's FIRST turn — exactly one, ever. It waits for the
   *  session to exist (there is nothing to prompt into before that) and for the mesh link to be up,
   *  because that turn also orients the agent on the mesh and answers back there. `bootPrompt` is
   *  cleared in the same synchronous step that drives it — nothing awaits in between — so a later
   *  readiness event cannot issue a second boot turn, and the floor is released even when there is
   *  no session to drive into. drive() itself never prompts into a running turn. */
  void (async () => {
    if (bootPrompt === undefined) return;
    const id = await sessionReady;
    while (!stopping && !agent.connected) await new Promise((r) => setTimeout(r, 100).unref?.());
    if (stopping || bootPrompt === undefined) return;
    const text = bootPrompt;
    bootPrompt = undefined;
    if (!id) {
      log("initial prompt not submitted — this session was never created");
      return;
    }
    await drive(text);
  })();

  /** Ack exactly the surfaced ids. Quiet ambient may be physically interleaved ahead of them, and
   *  overflow may already have removed some; MeshAgent marks every confirmed id handled while only
   *  acking entries still present. */
  function ackSurfaced(): void {
    if (surfaced.length === 0) return;
    agent.drainInboxIds(surfaced);
    surfaced = [];
  }

  function abandonSurfaced(): void {
    surfaced = [];
  }

  /** Native TUI / API prompts enter through OpenCode's chat.message hook before the model loop
   *  starts. This is the real "next turn" boundary for human-typed input: prepend the buffered Cotal
   *  batch to the user's text, then ack it when the resulting turn ends. We only mutate an existing
   *  text part so we don't need to manufacture OpenCode's internal part IDs. */
  function injectIntoPrompt(output: { parts?: unknown[] }): void {
    if (driving || awaitingTurnEnd) return; // drive() already injected, or one surfaced batch is open
    const items = agent.peekInbox("automatic");
    if (items.length === 0) return;
    const inj = formatInjection(items);
    if (!inj) return;
    const textPart = output.parts?.find(
      (p): p is { type: "text"; text: string } =>
        typeof p === "object" && p !== null && (p as { type?: unknown }).type === "text" && typeof (p as { text?: unknown }).text === "string",
    );
    if (!textPart) return;
    textPart.text = `${inj}\n\n${textPart.text}`;
    surfaced = items.map((i) => i.id);
    awaitingTurnEnd = true;
    busy = true;
  }

  /** A turn ended — ANY turn, ours (a driven inbox batch) OR the human's (typing into the attached
   *  TUI, a `/reconnect`, etc). Clear `busy` regardless of who drove it: it's the COALESCE guard, so
   *  a turn the connector didn't drive must still release it or every later push wedges behind a
   *  finished turn. Ack only what WE surfaced (gated on awaitingTurnEnd — a human turn surfaced
    *  nothing), then flush the next buffered batch — mode-aware, so bare ambient (dnd/focus) doesn't
    *  self-wake. A truly stray idle (nothing was running and
   *  we drove nothing) is ignored, so it can't mis-ack or empty-drive. */
  function completeTurn(): void {
    if (!busy && !awaitingTurnEnd) return; // stray/duplicate idle — no turn to close
    busy = false;
    if (awaitingTurnEnd) {
      awaitingTurnEnd = false;
      ackSurfaced(); // our driven turn: ack the surfaced batch (the sole ack site)
    }
    clearInterruptIntent();
    clearErrorRetry(true);
    if (pendingForWake() > 0) void drive();
  }

  // Inbound mesh → drive (never interrupt a running turn — matches Claude). A directed message
  // (DM / anycast / @mention) drives when idle; ambient channel chatter drives only in `open` while
  // idle (dnd/focus hold it for the next turn), and receive-time pull-only ambient never drives
  // (a quiet @mention remains automatic). `muted` ambient never reaches here
  // (ack-dropped at ingest); in `focus`, ambient/@mentions never reach "incoming" either.
  agent.on("incoming", (item: InboxItem) => {
    if (busy) return; // buffer; chat.message or completeTurn drives at the next safe boundary
    const automatic = agent.inboxScope(item.id) === "automatic";
    const directed = item.kind !== "channel" || item.mentionsMe;
    if (automatic && (directed || agent.attention === "open")) void drive();
  });
  agent.on("mention-wake", (item: InboxItem) => {
    // Focus: the @mention body was acked-and-dropped at ingest — wake a turn to PULL it (recall).
    if (!busy) void drive(`📨 You were mentioned by ${fmtFrom(item)} on #${item.channel ?? "?"} — read it with cotal_inbox.`);
  });
  agent.on("wake", () => {
    if (!busy) void drive();
  });

  /** Match an event's session against the one we drive. Adopt the first session id we see, then
   *  filter to it; later top-level `session.created` events adopt explicitly as reset-in-place.
   *
   *  LOAD-BEARING FOR THE EVENT PLANE, not merely tidy. The flush sites are fed the AMBIENT id, so
   *  an event that gets past this filter does not address its own session at all: it pumps whichever
   *  this process drives, publishing that session's staged turn early. R7 in
   *  `smoke/mutations/opencode-events-reset.json` opens this filter and requires a cell to notice. */
  const ours = (id?: string): boolean => {
    if (!id) return !sessionID; // a session-less event counts as ours only before we've adopted one
    if (!sessionID) adoptSession(id, "first event");
    return id === sessionID;
  };

  /**
   * EVERY WAY IN, FENCED IN ONE PLACE. Once teardown has begun, admitting more work undoes the
   * teardown: a late `permission.asked` or tool hook republishes presence over the offline record
   * `quiesce` exists to publish, a part or idle enqueues holder work after the join has already
   * snapshotted it, and a late `session.created` extends the very chain the join is waiting on.
   *
   * The refusal is applied by CONSTRUCTION rather than written at each entry, because writing it at
   * each entry is the mistake this file has now made twice: the guard was correct for every caller
   * that had been listed, and the list was mistaken for the property. A hook is fenced here by being
   * in this table, so a door added later cannot be forgotten, and there is no per-entry line for a
   * refactor to drop. `dispose` is deliberately NOT in it, being the teardown itself.
   *
   * BOUNDED, NOT ABSOLUTE. This closes ADMISSION, not the work already inside a hook when the flag
   * flips; that work is what the joins in `quiesce` cover, and a hook that had already passed this
   * point still runs. The two together are the claim, and neither is it alone.
   */
  const fence = <T extends Record<string, (...args: never[]) => Promise<unknown>>>(intake: T): T =>
    Object.fromEntries(
      Object.entries(intake).map(([name, hook]) => [
        name,
        async (...args: never[]): Promise<unknown> => (stopping ? undefined : await hook(...args)),
      ]),
    ) as T;

  /**
   * THE TOOL MAP IS INTAKE TOO, and it does not arrive through the table above. OpenCode is handed
   * these closures once, at registration, so a call already inside the model's turn reaches its spec
   * with no idea a stop is running: nothing in the turn loop knows the control socket fired. The
   * harm is the same one, not a smaller one. `cotal_status` publishes presence and would put the
   * seat back on the mesh it has just left, and the rest write to channels a departed seat should
   * no longer be writing to.
   *
   * REFUSED, NOT DROPPED. A tool call has a caller waiting on a result, so returning nothing would
   * read as a hang rather than as a shutdown; and it never throws, which is the convention this
   * whole surface already keeps.
   */
  const fenceTools = (tools: Record<string, ToolDefinition>): Record<string, ToolDefinition> =>
    Object.fromEntries(
      Object.entries(tools).map(([name, def]) => [
        name,
        {
          ...def,
          execute: async (...args: Parameters<ToolDefinition["execute"]>): ReturnType<ToolDefinition["execute"]> =>
            stopping ? `⚠ ${name} was not run: this seat is shutting down` : await track(def.execute(...args)),
        },
      ]),
    );

  const intake = {
    "chat.message": async (input, output) => {
      if (!ours(input.sessionID)) return;
      // OpenCode exposes the selected model only on this prompt hook. Do not invent a pre-turn
      // default: before the first prompt the dashboard truthfully shows "not reported".
      if (input.model)
        await track(agent.setModel(`${input.model.providerID}/${input.model.modelID}`, input.variant));
      injectIntoPrompt(output);
    },

    event: async ({ event }) => {
      // The server emits `permission.asked` (the SDK's `permission.updated` type ships but never
      // fires — #11616), so match the real runtime name out of band. With permission:"allow" this
      // rarely triggers, but it keeps presence correct if the posture tightens.
      if ((event.type as string) === "permission.asked") {
        const p = event.properties as { sessionID?: string; title?: string };
        if (!p.sessionID || ours(p.sessionID)) await safeStatus("waiting", p.title);
        return;
      }
      switch (event.type) {
        case "session.created": {
          // Adopt every top-level session created in this OpenCode process. That makes `/new` a
          // Cotal-aware context reset: same mesh identity, new OpenCode context/session id.
          if (event.properties.info.parentID) break;
          const created = event.properties.info.id;
          // SERIALIZED, AND NOT BY THE OBVIOUS SWAP (#600). Taking the holder out before the await
          // and installing the replacement there looks smaller and is unsafe: a fresh holder has no
          // `path` until something adopts it, and adopt happens after the await, so a second
          // invocation reads the replacement as "nothing to retire", skips the drain and adopts it,
          // then the first invocation adopts the same holder and the one-thread-per-holder refusal
          // fires. Measured: that turns a silent leak into a dead event plane. Serializing the whole
          // swap is what actually closes the window, because each swap then reads a holder that is
          // already settled rather than one mid-retirement.
          const swap = swapChain.then(async () => {
            swapping = true;
            try {
            // The id is adopted here, ahead of the drain, so status and prompt work follow the new
            // session at once. It is deliberately NOT paired with the holder install below, and does
            // not need to be: the event plane routes on the holder's OWN binding, so an event landing
            // in this window reaches a holder only if that holder is already bound to its thread.
            // Ordering these two flips against each other was the earlier attempt; it only ever moved
            // the gap, because two variables cannot be made one by sequencing them.
            adoptSession(created, "top-level session create");
            const previous = events;
            if (previous && previous.path !== undefined && previous.path !== created) {
              // DRAIN, THEN SWAP. Flush first so the session being left publishes what it settled,
              // then close its open run: an observer that never sees the close holds a run that never
              // ends, and the plane's rule is that a divergence is on the wire rather than silent.
              //
              // THE AWAIT IS THE ORDERING AND IS NOT A STYLE CHOICE. The two calls above land on the
              // OLD holder's chain and the new session's frames go out on a DIFFERENT one, so without
              // a settled point between them the new session's first frame can reach the subject
              // before the old session's close.
              // Symmetric with the adoption line above, and load-bearing rather than decorative: a
              // retirement that never happens is otherwise invisible, because a dropped holder has no
              // frames left to publish and its open handle looks identical to a cleanly retired one.
              previous.flush(previous.path);
              previous.closeRun(Date.now());
              const drained = await settleWithin(previous.settled(), SWAP_SETTLE_MS, `drain of ${previous.path}`);
              // AFTER the settle, never before it. Logged before, this line reports that the retire
              // path was ENTERED, and a cell keyed on it stays green even if the drain never finishes.
              log(`${SESSION_RETIRED} ${previous.path} superseded by ${created}; ${drained ? "drained before release" : "ABANDONED UNDRAINED"}`);
              events = newEventHolder();
            }
            // Adopt READS FROM HERE. A resumed session must not republish its history, and the
            // source's fresh adopt returns the position of the end for exactly that reason.
            eventsFor(created)?.adopt(created);
            } finally {
              swapping = false;
            }
            // THE DEFERRED DRIVE, and it is outside the `finally` on purpose. The cutover waiter is
            // complete at this line: the predecessor either drained or spent the bound, the
            // replacement holder is installed and bound, and `swapping` is already clear, so this
            // turn is allowed to start and produces records the holder publishes rather than records
            // it adopted past. Drained is not guaranteed, only waited for: a predecessor that
            // outlived the bound is released undrained and this line still runs.
            if (pendingForWake() > 0) void drive();
          });
          // The chain carries the SUCCESSFUL tail only: a rejected swap is absorbed so the next one
          // still runs, while this invocation still sees its own failure.
          swapChain = swap.catch(() => undefined);
          await swap;
          break;
        }
        case "session.idle": {
          const idleSession = event.properties.sessionID;
          if (!ours(idleSession)) return;
          // Order matters and is not stylistic: flush the turn's records FIRST, then close the run.
          // Both land on the holder's chain in the order they were enqueued, so closing first would
          // terminate a run the records that follow still belong to.
          eventsFor(sessionID)?.flush(sessionID);
          eventsFor(sessionID)?.closeRun(Date.now());
          await safeStatus("idle");
          completeTurn(); // the sole turn-end site: ack-on-surface + drive the next batch
          break;
        }
        case "session.status": {
          if (!ours(event.properties.sessionID)) return;
          const s = event.properties.status;
          // Presence only — session.idle owns ack + drive (so a duplicate idle can't mis-ack).
          if (s.type === "busy") {
            busy = true;
            await safeStatus("working");
          } else if (s.type === "idle") {
            await safeStatus("idle");
          } else if (s.type === "retry") {
            await safeStatus("working", `retrying: ${s.message}`);
          }
          break;
        }
        case "session.error":
          // session.error's sessionID is OPTIONAL; skip only a DIFFERENT session's error — a
          // session-less one (id undefined) during an in-flight turn must still close it, else
          // `busy` stays stuck and every later push is buffered behind a turn that already failed.
          if (event.properties.sessionID && !ours(event.properties.sessionID)) return;
          if (!busy && !awaitingTurnEnd) return; // no turn to fail — stray error
          // A failed turn still ENDED, so the run is closed rather than left open for the next one
          // to be refused against. It closes with no outcome, which says the run ended and does not
          // claim it succeeded; `RUN_ERROR` is unreachable from any emitter on this plane today.
          eventsFor(sessionID)?.flush(sessionID);
          eventsFor(sessionID)?.closeRun(Date.now());
          const interrupted = consumeInterruptIntent(event.properties.sessionID) || isMessageAbortedError(event.properties.error);
          busy = false;
          if (awaitingTurnEnd) {
            awaitingTurnEnd = false;
            if (interrupted) ackSurfaced(); // explicit user Stop/Cancel: treat the surfaced batch as dismissed, not failed
            else abandonSurfaced(); // failed turn: leave inbox unacked so the batch can retry on a later safe turn
          }
          await safeStatus("idle");
          if (!interrupted) scheduleErrorRetry();
          else clearErrorRetry(true);
          break;
        case "message.part.updated": {
          // NEAR-LIVE. The bus is the wake signal and never the data path: this says "look now", and
          // the source then reads the durable store and decides what is settled enough to publish.
          const partSession = (event.properties as { part?: { sessionID?: string } }).part?.sessionID;
          if (!ours(partSession)) return;
          eventsFor(sessionID)?.flush(sessionID);
          break;
        }
        case "tui.command.execute": {
          const p = event.properties as { command?: string; sessionID?: string };
          if (p.command === "session.interrupt") markInterruptIntent(p.sessionID);
          break;
        }
        case "session.deleted":
          if (!ours(event.properties.info.id)) return;
          await safeStatus("offline");
          break;
      }
    },

    // Surface the running tool as presence activity (parity with Claude's PreToolUse).
    "tool.execute.before": async (input) => {
      if (!ours(input.sessionID)) return;
      await safeStatus("working", input.tool);
    },
  } satisfies Partial<Hooks>;

  const hooks: Hooks = {
    tool: fenceTools(buildCotalTools(agent, config)),
    ...fence(intake),

    // The editor unloading the plugin. Same teardown as the manager's stop, minus the exit: see
    // `quiesce`, which owns the join so that neither exit can drift from the other.
    //
    // NO CELL GRADES THE dispose CALLER SPECIFICALLY. The shared routine is graded through the
    // manager's cooperative stop, which is the path a supervised seat takes and the one that has a
    // harness; this caller reaches the same code. Filed as #632.
    dispose: async () => {
      await quiesce();
    },
  };

  guard.__cotalOpencodeHooks = hooks;
  log(`opencode plugin ready — space="${config.space}" name="${config.name}"${config.role ? ` role="${config.role}"` : ""}`);
  return hooks;
};
