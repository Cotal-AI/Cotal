// An agent's work as the dashboard draws it: its AG-UI frames and its own verified posts and DMs,
// folded into turns that hold steps (`foldWork`), and the words and durations each part shows.
// `foldSession` is the older flat list the session view still draws.
//
// The third reader of the frame vocabulary. `aguiFrame.ts` (this client) and connector-core's
// `agui-render.ts` draw a frame as text lines; this folds the same events into items a view lays
// out. It keeps their fallbacks on purpose, because the parity suite compares all three: ids live in
// `Map`s (a plain object would reorder "2" and "10" and drop "__proto__"), every fallback keys on
// `undefined` and never on falsiness (an empty tool name stays "", an absent one is "?"), an empty
// stream draws nothing, and a stream with no END still shows, marked cut, where the renderers add a
// trailing " …". The deliberate differences are listed in `smoke/agui-render-parity.smoke.ts`.
//
// It draws only what the wire says. A tool call is a name, a start and, when the connector publishes
// the `cotal.toolResult` marker, an end and whether it returned an error; never its arguments or
// result, which the plane drops. Counts are of calls, never of files. A duration is only ever
// between a call's start and its marker, or between a turn's RUN_STARTED and its RUN_FINISHED or
// RUN_ERROR. A turn that ended is not a turn that succeeded. A run error carries no reason here:
// presence is where a reason comes from, and the view asks presence. A post is the agent's own
// verified chat message or DM placed by its time, and it is never joined to a `cotal_send` or
// `cotal_dm` call. Whether anything is still running is presence's to say, so call states take it.
//
// Pure: no React, no browser, and nothing from `@cotal-ai/*` at runtime.
import type { CotalMessage } from "../api/types.js";
import type { StoredMessage } from "../state/types.js";
import { partsToText } from "./parts.js";
import type { Status } from "./roster.js";
import { toolResultOf } from "./toolResult.js";

export type TurnSource = "prompt" | "mesh" | "continuation" | "notification";
export interface SessionFrame { id: string; ts: number; events: unknown[]; live: boolean }

/** What a call is, from its short name, for its words: `toolKind`. */
export type ToolKind = "command" | "edit" | "write" | "read" | "send" | "dm" | "inbox" | "other";
/** One tool call. `failed` is set, true or false, exactly when its `cotal.toolResult` marker arrived;
 *  `end` is that marker's time, when it had one. Neither is ever inferred. */
export interface ToolCall {
  key: string;
  /** Its `toolCallId`, "" when the START carried none. */
  id: string;
  /** The short name (`toolShortName`), "?" when the START carried none, "" when it carried "". */
  name: string;
  full: string;
  kind: ToolKind;
  /** Its TOOL_CALL_START. */
  ts?: number;
  /** Its marker's time. */
  end?: number;
  /** Its marker's isError. */
  failed?: boolean;
  live: boolean;
}

export type SessionItem =
  | { kind: "turn"; key: string; ts?: number; source?: TurnSource }
  | { kind: "prompt"; key: string; text: string; cut: boolean }
  | { kind: "said"; key: string; text: string; cut: boolean }
  | { kind: "tools"; key: string; calls: ToolCall[] }
  | { kind: "turnEnd"; key: string; ts?: number }
  | { kind: "runError"; key: string; ts?: number }
  | { kind: "reasoning"; key: string; text: string; cut: boolean }
  | { kind: "post"; key: string; channel: string; msg: CotalMessage }
  | { kind: "unknown"; key: string; label: string; ts?: number };
/** Every key is stable across a re-fold of the same input, and an item whose frames all arrived live
 *  carries live: true (for the rise animation). */
export type SessionStep = SessionItem & { live: boolean };

/** One step inside a turn, or loose before the first RUN_STARTED the window holds. A `post` is a
 *  channel post (`channel` set) or a DM (`to` set). Keys are stable across re-folds, and `live` is true
 *  only when every frame the step came from arrived live. */
export type WorkStep =
  | { kind: "said" | "prompt" | "reasoning"; key: string; text: string; cut: boolean; ts?: number; live: boolean }
  | { kind: "tools"; key: string; calls: ToolCall[]; live: boolean }
  | { kind: "post"; key: string; msg: CotalMessage; channel?: string; to?: string; live: boolean }
  | { kind: "runError"; key: string; ts?: number; live: boolean }
  | { kind: "unknown"; key: string; label: string; ts?: number; live: boolean };
