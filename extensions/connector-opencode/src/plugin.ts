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
import type { Plugin, Hooks } from "@opencode-ai/plugin";
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
  const safeStatus = async (status: PresenceStatus, activity?: string): Promise<void> => {
    try {
      if (agent.connected) await agent.setStatus(status, activity);
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
  const shutdown = async (): Promise<void> => {
    stopping = true;
    try {
      controlServer?.close();
    } catch {
      /* ignore */
    }
    try {
      await safeStatus("offline");
      await agent.stop();
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
    if (driving || busy) return;
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
   *  filter to it; later top-level `session.created` events adopt explicitly as reset-in-place. */
  const ours = (id?: string): boolean => {
    if (!id) return !sessionID; // a session-less event counts as ours only before we've adopted one
    if (!sessionID) adoptSession(id, "first event");
    return id === sessionID;
  };

  const hooks: Hooks = {
    tool: buildCotalTools(agent, config),

    "chat.message": async (input, output) => {
      if (!ours(input.sessionID)) return;
      // OpenCode exposes the selected model only on this prompt hook. Do not invent a pre-turn
      // default: before the first prompt the dashboard truthfully shows "not reported".
      if (input.model)
        await agent.setModel(`${input.model.providerID}/${input.model.modelID}`, input.variant);
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
          // IDENTITY AND HOLDER FLIP TOGETHER, and this is the whole reason the adopt is in here.
          // Setting the current session id outside the swap made them flip at different times, and
          // any ordinary event arriving in that gap was routed BY THE NEW ID to the OLD holder,
          // which is bound to a different thread and refuses terminally. Measured: a
          // `message.part.updated` for the new session, delivered while the swap was still queued,
          // killed the emitter and took the plane down.
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
            await previous.settled();
            // AFTER the settle, never before it. Logged before, this line reports that the retire
            // path was ENTERED, and a cell keyed on it stays green even if the drain never finishes.
            log(`${SESSION_RETIRED} ${previous.path} superseded by ${created}; drained before release`);
            events = newEventHolder();
          }
          // Adopt READS FROM HERE. A resumed session must not republish its history, and the
          // source's fresh adopt returns the position of the end for exactly that reason.
          events?.adopt(created);
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
          events?.flush(sessionID);
          events?.closeRun(Date.now());
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
          events?.flush(sessionID);
          events?.closeRun(Date.now());
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
          events?.flush(sessionID);
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

    dispose: async () => {
      stopping = true;
      try {
        controlServer?.close();
      } catch {
        /* ignore */
      }
      await safeStatus("offline");
      clearErrorRetry(true);
      await agent.stop();
    },
  };

  guard.__cotalOpencodeHooks = hooks;
  log(`opencode plugin ready — space="${config.space}" name="${config.name}"${config.role ? ` role="${config.role}"` : ""}`);
  return hooks;
};
