/**
 * Claude Code's tool permissions on the agent's prompt desk (SPEC 13.22), with no broker.
 *
 * Claude's hook events, in the shape Claude sends them, drive the shipped prompt module and its
 * launched-session transport against the shipped prompt desk. An answer is a `prompt-answer` call on
 * the desk's own handler, a hook's connection closing is its close signal aborting, and the relay's
 * receipt is the control server's `onReply`. Covered: every row of the report table, the identity
 * cases where a name and an input are not an identity, the scopes, the dialogs left to the terminal,
 * an input over the content limit, a full desk, no desk, the Windows gate, the session end, and the
 * existing hook consumer getting every other event whole and once.
 *
 * The last cells run the real hook entry in its own process against the real control server: a held
 * permission answered after more than 2 s, a hook killed while its prompt is open, the hook's Windows
 * answer (check H3), a socket directory open to its group (check H1, the mode half) and a session
 * with no launch material (check H4). The Claude connector's `prompts` declaration closes the file.
 *
 * Run: pnpm smoke:claude-permission-prompts
 */
import { execFileSync, spawn } from "node:child_process";
import { isDeepStrictEqual } from "node:util";
import { createRequire } from "node:module";
import { createServer } from "node:net";
import { chmodSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { AgentPrompt, CotalEndpoint, EpPrincipalServeContext, PromptState, PromptsOutput, PromptSummary } from "@cotal-ai/core";
import { createSuite } from "@cotal-ai/smoke-kit";
import { controlEndpoint, startControlServer, type HookEvent, type MeshAgent, type PromptDesk, type PromptHooks } from "@cotal-ai/connector-core";
import { createPromptDesk, type ServedPromptDesk } from "../../connector-core/src/prompt-desk.js";
import { createClaudeHandle } from "../src/hooks.js";
import { createClaudePrompts, launchedSessionHooks, type HookConsumer } from "../src/prompts.js";

const { check, finish } = createSuite();
const flush = async (): Promise<void> => {
  for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));
};
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ---- a world: one desk, the module over it, and the session's existing consumer ----------------

const PRINCIPAL = { owner: "u_alice", actor: "coder", uid: "a".repeat(26), runtimeId: "r".repeat(16) };
const ANSWERER = { owner: "u_alice", actor: "web", uid: "w".repeat(26) };

/** The agent the existing consumer drives: it records presence writes. */
function fakeAgent() {
  const statuses: string[] = [], conditions: unknown[] = [];
  const agent = {
    noteActivity() {},
    async setStatus(status: string) { statuses.push(status); },
    async setCondition(c: unknown) { conditions.push(c); },
    pendingWake: () => 0,
    requestWake() {},
  } as unknown as MeshAgent;
  return { agent, statuses, conditions };
}

interface World {
  desk: ServedPromptDesk;
  hooks: ReturnType<typeof launchedSessionHooks>;
  /** Every event the existing consumer handled, and every reply it was told about, in order. */
  handled: HookEvent[];
  told: HookEvent[];
  agent: ReturnType<typeof fakeAgent>;
  moduleWarnings: string[];
  deskWarnings: string[];
}

function world(opts: { platform?: NodeJS.Platform; served?: boolean } = {}): World {
  let seq = 0;
  const ep = { nextPromptsSeq: () => ++seq, setPromptsPresence: async () => {}, maxPayload: 1 << 20 } as unknown as CotalEndpoint;
  const deskWarnings: string[] = [], moduleWarnings: string[] = [];
  const desk = createPromptDesk(ep, (m) => deskWarnings.push(m));
  const prompts = createClaudePrompts({
    desk: () => (opts.served === false ? undefined : desk), warn: (m) => moduleWarnings.push(m),
    ...(opts.platform ? { platform: opts.platform } : {}),
  });
  const claude = createClaudeHandle();
  const handled: HookEvent[] = [], told: HookEvent[] = [];
  const next: HookConsumer = {
    handle: (agent, ev) => { handled.push(ev); return claude.handle(agent, ev); },
    onReply: (ev, delivered, handoff) => { told.push(ev); claude.onReply(ev, delivered, handoff); },
  };
  return { desk, hooks: launchedSessionHooks(prompts, next, (m) => moduleWarnings.push(m)), handled, told, agent: fakeAgent(), moduleWarnings, deskWarnings };
}

/** One hook process as the control server sees it: its event, its connection, and what it printed. */
interface Hook {
  ev: HookEvent;
  conn: AbortController;
  /** The handler's reply, once it returned. */
  output?: Record<string, unknown>;
  /** Whether the reply reached the hook: its connection was still open when the handler returned. */
  reached?: boolean;
  done: Promise<void>;
}

