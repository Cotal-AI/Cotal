import { useEffect, useMemo, useReducer, useState } from "react";
import { pillState } from "../../lib/membership.js";
import { topologyModel } from "../../lib/topology.js";
import { useStore } from "../../state/hooks.js";
import type { Store } from "../../state/store.js";
import type { DashboardState } from "../../state/types.js";
import { TopologyGraph } from "../graph/TopologyGraph.tsx";
import { MembershipPill } from "../MembershipPill.tsx";

/** What each kind of line in the graph means, in the same dress the graph gives it. */
const LEGEND: { cls: string; label: string }[] = [
  { cls: "ui-lg-member", label: "Member" },
  { cls: "ui-lg-durable", label: "Durable member" },
  { cls: "ui-lg-traffic", label: "Posted here" },
  { cls: "ui-lg-hot", label: "Active now" },
];

/** The topology view: the mesh as a graph from the rail. The header holds the membership pill
 *  and the "Hide offline" button (on by default, as the old graph had it), the graph fills the page
 *  and the legend sits under it.
 *
 *  The graph is a function of the store and of `clock`, the one place time comes in: a link is hot
 *  for two seconds after a message flows, and `clock` says what time it is. A suite passes a fixed
 *  clock. The view draws again every half second while a link is hot, so it goes cold on its own,
 *  and every five seconds otherwise, so the membership pill can turn stale on its own.
 *
 *  `initialHideOffline` is where the toggle starts (hidden, unless a caller says otherwise). */
export function TopologyView({ store, clock = Date.now, initialHideOffline = true }: { store: Store<DashboardState>; clock?: () => number; initialHideOffline?: boolean }) {
  const roster = useStore(store, (s) => s.roster);
  const channels = useStore(store, (s) => s.channels);
  const membership = useStore(store, (s) => s.membership);
  const activity = useStore(store, (s) => s.activity);
  const [hideOffline, setHideOffline] = useState(initialHideOffline);

  // A message's own `ts` is when it was sent, which is when it flows. The store caps the window.
  const recent = useMemo(
    () =>
      activity.map((a) => ({
        mode: a.mode,
        ...("channel" in a && a.channel !== undefined ? { channel: a.channel } : {}),
        ...("senderId" in a && a.senderId !== undefined ? { senderId: a.senderId } : {}),
        msg: a.msg,
        ts: a.msg.ts,
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

  return (
    <>
      <header className="ui-bar">
        <h1>Topology</h1>
        <span className="ui-sp" />
        <MembershipPill state={pillState(membership, now)} />
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
