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
 * run it starts, so that prompt answers when the seat stops working: its presence is not
 * `working` and no run that started after the text was typed is open. A seat that does not start
 * working soon after ends the prompt too. A manager that refuses the text fails the prompt with its
 * reason.
 *
 * Every update of a turn is sent before the prompt answers. A client may drop updates that arrive
 * after a prompt settled, so nothing is left to send afterwards.
 *
 * The questions a seat stops to ask during a turn are asked in the thread, and the seat's own
 * commands and skills are offered beside the session's commands.
 *
 * A thread that spawns a seat, or opens one with `/open`, stores a link from its id to the seat's
 * run. The list names a linked seat by its thread, and a load resolves a thread through its link
 * before it looks for a seat of that name, so a thread whose seat has another name (`/name` before
 * the first prompt, or `/open`) reopens on it.
 */
import { randomBytes } from "node:crypto";
import { realpathSync } from "node:fs";
import { AGENT_CMD_COMMAND, AGENT_CMD_COMMANDS, AGENT_CMD_INTERRUPT, type AgentPrompt, type CommandEntry, type CommandsOutput } from "@cotal-ai/core";
import { agent, methods, PROTOCOL_VERSION, RequestError, type AgentApp, type AgentContext, type AvailableCommand, type ClientCapabilities, type DeleteSessionRequest, type ListSessionsRequest, type LoadSessionRequest, type NewSessionRequest, type PromptRequest, type SessionUpdate, type SetSessionConfigOptionRequest, type StopReason } from "@agentclientprotocol/sdk";
import { TERMINAL_AUTH } from "./auth-method.js";
import { FrameMapper, type RunSignal } from "./frames.js";
import { answer, permissionRequest, plainOptions, PromptFollower } from "./prompts.js";
import { deregisterRemedy, LaunchListsRefused, NoLaunchManager, SignInRequired, type ManagerChoice, type Mesh, type SeatFrame, type SeatList, type SeatRef, type SeatRow } from "./mesh.js";
import { awaitTaken, promptParts, takeTurn, usageUpdate } from "./turns.js";
import { applyOption, configOptions, cutShort, modelState, DEFAULT_PERSONA, DEFAULT_VARIANT, defaultManager, initialSelection, NO_CHANNEL, noMachine, parseModel, reconcile, refusal, type Offer, type Selection } from "./options.js";

/** The slash commands every session offers. */
export const COMMANDS = [
  { name: "name", description: "Name this session's agent: before the first prompt, the name it starts with; after, the name it shows.", input: { hint: "new name" } },
  { name: "open", description: "Drive an agent that is already running from this session.", input: { hint: "agent name" } },
  { name: "despawn", description: "Stop this session's agent. The session stays, and the reply says whether a new prompt can start another." },
  { name: "roster", description: "List who is on the mesh and what each is doing." },
  { name: "channels", description: "List the space's channels." },
] as const;

/** The commands that pick a choice the thread's select cuts short. They set what the agent starts
 *  with, so a thread offers them only while it has no agent, and never shadows a running agent's own
 *  command of the same name. */
const LAUNCH_COMMANDS = [
  { name: "persona", configId: "persona", description: "Pick the persona this session's agent starts with, by its name in the manager's catalog.", input: { hint: "persona name" } },
  { name: "join", configId: "channel", description: "Pick the channel this session's agent joins when it starts, by its name.", input: { hint: "channel name" } },
] as const;

/** The launch commands a session offers now: those of a list its select cuts short, while it has no
 *  agent and may start one. */
function launchCommands(session: Session): (typeof LAUNCH_COMMANDS)[number][] {
  if (session.seat || session.offer.seatOnly) return [];
  return LAUNCH_COMMANDS.filter((c) => cutShort(c.configId === "persona" ? session.offer.personas : session.offer.channels));
}

/** How long a seat may be absent from the roster during a turn before the turn fails. */
const ABSENT_MS = 20_000;
const WATCH_MS = 250;
/** How long a later prompt waits for the seat to start working on it. */
export const START_MS = 30_000;
/** How long a seat must stay stopped, with no run open, before a later prompt answers. Presence and
 *  the last frames travel separately, so this lets the last frames arrive first. */
export const SETTLE_MS = 2_000;
/** How long a seat spawned for a prompt with images may take to serve its agent endpoint, which
 *  carries the images. */
const SERVE_MS = 20_000;
/** How long a prompt's answer waits for the seat's usage after its turn. A client such as T3 Code
 *  files a turn's usage only when it arrives before the prompt answers; a later one still goes. */
const USAGE_MS = 3_000;
/** Frames from a seat no session holds are kept this long, in case a spawn reply names it next. */
const UNCLAIMED_MS = 120_000;
const UNCLAIMED_FRAMES = 500;

/** The seat runs `session/delete` hid, by lifecycle UID. A delete hides one run and never stops it;
 *  a later seat under the same name lists again. */
export interface HiddenSessions {
  read(): ReadonlySet<string>;
  add(lifecycleUid: string): void;
}

/** One link from a thread to the seat run it drives. */
export interface ThreadLink {
  readonly thread: string;
  readonly lifecycleUid: string;
}

/** The links threads stored in each space, in the order they were stored. A thread's last link is the
 *  one that holds. */
export interface ThreadLinks {
  read(space: string): readonly ThreadLink[];
  add(space: string, link: ThreadLink): void;
}

