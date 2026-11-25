import { createHash } from "node:crypto";
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
  const report = async (agent: MeshAgent, failed: boolean, delay = 250): Promise<void> => {
    if (closed) return;
    const result = await agent.yieldKickoff(goal, failed ? "blocked" : "done", failed ? "Claude Code reported a turn failure" : undefined)
      .catch((error: unknown) => ({ ok: false, code: undefined, error: String(error) }));
    if (closed || result.ok || result.code === "not-found" || result.code === "failed-precondition") return;
    if (delay === 250) warn(`once kickoff completion could not be recorded: ${result.error ?? result.code ?? "no reply"}; retrying`);
    retry = setTimeout(() => void report(agent, failed, Math.min(delay * 2, 5_000)), delay);
    retry.unref?.();
  };
  const observe = (agent: MeshAgent, ev: HookEvent): void => {
    if (ended || ev.agent_id !== undefined || typeof ev.session_id !== "string") return;
    if (ev.hook_event_name === "UserPromptSubmit" && session === undefined && typeof ev.prompt === "string" &&
        createHash("sha256").update(ev.prompt.trim()).digest("hex") === hash) session = ev.session_id;
    if (session !== ev.session_id || (ev.hook_event_name !== "Stop" && ev.hook_event_name !== "StopFailure")) return;
    ended = true;
    void report(agent, ev.hook_event_name === "StopFailure");
  };
  return {
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
