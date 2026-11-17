import { Loading03Icon, Plug01Icon } from "@hugeicons/core-free-icons";
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode, type Ref } from "react";
import { Icon } from "../icons/Icon.tsx";
import { RailIcon } from "../icons/rail.tsx";
import { footerLine } from "../lib/compose.js";
import { dmPairs, pairKey } from "../lib/dms.js";
import { channelMembers } from "../lib/members.js";
import { displayNameOf, nameIndex } from "../lib/names.js";
import { rosterRows, waiting, type RosterRow } from "../lib/roster.js";
import { formatRoute, type Route } from "../lib/route.js";
import { rateText } from "../lib/shellText.js";
import { useStore } from "../state/hooks.js";
import type { Store } from "../state/store.js";
import type { Connection, DashboardState } from "../state/types.js";
import { Avatar as InitialsAvatar, AvatarFallback } from "#client/ui/shadcn/avatar.tsx";
import { Badge } from "#client/ui/shadcn/badge.tsx";
import { Empty, EmptyDescription, EmptyHeader } from "#client/ui/shadcn/empty.tsx";
import { Item, ItemActions, ItemContent, ItemDescription, ItemMedia, ItemTitle } from "#client/ui/shadcn/item.tsx";
import { SidebarContent, SidebarFooter, SidebarGroup, SidebarGroupLabel, SidebarHeader, SidebarMenu, SidebarMenuBadge, SidebarMenuButton, SidebarMenuItem, useSidebar } from "#client/ui/shadcn/sidebar.tsx";
import { Tooltip, TooltipContent, TooltipTrigger } from "#client/ui/shadcn/tooltip.tsx";
import { Avatar } from "./Avatar.tsx";
import { useBadgeOf } from "./identity.js";
import { Unverified } from "./MessageRow.tsx";
import { SkeletonPlaces } from "./Skeleton.tsx";
import { StaleMarker } from "./StaleMarker.tsx";

/** How often the Activity row redraws its rate. The rate falls as the window slides past old
 *  messages, with no message to trigger a render, so the row asks again on this beat. */
const RATE_TICK_MS = 1000;

/** How many direct message conversations the sidebar lists before "Show all". */
export const DM_ROWS = 10;

/** A channel the runtime writes a run's events to (`run.build-0412`). */
const isEventChannel = (channel: string): boolean => channel.startsWith("run.");

/** The pill while the feed is not open. Only `closed` says Disconnected: there the browser has failed
 *  the feed for good, while in the other two it is still trying, and the pill says what it is doing. */
const PILL: Record<Exclude<Connection, "connected">, { text: string; title: string }> = {
  connecting: { text: "Connecting", title: "Connecting to cotal web" },
  reconnecting: { text: "Reconnecting", title: "Reconnecting to cotal web" },
  closed: { text: "Disconnected", title: "The live feed closed and will not retry. Reload the page, or open the link cotal web printed when it started." },
};

/** What a channel row's working count says: how many members work, and who. */
const workingTitle = (working: RosterRow[]): string => `${working.length} member${working.length === 1 ? "" : "s"} working: ${working.map((r) => r.name).join(", ")}`;

/** One place, as shadcn's sidebar menu draws it: a link to `to`, active and `aria-current` while
 *  `here`. `tip`, when given, is the row's Tooltip, shown whether or not the sidebar is collapsed. A
 *  phone has no hover, so there the row has none, and the link takes focus without opening one.
 *  `badge`, when given, is the count at the row's end in a SidebarMenuBadge. The badge sits beside
 *  the link, not in it, so it is hidden from assistive tech and the caller says the count in the
 *  link's own text; the link keeps room for it at its end. `link` reaches the link itself. */
function Row({ to, here, tip, badge, link, children }: { to: Route; here: boolean; tip?: string; badge?: ReactNode; link?: Ref<HTMLAnchorElement>; children: ReactNode }) {
  const { isMobile } = useSidebar();
  return (
    <SidebarMenuItem>
      <SidebarMenuButton asChild isActive={here} className={badge === undefined ? undefined : "pr-8"} tooltip={tip === undefined || isMobile ? undefined : { children: tip, hidden: false }}>
        <a ref={link} href={formatRoute(to)} aria-current={here ? "page" : undefined}>{children}</a>
      </SidebarMenuButton>
      {badge !== undefined && <SidebarMenuBadge aria-hidden="true">{badge}</SidebarMenuBadge>}
    </SidebarMenuItem>
  );
}

/** The connection pill, a Badge with a dot whose shape says the state: filled while the feed is open,
 *  hollow and dashed while it is not, and destructive once it has closed for good. Its reason is the
 *  Tooltip and the screen reader text. */
function ConnectionPill({ connection }: { connection: Connection }) {
  const { text, title } = connection === "connected" ? { text: "Connected", title: "Connected to cotal web" } : PILL[connection];
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Badge variant={connection === "closed" ? "destructive" : "outline"}>
          <i className={connection === "connected" ? "ui-mdot ui-mdot-live" : "ui-mdot ui-mdot-down"} />
          {text}
          <span className="ui-sr">{` ${title}`}</span>
        </Badge>
      </TooltipTrigger>
      <TooltipContent>{title}</TooltipContent>
    </Tooltip>
  );
}

