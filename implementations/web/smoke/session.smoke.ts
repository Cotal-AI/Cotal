/**
 * An agent's session, folded: `client/src/lib/session.ts` turns AG-UI frames and the agent's own
 * verified posts into the steps the session view draws.
 *
 * WHAT IT DRIVES. The module is imported by source path, as the client bundle imports it, and every
 * cell calls it on a small synthetic frame list. Core is imported here, and only here, to check that
 * `eventChannelAgent` agrees with `eventChannelPrincipal`: the module restates that grammar because
 * the client cannot load core, so this suite is what holds the two together.
 *
 * WHAT IT DOES NOT CLAIM. It renders nothing; the session parts have their own suite. Agreement with
 * the two text renderers is `agui-render-parity.smoke.ts`'s fold cell, not this file's.
 *
 * Run: pnpm smoke:web-session
 */
import { eventChannelPrincipal } from "@cotal-ai/core";
import type { CotalMessage } from "../client/src/api/types.js";
import type { StoredMessage } from "../client/src/state/types.js";
import {
  SESSION_EVENT_CAP,
  eventChannelAgent,
  eventCount,
  foldSession,
  framesOf,
  toolGroupLabel,
  toolShortName,
  type SessionFrame,
  type SessionStep,
  type ToolCall,
} from "../client/src/lib/session.js";

let cells = 0;
let failed = 0;
const ok = (name: string, cond: boolean, detail?: unknown): void => {
  cells++;
  if (cond) {
    console.log(`  ok ${name}`);
    return;
  }
  failed++;
  console.log(`  x FAIL  ${name}${detail === undefined ? "" : `: ${JSON.stringify(detail)}`}`);
};

// ── Builders ─────────────────────────────────────────────────────────────────────────────────────
const at = (h: number, m: number) => Date.UTC(2026, 9, 17, h, m);
const T0 = at(10, 38);
const frame = (id: string, events: unknown[], ts = T0, live = false): SessionFrame => ({ id, ts, events, live });
const stamp = (ts?: number) => (ts === undefined ? {} : { timestamp: ts });

const started = (turnSource?: string, ts?: number) => ({
  type: "RUN_STARTED", threadId: "t", runId: "r",
  ...(turnSource === undefined ? {} : { cotal: { turnSource } }), ...stamp(ts),
});
const finished = (ts?: number) => ({ type: "RUN_FINISHED", threadId: "t", runId: "r", ...stamp(ts) });
/** A whole text stream, or with `end: false` one that never sees its END. */
const text = (id: string, body: string, o: { role?: string; ts?: number; end?: boolean } = {}) => [
  { type: "TEXT_MESSAGE_START", messageId: id, ...(o.role === undefined ? {} : { role: o.role }), ...stamp(o.ts) },
  { type: "TEXT_MESSAGE_CONTENT", messageId: id, delta: body, ...stamp(o.ts) },
  ...(o.end === false ? [] : [{ type: "TEXT_MESSAGE_END", messageId: id, ...stamp(o.ts) }]),
];
/** A call's START and END. `name` undefined leaves `toolCallName` out of the event entirely. */
const call = (id: string, name: string | undefined, ts?: number) => [
  { type: "TOOL_CALL_START", toolCallId: id, ...(name === undefined ? {} : { toolCallName: name }), ...stamp(ts) },
  { type: "TOOL_CALL_END", toolCallId: id, ...stamp(ts) },
];
const post = (id: string, ts: number, body: string): StoredMessage => ({
  msg: { id, ts, space: "s", from: { id: "local.engine", name: "engine" }, parts: [{ kind: "text", text: body }], channel: "team" } as CotalMessage,
  senderId: "local.engine",
});

/** The steps as one short string: `tools(n)` for a group, `turn(<source>)` for a turn line. */
const shape = (steps: SessionStep[]) =>
  steps.map((s) => (s.kind === "tools" ? `tools(${s.calls.length})` : s.kind === "turn" ? `turn(${s.source ?? ""})` : s.kind)).join(" ");
const calls = (...names: string[]): ToolCall[] => names.map((n) => ({ name: n, full: n }));

