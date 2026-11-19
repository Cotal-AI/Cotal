/**
 * An agent's own harness commands and skills on its `agent` endpoint (SPEC 13.22): the `commands`,
 * `command`, `command-cancel` and `command-state` handlers, and the queue between a `command` request
 * and the connector's next idle turn.
 *
 * A command starts only while no turn runs, which only the connector can see, so the connector takes
 * each queued command with {@link CommandQueue.dispatchNext}.
 */
import { randomBytes } from "node:crypto";
import {
  AGENT_COMMAND_DESCRIPTION_MAX, AGENT_COMMAND_INPUT_HINT_MAX, AGENT_COMMAND_LIST_MAX, AGENT_COMMAND_MESSAGE_MAX, AGENT_COMMAND_STATE_DETAIL,
  AGENT_CONTRACTS, EpEnvelopeError, isAgentCommandName,
  type CommandEntry, type CommandIdInput, type CommandInput, type CommandOutput, type CommandState, type CommandStateOutput, type CommandTarget,
  type CommandsOutput, type EpErrorCode, type EpPrincipalCommandDef,
} from "@cotal-ai/core";

/** A `commands` reply waits at most this long for the harness's list. */
export const COMMAND_LIST_MS = 10_000;
/** How many commands may be queued at once. */
export const MAX_QUEUED_COMMANDS = 8;
/** How many ended commands the agent remembers. An older id is `not-found`. */
export const ENDED_COMMANDS_KEPT = 32;

/** One command a caller asked this agent to run. `args` is empty when the caller sent none. */
export interface AgentCommand {
  readonly target: CommandTarget;
  readonly name: string;
  readonly args: string;
}

/** Lists and starts commands on a connector's harness. */
export interface CommandDispatcher {
  readonly targets: ReadonlySet<CommandTarget>;
  /** Every command and skill the harness runs now, each named as {@link dispatch} names it. A
   *  rejection is the caller's error reply. */
  list(): Promise<CommandEntry[]>;
  /** Start the command, resolving once the harness accepted it. A command that runs the model runs as
   *  a turn of its own, and some, such as OpenCode's `goal clear`, run no turn. Throw
   *  {@link CommandRefused} when the harness refused it and nothing started; any other throw leaves
   *  the outcome unknown. */
  dispatch(command: AgentCommand): Promise<void>;
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

function fitText(text: unknown, max: number): string | undefined {
  return typeof text === "string" && text !== "" ? cut(text, max) : undefined;
}

function within<T>(work: () => Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const late = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`no answer within ${ms / 1000} s`)), ms); });
  return Promise.race([Promise.resolve().then(work), late]).finally(() => clearTimeout(timer));
}

export function createCommandLane(dispatcher: CommandDispatcher | undefined, onQueued: () => void): CommandLane {
  // Every command not yet forgotten, in the order it was queued, so the first queued entry is the oldest.
  const entries = new Map<string, Entry>();
  const ended: string[] = [];
  let closed = false;

  const queued = (): Entry[] => [...entries.values()].filter((e) => e.state.kind === "queued");
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
    if (!dispatcher) return { supported: false };
    let listed: unknown;
    try {
      listed = await within(() => dispatcher.list(), COMMAND_LIST_MS);
    } catch (e) {
      throw refused("unavailable", `the harness did not list its commands: ${(e as Error).message}`);
    }
    if (!Array.isArray(listed)) throw refused("internal", "the connector's list is not an array");
    const commands: CommandEntry[] = [];
    for (const e of listed as Partial<Record<keyof CommandEntry, unknown>>[]) {
      if (!isAgentCommandName(e?.name)) continue;
      if (!dispatcher.targets.has(e.target as CommandTarget))
        throw refused("internal", `the connector listed the ${String(e.target)} "${e.name}" but runs no ${String(e.target)}s`);
      const description = fitText(e.description, AGENT_COMMAND_DESCRIPTION_MAX), inputHint = fitText(e.inputHint, AGENT_COMMAND_INPUT_HINT_MAX);
      commands.push({ name: e.name, target: e.target as CommandTarget, ...(description ? { description } : {}), ...(inputHint ? { inputHint } : {}) });
    }
    if (commands.length > AGENT_COMMAND_LIST_MAX)
      throw refused("resource-exhausted", `the harness lists ${commands.length} commands and skills, over the ${AGENT_COMMAND_LIST_MAX} a reply carries`);
    return { supported: true, commands };
  }

  function run(input: CommandInput): CommandOutput {
    if (!dispatcher) throw refused("unimplemented", "this agent's connector runs no commands or skills");
    if (!dispatcher.targets.has(input.target)) throw refused("unimplemented", `this agent's connector runs no ${input.target}s`);
    if (closed) throw refused("unavailable", "this agent is stopping");
    if (queued().length >= MAX_QUEUED_COMMANDS) throw refused("resource-exhausted", `${MAX_QUEUED_COMMANDS} commands are already queued`);
    let id: string;
    do id = Array.from(randomBytes(26), (b) => B32[b & 31]).join(""); while (entries.has(id));
    entries.set(id, { id, command: { target: input.target, name: input.name, args: input.args ?? "" }, state: { kind: "queued" } });
    onQueued();
    return { id };
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
      { command: "command", contract: AGENT_CONTRACTS.command, handler: (ctx) => run(ctx.request.args as unknown as CommandInput) },
      { command: "command-cancel", contract: AGENT_CONTRACTS["command-cancel"], handler: (ctx) => cancel(ctx.request.args as unknown as CommandIdInput) },
      { command: "command-state", contract: AGENT_CONTRACTS["command-state"], handler: (ctx) => ({ state: known((ctx.request.args as unknown as CommandIdInput).id).state }) },
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
      for (const e of queued()) end(e, { kind: "refused", code: "unavailable", message: `the agent stopped before ${what(e.command)} started` });
    },
  };
}
