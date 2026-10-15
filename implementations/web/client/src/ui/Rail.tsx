import { RailIcon, type RailIconName } from "../icons/rail.js";
import { formatRoute, type Route } from "../lib/route.js";

interface View {
  label: string;
  icon: RailIconName;
  view: Route["view"];
}

/** The rail's views, top to bottom, with the names the mock gives them. There is no Workflow runs
 *  item and no Needs you item: that view is reached from the sidebar. */
const VIEWS: View[] = [
  { label: "Activity", icon: "activity", view: "activity" },
  { label: "Channels", icon: "hash", view: "channel" },
  { label: "Direct messages", icon: "dm", view: "dm" },
  { label: "Agents", icon: "agents", view: "agents" },
  { label: "Topology", icon: "graph", view: "topology" },
];

/** Where an item leads, or null when it leads nowhere yet. On its own view an item keeps the current
 *  route, so a host-grouped Agents view or a two-party conversation is not reset by clicking it. A
 *  channel or a conversation to land on has to exist, and the shell says which. */
function leadsTo(view: Route["view"], route: Route, channel: string | null, peer: string | null): Route | null {
  if (route.view === view) return route;
  switch (view) {
    case "channel":
      return channel === null ? null : { view, channel };
    case "dm":
      return peer === null ? null : { view, peer };
    case "agents":
      return { view, group: "status" };
    case "activity":
    case "topology":
    case "needs":
      return { view };
  }
}

/** The view rail down the left edge. `channel` and `peer` are where Channels and Direct messages lead
 *  when the route is not already on them. Settings opens when `onSettings` is given and is disabled
 *  until then. */
export function Rail({ route, channel, peer, onSettings }: { route: Route; channel: string | null; peer: string | null; onSettings?: () => void }) {
  return (
    <nav className="ui-rail" aria-label="Views">
      {VIEWS.map(({ label, icon, view }) => {
        const to = leadsTo(view, route, channel, peer);
        const here = route.view === view;
        return (
          <a
            key={view}
            className="ui-rail-btn"
            href={to ? formatRoute(to) : undefined}
            aria-disabled={to ? undefined : true}
            aria-current={here ? "page" : undefined}
            aria-label={label}
            title={label}
          >
            <RailIcon name={icon} size={22} />
          </a>
        );
      })}
      <div className="ui-grow" />
      <button type="button" className="ui-rail-btn" aria-label="Settings" title="Settings" disabled={!onSettings} onClick={onSettings}>
        <RailIcon name="gear" size={22} />
      </button>
    </nav>
  );
}
