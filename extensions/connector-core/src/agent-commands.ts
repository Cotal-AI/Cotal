/**
 * An agent's own harness commands and skills on its `agent` endpoint (SPEC 13.22): the `commands`
 * and `command` handlers, and the queue between a `command` request and the connector's next idle
 * turn.
 *
 * A command starts only while no turn runs, which only the connector can see, so the connector takes
 * each waiting command with {@link CommandQueue.dispatchNext}.
 */
import {
  AGENT_COMMAND_DESCRIPTION_MAX, AGENT_COMMAND_INPUT_HINT_MAX, AGENT_COMMAND_LIST_MAX, AGENT_CONTRACTS, EpEnvelopeError,
  isAgentCommandName,
  type CommandEntry, type CommandInput, type CommandTarget, type CommandsOutput, type EpErrorCode, type EpPrincipalCommandDef,
} from "@cotal-ai/core";

/** A `command` reply waits at most this long for the harness to accept the command, and a `commands`
 *  reply this long for the harness's list. */
export const COMMAND_REPLY_MS = 10_000;
/** How many commands may wait for an idle turn at once. */
export const MAX_QUEUED_COMMANDS = 8;

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

/** What {@link CommandQueue.dispatchNext} did: nothing waited, the harness accepted the command, or
 *  it did not. */
export type CommandDispatch = "empty" | "dispatched" | "failed";

/** The connector's side of the queue. */
export interface CommandQueue {
  /** How many commands wait for an idle turn. */
  readonly queued: number;
  /** Hand the oldest waiting command to the dispatcher. It leaves the queue before the dispatch is
   *  awaited, so two calls never take one command. */
  dispatchNext(): Promise<CommandDispatch>;
}

export interface CommandLane extends CommandQueue {
  readonly handlers: EpPrincipalCommandDef[];
  /** Refuse every waiting command, and every later one, as `unavailable`, not-executed, and answer
   *  every command the harness is still being asked to start as `unavailable` with an unknown
   *  outcome. */
  close(): void;
}

interface Waiting {
  readonly command: AgentCommand;
  tryReply(result: Record<string, never> | EpEnvelopeError): boolean;
}

const refused = (code: EpErrorCode, message: string) => new EpEnvelopeError(code, message, undefined, "not-executed");
const what = (c: AgentCommand) => `the ${c.target} "${c.name}"`;

function fitText(text: unknown, max: number): string | undefined {
  if (typeof text !== "string" || text === "") return undefined;
  const chars = [...text];
  return chars.length <= max ? text : `${chars.slice(0, max - 1).join("")}…`;
}

function within<T>(work: () => Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const late = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`no answer within ${ms / 1000} s`)), ms); });
  return Promise.race([Promise.resolve().then(work), late]).finally(() => clearTimeout(timer));
}

export function createCommandLane(dispatcher: CommandDispatcher | undefined, opts: { onQueued(): void; warn(msg: string): void }): CommandLane {
  const queue: Waiting[] = [];
  const starting = new Set<Waiting>();
  let closed = false;

  async function list(): Promise<CommandsOutput> {
    if (!dispatcher) return { supported: false };
    let listed: unknown;
    try {
      listed = await within(() => dispatcher.list(), COMMAND_REPLY_MS);
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

  function run(input: CommandInput): Promise<Record<string, never>> {
    if (!dispatcher) throw refused("unimplemented", "this agent's connector runs no commands or skills");
    if (!dispatcher.targets.has(input.target)) throw refused("unimplemented", `this agent's connector runs no ${input.target}s`);
    if (closed) throw refused("unavailable", "this agent is stopping");
    if (queue.length >= MAX_QUEUED_COMMANDS) throw refused("resource-exhausted", `${MAX_QUEUED_COMMANDS} commands already wait for a turn`);
    const command: AgentCommand = { target: input.target, name: input.name, args: input.args ?? "" };
    return new Promise((resolve, reject) => {
      let done = false;
      const w: Waiting = {
        command,
        tryReply: (result) => {
          if (done) return false;
          done = true;
          clearTimeout(bound);
          if (result instanceof EpEnvelopeError) reject(result);
          else resolve(result);
          return true;
        },
      };
      const bound = setTimeout(() => {
        if (starting.has(w)) {
          w.tryReply(new EpEnvelopeError("deadline-exceeded", `the harness did not answer within ${COMMAND_REPLY_MS / 1000} s, so ${what(command)} may have started`, undefined, "unknown"));
          return;
        }
        queue.splice(queue.indexOf(w), 1);
        w.tryReply(refused("unavailable", `the agent took no new turn within ${COMMAND_REPLY_MS / 1000} s, so ${what(command)} did not start`));
      }, COMMAND_REPLY_MS);
      queue.push(w);
      opts.onQueued();
    });
  }

  return {
    handlers: [
      { command: "commands", contract: AGENT_CONTRACTS.commands, handler: () => list() },
      { command: "command", contract: AGENT_CONTRACTS.command, handler: (ctx) => run(ctx.request.args as unknown as CommandInput) },
    ],
    get queued() {
      return queue.length;
    },
    async dispatchNext() {
      const w = queue.shift();
      if (!w) return "empty";
      starting.add(w);
      try {
        await dispatcher!.dispatch(w.command);
        if (!w.tryReply({})) opts.warn(`${what(w.command)} started after its caller was answered`);
        return "dispatched";
      } catch (e) {
        const message = (e as Error)?.message ?? String(e);
        const reply = e instanceof CommandRefused ? refused(e.code, message)
          : new EpEnvelopeError("internal", `the harness failed, so ${what(w.command)} may have started: ${message}`, undefined, "unknown");
        if (!w.tryReply(reply)) opts.warn(`${what(w.command)} failed after its caller was answered: ${message}`);
        return "failed";
      } finally {
        starting.delete(w);
      }
    },
    close() {
      closed = true;
      for (const w of queue.splice(0)) w.tryReply(refused("unavailable", `the agent stopped before ${what(w.command)} started`));
      for (const w of starting)
        w.tryReply(new EpEnvelopeError("unavailable", `the agent stopped while the harness was being asked to start ${what(w.command)}, so it may have started`, undefined, "unknown"));
    },
  };
}
