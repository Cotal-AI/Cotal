/**
 * An agent's work, folded: `client/src/lib/session.ts` turns AG-UI frames and the agent's own
 * verified posts and DMs into the flat steps the session view draws (`foldSession`) and into turns
 * holding steps (`foldWork`), and gives each call, group and turn its state, words and duration.
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
  callDescription,
  callState,
  callTitle,
  eventChannelAgent,
  eventCount,
  foldSession,
  foldWork,
  formatDuration,
  framesOf,
  groupDescription,
  groupTitle,
  toolGroupLabel,
  toolKind,
  toolShortName,
  turnDescription,
  turnTitle,
  type CallState,
  type SessionFrame,
  type SessionStep,
  type ToolCall,
  type Turn,
  type WorkItem,
  type WorkStep,
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
const calls = (...names: string[]): ToolCall[] =>
  names.map((n, i) => ({ key: `k${i}`, id: `c${i}`, name: n, full: n, kind: toolKind(n), live: false }));

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
  const odd = (id: string, ts: unknown) => ({ ...post(id, 0, id), msg: { ...post(id, 0, id).msg, ts } as unknown as CotalMessage });
  const steps = foldSession([frame("f1", [started("human", at(10, 0))])], [odd("nan", Number.NaN), odd("str", "5"), post("m1", at(9, 0), "a"), odd("inf", Infinity)]);
  ok("a post whose ts is not a finite number goes last, in arrival order",
    steps.map((s) => (s.kind === "post" ? s.msg.id : s.kind)).join(" ") === "m1 turn nan str inf", steps.map((s) => (s.kind === "post" ? s.msg.id : s.kind)));
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
    labels.join("|") === 'Custom event "checkpoint"|Custom event (unnamed)|Custom event ""|Unrecognised event "STATE_SNAPSHOT"', labels);
}
{
  const steps = foldSession([frame("f", [{ type: "CUSTOM", name: "" }, { type: "" }, { type: "CUSTOM", name: 7 }])], []);
  const labels = steps.map((s) => (s.kind === "unknown" ? s.label : s.kind));
  ok("an empty type or name is quoted, never a label that ends in a bare space",
    labels.join("|") === 'Custom event ""|Unrecognised event ""|Custom event (unnamed)' && labels.every((l) => !l.endsWith(" ")), labels);
}
{
  const steps = foldSession([frame("f", [
    started("human"), ...text("a", "half a sent", { end: false }), finished(),
    started("channel"), { type: "REASONING_MESSAGE_CONTENT", messageId: "n", delta: "thinking" }, { type: "RUN_ERROR" },
    started("human"), ...text("b", "next", { end: false }), started("human"),
  ])], []);
  const cut = steps.filter((s) => (s.kind === "said" || s.kind === "reasoning") && s.cut).length;
  ok("a stream open when its turn ends is drawn cut inside the turn",
    shape(steps) === "turn(prompt) said turnEnd turn(mesh) reasoning runError turn(prompt) said turn(prompt)" && cut === 3, shape(steps));
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
  const framed = [{ kind: "ag-ui.frame", events: [started("human")] }];
  const ids: unknown[] = [7, null, undefined, { toString: () => "m1" }];
  const got = ids.map((id) => framesOf({ ...message(framed), id } as unknown as CotalMessage, true).length);
  const control = framesOf(message(framed, "7"), true).map((f) => f.id);
  ok("a message whose id is not a string gives no frames, so it can never share a key with another message",
    JSON.stringify(got) === JSON.stringify([0, 0, 0, 0]) && JSON.stringify(control) === JSON.stringify(["7"]), { got, control });
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

// ── 12. foldWork: turns ──────────────────────────────────────────────────────────────────────────
/** A time on the reader's own clock, so an expected `hh:mm` holds in any time zone. */
const L = (h: number, m: number, s = 0) => new Date(2026, 9, 17, h, m, s).getTime();
const marker = (id: string, isError: boolean, ts?: number) => ({ type: "CUSTOM", name: "cotal.toolResult", value: { toolCallId: id, isError }, ...stamp(ts) });
const runError = (ts?: number) => ({ type: "RUN_ERROR", message: "run failed", ...stamp(ts) });
const dm = (id: string, ts: number, to: string): StoredMessage => ({
  msg: { id, ts, space: "s", from: { id: "local.engine", name: "engine" }, parts: [{ kind: "text", text: "a dm" }], to } as CotalMessage,
  senderId: "local.engine",
});

