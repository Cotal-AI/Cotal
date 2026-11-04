import { Loading03Icon, Menu01Icon, SidebarRightIcon } from "@hugeicons/core-free-icons";
import { useContext, useMemo, type ReactNode } from "react";
import type { CotalMessage, FeedMessage } from "../../api/types.js";
import { Icon } from "../../icons/Icon.tsx";
import { Badge } from "#client/ui/shadcn/badge.tsx";
import { Button } from "#client/ui/shadcn/button.tsx";
import { Marker, MarkerContent } from "#client/ui/shadcn/marker.tsx";
import { MessageScroller, MessageScrollerButton, MessageScrollerContent, MessageScrollerProvider, MessageScrollerViewport } from "#client/ui/shadcn/message-scroller.tsx";
import { Toggle } from "#client/ui/shadcn/toggle.tsx";
import { Tooltip, TooltipContent, TooltipTrigger } from "#client/ui/shadcn/tooltip.tsx";
import { claimedBy } from "../../lib/claims.js";
import type { ComposeTarget } from "../../lib/compose.js";
import { channelMembers } from "../../lib/members.js";
import { nameIndex, type NameIndex } from "../../lib/names.js";
import { rosterRows, waiting, type RosterRow } from "../../lib/roster.js";
import { useStore } from "../../state/hooks.js";
import type { Store } from "../../state/store.js";
import type { ChannelRow, DashboardState, StoredMessage } from "../../state/types.js";
import { Avatar } from "../Avatar.tsx";
import { useBadgeOf } from "../identity.js";
import { Composer, OutgoingRows } from "../Composer.tsx";
import { MessageRow } from "../MessageRow.tsx";
import { NeedsCard, needsKey, useDismissed } from "../NeedsCard.tsx";
import { SheetMenu } from "../sheet.js";
import { WorkingLine } from "../WorkingLine.tsx";
import { reducedMotion } from "../../viewport.ts";

/** How many members the header stack draws before the count alone carries the rest. */
const STACK = 4;
/** Stable empty list, so the store selector returns the same reference while nothing is open. */
const NONE: StoredMessage[] = [];

/** How a message was addressed, read from the field the wire sets for each mode. */
export const modeOf = (msg: CotalMessage): FeedMessage["mode"] =>
  typeof msg.toService === "string" ? "anycast" : typeof msg.to === "string" ? "unicast" : "chat";

/** The unit words a replay window is written in (`30m`, `24h`, `7d`), one and many. */
const UNIT: Record<string, [string, string]> = { s: ["second", "seconds"], m: ["minute", "minutes"], h: ["hour", "hours"], d: ["day", "days"] };

/** The header Badges for a channel's policy, with the notes' tooltips. A channel whose policy the
 *  server has not sent yet (a row a live message created) gets none, rather than a guess. A phone's
 *  header has no room for them, so it draws none. */
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
    if (newDay) {
      out.push(
        <Marker key={`day\u0001${msg.id}\u0001${senderId ?? ""}`} variant="separator" className="my-2">
          <MarkerContent>{day}</MarkerContent>
        </Marker>,
      );
    }
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

/** The scroller's jump to the newest message. It shows once the reader has scrolled up from the
 *  bottom, and scrolls at once rather than smoothly under reduced motion. */
export function JumpToLatest() {
  return <MessageScrollerButton behavior={reducedMotion() ? "auto" : "smooth"} />;
}

