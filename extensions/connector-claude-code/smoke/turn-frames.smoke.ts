/**
 * RUN TURNS ON THE CLAUDE CODE HOOK FRAMES — the adapter half of the seat-side relay.
 *
 * The MeshAgent buffers pulled turns (graded in connector-core's `turn-intake` smoke); what THIS
 * suite grades is the claude-code adapter's delivery discipline around them:
 *
 *   1. An injectable frame (`UserPromptSubmit`, `SessionStart`) carries the pending turn as
 *      context, and the surface COMMITS ONLY ON THE FRAME'S DELIVERY VERDICT — the same
 *      format-then-verdict rail peer messages ride. An undelivered reply re-surfaces the turn on
 *      the next frame instead of arming a `done` for work the model never saw.
 *   2. Once delivered, the coming `Stop` auto-yields `done` through the presence funnel.
 *   3. Non-injectable frames (`PreToolUse`, `Notification`, `Stop`) never surface a turn: they
 *      have no vehicle to the model, and consuming one there would be a silent drop.
 *
 * No broker and no relay process: the shipped handle + onReply are driven directly with
 * synthesized frames over a scripted endpoint. Run: pnpm smoke:claude-turn-frames
 */
import { MeshAgent } from "@cotal-ai/connector-core";
import type { AgentConfig } from "@cotal-ai/connector-core";
import { createClaudeHandle, type HookEvent } from "../src/hooks.js";

let pass = 0, fail = 0;
const check = (name: string, cond: boolean, extra?: unknown) => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ FAIL: ${name}`, extra ?? ""); }
};
const tick = () => new Promise((r) => setTimeout(r, 25));

const cfg: AgentConfig = {
  space: "smoke", name: "seat", servers: "nats://127.0.0.1:1", kind: "agent", tls: false,
  subscribe: [], allowSubscribe: [], allowPublish: [],
};

const yields: Record<string, unknown>[] = [];
let pending = [{ goalId: "g1", payload: JSON.stringify({ run: "r1", step: "/turn#0", context: "fix the flaky test", noticeIds: [] }), acceptedAt: Date.now(), deadlineAt: Date.now() + 300_000 }];
const agent = new MeshAgent(cfg);
(agent as unknown as { ep: unknown }).ep = {
  principal: { owner: "local", actor: "seat" },
  setStatus: async () => {},
  setActivity: async () => {},
  setAttention: async () => {},
  joinedChannels: () => [],
  getChannelConfig: () => undefined,
  invokeService: async (_ep: string, command: string, args: unknown) => {
    if (command === "turn-pending") return { reply: { ok: true, data: { turns: [...pending] } } };
    if (command === "turn-yield") {
      yields.push(args as Record<string, unknown>);
      pending = pending.filter((t) => t.goalId !== (args as { goalId?: unknown }).goalId);
      return { reply: { ok: true, data: { goalId: (args as { goalId?: unknown }).goalId, state: "succeeded" } } };
    }
    return { reply: { ok: false, error: { message: `unscripted ${command}` } } };
  },
};
(agent as unknown as { _connected: boolean })._connected = true;
await (agent as unknown as { pollTurns(): Promise<void> }).pollTurns();

const claude = createClaudeHandle();
const contextOf = (reply: Record<string, unknown>): string =>
  String((reply.hookSpecificOutput as { additionalContext?: unknown } | undefined)?.additionalContext ?? "");
const frame = (name: string): HookEvent => ({ hook_event_name: name, transcript_path: "/tmp/none.jsonl" });

console.log("1 — the injectable frame carries the turn; the verdict is what commits it");
{
  const ev1 = frame("UserPromptSubmit");
  const r1 = await claude.handle(agent, ev1);
  check("the frame's context carries the turn payload", contextOf(r1).includes("fix the flaky test"), contextOf(r1).slice(0, 120));
  check("formatting alone commits nothing: the turn still peeks", agent.peekPendingTurns() !== undefined);
  claude.onReply(ev1, false);
  check("an UNDELIVERED reply leaves it unsurfaced, to ride the next frame", agent.peekPendingTurns() !== undefined);
  const ev2 = frame("UserPromptSubmit");
  const r2 = await claude.handle(agent, ev2);
  check("the next frame re-surfaces the same turn", contextOf(r2).includes("fix the flaky test"), contextOf(r2).slice(0, 120));
  claude.onReply(ev2, true);
  check("the DELIVERED verdict commits the surface", agent.peekPendingTurns() === undefined);
}

console.log("2 — the delivered turn's Stop auto-yields done through the presence funnel");
{
  await claude.handle(agent, frame("Stop"));
  await tick();
  check("Stop yields done for the surfaced turn", yields.some((y) => y.goalId === "g1" && y.status === "done"), JSON.stringify(yields));
}

console.log("3 — non-injectable frames never consume a turn");
{
  pending = [{ goalId: "g2", payload: JSON.stringify({ run: "r1", step: "/turn#1", context: "next task", noticeIds: [] }), acceptedAt: Date.now(), deadlineAt: Date.now() + 300_000 }];
  await (agent as unknown as { pollTurns(): Promise<void> }).pollTurns();
  const pre = await claude.handle(agent, { hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: {} });
  const note = await claude.handle(agent, { hook_event_name: "Notification", message: "waiting" });
  check("PreToolUse and Notification return no turn context",
    contextOf(pre) === "" && contextOf(note) === "", { pre, note });
  check("the turn is still waiting for an injectable frame", agent.peekPendingTurns()?.goalIds[0] === "g2");
  const boot = frame("SessionStart");
  const r = await claude.handle(agent, boot);
  claude.onReply(boot, true);
  check("SessionStart is an injectable frame too", contextOf(r).includes("next task") && agent.peekPendingTurns() === undefined, contextOf(r).slice(0, 120));
}

const EXPECTED_CELLS = 9;
const ran = pass + fail;
console.log(`\nturn-frames.smoke: ${pass} passed, ${fail} failed`);
if (ran !== EXPECTED_CELLS) {
  console.log(`SUITE INCOMPLETE — ran ${ran} of ${EXPECTED_CELLS} cells; a partial run is not a pass`);
  process.exitCode = 1;
} else process.exitCode = fail === 0 ? 0 : 1;