/** Items as one short string; a turn shows its outcome and its steps in brackets. */
const work = (items: readonly WorkItem[]): string =>
  items.map((i) =>
    i.kind === "turn" ? `turn(${i.outcome}${i.superseded ? ",superseded" : ""})[${work(i.steps)}]`
      : i.kind === "tools" ? `tools(${i.calls.length})`
        : i.kind).join(" ");
const turns = (items: readonly WorkItem[]): Turn[] => items.filter((i): i is Turn => i.kind === "turn");
const allCalls = (items: readonly WorkItem[]): ToolCall[] =>
  items.flatMap((i) => (i.kind === "turn" ? allCalls(i.steps) : i.kind === "tools" ? i.calls : []));
const allKeys = (items: readonly WorkItem[]): string[] =>
  items.flatMap((i) => [i.key, ...(i.kind === "turn" ? allKeys(i.steps) : i.kind === "tools" ? i.calls.map((c) => `call ${c.key}`) : [])]);
const toolsOf = (items: readonly WorkItem[]): (WorkStep & { kind: "tools" })[] =>
  items.flatMap((i) => (i.kind === "turn" ? toolsOf(i.steps) : i.kind === "tools" ? [i] : []));

{
  const w = foldWork([frame("f1", [
    started("human", L(10, 29)), ...text("a", "Drafting the API."), ...call("c1", "Write"), finished(L(10, 31)),
    started("channel", L(10, 36)), ...call("c2", "Read"),
  ])], []);
  const [t1, t2] = turns(w.items);
  ok("work: two turns, the second open, give turn(finished) turn(open) with their steps inside",
    work(w.items) === "turn(finished)[said tools(1)] turn(open)[tools(1)]" &&
      t1.start === L(10, 29) && t1.end === L(10, 31) && t1.source === "prompt" && t2.source === "mesh" && t2.end === undefined,
    work(w.items));
}
{
  const w = foldWork([frame("f1", [...text("a", "before"), ...call("c1", "Bash"), finished(), started("human"), ...text("b", "inside")])], []);
  ok("work: steps before the first RUN_STARTED are loose, and a RUN_FINISHED with no turn is a loose turnEnd",
    work(w.items) === "said tools(1) turnEnd turn(open)[said]", work(w.items));
}
{
  const w = foldWork([frame("f1", [started("human"), ...call("c1", "Bash"), started("channel"), ...text("b", "next")])], []);
  ok("work: a second RUN_STARTED marks the first turn superseded",
    work(w.items) === "turn(open,superseded)[tools(1)] turn(open)[said]", work(w.items));
}
{
  const w = foldWork([frame("f1", [started("human", L(10, 51)), ...call("c1", "Bash"), runError(L(10, 52)), ...text("a", "after")])], []);
  const [t] = turns(w.items);
  ok("work: RUN_ERROR closes the turn failed and puts runError last in it",
    work(w.items) === "turn(failed)[tools(1) runError] said" && t.end === L(10, 52) && !JSON.stringify(w).includes("run failed"), work(w.items));
  const loose = foldWork([frame("f1", [runError()])], []);
  ok("work: a RUN_ERROR with no open turn is a loose runError", work(loose.items) === "runError", work(loose.items));
}

