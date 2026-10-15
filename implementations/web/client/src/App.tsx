import { useEffect, useState } from "react";
import { httpApi } from "./api/http.js";
import { openFeed } from "./api/feed.js";
import "./lib/aguiFrame.js";
import { Shell } from "./Shell.js";
import { startDashboard } from "./state/boot.js";
import type { Controller } from "./state/controller.js";
import { createStore } from "./state/store.js";
import { initialState } from "./state/types.js";

const store = createStore(initialState);

/** The wiring: one store, the dashboard started against the real API and feed, and the shell drawn
 *  from that store. Everything the reader sees is in `Shell`. */
export function App() {
  // Started in an effect, not in render: the feed is a connection, and StrictMode runs an effect,
  // its cleanup and the effect again, so each run opens its own feed and the cleanup closes it.
  const [controller, setController] = useState<Controller | null>(null);
  useEffect(() => {
    const dashboard = startDashboard({ store, api: httpApi(), openFeed });
    setController(dashboard.controller);
    return dashboard.stop;
  }, []);
  return <Shell store={store} controller={controller} />;
}