export interface CotalAgentOptions {
  /** Opens the space on first use. A failure here is reported on the request that needed it. */
  readonly mesh: () => Promise<Mesh>;
  readonly hidden: HiddenSessions;
  readonly links: ThreadLinks;
  readonly log: (line: string) => void;
  readonly version: string;
  /** Whether the terminal action can sign in to the selected space or set one up. */
  readonly canSignIn?: () => Promise<boolean>;
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
  /** Runs that start at or after this time belong to the prompt. For a prompt the seat queued, the
   *  last time it was seen still waiting. */
  after: number;
  /** The run that answers a `run` prompt, once it started. */
  runId?: string;
  /** The runs that started at or after `after`, with when each started. One that fails fails the
   *  prompt. */
  readonly runs: Map<string, number>;
  /** Until an `idle` prompt's `start` resolved: the runs that failed meanwhile. Whether one was the
   *  prompt's own shows only once the seat took it. */
  waiting?: Map<string, Error>;
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
  /** The name the thread's next spawn gives its seat, as `/name` set it. Absent: the session's id. */
  name?: string;
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
  /** The manager that held the agent a loaded thread opened with, as the load described it. It stays a
   *  Machine choice, and is not described again. */
  held?: ManagerChoice;
  /** The seat's open prompts, followed while the thread drives the seat and asked while a turn runs. */
  prompts?: PromptFollower;
  /** The commands and skills the seat runs, as its last `commands` listed them. */
  agentCommands?: CommandEntry[];
}

/** The application a session's seat runs, as its model choice names it. */
const harnessOf = (session: Session): string => parseModel(session.selection.model).agent;

const principal = (p: { owner: string; actor: string }): string => `${p.owner}.${p.actor}`;

/** Each thread's current run, and the thread each run is linked from, of the links in one space. */
function linksIn(store: ThreadLinks, space: string): { byThread: Map<string, string>; byRun: Map<string, string> } {
  const links = store.read(space);
  const byThread = new Map<string, string>();
  for (const link of links) byThread.set(link.thread, link.lifecycleUid);
  const byRun = new Map<string, string>();
  for (const link of links) if (byThread.get(link.thread) === link.lifecycleUid) byRun.set(link.lifecycleUid, link.thread);
  return { byThread, byRun };
}

/** The seats a thread id names: the run its link names, else the seats listed under that name. */
function threadRows(store: ThreadLinks, m: Mesh, listed: SeatList, thread: string): SeatRow[] {
  const run = linksIn(store, m.space).byThread.get(thread);
  const linked = run === undefined ? [] : listed.rows.filter((row) => row.lifecycleUid === run);
  return linked.length > 0 ? linked : listed.rows.filter((row) => row.name === thread);
}

/** A seat no manager listed. When a manager did not answer, the seat may run there, so that is the
 *  answer, not that the seat does not exist. On a space where people sign in, a registration of the
 *  person's whose computer is gone stays listed, so the answer says how to remove those. */
function notListed(m: Mesh, name: string, listed: SeatList): RequestError {
  const { silent, removable = [] } = listed;
  if (silent.length === 0) return RequestError.resourceNotFound(name);
  return RequestError.internalError(undefined, `${name} was not listed, and ${silent.length === 1 ? "manager" : "managers"} ${silent.join(", ")} did not answer, so it may run there. Try again once ${silent.length === 1 ? "it answers" : "they answer"}.${removable.length ? ` ${deregisterRemedy(m.space, removable)}` : ""}`);
}