// ── 13. foldWork: the result marker ──────────────────────────────────────────────────────────────
{
  const w = foldWork([frame("f1", [
    started("human", L(10, 38)),
    ...call("c1", "Write", L(10, 38)), marker("c1", false, L(10, 38) + 200),
    ...call("c2", "Bash", L(10, 39)), marker("c2", true, L(10, 39) + 1800),
    finished(L(10, 40)),
  ])], []);
  const [write, bash] = allCalls(w.items);
  ok("work: a marker sets end and failed on its call",
    write.end === L(10, 38) + 200 && write.failed === false && bash.end === L(10, 39) + 1800 && bash.failed === true &&
      work(w.items) === "turn(finished)[tools(2)]",
    allCalls(w.items));
}
{
  const w = foldWork([frame("f1", [...call("c1", "Bash", L(10, 0)), ...call("c1", "Bash", L(10, 1)), marker("c1", true, L(10, 2))])], []);
  const [first, second] = allCalls(w.items);
  ok("work: a marker sets the latest call with its id, not an earlier one",
    first.failed === undefined && first.end === undefined && second.failed === true && second.end === L(10, 2), allCalls(w.items));
}
{
  const w = foldWork([frame("f1", [started("human"), ...call("c1", "Bash"), marker("gone", true)])], []);
  const [c] = allCalls(w.items);
  ok("work: a marker for an id the window does not hold adds nothing",
    work(w.items) === "turn(open)[tools(1)]" && c.end === undefined && c.failed === undefined, w);
}
{
  const w = foldWork([frame("f1", [
    ...call("c1", "Bash"),
    { type: "CUSTOM", name: "cotal.toolResult", value: { toolCallId: "c1", isError: "yes" } },
  ])], []);
  const labels = w.items.map((i) => (i.kind === "unknown" ? i.label : i.kind));
  ok("work: a malformed marker is named Custom event \"cotal.toolResult\" and sets nothing",
    labels.join("|") === 'tools|Custom event "cotal.toolResult"' && allCalls(w.items)[0].failed === undefined, labels);
}
{
  const marked = foldWork([frame("f1", [started(), ...call("c1", "Bash"), marker("c1", false), finished()])], []);
  ok("toolStatus: true when a well-formed marker is held", marked.toolStatus === true, marked.toolStatus);
  const legacy = foldWork([frame("f1", [started(), ...call("c1", "Bash"), finished()])], []);
  ok("toolStatus: false with no marker and a finished turn holding a call", legacy.toolStatus === false, legacy.toolStatus);
  const failed = foldWork([frame("f1", [started(), ...call("c1", "Bash"), runError()])], []);
  ok("toolStatus: false with no marker and a failed turn holding a call", failed.toolStatus === false, failed.toolStatus);
  const open = foldWork([frame("f1", [started(), ...call("c1", "Bash")])], []);
  ok("toolStatus: true with no marker and only an open turn", open.toolStatus === true, open.toolStatus);
}
{
  const w = foldWork([frame("f1", [
    started("channel", L(10, 36)), ...call("c1", "Write", L(10, 38)), ...call("c2", "Bash", L(10, 41)), ...call("c3", "Bash", L(10, 43)), finished(L(10, 44)),
  ])], []);
  const [group] = toolsOf(w.items);
  const title = group ? groupTitle(group.calls, w.toolStatus).title : "no group";
  ok("legacy: a closed turn of Write, Bash, Bash with no marker reads \"Called Write, Bash and Bash\"",
    title === "Called Write, Bash and Bash", { title, toolStatus: w.toolStatus });
  const described = group ? groupDescription(group.calls, w.toolStatus) : "no group";
  ok("legacy: its description is \"3 calls · 10:38 to 10:43\"", described === "3 calls · 10:38 to 10:43", described);
}

// ── 14. foldWork: posts and DMs, placed by time ──────────────────────────────────────────────────
{
  const frames = [frame("f1", [
    started("channel", L(10, 40)), ...call("c1", "Bash", L(10, 41)), ...text("a", "Posting now.", { ts: L(10, 43) }), finished(L(10, 44)),
    started("channel", L(10, 49)), ...call("c2", "cotal_inbox", L(10, 49)),
  ], L(10, 49))];
  const w = foldWork(frames, [post("m1", L(10, 42), "in #team"), dm("d1", L(10, 42) + 1, "local.lead")]);
  const [first] = turns(w.items);
  const [p, d] = first ? first.steps.filter((s) => s.kind === "post") : [];
  ok("work post placement: a channel post and a DM land inside the turn whose events surround them, the DM with to",
    work(w.items) === "turn(finished)[tools(1) post post said] turn(open)[tools(1)]" &&
      p?.kind === "post" && p.channel === "team" && p.to === undefined && p.msg.id === "m1" &&
      d?.kind === "post" && d.to === "local.lead" && d.channel === undefined && d.msg.id === "d1",
    work(w.items));
}
{
  const anycast = { msg: { id: "a1", ts: L(10, 0), space: "s", from: { id: "local.engine", name: "engine" }, parts: [], toService: "reviewer" } as CotalMessage, senderId: "local.engine" };
  const w = foldWork([], [anycast]);
  ok("work: a row with neither channel nor to is skipped", w.items.length === 0, w.items);
}

