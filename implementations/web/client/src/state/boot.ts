// The dashboard's boot order. The feed is opened FIRST and the bootstrap reads run after it, so the
// connection state is driven by the feed opening and no slow read can hold it down. What the feed
// says outranks a read issued before it: the controller drops a bootstrap value for a source the
// feed has already spoken for.
//
// Ported from the end of `app.js` (`refresh(); connect();` and the `open` handler that calls
// `refresh()` again) and the boot of `graph.js`, which used to chain the feed behind the bootstrap.
import type { FeedHandlers } from "../api/feed.js";
import { createController, type Api, type Controller } from "./controller.js";
import type { Store } from "./store.js";
import type { DashboardState } from "./types.js";

export function startDashboard(deps: {
  store: Store<DashboardState>;
  api: Api;
  openFeed: (h: FeedHandlers) => () => void;
}): { controller: Controller; stop(): void } {
  const { store } = deps;
  const controller = createController(store, deps.api);
  const handlers: FeedHandlers = {
    // EVERY open runs the bootstrap again, a reconnect included: events published while the feed was
    // down are not replayed, so the reads are what makes up the difference.
    open() {
      store.set({ connected: true });
      void controller.refresh();
    },
    error: () => store.set({ connected: false }),
    roster: controller.onRoster,
    presenceView: controller.onPresenceView,
    membership: controller.onMembership,
    membershipFailed: controller.onMembershipFailed,
    message: controller.onMessage,
  };
  const stopFeed = deps.openFeed(handlers);
  void controller.refresh();
  return { controller, stop: stopFeed };
}
