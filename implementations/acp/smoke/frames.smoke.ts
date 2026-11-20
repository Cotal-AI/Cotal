/**
 * The frame mapping the ACP agent's sessions are built on: AG-UI frames from a seat's event channel
 * to ACP `session/update` notifications and run signals. No broker.
 *
 *  - text keeps its role and message id; reasoning maps to thought chunks;
 *  - a tool call shows its name and ends on the `cotal.toolResult` marker, failed when it says so;
 *  - a frame mapped once maps to nothing the second time, so a history read and a live tap overlap;
 *  - RUN_ERROR ends the frame's run with the seat's message; an interrupt outcome is told apart;
 *  - `closeOpen` closes every tool call still open, once;
 *  - `frameOf` reads the frame part of an event-channel message and nothing else.
 *
 * Run: pnpm --filter @cotal-ai/acp test   (needs `pnpm build` of core and workspace first)
 */
import type { CotalMessage } from "@cotal-ai/core";
import { FrameMapper } from "../src/frames.js";
import { answeredReads, frameOf } from "../src/live-mesh.js";
import type { AguiEventLike, SeatFrame } from "../src/mesh.js";

let pass = 0, fail = 0;
const check = (n: string, c: boolean, x?: unknown): void => { if (c) { pass++; console.log(`  ✓ ${n}`); } else { fail++; console.log(`  ✗ FAIL: ${n}`, x ?? ""); } };

let seq = 0;
const frame = (events: AguiEventLike[], over: Partial<SeatFrame> = {}): SeatFrame =>
  ({ owner: "local", actor: "a1", threadId: "t1", runId: "r1", epoch: "e1", seq: ++seq, events, ts: 1000 + seq, ...over });

const m = new FrameMapper();
const first = m.map(frame([
  { type: "RUN_STARTED", threadId: "t1", runId: "r1" },
  { type: "TEXT_MESSAGE_START", messageId: "u1", role: "user" },
  { type: "TEXT_MESSAGE_CONTENT", messageId: "u1", delta: "hi" },
  { type: "TEXT_MESSAGE_END", messageId: "u1" },
  { type: "TEXT_MESSAGE_START", messageId: "m1", role: "assistant" },
  { type: "TEXT_MESSAGE_CONTENT", messageId: "m1", delta: "hello" },
  { type: "TEXT_MESSAGE_END", messageId: "m1" },
  { type: "REASONING_MESSAGE_CONTENT", messageId: "th1", delta: "thinking" },
  { type: "TOOL_CALL_START", toolCallId: "c1", toolCallName: "Bash" },
  { type: "TOOL_CALL_ARGS", toolCallId: "c1", delta: "{\"cmd\":\"ls\"}" },
  { type: "CUSTOM", name: "cotal.toolResult", value: { toolCallId: "c1", isError: true } },
  { type: "TOOL_CALL_START", toolCallId: "c2", toolCallName: "Read" },
]));
const kinds = first.updates.map((u) => u.sessionUpdate);
check("text, reasoning and tool events map in order", JSON.stringify(kinds) === JSON.stringify(["user_message_chunk", "agent_message_chunk", "agent_thought_chunk", "tool_call", "tool_call_update", "tool_call"]), kinds);
const assistant = first.updates[1] as { messageId?: string; content: { text: string } };
check("an assistant chunk keeps its message id and text", assistant.messageId === "m1" && assistant.content.text === "hello", assistant);
const call = first.updates[3] as { toolCallId: string; title: string; status: string };
check("a tool call shows its name, in progress", call.toolCallId === "c1" && call.title === "Bash" && call.status === "in_progress", call);
check("tool arguments are not shown", !JSON.stringify(first.updates).includes("cmd"), first.updates);
check("the result marker ends the call as failed when it says so", (first.updates[4] as { status: string }).status === "failed", first.updates[4]);
check("RUN_STARTED is a start signal for its run", first.runs.length === 1 && first.runs[0]!.kind === "start" && first.runs[0]!.runId === "r1", first.runs);

const again = frame([{ type: "TEXT_MESSAGE_CONTENT", messageId: "m1", delta: "dup" }], { seq: 1 });
check("a frame already mapped maps to nothing", m.map(again).updates.length === 0);

const closed = m.closeOpen("completed");
check("closeOpen closes the one call still open", closed.length === 1 && (closed[0] as { toolCallId: string; status: string }).toolCallId === "c2" && (closed[0] as { status: string }).status === "completed", closed);
check("closeOpen closes it once", m.closeOpen("failed").length === 0);

const failed = m.map(frame([{ type: "RUN_ERROR", message: "rate limited" }], { runId: "r2" }));
check("RUN_ERROR ends the frame's run with the seat's message", failed.runs[0]?.kind === "end" && failed.runs[0].outcome === "error" && failed.runs[0].runId === "r2" && failed.runs[0].message === "rate limited", failed.runs);
const interrupted = m.map(frame([{ type: "RUN_FINISHED", runId: "r3", outcome: { type: "interrupt" } }]));
check("an interrupt outcome is told apart from a finish", interrupted.runs[0]?.kind === "end" && interrupted.runs[0].outcome === "interrupt", interrupted.runs);

const message = (channel: string, parts: unknown[]): CotalMessage => ({ id: "x", ts: 5, channel, parts, from: { id: "local.a1", name: "a1" } }) as unknown as CotalMessage;
const read = frameOf(message("events.local.a1", [{ kind: "text", text: "x" }, { kind: "ag-ui.frame", protocol: "ag-ui", threadId: "t", runId: "r", epoch: "e", seq: 3, events: [{ type: "RUN_STARTED" }, { nope: 1 }] }]));
check("frameOf reads the frame part and the channel's principal", read?.owner === "local" && read.actor === "a1" && read.seq === 3 && read.events.length === 1 && read.ts === 5, read);
check("frameOf ignores a message off an event channel", frameOf(message("general", [{ kind: "ag-ui.frame", threadId: "t", runId: "r", seq: 1, events: [] }])) === undefined);
check("frameOf ignores a message with no frame part", frameOf(message("events.local.a1", [{ kind: "text", text: "x" }])) === undefined);
const forged = { ...message("events.local.a1", [{ kind: "ag-ui.frame", threadId: "t", runId: "r", seq: 1, events: [] }]), from: { id: "local.a2", name: "a2" } } as unknown as CotalMessage;
check("frameOf ignores a frame that another sender put on an agent's event channel", frameOf(forged) === undefined);

// A manager that does not list its agents hides only its own.
{
  const logged: string[] = [];
  let rows: { instanceId: string; rows: string[] }[] = [];
  let failed: unknown;
  try { rows = answeredReads([{ instanceId: "a", error: new Error("did not answer") }, { instanceId: "b", rows: ["onb"] }], (l) => logged.push(l)); } catch (e) { failed = e; }
  check("one silent manager leaves the others' agents listed", rows.length === 1 && rows[0]!.instanceId === "b" && rows[0]!.rows[0] === "onb", failed instanceof Error ? failed.message : rows);
  check("and the silent one is logged by instance", logged.length === 1 && logged[0]!.includes("manager a") && logged[0]!.includes("did not answer"), logged);
  let thrown: unknown;
  try { answeredReads([{ instanceId: "a", error: new Error("first") }, { instanceId: "b", error: new Error("second") }], () => {}); } catch (e) { thrown = e; }
  check("when no manager answered, the first failure is the answer", thrown instanceof Error && thrown.message === "first", thrown);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
