import { pillState } from "../../lib/membership.js";
import type { Store } from "../../state/store.js";
import type { DashboardState } from "../../state/types.js";
import { TopologyGraph } from "../graph/TopologyGraph.tsx";
import { MembershipPill } from "../MembershipPill.tsx";
import { useTopology } from "../views/TopologyView.tsx";

/** The graph's drawing size in the panel: the panel's width, and the height the mock gives it. */
export const PANEL_GRAPH = { width: 360, height: 420 };

/** The Topology tab (mock section D, the panel's third frame): the membership pill, Hide offline (on,
 *  as in the topology view), and the same graph at the panel's size. */
export function TopologyTab({ store, clock }: { store: Store<DashboardState>; clock: () => number }) {
  const { model, membership, now, hideOffline, setHideOffline } = useTopology(store, clock, true);
  return (
    <>
      <div style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 10 }}>
        <MembershipPill state={pillState(membership, now)} reason={membership.unreadable} />
        <span className="ui-sp" />
        <button type="button" className="ui-btn" style={{ padding: "5px 9px", fontSize: 12.5 }} aria-pressed={hideOffline} onClick={() => setHideOffline(!hideOffline)}>
          Hide offline
        </button>
      </div>
      <div className="ui-topo">
        <TopologyGraph model={model} width={PANEL_GRAPH.width} height={PANEL_GRAPH.height} />
      </div>
    </>
  );
}