// ── 1. The shape of a turn ───────────────────────────────────────────────────────────────────────
{
  const steps = foldSession([frame("f1", [
    started("human"),
    ...text("p", "You are engine.", { role: "user" }),
    ...text("a", "I'll check #team first."),
    ...call("c1", "Bash"), ...call("c2", "mcp__plugin_cotal_cotal__cotal_inbox"),
    ...text("b", "Nothing on #team yet."),
    ...call("c3", "Write"),
    finished(),
  ])], []);
  ok("grouping: a turn by a prompt, a prompt, a said paragraph, two calls, text, one call and a turn end give turn(prompt) prompt said tools(2) said tools(1) turnEnd",
    shape(steps) === "turn(prompt) prompt said tools(2) said tools(1) turnEnd", shape(steps));
  const first = steps.find((s) => s.kind === "tools");
  ok("a group keeps each call's short and full name, in call order",
    first?.kind === "tools" && first.calls.map((c) => `${c.name}|${c.full}`).join(",") === "Bash|Bash,cotal_inbox|mcp__plugin_cotal_cotal__cotal_inbox",
    first);
  const prompt = steps.find((s) => s.kind === "prompt");
  ok("a START with role user gives a prompt carrying its text", prompt?.kind === "prompt" && prompt.text === "You are engine." && !prompt.cut, prompt);
}
{
  const steps = foldSession([frame("f1", [...call("c1", "Read"), finished(), ...call("c2", "Read")])], []);
  ok("a turn line ends a group", shape(steps) === "tools(1) turnEnd tools(1)", shape(steps));
}
{
  const steps = foldSession([frame("f1", [
    ...call("c1", "Read"),
    { type: "TOOL_CALL_ARGS", toolCallId: "c1", delta: "{}" },
    { type: "TOOL_CALL_RESULT", toolCallId: "c1", content: "ok" },
    ...call("c2", "Read"),
  ])], []);
  ok("args and a result draw nothing and do not end a group", shape(steps) === "tools(2)", shape(steps));
}
{
  const steps = foldSession([frame("f1", [...text("a", "one", { end: false })]), frame("f2", [...call("c1", "Bash")])], []);
  ok("a stream with no END lands at the end of the fold, after a call that came later", shape(steps) === "tools(1) said", shape(steps));
}

// ── 2. Turn sources ──────────────────────────────────────────────────────────────────────────────
const sourceOf = (turnSource?: string) => {
  const s = foldSession([frame("f", [started(turnSource)])], [])[0];
  return s?.kind === "turn" ? s.source : "not a turn";
};
ok("turn source: a channel turn has source mesh", sourceOf("channel") === "mesh", sourceOf("channel"));
ok("turn source: an absent turnSource has none", sourceOf(undefined) === undefined, sourceOf(undefined));
ok("turn source: human and sdk give prompt", sourceOf("human") === "prompt" && sourceOf("sdk") === "prompt", [sourceOf("human"), sourceOf("sdk")]);
ok("turn source: auto-continuation gives continuation", sourceOf("auto-continuation") === "continuation", sourceOf("auto-continuation"));
ok("turn source: notification gives notification", sourceOf("notification") === "notification", sourceOf("notification"));
ok("turn source: unknown, a stranger and a prototype key give none",
  sourceOf("unknown") === undefined && sourceOf("task-notification") === undefined && sourceOf("constructor") === undefined,
  [sourceOf("unknown"), sourceOf("task-notification"), sourceOf("constructor")]);
{
  const s = foldSession([frame("f", [{ type: "RUN_STARTED", cotal: { turnSource: 7 } }, { type: "RUN_STARTED", cotal: "channel" }])], []);
  ok("turn source: a non-string turnSource and a non-object cotal give none", s.every((x) => x.kind === "turn" && x.source === undefined), s);
}

// ── 3. Tool group labels ─────────────────────────────────────────────────────────────────────────
{
  const g = toolGroupLabel(calls("Bash", "cotal_inbox", "Bash", "cotal_inbox"));
  ok("Bash, cotal_inbox, Bash, cotal_inbox is \"Checked the inbox 2 times\" with \"4 tool calls\"",
    g.label === "Checked the inbox 2 times" && g.names === "4 tool calls", g);
}
{
  const g = toolGroupLabel(calls("Bash", "cotal_inbox"));
  ok("Bash, cotal_inbox is \"2 tool calls\" with \"Bash, cotal_inbox\"", g.label === "2 tool calls" && g.names === "Bash, cotal_inbox", g);
}
{
  const g = toolGroupLabel(calls("Edit", "Edit"));
  ok("Edit, Edit keeps both names", g.label === "2 tool calls" && g.names === "Edit, Edit", g);
}
{
  const g = toolGroupLabel(calls("Read"));
  ok("one call is \"1 tool call\"", g.label === "1 tool call" && g.names === "Read", g);
}
{
  const g = toolGroupLabel(calls("cotal_inbox", "Read", "cotal_inbox"));
  ok("a call other than cotal_inbox or Bash keeps the plain count", g.label === "3 tool calls" && g.names === "cotal_inbox, Read, cotal_inbox", g);
}
{
  const g = toolGroupLabel(calls("cotal_inbox", "cotal_inbox", "cotal_inbox"));
  ok("three inbox polls alone are \"Checked the inbox 3 times\"", g.label === "Checked the inbox 3 times" && g.names === "3 tool calls", g);
}

