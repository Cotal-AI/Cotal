import { useEffect, type ReactNode } from "react";
import { openTarget, syncOpen } from "../lib/routeOpen.js";
import type { Route } from "../lib/route.js";
import type { Controller } from "../state/controller.js";
import { Rail } from "./Rail.tsx";

/** The page's grid: the rail, the sidebar, the centre and the details panel. A closed panel is not
 *  drawn and the grid drops its column (`no-pane`). The route is a prop and the shell reads no
 *  address: the wiring in `App` follows the hash and passes the route down.
 *
 *  Whenever the route changes the shell tells the controller what the address now asks for: a
 *  channel route opens that channel and any other route closes the open one. */
export function AppShell(props: {
  route: Route;
  controller: Controller | null;
  paneOpen: boolean;
  /** Where the rail's Channels item leads off a channel route. */
  channel: string | null;
  /** Where the rail's Direct messages item leads off a conversation route. */
  peer: string | null;
  sidebar?: ReactNode;
  panel?: ReactNode;
  children?: ReactNode;
}) {
  const { route, controller, paneOpen } = props;
  const target = openTarget(route);
  useEffect(() => {
    syncOpen(controller, target);
  }, [controller, target]);
  return (
    <div className={paneOpen ? "ui-app" : "ui-app no-pane"} data-view={route.view}>
      <Rail route={route} channel={props.channel} peer={props.peer} />
      <aside className="ui-side" aria-label="Space">{props.sidebar}</aside>
      <main className="ui-center">{props.children}</main>
      {paneOpen && <section className="ui-pane" aria-label="Details">{props.panel}</section>}
    </div>
  );
}
