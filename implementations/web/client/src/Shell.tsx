import { useMemo, type ReactNode } from "react";
import { dmPeers } from "./lib/dms.js";
import type { Route } from "./lib/route.js";
import { documentTitle, orderNotice } from "./lib/shellText.js";
import type { Controller } from "./state/controller.js";
import { useStore } from "./state/hooks.js";
import type { Store } from "./state/store.js";
import type { DashboardState } from "./state/types.js";
import { AppShell } from "./ui/AppShell.tsx";
import { Sidebar } from "./ui/Sidebar.tsx";
import { ActivityView } from "./ui/views/ActivityView.tsx";
import { ChannelView } from "./ui/views/ChannelView.tsx";
import { DmView } from "./ui/views/DmView.tsx";
import { AgentsView } from "./ui/views/AgentsView.tsx";
import { AgentPicker } from "./ui/panel/picker.js";
import { panelShown, RightPanel, usePanel, type Panel } from "./ui/panel/RightPanel.tsx";
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
 *  and an Agents view row pick the agent, and the Agents view marks the row of the agent picked. */
function centreView(
  store: Store<DashboardState>,
  route: Route,
  clock: () => number,
  panel: Panel,
  panelOpen: boolean,
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
 *  view rows and the Members tab rows are handed it, and message rows reach it through `AgentPicker`. */
export function Shell({ store, controller, route, paneOpen, msgPerSecond, clock = Date.now }: {
  store: Store<DashboardState>;
  controller: Controller | null;
  route: Route;
  paneOpen: boolean;
  msgPerSecond: () => number;
  clock?: () => number;
}) {
  const space = useStore(store, (s) => s.space);
  const channels = useStore(store, (s) => s.channels);
  const roster = useStore(store, (s) => s.roster);
  const dms = useStore(store, (s) => s.dms);
  const peer = useMemo(() => dmPeers(dms, roster)[0]?.id ?? null, [dms, roster]);
  const panel = usePanel(route);
  const shown = panelShown(panel, paneOpen);
  const view = centreView(store, route, clock, panel, shown);
  const panelBody = <RightPanel store={store} controller={controller} channel={route.view === "channel" ? route.channel : null} panel={panel} clock={clock} />;
  return (
    <AgentPicker.Provider value={panel.selectAgent}>
      <AppShell route={route} controller={controller} paneOpen={shown} panel={panelBody} channel={channels[0]?.channel ?? null} peer={peer} sidebar={<Sidebar store={store} route={route} msgPerSecond={msgPerSecond} />}>
        <title>{documentTitle(space)}</title>
        <StatusLines store={store} />
        <section className="ui-view" data-view={route.view}>{view}</section>
      </AppShell>
    </AgentPicker.Provider>
  );
}