/** RUN_STARTED to RUN_FINISHED (`finished`) or RUN_ERROR (`failed`, its `runError` step last), or
 *  still `open`. `start` and `end` are those events' times. */
export interface Turn {
  kind: "turn";
  key: string;
  start?: number;
  end?: number;
  outcome: "open" | "finished" | "failed";
  /** A later RUN_STARTED arrived while this one was open. */
  superseded: boolean;
  source?: TurnSource;
  steps: WorkStep[];
  live: boolean;
}
/** A turn, a loose step, or a RUN_FINISHED that closed no turn the window holds. */
export type WorkItem = Turn | WorkStep | { kind: "turnEnd"; key: string; ts?: number; live: boolean };
/** `toolStatus` says whether the agent's connector reports when calls finish: true when any
 *  well-formed marker is held, false when none is and some closed turn holds a call, else true. */
export interface Work { items: WorkItem[]; toolStatus: boolean }

/** The most events the browser keeps for one agent. */
export const SESSION_EVENT_CAP = 2000;

const FRAME_KIND = "ag-ui.frame";

/** An event off the wire. Nothing about its shape is trusted. */
type Wire = Record<string, any>;

// `undefined` for anything that is not a string, so absent and empty stay apart, as in `aguiFrame.ts`.
const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);
const finite = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);

/** A step that is not an AG-UI event: a message on the channel that carries no frame, or a frame part
 *  with no events. A class rather than a plain object so nothing off the wire can be mistaken for one. */
class Note {
  constructor(readonly label: string) {}
}

/** The frames of one message: every `ag-ui.frame` part's events, in part order. A message on the
 *  channel with no frame part yields one `unknown` step labelled from `partsToText`.
 *
 *  The first frame's id is the message id, so the common message (one frame part) keeps its id as
 *  is; a further frame part in the same message is `<message id>#<n>`, n counting frame parts from 1.
 *
 *  A message whose id is not a string gives no frames at all, not even an unknown step. Every frame
 *  and every step is keyed by that id, and a number, null or absent id would turn into the same key
 *  as another message's (`7` and `"7"`, or every `undefined`), so the store would take one for a
 *  copy of the other and a step's key would stop naming one step. */
export function framesOf(msg: CotalMessage, live: boolean): SessionFrame[] {
  if (typeof (msg as { id?: unknown }).id !== "string") return [];
  const parts: unknown[] = Array.isArray(msg.parts) ? msg.parts : [];
  const frames: SessionFrame[] = [];
  for (const p of parts) {
    if (typeof p !== "object" || p === null || (p as Wire).kind !== FRAME_KIND) continue;
    const events = (p as Wire).events;
    const id = frames.length === 0 ? msg.id : `${msg.id}#${frames.length}`;
    frames.push({
      id,
      ts: msg.ts,
      // A frame part with no events is named rather than dropped, as the renderers name it.
      events: Array.isArray(events) && events.length > 0 ? events : [new Note("A frame with no events")],
      live,
    });
  }
  if (frames.length > 0) return frames;
  return [{ id: msg.id, ts: msg.ts, events: [new Note(partsToText(parts))], live }];
}

/** `mcp__plugin_cotal_cotal__cotal_inbox` gives `cotal_inbox`: the text after the last `__`. */
export function toolShortName(full: string): string {
  const i = full.lastIndexOf("__");
  return i < 0 ? full : full.slice(i + 2);
}

const KINDS = new Map<string, ToolKind>([
  ["Bash", "command"],
  ["Edit", "edit"],
  ["MultiEdit", "edit"],
  ["NotebookEdit", "edit"],
  ["Write", "write"],
  ["Read", "read"],
  ["cotal_send", "send"],
  ["cotal_dm", "dm"],
  ["cotal_inbox", "inbox"],
]);

/** What a call is, from its short name: Bash a command, Edit, MultiEdit and NotebookEdit an edit,
 *  Write a write, Read a read, cotal_send a message, cotal_dm a direct message, cotal_inbox an inbox
 *  check, anything else another tool. */
export function toolKind(shortName: string): ToolKind {
  return KINDS.get(shortName) ?? "other";
}

/** The group's label and its names slot: "Checked the inbox N times" with "M tool calls" when every
 *  call is cotal_inbox or Bash and at least two are cotal_inbox; otherwise "M tool calls" (or
 *  "1 tool call") with the short names joined by ", " in call order. */
