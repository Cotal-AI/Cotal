/**
 * The OpenCode 2.x mapping, driven over real sessions (`fixtures/opencode2-sessions.json`) and
 * graded on what would leave: every mapped unit goes through the emitter's own egress policy and the
 * bracket machine, the two steps a unit passes before it is written. The expected streams are the
 * 1.x plane's contract restated per captured session: run boundaries, assistant text, each tool
 * call's start and end, and nothing a person or a tool wrote.
 *
 * Run: pnpm smoke:agui-opencode2-map
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { AguiBrackets, AGUI_EVENT_TYPE as T, applyAguiEgressPolicy, type AguiEvent } from "@cotal-ai/connector-core";
import { createSuite } from "@cotal-ai/smoke-kit";
import { OpenCode2SessionSource, type OpenCode2Message } from "../src/agui-source2.js";
import { createOpenCode2Mapper, type OpenCode2MapperOptions } from "../src/agui-map2.js";

const { check, finish, passed, failed } = createSuite();

const here = dirname(fileURLToPath(import.meta.url));
const fixture = JSON.parse(readFileSync(join(here, "fixtures", "opencode2-sessions.json"), "utf8")) as {
  sessions: { name: string; snapshots: OpenCode2Message[][] }[];
};
const finished = (name: string): OpenCode2Message[] => fixture.sessions.find((s) => s.name === name)!.snapshots.at(-1)!;

const THREAD = "ses_fixture";

/** What a session publishes: each mapped unit through egress and the brackets, in order. */
async function publish(messages: OpenCode2Message[], opts: Partial<OpenCode2MapperOptions> = {}) {
  let n = 0;
  const map = createOpenCode2Mapper({ threadId: THREAD, mintRunId: () => `run-${++n}`, ...opts });
  const read = await new OpenCode2SessionSource({ page: async () => ({ data: messages, cursor: { next: null } }) }).read("");
  const brackets = new AguiBrackets();
  const mapped: AguiEvent[] = [];
  const published: AguiEvent[] = [];
  let violation: string | undefined;
  for (const { value } of read.records) {
    const unit = map(value);
    if (unit === null || !("runId" in unit)) continue;
    mapped.push(...unit.events);
    for (const e of applyAguiEgressPolicy(unit.events)) {
      try {
        brackets.accept(e);
      } catch (err) {
        violation ??= (err as Error).message;
      }
      published.push(e);
    }
  }
  return { mapped, published, violation, open: brackets.open };
}

const TEXT = [T.TEXT_MESSAGE_START, T.TEXT_MESSAGE_CONTENT, T.TEXT_MESSAGE_END];
const TOOL = [T.TOOL_CALL_START, T.TOOL_CALL_END];
const expected: Record<string, string[]> = {
  "shell then text, two turns": [T.RUN_STARTED, ...TOOL, ...TEXT, T.RUN_FINISHED, T.RUN_STARTED, ...TEXT, T.RUN_FINISHED],
  "reasoning, text and a slow shell, then a long step": [T.RUN_STARTED, ...TEXT, ...TOOL, ...TEXT, T.RUN_FINISHED],
  "interrupted while streaming": [T.RUN_STARTED, ...TEXT, T.RUN_FINISHED],
  "tool error": [T.RUN_STARTED, ...TOOL, ...TEXT, T.RUN_FINISHED],
  "failed before any step": [],
  "prompt steered into a running turn": [T.RUN_STARTED, ...TEXT, T.RUN_FINISHED, T.RUN_STARTED, ...TEXT, T.RUN_FINISHED],
};

const all: { name: string; mapped: AguiEvent[]; published: AguiEvent[] }[] = [];
for (const session of fixture.sessions) {
  const out = await publish(session.snapshots.at(-1)!);
  all.push({ name: session.name, ...out });
  check(`stream:${session.name}: run boundaries, text and tool start and end, balanced and closed`,
    JSON.stringify(out.published.map((e) => e.type)) === JSON.stringify(expected[session.name])
      && out.violation === undefined && !out.open,
    { types: out.published.map((e) => e.type), violation: out.violation, open: out.open });
}

const mappedTypes = all.flatMap((s) => s.mapped.map((e): string => e.type));
const publishedTypes = all.flatMap((s) => s.published.map((e): string => e.type));
check("withheld:tool arguments and results are mapped and never published",
  mappedTypes.includes(T.TOOL_CALL_ARGS) && mappedTypes.includes(T.TOOL_CALL_RESULT)
    && !publishedTypes.includes(T.TOOL_CALL_ARGS) && !publishedTypes.includes(T.TOOL_CALL_RESULT),
  { mapped: [...new Set(mappedTypes)], published: [...new Set(publishedTypes)] });

const wire = JSON.stringify(all.map((s) => s.published));
const leaked = ["[user", "[reasoning", "[input", "[result", "[error"].filter((p) => wire.includes(p));
check("withheld:no prompt, reasoning, tool input, tool result or error text is published", leaked.length === 0, leaked);

