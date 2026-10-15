import { useMemo } from "react";
import { dmPeers } from "./lib/dms.js";
import { nameIndex, displayNameOf } from "./lib/names.js";
import { formatRoute, type Route } from "./lib/route.js";
import { partsToText } from "./lib/parts.js";
import { rosterRows, statusLabel } from "./lib/roster.js";
import { documentTitle, orderNotice, staleView } from "./lib/shellText.js";
import type { Controller } from "./state/controller.js";
import { useStore } from "./state/hooks.js";
import type { Store } from "./state/store.js";
import type { DashboardState } from "./state/types.js";
import { AppShell } from "./ui/AppShell.tsx";

/** The two lines the dashboard owes its reader about what it shows: which sources are showing their
 *  last good value, and what the event stream is missing. Plain on purpose; phase 2 restyles them. */
function StatusLines({ store }: { store: Store<DashboardState> }) {
  const stale = useStore(store, (s) => s.stale);
  const notes = useStore(store, (s) => s.orderNotes);
  const view = staleView(stale);
  const notice = orderNotice(notes);
  return (
    <div>
      <p id="stale" hidden={view.hidden} title={view.title}>{view.text}</p>
      {notice && <p id="order-notice" role={notice.fault ? "alert" : "status"}>{notice.text}</p>}
    </div>
  );
}

/** What the dashboard draws from the store and the route, and nothing else: no feed, no fetch, no
 *  DOM access, so it renders the same in a browser and in `renderToString`. `controller` is null
 *  until the dashboard has started. The sidebar and the panel are empty frames and the centre still
 *  draws the phase 1 content (channel list, messages, roster) until the views replace it. */
export function Shell({ store, controller, route, paneOpen }: { store: Store<DashboardState>; controller: Controller | null; route: Route; paneOpen: boolean }) {
  const space = useStore(store, (s) => s.space);
  const channels = useStore(store, (s) => s.channels);
  const roster = useStore(store, (s) => s.roster);
  const dms = useStore(store, (s) => s.dms);
  const open = useStore(store, (s) => s.open);
  const idx = useMemo(() => nameIndex(roster), [roster]);
  const peer = useMemo(() => dmPeers(dms, roster)[0]?.id ?? null, [dms, roster]);
  return (
    <AppShell route={route} controller={controller} paneOpen={paneOpen} channel={channels[0]?.channel ?? null} peer={peer}>
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
        <div>{open?.messages.map(({ msg }) => <p key={msg.id}><b>{displayNameOf(msg.from, idx)}</b> {partsToText(msg.parts)}</p>)}</div>
        <div aria-label="Roster">{rosterRows(roster).map((r) => <p key={r.id}>{r.name}: {statusLabel(r)}</p>)}</div>
      </section>
    </AppShell>
  );
}