/** Run `ev` through the transport as the control server would. The server tells `onReply` about every
 *  reply; for a permission the test does that itself, with {@link receipt} or {@link dieBeforeReceipt}. */
function fire(w: World, ev: HookEvent): Hook {
  const conn = new AbortController();
  const h = { ev, conn } as Hook;
  h.done = w.hooks.handle(w.agent.agent, ev, { signal: conn.signal }).then((out) => {
    h.output = out;
    h.reached = !conn.signal.aborted;
    if (ev.hook_event_name !== "PermissionRequest") w.hooks.onReply(ev, h.reached, true);
  });
  return h;
}
/** The relay's receipt for the reply `h` printed. */
const receipt = (w: World, h: Hook) => w.hooks.onReply(h.ev, true, true);
/** The hook died after its reply was written and before it sent the receipt. */
function dieBeforeReceipt(w: World, h: Hook): void {
  h.conn.abort();
  w.hooks.onReply(h.ev, false, true);
}

function call(w: World, command: string, args: Record<string, unknown>): unknown {
  const def = w.desk.handlers().find((d) => d.command === command)!;
  return def.handler({
    endpoint: "agent", principal: PRINCIPAL, caller: ANSWERER, authority: "owner",
    request: { v: 1, id: "req", command, args }, receivedAtMonotonicMs: performance.now(),
    replyFits: () => true, signal: new AbortController().signal,
  } as unknown as EpPrincipalServeContext);
}
const list = (w: World) => call(w, "prompts", {}) as PromptsOutput;
const openIds = (w: World) => list(w).open.map((s) => s.id);
const summary = (w: World, id: string): PromptSummary | undefined => {
  const l = list(w);
  return [...l.open, ...l.closed].find((s) => s.id === id);
};
const state = (w: World, id: string): PromptState | undefined => summary(w, id)?.state;
const read = (w: World, id: string) => (call(w, "prompt", { id }) as { prompt: AgentPrompt }).prompt;
/** Answer prompt `id` as the owner's web session. The reply waits for the delivery result, so it is
 *  returned, not awaited. */
function answer(w: World, id: string, option: string, note?: string): Promise<{ state: PromptState }> {
  const p = summary(w, id)!;
  const reply = Promise.resolve().then(() => call(w, "prompt-answer", { id, digest: p.digest, option, ...(note !== undefined ? { note } : {}) }) as Promise<{ state: PromptState }>);
  reply.catch(() => {});
  return reply;
}
/** Open one prompt for `ev` and return its hook and id. */
async function hold(w: World, ev: HookEvent): Promise<{ h: Hook; id: string }> {
  const before = new Set(openIds(w));
  const h = fire(w, ev);
  await flush();
  const id = openIds(w).find((x) => !before.has(x));
  if (!id) throw new Error(`no prompt opened for ${JSON.stringify(ev).slice(0, 200)}`);
  return { h, id };
}

const isOpen = (s?: PromptState) => s?.kind === "open";
const isSent = (s: PromptState | undefined, delivery: "unconfirmed" | "delivered", option: string) =>
  s?.kind === "sent" && s.delivery === delivery && s.answer.option === option;
const closedAs = (s: PromptState | undefined, outcome: Record<string, unknown>) =>
  s?.kind === "closed" && Object.entries(outcome).every(([k, v]) => isDeepStrictEqual((s.outcome as Record<string, unknown>)[k], v));
const NONE = { tie: "none" };
const SUBJECT = { tie: "subject", effect: "proceed" };

// ---- Claude's hook events ---------------------------------------------------------------------

const BASE = { session_id: "11111111-2222-3333-4444-555555555555", transcript_path: "/home/u/.claude/projects/p/s.jsonl", cwd: "/work", permission_mode: "default" };
const permission = (input: unknown, extra: Record<string, unknown> = {}): HookEvent =>
  ({ ...BASE, hook_event_name: "PermissionRequest", tool_name: "Bash", tool_input: input, ...extra });
const batch = (calls: { tool_name?: unknown; tool_input?: unknown; tool_response?: unknown }[], extra: Record<string, unknown> = {}): HookEvent =>
  ({ ...BASE, hook_event_name: "PostToolBatch", tool_calls: calls.map((c, i) => ({ tool_use_id: `toolu_${i}`, tool_response: "ok", ...c })), ...extra });
const bash = (command: string) => ({ tool_name: "Bash", tool_input: { command } });
const stop = (): HookEvent => ({ ...BASE, hook_event_name: "Stop", stop_hook_active: false });
const subagentStop = (agent_id: string): HookEvent =>
  ({ ...BASE, hook_event_name: "SubagentStop", agent_id, agent_type: "general-purpose", agent_transcript_path: "/tmp/a.jsonl", stop_hook_active: false });
