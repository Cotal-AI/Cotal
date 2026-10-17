import { useMemo, useState, type ReactNode } from "react";
import { dmPeers } from "./lib/dms.js";
import { rosterRows, waiting } from "./lib/roster.js";
import { formatRoute, type Route } from "./lib/route.js";
import { documentTitle, orderNotice } from "./lib/shellText.js";
import type { Controller } from "./state/controller.js";
import { useStore } from "./state/hooks.js";
import type { Store } from "./state/store.js";
import type { DashboardState } from "./state/types.js";
import type { Theme } from "./lib/theme.js";
import { AppShell } from "./ui/AppShell.tsx";
import type { Places } from "./ui/Rail.tsx";
import { Compose } from "./ui/Composer.tsx";
import { Sidebar } from "./ui/Sidebar.tsx";
import { ActivityView } from "./ui/views/ActivityView.tsx";
import { ChannelView } from "./ui/views/ChannelView.tsx";
import { DmView } from "./ui/views/DmView.tsx";
import { AgentsView } from "./ui/views/AgentsView.tsx";
import { SessionView } from "./ui/views/SessionView.tsx";
import { AgentPicker } from "./ui/panel/picker.js";
import { BadgeOf, badgeLookup } from "./ui/identity.js";
import { SheetMenu } from "./ui/sheet.js";
import { panelShown, RightPanel, usePanel, type Panel } from "./ui/panel/RightPanel.tsx";
import { SkeletonView } from "./ui/Skeleton.tsx";
import { TopologyView } from "./ui/views/TopologyView.tsx";

/** The line the dashboard owes its reader about what the event stream is missing. Plain on purpose;
 *  the feed views restyle it. */
function StatusLines({ store }: { store: Store<DashboardState> }) {
  const notes = useStore(store, (s) => s.orderNotes);
  const notice = orderNotice(notes);
  return (
    <div>
      {notice && <p id="order-notice" role={notice.fault ? "alert" : "status"}>{notice.text}</p>}
    </div>
  );
}

/** The view the centre draws for a route. The Agents route draws the Agents view in the grouping its
 *  address names, and the Needs route draws it by status with the Waiting group in focus. `clock` is
 *  the time the topology view measures hot links against and the Agents view measures heartbeats
 *  against. `panel` is how a view opens the right panel: the member stack opens Members, View agent
 *  and an Agents view row pick the agent. It is the panel as the views see it: its `agent` is the one
 *  the panel is showing on its Agent tab, and null while the panel is closed or on another tab, so
 *  the Agents view marks a row only while that agent is on screen. An agent's route draws its session,
 *  keyed by the agent so each agent's view starts afresh, with `session`'s controller, layout and
 *  the place its back link returns to; on a phone its Agent details opens the panel on that agent. */
function centreView(
  store: Store<DashboardState>,
  route: Route,
  clock: () => number,
  panel: Panel,
  panelOpen: boolean,
  session: { controller: Controller | null; phone: boolean; back: { label: string; route: Route }; panelOpen: boolean; toggle: () => void; details: (id: string) => void },
): ReactNode {
  switch (route.view) {
    case "channel":
      return <ChannelView store={store} channel={route.channel} onMembers={panel.showMembers} onViewAgent={panel.selectAgent} panelOpen={panelOpen} onTogglePanel={panel.toggle} />;
    case "activity":
      return <ActivityView store={store} />;
    case "dm":
      return <DmView store={store} peer={route.peer} with={route.with} />;
    case "topology":
      return <TopologyView store={store} clock={clock} />;
    case "agents":
      return <AgentsView store={store} group={route.group === "host" ? "host" : undefined} selected={panel.agent} onPick={panel.selectAgent} clock={clock} />;
    case "needs":
      return <AgentsView store={store} group="status" focusWaiting selected={panel.agent} onPick={panel.selectAgent} clock={clock} />;
    case "agent": {
      const id = route.id;
      return (
        <SessionView
          key={id}
          store={store}
          controller={session.controller}
          id={id}
          at={route.at}
          back={session.back}
          phone={session.phone}
          onDetails={() => session.details(id)}
          panelOpen={session.panelOpen}
          onTogglePanel={session.toggle}
        />
      );
    }
  }
}

