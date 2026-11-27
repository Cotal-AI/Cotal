/**
 * The frame mapping the ACP agent's sessions are built on: AG-UI frames from a seat's event channel
 * to ACP `session/update` notifications and run signals. No broker.
 *
 *  - text keeps its role and message id; reasoning maps to thought chunks;
 *  - a tool call shows its name and ends on the `cotal.toolResult` marker, failed when it says so;
 *  - a call's arguments and result from the payload rail show on it, whichever plane arrives first:
 *    its kind, title, locations, edits as diffs (a relative path in the seat's folder) and output;
 *    a connector without the marker ends a call with its result; a cut payload says so;
 *  - each harness's todo tools show as the session's plan, Claude's task tools one task at a time and
 *    Hermes's todo merging by id when asked;
 *  - Jcode's and Hermes's tools read by kind, with their edits as diffs;
 *  - a Codex file change approval's change list reads as diffs;
 *  - a `*** Begin Patch` envelope reads as one diff per file;
 *  - a frame mapped once maps to nothing the second time, so a history read and a live tap overlap;
 *  - RUN_ERROR ends the frame's run with the seat's message; an interrupt outcome is told apart;
 *  - `closeOpen` closes every tool call still open, once;
 *  - `frameOf` reads the frame part of an event-channel message and nothing else;
 *  - `managerPlan` starts new threads where the auth service's own rule would, and reads agents from
 *    every live manager the person may use;
 *  - `runningManagers` offers the listed managers whose rail is not gone, and with none left rejects as
 *    a space with no manager does;
 *  - a signed-in person's listed manager with no row under their principal, as the space's own, is
 *    described by what its rail reports;
 *  - a manager is local only by the machine id it names: this machine's manager under a host name it
 *    no longer has is local and starts no second one, and another machine's under this host name is not;
 *  - a manager that names no machine, as one an older release started, is local when this machine's
 *    service record names its instance, so a new thread starts no second manager beside it;
 *  - `launchManagers` starts this machine's manager when no listed one is, remote live included, and
 *    fails the thread when the start fails or its manager is still not listed here;
 *  - the model select and model state list `<agent>/default` once when the catalog names a model
 *    `default`, with that model's name and reasoning variants;
 *  - `agentCatalogs` carries a failed models read, so the application is refused with its reason, and
 *    a Jcode whose catalog lists models is offered with them.
 *
 * Run: pnpm --filter @cotal-ai/acp test   (needs `pnpm build` of core and workspace first)
 */
import type { CotalMessage, Presence } from "@cotal-ai/core";
import type { SessionUpdate } from "@agentclientprotocol/sdk";
import { FrameMapper } from "../src/frames.js";
import { patchDiffs } from "../src/tools.js";
import { agentCatalogs, answeredReads, frameOf, listedChoice, managerChoice, managerPlan, namesDeregister, runningManagers } from "../src/live-mesh.js";
import { launchManagers } from "../src/manager-start.js";
import { applyOption, configOptions, initialSelection, modelState, noMachine, refusal, spawnModel, type Offer } from "../src/options.js";
import { NoLaunchManager } from "../src/mesh.js";
import type { AguiEventLike, ManagerChoice, SeatFrame } from "../src/mesh.js";

let pass = 0, fail = 0;
const check = (n: string, c: boolean, x?: unknown): void => { if (c) { pass++; console.log(`  ✓ ${n}`); } else { fail++; console.log(`  ✗ FAIL: ${n}`, x ?? ""); } };

let seq = 0;
const frame = (events: AguiEventLike[], over: Partial<SeatFrame> = {}): SeatFrame =>
  ({ plane: "events", owner: "local", actor: "a1", threadId: "t1", runId: "r1", epoch: "e1", seq: ++seq, events, ts: 1000 + seq, ...over });

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
check("frameOf reads the frame part and the channel's principal", read?.owner === "local" && read.actor === "a1" && read.seq === 3 && read.events.length === 1 && read.ts === 5 && read.plane === "events", read);
const payloadRead = frameOf(message("events.local.a1", [{ kind: "ag-ui.frame", protocol: "ag-ui", threadId: "t", runId: "r", epoch: "e", seq: 3, events: [{ type: "TOOL_CALL_ARGS", toolCallId: "c", delta: "{}" }] }]), "payloads");
check("frameOf reads a payload frame, whose envelope names the event channel, as one", payloadRead?.plane === "payloads" && payloadRead.actor === "a1", payloadRead);
check("frameOf ignores a message off an event channel", frameOf(message("general", [{ kind: "ag-ui.frame", threadId: "t", runId: "r", seq: 1, events: [] }])) === undefined);
check("frameOf ignores a message with no frame part", frameOf(message("events.local.a1", [{ kind: "text", text: "x" }])) === undefined);
const forged = { ...message("events.local.a1", [{ kind: "ag-ui.frame", threadId: "t", runId: "r", seq: 1, events: [] }]), from: { id: "local.a2", name: "a2" } } as unknown as CotalMessage;
check("frameOf ignores a frame that another sender put on an agent's event channel", frameOf(forged) === undefined);

