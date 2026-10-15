import { Plug01Icon } from "@hugeicons/core-free-icons";
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { Icon } from "../icons/Icon.tsx";
import { RailIcon } from "../icons/rail.tsx";
import { footerLine } from "../lib/compose.js";
import { dmPeers } from "../lib/dms.js";
import { displayNameOf, nameIndex } from "../lib/names.js";
import { rosterRows, waiting } from "../lib/roster.js";
import { formatRoute, type Route } from "../lib/route.js";
import { rateText } from "../lib/shellText.js";
import { useStore } from "../state/hooks.js";
import type { Store } from "../state/store.js";
import type { Connection, DashboardState } from "../state/types.js";
import { Avatar } from "./Avatar.tsx";
import { UNVERIFIED } from "./MessageRow.tsx";
import { SkeletonPlaces } from "./Skeleton.tsx";
import { StaleMarker } from "./StaleMarker.tsx";

/** How often the Activity row redraws its rate. The rate falls as the window slides past old
 *  messages, with no message to trigger a render, so the row asks again on this beat. */
const RATE_TICK_MS = 1000;

/** A channel the runtime writes a run's events to (`run.build-0412`). */
const isEventChannel = (channel: string): boolean => channel.startsWith("run.");

/** The pill while the feed is not open. Only `closed` says Disconnected: there the browser has failed
 *  the feed for good, while in the other two it is still trying, and the pill says what it is doing. */
const PILL: Record<Exclude<Connection, "connected">, { text: string; title: string }> = {
  connecting: { text: "Connecting", title: "Connecting to cotal web" },
  reconnecting: { text: "Reconnecting", title: "Reconnecting to cotal web" },
  closed: { text: "Disconnected", title: "The live feed closed and will not retry. Reload the page, or open the link cotal web printed when it started." },
};

/** One link row: `to` is the route it opens and `here` whether that route is the page now. */
function Row({ to, here, bold, title, children }: { to: Route; here: boolean; bold?: boolean; title?: string; children: ReactNode }) {
  return (
    <a className={bold ? "ui-row ui-row-bold" : "ui-row"} href={formatRoute(to)} aria-current={here ? "page" : undefined} title={title}>
      {children}
    </a>
  );
}

/** The sidebar (mock section D), top to bottom: the space's name, the stale marker, the places, and
 *  the operator with the connection pill. It draws from the store and the route only.
 *
 *  `msgPerSecond` is read on every render and again every second, so the Activity row follows the
 *  rate as it falls. The rate itself lives outside the store, which holds serializable state.
 *
 *  A direct message conversation holding a row read from history says unverified, as a message row
 *  does, because it was grouped by what the payload says about its own sender. A conversation is
 *  named, and linked, opener first: the sender of its first message, then the other party, as the
 *  mock writes "reviewer_2, david".
 *
 *  While the first roster and channel reads are outstanding the places are skeleton rows.
 *
 *  The footer's second line is the operator's place on the roster (`footerLine`): nothing until
 *  `/api/meta` has said what the dashboard can post as, then "Not on the roster" until the operator's
 *  id is on it, "On the roster" once it is, and "Read only" when posting is off. Its reason is the
 *  tooltip, and the line takes the keyboard focus with the reason as its accessible description, so
 *  a reader without a pointer reaches it too. The operator's own id reads "operator (you)" in a conversation until the roster names it.
 *
 *  A "to you" mark on a direct message, which the mock draws, is left out. The space name has no menu
 *  until the server can list the other spaces. */
