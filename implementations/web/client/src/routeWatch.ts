// The browser half of routing: reading the address and following hash changes. It takes the host as
// a parameter instead of naming `window`, so a suite can drive it in Node over a fake location.
import { formatRoute, parseRoute, type Route } from "./lib/route.js";

/** The part of `window` the router uses. */
export interface RouteHost {
  location: { hash: string; pathname: string };
  history: { replaceState(data: null, unused: string, url: string): void };
  addEventListener(type: "hashchange", listener: () => void): void;
  removeEventListener(type: "hashchange", listener: () => void): void;
}

/** The route the address names right now. */
export function currentRoute(host: RouteHost): Route {
  return parseRoute(host.location.hash, host.location.pathname);
}

/** Report the route on every hash change, until the returned function is called. */
export function watchRoute(host: RouteHost, on: (r: Route) => void): () => void {
  const listener = () => on(currentRoute(host));
  host.addEventListener("hashchange", listener);
  return () => host.removeEventListener("hashchange", listener);
}

/** Write an agent's page back into the address in the form `formatRoute` gives it, in place, with no
 *  new history entry and no hash change. An old link, `#/agent/<id>/<message id>`, becomes
 *  `#/agent/<id>/work/<message id>`, so the address a reader copies is the current form. */
export function settleAddress(host: RouteHost, route: Route): void {
  if (route.view !== "agent") return;
  const hash = formatRoute(route);
  if (host.location.hash !== hash) host.history.replaceState(null, "", hash);
}

/** Go to `route` by writing its hash into `host`'s address: a new history entry, and a hash change
 *  that the route follows. The one way the dashboard moves itself to another route. */
export function goTo(host: Pick<RouteHost, "location">, route: Route): void {
  host.location.hash = formatRoute(route);
}
