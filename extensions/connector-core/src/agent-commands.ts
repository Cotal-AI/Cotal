/**
 * An agent's own harness commands and skills on its `agent` endpoint (SPEC 13.22): the `commands`,
 * `command`, `command-cancel`, `command-state` and `interrupt` handlers, and the queue between a
 * `command` request and the connector's next idle turn.
 *
 * A command starts only while no turn runs, which only the connector can see, so the connector takes
 * each queued command with {@link CommandQueue.dispatchNext}.
 */
import { randomBytes } from "node:crypto";
import {
  AGENT_COMMAND_MESSAGE_MAX, AGENT_COMMAND_STATE_DETAIL, AGENT_CONTRACTS, EpEnvelopeError, fitCommandEntries,
  type CommandEntry, type CommandIdInput, type CommandInput, type CommandOutput, type CommandState, type CommandStateOutput, type CommandTarget,
  type CommandsOutput, type EpErrorCode, type EpPrincipalCommandDef, type EpPrincipalServeContext, type FirstCommand, type InterruptOutput,
} from "@cotal-ai/core";

/** A `commands` reply waits at most this long for the harness's list. */
export const COMMAND_LIST_MS = 10_000;
/** How many commands may be queued at once. */
export const MAX_QUEUED_COMMANDS = 8;
/** How many ended commands the agent remembers. An older id is `not-found`. */
export const ENDED_COMMANDS_KEPT = 32;
/** How long a first command waits for a harness that runs no commands yet, such as Claude Code
 *  before its command mod connects. Then it is refused with the harness's cause. */
export const FIRST_COMMAND_READY_MS = 60_000;
const FIRST_COMMAND_POLL_MS = 250;

/** One command a caller asked this agent to run. `args` is empty when the caller sent none. */
export interface AgentCommand {
  readonly target: CommandTarget;
  readonly name: string;
  readonly args: string;
}

/** Lists and starts commands on a connector's harness. */
export interface CommandDispatcher {
  readonly targets: ReadonlySet<CommandTarget>;
  /** Why the harness runs no commands now, or undefined while it does. While it names a cause,
   *  `commands` answers `supported: false`, and `command` and `interrupt` are `unimplemented` with
   *  that cause. Without it, the harness always runs them. */
  unsupported?(): string | undefined;
  /** Every command and skill the harness runs now, each named as {@link dispatch} names it. A
   *  rejection is the caller's error reply. */
  list(): Promise<CommandEntry[]>;
  /** Start the command, resolving once the harness accepted it. A command that runs the model runs as
   *  a turn of its own, and some, such as OpenCode's `goal clear`, run no turn. Throw
   *  {@link CommandRefused} when the harness refused it and nothing started; any other throw leaves
   *  the outcome unknown. */
  dispatch(command: AgentCommand): Promise<void>;
  /** Stop the turn the harness is running, resolving once the harness answered: `interrupted` when it
   *  stopped one, `idle` when none ran. The connector then ends that turn as it ends one its user
   *  stopped, so the next queued command can start. Without it, `interrupt` is `unimplemented`. A
   *  throw leaves the outcome unknown. */
  interrupt?(): Promise<InterruptOutput["state"]>;
}

/** The harness refused a command, and nothing started. */
export class CommandRefused extends Error {
  constructor(readonly code: "not-found" | "failed-precondition", message: string) {
    super(message);
    this.name = "CommandRefused";
  }
}

/** What {@link CommandQueue.dispatchNext} did: nothing was queued, the harness accepted the command,
 *  or it did not. */
export type CommandDispatch = "empty" | "dispatched" | "failed";

/** The connector's side of the queue. */
export interface CommandQueue {
  /** How many commands are queued. */
  readonly queued: number;
  /** Take the oldest queued command and hand it to the dispatcher. It is taken before the dispatch is
   *  awaited, so two calls never take one command. */
  dispatchNext(): Promise<CommandDispatch>;
}