export function Sidebar({ store, route, msgPerSecond }: { store: Store<DashboardState>; route: Route; msgPerSecond: () => number }) {
  const space = useStore(store, (s) => s.space);
  const channels = useStore(store, (s) => s.channels);
  const unread = useStore(store, (s) => s.unread);
  const roster = useStore(store, (s) => s.roster);
  const dms = useStore(store, (s) => s.dms);
  const connection = useStore(store, (s) => s.connection);
  const loading = useStore(store, (s) => s.loading);
  const post = useStore(store, (s) => s.post);
  const self = useStore(store, (s) => s.operatorId);
  const [, setTick] = useState(0);
  useEffect(() => {
    const timer = setInterval(() => setTick((t) => t + 1), RATE_TICK_MS);
    return () => clearInterval(timer);
  }, []);
  const rows = useMemo(() => rosterRows(roster, { includeOffline: true }), [roster]);
  const idx = useMemo(() => nameIndex(roster), [roster]);
  const byId = useMemo(() => new Map(rows.map((r) => [r.id, r])), [rows]);
  const needing = waiting(rows).length;
  const line = footerLine(post, self !== null && roster.some((p) => p.card.id === self));
  const conversations = useMemo(() => {
    const seen = new Map<string, { pair: [string, string]; last: number; verified: boolean }>();
    for (const peer of dmPeers(dms, roster))
      for (const c of peer.conversations) {
        if (seen.has(c.key)) continue;
        const first = c.messages[0];
        const opener = first?.senderId ?? first?.msg.from?.id;
        const pair: [string, string] = opener === c.with ? [c.with, peer.id] : [peer.id, c.with];
        seen.set(c.key, { pair, last: c.last, verified: c.verified });
      }
    return [...seen.values()].sort((a, b) => b.last - a.last);
  }, [dms, roster]);
  const open = route.view === "dm" ? route : null;
  return (
    <>
      <div className="ui-side-head">
        <span className="ui-space ui-space-static">{space}</span>
      </div>
      <StaleMarker store={store} />
      {loading.roster || loading.channels ? <SkeletonPlaces /> : <nav className="ui-side-scroll" aria-label="Places">
        <Row to={{ view: "needs" }} here={route.view === "needs"}>
          <RailIcon name="inbox" />
          <span className="ui-row-lbl">Needs you</span>
          {needing > 0 && <span className="ui-badge-gold" title={`${needing} agent${needing === 1 ? "" : "s"} waiting`}>{needing}</span>}
        </Row>
        <Row to={{ view: "activity" }} here={route.view === "activity"}>
          <RailIcon name="activity" />
          <span className="ui-row-lbl">Activity</span>
          <span className="ui-row-n">{rateText(msgPerSecond())}</span>
        </Row>
        <div className="ui-sec">Channels</div>
        {channels.length === 0 && <div className="ui-beat ui-beat-empty">No channels yet. One appears with its first message.</div>}
        {channels.map((c) => {
          const count = unread[c.channel] ?? 0;
          const event = isEventChannel(c.channel);
          return (
            <Row
              key={c.channel}
              to={{ view: "channel", channel: c.channel }}
              here={route.view === "channel" && route.channel === c.channel}
              bold={count > 0}
              title={event ? `Events from run ${c.channel.slice("run.".length)}` : undefined}
            >
              {event ? <Icon icon={Plug01Icon} size={18} className="ui-ic" /> : <RailIcon name="hash" />}
              <span className="ui-row-lbl">{c.channel}</span>
              {count > 0 && <span className="ui-badge-blue">{count}</span>}
            </Row>
          );
        })}
        <div className="ui-sec">Direct messages</div>
        {conversations.map(({ pair: [a, b], verified }) => (
          <Row
            key={`${a}\u0001${b}`}
            to={{ view: "dm", peer: a, with: b }}
            here={open !== null && ((open.peer === a && open.with === b) || (open.peer === b && open.with === a))}
          >
            <span className="ui-stack">
              {[a, b].map((id) => (
                <Avatar key={id} vendor={byId.get(id)?.harness} status={byId.get(id)?.status ?? "offline"} size={18} dot={false} />
              ))}
            </span>
            <span className="ui-row-lbl">{`${displayNameOf(a, idx, self)}, ${displayNameOf(b, idx, self)}`}</span>
            {!verified && <span className="ui-unverified" title={UNVERIFIED}>unverified</span>}
          </Row>
        ))}
      </nav>}
      <div className="ui-side-foot">
        <span className="ui-me">OP</span>
        <div className="ui-who">
          <b>operator</b>
          {line && <span title={line.title} tabIndex={0} aria-describedby="operator-line-why">{line.text}</span>}
          {line && <span id="operator-line-why" className="ui-sr">{line.title}</span>}
        </div>
        {connection === "connected" ? (
          <span className="ui-live" title="Connected to cotal web"><i></i>Connected</span>
        ) : (
          <span className="ui-live ui-live-down" title={PILL[connection].title}><i></i>{PILL[connection].text}</span>
        )}
      </div>
    </>
  );
}