export function toolGroupLabel(calls: readonly ToolCall[]): { label: string; names: string } {
  const count = calls.length === 1 ? "1 tool call" : `${calls.length} tool calls`;
  const inbox = calls.filter((c) => c.name === "cotal_inbox").length;
  // Only the inbox calls are named: Bash's command (often a `sleep`) is not on the wire.
  if (inbox >= 2 && calls.every((c) => c.name === "cotal_inbox" || c.name === "Bash")) {
    return { label: `Checked the inbox ${inbox} times`, names: count };
  }
  return { label: count, names: calls.map((c) => c.name).join(", ") };
}

/** The roster id an event channel names, `events.<owner>.<actor>` to `<owner>.<actor>`, or undefined.
 *  Both tokens are [A-Za-z0-9_]+, as core's `eventChannelPrincipal` requires; restated because the
 *  client cannot import core. */
export function eventChannelAgent(channel: string): string | undefined {
  const m = /^events\.([A-Za-z0-9_]+)\.([A-Za-z0-9_]+)$/.exec(channel);
  return m ? `${m[1]}.${m[2]}` : undefined;
}

/** How many events the frames hold. */
export function eventCount(frames: readonly SessionFrame[]): number {
  let n = 0;
  for (const f of frames) n += f.events.length;
  return n;
}

const SOURCES = new Map<string, TurnSource>([
  ["human", "prompt"],
  ["sdk", "prompt"],
  ["channel", "mesh"],
  ["auto-continuation", "continuation"],
  ["notification", "notification"],
]);

/** `cotal.turnSource` as a turn source; `unknown`, absent or anything else gives none. */
function turnSource(e: Wire): TurnSource | undefined {
  const cotal = e.cotal;
  const raw = typeof cotal === "object" && cotal !== null ? str(cotal.turnSource) : undefined;
  return raw === undefined ? undefined : SOURCES.get(raw);
}

/** One step before the posts are merged and the calls grouped. `at` is its time for the merge, and
 *  `live` whether the frames it came from all arrived live. */
type Flat =
  | { item: SessionItem; at?: number; live: boolean }
  | { call: ToolCall; at?: number; live: boolean };

/** A stream being accumulated: its text, the role its START gave, the key of the event that opened
 *  it, the time of the last event that touched it, and whether every frame it came from was live. */
interface Stream { text: string; user: boolean; key: string; at?: number; live: boolean }

/** The frames as flat steps, in the order both folds draw them, and whether any well-formed tool
 *  result marker was held.
 *
 *  Text and reasoning accumulate by `messageId` and land where their END lands, as the renderers
 *  flush them; a call lands where it starts. A marker adds no step: it sets `end` and `failed` on the
 *  latest call with its id, and one whose call fell before the window sets nothing. */
