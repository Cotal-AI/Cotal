import { Cancel01Icon } from "@hugeicons/core-free-icons";
import { useLayoutEffect, useMemo, useRef, useState } from "react";
import { Icon } from "../../icons/Icon.tsx";
import { Button } from "#client/ui/shadcn/button.tsx";
import { Tooltip, TooltipContent, TooltipTrigger } from "#client/ui/shadcn/tooltip.tsx";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "#client/ui/shadcn/tabs.tsx";
import { formatRoute, type Route } from "../../lib/route.js";
import type { Controller } from "../../state/controller.js";
import type { Store } from "../../state/store.js";
import type { DashboardState } from "../../state/types.js";
import { AgentTab } from "./AgentTab.tsx";
import { MembersTab } from "./MembersTab.tsx";
import { TopologyTab } from "./TopologyTab.tsx";

export type PanelTab = "members" | "agent" | "topology";

/** Where this browser keeps whether the panel is open: "1" or "0". */
export const PANEL_KEY = "cotal.panel.open";

/** The saved open state, or undefined when nothing is saved, it is not one of the two values, or the
 *  browser blocks storage. */
function readOpen(): boolean | undefined {
  try {
    const v = globalThis.localStorage?.getItem(PANEL_KEY);
    return v === "1" ? true : v === "0" ? false : undefined;
  } catch {
    // Blocked storage is a browser setting, not a fault: the panel opens, as it does for a new reader.
    return undefined;
  }
}

/** Save the open state. When the browser blocks storage nothing is saved, and the choice lasts until
 *  the page closes. */
function writeOpen(open: boolean): void {
  try {
    globalThis.localStorage?.setItem(PANEL_KEY, open ? "1" : "0");
  } catch {
    // Blocked storage is a browser setting, not a fault.
  }
}

/** The panel's state and the ways to change it. `selectAgent` is the picker every view calls with an
 *  agent's id; it opens the panel on the Agent tab. */
export interface Panel {
  /** The reader's choice: open unless they closed it. */
  open: boolean;
  tab: PanelTab;
  /** The picked agent, which the Agent tab shows. */
  agent: string | null;
  setTab(tab: PanelTab): void;
  selectAgent(id: string): void;
  showMembers(): void;
  close(): void;
  toggle(): void;
}

/** The tab a route opens on: the Agent tab beside an agent's page, Members beside a channel,
 *  otherwise Topology, the one tab that needs nothing picked. */
const tabFor = (route: Route): PanelTab => (route.view === "agent" ? "agent" : (route.view === "channel" ? "members" : "topology"));

/** The panel's state for the shell.
 *
 *  - Open or closed is the reader's own choice, kept in this browser. It is read in a layout effect,
 *    before the first paint, so a server render never touches storage, and blocked storage reads as
 *    open. Picking an agent or the member stack opens the panel, and that is saved too.
 *  - A new route resets the tab: Members on a channel route, with the picked agent kept so its tab
 *    stays one click away; the Agent tab on an agent's page, with that agent picked; any other
 *    route drops the pick.
 *  - On a phone (`phone`) the panel is a sheet over the page, so it starts closed, opens only when the
 *    reader asks (the member stack, the panel button, picking an agent), closes again on a new route,
 *    and none of that touches the saved choice, which is the wide layout's. */
