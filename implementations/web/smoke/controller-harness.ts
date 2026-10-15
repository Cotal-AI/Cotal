// The dashboard controller, built over a fake `Api`, for the suites that used to lift `refresh`,
// `select` and `onMessage` out of the page sources. The cells drive the shipped controller through
// its methods and read what it wrote back from the store.
import { createEventOrder, type EventOrder } from "../client/src/lib/eventOrder.js";
import { createController, type Api, type Controller } from "../client/src/state/controller.js";
import { createStore, type Store } from "../client/src/state/store.js";
import { initialState, type DashboardState } from "../client/src/state/types.js";

/** Every read throws, so a cell that forgets to stub one fails on it instead of reading nothing. */
export const unusedApi: Api = {
  meta: async () => { throw new Error("meta not expected in this cell"); },
  roster: async () => { throw new Error("roster not expected in this cell"); },
  channels: async () => { throw new Error("channels not expected in this cell"); },
  activity: async () => { throw new Error("activity not expected in this cell"); },
  dms: async () => { throw new Error("dms not expected in this cell"); },
  history: async () => { throw new Error("history not expected in this cell"); },
  membership: async () => { throw new Error("membership not expected in this cell"); },
  deleteChannel: async () => { throw new Error("deleteChannel not expected in this cell"); },
  send: async () => { throw new Error("send not expected in this cell"); },
};

/** A bounded `/api/activity` page carrying `entries`, complete. */
export const page = (entries: unknown[] = []) =>
  ({ entries, partial: false, read: 1, of: 1, missing: [], reasons: {}, deadlineMs: 8000 }) as unknown as Awaited<ReturnType<Api["activity"]>>;

/** The six bootstrap reads `refresh()` issues, each answering an empty, healthy value. A refresh
 *  cell spreads this and overrides the read it is about. */
export const bootReads: Partial<Api> = {
  meta: async () => ({ space: "main", pid: 1, post: { mode: "participant" } }),
  roster: async () => [],
  channels: async () => [],
  activity: async () => page(),
  dms: async () => [],
  membership: async () => ({ members: [] }),
};

export interface Harness {
  store: Store<DashboardState>;
  ctl: Controller;
  /** Every order machine the controller armed, in order, by lane. */
  orders: { lane: "feed" | "open"; order: EventOrder }[];
  /** The machine the latest arm of `lane` produced. */
  last(lane: "feed" | "open"): EventOrder | undefined;
}

export function harness(api: Partial<Api>): Harness {
  const store = createStore(structuredClone(initialState));
  const orders: Harness["orders"] = [];
  const ctl = createController(store, { ...unusedApi, ...api }, {
    createOrder: (lane) => {
      const order = createEventOrder();
      orders.push({ lane, order });
      return order;
    },
  });
  const last = (lane: "feed" | "open") => orders.filter((o) => o.lane === lane).at(-1)?.order;
  return { store, ctl, orders, last };
}

/** A promise and the function that settles it, for a read the cell holds in flight. */
export function gate<T>(): { promise: Promise<T>; resolve(v: T): void; reject(e: unknown): void } {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}