const ALLOW_OUT = { hookSpecificOutput: { hookEventName: "PermissionRequest", decision: { behavior: "allow" } } };
const denyOut = (message?: string) =>
  ({ hookSpecificOutput: { hookEventName: "PermissionRequest", decision: { behavior: "deny", ...(message !== undefined ? { message } : {}) } } });

// ---- the prompt ---------------------------------------------------------------------------------
console.log("\nthe prompt a tool permission opens");
{
  const w = world();
  const main = await hold(w, permission({ command: "rm -rf build" }));
  const sub = await hold(w, permission({ title: "x" }, { agent_id: "agent-7", agent_type: "general-purpose", tool_name: "mcp__github__create_issue", mcp_server: { name: "github", source: "user" } }));
  const a = read(w, main.id), b = read(w, sub.id);
  check("a main-thread permission opens a permission prompt with the tool's input shown, its cwd, allow and deny, and no scope",
    isDeepStrictEqual(a.content, {
      kind: "permission", title: "Allow Bash?",
      subject: { type: "tool", name: "Bash", input: { kind: "shown", value: { command: "rm -rf build" } }, cwd: "/work" },
      options: [{ id: "allow", label: "Allow", effect: "proceed" }, { id: "deny", label: "Deny", effect: "refuse", note: "optional" }],
      source: { harness: "claude-code" },
    }), a.content);
  check("a subagent's MCP tool names its server and its scope",
    isDeepStrictEqual((b.content.subject as { server?: string }).server, "github") && isDeepStrictEqual(b.content.source, { harness: "claude-code", scope: "agent-7" }), b.content);
  check("it is offered for 7 days", Date.parse(a.expiresAt) - Date.parse(a.openedAt) === 7 * 24 * 60 * 60 * 1000, a);
  check("the hook prints nothing while its prompt is open", main.h.output === undefined && sub.h.output === undefined);
}

