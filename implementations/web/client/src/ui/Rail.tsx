import { useId } from "react";
import { mark } from "../art/index.ts";
import { DropdownMenu, DropdownMenuContent, DropdownMenuGroup, DropdownMenuLabel, DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuTrigger } from "#client/ui/shadcn/dropdown-menu.tsx";
import { SidebarContent, SidebarFooter, SidebarGroup, SidebarGroupContent, SidebarHeader, SidebarMenu, SidebarMenuButton, SidebarMenuItem } from "#client/ui/shadcn/sidebar.tsx";
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
          <span className="flex" tabIndex={onTheme ? undefined : 0}>
            <DropdownMenuTrigger asChild>
              <SidebarMenuButton disabled={!onTheme}>
                <RailIcon name="gear" />
                <span>Settings</span>
              </SidebarMenuButton>
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

/** The view rail: the Cotal mark in the header, the views as shadcn's sidebar menu, and Settings in
 *  the footer. The shell draws it as the icon column of its nested Sidebar, so it is the inside of a
 *  Sidebar, not one of its own. `places` says where Channels and Direct messages lead when the route
 *  is not already on them. Agents is current on an agent's page too, marked active and
 *  `aria-current`. Each item's label is clipped by the narrow column and named again by its Tooltip,
 *  which shows whether or not the sidebar is collapsed. An item that leads nowhere yet is a button
 *  marked disabled, which keyboard and screen readers still reach, with the empty state it would show
 *  as its Tooltip and its accessible description. A button marked so takes no pointer events, so that
 *  Tooltip hangs on a span around it. Settings opens the theme menu when `onTheme` is given and is
 *  disabled until then. The mark is drawn in `currentColor`, so the stylesheet's `--mark` token gives
 *  it the brand navy by day and cream at night. */
export function Rail({ route, places, theme, onTheme }: { route: Route; places: Places; theme?: Theme; onTheme?: (t: Theme) => void }) {
  return (
    <>
      <SidebarHeader>
        <span className="ui-rail-mark self-center" dangerouslySetInnerHTML={{ __html: mark("currentColor") }} />
      </SidebarHeader>
      <SidebarContent>
        <SidebarGroup>
          <SidebarGroupContent>
            <SidebarMenu>
              {VIEWS.map(({ label, icon, view }) => {
                const to = leadsTo(view, route, places);
                const here = route.view === view || (view === "agents" && route.view === "agent");
                const why = EMPTY_TITLE[view];
                return (
                  <SidebarMenuItem key={view}>
                    {to ? (
                      <SidebarMenuButton asChild isActive={here} tooltip={{ children: label, hidden: false }}>
                        <a href={formatRoute(to)} aria-current={here ? "page" : undefined}>
                          <RailIcon name={icon} />
                          <span>{label}</span>
                        </a>
                      </SidebarMenuButton>
                    ) : (
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <span className="flex">
                            <SidebarMenuButton type="button" aria-disabled aria-label={label} aria-describedby={`rail-why-${view}`}>
                              <RailIcon name={icon} />
                              <span>{label}</span>
                              <span id={`rail-why-${view}`} className="ui-sr">{why}</span>
                            </SidebarMenuButton>
                          </span>
                        </TooltipTrigger>
                        <TooltipContent side="right">{why}</TooltipContent>
                      </Tooltip>
                    )}
                  </SidebarMenuItem>
                );
              })}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
      </SidebarContent>
      <SidebarFooter>
        <SidebarMenu>
          <SidebarMenuItem>
            <Settings theme={theme} onTheme={onTheme} />
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarFooter>
    </>
  );
}