// The payload rail: arguments and results on the calls they belong to.
{
  type Any = Record<string, unknown>;
  const as = (u: SessionUpdate | undefined) => u as unknown as Any;
  const pm = new FrameMapper("claude", "/work");
  // The payload frame is published first, so its arguments can beat the call's start.
  const early = pm.map(frame([{ type: "TOOL_CALL_ARGS", toolCallId: "e1", delta: JSON.stringify({ file_path: "notes.txt", old_string: "a", new_string: "b" }) }], { plane: "payloads", seq: 500 }));
  check("arguments that beat the call show nothing yet", early.updates.length === 0, early.updates);
  const started = pm.map(frame([{ type: "TOOL_CALL_START", toolCallId: "e1", toolCallName: "Edit" }], { seq: 500 }));
  const edit = as(started.updates[0]);
  check("the call then starts with its kind, title and arguments", edit.sessionUpdate === "tool_call" && edit.kind === "edit" && edit.title === "Edit /work/notes.txt" && (edit.rawInput as Any).old_string === "a", edit);
  check("an edit shows as a diff, its relative path in the seat's folder", JSON.stringify(edit.content) === JSON.stringify([{ type: "diff", path: "/work/notes.txt", oldText: "a", newText: "b" }]) && JSON.stringify(edit.locations) === JSON.stringify([{ path: "/work/notes.txt" }]), edit);
  check("a payload frame and an event frame with one seq are both mapped", started.updates.length === 1);
  const result = pm.map(frame([{ type: "TOOL_CALL_RESULT", toolCallId: "e1", content: "updated" }], { plane: "payloads" }));
  const out = as(result.updates[0]);
  check("its result shows as output on the call and ends it", out.sessionUpdate === "tool_call_update" && out.rawOutput === "updated" && JSON.stringify(out.content).includes("updated") && out.status === "completed", out);
  const marked = pm.map(frame([{ type: "CUSTOM", name: "cotal.toolResult", value: { toolCallId: "e1", isError: false } }]));
  check("the marker after the result adds nothing", marked.updates.length === 0, marked.updates);

  const late = pm.map(frame([{ type: "TOOL_CALL_START", toolCallId: "l1", toolCallName: "Bash" }, { type: "CUSTOM", name: "cotal.toolResult", value: { toolCallId: "l1", isError: true } }]));
  check("a call whose payload has not arrived shows by name and ends on the marker", as(late.updates[0]).title === "Bash" && as(late.updates[0]).kind === "execute" && as(late.updates[1]).status === "failed", late.updates);
  const lateArgs = pm.map(frame([{ type: "TOOL_CALL_ARGS", toolCallId: "l1", delta: JSON.stringify({ command: "ls -la" }) }, { type: "TOOL_CALL_RESULT", toolCallId: "l1", content: "denied", cotal: { isError: true } }], { plane: "payloads" }));
  const lateUpdate = as(lateArgs.updates.at(-1));
  check("a payload that arrives after the call ended still shows on it", lateUpdate.title === "ls -la" && lateUpdate.rawOutput === "denied" && (lateUpdate.rawInput as Any).command === "ls -la", lateArgs.updates);
  check("closeOpen leaves calls that ended alone", pm.closeOpen("completed").length === 0);

  const cut = pm.map(frame([{ type: "TOOL_CALL_START", toolCallId: "k1", toolCallName: "Read" }]));
  pm.map(frame([{ type: "TOOL_CALL_RESULT", toolCallId: "k1", content: JSON.stringify({ cotalPayloadCut: true, originalBytes: 900000, sha256: "ab" }) }], { plane: "payloads" }));
  check("a read shows by kind before its arguments arrive", as(cut.updates[0]).kind === "read", cut.updates);
  const cutOut = pm.map(frame([{ type: "TOOL_CALL_RESULT", toolCallId: "k1", content: JSON.stringify({ cotalPayloadCut: true, originalBytes: 900000, sha256: "ab" }) }], { plane: "payloads", seq: 900 }));
  check("a payload the rail cut says so instead of showing the marker", String(as(cutOut.updates[0]).rawOutput).includes("900000 bytes"), cutOut.updates);

  const oc = new FrameMapper("opencode");
  oc.map(frame([{ type: "TOOL_CALL_START", toolCallId: "o1", toolCallName: "shell" }]));
  const ocEnd = oc.map(frame([{ type: "TOOL_CALL_ARGS", toolCallId: "o1", delta: JSON.stringify({ command: "sleep 1" }) }, { type: "TOOL_CALL_RESULT", toolCallId: "o1", content: "" }], { plane: "payloads" }));
  check("a connector without the marker ends a call with its result", as(ocEnd.updates.at(-1)).status === "completed", ocEnd.updates);
  const ocWrite = oc.map(frame([{ type: "TOOL_CALL_ARGS", toolCallId: "o2", delta: JSON.stringify({ path: "/w/x.txt", content: "alpha" }) }], { plane: "payloads", seq: 950 }));
  const ocStart = as(oc.map(frame([{ type: "TOOL_CALL_START", toolCallId: "o2", toolCallName: "write" }], { seq: 950 })).updates[0]);
  check("OpenCode 2.x's write shows as a diff from nothing", ocWrite.updates.length === 0 && ocStart.title === "Write /w/x.txt" && JSON.stringify(ocStart.content) === JSON.stringify([{ type: "diff", path: "/w/x.txt", oldText: null, newText: "alpha" }]), ocStart);

  const unknown = new FrameMapper("claude");
  unknown.map(frame([{ type: "TOOL_CALL_ARGS", toolCallId: "u1", delta: JSON.stringify({ q: 1 }) }], { plane: "payloads", seq: 960 }));
  const mcp = as(unknown.map(frame([{ type: "TOOL_CALL_START", toolCallId: "u1", toolCallName: "mcp__x__y" }], { seq: 960 })).updates[0]);
  check("a tool no table names reads as other with its arguments as given", mcp.kind === "other" && mcp.title === "mcp__x__y" && (mcp.rawInput as Any).q === 1, mcp);
}