// ── 4. Tool names: absent versus empty ───────────────────────────────────────────────────────────
const toolOf = (name: string | undefined) => {
  const s = foldSession([frame("f", call("c", name))], [])[0];
  return s?.kind === "tools" ? s.calls[0] : undefined;
};
ok("tool name: an absent toolCallName is ?", toolOf(undefined)?.full === "?" && toolOf(undefined)?.name === "?", toolOf(undefined));
ok("tool name: an empty toolCallName is \"\", kept apart from an absent one", toolOf("")?.full === "" && toolOf("")?.name === "", toolOf(""));
{
  const s = foldSession([frame("f", [{ type: "TOOL_CALL_START", toolCallId: "c", toolCallName: { a: 1 } }])], [])[0];
  ok("tool name: a non-string toolCallName is ?", s?.kind === "tools" && s.calls[0].full === "?", s);
}
ok("toolShortName(mcp__plugin_cotal_cotal__cotal_inbox) is cotal_inbox", toolShortName("mcp__plugin_cotal_cotal__cotal_inbox") === "cotal_inbox");
ok("toolShortName(Bash) stays Bash", toolShortName("Bash") === "Bash");

// ── 5. Posts, placed by time ─────────────────────────────────────────────────────────────────────
{
  const frames = [
    frame("f1", [...call("c1", "Bash", at(10, 57)), ...call("c2", "mcp__plugin_cotal_cotal__cotal_send", at(10, 58))], at(10, 58)),
    frame("f2", [...text("t", "Done for now.", { ts: at(10, 59) })], at(10, 59)),
  ];
  const steps = foldSession(frames, [post("m1", at(10, 58), "app/chess.js is ready.")]);
  const group = steps[0];
  ok("post placement: a post at 10:58 between cotal_send at 10:58 and text at 10:59 lands between them and splits nothing it should not",
    shape(steps) === "tools(2) post said" && group?.kind === "tools" && group.calls.map((c) => c.name).join(",") === "Bash,cotal_send",
    shape(steps));
  const p = steps[1];
  ok("a post carries its channel and the message itself", p?.kind === "post" && p.channel === "team" && p.msg.id === "m1", p);
}
{
  const frames = [frame("f1", [...call("c1", "Bash", at(10, 57)), ...call("c2", "Bash", at(10, 59))])];
  const steps = foldSession(frames, [post("m1", at(10, 58), "between")]);
  ok("a post between two calls ends the group and joins neither half", shape(steps) === "tools(1) post tools(1)", shape(steps));
}
{
  const steps = foldSession([frame("f1", [started("human", at(10, 0))])], [post("m2", at(11, 0), "b"), post("m1", at(9, 0), "a")]);
  ok("posts are ordered by time, before and after the frame steps", steps.map((s) => (s.kind === "post" ? s.msg.id : s.kind)).join(" ") === "m1 turn m2",
    steps.map((s) => s.kind));
}
{
  const dm = { msg: { id: "d1", ts: at(10, 0), space: "s", from: { id: "local.engine", name: "engine" }, parts: [], to: "x" } as CotalMessage, senderId: "local.engine" };
  ok("a message with no channel is never a post row", foldSession([], [dm]).length === 0);
}

