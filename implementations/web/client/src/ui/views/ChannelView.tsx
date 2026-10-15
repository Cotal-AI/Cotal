import { Menu01Icon, SidebarRightIcon } from "@hugeicons/core-free-icons";
import { useContext, useLayoutEffect, useMemo, useRef, type ReactNode } from "react";
import type { CotalMessage, FeedMessage } from "../../api/types.js";
import { Icon } from "../../icons/Icon.tsx";
import { claimedBy } from "../../lib/claims.js";
import { composeKey, type ComposeTarget } from "../../lib/compose.js";
import { channelMembers } from "../../lib/members.js";
import { nameIndex, type NameIndex } from "../../lib/names.js";
import { rosterRows, statusLabel, waiting, type RosterRow } from "../../lib/roster.js";
import { useStore } from "../../state/hooks.js";
import type { Store } from "../../state/store.js";
import type { ChannelRow, DashboardState, StoredMessage } from "../../state/types.js";
import { Avatar } from "../Avatar.tsx";
import { Composer, OutgoingRows } from "../Composer.tsx";
import { MessageRow } from "../MessageRow.tsx";
import { NeedsCard, needsKey, useDismissed } from "../NeedsCard.tsx";
import { SheetMenu } from "../sheet.js";

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
  // One written form for every reader ("14 October"), with the year only when it is not this one.
  // The locale is fixed so the label does not change with the browser's language.
  const d = new Date(ts);
  const thisYear = d.getFullYear() === new Date(now).getFullYear();
  return d.toLocaleDateString("en-GB", thisYear ? { day: "numeric", month: "long" } : { day: "numeric", month: "long", year: "numeric" });
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
    // Keyed by the row it opens, not by its label: a sender whose clock is skewed can make one label
    // come round twice, and two "Today" keys would collide.
    if (newDay) out.push(<div key={`day\u0001${msg.id}\u0001${senderId ?? ""}`} className="ui-day">{day}</div>);
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
 *  - The dock holds the card for the first waiting agent this browser has not dismissed, and the
 *    composer under it once `/api/meta` has said what the dashboard can post as. With neither it is
 *    not drawn at all. The operator's posts the list does not hold yet follow the messages.
 *  - `onMembers` and `onViewAgent` open the Members and Agent tabs. Without them (a view drawn with
 *    no panel) their buttons are disabled.
 *  - `onTogglePanel` adds the header's Toggle panel button, pressed while `panelOpen`, so a reader
 *    who closed the panel can bring it back.
 *  - On a phone (`SheetMenu`) the header opens with the menu button that shows the places sheet, and
 *    the panel button is titled Open agent panel. */
export function ChannelView({ store, channel, onMembers, onViewAgent, panelOpen = false, onTogglePanel }: {
  store: Store<DashboardState>;
  channel: string;
  onMembers?: () => void;
  onViewAgent?: (id: string) => void;
  panelOpen?: boolean;
  onTogglePanel?: () => void;
}) {
  const open = useStore(store, (s) => s.open);
  const channels = useStore(store, (s) => s.channels);
  const roster = useStore(store, (s) => s.roster);
  const membership = useStore(store, (s) => s.membership);
  const post = useStore(store, (s) => s.post);
  const self = useStore(store, (s) => s.operatorId);
  const messages = open?.channel === channel ? open.messages : NONE;
  const target = useMemo((): ComposeTarget => ({ kind: "msg", channel }), [channel]);
  const shown = useMemo(() => new Set(messages.map((m) => m.msg.id)), [messages]);
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
  // A post the operator sends moves the bottom too, so a reader following the channel sees it.
  const sent = useStore(store, (s) => s.drafts[composeKey(target)]?.outgoing.length ?? 0);
  const scroll = usePinnedScroll(channel, `${tail ? `${tail.msg.id}\u0001${tail.senderId ?? ""}` : ""}\u0002${sent}`);
  const count = members.length;
  const sheet = useContext(SheetMenu);
  // On a phone the panel opens over the whole page, so the button says what it does there, as mock F does.
  const panelLabel = sheet ? "Open agent panel" : "Toggle panel";
  return (
    <>
      <header className="ui-bar">
        {sheet && (
          <button type="button" className="ui-tool" title="Open sidebar" aria-label="Open sidebar" aria-haspopup="dialog" aria-expanded={sheet.open} onClick={sheet.show}>
            <Icon icon={Menu01Icon} className="ui-ic" />
          </button>
        )}
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
        {onTogglePanel && (
          <button type="button" className="ui-tool" title={panelLabel} aria-label={panelLabel} aria-pressed={panelOpen} onClick={onTogglePanel}>
            <Icon icon={SidebarRightIcon} className="ui-ic" />
          </button>
        )}
      </header>
      <div className="ui-scroll" ref={scroll.ref} onScroll={scroll.onScroll}>
        <div className="ui-col">
          <MessageList messages={messages} idx={idx} peers={peers} />
          <OutgoingRows store={store} target={target} shown={shown} />
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
      {(needing || post) && (
        <div className="ui-dock">
          <div className="ui-dock-in">
            {needing && <NeedsCard row={needing} onViewAgent={onViewAgent} onDismiss={() => dismiss(needsKey(needing))} post={post} selfId={self} />}
            <Composer store={store} target={target} where={`#${channel}`} to={`to #${channel} · ${count} member${count === 1 ? "" : "s"}`} />
          </div>
        </div>
      )}
    </>
  );
}