for (const s of all) {
  const deltas = s.published.filter((e) => e.type === T.TEXT_MESSAGE_CONTENT).map((e) => (e as { delta: string }).delta);
  const texts = [...finished(s.name)].sort((a, b) => (a.id < b.id ? -1 : 1))
    .flatMap((m) => (m.content ?? []).filter((c) => c.type === "text" && c.text).map((c) => (c as { text: string }).text));
  if (texts.length > 0) check(`text:${s.name}: each assistant text is published whole, in order`, JSON.stringify(deltas) === JSON.stringify(texts), { deltas, texts });
}

{
  const runs = all.flatMap((s) => s.published).filter((e) => e.type === T.RUN_STARTED || e.type === T.RUN_FINISHED);
  const ids = all.map((s) => s.published.filter((e) => e.type === T.TEXT_MESSAGE_START).map((e) => (e as { messageId: string }).messageId));
  check("ids:every run names the session as its thread, and each text in a thread its own message id",
    runs.every((e) => (e as { threadId: string }).threadId === THREAD) && ids.every((t) => new Set(t).size === t.length) && ids.flat().length > 0, { ids });
}

{
  const results = (name: string) => all.find((s) => s.name === name)!.mapped.filter((e) => e.type === T.TOOL_CALL_RESULT) as { cotal?: { isError?: boolean } }[];
  check("tool:a tool that failed is marked as an error before egress, a completed one is not",
    results("tool error").every((e) => e.cotal?.isError === true) && results("shell then text, two turns").every((e) => e.cotal?.isError === undefined));
}

{
  const s = all.find((x) => x.name === "interrupted while streaming")!;
  check("outcome:a stop someone pressed ends the run as an ordinary finish, not an error",
    s.published.at(-1)?.type === T.RUN_FINISHED && !s.published.some((e) => e.type === T.RUN_ERROR));
}

{
  const turn: OpenCode2Message[] = [
    { id: "msg_1", type: "user", time: { created: 10 } },
    { id: "msg_2", type: "assistant", time: { created: 11, streamed: 12, completed: 13 }, content: [{ type: "text", text: "partial" }] },
    { id: "msg_3", type: "idle", time: { created: 14 }, outcome: "failed", error: { type: "provider.auth", message: "upstream said: secret-detail" } },
  ];
  const out = await publish(turn);
  const terminal = out.published.at(-1) as { type: string; message?: string; code?: string; timestamp?: number };
  check("outcome:a failed turn ends its run with RUN_ERROR carrying only the fixed message",
    terminal.type === T.RUN_ERROR && terminal.message === "run failed" && terminal.code === undefined && terminal.timestamp === 14
      && !JSON.stringify(out.published).includes("secret-detail") && !out.open,
    out.published);
}

{
  const off = all.find((s) => s.name === "reasoning, text and a slow shell, then a long step")!;
  const on = await publish(finished("reasoning, text and a slow shell, then a long step"), { reasoning: true });
  const reasoning = (es: AguiEvent[]) => es.filter((e) => e.type === T.REASONING_MESSAGE_CONTENT).length;
  check("reasoning:published only when turned on", reasoning(off.published) === 0 && reasoning(on.published) === 2 && on.violation === undefined,
    { off: reasoning(off.published), on: reasoning(on.published) });
}

{
  const map = createOpenCode2Mapper({ threadId: THREAD, mintRunId: () => "run-new", resumeRunId: "run-open" });
  const step: OpenCode2Message = { id: "msg_2", type: "assistant", time: { created: 21, streamed: 22, completed: 23 }, content: [{ type: "text", text: "after a restart" }] };
  const a = map({ message: step, index: 0, element: step.content![0] });
  const b = map({ message: { id: "msg_3", type: "idle", time: { created: 24 }, outcome: "succeeded" }, index: -1 });
  check("resume:a mapper built over an open run continues it and closes it at the turn end",
    a !== null && "runId" in a && a.runId === "run-open" && !a.events.some((e) => e.type === T.RUN_STARTED)
      && b !== null && "runId" in b && b.runId === "run-open" && b.events[0]?.type === T.RUN_FINISHED,
    { a, b });
}

{
  const messages = [...finished("shell then text, two turns")].sort((a, b) => (a.id < b.id ? -1 : 1));
  const out = await publish(messages);
  const stamp = (type: string) => (out.published.find((e) => e.type === type) as { timestamp: number }).timestamp;
  const toolStep = messages.find((m) => m.content?.some((c) => c.type === "tool"))!;
  const textStep = messages.find((m) => m.content?.some((c) => c.type === "text"))!;
  const end = messages.find((m) => m.type === "idle")!;
  const toolCreated = (toolStep.content!.find((c) => c.type === "tool") as { time: { created: number } }).time.created;
  check("stamps:events carry the times the server recorded",
    stamp(T.TOOL_CALL_START) === toolCreated && stamp(T.TEXT_MESSAGE_START) === textStep.time.created && stamp(T.RUN_FINISHED) === end.time.created,
    { tool: stamp(T.TOOL_CALL_START), text: stamp(T.TEXT_MESSAGE_START), end: stamp(T.RUN_FINISHED) });
}

const EXPECTED = 20;
check(`meta:every cell ran - ${EXPECTED} expected`, passed() + failed() === EXPECTED, `${passed() + failed()} cells reported`);
finish();
