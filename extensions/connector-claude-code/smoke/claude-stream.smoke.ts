/**
 * Claude's streamed reply text (`claude-stream.ts`, `hooks/stream.js`), with no broker and no Claude.
 *
 * Covered, mapper side: a prompt's text blocks tie to what streamed under the same number across a
 * tool call, its tool result not starting the count again; a flush the mod relays after the saved
 * entry publishes nothing; a saved text that does not continue what streamed ends the stream and maps
 * as its own message; a turn end abandons a stream no saved entry closed; a subagent's text block is
 * not numbered; a mapper primed from the transcript goes on numbering where the last one stopped; a
 * text block Claude Code shows nothing for publishes nothing and ends what streamed under its number.
 * Mod side: the relay numbers each prompt's messages in the order they stream, skips a subagent's
 * flush, keeps a message's number across its flushes, restarts at the next prompt, and relays under
 * the id the seat sent.
 *
 * Run: pnpm smoke:claude-stream
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AGUI_EVENT_TYPE, JsonlFileSource, StreamedParts, type AguiEvent, type Merged } from "@cotal-ai/connector-core";
import { createSuite } from "@cotal-ai/smoke-kit";
import { createClaudeMapper, type ClaudeEntry } from "../src/agui-map.js";
import { ClaudeStreamOrder, claudeStreamKey, primeStreamOrder } from "../src/claude-stream.js";
// @ts-expect-error the mod is plain JavaScript with no declarations
import { register, streamTo } from "../hooks/stream.js";

const { check, finish } = createSuite();
const TS = "2026-11-23T15:00:00.000Z";
const P = "4b5c1a7e-1f0e-4f4e-9c55-6f0bb2f1a001";
const Q = "4b5c1a7e-1f0e-4f4e-9c55-6f0bb2f1a002";

const prompt = (promptId: string, uuid: string): ClaudeEntry => ({ type: "user", uuid, timestamp: TS, promptId, origin: { kind: "human" }, message: { content: "go" } });
const text = (uuid: string, t: string, sidechain = false): ClaudeEntry => ({ type: "assistant", uuid, timestamp: TS, ...(sidechain ? { isSidechain: true } : {}), message: { content: [{ type: "text", text: t }] } });
/** An assistant entry Claude Code writes itself, as it does on a resume (`model: "<synthetic>"`). */
const synthetic = (uuid: string, t: string, apiError = false): ClaudeEntry =>
  ({ type: "assistant", uuid, timestamp: TS, isApiErrorMessage: apiError, message: { model: "<synthetic>", content: [{ type: "text", text: t }] } } as ClaudeEntry);
const toolUse = (uuid: string): ClaudeEntry => ({ type: "assistant", uuid, timestamp: TS, message: { content: [{ type: "tool_use", id: "toolu_1", name: "Bash", input: {} }] } });
const toolResult = (promptId: string, uuid: string): ClaudeEntry => ({ type: "user", uuid, timestamp: TS, promptId, message: { content: [{ type: "tool_result", tool_use_id: "toolu_1", content: "ok" }] } });
const line = (key: string, t: string, ends?: string[]): Merged<ClaudeEntry> => ({ deltas: t ? [{ key, kind: "text", text: t }] : [], timestamp: 1, ...(ends ? { ends } : {}) });

function mapper(order = new ClaudeStreamOrder(), resumeRunId?: string) {
  let n = 0;
  const m = createClaudeMapper({ threadId: "thread", mintRunId: () => `run-${++n}`, now: () => 0, resumeRunId, stream: { order, parts: new StreamedParts() } });
  return (r: Merged<ClaudeEntry>): AguiEvent[] => {
    const unit = m.mapMerged(r);
    return unit !== null && "events" in unit ? unit.events : [];
  };
}
const texts = (events: AguiEvent[]) =>
  events.filter((e) => e.type.startsWith("TEXT_MESSAGE")).map((e) => {
    const x = e as { type: string; messageId: string; delta?: string; role?: string };
    return `${x.type.replace("TEXT_MESSAGE_", "")}:${x.messageId}${x.delta === undefined ? "" : `:${x.delta}`}`;
  });
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const k1 = claudeStreamKey(P, 1);
const k2 = claudeStreamKey(P, 2);