// ---- the report table -----------------------------------------------------------------------------
console.log("\nthe report table");
{
  const w = world();
  const { h, id } = await hold(w, permission({ command: "a" }));
  h.conn.abort();
  await flush();
  check("open, its hook connection closed: withdrawn, seen none, and nothing reaches the hook", closedAs(state(w, id), { kind: "withdrawn", seen: NONE }) && h.reached === false, state(w, id));
}
{
  const w = world();
  const { h, id } = await hold(w, permission({ command: "b" }));
  fire(w, batch([bash("b")]));
  await flush();
  check("open, a batch matches: withdrawn with a sighting tied to the subject, and the hook gets {}",
    closedAs(state(w, id), { kind: "withdrawn", seen: SUBJECT }) && isDeepStrictEqual(h.output, {}) && h.reached === true, { state: state(w, id), h });
}
{
  const w = world();
  const { h, id } = await hold(w, permission({ command: "c" }));
  fire(w, stop());
  await flush();
  check("open, the scope's turn ended: withdrawn, seen none, and the hook gets {}",
    closedAs(state(w, id), { kind: "withdrawn", seen: NONE }) && isDeepStrictEqual(h.output, {}), { state: state(w, id), h });
}
for (const [option, note, out] of [["allow", undefined, ALLOW_OUT], ["deny", "not this one", denyOut("not this one")]] as const) {
  const w = world();
  const { h, id } = await hold(w, permission({ command: "d" }));
  const reply = answer(w, id, option, note);
  await flush();
  check(`sent ${option}: the hook prints the ${option} decision`, isDeepStrictEqual(h.output, out) && h.reached === true, h.output);
  check(`sent ${option}: sent, unconfirmed before the relay's receipt`, isSent(state(w, id), "unconfirmed", option), state(w, id));
  receipt(w, h);
  await flush();
  check(`sent ${option}: sent, delivered on the receipt, and the answer's reply says so`, isSent(state(w, id), "delivered", option) && isSent((await reply).state, "delivered", option), state(w, id));
  fire(w, batch([bash("d")]));
  await flush();
  check(`sent ${option}, a batch matches: unconfirmed with a sighting tied to the subject`, closedAs(state(w, id), { kind: "unconfirmed", seen: SUBJECT }), state(w, id));
}
{
  const w = world();
  const main = await hold(w, permission({ command: "e" }));
  const sub = await hold(w, permission({ command: "e" }, { agent_id: "agent-1" }));
  void answer(w, main.id, "allow");
  void answer(w, sub.id, "deny");
  await flush();
  receipt(w, main.h);
  receipt(w, sub.h);
  await flush();
  check("a deny with no note prints a deny whose message is Permission denied.", isDeepStrictEqual(sub.h.output, denyOut("Permission denied.")), sub.h.output);
  fire(w, stop());
  await flush();
  check("sent allow, the main thread's turn ended: unconfirmed, seen none", closedAs(state(w, main.id), { kind: "unconfirmed", seen: NONE }), state(w, main.id));
  check("the main thread's turn end leaves the subagent's prompt sent", isSent(state(w, sub.id), "delivered", "deny"), state(w, sub.id));
  fire(w, subagentStop("agent-1"));
  await flush();
  check("sent deny, the subagent's turn ended: unconfirmed, seen none", closedAs(state(w, sub.id), { kind: "unconfirmed", seen: NONE }), state(w, sub.id));
}
for (const then of ["a batch matches", "the turn ends"] as const) {
  const w = world();
  const { h, id } = await hold(w, permission({ command: "f" }));
  void answer(w, id, "allow");
  await flush();
  dieBeforeReceipt(w, h);
  await flush();
  check(`sent, the hook closed after the write with no receipt: stays sent, unconfirmed (then ${then})`, isSent(state(w, id), "unconfirmed", "allow"), state(w, id));
  fire(w, then === "a batch matches" ? batch([bash("f")]) : stop());
  await flush();
  check(`... and ${then}: unconfirmed, ${then === "a batch matches" ? "with a sighting tied to the subject" : "seen none"}`,
    closedAs(state(w, id), { kind: "unconfirmed", seen: then === "a batch matches" ? SUBJECT : NONE }), state(w, id));
}
{
  // The desk calls `deliver` in the step that accepts an answer. A close that reaches the module first
  // is a report the desk applies after that step, so the hand-over meets a closed connection.
  const recorded: PromptHooks[] = [];
  const desk: PromptDesk = { waiting: 0, open: (_spec, hooks) => (recorded.push(hooks), Object.freeze({ id: "p", settle() {} })) };
  const writes: unknown[] = [];
  const prompts = createClaudePrompts({ desk: () => desk, warn: () => {} });
  const conn = new AbortController();
  prompts.hold({ scope: undefined, tool: "Bash", input: { command: "g" } }, { closed: conn.signal, write: (o) => (writes.push(o), new Promise(() => {})) });
  conn.abort();
  const d = await recorded[0]!.deliver({ option: "allow", by: { id: "u_alice.web", uid: ANSWERER.uid, authority: "owner" } });
  recorded[0]!.end({ attempted: true });
  check("an answer handed over after the hook's connection closed: deliver resolves gone and nothing is written", d.kind === "gone" && writes.length === 0, { d, writes });
  const again = createClaudePrompts({ desk: () => desk, warn: () => {} });
  const conn2 = new AbortController();
  again.hold({ scope: undefined, tool: "Bash", input: { command: "h" } }, { closed: conn2.signal, write: (o) => (writes.push(o), new Promise(() => {})) });
  conn2.abort();
  recorded[1]!.end({ attempted: false });
  check("end with nothing attempted and the hook's connection gone: nothing is written", writes.length === 0, writes);
}

// ---- a refused call -------------------------------------------------------------------------------
// Claude lists a call a deny refused in its batch, with the deny's message as the call's result.
console.log("\na call the deny refused");
for (const note of ["not this one", undefined]) {
  const w = world();
  const { h, id } = await hold(w, permission({ command: "r" }));
  void answer(w, id, "deny", note);
  await flush();
  receipt(w, h);
  fire(w, batch([{ ...bash("r"), tool_response: note ?? "Permission denied." }]));
  await flush();
  check(`sent deny${note ? " with a note" : ""}, the batch lists the refused call with the deny's message as its result: no sighting, the prompt stays sent`,
    isSent(state(w, id), "delivered", "deny"), state(w, id));
  fire(w, stop());
  await flush();
  check(`... and the turn end closes it unconfirmed, seen none`, closedAs(state(w, id), { kind: "unconfirmed", seen: NONE }), state(w, id));
}
{
  const w = world();
  const p1 = await hold(w, permission({ command: "s" }));
  const p2 = await hold(w, permission({ command: "s" }));
  void answer(w, p1.id, "deny", "no");
  await flush();
  receipt(w, p1.h);
  fire(w, batch([{ ...bash("s"), tool_response: "no" }]));
  await flush();
  check("the refused call is no sighting for a waiting twin either: P2 stays open", isOpen(state(w, p2.id)) && p2.h.output === undefined, state(w, p2.id));
  fire(w, batch([{ ...bash("s"), tool_response: "no" }], { agent_id: "agent-5" }));
  fire(w, batch([{ ...bash("s"), tool_response: "(Bash completed with no output)" }]));
  await flush();
  check("an entry with the key and another result is a sighting: P1 unconfirmed and P2 withdrawn, each tied to the subject",
    closedAs(state(w, p1.id), { kind: "unconfirmed", seen: SUBJECT }) && closedAs(state(w, p2.id), { kind: "withdrawn", seen: SUBJECT }), [state(w, p1.id), state(w, p2.id)]);
}
{
  const w = world();
  const sub = await hold(w, permission({ command: "t" }, { agent_id: "agent-6" }));
  const main = await hold(w, permission({ command: "t" }));
  void answer(w, main.id, "deny", "no");
  await flush();
  receipt(w, main.h);
  fire(w, batch([{ ...bash("t"), tool_response: "no" }], { agent_id: "agent-6" }));
  await flush();
  check("a refusal is recognized only in its own scope: the same result in a subagent's batch is a sighting there",
    closedAs(state(w, sub.id), { kind: "withdrawn", seen: SUBJECT }) && isSent(state(w, main.id), "delivered", "deny"), [state(w, sub.id), state(w, main.id)]);
}

