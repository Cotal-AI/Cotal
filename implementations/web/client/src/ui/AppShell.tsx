import { cn } from "cn";
import { useEffect, type CSSProperties, type ReactNode } from "react";
import { openTarget, syncOpen } from "../lib/routeOpen.js";
import type { Route } from "../lib/route.js";
import type { Controller } from "../state/controller.js";
import { Sheet, SheetContent, SheetTitle } from "#client/ui/shadcn/sheet.tsx";
import { Sidebar, SidebarInset, SidebarProvider } from "#client/ui/shadcn/sidebar.tsx";
import { Rail, type Places } from "./Rail.tsx";
import { useReturnFocus } from "./returnFocus.ts";
import { TabBar } from "./TabBar.tsx";

/** The sidebar's width, the rail and the places together, as shadcn's sidebar-09 block sets it. */
const SIDEBAR_WIDTH = { "--sidebar-width": "350px" } as CSSProperties;

/** The page, laid out as shadcn's sidebar-09 block lays out its nested sidebars: a SidebarProvider
 *  around one Sidebar that collapses to icons, holding the rail (`Rail`) as its icon column and the
 *  places (`sidebar`) beside it, with the centre in a SidebarInset. The SidebarTrigger at the start of
 *  each view's header (`SidebarToggle`) collapses the places, leaving the rail, and Ctrl or Cmd+B
 *  does too; the sidebar opens expanded on every load. The details panel is a column of its own after
 *  the centre, since the provider holds one open state, the left navigation's, and a closed panel is
 *  not drawn. The route is a prop and the shell reads no address: the wiring in `App` follows the hash
 *  and passes the route down.
 *
 *  Below 768px (`phone`) it is mock section F instead: the centre over a bottom tab bar. The places
 *  are then the Sidebar's own sheet from the left, which the header's SidebarToggle opens. The rail is
 *  left out of it, since the tab bar already picks the views and the sheet keeps its width for the
 *  places; theme settings live on the rail, so the phone follows the system. The panel, when open, is
 *  shadcn's Sheet from the right, titled Details for assistive tech. Both sheets are modal: each holds
 *  focus until it closes, and Escape and a tap on the overlay close it. Focus then goes back to the
 *  button that opened it.
 *
 *  `stale` puts `data-presence` on the page, and on both sheets, which are drawn outside it.
 *
 *  Whenever the route changes the shell tells the controller what the address now asks for: a
 *  channel route opens that channel and any other route closes the open one. */
export function AppShell(props: {
  route: Route;
  controller: Controller | null;
  paneOpen: boolean;
  /** Where the rail's and the tab bar's Channels and Direct messages lead off their own routes. */
  places: Places;
  sidebar?: ReactNode;
  panel?: ReactNode;
  children?: ReactNode;
  /** Phone width as `useIsMobile` reads it, the hook the Sidebar reads too. */
  phone: boolean;
  /** How many agents are waiting, for the phone tab bar's Agents count. */
  waiting: number;
  /** How many agents are working, which the phone tab bar's Agents tab counts when none waits. */
  working: number;
  /** The roster is only last seen, so the page holds every working mark still (`data-presence`). */
  stale: boolean;
  onPanelClose: () => void;
}) {
  const { route, controller, paneOpen, phone } = props;
  const target = openTarget(route);
  useEffect(() => {
    syncOpen(controller, target);
  }, [controller, target]);
  const returnFocus = useReturnFocus();
  const presence = props.stale ? "stale" : undefined;
  return (
    <SidebarProvider className={cn("h-dvh", phone && "ui-phone flex-col")} style={SIDEBAR_WIDTH} data-view={route.view} data-presence={presence}>
      <Sidebar collapsible="icon" className="overflow-hidden *:data-[sidebar=sidebar]:flex-row">
        <Sidebar collapsible="none" role="navigation" aria-label="Views" className="hidden w-[calc(var(--sidebar-width-icon)+1px)]! border-r md:flex">
          <Rail route={route} places={props.places} />
        </Sidebar>
        <Sidebar collapsible="none" role="complementary" aria-label="Space" data-presence={presence} className="min-w-0 flex-1 group-data-[collapsible=icon]:hidden">
          {props.sidebar}
        </Sidebar>
      </Sidebar>
      <SidebarInset className="min-h-0 min-w-0">{props.children}</SidebarInset>
      {phone ? (
        <>
          <TabBar route={route} places={props.places} waiting={props.waiting} working={props.working} />
          <Sheet open={paneOpen} onOpenChange={(open) => !open && props.onPanelClose()}>
            <SheetContent side="right" showCloseButton={false} aria-describedby={undefined} data-presence={presence} {...returnFocus}>
              <SheetTitle className="sr-only">Details</SheetTitle>
              {props.panel}
            </SheetContent>
          </Sheet>
        </>
      ) : (
        paneOpen && <section className="ui-pane" aria-label="Details">{props.panel}</section>
      )}
    </SidebarProvider>
  );
}
