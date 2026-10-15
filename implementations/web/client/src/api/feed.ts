// The live feed: one `EventSource` on `/feed`, each event decoded and handed to a handler. The
// handlers are the dashboard's (state/boot.ts wires them to the controller), so this module knows
// the wire and nothing about the state.
import type { FeedMessage, MembershipSnapshot, PresenceView, RosterEntry } from "./types.js";

export interface FeedHandlers {
  open(): void;
  /** The connection failed and the browser is retrying it. */
  error(): void;
  /** The browser failed the connection for good (a non-200 answer, such as the gate's 401 after a
   *  restart or an expired session) and will not retry. */
  closed(): void;
  roster(r: RosterEntry[]): void;
  presenceView(v: PresenceView): void;
  membership(m: MembershipSnapshot): void;
  membershipFailed(reason: string): void;
  message(e: FeedMessage): void;
}

/** The part of `EventSource` the feed uses, so a smoke can supply a source of its own. */
export interface FeedSource {
  addEventListener(type: string, fn: (e: MessageEvent) => void): void;
  /** `EventSource.readyState`: 0 connecting (a retry is coming), 1 open, 2 closed for good. */
  readonly readyState: number;
  onopen: (() => void) | null;
  onerror: (() => void) | null;
  close(): void;
}

/** The event the server sends when it could not read membership. Its `data` is `{ reason }`. The
 *  client imports nothing from core at runtime, so the name is restated here and
 *  `smoke:web-membership-refusal` pins it to the server's exported constant. */
const MEMBERSHIP_READ_FAILED = "membership-read-failed";

/** `EventSource.CLOSED`, restated so the module reads no browser global at load. */
const CLOSED = 2;

/** The browser's `EventSource`. Its `onopen` takes the event, which the feed does not read, so the
 *  property types differ and TypeScript will not see it as a `FeedSource` without the cast. */
const nativeSource = (url: string): FeedSource => new EventSource(url) as unknown as FeedSource;

/** Open the feed and return the function that closes it. */
export function openFeed(handlers: FeedHandlers, make: (url: string) => FeedSource = nativeSource): () => void {
  const es = make("/feed");
  es.onopen = () => handlers.open();
  // The same `error` event covers both outcomes, and only `readyState` tells them apart: a network
  // drop leaves it at CONNECTING because the browser retries, a refused answer leaves it CLOSED.
  es.onerror = () => (es.readyState === CLOSED ? handlers.closed() : handlers.error());
  const on = <T>(type: string, fn: (data: T) => void) => es.addEventListener(type, (e) => fn(JSON.parse(e.data) as T));
  on<RosterEntry[]>("roster", (d) => handlers.roster(d));
  on<PresenceView>("presence-view", (d) => handlers.presenceView(d));
  on<MembershipSnapshot>("membership", (d) => handlers.membership(d));
  on<{ reason: string }>(MEMBERSHIP_READ_FAILED, (d) => handlers.membershipFailed(d.reason));
  on<FeedMessage>("message", (d) => handlers.message(d));
  return () => es.close();
}