console.log("\nthe mapper");
{
  const map = mapper();
  map({ harness: prompt(P, "u1") });
  const streamed = [...map(line(k1, "I'll run it.\n")), ...map({ harness: text("a1", "I'll run it.\nNow.") })];
  map({ harness: toolUse("a2") });
  map({ harness: toolResult(P, "u2") });
  const second = [...map(line(k2, "It printed ok.\n")), ...map({ harness: text("a3", "It printed ok.\nDone.") })];
  check("a prompt's first text block closes what streamed under its first number",
    same(texts(streamed), [`START:${k1}`, `CONTENT:${k1}:I'll run it.\n`, `CONTENT:${k1}:Now.`, `END:${k1}`]), texts(streamed));
  check("...and after a tool call and its result, the next block closes the second number",
    same(texts(second), [`START:${k2}`, `CONTENT:${k2}:It printed ok.\n`, `CONTENT:${k2}:Done.`, `END:${k2}`]), texts(second));
}
{
  const map = mapper();
  map({ harness: prompt(P, "u1") });
  const saved = map({ harness: text("a1", "ok") });
  const late = map(line(k1, "ok"));
  check("a flush relayed after its saved entry publishes nothing, and the entry maps whole",
    same(texts(saved), ["START:a1#0", "CONTENT:a1#0:ok", "END:a1#0"]) && late.length === 0, { saved: texts(saved), late: texts(late) });
}
{
  const map = mapper();
  map({ harness: prompt(P, "u1") });
  map(line(k1, "Hello wor"));
  const saved = map({ harness: text("a1", "Something else") });
  check("a saved text that does not continue what streamed ends the stream and maps as its own message",
    same(texts(saved), [`END:${k1}`, "START:a1#0", "CONTENT:a1#0:Something else", "END:a1#0"]), texts(saved));
}
{
  const map = mapper();
  map({ harness: prompt(P, "u1") });
  map(line(k1, "partial"));
  const ended = map(line(k1, "", [k1]));
  const after = map(line(k1, " more"));
  check("a turn end abandons a stream no saved entry closed, and a later flush under it publishes nothing",
    same(texts(ended), [`END:${k1}`]) && after.length === 0, { ended: texts(ended), after: texts(after) });
}
{
  const map = mapper();
  map({ harness: prompt(P, "u1") });
  map({ harness: text("s1", "a subagent's words", true) });
  map(line(k1, "Main "));
  const saved = map({ harness: text("a1", "Main reply") });
  check("a subagent's text block takes no number, so the main reply still closes the first",
    same(texts(saved), [`CONTENT:${k1}:reply`, `END:${k1}`]), texts(saved));
}
{
  const map = mapper();
  map({ harness: prompt(P, "u1") });
  map({ harness: text("a1", "first") });
  map({ harness: prompt(Q, "u2") });
  const kq = claudeStreamKey(Q, 1);
  map(line(kq, "Next "));
  const saved = map({ harness: text("a2", "Next prompt") });
  check("a new prompt numbers from one again", same(texts(saved), [`CONTENT:${kq}:prompt`, `END:${kq}`]), texts(saved));
}
{
  // A resumed session whose last reply was cut off: Claude writes "No response requested." under the
  // killed prompt, shows nothing for it, and the next prompt opens the next turn.
  const map = mapper();
  map({ harness: prompt(P, "u1") });
  map(line(k1, "1. A volcano is an opening in Earth's crust.\n2."));
  const resumed = map({ harness: synthetic("a1", "No response requested.") });
  const next = map({ harness: prompt(Q, "u2") });
  check("Claude's resume entry publishes nothing of its own and ends what streamed under its number",
    same(texts(resumed), [`END:${k1}`]) && next.some((e) => e.type === AGUI_EVENT_TYPE.RUN_FINISHED), { resumed: texts(resumed), next: next.map((e) => e.type) });
}
{
  const map = mapper();
  map({ harness: prompt(P, "u1") });
  const hidden = ["(no content)", " (no content)\n", "", "\n\n", "<context>notes</context>\n", "<cc-memory>\n</cc-memory>"].flatMap((t, i) => map({ harness: synthetic(`h${i}`, t) }));
  const error = map({ harness: synthetic("e1", "API Error: Request was aborted.", true) });
  check("a text block Claude Code shows nothing for publishes nothing", hidden.length === 0, texts(hidden));
  check("...and an API error Claude Code shows still publishes", same(texts(error), ["START:e1#0", "CONTENT:e1#0:API Error: Request was aborted.", "END:e1#0"]), texts(error));
}
{
  const dir = mkdtempSync(join(tmpdir(), "cotal-claude-stream-"));
  try {
    const path = join(dir, "t.jsonl");
    writeFileSync(path, [prompt(P, "u1"), text("a1", "one"), toolUse("a2"), toolResult(P, "u2")].map((e) => JSON.stringify(e)).join("\n") + "\n");
    const cursor = await new JsonlFileSource<ClaudeEntry>(path).end();
    const map = mapper(await primeStreamOrder(path, cursor), "run-from-log");
    map(line(k2, "Two "));
    const saved = map({ harness: text("a3", "Two done") });
    check("a mapper primed from the transcript up to its cursor numbers the next block second",
      same(texts(saved), [`CONTENT:${k2}:done`, `END:${k2}`]), texts(saved));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

console.log("\nthe mod's relay");
{
  type Handler = ($: unknown, e: Record<string, unknown>, next: (e: unknown) => Promise<unknown>) => Promise<unknown>;
  let handler: Handler | undefined;
  register((event: string, h: Handler) => { if (event === "classic.MessageDisplay") handler = h; });
  const relayed: Array<{ argv: string[]; frame: { id: string; op: string; deltas: Array<{ key: string; text: string }> } }> = [];
  const $ = {
    plugin: { root: "/plugin" },
    clock: { after: (ms: number, fn: () => void) => { const t = setTimeout(fn, ms); return { cancel: () => clearTimeout(t) }; } },
    process: { run: async (argv: string[], init: { stdin: string }) => { relayed.push({ argv, frame: JSON.parse(init.stdin) }); return { exitCode: 0 }; } },
  };
  const flush = (e: Record<string, unknown>) => handler!($, e, async () => ({}));
  streamTo({ route: "/tmp/cotal-claude-cmd-1000/1-2.sock", id: "abcdefghijklmnopqrstuvwxyz" });
  await flush({ prompt_id: P, message_id: "m-a", index: 0, final: false, delta: "one\n" });
  await flush({ prompt_id: P, message_id: "s-a", agent_id: "agent-1", index: 0, final: true, delta: "subagent\n" });
  await flush({ prompt_id: P, message_id: "m-a", index: 1, final: true, delta: "two" });
  await flush({ prompt_id: P, message_id: "m-b", index: 0, final: true, delta: "three" });
  await flush({ prompt_id: Q, message_id: "m-c", index: 0, final: true, delta: "four" });
  await new Promise((r) => setTimeout(r, 900));
  const all = relayed.flatMap((r) => r.frame.deltas);
  const joined = new Map<string, string>();
  for (const d of all) joined.set(d.key, (joined.get(d.key) ?? "") + d.text);
  check("the relay keeps a message's number across its flushes and numbers the next message second",
    joined.get(k1) === "one\ntwo" && joined.get(k2) === "three", Object.fromEntries(joined));
  check("...skips a subagent's flush", ![...joined.values()].some((t) => t.includes("subagent")), Object.fromEntries(joined));
  check("...numbers the next prompt from one", joined.get(claudeStreamKey(Q, 1)) === "four", Object.fromEntries(joined));
  check("...answers under the seat's stream id through the reader helper, at most one relay per 250 ms",
    relayed.length >= 2 && relayed.every((r) => r.frame.id === "abcdefghijklmnopqrstuvwxyz" && r.frame.op === "deltas" && same(r.argv, ["node", "/plugin/dist/command-reader.cjs", "answer", "/tmp/cotal-claude-cmd-1000/1-2.sock"])),
    relayed.map((r) => r.argv));
}

finish();