// ---- a name and an input are not an identity ----------------------------------------------------
console.log("\nthe identity cases");
{
  const w = world();
  const { h, id } = await hold(w, permission({ command: "deploy" }));
  void answer(w, id, "deny");
  await flush();
  receipt(w, h);
  fire(w, stop());
  await flush();
  const before = state(w, id);
  fire(w, batch([bash("deploy")]));
  await flush();
  check("the delayed batch: the turn end first closes the prompt unconfirmed, seen none, and the late batch changes nothing",
    closedAs(before, { kind: "unconfirmed", seen: NONE }) && isDeepStrictEqual(state(w, id), before), { before, after: state(w, id) });
  check("... and meets no live prompt, so the desk is told nothing about a closed one", !w.deskWarnings.some((m) => m.includes("is closed")), w.deskWarnings);
}
{
  const w = world();
  const p1 = await hold(w, permission({ command: "twin" }));
  const p2 = await hold(w, permission({ command: "twin" }));
  p1.h.conn.abort();
  await flush();
  fire(w, batch([bash("twin")]));
  await flush();
  check("a closed prompt's batch meets a waiting twin: P1 stays withdrawn, seen none",
    closedAs(state(w, p1.id), { kind: "withdrawn", seen: NONE }), state(w, p1.id));
  check("... and P2 closes withdrawn with a sighting tied to the subject, its hook given {} so its terminal dialog still answers",
    closedAs(state(w, p2.id), { kind: "withdrawn", seen: SUBJECT }) && isDeepStrictEqual(p2.h.output, {}), { s: state(w, p2.id), out: p2.h.output });
}
for (const name of ["a call a rule allowed", "the previous turn's batch"]) {
  const w = world();
  const { h, id } = await hold(w, permission({ command: "same" }));
  fire(w, batch([bash("same")]));
  await flush();
  check(`${name}, with the key of a waiting prompt: withdrawn with a sighting tied to the subject, and the hook gets {}`,
    closedAs(state(w, id), { kind: "withdrawn", seen: SUBJECT }) && isDeepStrictEqual(h.output, {}), state(w, id));
}
{
  const w = world();
  const one = await hold(w, permission({ command: "n" }));
  fire(w, batch([bash("n"), bash("n")]));
  await flush();
  check("more entries than prompts: two entries, one live prompt, one sighting tied to the subject",
    closedAs(state(w, one.id), { kind: "withdrawn", seen: SUBJECT }) && !w.deskWarnings.some((m) => m.includes("is closed")), { s: state(w, one.id), warnings: w.deskWarnings });
  const p1 = await hold(w, permission({ command: "m" }));
  const p2 = await hold(w, permission({ command: "m" }));
  fire(w, batch([bash("m")]));
  await flush();
  check("fewer: one entry, two live prompts with its key, and each gets the same report",
    closedAs(state(w, p1.id), { kind: "withdrawn", seen: SUBJECT }) && closedAs(state(w, p2.id), { kind: "withdrawn", seen: SUBJECT }), [state(w, p1.id), state(w, p2.id)]);
}
{
  const w = world();
  const input = { command: "keep", description: "keep it" };
  const { h, id } = await hold(w, permission(input));
  fire(w, batch([{ tool_name: "Bash", tool_input: { ...input, command: "keep " } }, { tool_name: "Read", tool_input: input }], { agent_id: "agent-3" }));
  fire(w, batch([{ tool_name: "Bash", tool_input: input }], { agent_id: "agent-3" }));
  fire(w, batch([{ tool_name: "Bash", tool_input: { ...input, timeout: 1 } }, { tool_input: input }]));
  fire(w, batch([]));
  await flush();
  check("a batch with no entry for a waiting prompt's key (another input, tool or scope, a call with no name, no calls) changes nothing",
    isOpen(state(w, id)) && h.output === undefined, state(w, id));
  fire(w, batch([{ tool_name: "Bash", tool_input: { description: "keep it", command: "keep" } }]));
  await flush();
  check("the key is the canonical input: the same input written in another key order matches", closedAs(state(w, id), { kind: "withdrawn", seen: SUBJECT }), state(w, id));
}

