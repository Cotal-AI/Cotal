/**
 * Hermes lifecycle hooks → Cotal presence.
 *
 * The in-gateway Python plugin registers Hermes hooks (`ctx.register_hook`) and forwards each one
 * to this session's connector over connector-core's control socket — the same relay.ts pattern the
 * Claude Code connector uses, just driven from Python instead of a spawned hook binary. All this
 * handle does is move presence: content delivery rides the adapter (see bridge.ts), so hooks never
 * inject or ack — they only set `idle | working | waiting | offline`.
 *
 * Presence is coarse; only events that cross a state boundary move it. The plugin normalizes its
 * Hermes hook names into the `hook_event_name` values switched on below.
 */
import type { HookEvent, MeshAgent } from "@cotal-ai/connector-core";
import type { BridgeServer } from "./bridge.js";

/** Last tool the turn started — so `waiting` (approval) and `working` can name what it's doing. */
let pendingTool: string | undefined;

async function endTurn(agent: MeshAgent): Promise<void> {
  pendingTool = undefined;
  await agent.setStatus("idle");
  // Now idle: if ambient messages were held while busy, ask the bridge to flush them.
  if (agent.pendingWake() > 0) agent.requestWake();
}

/**
 * Run when the bridge may have gone idle. With no Cotal message or turn in progress, a turn still
 * working has ended without `post_llm_call` or `on_session_end`: a run Hermes gave up on, as when its
 * provider refused the request, returns before both. One that ended through them is idle already.
 */
export async function gatewayIdle(agent: MeshAgent, bridge: Pick<BridgeServer, "idle"> | undefined): Promise<void> {
  if (!bridge?.idle() || agent.status !== "working") return;
  try {
    await endTurn(agent);
  } catch {
    // presence is best effort, as in every hook
  }
}

/** A control-server handler that never reads the hook's connection. */
export const hermesHookHandle = async (agent: MeshAgent, ev: HookEvent): Promise<Record<string, unknown>> => {
  const event = String(ev.hook_event_name ?? "");
  try {
    if (event === "pre_llm_call" || event === "pre_tool_call" || event === "post_llm_call") agent.noteActivity();
    switch (event) {
      case "gateway_startup": // gateway up / adapter connected — present and free
      case "on_session_start":
        // NOT a turn ending. `setStatus` reads working→idle as the seat finishing its turn and
        // auto-yields `done` for every surfaced run turn; a gateway reconnect or a session start
        // that lands mid-turn is a lifecycle event, and routing it through the boundary yielded
        // work the model had not finished (the same defect Claude Code's SessionStart had).
        await agent.resetStatus("idle");
        return {};
      case "pre_llm_call": // a turn is running the model
        await agent.setStatus("working", pendingTool);
        return {};
      case "pre_tool_call": // name the tool without publishing its arguments
        pendingTool = typeof ev.tool_name === "string" && ev.tool_name ? ev.tool_name : undefined;
        await agent.setStatus("working", pendingTool);
        return {};
      case "approval_wait": // Hermes asked for command approval — blocked on a human/peer
        await agent.setStatus("waiting", typeof ev.detail === "string" ? ev.detail : pendingTool);
        return {};
      case "approval_done": // the approval stopped waiting, and the tool goes on or is refused
        await agent.setStatus("working", pendingTool);
        return {};
      case "post_llm_call": // turn done
      case "on_session_end":
        await endTurn(agent);
        return {};
      case "gateway_shutdown":
        await agent.setStatus("offline");
        return {};
      default:
        return {};
    }
  } catch {
    return {}; // never block the gateway
  }
};
