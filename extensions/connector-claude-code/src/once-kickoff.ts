import { createHash } from "node:crypto";
import type { ControlReply } from "@cotal-ai/core";
import type { HookEvent, MeshAgent } from "@cotal-ai/connector-core";
import type { HookConsumer } from "./prompts.js";

/** Match the prompt submitted at launch and report its main session's first terminal. */
export function onceKickoff(env: NodeJS.ProcessEnv, warn: (message: string) => void) {
  const goal = env.COTAL_CLAUDE_ONCE_GOAL;
  const hash = env.COTAL_CLAUDE_ONCE_PROMPT_HASH;
  if (!goal || !hash) return undefined;
  let session: string | undefined;
  let ended = false;
  let closed = false;
  let retry: ReturnType<typeof setTimeout> | undefined;
  const report = async (agent: MeshAgent, outcome: { status: "done" | "blocked"; note?: string; explicit?: true }, delay = 250): Promise<ControlReply> => {
    let connectFailed = false;
    const result = await agent.yieldKickoff(goal, outcome.status, outcome.note).catch((error: unknown): ControlReply => {
      connectFailed = true;
      return { ok: false, error: String(error) };
    });
    const retryable = outcome.explicit ? connectFailed || result.code === "unavailable"
      : result.code !== "not-found" && result.code !== "failed-precondition";
    if (!closed && !result.ok && retryable) {
      if (delay === 250) warn(`once kickoff completion could not be recorded: ${result.error ?? result.code ?? "no reply"}; retrying`);
      retry = setTimeout(() => {
        if (!closed) void report(agent, outcome, Math.min(delay * 2, 5_000));
      }, delay);
      retry.unref?.();
    }
    return result;
  };
  const observe = (agent: MeshAgent, ev: HookEvent): void => {
    if (closed || ended || ev.agent_id !== undefined || typeof ev.session_id !== "string") return;
    if (ev.hook_event_name === "UserPromptSubmit") {
      // Escape can interrupt without a Stop. Any later main-session submission means its Stop
      // cannot attest to the kickoff. Do not rearm even if the operator repeats the same text.
      if (session !== undefined) ended = true;
      else if (typeof ev.prompt === "string" && createHash("sha256").update(ev.prompt.trim()).digest("hex") === hash)
        session = ev.session_id;
      return;
    }
    if (session !== ev.session_id || (ev.hook_event_name !== "Stop" && ev.hook_event_name !== "StopFailure")) return;
    if (ev.hook_event_name === "Stop" && ev.stop_hook_active === true) return;
    ended = true;
    void report(agent, ev.hook_event_name === "StopFailure" ? { status: "blocked", note: "Claude Code reported a turn failure" } : { status: "done" });
  };
  return {
    async yieldBlocked(agent: MeshAgent, turn: string | undefined, note: string | undefined) {
      if (closed || ended || session === undefined || turn !== goal) return undefined;
      // Latch before the request: a Stop while the manager is unavailable must not replace the
      // explicit outcome, and retries must carry the same note.
      ended = true;
      const reply = await report(agent, { status: "blocked", note, explicit: true });
      if (reply.ok) {
        const state = (reply.data as { state?: unknown } | undefined)?.state;
        if (state !== "succeeded") return { ok: false, error: `the kickoff task already ended (${String(state)})` };
      }
      return reply;
    },
    wrap(next: HookConsumer): HookConsumer {
      return {
        onReply: next.onReply,
        async handle(agent, event) {
          if (event.hook_event_name === "UserPromptSubmit") observe(agent, event);
          const reply = await next.handle(agent, event);
          if (event.hook_event_name !== "UserPromptSubmit") observe(agent, event);
          return reply;
        },
      };
    },
    close(): void { closed = true; clearTimeout(retry); },
  };
}
