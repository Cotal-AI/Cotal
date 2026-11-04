import { useId } from "react";
import { mark } from "../art/index.ts";
import { DropdownMenu, DropdownMenuContent, DropdownMenuGroup, DropdownMenuLabel, DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuTrigger } from "#client/ui/shadcn/dropdown-menu.tsx";
import { Tooltip, TooltipContent, TooltipTrigger } from "#client/ui/shadcn/tooltip.tsx";
import { RailIcon, type RailIconName } from "../icons/rail.js";
import { formatRoute, type Route } from "../lib/route.js";
import type { Theme } from "../lib/theme.js";

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

/** Where the Channels and Direct messages items land off their own views: the place of that kind
 *  the reader last visited, or the first there is, or null when there is none yet. A conversation
 *  names both parties, so the item opens the conversation it stands for. */
export interface Places {
  channel: string | null;
  dm: { peer: string; with: string } | null;
}

/** Why an item that leads nowhere yet is disabled: the empty state the reader would find there. */
export const EMPTY_TITLE: Partial<Record<Route["view"], string>> = {
  channel: "No channels yet. One appears with its first message.",
  dm: "No direct messages yet.",
};

/** Where an item leads, or null when it leads nowhere yet. On its own view an item keeps the current
 *  route, so a host-grouped Agents view or a two-party conversation is not reset by clicking it. A
 *  channel or a conversation to land on has to exist, and the shell says which. */
export function leadsTo(view: Route["view"], route: Route, places: Places): Route | null {
  if (route.view === view) return route;
  switch (view) {
    case "channel":
      return places.channel === null ? null : { view, channel: places.channel };
    case "dm":
      return places.dm === null ? null : { view, ...places.dm };
    case "agents":
      return { view, group: "status" };
    case "activity":
    case "topology":
    case "needs":
      return { view };
    case "agent":
      // No item stands for one agent's page; the Agents item is current there.
      return null;
  }
}

/** The theme choices the Settings menu offers, in the order it lists them. */
const CHOICES: { value: Theme; label: string }[] = [
  { value: "system", label: "System" },
  { value: "light", label: "Light" },
  { value: "dark", label: "Dark" },
];

/** The Settings item at the foot of the rail and the menu it opens: the theme, System, Light or Dark,
 *  as radio items with the chosen one checked. Picking one applies it and closes the menu. The menu
 *  owns its keys, Escape and outside click, and gives focus back to Settings when it closes. With no
 *  `onTheme` the item is disabled. */
function Settings({ theme, onTheme }: { theme?: Theme; onTheme?: (t: Theme) => void }) {
  const label = useId();
  return (
    <DropdownMenu>
      <Tooltip>
        {/* A disabled button fires no pointer events, so the Tooltip hangs on a span around it, which
            takes the focus while the button cannot. */}
        <TooltipTrigger asChild>
          <span className="inline-flex" tabIndex={onTheme ? undefined : 0}>
            <DropdownMenuTrigger asChild>
              <button type="button" className="ui-rail-btn" aria-label="Settings" disabled={!onTheme}>
                <RailIcon name="gear" size={22} />
              </button>
            </DropdownMenuTrigger>
          </span>
        </TooltipTrigger>
        <TooltipContent side="right">Settings</TooltipContent>
      </Tooltip>
      {onTheme && (
        <DropdownMenuContent side="right" align="end">
          <DropdownMenuGroup aria-labelledby={label}>
            <DropdownMenuLabel id={label}>Theme</DropdownMenuLabel>
            <DropdownMenuRadioGroup
              value={theme}
              onValueChange={(next) => {
                const picked = CHOICES.find((t) => t.value === next);
                if (picked) onTheme(picked.value);
              }}
            >
              {CHOICES.map((t) => (
                <DropdownMenuRadioItem key={t.value} value={t.value}>{t.label}</DropdownMenuRadioItem>
              ))}
            </DropdownMenuRadioGroup>
          </DropdownMenuGroup>
        </DropdownMenuContent>
      )}
    </DropdownMenu>
  );
}

/** The view rail down the left edge, under the Cotal mark. `places` says where Channels and Direct
 *  messages lead when the route is not already on them. Agents is current on an agent's page too.
 *  Each item's Tooltip names it. An item that leads nowhere yet is a button marked disabled, which
 *  keyboard and screen readers still reach, with the empty state it would show as its Tooltip and its
 *  accessible description. Settings opens the theme menu when `onTheme` is given and is disabled
 *  until then. The mark is drawn in `currentColor`, so the
 *  stylesheet's `--mark` token gives it the brand navy by day and cream at night. */
export function Rail({ route, places, theme, onTheme }: { route: Route; places: Places; theme?: Theme; onTheme?: (t: Theme) => void }) {
  return (
    <nav className="ui-rail" aria-label="Views">
      <span className="ui-rail-mark" dangerouslySetInnerHTML={{ __html: mark("currentColor") }} />
      {VIEWS.map(({ label, icon, view }) => {
        const to = leadsTo(view, route, places);
        const here = route.view === view || (view === "agents" && route.view === "agent");
        const Item = to ? "a" : "button";
        const why = to ? undefined : EMPTY_TITLE[view];
        return (
          <Tooltip key={view}>
            <TooltipTrigger asChild>
              <Item
                className="ui-rail-btn"
                href={to ? formatRoute(to) : undefined}
                type={to ? undefined : "button"}
                aria-disabled={to ? undefined : true}
                aria-current={here ? "page" : undefined}
                aria-label={label}
                aria-describedby={why ? `rail-why-${view}` : undefined}
              >
                <RailIcon name={icon} size={22} />
                {why && <span id={`rail-why-${view}`} className="ui-sr">{why}</span>}
              </Item>
            </TooltipTrigger>
            <TooltipContent side="right">{why ?? label}</TooltipContent>
          </Tooltip>
        );
      })}
      <div className="ui-grow" />
      <Settings theme={theme} onTheme={onTheme} />
    </nav>
  );
}