function flatten(frames: readonly SessionFrame[]): { flat: Flat[]; marked: boolean } {
  const flat: Flat[] = [];
  const text = new Map<string, Stream>();
  const reasoning = new Map<string, Stream>();
  const calls = new Map<string, ToolCall>();
  let marked = false;

  const touch = (map: Map<string, Stream>, id: string, key: string, at: number | undefined, live: boolean): Stream => {
    const s = map.get(id);
    if (s !== undefined) {
      s.at = at;
      s.live = s.live && live;
      return s;
    }
    const fresh: Stream = { text: "", user: false, key, at, live };
    map.set(id, fresh);
    return fresh;
  };

  // A START empties its stream in place, as the renderers' `set(id, "")` does: a Map keeps a key's
  // first position when it is set again, so a reopened id still flushes in the order it was first seen.
  const open = (map: Map<string, Stream>, id: string, key: string, at: number | undefined, live: boolean): Stream => {
    const s = touch(map, id, key, at, live);
    s.text = "";
    s.user = false;
    s.key = key;
    s.live = live;
    return s;
  };

  // An empty stream draws nothing, as the renderers flush nothing for it.
  const flush = (map: Map<string, Stream>, id: string, kind: "said" | "reasoning", cut: boolean, at?: number, live = true): void => {
    const s = map.get(id);
    map.delete(id);
    if (s === undefined || s.text.length === 0) return;
    const k = kind === "said" && s.user ? "prompt" : kind;
    flat.push({ item: { kind: k, key: s.key, text: s.text, cut }, at: at ?? s.at, live: s.live && live });
  };

  // A stream still open when a turn ends or another begins is drawn cut there, with the same mark, so
  // it stays inside its turn. One still open at the end of the fold is drawn cut at the end.
  const cutOpen = (): void => {
    for (const id of [...text.keys()]) flush(text, id, "said", true);
    for (const id of [...reasoning.keys()]) flush(reasoning, id, "reasoning", true);
  };

  for (const f of frames) {
    const frameTs = finite(f.ts);
    f.events.forEach((ev, i) => {
      const key = `${f.id}:${i}`;
      const live = f.live;
      if (ev instanceof Note) {
        flat.push({ item: { kind: "unknown", key, label: ev.label, ts: frameTs }, at: frameTs, live });
        return;
      }
      // The element itself is untrusted: `null` arrives, and one bad element must cost one step.
      const e = ev as Wire;
      const isObj = typeof e === "object" && e !== null;
      const type = isObj ? str(e.type) : undefined;
      const at = (isObj ? finite(e.timestamp) : undefined) ?? frameTs;
      if (type === "RUN_STARTED" || type === "RUN_FINISHED" || type === "RUN_ERROR") cutOpen();
      switch (type) {
        case "RUN_STARTED": {
          const source = turnSource(e);
          flat.push({ item: { kind: "turn", key, ts: at, ...(source ? { source } : {}) }, at, live });
          break;
        }
        case "RUN_FINISHED":
          flat.push({ item: { kind: "turnEnd", key, ts: at }, at, live });
          break;
        // The message and code are not carried: the plane's message is fixed, and a reason comes from presence.
        case "RUN_ERROR":
          flat.push({ item: { kind: "runError", key, ts: at }, at, live });
          break;

        case "TEXT_MESSAGE_START":
          open(text, str(e.messageId) ?? "", key, at, live).user = str(e.role) === "user";
          break;
        case "TEXT_MESSAGE_CONTENT": {
          const s = touch(text, str(e.messageId) ?? "", key, at, live);
          s.text += str(e.delta) ?? "";
          break;
        }
        case "TEXT_MESSAGE_END":
          flush(text, str(e.messageId) ?? "", "said", false, at, live);
          break;

        case "REASONING_MESSAGE_START":
          open(reasoning, str(e.messageId) ?? "", key, at, live);
          break;
        case "REASONING_MESSAGE_CONTENT": {
          const s = touch(reasoning, str(e.messageId) ?? "", key, at, live);
          s.text += str(e.delta) ?? "";
          break;
        }
        case "REASONING_MESSAGE_END":
          flush(reasoning, str(e.messageId) ?? "", "reasoning", false, at, live);
          break;

        case "TOOL_CALL_START": {
          const full = str(e.toolCallName) ?? "?";
          const name = toolShortName(full);
          const call: ToolCall = { key, id: str(e.toolCallId) ?? "", name, full, kind: toolKind(name), ...(at !== undefined ? { ts: at } : {}), live };
          calls.set(call.id, call);
          flat.push({ call, at, live });
          break;
        }
        // The plane drops a call's arguments and result, and its END says nothing new: none is drawn.
        case "TOOL_CALL_END":
        case "TOOL_CALL_ARGS":
        case "TOOL_CALL_RESULT":
          break;

        case "CUSTOM": {
          // A well-formed tool result marker adds no step: a call is drawn where it starts, and the
          // marker only says it finished. A malformed one stays an unknown step.
          const marker = toolResultOf(e);
          if (marker !== undefined) {
            marked = true;
            const latest = calls.get(marker.toolCallId);
            if (latest !== undefined) {
              if (at !== undefined) latest.end = at;
              latest.failed = marker.isError;
              latest.live = latest.live && live;
            }
            break;
          }
          flat.push({ item: { kind: "unknown", key, label: `Custom event ${str(e.name) === undefined ? "(unnamed)" : JSON.stringify(e.name)}`, ts: at }, at, live });
          break;
        }

        // Named, never skipped: a skipped event is a hole in a transcript that still looks complete.
        default:
          flat.push({ item: { kind: "unknown", key, label: `Unrecognised event ${JSON.stringify(type ?? null)}`, ts: at }, at, live });
      }
    });
  }

  cutOpen();
  return { flat, marked };
}

/** The posts `keep` admits, by time and stable. A post whose ts is not a finite number has no time to
 *  place it by, so it goes last, in arrival order. */