// ---- scopes -------------------------------------------------------------------------------------
console.log("\nscopes");
{
  const w = world();
  const main = await hold(w, permission({ command: "x" }));
  const sub = await hold(w, permission({ command: "x" }, { agent_id: "agent-1" }));
  fire(w, batch([bash("x")], { agent_id: "agent-1" }));
  await flush();
  check("a main-thread call and a subagent call with the same name and input: the subagent's batch settles only its own prompt",
    closedAs(state(w, sub.id), { kind: "withdrawn", seen: SUBJECT }) && isOpen(state(w, main.id)), [state(w, main.id), state(w, sub.id)]);
  fire(w, batch([bash("x")]));
  await flush();
  check("... and the main thread's batch settles the main thread's", closedAs(state(w, main.id), { kind: "withdrawn", seen: SUBJECT }), state(w, main.id));
  const s2 = await hold(w, permission({ command: "y" }, { agent_id: "agent-2" }));
  const s3 = await hold(w, permission({ command: "y" }, { agent_id: "agent-3" }));
  const m = await hold(w, permission({ command: "y" }));
  fire(w, subagentStop("agent-2"));
  await flush();
  check("SubagentStop ends only that subagent's prompts", closedAs(state(w, s2.id), { kind: "withdrawn", seen: NONE }) && isOpen(state(w, s3.id)) && isOpen(state(w, m.id)),
    [state(w, s2.id), state(w, s3.id), state(w, m.id)]);
  fire(w, stop());
  await flush();
  check("Stop ends only the main thread's", closedAs(state(w, m.id), { kind: "withdrawn", seen: NONE }) && isOpen(state(w, s3.id)), [state(w, m.id), state(w, s3.id)]);
  const s4 = await hold(w, permission({ command: "z" }));
  fire(w, { ...BASE, hook_event_name: "StopFailure", error: "rate_limit" });
  await flush();
  check("StopFailure ends the main thread's turn as Stop does", closedAs(state(w, s4.id), { kind: "withdrawn", seen: NONE }), state(w, s4.id));
  const sent = await hold(w, permission({ command: "q" }, { agent_id: "agent-4" }));
  void answer(w, sent.id, "allow");
  await flush();
  fire(w, { ...BASE, hook_event_name: "SessionEnd", reason: "other" });
  await flush();
  check("SessionEnd ends every scope: an open prompt withdrawn, seen none, with {} to its hook, and a sent one unconfirmed, seen none",
    closedAs(state(w, s3.id), { kind: "withdrawn", seen: NONE }) && isDeepStrictEqual(s3.h.output, {}) && closedAs(state(w, sent.id), { kind: "unconfirmed", seen: NONE }),
    [state(w, s3.id), state(w, sent.id)]);
}