// Todo tools show as the session's plan.
{
  const plans = (m: FrameMapper, events: AguiEventLike[], plane: SeatFrame["plane"] = "events", at?: number) =>
    m.map(frame(events, { plane, ...(at ? { seq: at } : {}) })).updates.filter((u) => u.sessionUpdate === "plan").map((u) => (u as unknown as { entries: { content: string; status: string }[] }).entries);
  const cc = new FrameMapper("claude");
  const todo = JSON.stringify({ todos: [{ content: "write", status: "completed", activeForm: "w" }, { content: "test", status: "in_progress", activeForm: "t" }] });
  plans(cc, [{ type: "TOOL_CALL_ARGS", toolCallId: "t1", delta: todo }], "payloads", 970);
  const written = cc.map(frame([{ type: "TOOL_CALL_START", toolCallId: "t1", toolCallName: "TodoWrite" }, { type: "CUSTOM", name: "cotal.toolResult", value: { toolCallId: "t1" } }], { seq: 970 }));
  check("TodoWrite shows as the plan and not as a call", written.updates.length === 1 && written.updates[0]!.sessionUpdate === "plan" && JSON.stringify((written.updates[0] as unknown as { entries: unknown }).entries) === JSON.stringify([{ content: "write", status: "completed", priority: "medium" }, { content: "test", status: "in_progress", priority: "medium" }]), written.updates);
  check("a plan call is never closed as a call", cc.closeOpen("completed").length === 0);

  const tasks = new FrameMapper("claude");
  tasks.map(frame([{ type: "TOOL_CALL_START", toolCallId: "k1", toolCallName: "TaskCreate" }]));
  plans(tasks, [{ type: "TOOL_CALL_ARGS", toolCallId: "k1", delta: JSON.stringify({ subject: "ship", description: "d" }) }, { type: "TOOL_CALL_RESULT", toolCallId: "k1", content: "Task #4 created successfully: ship" }], "payloads");
  tasks.map(frame([{ type: "TOOL_CALL_START", toolCallId: "k2", toolCallName: "TaskCreate" }]));
  plans(tasks, [{ type: "TOOL_CALL_ARGS", toolCallId: "k2", delta: JSON.stringify({ subject: "review", description: "d" }) }, { type: "TOOL_CALL_RESULT", toolCallId: "k2", content: "Task #5 created successfully: review" }], "payloads");
  tasks.map(frame([{ type: "TOOL_CALL_START", toolCallId: "k3", toolCallName: "TaskUpdate" }]));
  const updated = plans(tasks, [{ type: "TOOL_CALL_ARGS", toolCallId: "k3", delta: JSON.stringify({ taskId: "4", status: "completed" }) }], "payloads");
  check("Claude's task tools build the plan one task at a time", JSON.stringify(updated.at(-1)) === JSON.stringify([{ content: "ship", status: "completed", priority: "medium" }, { content: "review", status: "pending", priority: "medium" }]), updated);
  tasks.map(frame([{ type: "TOOL_CALL_START", toolCallId: "k4", toolCallName: "TaskUpdate" }]));
  const deleted = plans(tasks, [{ type: "TOOL_CALL_ARGS", toolCallId: "k4", delta: JSON.stringify({ taskId: "5", status: "deleted" }) }], "payloads");
  check("a deleted task leaves the plan", JSON.stringify(deleted.at(-1)) === JSON.stringify([{ content: "ship", status: "completed", priority: "medium" }]), deleted);

  const cx = new FrameMapper("codex");
  cx.map(frame([{ type: "TOOL_CALL_START", toolCallId: "p1", toolCallName: "update_plan" }]));
  const steps = plans(cx, [{ type: "TOOL_CALL_ARGS", toolCallId: "p1", delta: JSON.stringify({ plan: [{ step: "read", status: "completed" }, { step: "fix", status: "in_progress" }] }) }], "payloads");
  check("Codex's update_plan shows as the plan", JSON.stringify(steps.at(-1)) === JSON.stringify([{ content: "read", status: "completed", priority: "medium" }, { content: "fix", status: "in_progress", priority: "medium" }]), steps);
  const ocp = new FrameMapper("opencode");
  ocp.map(frame([{ type: "TOOL_CALL_START", toolCallId: "q1", toolCallName: "todowrite" }]));
  const ocSteps = plans(ocp, [{ type: "TOOL_CALL_ARGS", toolCallId: "q1", delta: JSON.stringify({ todos: [{ content: "a", status: "pending", priority: "high" }, { content: "b", status: "cancelled", priority: "low" }] }) }], "payloads");
  check("OpenCode's todowrite shows as the plan, without cancelled entries", JSON.stringify(ocSteps.at(-1)) === JSON.stringify([{ content: "a", status: "pending", priority: "high" }]), ocSteps);
  const jc = new FrameMapper("jcode");
  jc.map(frame([{ type: "TOOL_CALL_START", toolCallId: "j1", toolCallName: "todo" }]));
  const jcSteps = plans(jc, [{ type: "TOOL_CALL_ARGS", toolCallId: "j1", delta: JSON.stringify({ intent: "plan", todos: [{ id: "1", content: "a", status: "in_progress", priority: "high", confidence: 0.9 }, { id: "2", content: "b", status: "cancelled" }] }) }], "payloads");
  check("Jcode's todo shows as the plan, without cancelled entries", JSON.stringify(jcSteps.at(-1)) === JSON.stringify([{ content: "a", status: "in_progress", priority: "high" }]), jcSteps);
  const hm = new FrameMapper("hermes");
  hm.map(frame([{ type: "TOOL_CALL_START", toolCallId: "h1", toolCallName: "todo" }]));
  plans(hm, [{ type: "TOOL_CALL_ARGS", toolCallId: "h1", delta: JSON.stringify({ todos: [{ id: "a", content: "read", status: "pending" }, { id: "b", content: "fix", status: "pending" }] }) }], "payloads");
  hm.map(frame([{ type: "TOOL_CALL_START", toolCallId: "h2", toolCallName: "todo" }]));
  const merged = plans(hm, [{ type: "TOOL_CALL_ARGS", toolCallId: "h2", delta: JSON.stringify({ merge: true, todos: [{ id: "a", status: "completed" }, { id: "b", status: "cancelled" }, { id: "c", content: "ship", status: "in_progress" }] }) }], "payloads");
  check("Hermes's todo with merge changes the items it names and adds new ones", JSON.stringify(merged.at(-1)) === JSON.stringify([{ content: "read", status: "completed", priority: "medium" }, { content: "ship", status: "in_progress", priority: "medium" }]), merged);
  hm.map(frame([{ type: "TOOL_CALL_START", toolCallId: "h3", toolCallName: "todo" }]));
  const replaced = plans(hm, [{ type: "TOOL_CALL_ARGS", toolCallId: "h3", delta: JSON.stringify({ todos: [{ id: "z", content: "again", status: "pending" }] }) }], "payloads");
  check("and without merge replaces the list", JSON.stringify(replaced.at(-1)) === JSON.stringify([{ content: "again", status: "pending", priority: "medium" }]), replaced);
}