function canonical(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

export function defaultName(): string {
  // Lowercase base32 keeps the name a valid user-mode actor token.
  const alphabet = "abcdefghijklmnopqrstuvwxyz234567";
  return `acp_${Array.from(randomBytes(10), (b) => alphabet[b & 31]).join("")}`;
}

/** What every handler shares: the sessions, the space connection and the routing of frames. */
interface Bridge {
  readonly options: CotalAgentOptions;
  readonly sessions: Map<string, Session>;
  readonly send: (session: Session, update: SessionUpdate, replay?: boolean) => Promise<void>;
  readonly mesh: () => Promise<Mesh>;
  readonly bind: (session: Session, seat: SeatRef, m: Mesh) => void;
  readonly unbind: (session: Session) => void;
  /** The session here that holds a seat, if any. */
  readonly holder: (seat: SeatRef) => Session | undefined;
  readonly sessionOf: (id: string) => Session;
  readonly announce: (session: Session) => Promise<void>;
  /** Send the seat's context usage, when its connector reports it. Resolves once it is sent, or
   *  after {@link USAGE_MS} while it is still being read; never rejects. */
  readonly reportUsage: (session: Session, m: Mesh) => Promise<void>;
  /** What the client said it can do when it initialized. */
  readonly client: { capabilities?: ClientCapabilities };
  /** Fails the running prompts and closes the space, once the client disconnected. */
  readonly close: () => Promise<void>;
}

function bridge(options: CotalAgentOptions): Bridge {
  const sessions = new Map<string, Session>();
  const byPrincipal = new Map<string, Session>();
  const unclaimed = new Map<string, { at: number; frames: SeatFrame[] }>();
  let opened: Promise<Mesh> | undefined;
  let stopFollowing: (() => void) | undefined;
  const client: Bridge["client"] = {};

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
      turn.runs.set(run.runId, run.ts);
      turn.started = true;
      turn.runId ??= run.runId;
      return;
    }
    if (!turn.runs.has(run.runId)) return;
    if (run.outcome === "error") {
      const failed = new Error(`${session.seat?.name ?? session.id}'s turn failed${run.message ? `: ${run.message}` : ""}`);
      if (turn.waiting) turn.waiting.set(run.runId, failed);
      else turn.fail(failed);
    } else if (turn.until === "run" && run.runId === turn.runId) turn.stop("end_turn");
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

  const bind = (session: Session, seat: SeatRef, m: Mesh): void => {
    session.seat = seat;
    session.prompts?.stop();
    const ask = (p: AgentPrompt) => askPrompt({ options, send, client }, session, m, p);
    session.prompts = new PromptFollower(m, seat, ask, (line) => options.log(`session ${session.id}: ${line}`), () => session.turn !== undefined, WATCH_MS);
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
    session.prompts?.stop();
    session.prompts = undefined;
    session.agentCommands = undefined;
  };

  const holder = (seat: SeatRef): Session | undefined => byPrincipal.get(principal(seat));

  const sessionOf = (id: string): Session => {
    const s = sessions.get(id);
    if (!s) throw RequestError.sessionNotFound(id);
    return s;
  };

  /** Offer the session's commands, and the seat's own where it serves them. A skill is named with a
   *  leading `$`, which clients such as T3 Code show as a skill. A seat command that shares a name
   *  with a session command is not offered. */
  const announce = async (session: Session): Promise<void> => {
    const seat = session.seat;
    const m = seat ? await opened?.catch(() => undefined) : undefined;
    session.agentCommands = undefined;
    if (seat && m) {
      try {
        const out = (await m.agentCall(seat, AGENT_CMD_COMMANDS, {})) as CommandsOutput;
        if (out.supported) session.agentCommands = out.commands.filter((c) => !COMMANDS.some((own) => own.name === c.name));
      } catch (e) {
        options.log(`session ${session.id}: ${seat.name}'s commands not read: ${(e as Error).message}`);
      }
    }
    const theirs: AvailableCommand[] = (session.agentCommands ?? []).map((c) => ({
      name: c.target === "skill" ? "$" + c.name : c.name,
      description: c.description ?? (c.target === "skill" ? `${c.name} skill` : `/${c.name}`),
      ...(c.inputHint ? { input: { hint: c.inputHint } } : {}),
    }));
    const launch = launchCommands(session).map(({ name, description, input }) => ({ name, description, input }));
    await send(session, { sessionUpdate: "available_commands_update", availableCommands: [...COMMANDS.map((c) => ({ ...c })), ...launch, ...theirs] });
  };

  const reportUsage = async (session: Session, m: Mesh): Promise<void> => {
    const seat = session.seat;
    if (!seat) return;
    const sent = usageUpdate(m, seat)
      .then((u) => (u && session.seat === seat ? send(session, u) : undefined))
      .catch((e: Error) => options.log(`session ${session.id}: ${seat.name}'s usage not read: ${e.message}`));
    let timer: NodeJS.Timeout | undefined;
    await Promise.race([sent, new Promise<void>((r) => { timer = setTimeout(r, USAGE_MS); })]).finally(() => clearTimeout(timer));
  };

  const close = async (): Promise<void> => {
    stopFollowing?.();
    for (const s of sessions.values()) {
      s.prompts?.stop();
      if (s.turn) s.turn.fail(new Error("the client disconnected"));
    }
    if (opened) await (await opened.catch(() => undefined))?.close();
  };
  return { options, sessions, send, mesh, bind, unbind, holder, sessionOf, announce, reportUsage, close, client };
}

function launchOffers(options: CotalAgentOptions) {
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

  /** The managers a new agent may start on. When none may, this machine's manager is started and the
   *  list read again, and `onStart` gets the line the thread shows. */
  const launchManagers = async (m: Mesh, onStart: (line: string) => void): Promise<ManagerChoice[]> => {
    try {
      return await m.managers();
    } catch (e) {
      if (!(e instanceof NoLaunchManager)) throw e;
      onStart(await m.startManager());
      return m.managers();
    }
  };

  /** The launch lists of the manager a thread starts on. A loaded thread passes the manager that
   *  `held` its agent: it stays a choice, and the thread opens while no manager may start a new one.
   *  The load passes its id; a later change passes the choice the load described. */
  const offerFor = async (m: Mesh, machine?: string, held?: string | ManagerChoice, onStart: (line: string) => void = () => {}): Promise<Offer> => {
    const heldId = typeof held === "string" ? held : held?.instanceId;
    const listed = heldId === undefined ? await launchManagers(m, onStart) : await m.managers().catch((e: unknown) => {
      if (!(e instanceof NoLaunchManager)) throw e;
      return [];
    });
    const managers = heldId === undefined || listed.some((x) => x.instanceId === heldId) ? listed : [...listed, typeof held === "string" ? await m.manager(held) : held!];
    // Read the lists of the manager a new session starts on, never whichever the exchange picks. With
    // none chosen, show a live one's lists until the Machine option names one.
    const from = machine ?? (defaultManager(managers) ?? managers.find((x) => x.live) ?? managers[0])?.instanceId;
    const [catalogs, personas, channels] = await Promise.all([m.catalogs(from), m.personas(from), m.channels()]);
    if (cutShort(personas)) options.log(`the persona catalog holds ${personas.length} personas, more than a client select shows; the persona select offers your own, and /persona picks any`);
    if (cutShort(channels)) options.log(`the space holds ${channels.length} channels, more than a client select shows; the channel select offers the described and busiest, and /join picks any`);
    return { catalogs, personas, channels, managers, defaultAgent: catalogs.find((c) => c.agent === m.defaultAgent)?.agent };
  };

  /** What a thread that drives a running seat opens with: the launch lists of the seat's manager, or
   *  only the seat's own model when the caller may not read them, with the seat's model selected. A
   *  person whose grant does not let them spawn may not read the lists; their thread controls the
   *  agent they have and offers nothing to launch. */
  const seatThread = async (m: Mesh, row: SeatRow): Promise<Pick<Session, "offer" | "selection" | "held">> => {
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
    const held = row.managerInstanceId ? offer.managers.find((x) => x.instanceId === row.managerInstanceId) : undefined;
    const selection = { ...initialSelection(offer), model: `${row.agent}/${row.model ?? "default"}`, ...(row.managerInstanceId ? { machine: row.managerInstanceId } : {}) };
    return { offer, selection, ...(held ? { held } : {}) };
  };
  return { seatOffer, offerFor, seatThread, launchManagers };
}

