/**
 * The Claude Code seat's commands on its `agent` endpoint (SPEC 13.22). The plugin's command mod
 * (`hooks/commands.js`) lists, runs and interrupts inside Claude Code, and the seat's command socket
 * (`command-feed.ts`) carries each request to it. The mod lists only what may run remotely, and
 * Claude's list does not say which entries are skills, so every entry is a `command`.
 */
import { CommandRefused, type AgentTurn, type AgentUsage, type CommandDispatcher, type MeshAgent } from "@cotal-ai/connector-core";
import type { CommandEntry } from "@cotal-ai/core";
import type { CommandFeed } from "./command-feed.js";
import type { ModAnswer } from "./command-frames.js";
import { promptWithImages } from "./turn-images.js";

/** How long Claude Code has to start a command or take a prompt, and the mod to stop a turn. A panel
 *  or dialog open at the seat holds a command's start until someone there closes it. */
const BOUNDS = { runMs: 30_000, interruptMs: 10_000 };

/** How long a started command's turn has to show in presence before the next command goes. The
 *  turn's prompt hook relays from a process of its own, after the mod's answer. */
const TURN_SHOWS_MS = 1_000;

const NO_FEED =
  "this session's MCP server serves no command socket, because the host that runs it named no Claude Code process for it";

interface ClaudeCommandsOptions {
  /** The seat's command socket, read at each call because it opens after the agent that owns the
   *  dispatcher. Undefined when the session names no Claude Code process. */
  feed(): CommandFeed | undefined;
  /** Marks a remote interrupt. The call it returns ends the turn that interrupt stopped, which Claude
   *  Code reports with no hook. Undefined when no hooks follow the session's turns. */
  interrupting(): (() => Promise<void>) | undefined;
  warn(msg: string): void;
  /** The seat's image folder (turn-images.ts). Without one, a turn takes no images. */
  imageDir?: string;
  bounds?: typeof BOUNDS;
}

function within(answer: Promise<ModAnswer>, ms: number, late: string): Promise<ModAnswer> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(late)), ms); });
  return Promise.race([answer, timeout]).finally(() => clearTimeout(timer));
}

/** The feed answers a request with its own op or with `error`. */
function expect<Op extends ModAnswer["op"]>(answer: ModAnswer, op: Op): Extract<ModAnswer, { op: Op }> {
  if (answer.op === "error") throw new Error(`the command mod failed: ${answer.reason}`);
  if (answer.op !== op) throw new Error(`the command mod answered a ${op} request with ${answer.op}`);
  return answer as Extract<ModAnswer, { op: Op }>;
}

export function claudeCommands(o: ClaudeCommandsOptions): CommandDispatcher {
  const bounds = o.bounds ?? BOUNDS;
  const unsupported = (): string | undefined => {
    const feed = o.feed();
    return feed ? feed.unsupported() : NO_FEED;
  };
  /** The feed, or a refusal naming why no mod serves it. Nothing was sent. */
  const served = (): CommandFeed => {
    const cause = unsupported();
    if (cause !== undefined) throw new CommandRefused("failed-precondition", `the command mod does not serve this session now: ${cause}`);
    return o.feed()!;
  };
  return {
    targets: new Set(["command"]),
    unsupported,
    async list(): Promise<CommandEntry[]> {
      const { commands } = expect(await served().request({ op: "list" }), "list");
      return commands.map((c) => ({ name: c.name, target: "command", description: c.description, inputHint: c.argumentHint }));
    },
    async dispatch({ name, args }) {
      const late = `Claude Code did not start /${name} within ${bounds.runMs / 1000} s. A panel or dialog open at the seat holds it until someone there closes it, so it may still run`;
      const answer = expect(await within(served().request({ op: "run", command: name, args }), bounds.runMs, late), "run");
      if (answer.outcome === "started") return;
      throw new CommandRefused(answer.outcome === "not-found" ? "not-found" : "failed-precondition", answer.reason);
    },
    ...(o.imageDir !== undefined ? { images: true } : {}),
    async turn({ text, images }: AgentTurn) {
      const feed = served();
      const late = `Claude Code did not take the prompt within ${bounds.runMs / 1000} s. A panel or dialog open at the seat holds it until someone there closes it, so it may still run`;
      const prompt = images.length ? promptWithImages(o.imageDir!, text, images) : text;
      const answer = expect(await within(feed.request({ op: "prompt", text: prompt }), bounds.runMs, late), "prompt");
      if (answer.outcome === "refused") throw new CommandRefused("failed-precondition", answer.reason);
    },
    async usage(): Promise<AgentUsage> {
      const late = `the command mod did not report usage within ${bounds.interruptMs / 1000} s`;
      const { window, tokens, usd } = expect(await within(served().request({ op: "usage" }), bounds.interruptMs, late), "usage");
      return {
        ...(tokens !== undefined ? { context: { used: tokens, size: window } } : {}),
        ...(usd !== undefined ? { cost: { amount: usd, currency: "USD" } } : {}),
      };
    },
    async interrupt() {
      const feed = served();
      const stopped = o.interrupting();
      const late = `the command mod did not answer within ${bounds.interruptMs / 1000} s`;
      const answer = expect(await within(feed.request({ op: "interrupt" }), bounds.interruptMs, late), "interrupt");
      if (answer.reason) o.warn(`a remote interrupt stopped the turn, and ${answer.reason}`);
      if (answer.outcome === "interrupted") await stopped?.();
      return answer.outcome;
    },
  };
}

type Seat = Pick<MeshAgent, "status" | "queuedCommands" | "dispatchNextCommand" | "on">;

/** Starts the agent's queued commands one at a time while the seat runs no turn. Claude Code holds
 *  a command it gets mid-turn until the turn ends, which would count that turn against the
 *  command's start bound. Call `idle` at each turn end. */
export function commandTurns(seat: Seat): { idle(): void } {
  let taking = false;
  const pump = (): void => {
    if (taking || seat.queuedCommands === 0 || seat.status === "working" || seat.status === "waiting") return;
    taking = true;
    void seat.dispatchNextCommand().then((outcome) => {
      setTimeout(() => {
        taking = false;
        pump();
      }, outcome === "dispatched" ? TURN_SHOWS_MS : 0).unref?.();
    });
  };
  seat.on("command", pump);
  return { idle: pump };
}