function postsByTime(posts: readonly StoredMessage[], keep: (msg: CotalMessage) => boolean): { msg: CotalMessage; at?: number }[] {
  return posts
    .filter((p) => keep(p.msg))
    .map((p, i) => ({ msg: p.msg, i, at: finite(p.msg.ts) }))
    .sort((a, b) => (a.at ?? Infinity) - (b.at ?? Infinity) || a.i - b.i)
    .map(({ msg, at }) => ({ msg, at }));
}

/** The frame steps with the ordered posts merged in: each post goes before the first frame step whose
 *  time is later, and the rest go last. */
function mergeByTime<T extends { at?: number }>(flat: readonly T[], ordered: readonly T[]): T[] {
  const before = (post: number | undefined, step: number | undefined) => post !== undefined && step !== undefined && post < step;
  const merged: T[] = [];
  let next = 0;
  for (const s of flat) {
    while (next < ordered.length && before(ordered[next].at, s.at)) merged.push(ordered[next++]);
    merged.push(s);
  }
  while (next < ordered.length) merged.push(ordered[next++]);
  return merged;
}

/** Fold frames and channel posts into the flat steps the session view draws, oldest first: a turn
 *  line, its steps and its end line, each a step. Posts merge by time. Calls then group: a call joins
 *  the calls right before it, and any other step (text, a post, a turn line) ends the group. */
export function foldSession(frames: readonly SessionFrame[], posts: readonly StoredMessage[]): SessionStep[] {
  const ordered = postsByTime(posts, (m) => typeof m.channel === "string")
    .map(({ msg, at }): Flat => ({ item: { kind: "post", key: `post:${msg.id}`, channel: msg.channel as string, msg }, at, live: true }));
  const merged = mergeByTime(flatten(frames).flat, ordered);

  // Calls group with the calls right before them; anything else ends the group.
  const steps: SessionStep[] = [];
  let group: (SessionStep & { kind: "tools" }) | undefined;
  for (const s of merged) {
    if ("call" in s) {
      if (group !== undefined) {
        group.calls.push(s.call);
        group.live = group.live && s.live;
      } else {
        group = { kind: "tools", key: s.call.key, calls: [s.call], live: s.live };
        steps.push(group);
      }
      continue;
    }
    group = undefined;
    steps.push({ ...s.item, live: s.live });
  }
  return steps;
}

type WorkFlat = Flat | { post: WorkStep & { kind: "post" }; at?: number };

/** Fold frames, channel posts and DMs into turns holding their steps, oldest first.
 *
 *  `posts` holds the agent's own verified rows (each with `senderId`): a row with a string `channel`
 *  is a channel post, one with a string `to` a DM, and any other row is skipped. Posts merge into the
 *  flat stream by time before it nests into turns, so a post lands inside the turn whose events
 *  surround it.
 *
 *  RUN_STARTED opens a turn; one that arrives while a turn is open marks that turn superseded. A
 *  RUN_FINISHED closes the open turn finished; a RUN_ERROR puts a `runError` step last in it and
 *  closes it failed. Either with no open turn is a loose item, as is every step before the first
 *  RUN_STARTED the window holds. Adjacent calls share one `tools` step; any other step ends it. */
