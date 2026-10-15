// The dashboard's boot order. The feed is opened FIRST and the bootstrap reads run after it, so the
// connection state is driven by the feed opening and no slow read can hold it down. What the feed
// says outranks a read issued before it: the controller drops a bootstrap value for a source the
// feed has already spoken for.
//
// Ported from the end of the old plain-JS console page (`refresh(); connect();` and the `open`
// handler that calls `refresh()` again) and the boot of the old graph page, which used to chain the
// feed behind the bootstrap.
import type { FeedHandlers } from "../api/feed.js";
import { createController, type Api, type Controller } from "./controller.js";
import type { Store } from "./store.js";
import type { DashboardState } from "./types.js";

/** How long after a refused read the dashboard first reads again, while the refusal stands. Each
 *  retry that is still refused doubles the wait, up to `RETRY_MAX_MS`. */
export const RETRY_MS = 5000;

/** The longest wait between two retries. */
export const RETRY_MAX_MS = 60_000;

/** The timer the retry runs on: `setTimeout` and `clearTimeout` unless a suite passes its own. */
export interface RetryTimer {
  set(fn: () => void, ms: number): unknown;
  clear(handle: unknown): void;
}

const realTimer: RetryTimer = {
  set: (fn, ms) => setTimeout(fn, ms),
  clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

/** A refused read the next `refresh()` can retry. The `roster` mark is the observer's own presence
 *  watch going silent, which no read repairs; a partial page is not a refusal. */
const retryable = (s: DashboardState): boolean => s.stale.some((m) => m.kind === "refused" && m.name !== "roster");

/** `onArrival` is told of every message the feed delivers, a duplicate delivery included, before the
 *  controller takes it. It is how the sidebar's message rate is fed without the rate entering the store.
 *
 *  The first roster and channel reads are marked outstanding before anything is read, so the page
 *  draws its skeleton rows until they land. While any read stands refused the dashboard reads again
 *  (on `timer`), which is what the stale marker's "Retrying." promises: first after `RETRY_MS`, then
 *  after twice the last wait, up to `RETRY_MAX_MS`, and from `RETRY_MS` again once the refusals have
 *  cleared. `stop()` cancels a pending retry along with the feed. */
export function startDashboard(deps: {
  store: Store<DashboardState>;
  api: Api;
  openFeed: (h: FeedHandlers) => () => void;
  onArrival?: () => void;
  timer?: RetryTimer;
}): { controller: Controller; stop(): void } {
  const { store } = deps;
  const timer = deps.timer ?? realTimer;
  store.set({ loading: { roster: true, channels: true } });
  const controller = createController(store, deps.api);
  // A read that is refused never rejects `refresh()`: `refreshAll` turns it into a stale mark. What
  // does reject it is a defect (an `apply` or a store subscriber that throws), and that is not a
  // fact about the link, so it must not become a stale mark that blames the network. It is made
  // visible on the console instead of being left as an unhandled rejection.
  const refresh = () => {
    void controller.refresh().catch((err) => console.error("dashboard refresh failed:", err));
  };
  const handlers: FeedHandlers = {
    // EVERY open runs the bootstrap again, a reconnect included: events published while the feed was
    // down are not replayed, so the reads are what makes up the difference.
    open() {
      store.set({ connection: "connected" });
      refresh();
    },
    // A failed first attempt has dropped nothing, so it is still connecting; an error after an open
    // is a drop, and the browser's EventSource retries it. A closed feed stays closed: the browser
    // will not retry it, so a late error cannot make the pill say it is reconnecting.
    error: () => store.set((s) => (s.connection === "closed" ? {} : { connection: s.connection === "connecting" ? "connecting" : "reconnecting" })),
    // Final: nothing reopens a feed the browser gave up on, so no later event can undo it.
    closed: () => store.set({ connection: "closed" }),
    roster: controller.onRoster,
    presenceView: controller.onPresenceView,
    membership: controller.onMembership,
    membershipFailed: controller.onMembershipFailed,
    message(e) {
      deps.onArrival?.();
      controller.onMessage(e);
    },
  };
  // One retry pending at most, and pending exactly while the store holds a retryable refusal, by
  // whichever read left it there (a refresh or a channel's history). It fires one refresh, which
  // reopens the open channel too. A read that lands clears the mark, and with it the pending retry,
  // which an earlier write in the same refresh may have armed while the old mark still stood, and
  // the wait goes back to its first length. Each retry that fires doubles the next wait, to the cap,
  // so a server that stays down is not asked every five seconds for as long as the page is open.
  let retry: unknown = null;
  let wait = RETRY_MS;
  const armRetry = () => {
    const wanted = retryable(store.get());
    if (!wanted) {
      if (retry !== null) timer.clear(retry);
      retry = null;
      wait = RETRY_MS;
      return;
    }
    if (retry !== null) return;
    retry = timer.set(() => {
      retry = null;
      wait = Math.min(wait * 2, RETRY_MAX_MS);
      refresh();
    }, wait);
  };
  const unsubscribe = store.subscribe(armRetry);
  const stopFeed = deps.openFeed(handlers);
  refresh();
  return {
    controller,
    stop() {
      unsubscribe();
      if (retry !== null) timer.clear(retry);
      retry = null;
      stopFeed();
    },
  };
}