// Jcode's and Hermes's tools read by kind, with their edits as diffs.
{
  const view = (harness: string, id: string, name: string, args: unknown, at: number) => {
    const fm = new FrameMapper(harness, "/w");
    fm.map(frame([{ type: "TOOL_CALL_ARGS", toolCallId: id, delta: JSON.stringify(args) }], { plane: "payloads", seq: at }));
    return fm.map(frame([{ type: "TOOL_CALL_START", toolCallId: id, toolCallName: name }], { seq: at })).updates[0] as unknown as Record<string, unknown>;
  };
  const jEdit = view("jcode", "je", "edit", { intent: "fix", file_path: "a.ts", edits: [{ old_string: "x", new_string: "y" }] }, 1001);
  check("Jcode 1.x's edit list shows as diffs", jEdit.kind === "edit" && JSON.stringify(jEdit.content) === JSON.stringify([{ type: "diff", path: "/w/a.ts", oldText: "x", newText: "y" }]), jEdit);
  const jRead = view("jcode", "jr", "read", { file_path: "/w/b.ts" }, 1002);
  const jBash = view("jcode", "jb", "bash", { command: "ls" }, 1003);
  check("Jcode's read and bash read by kind", jRead.kind === "read" && jRead.title === "Read /w/b.ts" && jBash.kind === "execute" && jBash.title === "ls", [jRead, jBash]);
  const hPatch = view("hermes", "hp", "patch", { path: "c.ts", old_string: "p", new_string: "q" }, 1004);
  check("Hermes's patch replaces a span by default", hPatch.kind === "edit" && JSON.stringify(hPatch.content) === JSON.stringify([{ type: "diff", path: "/w/c.ts", oldText: "p", newText: "q" }]), hPatch);
  const hEnvelope = view("hermes", "he", "patch", { mode: "patch", patch: "*** Begin Patch\n*** Add File: d.ts\n+new\n*** End Patch" }, 1005);
  check("and with mode patch reads its envelope", JSON.stringify(hEnvelope.content) === JSON.stringify([{ type: "diff", path: "/w/d.ts", oldText: null, newText: "new" }]), hEnvelope);
  const hTerm = view("hermes", "ht", "terminal", { command: "echo ok" }, 1006);
  const hSearch = view("hermes", "hs", "search_files", { pattern: "TODO", path: "src" }, 1007);
  check("Hermes's terminal and search_files read by kind", hTerm.kind === "execute" && hTerm.title === "echo ok" && hSearch.kind === "search", [hTerm, hSearch]);
}

// A patch envelope as diffs.
{
  const diffs = patchDiffs(["*** Begin Patch", "*** Update File: a.ts", "@@", " keep", "-old", "+new", "*** Add File: b.ts", "+fresh", "*** Delete File: c.ts", "*** End Patch"].join("\n"));
  check("a patch reads as one diff per file", JSON.stringify(diffs.map((d) => d.content)) === JSON.stringify([
    { type: "diff", path: "a.ts", oldText: "keep\nold", newText: "keep\nnew" },
    { type: "diff", path: "b.ts", oldText: null, newText: "fresh" },
    { type: "diff", path: "c.ts", oldText: "", newText: "" },
  ]), diffs);
  const cx = new FrameMapper("codex", "/repo");
  cx.map(frame([{ type: "TOOL_CALL_ARGS", toolCallId: "ap", delta: "*** Begin Patch\n*** Update File: src/x.ts\n-a\n+b\n*** End Patch" }], { plane: "payloads", seq: 990 }));
  const patched = cx.map(frame([{ type: "TOOL_CALL_START", toolCallId: "ap", toolCallName: "apply_patch" }], { seq: 990 })).updates[0] as unknown as Record<string, unknown>;
  check("Codex's apply_patch, whose input is not JSON, shows its files as diffs", patched.kind === "edit" && patched.title === "Edit /repo/src/x.ts" && JSON.stringify(patched.content) === JSON.stringify([{ type: "diff", path: "/repo/src/x.ts", oldText: "a", newText: "b" }]), patched);
  const changes = [
    { path: "src/u.ts", kind: { type: "update", move_path: null }, diff: "--- a/src/u.ts\n+++ b/src/u.ts\n@@ -1,2 +1,2 @@\n keep\n-old\n+new" },
    { path: "src/n.ts", kind: { type: "add" }, diff: "fresh" },
    { path: "src/g.ts", kind: { type: "delete" }, diff: "gone" },
  ];
  cx.map(frame([{ type: "TOOL_CALL_ARGS", toolCallId: "ch", delta: JSON.stringify({ changes }) }], { plane: "payloads", seq: 991 }));
  const asked = cx.map(frame([{ type: "TOOL_CALL_START", toolCallId: "ch", toolCallName: "apply_patch" }], { seq: 991 })).updates[0] as unknown as Record<string, unknown>;
  check("a Codex file change approval's change list shows as diffs: an update's hunks, an added or deleted file's contents", asked.title === "Edit 3 files" && JSON.stringify(asked.content) === JSON.stringify([
    { type: "diff", path: "/repo/src/u.ts", oldText: "keep\nold", newText: "keep\nnew" },
    { type: "diff", path: "/repo/src/n.ts", oldText: null, newText: "fresh" },
    { type: "diff", path: "/repo/src/g.ts", oldText: "gone", newText: "" },
  ]), asked);
}