export function foldWork(frames: readonly SessionFrame[], posts: readonly StoredMessage[]): Work {
  const { flat, marked } = flatten(frames);
  const ordered = postsByTime(posts, (m) => typeof m.channel === "string" || typeof m.to === "string")
    .map(({ msg, at }): WorkFlat => ({
      post: { kind: "post", key: `post:${msg.id}`, msg, ...(typeof msg.channel === "string" ? { channel: msg.channel } : { to: msg.to as string }), live: true },
      at,
    }));

  const items: WorkItem[] = [];
  let turn: Turn | undefined;
  let tools: (WorkStep & { kind: "tools" }) | undefined;
  const place = (step: WorkStep): void => {
    tools = undefined;
    (turn?.steps ?? items).push(step);
  };
  const close = (outcome: "finished" | "failed", end: number | undefined, live: boolean): void => {
    if (turn === undefined) return;
    turn.outcome = outcome;
    if (end !== undefined) turn.end = end;
    turn.live = turn.live && live;
    turn = undefined;
  };

  for (const s of mergeByTime<WorkFlat>(flat, ordered)) {
    if ("post" in s) {
      place(s.post);
      continue;
    }
    if ("call" in s) {
      if (tools !== undefined) {
        tools.calls.push(s.call);
        tools.live = tools.live && s.call.live;
      } else {
        const group: WorkStep & { kind: "tools" } = { kind: "tools", key: s.call.key, calls: [s.call], live: s.call.live };
        place(group);
        tools = group;
      }
      continue;
    }
    const it = s.item;
    switch (it.kind) {
      case "turn":
        tools = undefined;
        if (turn !== undefined) turn.superseded = true;
        turn = { kind: "turn", key: it.key, ...(it.ts !== undefined ? { start: it.ts } : {}), outcome: "open", superseded: false, ...(it.source ? { source: it.source } : {}), steps: [], live: s.live };
        items.push(turn);
        break;
      case "turnEnd":
        tools = undefined;
        if (turn !== undefined) close("finished", it.ts, s.live);
        else items.push({ kind: "turnEnd", key: it.key, ...(it.ts !== undefined ? { ts: it.ts } : {}), live: s.live });
        break;
      case "runError":
        place({ kind: "runError", key: it.key, ...(it.ts !== undefined ? { ts: it.ts } : {}), live: s.live });
        close("failed", it.ts, s.live);
        break;
      case "said":
      case "prompt":
      case "reasoning":
        place({ ...it, ...(s.at !== undefined ? { ts: s.at } : {}), live: s.live });
        break;
      case "unknown":
        place({ ...it, live: s.live });
        break;
      // `flatten` yields neither: calls come as `call`, and posts merge in above.
      case "tools":
      case "post":
        break;
    }
  }

  const closedWithCall = items.some((i) => i.kind === "turn" && i.outcome !== "open" && i.steps.some((s) => s.kind === "tools"));
  return { items, toolStatus: marked || !closedWithCall };
}

// ── Call states ──────────────────────────────────────────────────────────────────────────────────

/** What a call's row says about it. `called` is a call the wire never said finished and something
 *  followed, or any call from a connector that reports no tool status. */
export type CallState = "running" | "pending" | "noResult" | "done" | "failed" | "called";

/** A call's state. With a marker, `failed` or `done`. Without one: `called` when the connector reports
 *  no tool status or when the call is not trailing; else `noResult` when it has no turn, or its turn
 *  ended or was superseded; else by presence: working `running`, waiting `pending`, idle or offline
 *  `noResult`. `trailing` means the call sits in its turn's last `tools` step and nothing but calls
 *  follows it. Never `failed` without the marker's isError. */
export function callState(call: ToolCall, at: { turn?: Turn; trailing: boolean; status: Status; toolStatus: boolean }): CallState {
  if (call.failed !== undefined) return call.failed ? "failed" : "done";
  if (!at.toolStatus || !at.trailing) return "called";
  const t = at.turn;
  if (t === undefined || t.outcome !== "open" || t.superseded) return "noResult";
  if (at.status === "working") return "running";
  if (at.status === "waiting") return "pending";
  return "noResult";
}

// ── Words ────────────────────────────────────────────────────────────────────────────────────────

type Titled = Exclude<CallState, "called">;
interface Words {
  title: Record<Titled, string>;
  /** The group part for one call, and for n calls with `#` for n. */
  one: string;
  many: string;
  /** The noun for "<n> <noun> failed". */
  noun: [string, string];
}

