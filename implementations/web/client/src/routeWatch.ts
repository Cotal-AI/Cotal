// The browser half of routing: reading the address and following hash changes. It takes the host as
// a parameter instead of naming `window`, so a suite can drive it in Node over a fake location.
import { parseRoute, type Route } from "./lib/route.js";

/** The part of `window` the router uses. */
export interface RouteHost {
  location: { hash: string; pathname: string };
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