type Offers = ReturnType<typeof launchOffers>;

/** How one turn waits: `startMs` overrides how long the seat may take to start working, and `quiet`
 *  ends a turn the seat never started without the note that it has the prompt. */
interface TurnWait {
  readonly startMs?: number;
  readonly quiet?: boolean;
}

/** Ask one of the seat's prompts in the thread and send the answer back. A form goes to a client
 *  that takes forms; anything else is a permission request. A request the client cancels, as when
 *  the turn is stopped, is not answered. */
async function askPrompt(b: Pick<Bridge, "options" | "send" | "client">, session: Session, m: Mesh, prompt: AgentPrompt): Promise<void> {
  const seat = session.seat;
  if (!seat) return;
  const { content } = prompt;
  const formOption = content.form ? content.options.find((o) => o.form === "required" && o.note !== "required") : undefined;
  if (content.form && formOption && b.client.capabilities?.elicitation?.form) {
    const reply = await session.client.request(methods.client.elicitation.create, {
      sessionId: session.id,
      mode: "form",
      message: permissionRequest(session.id, seat.name, harnessOf(session), prompt).toolCall.title ?? content.title,
      requestedSchema: content.form.schema,
      ...(content.source?.toolCallId ? { toolCallId: content.source.toolCallId } : {}),
    });
    const plain = plainOptions(prompt);
    const option = reply.action === "accept" ? formOption : plain.find((o) => o.effect === (reply.action === "decline" ? "refuse" : "cancel")) ?? plain.find((o) => o.effect !== "proceed");
    if (!option) return;
    const values = reply.action === "accept" && "content" in reply && reply.content ? (reply.content as Record<string, unknown>) : undefined;
    b.options.log(`session ${session.id}: ${seat.name}'s prompt ${prompt.id} answered ${option.id}: ${await answer(m, seat, prompt, option.id, option === formOption ? values ?? {} : undefined)}`);
    return;
  }
  const request = permissionRequest(session.id, seat.name, harnessOf(session), prompt, session.cwd);
  if (request.options.length === 0) {
    await b.send(session, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: `${seat.name} asks "${content.title}", which can be answered only at its terminal.` } })
      .catch((e: Error) => b.options.log(`session ${session.id}: update not sent: ${e.message}`));
    return;
  }
  const reply = await session.client.request(methods.client.session.requestPermission, request);
  if (reply.outcome.outcome !== "selected") return;
  b.options.log(`session ${session.id}: ${seat.name}'s prompt ${prompt.id} answered ${reply.outcome.optionId}: ${await answer(m, seat, prompt, reply.outcome.optionId)}`);
}

/** What a turn owns once its `start` resolved, with the time a queued prompt was taken when it was one:
 *  only the runs that started after that time. Returns the failure of one of them that failed before,
 *  if any. */
function taken(turn: Turn, since: number | void): Error | undefined {
  if (since !== undefined) {
    turn.after = since;
    for (const [id, ts] of turn.runs) if (ts < since) turn.runs.delete(id);
    turn.started = turn.runs.size > 0;
  }
  const failed = [...(turn.waiting ?? [])].find(([id]) => turn.runs.has(id))?.[1];
  turn.waiting = undefined;
  return failed;
}