// ── 6. Streams, errors and named markers ─────────────────────────────────────────────────────────
{
  const steps = foldSession([frame("f", text("a", "half a sent", { end: false }))], []);
  const s = steps[0];
  ok("an unterminated text stream ends cut: true", steps.length === 1 && s.kind === "said" && s.text === "half a sent" && s.cut === true, steps);
  const whole = foldSession([frame("f", text("a", "whole"))], [])[0];
  ok("a terminated stream is not cut", whole?.kind === "said" && whole.cut === false, whole);
}
ok("an empty text gives no item", foldSession([frame("f", text("a", ""))], []).length === 0);
{
  const steps = foldSession([frame("f", [{ type: "RUN_ERROR", message: "run failed", code: "E_X" }])], []);
  ok("RUN_ERROR gives runError and no text from its message",
    shape(steps) === "runError" && !JSON.stringify(steps).includes("run failed") && !JSON.stringify(steps).includes("E_X"), steps);
}
{
  const steps = foldSession([frame("f", [{ type: "CUSTOM", name: "checkpoint" }, { type: "CUSTOM" }, { type: "CUSTOM", name: "" }, { type: "STATE_SNAPSHOT" }])], []);
  const labels = steps.map((s) => (s.kind === "unknown" ? s.label : s.kind));
  ok("CUSTOM and an unknown type are named",
    labels.join("|") === "Custom event checkpoint|Custom event (unnamed)|Custom event |Unrecognised event STATE_SNAPSHOT", labels);
}
{
  const steps = foldSession([frame("f", [started("human"), null, 42, { type: 5 }, ...text("a", "after"), finished()])], []);
  const labels = steps.map((s) => (s.kind === "unknown" ? s.label : s.kind));
  ok("a null event is named and the events after it still fold",
    labels.join("|") === "turn|Unrecognised event null|Unrecognised event null|Unrecognised event null|said|turnEnd", labels);
}
{
  const steps = foldSession([frame("f", [
    { type: "REASONING_MESSAGE_START", messageId: "n" },
    { type: "REASONING_MESSAGE_CONTENT", messageId: "n", delta: "step one" },
    { type: "REASONING_MESSAGE_END", messageId: "n" },
    { type: "REASONING_MESSAGE_CONTENT", messageId: "m", delta: "cut off" },
  ])], []);
  ok("reasoning accumulates like text, and a cut one is marked",
    steps.length === 2 && steps[0].kind === "reasoning" && steps[0].text === "step one" && !steps[0].cut &&
      steps[1].kind === "reasoning" && steps[1].text === "cut off" && steps[1].cut, steps);
}

// ── 7. Ids that a plain object would mishandle ───────────────────────────────────────────────────
{
  const steps = foldSession([frame("f", [
    ...text("10", "ten", { end: false }),
    ...text("2", "two", { end: false }),
    ...text("__proto__", "proto", { end: false }),
  ])], []);
  const got = steps.map((s) => (s.kind === "said" ? s.text : s.kind));
  ok("ids \"2\", \"10\" and \"__proto__\" fold in insertion order and none is lost", got.join(",") === "ten,two,proto", got);
}
{
  const steps = foldSession([frame("f", [
    { type: "TEXT_MESSAGE_START", messageId: "a" },
    { type: "TEXT_MESSAGE_START", messageId: "b" },
    { type: "TEXT_MESSAGE_CONTENT", messageId: "a", delta: "AAA" },
    { type: "TEXT_MESSAGE_CONTENT", messageId: "b", delta: "BBB" },
    { type: "TEXT_MESSAGE_START", messageId: "a" },
    { type: "TEXT_MESSAGE_CONTENT", messageId: "a", delta: "again" },
  ])], []);
  const got = steps.map((s) => (s.kind === "said" ? s.text : s.kind));
  ok("a second START empties its stream and keeps its first place", got.join(",") === "again,BBB", got);
}
{
  const steps = foldSession([frame("f", [{ type: "TEXT_MESSAGE_START" }, { type: "TEXT_MESSAGE_CONTENT", delta: "keyless" }, { type: "TEXT_MESSAGE_END" }])], []);
  ok("an absent messageId is the \"\" stream", shape(steps) === "said" && steps[0].kind === "said" && steps[0].text === "keyless", steps);
}

