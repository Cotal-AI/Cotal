import { useMemo } from "react";
import { nameIndex, displayNameOf } from "./lib/names.js";
import { partsToText } from "./lib/parts.js";
import { rosterRows, statusLabel } from "./lib/roster.js";
import { documentTitle, orderNotice, staleView } from "./lib/shellText.js";
import type { Controller } from "./state/controller.js";
import { useStore } from "./state/hooks.js";
import type { Store } from "./state/store.js";
import type { DashboardState } from "./state/types.js";

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

/** What the phase 1 dashboard draws from the store, and nothing else: no feed, no fetch, no DOM
 *  access, so it renders the same in a browser and in `renderToString`. `controller` is null until
 *  the dashboard has started; the channel buttons stay disabled until then. */
export function Shell({ store, controller }: { store: Store<DashboardState>; controller: Controller | null }) {
  const space = useStore(store, (s) => s.space);
  const channels = useStore(store, (s) => s.channels);
  const roster = useStore(store, (s) => s.roster);
  const open = useStore(store, (s) => s.open);
  const idx = useMemo(() => nameIndex(roster), [roster]);
  return (
    <div style={{ font: "14px 'Inter Variable', system-ui", padding: 16 }}>
      <title>{documentTitle(space)}</title>
      <StatusLines store={store} />
      <div style={{ display: "grid", gridTemplateColumns: "220px 1fr 260px", gap: 16 }}>
        <nav>{channels.map((c) => <button key={c.channel} disabled={!controller} onClick={() => void controller?.open(c.channel)}># {c.channel}</button>)}</nav>
        <main>{open?.messages.map((m) => <p key={m.id}><b>{displayNameOf(m.from, idx)}</b> {partsToText(m.parts)}</p>)}</main>
        <aside>{rosterRows(roster).map((r) => <p key={r.id}>{r.name}: {statusLabel(r)}</p>)}</aside>
      </div>
    </div>
  );
}