/** The places (mock section D), drawn inside the shell's places Sidebar: the space's name in the
 *  header, the stale marker, the places as shadcn's sidebar groups and menus, and the operator with
 *  the connection pill in the footer. It draws from the store and the route only.
 *
 *  `msgPerSecond` is read on every render and again every second, so the Activity row follows the
 *  rate as it falls. The rate itself lives outside the store, which holds serializable state.
 *
 *  Needs you counts the agents waiting, with the count in words as its Tooltip. A channel with
 *  members presence says are working shows the turning spokes and how many, with their names in its
 *  Tooltip and its screen reader text, and its unread count in the badge. Its members are
 *  `channelMembers` over the broker's membership alone, with no posts, so the count reads presence
 *  and membership and never the event plane: with no authoritative feed no channel shows one. A
 *  direct message row draws each party's status dot when the roster holds it, so a working agent's
 *  dot breathes there. The avatars are hidden from assistive tech, so the row's name is the two names
 *  it shows.
 *
 *  A direct message conversation holding a row read from history says unverified, as a message row
 *  does, because it was grouped by what the payload says about its own sender. A conversation is
 *  named, and linked, opener first: the sender of its first message, then the other party, as the
 *  mock writes "reviewer_2, david".
 *
 *  The conversations are grouped from the DMs alone and named from the roster as they are drawn, so
 *  the heartbeats that change the roster every two seconds do not regroup them. The ten most recent
 *  are listed, and the open conversation too when it is older, then a "Show all" button with the
 *  count, which lists every one in place and then reads "Show fewer".
 *
 *  While the first roster and channel reads are outstanding the places are skeleton rows.
 *
 *  The footer's second line is the operator's place on the roster (`footerLine`): nothing until
 *  `/api/meta` has said what the dashboard can post as, then "Not on the roster" until the operator's
 *  id is on it, "On the roster" once it is, and "Read only" when posting is off. Its reason is the
 *  tooltip, and the line takes the keyboard focus with the reason as its accessible description, so
 *  a reader without a pointer reaches it too. The operator's own id reads "operator (you)" in a conversation until the roster names it.
 *
 *  On a phone the places are the Sidebar's sheet. They mount as it opens, and the first place takes
 *  the focus: Radix would give it to the first thing that is not a link, the roster line at the foot.
 *  The sheet closes on any new route, as picking a place is one.
 *
 *  A "to you" mark on a direct message, which the mock draws, is left out. The space name has no menu
 *  until the server can list the other spaces. */
