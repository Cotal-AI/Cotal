import { Plug01Icon } from "@hugeicons/core-free-icons";
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { Icon } from "../icons/Icon.tsx";
import { RailIcon } from "../icons/rail.tsx";
import { dmPeers } from "../lib/dms.js";
import { displayNameOf, nameIndex } from "../lib/names.js";
import { rosterRows, waiting } from "../lib/roster.js";
import { formatRoute, type Route } from "../lib/route.js";
import { rateText } from "../lib/shellText.js";
import { useStore } from "../state/hooks.js";
import type { Store } from "../state/store.js";
import type { DashboardState } from "../state/types.js";
import { Avatar } from "./Avatar.tsx";
import { StaleMarker } from "./StaleMarker.tsx";

/** How often the Activity row redraws its rate. The rate falls as the window slides past old
 *  messages, with no message to trigger a render, so the row asks again on this beat. */
const RATE_TICK_MS = 1000;

/** A channel the runtime writes a run's events to (`run.build-0412`). */
const isEventChannel = (channel: string): boolean => channel.startsWith("run.");

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
 *  Two things the mock draws are left out because the page cannot say them: the operator's place on
 *  the roster (it depends on the mesh's credential mode, which no read reports) and a "to you" mark on a
 *  direct message (the operator's id is not known here). The space name has no menu until the server
 *  can list the other spaces. */
export function Sidebar({ store, route, msgPerSecond }: { store: Store<DashboardState>; route: Route; msgPerSecond: () => number }) {
  const space = useStore(store, (s) => s.space);
  const channels = useStore(store, (s) => s.channels);
  const unread = useStore(store, (s) => s.unread);
  const roster = useStore(store, (s) => s.roster);
  const dms = useStore(store, (s) => s.dms);
  const connected = useStore(store, (s) => s.connected);
  const [, setTick] = useState(0);
  useEffect(() => {
    const timer = setInterval(() => setTick((t) => t + 1), RATE_TICK_MS);
    return () => clearInterval(timer);
  }, []);
  const rows = useMemo(() => rosterRows(roster, { includeOffline: true }), [roster]);
  const idx = useMemo(() => nameIndex(roster), [roster]);
  const byId = useMemo(() => new Map(rows.map((r) => [r.id, r])), [rows]);
  const needing = waiting(rows).length;
  const conversations = useMemo(() => {
    const seen = new Map<string, { pair: [string, string]; last: number }>();
    for (const peer of dmPeers(dms, roster))
      for (const c of peer.conversations)
        if (!seen.has(c.key)) seen.set(c.key, { pair: [peer.id, c.with].sort() as [string, string], last: c.last });
    return [...seen.values()].sort((a, b) => b.last - a.last);
  }, [dms, roster]);
  const open = route.view === "dm" ? route : null;
  return (
    <>
      <div className="ui-side-head">
        <span className="ui-space ui-space-static">{space}</span>
      </div>
      <StaleMarker store={store} />
      <nav className="ui-side-scroll" aria-label="Places">
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
        {conversations.map(({ pair: [a, b] }) => (
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
            <span className="ui-row-lbl">{`${displayNameOf(a, idx)}, ${displayNameOf(b, idx)}`}</span>
          </Row>
        ))}
      </nav>
      <div className="ui-side-foot">
        <span className="ui-me">OP</span>
        <div className="ui-who"><b>operator</b></div>
        {connected ? (
          <span className="ui-live" title="Connected to cotal web"><i></i>Connected</span>
        ) : (
          <span className="ui-live ui-live-down" title="Not connected to cotal web"><i></i>Disconnected</span>
        )}
      </div>
    </>
  );
}
