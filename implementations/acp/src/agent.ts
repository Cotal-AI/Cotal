/**
 * The ACP agent: Cotal seats as ACP sessions.
 *
 * A session id is the seat's name. `session/new` launches nothing, so a client that opens and drops a
 * session (T3 Code probes every provider this way) leaves no seat. The first prompt spawns the seat
 * with that prompt as its kickoff, in the session's folder, through the session's manager. The seat
 * belongs to the manager and outlives this process.
 *
 * A later prompt is typed into the seat's terminal through its manager's `input` command, so it
 * arrives as the operator's own words, as the first prompt does. Cotal does not tie typed text to the
 * run it starts, so that prompt answers when the seat stops working: its presence is no longer
 * `working` and no run that started after the text was typed is open. A seat that does not start
 * working soon after ends the prompt too. A manager that refuses the text fails the prompt with its
 * reason.
 *
 * Every update of a turn is sent before the prompt answers. A client may drop updates that arrive
 * after a prompt settled, so nothing is left to send afterwards.
 */
import { randomBytes } from "node:crypto";
import { realpathSync } from "node:fs";
import { agent, methods, PROTOCOL_VERSION, RequestError, type AgentApp, type AgentContext, type ContentBlock, type SessionUpdate, type StopReason } from "@agentclientprotocol/sdk";
import { FrameMapper, type RunSignal } from "./frames.js";
import { LaunchListsRefused, NoLaunchManager, SignInRequired, type Mesh, type SeatFrame, type SeatRef, type SeatRow } from "./mesh.js";
import { applyOption, configOptions, DEFAULT_PERSONA, DEFAULT_VARIANT, defaultManager, initialSelection, MAX_CHOICES, NO_CHANNEL, parseModel, reconcile, refusal, type Offer, type Selection } from "./options.js";

/** The slash commands every session offers. */
export const COMMANDS = [
  { name: "despawn", description: "Stop this session's agent. The session stays, and the reply says whether a new prompt can start another." },
  { name: "roster", description: "List who is on the mesh and what each is doing." },
  { name: "channels", description: "List the space's channels." },
] as const;

/** How long a seat may be absent from the roster during a turn before the turn fails. */
const ABSENT_MS = 20_000;
const WATCH_MS = 250;
/** How long a later prompt waits for the seat to start working on it. */
export const START_MS = 30_000;
/** How long a seat must stay stopped, with no run open, before a later prompt answers. Presence and
 *  the last frames travel separately, so this lets the last frames arrive first. */
export const SETTLE_MS = 2_000;
/** Frames from a seat no session holds are kept this long, in case a spawn reply names it next. */
const UNCLAIMED_MS = 120_000;
const UNCLAIMED_FRAMES = 500;

/** The seat runs `session/delete` hid, by lifecycle UID. A delete hides one run and never stops it;
 *  a later seat under the same name lists again. */
export interface HiddenSessions {
  read(): ReadonlySet<string>;
  add(lifecycleUid: string): void;
}

export interface CotalAgentOptions {
  /** Opens the space on first use. A failure here is reported on the request that needed it. */
  readonly mesh: () => Promise<Mesh>;
  readonly hidden: HiddenSessions;
  readonly log: (line: string) => void;
  readonly version: string;
  /** Mints a new session's id, which becomes its seat's name. */
  readonly newName?: () => string;
  /** Overrides `START_MS` and `SETTLE_MS`. */
  readonly waits?: { readonly startMs?: number; readonly settleMs?: number };
}

interface Turn {
  readonly stop: (reason: StopReason) => void;
  readonly fail: (error: Error) => void;
  /** `run`: the first run that starts at or after `after` answers the prompt. `idle`: the prompt
   *  answers once the seat started working and stopped again. */
  readonly until: "run" | "idle";
  /** Runs that start at or after this time belong to the prompt. */
  readonly after: number;
  /** The run that answers a `run` prompt, once it started. */
  runId?: string;
  /** The runs that started at or after `after`. One that fails fails the prompt. */
  readonly runs: Set<string>;
  /** The seat has been seen working since the prompt was sent. */
  started: boolean;
  /** Since when the seat has been stopped with no run open. */
  quietSince?: number;
  /** A cancel arrived: `requested` until the interrupt key is written, then when it was or when the
   *  manager refused it. */
  cancelled?: "requested" | number;
  /** Interrupt the seat for a `session/cancel`. */
  readonly cancel: () => void;
  lastSeen: number;
  timer?: ReturnType<typeof setInterval>;
}