function turnRunner(b: Bridge, startMs: number, settleMs: number) {
  const { options, send } = b;
  const say = (session: Session, line: string): Promise<void> =>
    send(session, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: line } }).catch((e: Error) => options.log(`session ${session.id}: update not sent: ${e.message}`));

  /** Run one turn to its end. Every update is sent before this resolves. A `run` prompt belongs to the
   *  seat's first run. An `idle` prompt's runs are the ones that start once `start` is called, so a
   *  run that starts and ends before `start` resolves still counts. A `start` that resolves with a
   *  time gave the seat a queued prompt, which owns only the runs that start after that time; until it
   *  resolves, a cancel aborts its signal. */
  const runTurn = (session: Session, m: Mesh, until: Turn["until"], start: (signal: AbortSignal) => Promise<number | void>, wait: TurnWait = {}): Promise<StopReason> =>
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
      let begun = false;
      const queued = new AbortController();
      // One path, read once from the seat's presence: the endpoint's `interrupt` where the seat says
      // it serves it now, else the manager's interrupt key.
      const interrupt = (): void => {
        const seat = session.seat;
        if (!seat) return;
        const stopping = m.served(seat)?.interrupt ? m.agentCall(seat, AGENT_CMD_INTERRUPT, {}) : m.interrupt(seat);
        stopping.then(() => {
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
        // A fresh seat's first run answers its kickoff prompt, whatever its clock says.
        after: until === "run" ? 0 : Date.now(),
        runs: new Map(),
        ...(until === "idle" ? { waiting: new Map() } : {}),
        started: false,
        lastSeen: Date.now(),
        stop: (reason) => turn.cancelled !== undefined ? finish("failed", () => resolve("cancelled")) : finish("completed", () => resolve(reason)),
        fail: (error) => turn.cancelled !== undefined ? finish("failed", () => resolve("cancelled")) : finish("failed", () => reject(RequestError.internalError(undefined, error.message))),
        cancel: () => {
          if (turn.cancelled !== undefined) return;
          turn.cancelled = "requested";
          // A cancel that beats the spawn reply or the typed prompt interrupts once that lands. One
          // whose prompt waits in the seat's queue takes it out of the queue.
          if (begun) interrupt();
          else queued.abort();
        },
      };
      session.turn = turn;
      turn.timer = setInterval(() => {
        const seat = session.seat;
        if (!seat) return;
        const now = Date.now();
        if (typeof turn.cancelled === "number") {
          // Connectors end an interrupted run differently or not at all, so wait briefly for it.
          const running = [...turn.runs.keys()].some((id) => session.open.has(id));
          if (!running || now - turn.cancelled >= settleMs) turn.stop("cancelled");
          return;
        }
        if (turn.cancelled === "requested") return;
        const status = m.presence(seat);
        if (status === undefined) {
          if (now - turn.lastSeen > ABSENT_MS) turn.fail(new Error(`${seat.name} left the mesh during its turn`));
          return;
        }
        turn.lastSeen = now;
        // Settle only once the prompt was typed, so a refusal still fails the prompt.
        if (until !== "idle" || !begun) return;
        // An ask still open in the client holds the turn, so the request stays within it.
        const asking = session.prompts?.pending === true;
        if (status === "working" || asking) turn.started = true;
        if (!turn.started) {
          if (now - turn.after > (wait.startMs ?? startMs)) {
            clearInterval(turn.timer);
            if (wait.quiet) return turn.stop("end_turn");
            void say(session, `${seat.name} has the prompt but has not started on it yet.`).finally(() => turn.stop("end_turn"));
          }
          return;
        }
        const running = [...turn.runs.keys()].some((id) => session.open.has(id));
        if (status === "working" || running || asking) turn.quietSince = undefined;
        else if (now - (turn.quietSince ??= now) >= settleMs) turn.stop("end_turn");
      }, WATCH_MS);
      start(queued.signal).then((since) => {
        const failed = taken(turn, since);
        begun = true;
        if (failed) turn.fail(failed);
        else if (turn.cancelled === "requested") interrupt();
      }, (e: Error) => turn.fail(e));
    });
  return runTurn;
}

/** The seat command or skill a prompt runs: `/<name> <args>` for a command, `$<name> <args>` for a
 *  skill, when the seat listed it. */
export function seatCommand(commands: readonly CommandEntry[] | undefined, text: string): { entry: CommandEntry; args: string } | undefined {
  const match = /^([/$])(\S+)\s*(.*)$/s.exec(text);
  if (!match || !commands) return undefined;
  const target = match[1] === "$" ? "skill" : "command";
  const entry = commands.find((c) => c.target === target && c.name === match[2]);
  return entry ? { entry, args: match[3]!.trim() } : undefined;
}

function slashCommands(b: Bridge, offers: Offers, runTurn: ReturnType<typeof turnRunner>, settleMs: number) {
  const { send, unbind } = b;
  const name = nameCommand(b);
  const open = openCommand(b, offers);
  const choose = chooseCommand(b);

  /** Queue a seat command and wait until the seat started it, as {@link awaitTaken} does. */
  const queue = async (m: Mesh, seat: SeatRef, entry: CommandEntry, args: string, signal: AbortSignal): Promise<number> => {
    const label = entry.target === "skill" ? `the ${entry.name} skill` : `/${entry.name}`;
    const since = Date.now();
    const { id } = (await m.agentCall(seat, AGENT_CMD_COMMAND, { target: entry.target, name: entry.name, ...(args ? { args } : {}) })) as { id: string };
    return awaitTaken(m, seat, id, label, since, signal);
  };

  const slash = async (session: Session, m: Mesh, text: string): Promise<StopReason | undefined> => {
    const say = (line: string) => send(session, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: line } });
    // A seat that has not listed its commands yet, such as one that just started, is asked first.
    if (session.seat && session.agentCommands === undefined && /^[/$]\S/.test(text)) await b.announce(session);
    const theirs = session.seat ? seatCommand(session.agentCommands, text) : undefined;
    if (theirs && session.seat) {
      const seat = session.seat;
      b.options.log(`session ${session.id}: ${seat.name} runs its ${theirs.entry.target} ${theirs.entry.name}`);
      // A command that runs no turn, such as one that clears the session, ends its prompt soon.
      return runTurn(session, m, "idle", (signal) => queue(m, seat, theirs.entry, theirs.args, signal), { startMs: settleMs * 2, quiet: true }).then(async (stop) => {
        await b.reportUsage(session, m);
        return stop;
      }, async (e: Error) => {
        await say(e.message);
        return "end_turn" as const;
      });
    }
    const match = /^\/([a-z]+)\b\s*(.*)$/s.exec(text);
    const launch = match && launchCommands(session).find((c) => c.name === match[1]);
    if (launch) {
      await say(await choose(session, launch.configId, match[2]!.trim()));
      return "end_turn";
    }
    if (!match || !COMMANDS.some((c) => c.name === match[1])) return undefined;
    const arg = match[2]!.trim();
    switch (match[1]) {
      case "name":
        await say(await name(session, m, arg));
        return "end_turn";
      case "open":
        await say(await open(session, m, arg));
        return "end_turn";
      case "despawn": {
        if (text !== "/despawn") return undefined;
        if (!session.seat) {
          await say("This session has no agent running.");
          return "end_turn";
        }
        const seat = session.seat;
        await m.despawn(seat);
        unbind(session);
        // The seat's commands go, and the launch commands return for the next agent.
        void b.announce(session).catch(() => {});
        await say(session.offer.seatOnly ? `Stopped ${seat.name}. Starting another agent here needs a grant that may spawn.` : `Stopped ${seat.name}. A new prompt spawns a fresh agent.`);
        return "end_turn";
      }
      case "roster": {
        const rows = await m.roster();
        await say(rows.length ? rows.map((r) => `- ${r.name}${r.role ? ` (${r.role})` : ""}: ${r.status}${r.activity ? `, ${r.activity}` : ""}`).join("\n") : "Nobody is on the mesh.");
        return "end_turn";
      }
      case "channels": {
        const rows = await m.channels();
        await say(rows.length ? rows.map((c) => `- #${c.channel}`).join("\n") : "The space has no channels.");
        return "end_turn";
      }
    }
    return undefined;
  };
  return slash;
}

