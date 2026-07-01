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
 *    TURN COMPLETION (so a crash/error redelivers). Pending peer messages are also injected into
 *    the next native prompt creation when a human/API prompt starts in the attached session.
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
  transcriptChannel,
  type InboxItem,
} from "@cotal-ai/connector-core";
import type { Plugin, Hooks } from "@opencode-ai/plugin";
import { buildCotalTools } from "./tools.js";
import { createTranscriptMirror } from "./transcript.js";

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
  // Transcript mirror → `tr-<name>`: opt-in via COTAL_TRANSCRIPT (the connector's buildLaunch / the
  // manager set it for managed sessions; a personal opencode never mirrors). EVENT-DRIVEN — fed from
  // the OpenCode event hook below (message.updated → assistant roles, message.part.updated → parts)
  // and flushed at session.idle, so it never re-reads the whole session. The manager grants this agent
  // pub rights on the same `tr-<name>` channel.
  const transcript = /^(1|true|yes|on)$/i.test(process.env.COTAL_TRANSCRIPT ?? "")
    ? createTranscriptMirror(agent, transcriptChannel(config.name))
    : undefined;

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
    clearErrorRetry(true);
    transcript?.reset(); // hard session boundary: drop any buffered parts so `/new` never mirrors them
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
    driving = true;
    try {
      const id = await ensureSession();
      if (!id) return; // no visible session yet — retry on the next event/wake
      const parts: { type: "text"; text: string }[] = [];
      let ids: string[] = [];
      if (override) {
        parts.push({ type: "text", text: override });
      } else {
        const items = agent.peekInbox();
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
      if (!primed && persona) body.system = `${persona}\n\n${ORIENTATION_BOOTSTRAP}`;
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

  /** Ack the surfaced batch — but only the leading run STILL at the front of the inbox, matched by
   *  id. MeshAgent evicts from the FRONT at MAX_INBOX, so a long turn on a chatty channel can shift
   *  our surfaced prefix out; matching by id (not a raw count) means we never ack the wrong, newer
   *  messages. Evicted items were already acked by the overflow; any surfaced survivor that no
   *  longer leads is left unacked → redelivered (re-answered, never lost). */
  function ackSurfaced(): void {
    if (surfaced.length === 0) return;
    const front = agent.peekInbox();
    let n = 0;
    while (n < surfaced.length && n < front.length && front[n].id === surfaced[n]) n++;
    if (n > 0) agent.drainInbox(n);
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
    const items = agent.peekInbox();
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
   *  self-wake (it rides the next directed/human turn). A truly stray idle (nothing was running and
   *  we drove nothing) is ignored, so it can't mis-ack or empty-drive. */
  function completeTurn(): void {
    if (!busy && !awaitingTurnEnd) return; // stray/duplicate idle — no turn to close
    busy = false;
    if (awaitingTurnEnd) {
      awaitingTurnEnd = false;
      ackSurfaced(); // our driven turn: ack the surfaced batch (the sole ack site)
    }
    clearErrorRetry(true);
    if (pendingForWake() > 0) void drive();
  }

  // Inbound mesh → drive (never interrupt a running turn — matches Claude). A directed message
  // (DM / anycast / @mention) drives when idle; ambient channel chatter drives only in `open` while
  // idle (dnd/focus hold it for the next turn), and a per-channel `quiet` channel never ambient-drives
  // (read on the agent's terms; a `quiet` @mention still drives). `muted` ambient never reaches here
  // (ack-dropped at ingest); in `focus`, ambient/@mentions never reach "incoming" either.
  agent.on("incoming", (item: InboxItem) => {
    if (busy) return; // buffer; chat.message or completeTurn drives at the next safe boundary
    const directed = item.kind !== "channel" || item.mentionsMe;
    const quiet = item.kind === "channel" && agent.channelMode(item.channel) === "quiet";
    if (directed || (!quiet && agent.attention === "open")) void drive();
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
        case "session.created":
          // Adopt every top-level session created in this OpenCode process. That makes `/new` a
          // Cotal-aware context reset: same mesh identity, new OpenCode context/session id.
          if (!event.properties.info.parentID) adoptSession(event.properties.info.id, "top-level session create");
          break;
        case "message.updated":
          // Feed the transcript mirror: which messages on OUR session are assistant-authored.
          if (transcript && ours(event.properties.info.sessionID)) transcript.record(event.properties.info);
          break;
        case "message.part.updated":
          // Feed the transcript mirror: buffer each part as it streams (no per-turn refetch).
          if (transcript && ours(event.properties.part.sessionID)) transcript.observe(event.properties.part);
          break;
        case "session.idle": {
          const idleSession = event.properties.sessionID;
          if (!ours(idleSession)) return;
          await safeStatus("idle");
          // Publish what the agent did this turn BEFORE driving the next batch, so a fresh turn's parts
          // don't bleed in. The mirror is an observability side-channel: surface a publish failure but
          // keep it OFF the turn loop, so a transport hiccup can never wedge the agent.
          if (transcript)
            await transcript.flush().catch((e) => log(`transcript mirror publish failed: ${(e as Error).message}`));
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
          busy = false;
          if (awaitingTurnEnd) {
            awaitingTurnEnd = false;
            abandonSurfaced(); // failed turn: leave inbox unacked so the batch can retry on a later safe turn
          }
          await safeStatus("idle");
          scheduleErrorRetry();
          break;
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