/** The wording table: one row per kind, every title sentence case. */
const TOOL_WORDS: Readonly<Record<ToolKind, Words>> = {
  command: {
    title: { running: "Running a command", done: "Ran a command", failed: "A command failed", pending: "A command hasn't finished", noResult: "No result arrived for a command" },
    one: "ran a command", many: "ran # commands", noun: ["command", "commands"],
  },
  edit: {
    title: { running: "Editing a file", done: "Edited a file", failed: "An edit failed", pending: "An edit hasn't finished", noResult: "No result arrived for an edit" },
    one: "made an edit", many: "made # edits", noun: ["edit", "edits"],
  },
  write: {
    title: { running: "Writing a file", done: "Wrote a file", failed: "A write failed", pending: "A write hasn't finished", noResult: "No result arrived for a write" },
    one: "wrote a file", many: "wrote # times", noun: ["write", "writes"],
  },
  read: {
    title: { running: "Reading a file", done: "Read a file", failed: "A read failed", pending: "A read hasn't finished", noResult: "No result arrived for a read" },
    one: "read a file", many: "read # times", noun: ["read", "reads"],
  },
  send: {
    title: { running: "Sending a message", done: "Sent a message", failed: "A message failed", pending: "A message hasn't finished", noResult: "No result arrived for a message" },
    one: "sent a message", many: "sent # messages", noun: ["message", "messages"],
  },
  dm: {
    title: { running: "Sending a direct message", done: "Sent a direct message", failed: "A direct message failed", pending: "A direct message hasn't finished", noResult: "No result arrived for a direct message" },
    one: "sent a direct message", many: "sent # direct messages", noun: ["direct message", "direct messages"],
  },
  inbox: {
    title: { running: "Checking the inbox", done: "Checked the inbox", failed: "An inbox check failed", pending: "An inbox check hasn't finished", noResult: "No result arrived for an inbox check" },
    one: "checked the inbox", many: "checked the inbox # times", noun: ["inbox check", "inbox checks"],
  },
  other: {
    title: { running: "Using a tool", done: "Used a tool", failed: "A tool call failed", pending: "A tool call hasn't finished", noResult: "No result arrived for a tool call" },
    one: "called a tool", many: "called # tools", noun: ["tool call", "tool calls"],
  },
};
// The other-tools part when other kinds share the group.
const OTHER_AMONG = { one: "called another tool", many: "called # other tools" };

const capital = (s: string): string => s.charAt(0).toUpperCase() + s.slice(1);
const count = (pattern: { one: string; many: string }, n: number): string => (n === 1 ? pattern.one : pattern.many.replace("#", String(n)));
const plural = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`;

/** A call's title: the wording table's, or `Called <short name>` for a call in the `called` state. */
export function callTitle(kind: ToolKind, state: CallState, name: string): string {
  return state === "called" ? `Called ${name}` : TOOL_WORDS[kind].title[state];
}

/** A group's title. With tool status: a part per kind, in order of first appearance, each with its
 *  count of calls, joined ", " and capitalised ("Checked the inbox 2 times, made an edit, ran a
 *  command"). Without: `Called ` and the short names in call order ("Called Write, Bash and Bash").
 *  `failed` counts the failed calls. */
export function groupTitle(calls: readonly ToolCall[], toolStatus: boolean): { title: string; failed: number } {
  const failed = calls.filter((c) => c.failed === true).length;
  if (!toolStatus) {
    const names = calls.map((c) => c.name);
    const list = names.length < 2 ? names.join("") : `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;
    return { title: `Called ${list}`, failed };
  }
  const counts = new Map<ToolKind, number>();
  for (const c of calls) counts.set(c.kind, (counts.get(c.kind) ?? 0) + 1);
  const mixed = counts.size > 1;
  const parts = [...counts].map(([kind, n]) => count(kind === "other" && mixed ? OTHER_AMONG : TOOL_WORDS[kind], n));
  return { title: capital(parts.join(", ")), failed };
}

/** Every call a turn holds, in order. */
const callsOf = (turn: Turn): ToolCall[] => turn.steps.flatMap((s) => (s.kind === "tools" ? s.calls : []));

/** A turn's title, and when it holds failed calls `failed`: `<n> <noun> failed` when they are one
 *  kind, `<n> calls failed` when they are mixed. */
export function turnTitle(turn: Turn, status: Status, now: number): { title: string; failed?: string } {
  const span = (from: number | undefined, to: number | undefined) =>
    from === undefined || to === undefined ? undefined : formatDuration(to - from, false);
  const said = (lead: string, d: string | undefined, bare: string) => (d === undefined ? bare : `${lead} ${d}`);
  let title: string;
  if (turn.outcome === "finished") title = said("Worked for", span(turn.start, turn.end), "Worked");
  else if (turn.outcome === "failed") title = said("Turn failed after", span(turn.start, turn.end), "Turn failed");
  else if (turn.superseded || (status !== "working" && status !== "waiting")) title = "No end arrived for this turn";
  else if (status === "working") title = said("Working for", span(turn.start, now), "Working");
  else title = said("Open for", span(turn.start, now), "Open");

  const bad = callsOf(turn).filter((c) => c.failed === true);
  if (bad.length === 0) return { title };
  const kinds = new Set(bad.map((c) => c.kind));
  const [one, many] = kinds.size === 1 ? TOOL_WORDS[bad[0].kind].noun : ["call", "calls"];
  return { title, failed: `${plural(bad.length, one, many)} failed` };
}