/** `/name`: before the first prompt, the name the thread's spawn gives its seat; on a running seat, the
 *  name it shows. Answers with the line the thread shows. */
function nameCommand(b: Bridge) {
  return async (session: Session, m: Mesh, want: string): Promise<string> => {
    const seat = session.seat;
    if (!want) return seat ? `This session's agent is ${seat.name}. Rename it with /name <new name>.` : `This session's agent will start as ${session.name ?? session.id}. Pick another name with /name <new name>.`;
    if (session.spawning) return "The agent is starting. Name it once it has started.";
    if (!seat) {
      const why = m.spawnNameError(want);
      if (why) return `The agent cannot start as ${want}: ${why}.`;
      session.name = want;
      return `This session's agent will start as ${want}.`;
    }
    try {
      return `${seat.name} now shows as ${await m.rename(seat, want)}.`;
    } catch (e) {
      b.options.log(`session ${session.id}: rename refused: ${(e as Error).message}`);
      return `Could not rename ${seat.name}: ${(e as Error).message}`;
    }
  };
}

/** `/persona <name>` and `/join <channel>`: set the persona or channel the thread's agent starts
 *  with, by exact name, checked against the whole list as the select's own choice is, and send the
 *  options holding it. Answers with the line the thread shows. */
function chooseCommand(b: Bridge) {
  const persona = (p: string) => (p === DEFAULT_PERSONA ? "the default persona" : `persona ${p}`);
  const channel = (c: string) => (c === NO_CHANNEL ? "no channel" : `#${c}`);
  return async (session: Session, configId: "persona" | "channel", want: string): Promise<string> => {
    if (!want)
      return configId === "persona"
        ? `This session's agent starts with ${persona(session.selection.persona)}. Pick another with /persona <name>.`
        : `This session's agent joins ${channel(session.selection.channel)} when it starts. Pick one with /join <channel>.`;
    try {
      session.selection = applyOption(session.offer, session.selection, configId, want);
    } catch (e) {
      const why = (e as Error).message;
      return `${why[0]!.toUpperCase()}${why.slice(1)}.`;
    }
    await b.send(session, { sessionUpdate: "config_option_update", configOptions: configOptions(session.offer, session.selection) });
    return configId === "persona"
      ? `This session's agent will start with ${persona(session.selection.persona)}.`
      : `This session's agent will join ${channel(session.selection.channel)} when it starts.`;
  };
}

/** `/open <name>`: in a thread with no agent, drive the running seat with that name or display name.
 *  The thread shows what the space retains of the seat, then follows it live, and its link is stored
 *  so the thread reopens on that seat. Answers with the line the thread shows. */
function openCommand(b: Bridge, offers: Offers) {
  const { options, send, bind, unbind, holder } = b;
  return async (session: Session, m: Mesh, want: string): Promise<string> => {
    if (!want) return "Name the agent to open: /open <name>.";
    const current = session.seat?.name ?? (session.spawning ? session.name ?? session.id : undefined);
    if (current) return `This session already drives ${current}. Open ${want} in a new session.`;
    const listed = await m.seats();
    const exact = listed.rows.filter((row) => row.name === want);
    const lower = want.toLowerCase();
    const rows = exact.length > 0 ? exact : listed.rows.filter((row) => row.name.toLowerCase() === lower || row.display?.toLowerCase() === lower);
    if (rows.length === 0) return listed.silent.length > 0 ? notListed(m, want, listed).message : `No agent named ${want} is running.`;
    if (rows.length > 1) return `${rows.length} agents are named ${want} (${rows.map((row) => row.name).join(", ")}). Open one by the name its manager lists.`;
    const row = rows[0]!;
    const opened = await offers.seatThread(m, row);
    const other = holder(row);
    if (other && other !== session) unbind(other);
    Object.assign(session, opened, { mapper: new FrameMapper(row.agent, row.cwd), open: new Map() });
    const replay = [...(await m.frameHistory(row)).flatMap((frame) => session.mapper.map(frame).updates), ...session.mapper.closeOpen("completed")];
    for (const update of replay) await send(session, update);
    bind(session, row, m);
    options.links.add(m.space, { thread: session.id, lifecycleUid: row.lifecycleUid });
    void b.announce(session).catch(() => {});
    void b.reportUsage(session, m);
    // A client joins consecutive message chunks into one message, so the line keeps clear of the replay.
    return `${replay.length > 0 ? "\n\n" : ""}This session now drives ${row.display ?? row.name} (${row.agent}${row.model ? ` ${row.model}` : ""}). A prompt here reaches it as your own words.`;
  };
}

