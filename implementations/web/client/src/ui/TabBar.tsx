import { Loading03Icon } from "@hugeicons/core-free-icons";
import { Icon } from "../icons/Icon.tsx";
import { Badge } from "#client/ui/shadcn/badge.tsx";
import { Tooltip, TooltipContent, TooltipTrigger } from "#client/ui/shadcn/tooltip.tsx";
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
 *  the rail's item for that view leads, and a tab with nowhere to go yet is a disabled button with the
 *  empty state as its Tooltip and its accessible description, as on the rail. Agents carries a Badge
 *  with the count of agents waiting, or with none waiting the turning spokes and the count of agents
 *  working, each with its count in words as its Tooltip and screen reader text, and is the current
 *  tab on the Needs route too, since that route draws the Agents view, and on an agent's page. */
export function TabBar({ route, places, waiting, working }: { route: Route; places: Places; waiting: number; working: number }) {
  return (
    <nav className="v3-tabbar" aria-label="Sections">
      {TABS.map(({ label, icon, view }) => {
        const to = leadsTo(view, route, places);
        const here = route.view === view || (view === "agents" && route.view === "needs") || (view === "agents" && route.view === "agent");
        const Item = to ? "a" : "button";
        const why = to ? undefined : EMPTY_TITLE[view];
        const item = (
          <Item
            key={view}
            href={to ? formatRoute(to) : undefined}
            type={to ? undefined : "button"}
            aria-disabled={to ? undefined : true}
            aria-current={here ? "page" : undefined}
            aria-label={why ? label : undefined}
            aria-describedby={why ? `tab-why-${view}` : undefined}
          >
            <RailIcon name={icon} size={22} />
            {label}
            {why && <span id={`tab-why-${view}`} className="ui-sr">{why}</span>}
            {view === "agents" && waiting > 0 && (
              <Tooltip>
                <TooltipTrigger asChild>
                  <Badge><span aria-hidden="true">{waiting}</span><span className="ui-sr">{`${waiting} agent${waiting === 1 ? "" : "s"} waiting`}</span></Badge>
                </TooltipTrigger>
                <TooltipContent>{`${waiting} agent${waiting === 1 ? "" : "s"} waiting`}</TooltipContent>
              </Tooltip>
            )}
            {view === "agents" && waiting === 0 && working > 0 && (
              <Tooltip>
                <TooltipTrigger asChild>
                  <span className="ox-sbw ox-tabw">
                    <Icon icon={Loading03Icon} size={16} className="ui-ic ox-spin" />
                    <span aria-hidden="true">{working}</span>
                    <span className="ui-sr">{`${working} agent${working === 1 ? "" : "s"} working`}</span>
                  </span>
                </TooltipTrigger>
                <TooltipContent>{`${working} agent${working === 1 ? "" : "s"} working`}</TooltipContent>
              </Tooltip>
            )}
          </Item>
        );
        if (!why) return item;
        return (
          <Tooltip key={view}>
            <TooltipTrigger asChild>{item}</TooltipTrigger>
            <TooltipContent side="top">{why}</TooltipContent>
          </Tooltip>
        );
      })}
    </nav>
  );
}