// ── 15. Group titles: counts of calls per kind ───────────────────────────────────────────────────
ok("group title: two Edit calls read \"Made 2 edits\", counting calls, never files",
  groupTitle(calls("Edit", "Edit"), true).title === "Made 2 edits", groupTitle(calls("Edit", "Edit"), true));
ok("group title: Bash, cotal_inbox, Bash, cotal_inbox reads \"Ran 2 commands, checked the inbox 2 times\"",
  groupTitle(calls("Bash", "cotal_inbox", "Bash", "cotal_inbox"), true).title === "Ran 2 commands, checked the inbox 2 times",
  groupTitle(calls("Bash", "cotal_inbox", "Bash", "cotal_inbox"), true));
ok("group title: cotal_inbox, cotal_inbox, Edit, Bash reads \"Checked the inbox 2 times, made an edit, ran a command\"",
  groupTitle(calls("cotal_inbox", "cotal_inbox", "Edit", "Bash"), true).title === "Checked the inbox 2 times, made an edit, ran a command",
  groupTitle(calls("cotal_inbox", "cotal_inbox", "Edit", "Bash"), true));
ok("group title: legacy Write, Bash, Bash reads \"Called Write, Bash and Bash\"",
  groupTitle(calls("Write", "Bash", "Bash"), false).title === "Called Write, Bash and Bash", groupTitle(calls("Write", "Bash", "Bash"), false));
{
  const got = [calls("Grep"), calls("Grep", "Glob"), calls("Bash", "Grep", "Glob"), calls("Write", "Bash")].map((c) => groupTitle(c, true).title);
  ok("group title: other tools read \"called a tool\" alone and \"called n other tools\" beside other kinds",
    got.join("|") === "Called a tool|Called 2 tools|Ran a command, called 2 other tools|Wrote a file, ran a command", got);
}
{
  const c = calls("Write", "Bash", "Bash");
  c[1].failed = true;
  c[0].failed = false;
  ok("group title: failed counts the failed calls", groupTitle(c, true).failed === 1 && groupTitle(calls("Bash"), true).failed === 0, groupTitle(c, true));
}

// ── 16. Call states (one cell per rule) ──────────────────────────────────────────────────────────
const openTurn: Turn = { kind: "turn", key: "t", start: L(10, 49), outcome: "open", superseded: false, steps: [], live: false };
const one = (over: Partial<ToolCall> = {}): ToolCall => ({ ...calls("Bash")[0], ts: L(10, 50), ...over });
const state = (call: ToolCall, over: Partial<Parameters<typeof callState>[1]> = {}): CallState =>
  callState(call, { turn: openTurn, trailing: true, status: "working", toolStatus: true, ...over });
ok("call state: a marker gives done or failed, whatever follows it or presence says",
  state(one({ end: L(10, 51), failed: false }), { trailing: false, status: "offline" }) === "done" &&
    state(one({ end: L(10, 51), failed: true }), { turn: undefined }) === "failed");
ok("call state: a call with no marker that something followed is called, never running",
  state(one(), { trailing: false }) === "called", state(one(), { trailing: false }));
ok("call state: with no tool status every call is called", state(one(), { toolStatus: false }) === "called");
ok("call state: a trailing call with no turn has no result", state(one(), { turn: undefined }) === "noResult");
ok("call state: a trailing call in a closed or superseded turn has no result",
  state(one(), { turn: { ...openTurn, outcome: "finished" } }) === "noResult" &&
    state(one(), { turn: { ...openTurn, outcome: "failed" } }) === "noResult" &&
    state(one(), { turn: { ...openTurn, superseded: true } }) === "noResult");
ok("call state: a trailing call in an open turn runs while presence says working", state(one(), { status: "working" }) === "running");
ok("call state: a trailing call in an open turn is pending while presence says waiting", state(one(), { status: "waiting" }) === "pending");
ok("call state: idle and offline give no result", state(one(), { status: "idle" }) === "noResult" && state(one(), { status: "offline" }) === "noResult");

