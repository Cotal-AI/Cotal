/**
 * The session-start hook hands the seat its orientation card, so the model has its bearings
 * without asking: at every SessionStart (startup, resume, fork, clear, compact), or with the next
 * prompt when the seat was not bound yet at the start. Pure (no broker): the card is whatever the
 * `orientation` dep answers, and the agent never connects. Run: `pnpm smoke:claude-orientation-boot`.
 */
import { MeshAgent, type AgentConfig, type HookEvent, type InboxItem } from "@cotal-ai/connector-core";
import { emitSentinel } from "@cotal-ai/smoke-kit";
// RELATIVE, so the bytes mutated are the bytes graded.
import { createClaudeHandle } from "../src/hooks.js";

let passed = 0;
let failed = 0;
function check(name: string, cond: boolean, extra?: unknown): void {
  if (cond) passed++;
  else failed++;
  console.log(`${cond ? "✓" : "✗"} ${name}${cond ? "" : ` — ${JSON.stringify(extra)}`}`);
}

const cfg: AgentConfig = {
  space: "smoke",
  name: "alice",
  servers: "nats://127.0.0.1:1",
  kind: "agent",
  tls: false,
  subscribe: [],
  allowSubscribe: [],
  allowPublish: [],
};
const agent = new MeshAgent(cfg);
const CARD = "You are alice in space \"smoke\" (card)";
const contextOf = (reply: Record<string, unknown>): string =>
  String((reply.hookSpecificOutput as { additionalContext?: unknown } | undefined)?.additionalContext ?? "");
const frame = (name: string, source?: string): HookEvent => ({ hook_event_name: name, transcript_path: "/tmp/none.jsonl", ...(source ? { source } : {}) });

// Hooks observe lifecycle only here (`delivery: false`), so the context carries nothing but the card.
let card: string | undefined = CARD;
const bound = createClaudeHandle({ delivery: false, orientation: async () => card });
check("a bound session start hands over the orientation card", contextOf(await bound.handle(agent, frame("SessionStart", "startup"))) === CARD);
check("the next prompt carries it again only if it is owed, and it is not", contextOf(await bound.handle(agent, frame("UserPromptSubmit"))) === "");
check("a compaction hands the card over again", contextOf(await bound.handle(agent, frame("SessionStart", "compact"))) === CARD);

card = undefined;
const late = createClaudeHandle({ delivery: false, orientation: async () => card });
check("an unbound session start carries no card", contextOf(await late.handle(agent, frame("SessionStart", "startup"))) === "");
check("a prompt while still unbound carries none either", contextOf(await late.handle(agent, frame("UserPromptSubmit"))) === "");
card = CARD;
check("an unbound session start owes the card to the next prompt", contextOf(await late.handle(agent, frame("UserPromptSubmit"))) === CARD);
check("the owed card is handed over once", contextOf(await late.handle(agent, frame("UserPromptSubmit"))) === "");

const none = createClaudeHandle({ delivery: false });
check("without an orientation source nothing is handed over or owed", contextOf(await none.handle(agent, frame("SessionStart", "startup"))) === "" && contextOf(await none.handle(agent, frame("UserPromptSubmit"))) === "");

// The card counts against the hook's 9,000-character budget. A full inbox must leave room for it:
// a frame over the budget collapses to a waiting notice and drops the card with the messages.
const BUDGET = 9_000;
const BIG_CARD = `You are alice (card) ${"orientation ".repeat(250)}`;
const backlog: InboxItem[] = Array.from({ length: 30 }, (_, i) => ({
  id: `m${i}`, recvKey: `m${i}`, ts: i, fromId: "local.BOB", fromName: "bob", kind: "dm",
  mentionsMe: false, historical: false, text: `message ${i} ${"x".repeat(400)}`,
}));
const full = new MeshAgent(cfg);
full.peekInbox = () => backlog;
full.holdInFlight = () => true;
full.inboxCount = () => backlog.length;
full.peekPendingTurns = () => undefined;
const fits = (text: string): boolean => text.length <= BUDGET && text.startsWith(BIG_CARD) && text.includes("message 0 ") && text.includes("still waiting");
const delivering = createClaudeHandle({ orientation: async () => BIG_CARD });
const startCtx = contextOf(await delivering.handle(full, frame("SessionStart", "startup")));
check("a session start with a full inbox keeps the card and fits the budget", fits(startCtx), { length: startCtx.length, head: startCtx.slice(0, 40) });
let owedCard: string | undefined;
const owing = createClaudeHandle({ orientation: async () => owedCard });
await owing.handle(full, frame("SessionStart", "startup"));
owedCard = BIG_CARD;
const promptCtx = contextOf(await owing.handle(full, frame("UserPromptSubmit")));
check("an owed card with a full inbox is kept and fits the budget", fits(promptCtx), { length: promptCtx.length, head: promptCtx.slice(0, 40) });

console.log(`\nclaude-orientation-boot smoke: ${failed === 0 ? "OK ✅" : "FAILED ❌"} — ${passed} passed, ${failed} failed`);
emitSentinel({ passed, failed });
process.exit(failed === 0 ? 0 : 1);