interface Session {
  readonly id: string;
  cwd: string;
  offer: Offer;
  selection: Selection;
  seat?: SeatRef;
  /** The first prompt's spawn, while the manager has not answered it. */
  spawning?: Promise<SeatRef>;
  mapper: FrameMapper;
  /** The seat's runs that started and have not ended, with when each started. A later prompt answers
   *  only once its own runs ended. */
  open: Map<string, number>;
  turn?: Turn;
  client: AgentContext;
  /** The manager that held the agent a loaded thread opened with. It stays a Machine choice. */
  held?: string;
}

const principal = (p: { owner: string; actor: string }): string => `${p.owner}.${p.actor}`;

/** A seat no manager listed. When a manager did not answer, the seat may run there, so that is the
 *  answer, not that the seat does not exist. */
function notListed(name: string, silent: readonly string[]): RequestError {
  if (silent.length === 0) return RequestError.resourceNotFound(name);
  return RequestError.internalError(undefined, `${name} was not listed, and ${silent.length === 1 ? "manager" : "managers"} ${silent.join(", ")} did not answer, so it may run there. Try again once ${silent.length === 1 ? "it answers" : "they answer"}. A manager whose host is gone stays registered until you remove it with \`cotal endpoint deregister manager <id> --yes\`.`);
}

