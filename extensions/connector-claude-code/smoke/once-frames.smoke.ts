/**
 * A ONCE TASK ON THE CLAUDE CODE HOOK FRAMES.
 *
 * A once task is handed to the session at most once. The hooks put it on an injectable frame
 * (`UserPromptSubmit`, `SessionStart`) ahead of anything else, claim it once the frame's text is
 * fixed, and confirm it only on the relay's receipt that the frame reached Claude. Every other end
 * seals it and reports it: an undelivered frame, a relay with no handoff receipt, and a turn or
 * session that ends before the verdict. A task that cannot ride the frame is left unclaimed.
 *
 * No broker and no relay process: the shipped handle and onReply are driven directly with
 * synthesized frames over a scripted endpoint. Run: pnpm smoke:claude-once-frames
 */
import { MeshAgent } from "@cotal-ai/connector-core";
import type { AgentConfig, HookEvent, InboxItem } from "@cotal-ai/connector-core";
import { mintLifecycleUid } from "@cotal-ai/core";
import { HOOK_CONTEXT_CHARS, createClaudeHandle } from "../src/hooks.js";

let pass = 0, fail = 0;
const check = (name: string, cond: boolean, extra?: unknown) => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ FAIL: ${name}`, extra ?? ""); }
};
const tick = () => new Promise((r) => setTimeout(r, 25));

/** One seat holding one once task, over a scripted endpoint that records its reports. */
const seat = async (prompt = "write the summary") => {
  const uid = mintLifecycleUid();
  const cfg: AgentConfig = {
    space: "smoke", name: "seat", servers: "nats://127.0.0.1:1", kind: "agent", tls: false,
    managerInstanceId: "m".repeat(26), lifecycleUid: uid,
    subscribe: [], allowSubscribe: [], allowPublish: [],
  };
  const reports: string[] = [];
  const agent = new MeshAgent(cfg);
  const row = { goalId: "o1", payload: JSON.stringify({ context: prompt, once: { spawner: "lead" } }), acceptedAt: Date.now(), once: true };
  (agent as unknown as { ep: unknown }).ep = {
    principal: { owner: "local", actor: "seat" },
    setStatus: async () => {},
    setActivity: async () => {},
    setAttention: async () => {},
    setCondition: async () => {},
    joinedChannels: () => [],
    getChannelConfig: () => undefined,
    invokeService: async (_ep: string, command: string, args: unknown) => {
      if (command === "turn-pending") return { reply: { ok: true, data: { turns: [row], notices: true } } };
      if (command === "turn-unconfirmed") {
        reports.push(String((args as { goalId?: unknown }).goalId));
        return { reply: { ok: true, data: { goalId: "o1", state: "failed" } } };
      }
      return { reply: { ok: false, error: { message: `unscripted ${command}` } } };
    },
  };
  (agent as unknown as { _connected: boolean })._connected = true;
  await (agent as unknown as { pollTurns(): Promise<void> }).pollTurns();
  // The handoff state, read from the process registry every copy of connector-core shares.
  const state = () => (globalThis as unknown as Record<symbol, { handoffs: Map<string, { state: string }> } | undefined>)[Symbol.for("cotal.once-handoff")]
    ?.handoffs.get(`${uid}:o1`)?.state ?? "pending";
  return { agent, reports, state };
};
const contextOf = (reply: Record<string, unknown>): string =>
  String((reply.hookSpecificOutput as { additionalContext?: unknown } | undefined)?.additionalContext ?? "");
const frame = (name: string): HookEvent => ({ hook_event_name: name, transcript_path: "/tmp/none.jsonl" });
const TASK = /lead started this seat for one task \(goal o1\)/;

console.log("1. the verdict: only a delivered frame with the relay's handoff receipt confirms the task");
{
  const s = await seat();
  const claude = createClaudeHandle();
  const ev = frame("UserPromptSubmit");
  const r = await claude.handle(s.agent, ev);
  check("an injectable frame carries the task and claims it", TASK.test(contextOf(r)) && contextOf(r).includes("write the summary") && s.state() === "claimed", contextOf(r).slice(0, 200));
  claude.onReply(ev, true, true);
  claude.onReply(ev, false, false);
  await tick();
  check("the handoff receipt confirms it, and a second verdict for the same frame changes nothing", s.state() === "confirmed" && s.reports.length === 0, { state: s.state(), reports: s.reports });
}
for (const [label, delivered, handoff] of [["an undelivered frame", false, false], ["a delivered frame from a relay with no handoff receipt", true, false]] as const) {
  const s = await seat();
  const claude = createClaudeHandle();
  const ev = frame("UserPromptSubmit");
  await claude.handle(s.agent, ev);
  claude.onReply(ev, delivered, handoff);
  await tick();
  check(`${label} seals the task and reports it once`, s.state() === "sealed" && s.reports.join() === "o1", { state: s.state(), reports: s.reports });
}

console.log("\n2. the budget: the task comes first, and what does not fit beside it stays out");
{
  const big = await seat();
  const card = "c".repeat(HOOK_CONTEXT_CHARS - 200);
  const claude = createClaudeHandle({ orientation: async () => card });
  const ev = frame("SessionStart");
  const text = contextOf(await claude.handle(big.agent, ev));
  check("a card that does not fit beside the task is left out of the frame, and the task rides it within the cap",
    TASK.test(text) && !text.includes("ccccc") && text.length <= HOOK_CONTEXT_CHARS && big.state() === "claimed", { length: text.length });
  claude.onReply(ev, true, true);
  const small = await seat();
  const withCard = createClaudeHandle({ orientation: async () => "the orientation card" });
  const ev2 = frame("SessionStart");
  const text2 = contextOf(await withCard.handle(small.agent, ev2));
  check("...and one that fits rides before it", text2.startsWith("the orientation card") && TASK.test(text2), text2.slice(0, 120));
  withCard.onReply(ev2, true, true);
  const huge = await seat("p".repeat(HOOK_CONTEXT_CHARS));
  const plain = createClaudeHandle();
  const ev3 = frame("UserPromptSubmit");
  const text3 = contextOf(await plain.handle(huge.agent, ev3));
  plain.onReply(ev3, true, true);
  await tick();
  check("a task that cannot fit the frame is not put on it and stays unclaimed", !TASK.test(text3) && huge.state() === "pending" && huge.reports.length === 0, { length: text3.length, state: huge.state() });
  // One pending peer message, with no room beside a task that fits the frame alone.
  const wrapper = (await seat("p")).agent.peekPendingTurns()!.text.length - 1;
  const crowded = await seat("p".repeat(HOOK_CONTEXT_CHARS - wrapper - 50));
  const message: InboxItem = { id: "m1", recvKey: "m1", ts: 1, fromId: "local.BOB", fromName: "bob", kind: "dm", mentionsMe: false, historical: false, text: "x".repeat(4_000) };
  const inbox = crowded.agent.peekInbox.bind(crowded.agent);
  crowded.agent.peekInbox = (scope) => scope === "automatic" ? [message] : inbox(scope);
  const ev5 = frame("UserPromptSubmit");
  const text5 = contextOf(await plain.handle(crowded.agent, ev5));
  plain.onReply(ev5, true, true);
  await tick();
  check("a pending message with no room beside a task that fits alone stays waiting, and the task rides the frame within the cap",
    TASK.test(text5) && !text5.includes("xxxxx") && !text5.includes("still waiting") && text5.length <= HOOK_CONTEXT_CHARS && crowded.state() === "confirmed",
    { length: text5.length, state: crowded.state(), start: text5.slice(0, 80) });
  const refused = await seat();
  refused.agent.claimTurns = () => false;
  const ev4 = frame("UserPromptSubmit");
  const text4 = contextOf(await plain.handle(refused.agent, ev4));
  plain.onReply(ev4, true, true);
  await tick();
  check("a claim that fails leaves the frame without the task and the task unclaimed", !TASK.test(text4) && refused.state() === "pending" && refused.reports.length === 0, { text4, state: refused.state() });
}

console.log("\n3. a turn or session that ends before the verdict seals the task, and a late receipt cannot confirm it");
for (const end of ["Stop", "StopFailure", "SessionEnd", "SessionStart"]) {
  const s = await seat();
  const claude = createClaudeHandle();
  const ev = frame("UserPromptSubmit");
  await claude.handle(s.agent, ev);
  // SessionStart here is a new session replacing the one the frame rode on.
  await claude.handle(s.agent, frame(end));
  claude.onReply(ev, true, true);
  await tick();
  check(`${end} before the verdict seals the claimed task; the late receipt leaves it sealed, reported once`,
    s.state() === "sealed" && s.reports.join() === "o1", { state: s.state(), reports: s.reports });
}
{
  // The new session's advisory writes are still pending when the old frame's receipt lands.
  const s = await seat();
  const claude = createClaudeHandle();
  const ev = frame("UserPromptSubmit");
  await claude.handle(s.agent, ev);
  let release!: () => void;
  s.agent.setModel = () => new Promise<void>((resolve) => { release = resolve; });
  const replacing = claude.handle(s.agent, { ...frame("SessionStart"), source: "resume", model: "changed" });
  await tick();
  claude.onReply(ev, true, true);
  release();
  await replacing;
  await tick();
  check("a receipt that lands while a new session's writes are pending finds the old task sealed, reported once",
    s.state() === "sealed" && s.reports.join() === "o1", { state: s.state(), reports: s.reports });
}

const EXPECTED_CELLS = 14;
const ran = pass + fail;
console.log(`\nonce-frames.smoke: ${pass} passed, ${fail} failed`);
if (ran !== EXPECTED_CELLS) {
  console.log(`SUITE INCOMPLETE — ran ${ran} of ${EXPECTED_CELLS} cells; a partial run is not a pass`);
  process.exitCode = 1;
} else process.exitCode = fail === 0 ? 0 : 1;
