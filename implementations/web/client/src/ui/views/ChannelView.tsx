import { useLayoutEffect, useMemo, useRef, type ReactNode } from "react";
import type { CotalMessage, FeedMessage } from "../../api/types.js";
import { claimedBy } from "../../lib/claims.js";
import { channelMembers } from "../../lib/members.js";
import { nameIndex, type NameIndex } from "../../lib/names.js";
import { rosterRows, statusLabel, waiting, type RosterRow } from "../../lib/roster.js";
import { useStore } from "../../state/hooks.js";
import type { Store } from "../../state/store.js";
import type { ChannelRow, DashboardState, StoredMessage } from "../../state/types.js";
import { Avatar } from "../Avatar.tsx";
import { MessageRow } from "../MessageRow.tsx";
import { NeedsCard, needsKey, useDismissed } from "../NeedsCard.tsx";

/** How many members the header stack draws before the count alone carries the rest. */
const STACK = 4;
/** A reader within this many pixels of the bottom is following the conversation. */
const PINNED_PX = 24;
/** Stable empty list, so the store selector returns the same reference while nothing is open. */
const NONE: StoredMessage[] = [];

/** How a message was addressed, read from the field the wire sets for each mode. */
export const modeOf = (msg: CotalMessage): FeedMessage["mode"] =>
  typeof msg.toService === "string" ? "anycast" : typeof msg.to === "string" ? "unicast" : "chat";

/** The unit words a replay window is written in (`30m`, `24h`, `7d`), one and many. */
const UNIT: Record<string, [string, string]> = { s: ["second", "seconds"], m: ["minute", "minutes"], h: ["hour", "hours"], d: ["day", "days"] };

/** The header chips for a channel's policy, with the notes' tooltips. A channel whose policy the
 *  server has not sent yet (a row a live message created) gets none, rather than a guess. */
function policyChips(info: ChannelRow | undefined): { text: string; title: string }[] {
  const out: { text: string; title: string }[] = [];
  if (info?.deliveryClass === "durable") out.push({ text: "durable", title: "Kept for members who are offline" });
  if (info?.replay === true) {
    const w = info.replayWindow;
    if (w === undefined) {
      out.push({ text: "replay", title: "New members see every message the channel keeps" });
    } else {
      const m = /^(\d+)(s|m|h|d)$/.exec(w.trim());
      const span = m ? (Number(m[1]) === 1 ? UNIT[m[2]][0] : `${m[1]} ${UNIT[m[2]][1]}`) : w;
      out.push({ text: `replay ${w}`, title: `New members see the last ${span}` });
    }
  }
  return out;
}