// ── 17. Every title for a command, and each turn title ───────────────────────────────────────────
{
  const states: CallState[] = ["running", "done", "failed", "pending", "noResult", "called"];
  const got = states.map((s) => callTitle("command", s, "Bash"));
  ok("call titles for a command follow the wording table",
    got.join("|") === "Running a command|Ran a command|A command failed|A command hasn't finished|No result arrived for a command|Called Bash", got);
  const parts = [groupTitle(calls("Bash"), true).title, groupTitle(calls("Bash", "Bash"), true).title];
  ok("group parts for a command read \"Ran a command\" and \"Ran 2 commands\"", parts.join("|") === "Ran a command|Ran 2 commands", parts);
  ok("callTitle names a called tool by its short name", callTitle("send", "called", "cotal_send") === "Called cotal_send");
}
{
  const start = L(10, 36);
  const failing = (...names: string[]): WorkStep[] => [{ kind: "tools", key: "g", calls: calls(...names).map((c) => ({ ...c, failed: true })), live: false }];
  const finished7 = { ...openTurn, start, end: start + 7 * 60_000 + 48_000, outcome: "finished" as const, steps: failing("Bash") };
  const t = turnTitle(finished7, "idle", start);
  ok("turn title: finished reads \"Worked for 7m 48s\" with \"1 command failed\"", t.title === "Worked for 7m 48s" && t.failed === "1 command failed", t);
  const mixed = turnTitle({ ...finished7, steps: failing("Bash", "Edit") }, "idle", start);
  ok("turn title: failed calls of mixed kinds read \"2 calls failed\"", mixed.failed === "2 calls failed", mixed);
  const twoBash = turnTitle({ ...finished7, steps: failing("Bash", "Bash") }, "idle", start);
  ok("turn title: two failed commands read \"2 commands failed\"", twoBash.failed === "2 commands failed", twoBash);
  const failedTurn = turnTitle({ ...openTurn, start, end: start + 72_000, outcome: "failed" }, "idle", start);
  ok("turn title: failed reads \"Turn failed after 1m 12s\"", failedTurn.title === "Turn failed after 1m 12s" && failedTurn.failed === undefined, failedTurn);
  const now = start + 182_400;
  const live = (status: "working" | "waiting" | "idle" | "offline", over: Partial<Turn> = {}) => turnTitle({ ...openTurn, start, ...over }, status, now).title;
  ok("turn title: open while working reads \"Working for 3m 2s\"", live("working") === "Working for 3m 2s", live("working"));
  ok("turn title: open while waiting reads \"Open for 3m 2s\"", live("waiting") === "Open for 3m 2s", live("waiting"));
  ok("turn title: open while idle or offline, or superseded, reads \"No end arrived for this turn\"",
    [live("idle"), live("offline"), live("working", { superseded: true })].every((x) => x === "No end arrived for this turn"),
    [live("idle"), live("offline"), live("working", { superseded: true })]);
}

// ── 18. Durations and descriptions ───────────────────────────────────────────────────────────────
{
  const got = [formatDuration(400, true), formatDuration(20_000, true), formatDuration(12_400, false), formatDuration(182_000, false),
    formatDuration(3_840_000, false), formatDuration(-1, true), formatDuration(Number.NaN, false)];
  ok("formatDuration: 0.4s and 20.0s precise, 12s whole, 3m 2s, 1h 4m, and none for -1 or NaN",
    JSON.stringify(got) === JSON.stringify(["0.4s", "20.0s", "12s", "3m 2s", "1h 4m", undefined, undefined]), got);
}
{
  const t = L(10, 50);
  const got = [
    callDescription(one({ ts: t, end: t + 1800, failed: false }), "done", t),
    callDescription(one({ ts: t, end: t + 1800, failed: true }), "failed", t),
    callDescription(one({ ts: t }), "running", t + 12_700),
    callDescription(one({ ts: t }), "pending", t + 99_000),
    callDescription(one({ ts: t }), "noResult", t + 99_000),
    callDescription(one({ ts: L(10, 44), name: "cotal_send" }), "called", t),
    callDescription(one({ ts: t, end: t - 5, failed: false }), "done", t),
  ];
  ok("call descriptions: the name with its precise, counting or start time, and only the time when called",
    got.join("|") === "Bash · 1.8s|Bash · 1.8s|Bash · 12s|Bash · started 10:50|Bash · started 10:50|10:44|Bash", got);
}
{
  const t = L(10, 38);
  const pair = calls("Write", "Bash").map((c, i) => ({ ...c, ts: t + i * 200, end: t + i * 200 + (i === 0 ? 200 : 1800), failed: false }));
  const half = [pair[0], { ...pair[1], end: undefined, failed: undefined }];
  const same = calls("Bash", "Bash").map((c) => ({ ...c, ts: t }));
  const got = [groupDescription(pair, true), groupDescription(half, true), groupDescription(same, false)];
  ok("group descriptions: steps with the span when every call has both ends, else calls and their times",
    got.join("|") === "2 steps · 2.0s|2 steps|2 calls · 10:38", got);
}
{
  const w = foldWork([frame("f1", [
    started("channel", L(10, 36)), ...text("a", "Rewriting to match."), ...call("c1", "Write"), ...call("c2", "Bash"),
    ...text("b", "Checking with lead."), ...call("c3", "mcp__plugin_cotal_cotal__cotal_dm"), finished(L(10, 44)),
  ])], []);
  const [t] = turns(w.items);
  const d = t ? turnDescription(t, L(11, 0)) : "no turn";
  ok("turn description: the mock's second turn reads \"10:36 to 10:44 · started by a message from the mesh · 5 steps\"",
    d === "10:36 to 10:44 · started by a message from the mesh · 5 steps", d);
}
{
  const w = foldWork([frame("f1", [started("channel", L(10, 49)), ...call("c1", "cotal_inbox", L(10, 49)), ...text("a", "Returning { ate, dead }.", { ts: L(10, 50) })], L(10, 50))],
    [post("m1", L(10, 49) + 30_000, "posted")]);
  const [t] = turns(w.items);
  const d = t ? turnDescription(t, L(10, 52)) : "no turn";
  ok("turn description: an open turn reads \"since 10:49 · started by a message from the mesh · 3 steps · posted in #team\"",
    d === "since 10:49 · started by a message from the mesh · 3 steps · posted in #team", d);
}