// A manager that does not list its agents hides only its own.
{
  const logged: string[] = [];
  let read: { answered: { instanceId: string; rows: string[] }[]; silent: string[] } | undefined;
  let failed: unknown;
  try { read = answeredReads([{ instanceId: "a", error: new Error("did not answer") }, { instanceId: "b", rows: ["onb"] }], (l) => logged.push(l)); } catch (e) { failed = e; }
  const rows = read?.answered ?? [];
  check("one silent manager leaves the others' agents listed", rows.length === 1 && rows[0]!.instanceId === "b" && rows[0]!.rows[0] === "onb", failed instanceof Error ? failed.message : rows);
  check("and is named as silent, so a miss is not taken for absence", read?.silent.length === 1 && read.silent[0] === "a", read?.silent);
  check("and the silent one is logged by instance", logged.length === 1 && logged[0]!.includes("manager a") && logged[0]!.includes("did not answer"), logged);
  let thrown: unknown;
  try { answeredReads([{ instanceId: "a", error: new Error("first") }, { instanceId: "b", error: new Error("second") }], () => {}); } catch (e) { thrown = e; }
  check("when no manager answered, the first failure is the answer", thrown instanceof Error && thrown.message === "first", thrown);
}

// Which listed managers a person's new thread may start on, and which the bridge reads.
{
  const L = (instanceId: string, placement: "remote" | "local", state: "candidate" | "unknown" | "not open" = "candidate") => ({ instanceId, placement, state });
  const both = managerPlan([L("space", "local"), L("lapb", "remote"), L("lapa", "remote"), L("gone", "remote", "not open")]);
  check("with managers of their own live, new threads start only on those, in a stable order", JSON.stringify(both.launch) === JSON.stringify(["lapa", "lapb"]) && both.why === undefined, both);
  check("and agents are read from them and from the space's manager", JSON.stringify(both.read) === JSON.stringify(["lapa", "lapb", "space"]), both);
  const none = managerPlan([L("space", "local")]);
  check("with none registered, new threads start on the space's manager", JSON.stringify(none.launch) === JSON.stringify(["space"]) && JSON.stringify(none.read) === JSON.stringify(["space"]), none);
  const asleep = managerPlan([L("space", "local"), L("lapa", "remote", "unknown")]);
  check("with managers registered and none live, nothing starts and the reason names each", asleep.launch.length === 0 && String(asleep.why).includes("lapa: unknown") && String(asleep.why).includes("cotal manager start"), asleep);
  check("while the space's manager is still read", JSON.stringify(asleep.read) === JSON.stringify(["space"]), asleep);
  const empty = managerPlan([L("space", "local", "not open")]);
  check("a manager that is not a candidate is neither started on nor read", empty.launch.length === 0 && empty.read.length === 0 && typeof empty.why === "string", empty);
  check("every registration of the person's is their own, whatever its state, and the space's manager is not", JSON.stringify([...both.own].sort()) === JSON.stringify(["gone", "lapa", "lapb"]), both.own);
}

// A listed manager whose rail is gone, such as one that died without deregistering, is not offered.
{
  check("the managers whose rail is not gone are offered", JSON.stringify(runningManagers("s", ["a", "b"], [undefined, "b"])) === JSON.stringify(["b"]));
  let thrown: unknown;
  try { runningManagers("s", ["a", "b"], [undefined, undefined]); } catch (e) { thrown = e; }
  check("with every one gone, the list rejects as a space with no manager, naming them, so a new thread starts one",
    thrown instanceof NoLaunchManager && thrown.message === "No manager for s is running: the broker reports nothing on the rail of a, b.", thrown);
}

// A manager as a choice: only a current presence row describes it, and only the machine it names
// makes it local. HERE stands for this machine's id, THERE for another computer's.
const HERE = "1".repeat(64), THERE = "2".repeat(64);
{
  const row = (id: string, host: string, status: string, machine?: string) => ({ card: { id: `u_p.manager_${id}`, name: id, meta: { host, ...(machine ? { machine } : {}) } }, status }) as unknown as Presence;
  const roster = [row("a", "here", "idle", HERE), row("b", "there", "offline", THERE), row("e", "here", "idle")];
  const a = managerChoice("a", roster, HERE);
  check("a manager with a current row is live, takes its host, and is local when it names this machine", a.live === true && a.host === "here" && a.local === true, a);
  const b = managerChoice("b", roster, THERE);
  check("an offline row makes a manager neither live nor local, and names no host", b.live === false && b.local === false && b.host === undefined, b);
  const c = managerChoice("c", roster, HERE);
  check("a manager with no row is not live", c.live === false && c.local === false && c.host === undefined, c);
  const e = managerChoice("e", roster, HERE);
  check("a row that names no machine is not local, whatever its host", e.live === true && e.local === false && e.host === "here", e);
  const theirs = [({ card: { id: "u_other.manager_d", name: "manager_d", meta: { host: "here", machine: HERE } }, status: "idle" }) as unknown as Presence];
  const d = managerChoice("d", theirs, HERE, "u_p");
  check("on a signed-in space another owner's agent named after the manager does not describe it", d.live === false && d.local === false && d.host === undefined, d);
  const mine = managerChoice("a", roster, HERE, "u_p");
  check("and the person's own manager row still does", mine.live === true && mine.host === "here" && mine.local === true, mine);
}