// ── 8. framesOf ──────────────────────────────────────────────────────────────────────────────────
const message = (parts: unknown[], id = "m1"): CotalMessage =>
  ({ id, ts: T0, space: "s", from: { id: "local.engine", name: "engine" }, parts, channel: "events.local.engine" }) as unknown as CotalMessage;
{
  const frames = framesOf(message([{ kind: "text", text: "a plain line" }]), true);
  const steps = foldSession(frames, []);
  ok("a message with a text part and no frame part yields one unknown step",
    steps.length === 1 && steps[0].kind === "unknown" && steps[0].label === "a plain line" && steps[0].live, steps);
}
{
  const f1 = { kind: "ag-ui.frame", events: [started("human")] };
  const f2 = { kind: "ag-ui.frame", events: [finished()] };
  const frames = framesOf(message([f1, { kind: "text", text: "ignored" }, f2]), false);
  ok("framesOf gives one frame per frame part, the first keyed by the message id",
    frames.length === 2 && frames[0].id === "m1" && frames[1].id === "m1#1" && frames[0].ts === T0 && !frames[0].live,
    frames.map((f) => f.id));
  ok("a message's frames fold in part order", shape(foldSession(frames, [])) === "turn(prompt) turnEnd");
}
{
  const steps = foldSession(framesOf(message([{ kind: "ag-ui.frame", events: [] }, { kind: "ag-ui.frame", events: "nope" }]), false), []);
  ok("a frame part with no events is named, never dropped",
    steps.length === 2 && steps.every((s) => s.kind === "unknown" && s.label === "A frame with no events"), steps);
}

// ── 9. Keys, times and live ──────────────────────────────────────────────────────────────────────
{
  const input = (): SessionFrame[] => [
    frame("f1", [started("human"), ...text("p", "go", { role: "user" }), ...call("c1", "Bash"), ...call("c2", "Bash"), ...text("a", "x", { end: false })]),
    frame("f2", [null, { type: "CUSTOM", name: "n" }, finished()]),
  ];
  const posts = [post("m1", T0, "hi")];
  const a = foldSession(input(), posts).map((s) => s.key);
  const b = foldSession(input(), posts).map((s) => s.key);
  ok("keys are equal across two folds of the same input", a.join("|") === b.join("|") && a.length === 8, [a, b]);
  ok("keys are unique within a fold", new Set(a).size === a.length, a);
}
{
  const steps = foldSession([frame("f", [{ type: "RUN_STARTED", timestamp: at(10, 40) }, { type: "RUN_FINISHED", timestamp: Number.NaN }], at(10, 45))], []);
  ok("a step's time is the event's timestamp when finite, else the frame's ts",
    steps[0].kind === "turn" && steps[0].ts === at(10, 40) && steps[1].kind === "turnEnd" && steps[1].ts === at(10, 45), steps);
}
{
  const live = foldSession([frame("f1", call("c1", "Bash"), T0, true), frame("f2", text("a", "x"), T0, true)], []);
  ok("an item whose frames all arrived live is live", live.every((s) => s.live), live);
  const mixed = foldSession([
    frame("f1", [{ type: "TEXT_MESSAGE_START", messageId: "a" }, { type: "TEXT_MESSAGE_CONTENT", messageId: "a", delta: "x" }], T0, false),
    frame("f2", [{ type: "TEXT_MESSAGE_END", messageId: "a" }, ...call("c1", "Bash")], T0, true),
    frame("f3", call("c2", "Bash"), T0, false),
  ], []);
  ok("an item with one frame from history is not live", mixed.length === 2 && !mixed[0].live && !mixed[1].live, mixed);
}

// ── 10. Counting ─────────────────────────────────────────────────────────────────────────────────
ok("eventCount sums the events across frames", eventCount([frame("a", [1, 2]), frame("b", []), frame("c", [3])]) === 3);
ok("SESSION_EVENT_CAP is 2000", SESSION_EVENT_CAP === 2000);

// ── 11. eventChannelAgent agrees with core ───────────────────────────────────────────────────────
const CHANNELS = [
  "events.local.abc", "events.standup", "events.my-team.notes", "events.a.b.c", "events.a.b-c",
  "events.A_1.b_2", "events._._", "events.", "events..", "events.a.", "events..b", "Events.a.b",
  "x.events.a.b", "events.a.b ", " events.a.b", "events.a.b\n", "events.é.b", "events.a.b.", "team", "",
];
const disagree = CHANNELS.filter((c) => {
  const p = eventChannelPrincipal(c);
  return eventChannelAgent(c) !== (p === null ? undefined : `${p.owner}.${p.actor}`);
});
ok("eventChannelAgent agrees with core's eventChannelPrincipal over the corpus", disagree.length === 0, disagree);
ok("CONTROL: the corpus holds channels on both sides of the line",
  CHANNELS.some((c) => eventChannelPrincipal(c) !== null) && CHANNELS.some((c) => eventChannelPrincipal(c) === null));
ok("events.local.abc names local.abc", eventChannelAgent("events.local.abc") === "local.abc");

console.log(`\nsession: ${cells - failed} of ${cells} cells green`);
if (failed > 0) process.exit(1);
