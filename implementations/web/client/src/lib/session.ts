// An agent's session as the dashboard draws it: its AG-UI frames and its own verified posts, folded
// into one ordered list of steps.
//
// The third reader of the frame vocabulary. `aguiFrame.ts` (this client) and connector-core's
// `agui-render.ts` draw a frame as text lines; this folds the same events into items a view lays
// out. It keeps their fallbacks on purpose, because the parity suite compares all three: ids live in
// `Map`s (a plain object would reorder "2" and "10" and drop "__proto__"), every fallback keys on
// `undefined` and never on falsiness (an empty tool name stays "", an absent one is "?"), an empty
// stream draws nothing, and a stream with no END still shows, marked cut, where the renderers add a
// trailing " …". The deliberate differences are listed in `smoke/agui-render-parity.smoke.ts`.
//
// It draws only what the wire says. A tool call is a name and a time, since the plane drops its
// arguments and result. A turn that ended is not a turn that succeeded. A run error carries no
// reason here: presence is where a reason comes from, and the view asks presence. A post is the
// agent's own verified chat message placed by its time, and it is never joined to a `cotal_send` call.
//
// Pure: no React, no browser, and nothing from `@cotal-ai/*` at runtime.
import type { CotalMessage } from "../api/types.js";
import type { StoredMessage } from "../state/types.js";
import { partsToText } from "./parts.js";

export type TurnSource = "prompt" | "mesh" | "continuation" | "notification";
export interface SessionFrame { id: string; ts: number; events: unknown[]; live: boolean }
export interface ToolCall { name: string; full: string; ts?: number }
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
 *  is; a further frame part in the same message is `<message id>#<n>`, n counting frame parts from 1. */
export function framesOf(msg: CotalMessage, live: boolean): SessionFrame[] {
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

/** One step before the posts are merged and the calls grouped. `at` is its time for the merge. */
type Flat =
  | { item: SessionItem; at?: number; live: boolean }
  | { call: ToolCall; key: string; at?: number; live: boolean };

/** A stream being accumulated: its text, the role its START gave, the key of the event that opened
 *  it, the time of the last event that touched it, and whether every frame it came from was live. */
interface Stream { text: string; user: boolean; key: string; at?: number; live: boolean }

/** Fold frames and posts into the steps a session view draws, oldest first.
 *
 *  Text and reasoning accumulate by `messageId` and land where their END lands, as the renderers
 *  flush them; a call lands where it starts. Posts merge by time: a post goes before the first frame
 *  step whose time is later. Calls then group: a call joins the calls right before it, and any other
 *  step (text, a post, a turn line) ends the group. */
export function foldSession(frames: readonly SessionFrame[], posts: readonly StoredMessage[]): SessionStep[] {
  const flat: Flat[] = [];
  const text = new Map<string, Stream>();
  const reasoning = new Map<string, Stream>();

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
          flat.push({ call: { name: toolShortName(full), full, ...(at !== undefined ? { ts: at } : {}) }, key, at, live });
          break;
        }
        // The plane drops a call's arguments and result, and its END says nothing new: none is drawn.
        case "TOOL_CALL_END":
        case "TOOL_CALL_ARGS":
        case "TOOL_CALL_RESULT":
          break;

        case "CUSTOM":
          flat.push({ item: { kind: "unknown", key, label: `Custom event ${str(e.name) === undefined ? "(unnamed)" : JSON.stringify(e.name)}`, ts: at }, at, live });
          break;

        // Named, never skipped: a skipped event is a hole in a transcript that still looks complete.
        default:
          flat.push({ item: { kind: "unknown", key, label: `Unrecognised event ${JSON.stringify(type ?? null)}`, ts: at }, at, live });
      }
    });
  }

  cutOpen();

  // Posts by time, stable, then each one before the first frame step whose time is later. A post whose
  // ts is not a finite number has no time to place it by, so it goes last, in arrival order.
  const ordered = posts
    .filter((p) => typeof p.msg.channel === "string")
    .map((p, i) => ({ p, i, at: finite(p.msg.ts) }))
    .sort((a, b) => (a.at ?? Infinity) - (b.at ?? Infinity) || a.i - b.i)
    .map(({ p, at }): Flat => ({ item: { kind: "post", key: `post:${p.msg.id}`, channel: p.msg.channel as string, msg: p.msg }, at, live: true }));
  const before = (post: number | undefined, step: number | undefined) => post !== undefined && step !== undefined && post < step;
  const merged: Flat[] = [];
  let next = 0;
  for (const s of flat) {
    while (next < ordered.length && before(ordered[next].at, s.at)) merged.push(ordered[next++]);
    merged.push(s);
  }
  while (next < ordered.length) merged.push(ordered[next++]);

  // Calls group with the calls right before them; anything else ends the group.
  const steps: SessionStep[] = [];
  let group: (SessionStep & { kind: "tools" }) | undefined;
  for (const s of merged) {
    if ("call" in s) {
      if (group !== undefined) {
        group.calls.push(s.call);
        group.live = group.live && s.live;
      } else {
        group = { kind: "tools", key: s.key, calls: [s.call], live: s.live };
        steps.push(group);
      }
      continue;
    }
    group = undefined;
    steps.push({ ...s.item, live: s.live });
  }
  return steps;
}