/** The handlers that open a thread, change its options and run its prompts. */
function threadHandlers(b: Bridge, offers: Offers, runTurn: ReturnType<typeof turnRunner>, slash: ReturnType<typeof slashCommands>, newName: () => string) {
  const { options, sessions, send, mesh, bind, sessionOf, announce, reportUsage } = b;
  const { offerFor, launchManagers } = offers;
  /** Show a line in the thread once the current reply is out, so a new thread's client knows its id. */
  const tell = (session: Session) => (line: string): void => {
    setImmediate(() => void send(session, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: line } }).catch((e: Error) => options.log(`session ${session.id}: update not sent: ${e.message}`)));
  };
  return {
    newSession: async (params: NewSessionRequest, client: AgentContext) => {
      const m = await mesh();
      let started: string | undefined;
      const offer = await offerFor(m, undefined, undefined, (line) => (started = line)).catch((e: unknown) => {
        // ACP clients display the message, not necessarily the error data.
        if (e instanceof NoLaunchManager) throw new RequestError(-32603, e.message);
        throw e;
      });
      const id = newName();
      const session: Session = { id, cwd: params.cwd, offer, selection: initialSelection(offer), mapper: new FrameMapper(), open: new Map(), client };
      sessions.set(id, session);
      setImmediate(() => void announce(session).catch(() => {}));
      if (started) tell(session)(started);
      return { sessionId: id, configOptions: configOptions(offer, session.selection), models: modelState(offer, session.selection) };
    },
    setConfigOption: async (params: SetSessionConfigOptionRequest) => {
      const session = sessionOf(params.sessionId);
      if (!("value" in params) || typeof params.value !== "string") throw RequestError.invalidParams(undefined, `option "${params.configId}" takes a select value`);
      // A thread that cannot start another agent has nothing a changed option would apply to.
      const fixed = `${session.id} opened without a grant that may spawn, so its options cannot change`;
      if (session.seat) throw RequestError.invalidParams(undefined, session.offer.seatOnly ? fixed : `${session.seat.name} is already running; ${params.configId} applies to a new agent, after /despawn`);
      let next: Selection;
      try {
        next = applyOption(session.offer, session.selection, params.configId, params.value);
      } catch (e) {
        throw RequestError.invalidParams(undefined, (e as Error).message);
      }
      if (session.offer.seatOnly && JSON.stringify(next) !== JSON.stringify(session.selection)) throw RequestError.invalidParams(undefined, fixed);
      if (next.machine !== session.selection.machine) {
        const m = await mesh();
        const offer = await offerFor(m, next.machine, session.held, tell(session));
        try {
          next = reconcile(offer, next);
        } catch (e) {
          throw RequestError.invalidParams(undefined, (e as Error).message);
        }
        session.offer = offer;
        // Another manager's catalog can change which lists the select cuts short.
        void announce(session).catch(() => {});
      }
      session.selection = next;
      return { configOptions: configOptions(session.offer, session.selection) };
    },
    prompt: async (params: PromptRequest) => {
      const session = sessionOf(params.sessionId);
      if (session.turn) throw RequestError.invalidRequest(undefined, "a prompt is already running in this session");
      const { text, images } = promptParts(params.prompt);
      const m = await mesh();
      const handled = images.length ? undefined : await slash(session, m, text);
      if (handled) return { stopReason: handled };
      if (!text && !images.length) throw RequestError.invalidParams(undefined, "the prompt is empty");
      const running = session.seat;
      if (running) {
        const stopReason = await runTurn(session, m, "idle", (signal) => takeTurn(m, running, text, images, signal));
        await reportUsage(session, m);
        return { stopReason };
      }
      if (session.offer.seatOnly) throw RequestError.invalidParams(undefined, `${session.id} opened without a grant that may spawn, so this thread cannot start another agent`);
      if (!session.selection.machine) throw new RequestError(-32602, noMachine(m.space));
      const { agent: harness, model } = parseModel(session.selection.model);
      const why = refusal(session.offer.catalogs, harness);
      const catalog = session.offer.catalogs.find((c) => c.agent === harness);
      if (why) throw RequestError.invalidParams(undefined, why);
      session.mapper = new FrameMapper(harness, session.cwd);
      // Images ride a turn, so a first prompt with images starts the seat with none and gives it the
      // prompt once it takes a turn.
      const stopReason = await runTurn(session, m, images.length ? "idle" : "run", async (signal) => {
        // A thread left open past its manager's idle exit starts it again here.
        await launchManagers(m, tell(session));
        const spawning = m.spawn({
          name: session.name ?? session.id,
          agent: harness,
          ...(model ? { model } : {}),
          ...(session.selection.variant !== DEFAULT_VARIANT ? { variant: session.selection.variant } : {}),
          ...(session.selection.persona !== DEFAULT_PERSONA ? { persona: session.selection.persona } : {}),
          ...(session.selection.channel !== NO_CHANNEL ? { subscribe: [session.selection.channel] } : {}),
          cwd: session.cwd,
          ...(images.length ? {} : { prompt: text }),
          ...(session.selection.machine ? { managerInstanceId: session.selection.machine } : {}),
          ...(catalog?.askPermissions ? { askPermissions: true } : {}),
          ...(catalog?.reasoningEvents ? { reasoningEvents: true } : {}),
        });
        session.spawning = spawning;
        const seat = await spawning.finally(() => (session.spawning = undefined));
        // A session deleted or replaced while the spawn was pending keeps no claim on the seat. A
        // delete hides it.
        if (sessions.get(session.id) !== session) return;
        bind(session, seat, m);
        options.links.add(m.space, { thread: session.id, lifecycleUid: seat.lifecycleUid });
        if (!images.length) return;
        // A seat can serve its endpoint before its harness takes turns, as a Claude Code seat does
        // until its command mod connects, so wait for `turn` before the one read that picks the path.
        for (const until = Date.now() + SERVE_MS; !m.served(seat)?.turn; await new Promise((r) => setTimeout(r, WATCH_MS)))
          if (Date.now() > until) throw new Error(`${seat.name} started but does not take a turn on its agent endpoint, so it cannot take the prompt's images`);
        return takeTurn(m, seat, text, images, signal);
      });
      // The seat's own commands can be read once it runs.
      if (session.seat) void announce(session).catch(() => {});
      await reportUsage(session, m);
      return { stopReason };
    },
  };
}