export interface CommandLane extends CommandQueue {
  readonly handlers: EpPrincipalCommandDef[];
  /** Refuse every queued command as `unavailable`, and refuse every later `command`. A taken command
   *  stays taken, and its dispatch still ends it. */
  close(): void;
}

interface Entry {
  readonly id: string;
  readonly command: AgentCommand;
  state: CommandState;
}

const B32 = "abcdefghijklmnopqrstuvwxyz234567";
const refused = (code: EpErrorCode, message: string) => new EpEnvelopeError(code, message, undefined, "not-executed");
const what = (c: AgentCommand) => `the ${c.target} "${c.name}"`;

function cut(text: string, max: number): string {
  const chars = [...text];
  return chars.length <= max ? text : `${chars.slice(0, max - 1).join("")}…`;
}

function within<T>(work: () => Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const late = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`no answer within ${ms / 1000} s`)), ms); });
  return Promise.race([Promise.resolve().then(work), late]).finally(() => clearTimeout(timer));
}

/** `first` is the command the launch handed this agent. It is queued before any other, under the
 *  id its spawn named, and waits until the harness runs commands. */
export function createCommandLane(dispatcher: CommandDispatcher | undefined, onQueued: () => void, first?: FirstCommand): CommandLane {
  // Every command not yet forgotten, in the order it was queued, so the first queued entry is the oldest.
  const entries = new Map<string, Entry>();
  const ended: string[] = [];
  let closed = false;
  // The first command while the harness runs no commands yet. It reads as queued, and the connector
  // is not shown it until the harness runs commands.
  let held: Entry | undefined;

  const queued = (): Entry[] => [...entries.values()].filter((e) => e.state.kind === "queued" && e !== held);
  const known = (id: string): Entry => {
    const e = entries.get(id);
    if (!e) throw refused("not-found", `command ${id} is not known to this agent`);
    return e;
  };
  function end(e: Entry, state: CommandState): void {
    e.state = state;
    ended.push(e.id);
    while (ended.length > ENDED_COMMANDS_KEPT) entries.delete(ended.shift()!);
  }

  async function list(): Promise<CommandsOutput> {
    if (!dispatcher || dispatcher.unsupported?.() !== undefined) return { supported: false };
    let listed: unknown;
    try {
      listed = await within(() => dispatcher.list(), COMMAND_LIST_MS);
    } catch (e) {
      throw refused("unavailable", `the harness did not list its commands: ${(e as Error).message}`);
    }
    return { supported: true, commands: fitCommandEntries(listed, dispatcher.targets) };
  }

  function seed(f: FirstCommand): void {
    const e: Entry = { id: f.id, command: { target: f.target, name: f.name, args: f.args ?? "" }, state: { kind: "queued" } };
    entries.set(e.id, e);
    const refuse = (message: string): void => end(e, { kind: "refused", code: "failed-precondition", message: cut(message, AGENT_COMMAND_MESSAGE_MAX) });
    if (!dispatcher) return refuse("this agent's connector runs no commands or skills");
    if (!dispatcher.targets.has(e.command.target)) return refuse(`this agent's connector runs no ${e.command.target}s`);
    if (dispatcher.unsupported?.() === undefined) return;
    held = e;
    const deadline = Date.now() + FIRST_COMMAND_READY_MS;
    const timer = setInterval(() => {
      const cause = e.state.kind === "queued" ? dispatcher.unsupported?.() : undefined;
      if (cause !== undefined && Date.now() < deadline) return;
      clearInterval(timer);
      held = undefined;
      if (e.state.kind !== "queued") return;
      if (cause === undefined) onQueued();
      else refuse(`the harness ran no commands within ${FIRST_COMMAND_READY_MS / 1000} s: ${cause}`);
    }, FIRST_COMMAND_POLL_MS);
    timer.unref?.();
  }
  if (first) seed(first);

  /** An agent never runs a command on itself or stops its own turn, whatever its row. */
  function notSelf(ctx: EpPrincipalServeContext, what: string): void {
    if (ctx.caller.owner === ctx.principal.owner && ctx.caller.actor === ctx.principal.actor)
      throw refused("permission-denied", `an agent never ${what}`);
  }

  function run(ctx: EpPrincipalServeContext): CommandOutput {
    notSelf(ctx, "runs a command on itself");
    const input = ctx.request.args as unknown as CommandInput;
    if (!dispatcher) throw refused("unimplemented", "this agent's connector runs no commands or skills");
    const cause = dispatcher.unsupported?.();
    if (cause !== undefined) throw refused("unimplemented", `this agent's connector runs no commands now: ${cause}`);
    if (!dispatcher.targets.has(input.target)) throw refused("unimplemented", `this agent's connector runs no ${input.target}s`);
    if (closed) throw refused("unavailable", "this agent is stopping");
    if (queued().length >= MAX_QUEUED_COMMANDS) throw refused("resource-exhausted", `${MAX_QUEUED_COMMANDS} commands are already queued`);
    let id: string;
    do id = Array.from(randomBytes(26), (b) => B32[b & 31]).join(""); while (entries.has(id));
    entries.set(id, { id, command: { target: input.target, name: input.name, args: input.args ?? "" }, state: { kind: "queued" } });
    onQueued();
    return { id };
  }

  async function interrupt(ctx: EpPrincipalServeContext): Promise<InterruptOutput> {
    notSelf(ctx, "interrupts its own turn");
    if (!dispatcher?.interrupt) throw refused("unimplemented", "this agent's connector cannot interrupt a turn");
    const cause = dispatcher.unsupported?.();
    if (cause !== undefined) throw refused("unimplemented", `this agent's connector cannot interrupt a turn now: ${cause}`);
    if (closed) throw refused("unavailable", "this agent is stopping");
    try {
      return { state: await dispatcher.interrupt() };
    } catch (e) {
      throw new EpEnvelopeError("internal", `the harness failed, so the turn may have been interrupted: ${String((e as Error)?.message ?? e)}`, undefined, "unknown");
    }
  }

  function cancel({ id }: CommandIdInput): CommandStateOutput {
    const e = known(id);
    if (e.state.kind === "queued") end(e, { kind: "cancelled" });
    else if (e.state.kind !== "cancelled")
      throw new EpEnvelopeError("conflict", `command ${id} is ${e.state.kind}, so it can no longer be cancelled`,
        [{ kind: AGENT_COMMAND_STATE_DETAIL, state: e.state }], "not-executed");
    return { state: e.state };
  }

  return {
    handlers: [
      { command: "commands", contract: AGENT_CONTRACTS.commands, handler: () => list() },
      { command: "command", contract: AGENT_CONTRACTS.command, handler: (ctx) => run(ctx) },
      { command: "command-cancel", contract: AGENT_CONTRACTS["command-cancel"], handler: (ctx) => cancel(ctx.request.args as unknown as CommandIdInput) },
      { command: "command-state", contract: AGENT_CONTRACTS["command-state"], handler: (ctx) => ({ state: known((ctx.request.args as unknown as CommandIdInput).id).state }) },
      { command: "interrupt", contract: AGENT_CONTRACTS.interrupt, handler: (ctx) => interrupt(ctx) },
    ],
    get queued() {
      return queued().length;
    },
    async dispatchNext() {
      const e = queued()[0];
      if (!e) return "empty";
      e.state = { kind: "taken" };
      try {
        await dispatcher!.dispatch(e.command);
        end(e, { kind: "started" });
        return "dispatched";
      } catch (err) {
        const message = String((err as Error)?.message ?? err);
        end(e, err instanceof CommandRefused
          ? { kind: "refused", code: err.code, message: cut(message, AGENT_COMMAND_MESSAGE_MAX) }
          : { kind: "unknown", code: "internal", message: cut(`the harness failed, so ${what(e.command)} may have started: ${message}`, AGENT_COMMAND_MESSAGE_MAX) });
        return "failed";
      }
    },
    close() {
      closed = true;
      for (const e of entries.values())
        if (e.state.kind === "queued") end(e, { kind: "refused", code: "unavailable", message: `the agent stopped before ${what(e.command)} started` });
    },
  };
}
