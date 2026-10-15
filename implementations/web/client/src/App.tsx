import { useEffect, useState } from "react";
import { httpApi } from "./api/http.js";
import { openFeed } from "./api/feed.js";
import "./lib/aguiFrame.js";
import { currentRoute, watchRoute, type RouteHost } from "./routeWatch.js";
import { Shell } from "./Shell.tsx";
import { startDashboard } from "./state/boot.js";
import type { Controller } from "./state/controller.js";
import { createStore, type Store } from "./state/store.js";
import { initialState, type DashboardState } from "./state/types.js";

const store = createStore(initialState);

/** Starts the dashboard against `store` and hands back its controller and the way to stop it. */
type Start = (store: Store<DashboardState>) => { controller: Controller; stop(): void };

/** The real start: the HTTP API and the live feed. */
const startLive: Start = (s) => startDashboard({ store: s, api: httpApi(), openFeed });

/** The wiring: one store, the dashboard started, the route followed from the address hash, and the
 *  shell drawn from the store and the route. Everything the reader sees is in `Shell`.
 *
 *  `host` (the address) and `start` default to the page's `window` and the live dashboard. A suite
 *  passes a fake of each to mount the app with no server and drive its hash. */
export function App({ host = window, start = startLive }: { host?: RouteHost; start?: Start }) {
  // Started in an effect, not in render: the feed is a connection, and StrictMode runs an effect,
  // its cleanup and the effect again, so each run opens its own feed and the cleanup closes it.
  const [controller, setController] = useState<Controller | null>(null);
  useEffect(() => {
    const dashboard = start(store);
    setController(dashboard.controller);
    return dashboard.stop;
  }, [start]);
  const [route, setRoute] = useState(() => currentRoute(host));
  useEffect(() => watchRoute(host, setRoute), [host]);
  // The details panel has nothing to show until its tabs exist, so it opens only beside a channel.
  return <Shell store={store} controller={controller} route={route} paneOpen={route.view === "channel"} />;
}
