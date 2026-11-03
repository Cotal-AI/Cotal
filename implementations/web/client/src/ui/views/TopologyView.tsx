import { useEffect, useMemo, useReducer, useState } from "react";
import { pillState } from "../../lib/membership.js";
import { topologyModel } from "../../lib/topology.js";
import { useStore } from "../../state/hooks.js";
import type { Store } from "../../state/store.js";
import type { DashboardState } from "../../state/types.js";
import { TopologyGraph } from "../graph/TopologyGraph.tsx";
import { MembershipPill } from "../MembershipPill.tsx";

/** What each kind of line in the graph means, in the same dress the graph gives it, and the arc a
 *  working agent's node carries. */
const LEGEND: { cls: string; label: string }[] = [
  { cls: "ui-lg-member", label: "Member" },
  { cls: "ui-lg-durable", label: "Durable member" },
  { cls: "ui-lg-offline", label: "Offline agent" },
  { cls: "ui-lg-traffic", label: "Posted here" },
  { cls: "ui-lg-hot", label: "Active now" },
  { cls: "ui-lg-working", label: "Working" },
];

/** The graph's model and the clock it is drawn against, for the topology view and the panel's Topology
 *  tab alike. A link is hot for two seconds after a message flows, and `clock` says what time it is.
 *  The caller draws again every half second while a link is hot, so it goes cold on its own, and every
 *  five seconds otherwise, so the membership pill can turn stale on its own. `initialHideOffline` is
 *  where the Hide offline toggle starts. */
export function useTopology(store: Store<DashboardState>, clock: () => number, initialHideOffline: boolean) {
  const roster = useStore(store, (s) => s.roster);
  const channels = useStore(store, (s) => s.channels);
  const membership = useStore(store, (s) => s.membership);
  const activity = useStore(store, (s) => s.activity);
  const [hideOffline, setHideOffline] = useState(initialHideOffline);

  // A link is hot from the time a message ARRIVED here, stamped by the controller from this page's own
  // clock. The message's `ts` is the sender's clock and is not used. Entries read from history carry
  // no stamp, so they draw nodes and links and are never hot. The store caps the window.
  const recent = useMemo(
    () =>
      activity.map((a) => ({
        mode: a.mode,
        ...("channel" in a && a.channel !== undefined ? { channel: a.channel } : {}),
        ...("senderId" in a && a.senderId !== undefined ? { senderId: a.senderId } : {}),
        msg: a.msg,
        ts: a.arrivedAt ?? Number.NEGATIVE_INFINITY,
      })),
    [activity],
  );
  const now = clock();
  const model = topologyModel({ roster, channels, membership, recent, hideOffline, hideEmpty: true, now });

  const hot = model.links.some((l) => l.hot);
  const [, redraw] = useReducer((n: number) => n + 1, 0);
  useEffect(() => {
    const id = setInterval(redraw, hot ? 500 : 5000);
    return () => clearInterval(id);
  }, [hot]);

  return { model, membership, now, hideOffline, setHideOffline };
}

/** The topology view: the mesh as a graph from the rail. The header holds the membership pill
 *  and the "Hide offline" button (on by default, as the old graph had it), the graph fills the page
 *  and the legend sits under it.
 *
 *  The graph is a function of the store and of `clock`, the one place time comes in (`useTopology`).
 *  A suite passes a fixed clock.
 *
 *  `initialHideOffline` is where the toggle starts (hidden, unless a caller says otherwise). */
export function TopologyView({ store, clock = Date.now, initialHideOffline = true }: { store: Store<DashboardState>; clock?: () => number; initialHideOffline?: boolean }) {
  const { model, membership, now, hideOffline, setHideOffline } = useTopology(store, clock, initialHideOffline);
  return (
    <>
      <header className="ui-bar">
        <h1>Topology</h1>
        <span className="ui-sp" />
        <MembershipPill state={pillState(membership, now)} reason={membership.unreadable} />
        <button type="button" className="ui-btn ui-btn-sm" aria-pressed={hideOffline} onClick={() => setHideOffline(!hideOffline)}>
          Hide offline
        </button>
      </header>
      <div className="ui-scroll">
        <div className="ui-col ui-col-wide">
          <div className="ui-topo">
            <TopologyGraph model={model} width={960} height={600} />
          </div>
          <div className="ui-legend">
            {LEGEND.map((l) => (
              <span key={l.cls}><i className={l.cls} />{l.label}</span>
            ))}
            <span><b className="ui-wide-key">all channels</b>Reads every channel</span>
          </div>
        </div>
      </div>
    </>
  );
}