/** The divider for the day `ts` falls on, in the reader's own calendar. */
function dayLabel(ts: number, now: number): string {
  const day = (t: number) => {
    const d = new Date(t);
    return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  };
  const today = day(now);
  const that = day(ts);
  if (that === today) return "Today";
  if (that === day(today - 12 * 3_600_000)) return "Yesterday";
  const d = new Date(ts);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/** A list of messages as the channel and DM views draw it: a divider at each new day, and a run of
 *  rows from one verified sender collapsed under its first header. A divider breaks a run, and a row
 *  with no verified sender always draws its header (MessageRow enforces that too). Rows are keyed by
 *  id and sender together, so one id from two senders draws both. */
export function MessageList({ messages, idx, peers }: { messages: StoredMessage[]; idx: NameIndex; peers: ReadonlyMap<string, RosterRow> }) {
  const now = Date.now();
  const out: ReactNode[] = [];
  let lastDay: string | undefined;
  messages.forEach(({ msg, senderId }, i) => {
    const day = Number.isFinite(msg.ts) ? dayLabel(msg.ts, now) : undefined;
    const newDay = day !== undefined && day !== lastDay;
    if (newDay) out.push(<div key={`day\u0001${day}`} className="ui-day">{day}</div>);
    if (day !== undefined) lastDay = day;
    const prev = messages[i - 1];
    const compact = !newDay && prev !== undefined && senderId !== undefined && prev.senderId === senderId;
    const mode = modeOf(msg);
    out.push(
      <MessageRow
        key={`${msg.id}\u0001${senderId ?? ""}`}
        msg={msg}
        senderId={senderId}
        mode={mode}
        idx={idx}
        peers={peers}
        compact={compact}
        mention="operator"
        claim={mode === "anycast" ? claimedBy(msg.id, messages.slice(i + 1)) : undefined}
      />,
    );
  });
  return <>{out}</>;
}

/** The part of the scrolling element the pin reads. Spelled out rather than taken from the DOM lib,
 *  because the suites typecheck the components that render on the server with no DOM lib. */
type Scroller = { scrollTop: number; scrollHeight: number; clientHeight: number };

/** Keep a list's scroll at the newest message while the reader is at the bottom, and leave it where
 *  the reader put it otherwise. It acts only when `list` changes (a new conversation, which starts at
 *  the bottom) or `last` does (a new newest message), so a reload of the same rows moves nothing.
 *  Hand the returned ref and `onScroll` to the scrolling element. */
export function usePinnedScroll(list: string, last: string | undefined) {
  const ref = useRef<HTMLDivElement>(null);
  const pinned = useRef(true);
  const shown = useRef<string | null>(null);
  const scroller = () => ref.current as unknown as Scroller | null;
  useLayoutEffect(() => {
    const el = scroller();
    if (!el) return;
    if (shown.current !== list) {
      shown.current = list;
      pinned.current = true;
    }
    if (pinned.current) el.scrollTop = el.scrollHeight;
  }, [list, last]);
  const onScroll = () => {
    const el = scroller();
    if (el) pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight <= PINNED_PX;
  };
  return { ref, onScroll };
}

/** One channel (mock section D, the centre): the header with the topic, the policy chips and the
 *  member stack; the messages; the working line; and the dock with the Needs card.
 *
 *  - The messages are the open channel's, shown only while the open channel is this one. A reopen
 *    keeps them on screen while its history loads (the controller holds them), and the scroll stays
 *    where the reader left it.
 *  - Members are `channelMembers`: the broker's when its feed is authoritative, else who posted here.
 *  - The working line names the first member of this channel, in that order, whose status is
 *    working, with the honest progress text from `statusLabel`. Unknown progress draws no moving dots.
 *  - The dock holds the card for the first waiting agent this browser has not dismissed, and is not
 *    drawn at all when there is none. Phase 3 adds the composer under it.
 *  - `onMembers` and `onViewAgent` open the Members and Agent tabs. The panel that has them is not
 *    built yet, so the shell passes neither and their buttons are disabled. */
export function ChannelView({ store, channel, onMembers, onViewAgent }: {
  store: Store<DashboardState>;
  channel: string;
  onMembers?: () => void;
  onViewAgent?: (id: string) => void;
}) {
  const open = useStore(store, (s) => s.open);
  const channels = useStore(store, (s) => s.channels);
  const roster = useStore(store, (s) => s.roster);
  const membership = useStore(store, (s) => s.membership);
  const messages = open?.channel === channel ? open.messages : NONE;
  const idx = useMemo(() => nameIndex(roster), [roster]);
  const everyone = useMemo(() => rosterRows(roster, { includeOffline: true }), [roster]);
  const peers = useMemo(() => new Map(everyone.map((r) => [r.id, r])), [everyone]);
  const info = channels.find((c) => c.channel === channel);
  const members = useMemo(
    () => channelMembers(channel, membership, channels.map((c) => c.channel), messages),
    [channel, membership, channels, messages],
  );
  const working = members.map((m) => peers.get(m.id)).find((r) => r?.status === "working");
  const [dismissed, dismiss] = useDismissed();
  const needing = waiting(everyone).find((r) => !dismissed.has(needsKey(r)));
  const tail = messages[messages.length - 1];
  const scroll = usePinnedScroll(channel, tail && `${tail.msg.id}\u0001${tail.senderId ?? ""}`);
  const count = members.length;
  return (
    <>
      <header className="ui-bar">
        <h1>{`# ${channel}`}</h1>
        {info?.description && <span className="ui-topic">{info.description}</span>}
        <span className="ui-sp" />
        {policyChips(info).map((c) => <span key={c.text} className="ui-chip" title={c.title}>{c.text}</span>)}
        <button type="button" className="ui-members" title={`${count} member${count === 1 ? "" : "s"}`} disabled={!onMembers} onClick={onMembers}>
          <span className="ui-stack">
            {members.slice(0, STACK).map((m) => {
              const r = peers.get(m.id);
              return <Avatar key={m.id} vendor={r?.harness} status={r?.status ?? "offline"} size={22} dot={false} />;
            })}
          </span>
          {count}
        </button>
      </header>
      <div className="ui-scroll" ref={scroll.ref} onScroll={scroll.onScroll}>
        <div className="ui-col">
          <MessageList messages={messages} idx={idx} peers={peers} />
          {working && (
            <div className="ui-typing">
              <Avatar vendor={working.harness} status={working.status} size={18} dot={false} />
              <b>{working.name}</b>
              {` is ${statusLabel(working)} `}
              {working.progress?.kind !== "unknown" && <span className="ui-dots"><i /><i /><i /></span>}
              {working.activity && <span>{working.activity}</span>}
            </div>
          )}
        </div>
      </div>
      {needing && (
        <div className="ui-dock">
          <div className="ui-dock-in">
            <NeedsCard row={needing} onViewAgent={onViewAgent} onDismiss={() => dismiss(needsKey(needing))} />
          </div>
        </div>
      )}
    </>
  );
}