/** What the dashboard draws from the store and the route, and nothing else: no feed, no fetch, no
 *  DOM access, so it renders the same in a browser and in `renderToString`. `controller` is null
 *  until the dashboard has started. `msgPerSecond` is where the sidebar reads the message rate.
 *  `clock` is the topology view's and the panel's clock, `Date.now` unless a caller passes its own.
 *  `paneOpen` says whether the route has a panel beside it (a channel route does).
 *
 *  The sidebar is the places and the stale marker. The centre draws the view for the route
 *  (`centreView`) inside a section that says which view it is. The panel draws while the reader has
 *  it open and there is something to show: the route's channel or a picked agent (`panelShown`).
 *
 *  `selectAgent(id)` (from `usePanel`) is the one picker: the Needs card's View agent, the Agents
 *  view rows and the Members tab rows are handed it, and message rows reach it through `AgentPicker`.
 *
 *  While the first roster and channel reads are outstanding (`loading`) the centre draws skeleton
 *  rows in place of the view, as the sidebar does in place of the places.
 *
 *  `phone` draws mock section F (see `AppShell`): the places sheet opens from the channel header's
 *  menu button (through `SheetMenu`) and closes on Escape, on the scrim or on any new route.
 *  `theme` and `onTheme` are the Settings menu's; without `onTheme` Settings is disabled.
 *
 *  The composers the views draw reach the controller's `send` and `draft` through `Compose`, and
 *  every avatar of a roster row finds its initial badge through `BadgeOf`. */
export function Shell({ store, controller, route, paneOpen, msgPerSecond, clock = Date.now, phone = false, theme, onTheme }: {
  store: Store<DashboardState>;
  controller: Controller | null;
  route: Route;
  paneOpen: boolean;
  msgPerSecond: () => number;
  clock?: () => number;
  phone?: boolean;
  theme?: Theme;
  onTheme?: (t: Theme) => void;
}) {
  const space = useStore(store, (s) => s.space);
  const channels = useStore(store, (s) => s.channels);
  const roster = useStore(store, (s) => s.roster);
  const dms = useStore(store, (s) => s.dms);
  const loading = useStore(store, (s) => s.loading);
  const self = useStore(store, (s) => s.operatorId);
  const places = usePlaces(route, channels, dms, roster, self);
  const everyone = useMemo(() => rosterRows(roster, { includeOffline: true }), [roster]);
  const needing = useMemo(() => waiting(everyone).length, [everyone]);
  const badgeOf = useMemo(() => badgeLookup(everyone), [everyone]);
  const panel = usePanel(route, phone);
  const shown = panelShown(panel, paneOpen);
  const seen: Panel = { ...panel, agent: shown && panel.tab === "agent" ? panel.agent : null };
  const back = useBack(route);
  const session = { controller, phone, back, panelOpen: shown, toggle: panel.toggle, details: panel.selectAgent };
  const view = loading.roster || loading.channels ? <SkeletonView /> : centreView(store, route, clock, seen, shown, session);
  const panelBody = <RightPanel store={store} controller={controller} channel={route.view === "channel" ? route.channel : null} route={route} panel={panel} clock={clock} />;
  // The sheet remembers the route it was opened on, so any new route closes it, during render and
  // with no effect to run, and coming back to that route does not reopen it.
  const [sheetAt, setSheetAt] = useState<string | null>(null);
  const here = formatRoute(route);
  if (sheetAt !== null && sheetAt !== here) setSheetAt(null);
  const sheetOpen = phone && sheetAt === here;
  const menu = useMemo(() => (phone ? { open: sheetOpen, show: () => setSheetAt(here) } : null), [phone, sheetOpen, here]);
  return (
    <Compose.Provider value={controller}>
    <AgentPicker.Provider value={panel.selectAgent}>
    <BadgeOf.Provider value={badgeOf}>
      <SheetMenu.Provider value={menu}>
        <AppShell
          route={route}
          controller={controller}
          paneOpen={shown}
          panel={panelBody}
          places={places}
          theme={theme}
          onTheme={onTheme}
          phone={phone}
          waiting={needing}
          sheetOpen={sheetOpen}
          onSheetClose={() => setSheetAt(null)}
          onPanelClose={panel.close}
          sidebar={<Sidebar store={store} route={route} msgPerSecond={msgPerSecond} />}
        >
          <title>{documentTitle(space)}</title>
          <StatusLines store={store} />
          <section className="ui-view" data-view={route.view}>{view}</section>
        </AppShell>
      </SheetMenu.Provider>
    </BadgeOf.Provider>
    </AgentPicker.Provider>
    </Compose.Provider>
  );
}

