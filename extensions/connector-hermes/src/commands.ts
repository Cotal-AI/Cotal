/**
 * The Hermes seat's side of its `agent` endpoint (SPEC 13.22): the owner's turns, run in the
 * gateway's operator chat as the user's own words, images included; the stop for the Cotal messages
 * and turns in progress; and the operator chat's context window and cost.
 */
import type { CommandTarget, InterruptOutput } from "@cotal-ai/core";
import { CommandRefused, type AgentUsage, type CommandDispatcher } from "@cotal-ai/connector-core";
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

/** `bridge` is read at each call: the sidecar starts the bridge after the agent that serves this. */
export function hermesCommands(bridge: () => BridgeServer | undefined): CommandDispatcher {
  const live = (): BridgeServer => {
    const b = bridge();
    if (!b) throw new Error("the Hermes bridge is not started");
    return b;
  };
  return {
    targets: new Set<CommandTarget>(),
    async list() {
      return [];
    },
    async dispatch({ name }) {
      throw new CommandRefused("not-found", `Hermes runs no command named "${name}" from the agent endpoint`);
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