const BY: Record<TurnSource, string> = {
  prompt: "started by a prompt",
  mesh: "started by a message from the mesh",
  continuation: "started by the harness continuing itself",
  notification: "started by a notification",
};

/** A turn's description: its span (`<hh:mm> to <hh:mm>` closed, `since <hh:mm>` open), what started
 *  it when the source is known, its steps (calls, prose and posts), and the first channel it posted
 *  in, joined " · ". `now` is not read: an open turn's description does not count. */
export function turnDescription(turn: Turn, now: number): string {
  const parts: string[] = [];
  const from = hhmm(turn.start);
  const to = hhmm(turn.end);
  if (turn.outcome === "open") {
    if (from !== undefined) parts.push(`since ${from}`);
  } else if (from !== undefined && to !== undefined) parts.push(`${from} to ${to}`);
  if (turn.source !== undefined) parts.push(BY[turn.source]);
  let steps = 0;
  for (const s of turn.steps) {
    if (s.kind === "tools") steps += s.calls.length;
    else if (s.kind === "said" || s.kind === "prompt" || s.kind === "reasoning" || s.kind === "post") steps++;
  }
  parts.push(plural(steps, "step", "steps"));
  const posted = turn.steps.find((s) => s.kind === "post" && s.channel !== undefined);
  if (posted?.kind === "post") parts.push(`posted in #${posted.channel}`);
  return parts.join(" · ");
}

/** A call's description: the short name and its precise duration when done or failed, its whole
 *  seconds counting while running, `started <hh:mm>` while pending or with no result, and only its
 *  time when `called`. A part the wire gives no time for is left out. */
export function callDescription(call: ToolCall, state: CallState, now: number): string {
  const at = hhmm(call.ts);
  if (state === "called") return at ?? "";
  let tail: string | undefined;
  if (state === "done" || state === "failed") tail = call.ts === undefined || call.end === undefined ? undefined : formatDuration(call.end - call.ts, true);
  else if (state === "running") tail = call.ts === undefined ? undefined : formatDuration(now - call.ts, false);
  else tail = at === undefined ? undefined : `started ${at}`;
  return tail === undefined ? call.name : `${call.name} · ${tail}`;
}

/** A group's description. With tool status: `<n> steps`, and the span from the first start to the
 *  last end when every call has both. Without: `<n> calls` and the first to the last start, one time
 *  when they match. */
export function groupDescription(calls: readonly ToolCall[], toolStatus: boolean): string {
  if (toolStatus) {
    const n = plural(calls.length, "step", "steps");
    const timed = calls.length > 0 && calls.every((c) => c.ts !== undefined && c.end !== undefined);
    const d = timed ? formatDuration(Math.max(...calls.map((c) => c.end as number)) - (calls[0].ts as number), true) : undefined;
    return d === undefined ? n : `${n} · ${d}`;
  }
  const n = plural(calls.length, "call", "calls");
  const first = hhmm(calls[0]?.ts);
  const last = hhmm(calls.at(-1)?.ts);
  const span = first === undefined ? last : last === undefined || last === first ? first : `${first} to ${last}`;
  return span === undefined ? n : `${n} · ${span}`;
}

// ── Times ────────────────────────────────────────────────────────────────────────────────────────

const two = (n: number): string => String(n).padStart(2, "0");
/** `hh:mm` in the reader's own clock, or undefined when the wire gave no time a Date can hold. */
function hhmm(ts: number | undefined): string | undefined {
  if (ts === undefined || !Number.isFinite(ts)) return undefined;
  const d = new Date(ts);
  return Number.isNaN(d.getTime()) ? undefined : `${two(d.getHours())}:${two(d.getMinutes())}`;
}

/** Calls: "0.4s", "20.0s", "2m 31s", "1h 4m". Turns and live clocks: "12s", "3m 2s", "1h 4m".
 *  Under a minute, `precise` gives one decimal and otherwise whole seconds, both floored; then minutes
 *  and seconds; from an hour, hours and minutes. A negative or non-finite span has no duration. */
export function formatDuration(ms: number, precise: boolean): string | undefined {
  if (!Number.isFinite(ms) || ms < 0) return undefined;
  const s = Math.floor(ms / 1000);
  if (s < 60) return precise ? `${(Math.floor(ms / 100) / 10).toFixed(1)}s` : `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m ${s % 60}s`;
  return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
}
