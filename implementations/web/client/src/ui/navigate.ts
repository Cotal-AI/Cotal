import { createContext } from "react";
import type { Route } from "../lib/route.js";
import { goTo, type RouteHost } from "../routeWatch.js";

/** How a part moves the dashboard to another route: `goTo` over the address `App` was given, so a
 *  suite's fake address sees it. Outside `App` it writes the page's own address. */
export const Navigate = createContext<(route: Route) => void>((route) => goTo(globalThis as unknown as Pick<RouteHost, "location">, route));