// A signed-in person's listed manager: the space's own shows a row only under its bare NKey id, so
// what its rail reports describes it.
{
  const nkey = "UCJ2KVYXP6NPUGAZ4ZQ3JVJ6WQ7K5QOFM4ZQXUMOBQ5RYRYTVLRDUJAN";
  const spaceRow = ({ card: { id: nkey, name: "manager", meta: { host: "here", machine: HERE } }, status: "idle" }) as unknown as Presence;
  const own = listedChoice("space", { host: "here", machine: HERE }, [spaceRow], HERE, "u_p");
  check("the space's own manager, whose rail reports this machine, is live and local", own?.live === true && own.local === true && own.host === "here", own);
  const far = listedChoice("space", { host: "there", machine: THERE }, [spaceRow], HERE, "u_p");
  check("and on another machine's report it is live and not local", far?.live === true && far.local === false && far.host === "there", far);
  const nameless = listedChoice("space", { host: "here" }, [spaceRow], HERE, "u_p");
  check("a report that names no machine is not local, whatever its host", nameless?.live === true && nameless.local === false, nameless);
  const quiet = listedChoice("space", {}, [spaceRow], HERE, "u_p");
  check("a rail that reports no host leaves it neither live nor local", quiet?.live === false && quiet.local === false && quiet.host === undefined, quiet);
  check("a gone rail offers nothing", listedChoice("space", undefined, [spaceRow], HERE, "u_p") === undefined);
  const mineRow = ({ card: { id: "u_p.manager_a", name: "manager_a", meta: { host: "here", machine: HERE } }, status: "idle" }) as unknown as Presence;
  const mine = listedChoice("a", {}, [mineRow], HERE, "u_p");
  check("the person's own manager is described by its row", mine?.live === true && mine.local === true && mine.host === "here", mine);
  let starts = 0;
  const listed = await launchManagers({ space: "s", managers: async () => [own!], startManager: async () => (starts++, "started"), machineUnreadable: () => undefined }, () => {}).catch((e: Error) => e);
  check("so a new thread there starts no second manager", starts === 0 && Array.isArray(listed) && listed.length === 1, { starts, listed });
}

// This machine's manager after the machine's host name changed, as macOS renames a machine when its
// network changes: its presence keeps the name it started with, and its status reports the new one.
// Both name the same machine.
{
  const card = { id: "u_p.manager_mac", name: "manager_mac", meta: { host: "mac-home", machine: HERE } };
  const roster = [({ card, status: "idle" }) as unknown as Presence];
  const held = managerChoice("mac", roster, HERE, "u_p");
  check("same machine, different host name: its row reads local", held.live === true && held.local === true, held);
  const listed = listedChoice("mac", { host: "mac-cafe", machine: HERE }, roster, HERE, "u_p");
  check("and as a listed manager it reads local", listed?.live === true && listed.local === true, listed);
  let starts = 0;
  const got = await launchManagers({ space: "s", managers: async () => [listed!], startManager: async () => (starts++, "started"), machineUnreadable: () => undefined }, () => {}).catch((e: Error) => e);
  check("so a new thread starts no second manager", starts === 0 && Array.isArray(got), { starts, got: got instanceof Error ? got.message : got });
}

// The mirror: another machine's manager that shows this machine's host name is not local.
{
  const card = { id: "u_p.manager_twin", name: "manager_twin", meta: { host: "mac-cafe", machine: THERE } };
  const roster = [({ card, status: "idle" }) as unknown as Presence];
  const held = managerChoice("twin", roster, HERE, "u_p");
  check("same host name, other machine: its row does not read local", held.live === true && held.local === false && held.host === "mac-cafe", held);
  const listed = listedChoice("twin", { host: "mac-cafe", machine: THERE }, [], HERE, "u_p");
  check("nor does its rail's report", listed?.live === true && listed.local === false, listed);
  let starts = 0;
  const got = await launchManagers({ space: "s", managers: async () => [listed!], startManager: async () => (starts++, "started"), machineUnreadable: () => undefined }, () => {}).catch((e: Error) => e);
  check("so a new thread starts this machine's manager", starts === 1, { starts, got: got instanceof Error ? got.message : got });
}

// A manager that an older release started names no machine, as a manager service that kept running
// across `cotal update --self` does. This machine's service record for the space names the instance it
// runs here, and that one is local; a manager that names a machine is still decided by it.
{
  const card = (id: string, machine?: string) => ({ card: { id: `u_p.manager_${id}`, name: `manager_${id}`, meta: { host: "mac", ...(machine ? { machine } : {}) } }, status: "idle" }) as unknown as Presence;
  const roster = [card("old"), card("far", THERE)];
  const old = managerChoice("old", roster, HERE, "u_p", "old");
  check("a manager row that names no machine is local when this machine's service record names it", old.live === true && old.local === true, old);
  const other = managerChoice("old", roster, HERE, "u_p", "another");
  check("and not when the record names another instance", other.live === true && other.local === false, other);
  const far = managerChoice("far", roster, HERE, "u_p", "far");
  check("a row that names another machine stays not local, whatever the record says", far.live === true && far.local === false, far);
  const listed = listedChoice("space", { host: "mac" }, [], HERE, "u_p", "space");
  check("a rail report that names no machine is local when the record names the instance", listed?.live === true && listed.local === true, listed);
  let starts = 0;
  const got = await launchManagers({ space: "s", managers: async () => [old], startManager: async () => (starts++, "started"), machineUnreadable: () => undefined }, () => {}).catch((e: Error) => e);
  check("so a new thread starts no second manager beside the older one", starts === 0 && Array.isArray(got) && got.length === 1, { starts, got: got instanceof Error ? got.message : got });
}