// ── 19. foldWork: keys, ids and live ─────────────────────────────────────────────────────────────
{
  const input = (): SessionFrame[] => [
    frame("f1", [...text("x", "loose"), started("human"), ...call("c1", "Bash"), marker("c1", false), ...call("c2", "Edit"), ...text("a", "x", { end: false })]),
    frame("f2", [null, { type: "CUSTOM", name: "n" }, finished(), runError()]),
  ];
  const posts = [post("m1", T0, "hi"), dm("d1", T0, "local.lead")];
  const a = allKeys(foldWork(input(), posts).items);
  const b = allKeys(foldWork(input(), posts).items);
  ok("work: keys are equal across two folds and unique within one", a.join("|") === b.join("|") && new Set(a).size === a.length && a.length >= 10, [a, b]);
}
{
  const w = foldWork([frame("f", [
    started("human"),
    ...text("10", "ten", { end: false }), ...text("2", "two", { end: false }), ...text("__proto__", "proto", { end: false }),
    ...call("10", "Bash", L(10, 0)), ...call("2", "Edit", L(10, 0)), ...call("__proto__", "Read", L(10, 0)),
    marker("__proto__", true, L(10, 3)), marker("2", false, L(10, 2)), marker("10", false, L(10, 1)),
  ])], []);
  const [t] = turns(w.items);
  const said = t ? t.steps.filter((s) => s.kind === "said").map((s) => (s.kind === "said" ? s.text : "")) : [];
  const ends = allCalls(w.items).map((c) => `${c.id}:${c.end === undefined ? "-" : new Date(c.end).getMinutes()}:${c.failed}`);
  ok("work: ids \"2\", \"10\" and \"__proto__\" keep their order, and each marker finds its own call",
    said.join(",") === "ten,two,proto" && ends.join(",") === "10:1:false,2:2:false,__proto__:3:true", { said, ends });
}
{
  const w = foldWork([
    frame("f1", [started("human"), ...call("c1", "Bash"), ...call("c2", "Bash")], T0, true),
    frame("f2", [marker("c1", false)], T0, true),
    frame("f3", [marker("c2", false), finished()], T0, false),
  ], []);
  const [t] = turns(w.items);
  const [c1, c2] = allCalls(w.items);
  ok("work: an item is live only when every frame it came from arrived live",
    t?.live === false && c1.live === true && c2.live === false && toolsOf(w.items)[0]?.live === false, { turn: t?.live, c1: c1.live, c2: c2.live });
}

console.log(`\nsession: ${cells - failed} of ${cells} cells green`);
if (failed > 0) process.exit(1);