/** The handlers that list, load and delete threads. */
function historyHandlers(b: Bridge, offers: Offers) {
  const { options, sessions, send, mesh, bind, unbind, holder, announce, reportUsage } = b;
  return {
    list: async (params: ListSessionsRequest) => {
      const m = await mesh();
      const want = params.cwd ? canonical(params.cwd) : undefined;
      const hidden = options.hidden.read();
      const { byRun } = linksIn(options.links, m.space);
      const rows = (await m.seats()).rows.filter((row) => !hidden.has(row.lifecycleUid) && (want === undefined || (row.cwd !== undefined && canonical(row.cwd) === want)));
      return {
        sessions: rows.map((row) => ({
          sessionId: byRun.get(row.lifecycleUid) ?? row.name,
          cwd: row.cwd ?? params.cwd ?? "",
          title: `${row.display ?? row.name} (${row.agent}${row.model ? ` ${row.model}` : ""})`,
          ...(row.uptimeMs !== undefined ? { updatedAt: new Date(Date.now() - row.uptimeMs).toISOString() } : {}),
        })),
      };
    },
    load: async (params: LoadSessionRequest, client: AgentContext) => {
      const m = await mesh();
      const listed = await m.seats();
      const matches = threadRows(options.links, m, listed, params.sessionId);
      if (matches.length === 0) throw notListed(m, params.sessionId, listed);
      if (matches.length > 1) throw RequestError.invalidParams(undefined, `${matches.length} seats are named ${params.sessionId}; stop all but one`);
      const row: SeatRow = matches[0]!;
      const session: Session = { id: params.sessionId, cwd: params.cwd, ...(await offers.seatThread(m, row)), mapper: new FrameMapper(row.agent, row.cwd), open: new Map(), client };
      const previous = sessions.get(params.sessionId);
      if (previous) unbind(previous);
      const other = holder(row);
      if (other && other !== previous) unbind(other);
      sessions.set(params.sessionId, session);
      // Replay what the space still holds, then follow live. The mapper drops a frame it already sent.
      for (const frame of await m.frameHistory(row)) {
        const { updates } = session.mapper.map(frame);
        for (const update of updates) await send(session, update, true);
      }
      for (const update of session.mapper.closeOpen("completed")) await send(session, update, true);
      bind(session, row, m);
      setImmediate(() => {
        void announce(session).catch(() => {});
        void reportUsage(session, m);
      });
      return { configOptions: configOptions(session.offer, session.selection), models: modelState(session.offer, session.selection) };
    },
    delete: async (params: DeleteSessionRequest) => {
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
      const rows = threadRows(options.links, m, listed, params.sessionId);
      if (rows.length === 0 && listed.silent.length > 0) throw notListed(m, params.sessionId, listed);
      for (const row of rows) options.hidden.add(row.lifecycleUid);
      return {};
    },
  };
}

export function cotalAgent(options: CotalAgentOptions): AgentApp {
  const b = bridge(options);
  const { sessions } = b;
  const offers = launchOffers(options);
  const settleMs = options.waits?.settleMs ?? SETTLE_MS;
  const runTurn = turnRunner(b, options.waits?.startMs ?? START_MS, settleMs);
  const threads = threadHandlers(b, offers, runTurn, slashCommands(b, offers, runTurn, settleMs), options.newName ?? defaultName);
  const history = historyHandlers(b, offers);
  const app = agent({ name: "cotal" })
    .onRequest(methods.agent.initialize, async ({ params }) => {
      b.client.capabilities = params.clientCapabilities ?? {};
      return {
        protocolVersion: PROTOCOL_VERSION,
        agentInfo: { name: "cotal", title: "Cotal", version: options.version },
        agentCapabilities: {
          loadSession: true,
          promptCapabilities: { image: true, audio: false, embeddedContext: false },
          sessionCapabilities: { list: {}, delete: {} },
        },
        authMethods: params.clientCapabilities?.auth?.terminal && (await options.canSignIn?.() ?? true) ? [TERMINAL_AUTH] : [],
      };
    })
    .onRequest(methods.agent.authenticate, async () => {
      await b.mesh();
      return {};
    })
    .onRequest(methods.agent.session.new, ({ params, client }) => threads.newSession(params, client))
    .onRequest(methods.agent.session.setConfigOption, ({ params }) => threads.setConfigOption(params))
    .onRequest(methods.agent.session.prompt, ({ params }) => threads.prompt(params))
    .onNotification(methods.agent.session.cancel, ({ params }) => {
      sessions.get(params.sessionId)?.turn?.cancel();
    })
    .onRequest(methods.agent.session.list, ({ params }) => history.list(params))
    .onRequest(methods.agent.session.load, ({ params, client }) => history.load(params, client))
    .onRequest(methods.agent.session.delete, ({ params }) => history.delete(params));

  app.onConnect((connection) => {
    void connection.closed.finally(b.close);
  });
  return app;
}