// This machine's identity could not be read, as in a container with no /etc/machine-id. A manager a
// thread names is still described, and none reads as this machine's, not even one that names no
// machine either. So a new thread neither defaults to one nor starts one.
{
  const card = { id: "u_p.manager_box", name: "manager_box", meta: { host: "box" } };
  const roster = [({ card, status: "idle" }) as unknown as Presence];
  const held = managerChoice("box", roster, undefined, "u_p");
  check("with this machine's identity unread, a manager row that names no machine is described, live and not local", held.live === true && held.local === false && held.host === "box", held);
  const listed = listedChoice("box", { host: "box" }, [], undefined, "u_p");
  check("nor does a rail's report that names no machine read local", listed?.live === true && listed.local === false, listed);
  const why = "ENOENT: no such file or directory, open '/etc/machine-id'";
  const linux = process.platform === "linux";
  check("a thread with no Machine chosen says why it cannot tell which manager runs here", noMachine("s", why) === (linux
    ? "This machine's identity could not be read (ENOENT: no such file or directory, open '/etc/machine-id'), so Cotal cannot tell which manager runs here. Create /etc/machine-id with `systemd-machine-id-setup` and open a new thread, or choose a machine in the Machine option."
    : "This machine's identity could not be read (ENOENT: no such file or directory, open '/etc/machine-id'), so Cotal cannot tell which manager runs here. Choose a machine in the Machine option."), noMachine("s", why));
  let starts = 0;
  const space = (managers: ManagerChoice[]) => ({ space: "s", managers: async () => managers, startManager: async () => (starts++, "started"), machineUnreadable: () => why });
  const got = await launchManagers(space([listed!]), () => {}).catch((e: Error) => e);
  check("so a new thread starts no manager and offers the listed one", starts === 0 && Array.isArray(got) && got.length === 1 && got[0]!.instanceId === "box", { starts, got: got instanceof Error ? got.message : got });
  const none = await launchManagers(space([]), () => {}).catch((e: Error) => e);
  check("with none listed, the new thread fails with the reason and starts none", starts === 0 && none instanceof NoLaunchManager && none.message === (linux
    ? "This machine's identity could not be read (ENOENT: no such file or directory, open '/etc/machine-id'), so Cotal cannot tell which manager runs here and starts none. Create /etc/machine-id with `systemd-machine-id-setup` and open a new thread, or start a manager with `cotal manager start --space s` and choose it in the Machine option."
    : "This machine's identity could not be read (ENOENT: no such file or directory, open '/etc/machine-id'), so Cotal cannot tell which manager runs here and starts none. Start a manager with `cotal manager start --space s` and choose it in the Machine option."), { starts, none: none instanceof Error ? none.message : none });
}

// Remote live, no local: only another computer's manager is live, so this machine's is started.
{
  const far: ManagerChoice = { instanceId: "far", host: "there", local: false, live: true };
  const near: ManagerChoice = { instanceId: "near", host: "here", local: true, live: true };
  const line = "Started this machine's manager for s. It stops itself after 10 minutes with no agents.";
  const space = (after: ManagerChoice[], start = async () => line) => {
    let listed = [far];
    const counts = { starts: 0, reads: 0 };
    return { counts, space: "s", managers: async () => (counts.reads++, listed), startManager: async () => { counts.starts++; const said = await start(); listed = after; return said; }, machineUnreadable: () => undefined };
  };
  const lines: string[] = [];
  const s1 = space([near, far]);
  const got = await launchManagers(s1, (l) => lines.push(l)).catch((e: Error) => e);
  check("remote live, no local: this machine's manager is started and the list read again",
    s1.counts.starts === 1 && s1.counts.reads === 2 && JSON.stringify(Array.isArray(got) ? got.map((m) => m.instanceId) : got) === JSON.stringify(["near", "far"]) && JSON.stringify(lines) === JSON.stringify([line]), { counts: s1.counts, got, lines });
  const again = await launchManagers(s1, (l) => lines.push(l)).catch((e: Error) => e);
  check("with this machine's manager listed, nothing starts and nothing is said", s1.counts.starts === 1 && Array.isArray(again) && again.length === 2 && lines.length === 1, { counts: s1.counts, again });
  const s2 = space([far]);
  const unlisted = await launchManagers(s2, () => {}).catch((e: Error) => e);
  check("a start after which no manager here is listed fails the thread, saying so",
    unlisted instanceof NoLaunchManager && unlisted.message === "Started this machine's manager for s, but the space does not list it as running here yet. Open the thread again in a moment.", unlisted);
  const s3 = space([near, far], async () => { throw new NoLaunchManager("Could not start this machine's manager for s: boom"); });
  const failed = await launchManagers(s3, () => {}).catch((e: Error) => e);
  check("a failed start fails the thread with its reason", failed instanceof NoLaunchManager && failed.message === "Could not start this machine's manager for s: boom", failed);
}

