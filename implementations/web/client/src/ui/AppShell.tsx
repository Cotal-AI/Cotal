import { useEffect, type ReactNode } from "react";
import { openTarget, syncOpen } from "../lib/routeOpen.js";
import type { Route } from "../lib/route.js";
import type { Controller } from "../state/controller.js";
import type { Theme } from "../lib/theme.js";
import { FocusTrap } from "./focusTrap.tsx";
import { Sheet, SheetContent, SheetTitle } from "#client/ui/shadcn/sheet.tsx";
import { Rail, type Places } from "./Rail.tsx";
import { useReturnFocus } from "./returnFocus.ts";
import { TabBar } from "./TabBar.tsx";

/** The page's grid: the rail, the sidebar, the centre and the details panel. A closed panel is not
 *  drawn and the grid drops its column (`no-pane`). The route is a prop and the shell reads no
 *  address: the wiring in `App` follows the hash and passes the route down.
 *
 *  Below 768px (`phone`) it is mock section F instead: the centre over a bottom tab bar, with no rail
 *  and no sidebar column. The sidebar is a sheet over the page while `sheetOpen`, and the panel, when
 *  open, is shadcn's Sheet from the right, titled Details for assistive tech. Both are modal: each
 *  holds focus until it closes, Escape closes it (`onSheetClose`, `onPanelClose`), and so does a tap on
 *  the scrim. Focus then goes back where it was. Theme settings live on the rail, so the phone follows
 *  the system.
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
  theme?: Theme;
  onTheme?: (t: Theme) => void;
  phone: boolean;
  /** How many agents are waiting, for the phone tab bar's Agents count. */
  waiting: number;
  /** How many agents are working, which the phone tab bar's Agents tab counts when none waits. */
  working: number;
  /** The roster is only last seen, so the page holds every working mark still (`data-presence`). */
  stale: boolean;
  sheetOpen: boolean;
  onSheetClose: () => void;
  onPanelClose: () => void;
}) {
  const { route, controller, paneOpen } = props;
  const target = openTarget(route);
  useEffect(() => {
    syncOpen(controller, target);
  }, [controller, target]);
  const returnFocus = useReturnFocus();
  if (props.phone) {
    return (
      <div className="ui-app ui-phone" data-view={route.view} data-presence={props.stale ? "stale" : undefined}>
        <main className="ui-center">{props.children}</main>
        <TabBar route={route} places={props.places} waiting={props.waiting} working={props.working} />
        {props.sheetOpen && (
          <FocusTrap onEscape={props.onSheetClose}>
            <div className="ui-sheet-scrim" onClick={props.onSheetClose} />
            <aside className="ui-side ui-sheet" aria-label="Space" role="dialog" aria-modal="true">{props.sidebar}</aside>
          </FocusTrap>
        )}
        <Sheet open={paneOpen} onOpenChange={(open) => !open && props.onPanelClose()}>
          <SheetContent side="right" showCloseButton={false} aria-describedby={undefined} {...returnFocus}>
            <SheetTitle className="sr-only">Details</SheetTitle>
            {props.panel}
          </SheetContent>
        </Sheet>
      </div>
    );
  }
  return (
    <div className={paneOpen ? "ui-app" : "ui-app no-pane"} data-view={route.view} data-presence={props.stale ? "stale" : undefined}>
      <Rail route={route} places={props.places} theme={props.theme} onTheme={props.onTheme} />
      <aside className="ui-side" aria-label="Space">{props.sidebar}</aside>
      <main className="ui-center">{props.children}</main>
      {paneOpen && <section className="ui-pane" aria-label="Details">{props.panel}</section>}
    </div>
  );
}