export function Sidebar({ store, route, msgPerSecond }: { store: Store<DashboardState>; route: Route; msgPerSecond: () => number }) {
  const space = useStore(store, (s) => s.space);
  const channels = useStore(store, (s) => s.channels);
  const unread = useStore(store, (s) => s.unread);
  const roster = useStore(store, (s) => s.roster);
  const dms = useStore(store, (s) => s.dms);
  const membership = useStore(store, (s) => s.membership);
  const connection = useStore(store, (s) => s.connection);
  const loading = useStore(store, (s) => s.loading);
  const post = useStore(store, (s) => s.post);
  const self = useStore(store, (s) => s.operatorId);
  const [, setTick] = useState(0);
  useEffect(() => {
    const timer = setInterval(() => setTick((t) => t + 1), RATE_TICK_MS);
    return () => clearInterval(timer);
  }, []);
  const { isMobile, setOpenMobile } = useSidebar();
  const firstPlace = useRef<HTMLAnchorElement>(null);
  useLayoutEffect(() => {
    if (isMobile) firstPlace.current?.focus();
  }, [isMobile]);
  const here = formatRoute(route);
  const shownOn = useRef(here);
  useEffect(() => {
    if (shownOn.current === here) return;
    shownOn.current = here;
    setOpenMobile(false);
  }, [here, setOpenMobile]);
  const rows = useMemo(() => rosterRows(roster, { includeOffline: true }), [roster]);
  const idx = useMemo(() => nameIndex(roster), [roster]);
  const byId = useMemo(() => new Map(rows.map((r) => [r.id, r])), [rows]);
  const badgeOf = useBadgeOf();
  const busy = useMemo(() => {
    const names = channels.map((c) => c.channel);
    return new Map(channels.map((c) => [c.channel, channelMembers(c.channel, membership, names, []).map((m) => byId.get(m.id)).filter((r): r is RosterRow => r?.status === "working")]));
  }, [channels, membership, byId]);
  const needing = waiting(rows).length;
  const waitingText = `${needing} agent${needing === 1 ? "" : "s"} waiting`;
  const rate = rateText(msgPerSecond());
  const line = footerLine(post, self !== null && roster.some((p) => p.card.id === self));
  const conversations = useMemo(() => dmPairs(dms), [dms]);
  const [allDms, setAllDms] = useState(false);
  const openKey = route.view === "dm" && route.with !== undefined ? pairKey(route.peer, route.with) : null;
  const listed = useMemo(
    () => (allDms ? conversations : conversations.filter((c, i) => i < DM_ROWS || c.key === openKey)),
    [conversations, allDms, openKey],
  );
  return (
    <>
      <SidebarHeader>
        <span className="ui-space px-2 py-1.5">{space}</span>
      </SidebarHeader>
      <StaleMarker store={store} />
      {loading.roster || loading.channels ? <SkeletonPlaces /> : (
        <SidebarContent role="navigation" aria-label="Places">
          <SidebarGroup>
            <SidebarMenu>
              <Row to={{ view: "needs" }} here={route.view === "needs"} tip={needing > 0 ? waitingText : undefined} badge={needing > 0 ? needing : undefined} link={firstPlace}>
                <RailIcon name="inbox" />
                <span className="flex-1 truncate">Needs you</span>
                {needing > 0 && <span className="ui-sr">{` ${waitingText}`}</span>}
              </Row>
              <Row to={{ view: "activity" }} here={route.view === "activity"} badge={rate}>
                <RailIcon name="activity" />
                <span className="flex-1 truncate">Activity</span>
                <span className="ui-sr">{` ${rate}`}</span>
              </Row>
            </SidebarMenu>
          </SidebarGroup>
          <SidebarGroup>
            <SidebarGroupLabel>Channels</SidebarGroupLabel>
            {channels.length === 0 && (
              <Empty className="p-4">
                <EmptyHeader>
                  <EmptyDescription>No channels yet. One appears with its first message.</EmptyDescription>
                </EmptyHeader>
              </Empty>
            )}
            <SidebarMenu>
              {channels.map((c) => {
                const count = unread[c.channel] ?? 0;
                const event = isEventChannel(c.channel) ? `Events from run ${c.channel.slice("run.".length)}` : undefined;
                const working = busy.get(c.channel) ?? [];
                return (
                  <Row
                    key={c.channel}
                    to={{ view: "channel", channel: c.channel }}
                    here={route.view === "channel" && route.channel === c.channel}
                    tip={event}
                    badge={count > 0 ? count : undefined}
                  >
                    {event ? <Icon icon={Plug01Icon} /> : <RailIcon name="hash" />}
                    <span className="flex-1 truncate">{c.channel}</span>
                    {working.length > 0 && (
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <span className="ox-sbw">
                            <Icon icon={Loading03Icon} className="ox-spin" />
                            <span aria-hidden="true">{working.length}</span>
                            <span className="ui-sr">{workingTitle(working)}</span>
                          </span>
                        </TooltipTrigger>
                        <TooltipContent>{workingTitle(working)}</TooltipContent>
                      </Tooltip>
                    )}
                    {count > 0 && <span className="ui-sr">{` ${count}`}</span>}
                    {event && <span className="ui-sr">{` ${event}`}</span>}
                  </Row>
                );
              })}
            </SidebarMenu>
          </SidebarGroup>
          <SidebarGroup>
            <SidebarGroupLabel>Direct messages</SidebarGroupLabel>
            <SidebarMenu>
              {listed.map(({ key, parts, opener: a, verified }) => {
                const b = parts[0] === a ? parts[1] : parts[0];
                return (
                  <Row key={key} to={{ view: "dm", peer: a, with: b }} here={key === openKey}>
                    <span className="ui-stack" aria-hidden="true">
                      {[a, b].map((id) => (
                        <Avatar key={id} vendor={byId.get(id)?.harness} status={byId.get(id)?.status ?? "offline"} size={18} dot={byId.has(id)} badge={byId.has(id) ? badgeOf(id) : undefined} />
                      ))}
                    </span>
                    <span className="flex-1 truncate">{`${displayNameOf(a, idx, self)}, ${displayNameOf(b, idx, self)}`}</span>
                    {!verified && <Unverified />}
                  </Row>
                );
              })}
              {conversations.length > DM_ROWS && (
                <SidebarMenuItem>
                  <SidebarMenuButton type="button" aria-expanded={allDms} onClick={() => setAllDms((v) => !v)}>
                    <span>{allDms ? "Show fewer" : `Show all ${conversations.length}`}</span>
                  </SidebarMenuButton>
                </SidebarMenuItem>
              )}
            </SidebarMenu>
          </SidebarGroup>
        </SidebarContent>
      )}
      <SidebarFooter>
        <Item size="xs">
          <ItemMedia>
            <InitialsAvatar size="sm">
              <AvatarFallback>OP</AvatarFallback>
            </InitialsAvatar>
          </ItemMedia>
          <ItemContent>
            <ItemTitle>operator</ItemTitle>
            {line && (
              <ItemDescription>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <span tabIndex={0} aria-describedby="operator-line-why">{line.text}</span>
                  </TooltipTrigger>
                  <TooltipContent>{line.title}</TooltipContent>
                </Tooltip>
                <span id="operator-line-why" className="ui-sr">{line.title}</span>
              </ItemDescription>
            )}
          </ItemContent>
          <ItemActions>
            <ConnectionPill connection={connection} />
          </ItemActions>
        </Item>
      </SidebarFooter>
    </>
  );
}
