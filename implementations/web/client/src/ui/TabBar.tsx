import { RailIcon, type RailIconName } from "../icons/rail.js";
import { formatRoute, type Route } from "../lib/route.js";
import { EMPTY_TITLE, leadsTo, type Places } from "./Rail.tsx";

/** The phone's sections, left to right, with the names mock section F gives them. */
const TABS: { label: string; icon: RailIconName; view: Route["view"] }[] = [
  { label: "Channels", icon: "hash", view: "channel" },
  { label: "DMs", icon: "dm", view: "dm" },
  { label: "Agents", icon: "agents", view: "agents" },
  { label: "Activity", icon: "activity", view: "activity" },
];

/** The bottom tab bar that stands in for the rail below 768px (mock section F). Each tab leads where
 *  the rail's item for that view leads, and a tab with nowhere to go yet is a disabled button titled
 *  with the empty state, as on the rail. Agents carries the gold count of agents waiting, and is the
 *  current tab on the Needs route too, since that route draws the Agents view, and on an agent's
 *  session. */
export function TabBar({ route, places, waiting }: { route: Route; places: Places; waiting: number }) {
  return (
    <nav className="v3-tabbar" aria-label="Sections">
      {TABS.map(({ label, icon, view }) => {
        const to = leadsTo(view, route, places);
        const here = route.view === view || (view === "agents" && route.view === "needs") || (view === "agents" && route.view === "agent");
        const Item = to ? "a" : "button";
        return (
          <Item
            key={view}
            href={to ? formatRoute(to) : undefined}
            type={to ? undefined : "button"}
            aria-disabled={to ? undefined : true}
            aria-current={here ? "page" : undefined}
            title={to ? undefined : EMPTY_TITLE[view]}
          >
            <RailIcon name={icon} size={22} />
            {label}
            {view === "agents" && waiting > 0 && (
              <span className="ui-badge-gold" title={`${waiting} agent${waiting === 1 ? "" : "s"} waiting`}>{waiting}</span>
            )}
          </Item>
        );
      })}
    </nav>
  );
}
