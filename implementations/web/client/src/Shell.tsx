import { useMemo } from "react";
import type { CotalMessage, FeedMessage } from "./api/types.js";
import { claimedBy } from "./lib/claims.js";
import { dmPeers } from "./lib/dms.js";
import { nameIndex } from "./lib/names.js";
import { formatRoute, type Route } from "./lib/route.js";
import { rosterRows } from "./lib/roster.js";
import { documentTitle, orderNotice } from "./lib/shellText.js";
import type { Controller } from "./state/controller.js";
import { useStore } from "./state/hooks.js";
import type { Store } from "./state/store.js";
import type { DashboardState } from "./state/types.js";
import { AppShell } from "./ui/AppShell.tsx";
import { Avatar } from "./ui/Avatar.tsx";
import { MessageRow } from "./ui/MessageRow.tsx";
import { Sidebar } from "./ui/Sidebar.tsx";
import { StatusWord } from "./ui/Status.tsx";

/** The line the dashboard owes its reader about what the event stream is missing. Plain on purpose;
 *  the feed views restyle it. */
function StatusLines({ store }: { store: Store<DashboardState> }) {
  const notes = useStore(store, (s) => s.orderNotes);
  const notice = orderNotice(notes);
  return (
    <div>
      {notice && <p id="order-notice" role={notice.fault ? "alert" : "status"}>{notice.text}</p>}
    </div>
  );
}

/** How a message was addressed, read from the field the wire sets for each mode. */
const modeOf = (msg: CotalMessage): FeedMessage["mode"] =>
  typeof msg.toService === "string" ? "anycast" : typeof msg.to === "string" ? "unicast" : "chat";

/** What the dashboard draws from the store and the route, and nothing else: no feed, no fetch, no
 *  DOM access, so it renders the same in a browser and in `renderToString`. `controller` is null
 *  until the dashboard has started. `msgPerSecond` is where the sidebar reads the message rate. The
 *  sidebar is the places and the stale marker, and the panel is an empty frame; the centre still draws the interim content (channel list, messages, roster) until the
 *  views replace it, but with the shared components.
 *
 *  A message row is keyed by its id and its verified sender together: one id can arrive from two
 *  senders (a duplicate delivery, or a peer reusing another's id), and both are facts to show. */
export function Shell({ store, controller, route, paneOpen, msgPerSecond }: {
  store: Store<DashboardState>;
  controller: Controller | null;
  route: Route;
  paneOpen: boolean;
  msgPerSecond: () => number;
}) {
  const space = useStore(store, (s) => s.space);
  const channels = useStore(store, (s) => s.channels);
  const roster = useStore(store, (s) => s.roster);
  const dms = useStore(store, (s) => s.dms);
  const open = useStore(store, (s) => s.open);
  const idx = useMemo(() => nameIndex(roster), [roster]);
  const rows = useMemo(() => rosterRows(roster, { includeOffline: true }), [roster]);
  const peers = useMemo(() => new Map(rows.map((r) => [r.id, r])), [rows]);
  const peer = useMemo(() => dmPeers(dms, roster)[0]?.id ?? null, [dms, roster]);
  return (
    <AppShell route={route} controller={controller} paneOpen={paneOpen} channel={channels[0]?.channel ?? null} peer={peer} sidebar={<Sidebar store={store} route={route} msgPerSecond={msgPerSecond} />}>
      <title>{documentTitle(space)}</title>
      <StatusLines store={store} />
      <section className="ui-view" data-view={route.view}>
        <nav aria-label="Channels">
          {channels.map((c) => (
            <a
              key={c.channel}
              className="ui-chlink"
              href={formatRoute({ view: "channel", channel: c.channel })}
              aria-current={route.view === "channel" && route.channel === c.channel ? "page" : undefined}
            ># {c.channel}</a>
          ))}
        </nav>
        <div className="ui-col">
          {open?.messages.map(({ msg, senderId }, i, all) => {
            const mode = modeOf(msg);
            return (
              <MessageRow
                key={`${msg.id}\u0001${senderId ?? ""}`}
                msg={msg}
                senderId={senderId}
                mode={mode}
                idx={idx}
                peers={peers}
                mention="operator"
                claim={mode === "anycast" ? claimedBy(msg.id, all.slice(i + 1)) : undefined}
              />
            );
          })}
        </div>
        <div aria-label="Roster">
          {rows.filter((r) => r.status !== "offline").map((r) => (
            <div key={r.id} className="v3-mrow">
              <Avatar vendor={r.harness} status={r.status} size={28} />
              <span className="v3-mname">{r.name}{r.role && <span>{r.role}</span>}</span>
              <StatusWord row={r} />
            </div>
          ))}
        </div>
      </section>
    </AppShell>
  );
}
