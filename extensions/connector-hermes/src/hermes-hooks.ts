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
import type { HookHandle } from "@cotal-ai/connector-core";

/** Last tool the turn started — so `waiting` (approval) and `working` can name what it's doing. */
let pendingTool: string | undefined;

/** A short, human-readable preview of a tool call: "name: most-salient-input". */
function toolDetail(name: unknown, input: unknown): string | undefined {
  if (typeof name !== "string" || !name) return undefined;
  const i = (input ?? {}) as Record<string, unknown>;
  const salient = i.command ?? i.file_path ?? i.path ?? i.url ?? i.query ?? i.description;
  let detail = typeof salient === "string" && salient ? `${name}: ${salient}` : name;
  if (detail.length > 200) detail = `${detail.slice(0, 199)}…`;
  return detail;
}

export const hermesHookHandle: HookHandle = async (agent, ev) => {
  const event = String(ev.hook_event_name ?? "");
  try {
    switch (event) {
      case "gateway_startup": // gateway up / adapter connected — present and free
      case "on_session_start":
        await agent.setStatus("idle");
        return {};
      case "pre_llm_call": // a turn is running the model
        await agent.setStatus("working", pendingTool);
        return {};
      case "pre_tool_call": // record what it's about to run
        pendingTool = toolDetail(ev.tool_name, ev.tool_input);
        await agent.setStatus("working", pendingTool);
        return {};
      case "approval_wait": // Hermes asked for command approval — blocked on a human/peer
        await agent.setStatus("waiting", typeof ev.detail === "string" ? ev.detail : pendingTool);
        return {};
      case "post_llm_call": // turn done
      case "on_session_end":
        pendingTool = undefined;
        await agent.setStatus("idle");
        // Now idle: if ambient messages were held while busy, ask the bridge to flush them.
        if (agent.pendingWake() > 0) agent.requestWake();
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