// ---- what stays with the terminal ---------------------------------------------------------------
console.log("\nwhat stays with Claude's dialog");
for (const tool of ["AskUserQuestion", "ExitPlanMode"]) {
  const w = world();
  const h = fire(w, permission({ questions: [] }, { tool_name: tool }));
  await flush();
  check(`${tool}: {} at once and no prompt`, isDeepStrictEqual(h.output, {}) && list(w).open.length === 0, { out: h.output, open: list(w).open.length });
}
{
  const w = world();
  const big = { command: "x".repeat(300_000) };
  const { h, id } = await hold(w, permission(big));
  const p = read(w, id);
  check("an input over the content limit is shown as omitted with its size, and only deny is offered",
    isDeepStrictEqual((p.content.subject as { input: unknown }).input, { kind: "omitted", bytes: Buffer.byteLength(JSON.stringify(big)) }) &&
      isDeepStrictEqual(p.content.options.map((o) => o.id), ["deny"]), { subject: p.content.subject, options: p.content.options });
  let refused: unknown;
  await answer(w, id, "allow").catch((e) => (refused = e));
  check("... an allow is refused and the prompt stays open", (refused as { code?: string })?.code === "bad-request" && isOpen(state(w, id)), { refused, s: state(w, id) });
  void answer(w, id, "deny", "too big to read");
  await flush();
  check("... and a deny reaches the hook", isDeepStrictEqual(h.output, denyOut("too big to read")), h.output);
}
{
  const w = world();
  const held = [];
  for (let i = 0; i < 32; i++) held.push(await hold(w, permission({ command: `full ${i}` })));
  const h = fire(w, permission({ command: "one too many" }));
  await flush();
  check("a full desk: the 33rd permission gets {} at once, and the 32 stay open",
    isDeepStrictEqual(h.output, {}) && list(w).open.length === 32 && held.every((x) => x.h.output === undefined), { out: h.output, open: list(w).open.length });
  check("... and the connector says why", w.moduleWarnings.some((m) => m.includes("32 prompts are open or sent")), w.moduleWarnings);
}
{
  const w = world({ served: false });
  const h = fire(w, permission({ command: "ls" }));
  await flush();
  check("no desk served (before the broker accepted it, or an open mesh): {} at once", isDeepStrictEqual(h.output, {}));
}
{
  const w = world({ platform: "win32" });
  check("Windows: the connector warns once, at start, and says why", w.moduleWarnings.length === 1 && /Windows/.test(w.moduleWarnings[0]!), w.moduleWarnings);
  const h = fire(w, permission({ command: "ls" }));
  await flush();
  check("Windows: a permission that reaches the connector gets {} at once and opens no prompt",
    isDeepStrictEqual(h.output, {}) && list(w).open.length === 0 && w.moduleWarnings.length === 1, { out: h.output, warnings: w.moduleWarnings });
}

// ---- the existing consumer ----------------------------------------------------------------------
console.log("\nthe existing hook consumer");
for (const withPrompt of [false, true]) {
  const w = world();
  const open = withPrompt ? await hold(w, permission({ command: "long" }, { agent_id: "agent-9" })) : undefined;
  const events: HookEvent[] = [
    { ...BASE, hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "ls" }, tool_use_id: "toolu_1" },
    { ...BASE, hook_event_name: "Notification", notification_type: "permission_prompt", message: "Claude needs your permission to use Bash" },
    batch([bash("ls")]),
    { ...BASE, hook_event_name: "StopFailure", error: "rate_limit", error_details: "429" },
    subagentStop("agent-8"),
    stop(),
  ];
  const fired = events.map((ev) => fire(w, ev));
  await Promise.all(fired.map((h) => h.done));
  const label = withPrompt ? "with a prompt open" : "with none";
  check(`${label}: the consumer handled each event once, the same object, in order, and never a PermissionRequest`,
    w.handled.length === events.length && w.handled.every((ev, i) => ev === events[i]), w.handled.map((e) => e.hook_event_name));
  check(`${label}: each reply reached the consumer's onReply once, in whatever order the replies ended`,
    w.told.length === events.length && events.every((ev) => w.told.filter((t) => t === ev).length === 1), w.told.map((e) => e.hook_event_name));
  check(`${label}: StopFailure with error rate_limit still sets that condition`,
    w.agent.conditions.some((c) => (c as { code?: string; source?: string } | null)?.code === "rate_limit" && (c as { source?: string }).source === "rate_limit"), w.agent.conditions);
  if (open) check(`${label}: the subagent's prompt is still open`, isOpen(state(w, open.id)), state(w, open.id));
}

// ---- the real hook process ------------------------------------------------------------------------
console.log("\nthe real hook, in its own process");
const dirs: string[] = [];
const here = fileURLToPath(new URL(".", import.meta.url));
const hookEntry = join(here, "..", "src", "hook.ts");
const tsx = pathToFileURL(createRequire(import.meta.url).resolve("tsx")).href;
const AS_WINDOWS = 'data:text/javascript,Object.defineProperty(process,"platform",{value:"win32"})';

function runHook(env: Record<string, string>, event: HookEvent, preload: string[] = []) {
  const clean = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("COTAL_")));
  const child = spawn(process.execPath, ["--import", tsx, ...preload.flatMap((p) => ["--import", p]), hookEntry], { env: { ...clean, ...env }, stdio: ["pipe", "pipe", "pipe"] });
  let stdout = "";
  child.stdout.setEncoding("utf8").on("data", (c) => (stdout += c));
  child.stderr.resume();
  const started = performance.now();
  const done = new Promise<{ stdout: string; ms: number }>((resolve) => child.on("close", () => resolve({ stdout: stdout.trim(), ms: performance.now() - started })));
  child.stdin.end(JSON.stringify(event));
  return { child, done };
}
const launchEnv = (ep: { path: string; token: string; version: number }) =>
  ({ COTAL_NAME: "prompt-probe", COTAL_CONTROL_SOCKET: ep.path, COTAL_CONTROL_KEY: ep.token, COTAL_CONTROL_VERSION: String(ep.version) });