// An application whose catalog has a model with the id `default`, as a Hermes endpoint can: the value
// `<agent>/default` already means the application's own default, so it is one choice.
{
  const offer: Offer = { personas: [], channels: [], managers: [], catalogs: [{ agent: "hermes", available: true, eventPlane: true,
    models: [{ id: "a", variants: ["high"] }, { id: "default", name: "default", variants: ["high"] }] }] };
  const selection = initialSelection(offer);
  const select = configOptions(offer, selection).find((o) => o.id === "model") as unknown as { options: { options: { value: string }[] }[] };
  const values = select.options.flatMap((g) => g.options.map((o) => o.value));
  check("a catalog model named default does not list <agent>/default twice", values.filter((v) => v === "hermes/default").length === 1, values);
  const listed = modelState(offer, selection).availableModels.map((m) => m.modelId);
  check("nor does the session's model state", listed.filter((v) => v === "hermes/default").length === 1, listed);
}

// That model is the application's default choice, with its name and reasoning variants. A Hermes
// provider that lists an id `default` gives it Hermes's efforts, as every model it lists.
{
  const row = { agent: "hermes", state: "available", eventPlane: true };
  const offerOf = (models: unknown[]): Offer => ({ personas: [], channels: [], managers: [], catalogs: agentCatalogs([row], [{ agent: "hermes", supported: true, models }] as never) });
  const offer = offerOf([{ id: "a", variants: [{ name: "low" }] }, { id: "default", name: "Hermes pick", variants: [{ name: "high" }] }]);
  const selection = initialSelection(offer);
  const own = modelState(offer, selection).availableModels.find((m) => m.modelId === "hermes/default");
  const efforts = (own?._meta.reasoningEfforts as { value: string }[] | undefined)?.map((e) => e.value);
  check("the model state gives <agent>/default that model's name and reasoning variants", own?.name === "hermes: Hermes pick" && JSON.stringify(efforts) === JSON.stringify(["default", "high"]), own);
  const select = configOptions(offer, selection).find((o) => o.id === "model") as unknown as { options: { options: { value: string; name: string }[] }[] };
  const choice = select.options.flatMap((g) => g.options).find((o) => o.value === "hermes/default");
  check("and so does the model select", choice?.name === "hermes: Hermes pick", choice);
  let variant: string;
  try {
    variant = applyOption(offer, selection, "reasoning", "high").variant;
  } catch (e) {
    variant = (e as Error).message;
  }
  check("one of its variants can be chosen on <agent>/default", variant === "high", variant);
  const alone = offerOf([{ id: "default", variants: [{ name: "high" }] }]);
  const reasoning = configOptions(alone, initialSelection(alone)).find((o) => o.id === "reasoning") as unknown as { options: { value: string }[] } | undefined;
  check("where it is the only model, the Reasoning select holds its variants", JSON.stringify(reasoning?.options.map((o) => o.value)) === JSON.stringify(["default", "high"]), reasoning);
  // The Manager checks a variant against the model a launch names, or the catalog's marked default
  // when it names none, so a variant chosen on <agent>/default launches naming the model it came from.
  const chosen = applyOption(offer, selection, "reasoning", "high");
  check("a variant chosen on <agent>/default launches naming the model default, with that variant", spawnModel(offer, chosen.model) === "default" && chosen.variant === "high", chosen);
  const plainOffer = offerOf([{ id: "a", variants: [{ name: "low" }] }]);
  check("where no catalog model is named default, <agent>/default launches naming no model", spawnModel(plainOffer, initialSelection(plainOffer).model) === undefined);
  check("a named model launches as itself", spawnModel(offer, "hermes/a") === "a");
}

// A Jcode whose `jcode model list` lists models, as its catalog reads them on an install with no
// config.toml: the manager's row carries those ids, and the application is offered with them.
{
  const catalogs = agentCatalogs([{ agent: "jcode", state: "available", eventPlane: true }], [
    { agent: "jcode", supported: true, source: "jcode model list --json", models: [{ id: "gpt-5.4", provider: "fakeprov" }, { id: "glm-4.7" }] },
  ] as never);
  const offer: Offer = { personas: [], channels: [], managers: [], catalogs };
  const select = configOptions(offer, initialSelection(offer)).find((o) => o.id === "model") as unknown as { options: { options: { value: string }[] }[] };
  const values = select.options.flatMap((g) => g.options.map((o) => o.value));
  check("a Jcode whose catalog lists models is offered with them",
    refusal(catalogs, "jcode") === undefined && JSON.stringify(values) === JSON.stringify(["jcode/default", "jcode/gpt-5.4", "jcode/glm-4.7"]), { catalogs, values });
}

// A manager whose read of an application's models failed, as OpenCode 1.19.6 refusing its database:
// the models row carries the error, and the application is refused with it.
{
  const row = (agent: string) => ({ agent, state: "available", eventPlane: true });
  const why = "Database is not empty and has no session table";
  const catalogs = agentCatalogs([row("opencode"), row("pi")], [
    { agent: "opencode", supported: true, models: [], error: why },
    { agent: "pi", supported: false, models: [] },
  ] as never);
  check("an application whose models could not be read is refused with the read's reason", refusal(catalogs, "opencode")?.includes(why) === true, catalogs);
  check("one with no model list to read is not, and keeps its default alone", refusal(catalogs, "pi") === undefined && catalogs[1]?.models.length === 0, catalogs);
}

// Which unanswered replies name the deregister command.
{
  const own = new Set(["lapa"]);
  const silence = { ok: false, unanswered: true };
  check("an unanswered read of the person's own registration names it", namesDeregister("ps", "lapa", own, silence) && namesDeregister("models", "lapa", own, silence));
  check("an unanswered start does not, since the manager may have accepted it", !namesDeregister("start", "lapa", own, silence));
  check("the space's own manager does not, since it is not the person's registration", !namesDeregister("ps", "space", own, silence));
  check("a refusal does not, since the manager answered", !namesDeregister("ps", "lapa", own, { ok: false }));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