/** One channel (mock section D, the centre): the header with the topic, the policy chips and the
 *  member stack; the messages; the working line; and the dock with the Needs card.
 *
 *  - The messages are the open channel's, shown only while the open channel is this one. A reopen
 *    keeps them on screen while its history loads (the controller holds them). They sit in shadcn's
 *    Message Scroller, which opens a channel at the newest message, follows new ones while the reader
 *    is at the bottom, leaves the scroll where the reader put it otherwise, and offers a jump back.
 *  - Members are `channelMembers`: the broker's when its feed is authoritative, else who posted here.
 *    The member stack draws each one's status dot, so a working member's dot breathes. The stack is
 *    hidden from assistive tech, and the button's name is the count in words ("3 members"), which its
 *    Tooltip repeats.
 *  - The members presence says are working, in that order, make the header chip ("<n> working", or
 *    on a phone just the count, with the spokes turning and their names in its Tooltip) and the
 *    working line under the messages (`WorkingLine`). With nobody working neither is drawn.
 *  - The dock holds the card for the first waiting agent this browser has not dismissed, and the
 *    composer under it once `/api/meta` has said what the dashboard can post as. With neither it is
 *    not drawn at all. The operator's posts the list does not hold yet follow the messages.
 *  - `onMembers` and `onViewAgent` open the Members and Agent tabs. Without them (a view drawn with
 *    no panel) their buttons are disabled.
 *  - `onTogglePanel` adds the header's Toggle panel button, pressed while `panelOpen`, so a reader
 *    who closed the panel can bring it back.
 *  - On a phone (`SheetMenu`) the header opens with the menu button that shows the places sheet, the
 *    panel button is named Open agent panel, and the composer's mode line names the channel alone. */
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
  const badgeOf = useBadgeOf();
  const info = channels.find((c) => c.channel === channel);
  const members = useMemo(
    () => channelMembers(channel, membership, channels.map((c) => c.channel), messages),
    [channel, membership, channels, messages],
  );
  const working = members.map((m) => peers.get(m.id)).filter((r): r is RosterRow => r?.status === "working");
  const [dismissed, dismiss] = useDismissed();
  const needing = waiting(everyone).find((r) => !dismissed.has(needsKey(r)));
  const count = members.length;
  const sheet = useContext(SheetMenu);
  // On a phone the panel opens as a sheet over the page, so the button says what it does there, as mock F does.
  const panelLabel = sheet ? "Open agent panel" : "Toggle panel";
  const memberCount = `${count} member${count === 1 ? "" : "s"}`;
  const workingNow = `Working now: ${working.map((r) => r.name).join(", ")}`;
  return (
    <>
      <header className="ui-bar">
        {sheet && (
          <Tooltip>
            <TooltipTrigger asChild>
              <Button type="button" variant="ghost" size="icon" aria-label="Open sidebar" aria-haspopup="dialog" aria-expanded={sheet.open} onClick={sheet.show}>
                <Icon icon={Menu01Icon} />
              </Button>
            </TooltipTrigger>
            <TooltipContent>Open sidebar</TooltipContent>
          </Tooltip>
        )}
        <h1>{`# ${channel}`}</h1>
        {info?.description && <span className="ui-topic">{info.description}</span>}
        <span className="ui-sp" />
        {!sheet && policyChips(info).map((c) => (
          <Tooltip key={c.text}>
            <TooltipTrigger asChild>
              <Badge variant="outline">{c.text}<span className="ui-sr">{` ${c.title}`}</span></Badge>
            </TooltipTrigger>
            <TooltipContent>{c.title}</TooltipContent>
          </Tooltip>
        ))}
        {working.length > 0 && (
          <Tooltip>
            <TooltipTrigger asChild>
              <span className="ox-hchip">
                <Icon icon={Loading03Icon} size={16} className="ui-ic ox-spin" />
                {sheet ? working.length : `${working.length} working`}
                <span className="ui-sr">{` ${workingNow}`}</span>
              </span>
            </TooltipTrigger>
            <TooltipContent>{workingNow}</TooltipContent>
          </Tooltip>
        )}
        <Tooltip>
          {/* A disabled button fires no pointer events, so the Tooltip hangs on a span around it, which
              takes the focus while the button cannot. */}
          <TooltipTrigger asChild>
            <span className="inline-flex" tabIndex={onMembers ? undefined : 0}>
              <Button type="button" variant="ghost" size="sm" aria-label={memberCount} disabled={!onMembers} onClick={onMembers}>
                <span className="ui-stack" aria-hidden="true">
                  {members.slice(0, STACK).map((m) => {
                    const r = peers.get(m.id);
                    return <Avatar key={m.id} vendor={r?.harness} status={r?.status ?? "offline"} badge={r ? badgeOf(m.id) : undefined} size={22} />;
                  })}
                </span>
                {count}
              </Button>
            </span>
          </TooltipTrigger>
          <TooltipContent>{memberCount}</TooltipContent>
        </Tooltip>
        {onTogglePanel && (
          <Tooltip>
            <TooltipTrigger asChild>
              <Toggle aria-label={panelLabel} pressed={panelOpen} onPressedChange={onTogglePanel}>
                <Icon icon={SidebarRightIcon} />
              </Toggle>
            </TooltipTrigger>
            <TooltipContent>{panelLabel}</TooltipContent>
          </Tooltip>
        )}
      </header>
      <MessageScrollerProvider key={channel} autoScroll>
        <MessageScroller className="flex-1">
          <MessageScrollerViewport>
            <MessageScrollerContent className="ui-col gap-0">
              <MessageList messages={messages} idx={idx} peers={peers} />
              <OutgoingRows store={store} target={target} shown={shown} />
              <WorkingLine rows={working} />
            </MessageScrollerContent>
          </MessageScrollerViewport>
          <JumpToLatest />
        </MessageScroller>
      </MessageScrollerProvider>
      {(needing || post) && (
        <div className="ui-dock">
          <div className="ui-dock-in">
            {needing && <NeedsCard row={needing} onViewAgent={onViewAgent} onDismiss={() => dismiss(needsKey(needing))} post={post} selfId={self} />}
            <Composer store={store} target={target} where={`#${channel}`} to={sheet ? `to #${channel}` : `to #${channel} · ${count} member${count === 1 ? "" : "s"}`} />
          </div>
        </div>
      )}
    </>
  );
}