const w = world();
const endpoint = controlEndpoint("permission-prompts", "probe", dirs);
let connections = 0;
const server = startControlServer(w.agent.agent, endpoint, w.hooks.handle, { onReply: w.hooks.onReply });
server.on("connection", () => connections++);
await new Promise<void>((resolve) => server.once("listening", () => resolve()));
try {
  {
    const before = new Set(openIds(w));
    const run = runHook(launchEnv(endpoint), permission({ command: "make release" }));
    let id: string | undefined;
    for (let i = 0; i < 200 && !id; i++, await wait(25)) id = openIds(w).find((x) => !before.has(x));
    await wait(2_500);
    const stillOpen = isOpen(id ? state(w, id) : undefined);
    if (id) void answer(w, id, "allow");
    const r = await run.done;
    await flush();
    check(`a held permission answered allow after 2.5 s: the hook prints the allow decision (${Math.round(r.ms)} ms)`,
      stillOpen && r.stdout === JSON.stringify(ALLOW_OUT) && r.ms > 2_500, { stillOpen, r });
    await wait(100);
    check("... and the relay's receipt makes it sent, delivered", isSent(id ? state(w, id) : undefined, "delivered", "allow"), id && state(w, id));
  }
  {
    const before = new Set(openIds(w));
    const run = runHook(launchEnv(endpoint), permission({ command: "sleep 99" }));
    let id: string | undefined;
    for (let i = 0; i < 200 && !id; i++, await wait(25)) id = openIds(w).find((x) => !before.has(x));
    run.child.kill("SIGKILL");
    await run.done;
    for (let i = 0; i < 50 && isOpen(id ? state(w, id) : undefined); i++) await wait(20);
    check("a hook killed from outside while its prompt is open: withdrawn, seen none", closedAs(id ? state(w, id) : undefined, { kind: "withdrawn", seen: NONE }), id && state(w, id));
  }
  {
    const stand = controlEndpoint("permission-prompts", "stand-in", dirs);
    let standIns = 0;
    const standIn = createServer((s) => { standIns++; s.end(`${JSON.stringify(ALLOW_OUT)}\n`); });
    await new Promise<void>((resolve) => standIn.listen(stand.path, () => resolve()));
    const seen = connections, open = list(w).open.length;
    const real = await runHook(launchEnv(endpoint), permission({ command: "ls" }), [AS_WINDOWS]).done;
    const fake = await runHook(launchEnv(stand), permission({ command: "ls" }), [AS_WINDOWS]).done;
    await new Promise<void>((resolve) => standIn.close(() => resolve()));
    check("H3, Windows: with the real server, the hook prints {} at once and no connection is made",
      real.stdout === "{}" && real.ms < 3_000 && connections === seen && list(w).open.length === open, { real, connections: connections - seen });
    check("H3, Windows: with a stand-in that answers allow, the hook prints {} at once and the stand-in receives nothing",
      fake.stdout === "{}" && fake.ms < 3_000 && standIns === 0, { fake, standIns });
  }
  if (process.platform !== "win32") {
    const seen = connections;
    chmodSync(dirname(endpoint.path), 0o750);
    const r = await runHook(launchEnv(endpoint), permission({ command: "ls" })).done;
    chmodSync(dirname(endpoint.path), 0o700);
    check("H1, the socket's directory open to its group: the hook connects to nothing and prints no decision",
      r.stdout === "" && r.ms < 3_000 && connections === seen, { r, connections: connections - seen });
  }
  {
    const seen = connections;
    const r = await runHook({}, permission({ command: "ls" })).done;
    check("H4, a session with the plugin and no launch material: the hook exits at once with no decision", r.stdout === "" && r.ms < 3_000 && connections === seen, r);
  }
  {
    // The launch fact a Manager reports comes from this declaration.
    const declared = (preload: string[]) => execFileSync(process.execPath,
      ["--import", tsx, ...preload.flatMap((p) => ["--import", p]), "--input-type=module", "-e",
        `const { claudeConnector } = await import(${JSON.stringify(pathToFileURL(join(here, "..", "src", "extension.ts")).href)}); process.stdout.write(String(claudeConnector.prompts));`],
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    check("the Claude connector declares prompts off Windows", declared([]) === "true");
    check("H3, Windows: the Claude connector does not declare prompts, so the Manager fact is false", declared([AS_WINDOWS]) === "undefined");
  }
} finally {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
}
finish();