export function usePanel(route: Route, phone = false): Panel {
  const key = formatRoute(route);
  const [wide, setOpen] = useState(true);
  const [phoneOpen, setPhoneOpen] = useState(false);
  const onPhone = useRef(phone);
  onPhone.current = phone;
  useLayoutEffect(() => {
    const saved = readOpen();
    if (saved !== undefined) setOpen(saved);
  }, []);
  const [at, setAt] = useState<{ key: string; tab: PanelTab; agent: string | null }>(() => ({ key, tab: tabFor(route), agent: route.view === "agent" ? route.id : null }));
  let cur = at;
  if (at.key !== key) {
    // Reset during render, not in an effect, so the new route never draws a frame with the old tab.
    cur = { key, tab: tabFor(route), agent: route.view === "channel" ? at.agent : null };
    if (route.view === "agent") cur = { ...cur, agent: route.id };
    setAt(cur);
    setPhoneOpen(false);
  }
  // Stable across renders, so the picker handed down through `AgentPicker` does not redraw every row.
  const actions = useMemo(() => {
    const remember = (next: boolean) => {
      if (onPhone.current) return setPhoneOpen(next);
      setOpen(next);
      writeOpen(next);
    };
    return {
      setTab: (tab: PanelTab) => setAt((a) => ({ ...a, tab })),
      selectAgent: (id: string) => {
        setAt((a) => ({ ...a, tab: "agent", agent: id }));
        remember(true);
      },
      showMembers: () => {
        setAt((a) => ({ ...a, tab: "members" }));
        remember(true);
      },
      close: () => remember(false),
      remember,
    };
  }, []);
  const open = phone ? phoneOpen : wide;
  return {
    open,
    tab: cur.tab,
    agent: cur.agent,
    setTab: actions.setTab,
    selectAgent: actions.selectAgent,
    showMembers: actions.showMembers,
    close: actions.close,
    toggle: () => actions.remember(!open),
  };
}

/** Whether the shell draws the panel: the reader has it open, and there is something to show, a
 *  channel beside it (`routeHasPanel`) or a picked agent. */
export const panelShown = (panel: Panel, routeHasPanel: boolean): boolean => panel.open && (routeHasPanel || panel.agent !== null);

/** The right panel (mock section D, the panel): the Members, Agent and Topology tabs, the close
 *  button, and the open tab's body. A tab with nothing to show is disabled: Members off a channel
 *  route, Agent before an agent is picked. `clock` is the time the pill and the heartbeat read.
 *
 *  The tabs are shadcn's Tabs, so they follow the ARIA tabs pattern: Tab reaches the selected tab, and
 *  Left and Right (wrapping), Home and End move between the enabled tabs and select them. When the
 *  selected tab is disabled, Tab reaches the first enabled tab instead. */
export function RightPanel({ store, controller, channel, route, panel, clock }: {
  store: Store<DashboardState>;
  controller: Controller | null;
  /** The channel the route has open, or null off a channel route. */
  channel: string | null;
  /** The centre's route, which the Agent tab reads to leave out "Now" beside that agent's own page. */
  route: Route;
  panel: Panel;
  clock: () => number;
}) {
  const tabs: { id: PanelTab; label: string; off: boolean }[] = [
    { id: "members", label: "Members", off: channel === null },
    { id: "agent", label: "Agent", off: panel.agent === null },
    { id: "topology", label: "Topology", off: false },
  ];
  return (
    <Tabs value={panel.tab} onValueChange={(next) => (next === "members" || next === "agent" || next === "topology") && panel.setTab(next)} className="min-h-0 flex-1 gap-0">
      <div className="ui-tabs">
        <TabsList variant="line" aria-label="Details">
          {tabs.map((t) => (
            <TabsTrigger key={t.id} value={t.id} disabled={t.off}>{t.label}</TabsTrigger>
          ))}
        </TabsList>
        <span className="ui-sp" />
        <Tooltip>
          <TooltipTrigger asChild>
            <Button type="button" variant="ghost" size="icon" aria-label="Close panel" onClick={panel.close}>
              <Icon icon={Cancel01Icon} />
            </Button>
          </TooltipTrigger>
          <TooltipContent>Close panel</TooltipContent>
        </Tooltip>
      </div>
      <TabsContent value="members" className="ui-pane-body">
        {channel !== null && <MembersTab store={store} controller={controller} channel={channel} now={clock()} onPick={panel.selectAgent} />}
      </TabsContent>
      <TabsContent value="agent" className="ui-pane-body">
        {panel.agent !== null && <AgentTab store={store} controller={controller} id={panel.agent} route={route} />}
      </TabsContent>
      <TabsContent value="topology" className="ui-pane-body">
        <TopologyTab store={store} clock={clock} />
      </TabsContent>
    </Tabs>
  );
}