function canonical(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

/** A prompt's blocks as the text a seat receives. A link names its target; other kinds are refused
 *  by the capabilities `initialize` declares. */
export function promptText(blocks: readonly ContentBlock[]): string {
  return blocks.map((b) => {
    if (b.type === "text") return b.text;
    if (b.type === "resource_link") return b.name && b.name !== b.uri ? `[${b.name}](${b.uri})` : b.uri;
    throw RequestError.invalidParams(undefined, `${b.type} content is not supported`);
  }).join("\n\n").trim();
}

export function defaultName(): string {
  // Lowercase base32 keeps the name a valid user-mode actor token.
  const alphabet = "abcdefghijklmnopqrstuvwxyz234567";
  return `acp_${Array.from(randomBytes(10), (b) => alphabet[b & 31]).join("")}`;
}

export function cotalAgent(options: CotalAgentOptions): AgentApp {
  const sessions = new Map<string, Session>();
  const byPrincipal = new Map<string, Session>();
  const unclaimed = new Map<string, { at: number; frames: SeatFrame[] }>();
  let opened: Promise<Mesh> | undefined;
  let stopFollowing: (() => void) | undefined;
  const newName = options.newName ?? defaultName;
  const startMs = options.waits?.startMs ?? START_MS;
  const settleMs = options.waits?.settleMs ?? SETTLE_MS;

  const send = (session: Session, update: SessionUpdate, replay = false): Promise<void> =>
    session.client.notify(methods.client.session.update, { sessionId: session.id, update, ...(replay ? { _meta: { isReplay: true } } : {}) });

  const route = (frame: SeatFrame): void => {
    const key = principal(frame);
    const session = byPrincipal.get(key);
    if (!session) {
      const now = Date.now();
      for (const [k, v] of unclaimed) if (now - v.at > UNCLAIMED_MS) unclaimed.delete(k);
      const held = unclaimed.get(key) ?? { at: now, frames: [] };
      held.at = now;
      held.frames.push(frame);
      if (held.frames.length > UNCLAIMED_FRAMES) held.frames.shift();
      unclaimed.set(key, held);
      return;
    }
    deliver(session, frame);
  };

  const deliver = (session: Session, frame: SeatFrame): void => {
    const { updates, runs } = session.mapper.map(frame);
    for (const update of updates) void send(session, update).catch((e: Error) => options.log(`session ${session.id}: update not sent: ${e.message}`));
    for (const run of runs) {
      if (run.kind === "start") session.open.set(run.runId, run.ts);
      else session.open.delete(run.runId);
      onRun(session, run);
    }
  };

  const onRun = (session: Session, run: RunSignal): void => {
    const turn = session.turn;
    if (!turn) return;
    if (run.kind === "start") {
      if (run.ts < turn.after) return;
      turn.runs.add(run.runId);
      turn.started = true;
      turn.runId ??= run.runId;
      return;
    }
    if (!turn.runs.has(run.runId)) return;
    if (run.outcome === "error") turn.fail(new Error(`${session.seat?.name ?? session.id}'s turn failed${run.message ? `: ${run.message}` : ""}`));
    else if (turn.until === "run" && run.runId === turn.runId) turn.stop("end_turn");
  };

  const mesh = (): Promise<Mesh> => {
    opened ??= options.mesh().then((m) => {
      stopFollowing = m.followFrames(route);
      return m;
    });
    return opened.catch((e: Error) => {
      opened = undefined;
      throw e instanceof SignInRequired ? RequestError.authRequired(undefined, e.message) : RequestError.internalError(undefined, e.message);
    });
  };

  const bind = (session: Session, seat: SeatRef): void => {
    session.seat = seat;
    const key = principal(seat);
    byPrincipal.set(key, session);
    const held = unclaimed.get(key);
    unclaimed.delete(key);
    for (const frame of held?.frames ?? []) deliver(session, frame);
  };

  const unbind = (session: Session): void => {
    // A deleted or replaced session's running prompt answers cancelled. Its seat keeps working.
    if (session.turn) {
      session.turn.cancelled = Date.now();
      session.turn.stop("cancelled");
    }
    if (session.seat) byPrincipal.delete(principal(session.seat));
    session.seat = undefined;
    session.mapper = new FrameMapper();
    session.open = new Map();
  };

  /** The offer of a thread opened without the launch lists: the seat's own application and model,
   *  nothing to launch with. Without the lists the bridge cannot tell whether the application has an
   *  event plane, so it follows the seat's channel, and a prompt the seat never starts on ends with
   *  its note. */
  const seatOffer = (row: SeatRow): Offer => ({
    catalogs: [{ agent: row.agent, available: true, eventPlane: true, models: row.model ? [{ id: row.model, variants: [] }] : [] }],
    personas: [],
    channels: [],
    managers: [],
    defaultAgent: row.agent,
    seatOnly: true,
  });

  /** The launch lists of the manager a thread starts on. A loaded thread passes the manager that
   *  `held` its agent: it stays a choice, and the thread opens while no manager may start a new one. */
  const offerFor = async (m: Mesh, machine?: string, held?: string): Promise<Offer> => {
    const listed = await m.managers().catch((e: unknown) => {
      if (held === undefined || !(e instanceof NoLaunchManager)) throw e;
      return [];
    });
    const managers = held === undefined || listed.some((x) => x.instanceId === held) ? listed : [...listed, { instanceId: held, local: false }];
    // Read the lists of the manager a new session starts on, never whichever the exchange picks.
    const from = machine ?? defaultManager(managers)?.instanceId;
    const [catalogs, personas, channels] = await Promise.all([m.catalogs(from), m.personas(from), m.channels()]);
    if (personas.length >= MAX_CHOICES) options.log(`the persona catalog holds ${personas.length} personas, more than a client select shows; the persona option is not offered`);
    if (channels.length >= MAX_CHOICES) options.log(`the space holds ${channels.length} channels, more than a client select shows; the channel option is not offered`);
    return { catalogs, personas, channels, managers, defaultAgent: catalogs.find((c) => c.agent === m.defaultAgent)?.agent };
  };

  const sessionOf = (id: string): Session => {
    const s = sessions.get(id);
    if (!s) throw RequestError.sessionNotFound(id);
    return s;
  };

  const announce = async (session: Session): Promise<void> => {
    await send(session, { sessionUpdate: "available_commands_update", availableCommands: COMMANDS.map((c) => ({ ...c })) });
  };

  /** Run one turn to its end. Every update is sent before this resolves. A `run` prompt belongs to the
   *  seat's first run. An `idle` prompt's runs are the ones that start once `start` is called, so a
   *  run that starts and ends before `start` resolves still counts. */
  const runTurn = (session: Session, m: Mesh, until: Turn["until"], start: () => Promise<void>): Promise<StopReason> =>
    new Promise<StopReason>((resolve, reject) => {
      let settled = false;
      const finish = (close: "completed" | "failed", then: () => void) => {
        if (settled) return;
        settled = true;
        clearInterval(turn.timer);
        session.turn = undefined;
        const closes = session.mapper.closeOpen(close).map((u) => send(session, u));
        void Promise.allSettled(closes).then(then);
      };
      // A fresh seat's first run answers its kickoff prompt, whatever its clock says.
      const after = until === "run" ? 0 : Date.now();
      let begun = false;
      const interrupt = (): void => {
        const seat = session.seat;
        if (!seat) return;
        m.interrupt(seat).then(() => {
          if (turn.cancelled === "requested") turn.cancelled = Date.now();
        }, (e: Error) => {
          // A cancelled prompt answers cancelled even when the seat cannot be stopped (ACP v1).
          options.log(`session ${session.id}: interrupt refused: ${e.message}`);
          void send(session, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: `Could not stop ${seat.name}: ${e.message}. It keeps working on the mesh.` } })
            .catch((err: Error) => options.log(`session ${session.id}: update not sent: ${err.message}`));
          turn.cancelled = Date.now();
          turn.stop("cancelled");
        });
      };
      // After a cancel, the prompt answers `cancelled` however the turn ends.
      const turn: Turn = {
        until,
        after,
        runs: new Set(),
        started: false,
        lastSeen: Date.now(),
        stop: (reason) => turn.cancelled !== undefined ? finish("failed", () => resolve("cancelled")) : finish("completed", () => resolve(reason)),
        fail: (error) => turn.cancelled !== undefined ? finish("failed", () => resolve("cancelled")) : finish("failed", () => reject(RequestError.internalError(undefined, error.message))),
        cancel: () => {
          if (turn.cancelled !== undefined) return;
          turn.cancelled = "requested";
          // A cancel that beats the spawn reply or the typed prompt interrupts once that lands.
          if (begun) interrupt();
        },
      };
      session.turn = turn;
      turn.timer = setInterval(() => {
        if (!session.seat) return;
        const now = Date.now();
        if (typeof turn.cancelled === "number") {
          // Connectors end an interrupted run differently or not at all, so wait briefly for it.
          const running = [...turn.runs].some((id) => session.open.has(id));
          if (!running || now - turn.cancelled >= settleMs) turn.stop("cancelled");
          return;
        }
        if (turn.cancelled === "requested") return;
        const status = m.presence(session.seat);
        if (status === undefined) {
          if (now - turn.lastSeen > ABSENT_MS) turn.fail(new Error(`${session.seat.name} left the mesh during its turn`));
          return;
        }
        turn.lastSeen = now;
        // Settle only once the prompt was typed, so a refusal still fails the prompt.
        if (until !== "idle" || !begun) return;
        if (status === "working") turn.started = true;
        if (!turn.started) {
          if (now - after > startMs) {
            clearInterval(turn.timer);
            const line = `${session.seat.name} has the prompt but has not started on it yet.`;
            void send(session, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: line } }).finally(() => turn.stop("end_turn"));
          }
          return;
        }
        const running = [...turn.runs].some((id) => session.open.has(id));
        if (status === "working" || running) turn.quietSince = undefined;
        else if (now - (turn.quietSince ??= now) >= settleMs) turn.stop("end_turn");
      }, WATCH_MS);
      start().then(() => {
        begun = true;
        if (turn.cancelled === "requested") interrupt();
      }, (e: Error) => turn.fail(e));
    });

  const slash = async (session: Session, m: Mesh, text: string): Promise<StopReason | undefined> => {
    const match = /^\/([a-z]+)\b\s*(.*)$/s.exec(text);
    if (!match || !COMMANDS.some((c) => c.name === match[1])) return undefined;
    const say = (line: string) => send(session, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: line } });
    switch (match[1]) {
      case "despawn": {
        if (!session.seat) {
          await say("This session has no agent running.");
          return "end_turn";
        }
        const seat = session.seat;
        await m.despawn(seat);
        unbind(session);
        await say(session.offer.seatOnly ? `Stopped ${seat.name}. Starting another agent here needs a grant that may spawn.` : `Stopped ${seat.name}. A new prompt spawns a fresh agent.`);
        return "end_turn";
      }
      case "roster": {
        const rows = await m.roster();
        await say(rows.length ? rows.map((r) => `- ${r.name}${r.role ? ` (${r.role})` : ""}: ${r.status}${r.activity ? `, ${r.activity}` : ""}`).join("\n") : "Nobody is on the mesh.");
        return "end_turn";
      }
      case "channels": {
        const names = await m.channels();
        await say(names.length ? names.map((n) => `- #${n}`).join("\n") : "The space has no channels.");
        return "end_turn";
      }
    }
    return undefined;
  };

  const app = agent({ name: "cotal" })
    .onRequest(methods.agent.initialize, ({ params }) => ({
      protocolVersion: PROTOCOL_VERSION,
      agentInfo: { name: "cotal", title: "Cotal", version: options.version },
      agentCapabilities: {
        loadSession: true,
        promptCapabilities: { image: false, audio: false, embeddedContext: false },
        sessionCapabilities: { list: {}, delete: {} },
      },
      authMethods: params.clientCapabilities?.auth?.terminal
        ? [{ type: "terminal" as const, id: "cotal-sign-in", name: "Sign in to Cotal", description: "Signs in to a hosted space, or sets up a local one.", args: ["--auth"] }]
        : [],
    }))
    .onRequest(methods.agent.authenticate, async () => {
      await mesh();
      return {};
    })
    .onRequest(methods.agent.session.new, async ({ params, client }) => {
      const m = await mesh();
      const offer = await offerFor(m);
      const id = newName();
      const session: Session = { id, cwd: params.cwd, offer, selection: initialSelection(offer), mapper: new FrameMapper(), open: new Map(), client };
      sessions.set(id, session);
      setImmediate(() => void announce(session).catch(() => {}));
      return { sessionId: id, configOptions: configOptions(offer, session.selection) };
    })
    .onRequest(methods.agent.session.setConfigOption, async ({ params }) => {
      const session = sessionOf(params.sessionId);
      if (!("value" in params) || typeof params.value !== "string") throw RequestError.invalidParams(undefined, `option "${params.configId}" takes a select value`);
      if (session.seat) throw RequestError.invalidParams(undefined, `${session.seat.name} is already running; ${params.configId} applies to a new agent, after /despawn`);
      let next: Selection;
      try {
        next = applyOption(session.offer, session.selection, params.configId, params.value);
      } catch (e) {
        throw RequestError.invalidParams(undefined, (e as Error).message);
      }
      // A thread that cannot start another agent has nothing a changed option would apply to.
      if (session.offer.seatOnly && JSON.stringify(next) !== JSON.stringify(session.selection))
        throw RequestError.invalidParams(undefined, `${session.id} opened without a grant that may spawn, so its options cannot change`);
      if (next.machine !== session.selection.machine) {
        const m = await mesh();
        const offer = await offerFor(m, next.machine, session.held);
        try {
          next = reconcile(offer, next);
        } catch (e) {
          throw RequestError.invalidParams(undefined, (e as Error).message);
        }
        session.offer = offer;
      }
      session.selection = next;
      return { configOptions: configOptions(session.offer, session.selection) };
    })
    .onRequest(methods.agent.session.prompt, async ({ params }) => {
      const session = sessionOf(params.sessionId);
      if (session.turn) throw RequestError.invalidRequest(undefined, "a prompt is already running in this session");
      const text = promptText(params.prompt);
      const m = await mesh();
      const handled = await slash(session, m, text);
      if (handled) return { stopReason: handled };
      if (!text) throw RequestError.invalidParams(undefined, "the prompt is empty");
      const running = session.seat;
      if (running) {
        const stopReason = await runTurn(session, m, "idle", () => m.input(running, text));
        return { stopReason };
      }
      if (session.offer.seatOnly) throw RequestError.invalidParams(undefined, `${session.id} opened without a grant that may spawn, so this thread cannot start another agent`);
      const { agent: harness, model } = parseModel(session.selection.model);
      const why = refusal(session.offer.catalogs, harness);
      if (why) throw RequestError.invalidParams(undefined, why);
      const stopReason = await runTurn(session, m, "run", async () => {
        const spawning = m.spawn({
          name: session.id,
          agent: harness,
          ...(model ? { model } : {}),
          ...(session.selection.variant !== DEFAULT_VARIANT ? { variant: session.selection.variant } : {}),
          ...(session.selection.persona !== DEFAULT_PERSONA ? { persona: session.selection.persona } : {}),
          ...(session.selection.channel !== NO_CHANNEL ? { subscribe: [session.selection.channel] } : {}),
          cwd: session.cwd,
          prompt: text,
          ...(session.selection.machine ? { managerInstanceId: session.selection.machine } : {}),
        });
        session.spawning = spawning;
        const seat = await spawning.finally(() => (session.spawning = undefined));
        // A session deleted or replaced while the spawn was pending keeps no claim on the seat. A
        // delete hides it.
        if (sessions.get(session.id) !== session) return;
        bind(session, seat);
      });
      return { stopReason };
    })
    .onNotification(methods.agent.session.cancel, ({ params }) => {
      sessions.get(params.sessionId)?.turn?.cancel();
    })
    .onRequest(methods.agent.session.list, async ({ params }) => {
      const m = await mesh();
      const want = params.cwd ? canonical(params.cwd) : undefined;
      const hidden = options.hidden.read();
      const rows = (await m.seats()).rows.filter((row) => !hidden.has(row.lifecycleUid) && (want === undefined || (row.cwd !== undefined && canonical(row.cwd) === want)));
      return {
        sessions: rows.map((row) => ({
          sessionId: row.name,
          cwd: row.cwd ?? params.cwd ?? "",
          title: `${row.name} (${row.agent}${row.model ? ` ${row.model}` : ""})`,
          ...(row.uptimeMs !== undefined ? { updatedAt: new Date(Date.now() - row.uptimeMs).toISOString() } : {}),
        })),
      };
    })
    .onRequest(methods.agent.session.load, async ({ params, client }) => {
      const m = await mesh();
      const listed = await m.seats();
      const matches = listed.rows.filter((row) => row.name === params.sessionId);
      if (matches.length === 0) throw notListed(params.sessionId, listed.silent);
      if (matches.length > 1) throw RequestError.invalidParams(undefined, `${matches.length} seats are named ${params.sessionId}; stop all but one`);
      const row: SeatRow = matches[0]!;
      // A person whose grant does not let them spawn may not read the launch lists. Their thread
      // controls the agent they have and offers nothing to launch.
      let launch = true;
      const offer = await offerFor(m, row.managerInstanceId, row.managerInstanceId).catch((e: unknown) => {
        if (!(e instanceof LaunchListsRefused)) throw e;
        options.log(`${row.name} opens with only its own model: ${e.message}`);
        launch = false;
        return seatOffer(row);
      });
      // Only the launch lists say whether an application has an event plane.
      const why = launch ? refusal(offer.catalogs, row.agent) : undefined;
      if (why) throw RequestError.invalidParams(undefined, why);
      const base = initialSelection(offer);
      const session: Session = {
        id: row.name,
        cwd: params.cwd,
        offer,
        selection: { ...base, model: `${row.agent}/${row.model ?? "default"}`, ...(row.managerInstanceId ? { machine: row.managerInstanceId } : {}) },
        mapper: new FrameMapper(),
        open: new Map(),
        client,
        ...(row.managerInstanceId ? { held: row.managerInstanceId } : {}),
      };
      const previous = sessions.get(row.name);
      if (previous) unbind(previous);
      sessions.set(row.name, session);
      // Replay what the space still holds, then follow live. The mapper drops a frame it already sent.
      for (const frame of await m.frameHistory(row)) {
        const { updates } = session.mapper.map(frame);
        for (const update of updates) await send(session, update, true);
      }
      for (const update of session.mapper.closeOpen("completed")) await send(session, update, true);
      bind(session, row);
      setImmediate(() => void announce(session).catch(() => {}));
      return { configOptions: configOptions(offer, session.selection) };
    })
    .onRequest(methods.agent.session.delete, async ({ params }) => {
      const session = sessions.get(params.sessionId);
      if (session) {
        const seat = session.seat;
        unbind(session);
        sessions.delete(params.sessionId);
        // A session that never spawned, such as a client's probe, has no run to hide. One whose first
        // spawn is pending hides the seat once the manager answers.
        const run = seat ?? (await session.spawning?.catch(() => undefined));
        if (run) options.hidden.add(run.lifecycleUid);
        return {};
      }
      const m = await mesh();
      const listed = await m.seats();
      const rows = listed.rows.filter((row) => row.name === params.sessionId);
      if (rows.length === 0 && listed.silent.length > 0) throw notListed(params.sessionId, listed.silent);
      for (const row of rows) options.hidden.add(row.lifecycleUid);
      return {};
    });

  app.onConnect((connection) => {
    void connection.closed.finally(async () => {
      stopFollowing?.();
      for (const s of sessions.values()) if (s.turn) s.turn.fail(new Error("the client disconnected"));
      if (opened) await (await opened.catch(() => undefined))?.close();
    });
  });
  return app;
}