/** Where the rail's Channels and Direct messages items lead off their own routes: the channel and
 *  the conversation the reader last visited, while they still exist, and otherwise the first channel
 *  and the newest conversation, or null when there is none. The last visits are kept as the route
 *  changes, during render, so the rail never draws a frame that points at the place before.
 *
 *  A conversation is named by both parties, so the link opens the conversation it stands for. A
 *  visit from a Message button names only the agent: the operator is the other party, and until
 *  `self`, the operator's id, is known that visit is no place to land. */
function usePlaces(route: Route, channels: DashboardState["channels"], dms: DashboardState["dms"], roster: DashboardState["roster"], self: string | null): Places {
  const [last, setLast] = useState<{ channel: string | null; dm: { peer: string; with?: string } | null }>({ channel: null, dm: null });
  let seen = last;
  if (route.view === "channel" && last.channel !== route.channel) seen = { ...last, channel: route.channel };
  if (route.view === "dm" && (last.dm?.peer !== route.peer || last.dm?.with !== route.with)) seen = { ...seen, dm: { peer: route.peer, with: route.with } };
  if (seen !== last) setLast(seen);
  const peers = useMemo(() => dmPeers(dms, roster), [dms, roster]);
  const channel = seen.channel !== null && channels.some((c) => c.channel === seen.channel) ? seen.channel : (channels[0]?.channel ?? null);
  const other = seen.dm === null ? null : (seen.dm.with ?? self);
  const newest = peers[0]?.conversations[0];
  const dm = seen.dm !== null && other !== null && peers.some((p) => p.id === seen.dm?.peer) ? { peer: seen.dm.peer, with: other } : peers[0] && newest ? { peer: peers[0].id, with: newest.with } : null;
  return { channel, dm };
}

/** What an agent's session calls the place it goes back to: the channel by name, any other view by
 *  the name the rail or the sidebar gives it. */
function placeLabel(r: Route): string {
  switch (r.view) {
    case "channel":
      return `#${r.channel}`;
    case "activity":
      return "Activity";
    case "dm":
      return "Direct messages";
    case "topology":
      return "Topology";
    case "needs":
      return "Needs you";
    case "agents":
    case "agent":
      return "Agents";
  }
}

/** Where an agent's session goes back to: the last route the reader had that was not a session,
 *  with its label, or the Agents view when the page opened on a session. Kept as the route changes,
 *  during render, so the crumb never draws a frame that points at the place before. */
function useBack(route: Route): { label: string; route: Route } {
  const [from, setFrom] = useState<Route | null>(null);
  if (route.view !== "agent" && (from === null || formatRoute(from) !== formatRoute(route))) setFrom(route);
  const last = route.view !== "agent" ? route : from;
  return last !== null ? { label: placeLabel(last), route: last } : { label: "Agents", route: { view: "agents", group: "status" } };
}
