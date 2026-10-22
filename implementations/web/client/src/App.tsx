import { useCallback, useEffect, useLayoutEffect, useState } from "react";
import { httpApi } from "./api/http.js";
import { openFeed } from "./api/feed.js";
import "./lib/aguiFrame.js";
import { createRate } from "./lib/rate.js";
import type { Route } from "./lib/route.js";
import { currentRoute, goTo, settleAddress, watchRoute, type RouteHost } from "./routeWatch.js";
import { Shell } from "./Shell.tsx";
import { startDashboard } from "./state/boot.js";
import { Navigate } from "./ui/navigate.js";
import type { Controller } from "./state/controller.js";
import { createStore, type Store } from "./state/store.js";
import { initialState, type DashboardState } from "./state/types.js";
import { useTheme } from "./theme.ts";
import { usePhone } from "./viewport.ts";

const store = createStore(initialState);

/** The span the sidebar's message rate averages over. A second would show whole numbers that jump;
 *  ten smooths a trickle into the `0.8 msg/s` the mock draws. */
const RATE_WINDOW_MS = 10_000;

/** Starts the dashboard against `store` and hands back its controller and the way to stop it.
 *  `onArrival` is called once for every message the feed delivers. */
type Start = (store: Store<DashboardState>, onArrival: () => void) => { controller: Controller; stop(): void };

/** The real start: the HTTP API and the live feed. */
const startLive: Start = (s, onArrival) => startDashboard({ store: s, api: httpApi(), openFeed, onArrival });

/** The wiring: one store, the dashboard started, the route followed from the address hash, the
 *  theme and the phone layout followed from the browser, and the shell drawn from all of it.
 *  Everything the reader sees is in `Shell`. An agent's page reached by an old link has its address
 *  rewritten in place to the current form (`settleAddress`), and a part that moves the dashboard
 *  itself writes `host`'s address through `Navigate`.
 *
 *  The dashboard starts in a layout effect, before the first paint, so the skeleton rows it asks for
 *  are the first thing drawn rather than an empty page a frame earlier.
 *
 *  The message rate is a rolling counter held here, outside the store: it is fed by the feed's
 *  arrivals and read by the sidebar on its one-second beat, and it is not serializable state. It
 *  counts from the moment the app mounts, so its first ten seconds are not diluted.
 *
 *  `host` (the address), `start` and `clock` default to the page's `window`, the live dashboard and
 *  `Date.now`. A suite passes a fake of each to mount the app with no server, drive its hash and set
 *  the time the rate reads. */
export function App({ host = window, start = startLive, clock = Date.now }: { host?: RouteHost; start?: Start; clock?: () => number }) {
  // Started in a layout effect, not in render: the feed is a connection, and StrictMode runs an effect,
  // its cleanup and the effect again, so each run opens its own feed and the cleanup closes it.
  const [controller, setController] = useState<Controller | null>(null);
  const [rate] = useState(() => createRate(RATE_WINDOW_MS, clock()));
  useLayoutEffect(() => {
    const dashboard = start(store, () => rate.hit(clock()));
    setController(dashboard.controller);
    return dashboard.stop;
  }, [start, rate, clock]);
  const [route, setRoute] = useState(() => currentRoute(host));
  useEffect(() => watchRoute(host, setRoute), [host]);
  useEffect(() => settleAddress(host, route), [host, route]);
  const navigate = useCallback((r: Route) => goTo(host, r), [host]);
  const [theme, setTheme] = useTheme();
  const phone = usePhone();
  // The details panel opens beside a channel and beside an agent's page, on that agent's tab.
  return (
    <Navigate.Provider value={navigate}>
    <Shell
      store={store}
      controller={controller}
      route={route}
      paneOpen={route.view === "channel" || route.view === "agent"}
      msgPerSecond={() => rate.perSecond(clock())}
      phone={phone}
      theme={theme}
      onTheme={setTheme}
    />
    </Navigate.Provider>
  );
}
