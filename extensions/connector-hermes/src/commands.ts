/**
 * The Hermes seat's side of its `agent` endpoint (SPEC 13.22): the owner's turns, run in the
 * gateway's operator chat as the user's own words, images included; the gateway's slash commands and
 * skill commands the operator chat may run, each run there as `/<name> <args>`; the stop for the
 * Cotal messages and turns in progress; and the operator chat's context window and cost.
 */
import type { CommandEntry, CommandTarget, InterruptOutput } from "@cotal-ai/core";
import { CommandRefused, type AgentUsage, type CommandDispatcher, type MeshAgent } from "@cotal-ai/connector-core";
import type { BridgeServer } from "./bridge.js";

const isCount = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v) && v >= 0;

/** The usage the adapter answered, checked field by field: a field it left out stays out. */
function usageOf(data: Record<string, unknown>): AgentUsage {
  const { context, cost } = data as { context?: { used?: unknown; size?: unknown }; cost?: { amount?: unknown; currency?: unknown } };
  const usage: AgentUsage = {};
  if (context !== undefined) {
    if (!isCount(context.used) || !isCount(context.size)) throw new Error(`the gateway answered an invalid context: ${JSON.stringify(context)}`);
    usage.context = { used: context.used, size: context.size };
  }
  if (cost !== undefined) {
    if (typeof cost.amount !== "number" || !Number.isFinite(cost.amount) || typeof cost.currency !== "string")
      throw new Error(`the gateway answered an invalid cost: ${JSON.stringify(cost)}`);
    usage.cost = { amount: cost.amount, currency: cost.currency };
  }
  return usage;
}

/** The commands the adapter listed, checked entry by entry. */
function entriesOf(data: Record<string, unknown>): CommandEntry[] {
  if (!Array.isArray(data.commands)) throw new Error(`the gateway answered no command list: ${JSON.stringify(data).slice(0, 200)}`);
  return data.commands.map((e: unknown) => {
    const { name, target, description, inputHint } = (e ?? {}) as Record<string, unknown>;
    if (typeof name !== "string" || (target !== "command" && target !== "skill"))
      throw new Error(`the gateway listed an invalid command: ${JSON.stringify(e).slice(0, 200)}`);
    return {
      name,
      target,
      ...(typeof description === "string" && description ? { description } : {}),
      ...(typeof inputHint === "string" && inputHint ? { inputHint } : {}),
    };
  });
}

/** `bridge` is read at each call: the sidecar starts the bridge after the agent that serves this. */
export function hermesCommands(bridge: () => BridgeServer | undefined): CommandDispatcher {
  const live = (): BridgeServer => {
    const b = bridge();
    if (!b) throw new Error("the Hermes bridge is not started");
    return b;
  };
  return {
    targets: new Set<CommandTarget>(["command", "skill"]),
    async list() {
      return entriesOf(await live().ask("commands"));
    },
    // Hermes runs a skill command by its slash name, as it does a command.
    async dispatch({ target, name, args }) {
      const listed = entriesOf(await live().ask("commands"));
      if (!listed.some((c) => c.target === target && c.name === name))
        throw new CommandRefused("not-found", `Hermes lists no ${target} named "${name}" for its operator chat`);
      await live().submitTurn(args ? `/${name} ${args}` : `/${name}`);
    },
    images: true,
    turn: ({ text, images }) => live().submitTurn(text, images),
    async interrupt(): Promise<InterruptOutput["state"]> {
      const { state } = await live().ask("interrupt");
      if (state !== "interrupted" && state !== "idle") throw new Error(`the gateway answered an unknown interrupt state: ${JSON.stringify(state)}`);
      return state;
    },
    async usage() {
      return usageOf(await live().ask("usage"));
    },
  };
}

/** The owner's queued turns start one at a time, each only once the gateway has no Cotal message
 *  or turn in progress: the gateway's own busy handling would interrupt a turn in progress. The
 *  returned wake dispatches until the queue is empty or the bridge is not idle. */
export function drainWhileIdle(agent: Pick<MeshAgent, "dispatchNextCommand">, bridge: () => BridgeServer | undefined): () => void {
  let draining = false;
  return () => {
    const b = bridge();
    if (draining || !b?.idle()) return;
    draining = true;
    void (async () => {
      try {
        while (b.idle() && (await agent.dispatchNextCommand()) !== "empty");
      } finally {
        draining = false;
      }
    })();
  };
}
