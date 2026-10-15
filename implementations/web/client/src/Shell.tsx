import { useMemo, type ReactNode } from "react";
import { dmPeers } from "./lib/dms.js";
import type { Route } from "./lib/route.js";
import { rosterRows } from "./lib/roster.js";
import { documentTitle, orderNotice } from "./lib/shellText.js";
import type { Controller } from "./state/controller.js";
import { useStore } from "./state/hooks.js";
import type { Store } from "./state/store.js";
import type { DashboardState } from "./state/types.js";
import { AppShell } from "./ui/AppShell.tsx";
import { Avatar } from "./ui/Avatar.tsx";
import { Sidebar } from "./ui/Sidebar.tsx";
import { StatusWord } from "./ui/Status.tsx";
import { ActivityView } from "./ui/views/ActivityView.tsx";
import { ChannelView } from "./ui/views/ChannelView.tsx";
import { DmView } from "./ui/views/DmView.tsx";
import { AgentsView } from "./ui/views/AgentsView.tsx";
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

/** The view the centre draws for a route, or null where that view is not built yet and the phase 1
 *  roster list still stands in. The Agents route draws the Agents view in the grouping its address
 *  names, and the Needs route draws it by status with the Waiting group in focus. `clock` is the time
 *  the topology view measures hot links against and the Agents view measures heartbeats against.
 *  `selectedAgent` and `onPickAgent` are the Agents view's seam to the details panel. */
function centreView(
  store: Store<DashboardState>,
  route: Route,
  clock: () => number,
  selectedAgent: string | null,
  onPickAgent: ((id: string) => void) | undefined,
): ReactNode {
  switch (route.view) {
    case "channel":
      return <ChannelView store={store} channel={route.channel} />;
    case "activity":
      return <ActivityView store={store} />;
    case "dm":
      return <DmView store={store} peer={route.peer} with={route.with} />;
    case "topology":
      return <TopologyView store={store} clock={clock} />;
    case "agents":
      return <AgentsView store={store} group={route.group === "host" ? "host" : undefined} selected={selectedAgent} onPick={onPickAgent} clock={clock} />;
    case "needs":
      return <AgentsView store={store} group="status" focusWaiting selected={selectedAgent} onPick={onPickAgent} clock={clock} />;
    default:
      return null;
  }
}

/** What the dashboard draws from the store and the route, and nothing else: no feed, no fetch, no
 *  DOM access, so it renders the same in a browser and in `renderToString`. `controller` is null
 *  until the dashboard has started. `msgPerSecond` is where the sidebar reads the message rate.
 *  `clock` is the topology view's clock, `Date.now` unless a caller passes its own.
 *
 *  The sidebar is the places and the stale marker, and the panel is an empty frame. The centre draws
 *  the view for the route (`centreView`) inside a section that says which view it is; the routes
 *  whose views are not built yet keep the phase 1 roster list. */
export function Shell({ store, controller, route, paneOpen, msgPerSecond, clock = Date.now, selectedAgent = null, onPickAgent }: {
  store: Store<DashboardState>;
  controller: Controller | null;
  route: Route;
  paneOpen: boolean;
  msgPerSecond: () => number;
  clock?: () => number;
  /** The agent the details panel shows, marked in the Agents view. */
  selectedAgent?: string | null;
  /** Called with the id of the agent whose row the reader opens in the Agents view. */
  onPickAgent?: (id: string) => void;
}) {
  const space = useStore(store, (s) => s.space);
  const channels = useStore(store, (s) => s.channels);
  const roster = useStore(store, (s) => s.roster);
  const dms = useStore(store, (s) => s.dms);
  const rows = useMemo(() => rosterRows(roster, { includeOffline: true }), [roster]);
  const peer = useMemo(() => dmPeers(dms, roster)[0]?.id ?? null, [dms, roster]);
  const view = centreView(store, route, clock, selectedAgent, onPickAgent);
  return (
    <AppShell route={route} controller={controller} paneOpen={paneOpen} channel={channels[0]?.channel ?? null} peer={peer} sidebar={<Sidebar store={store} route={route} msgPerSecond={msgPerSecond} />}>
      <title>{documentTitle(space)}</title>
      <StatusLines store={store} />
      {view ? (
        <section className="ui-view" data-view={route.view}>{view}</section>
      ) : (
        <section className="ui-view ui-interim" data-view={route.view}>
          <div aria-label="Roster">
            {rows.filter((r) => r.status !== "offline").map((r) => (
              <div key={r.id} className="v3-mrow">
                <Avatar vendor={r.harness} status={r.status} size={28} />
                <span className="v3-mname">{r.name}{r.role && <span>{r.role}</span>}</span>
                <StatusWord row={r} />
              </div>
            ))}
          </div>
        </section>
      )}
    </AppShell>
  );
}
