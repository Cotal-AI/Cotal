import { useEffect, useMemo, useState } from "react";
import { httpApi } from "./api/http.js";
import { openFeed } from "./api/feed.js";
import { nameIndex, displayNameOf } from "./lib/names.js";
import { partsToText } from "./lib/parts.js";
import "./lib/aguiFrame.js";
import { rosterRows, statusLabel } from "./lib/roster.js";
import { documentTitle, orderNotice, staleView } from "./lib/shellText.js";
import { startDashboard } from "./state/boot.js";
import type { Controller } from "./state/controller.js";
import { useStore } from "./state/hooks.js";
import { createStore } from "./state/store.js";
import { initialState } from "./state/types.js";

const store = createStore(initialState);

/** The two lines the dashboard owes its reader about what it shows: which sources are showing their
 *  last good value, and what the event stream is missing. Plain on purpose; phase 2 restyles them. */
function StatusLines() {
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

export function App() {
  // Started in an effect, not in render: the feed is a connection, and StrictMode runs an effect,
  // its cleanup and the effect again, so each run opens its own feed and the cleanup closes it.
  const [controller, setController] = useState<Controller | null>(null);
  useEffect(() => {
    const dashboard = startDashboard({ store, api: httpApi(), openFeed });
    setController(dashboard.controller);
    return dashboard.stop;
  }, []);
  const space = useStore(store, (s) => s.space);
  useEffect(() => {
    document.title = documentTitle(space);
  }, [space]);
  const channels = useStore(store, (s) => s.channels);
  const roster = useStore(store, (s) => s.roster);
  const open = useStore(store, (s) => s.open);
  const idx = useMemo(() => nameIndex(roster), [roster]);
  return (
    <div style={{ font: "14px 'Inter Variable', system-ui", padding: 16 }}>
      <StatusLines />
      <div style={{ display: "grid", gridTemplateColumns: "220px 1fr 260px", gap: 16 }}>
        <nav>{channels.map((c) => <button key={c.channel} disabled={!controller} onClick={() => void controller?.open(c.channel)}># {c.channel}</button>)}</nav>
        <main>{open?.messages.map((m) => <p key={m.id}><b>{displayNameOf(m.from, idx)}</b> {partsToText(m.parts)}</p>)}</main>
        <aside>{rosterRows(roster).map((r) => <p key={r.id}>{r.name}: {statusLabel(r)}</p>)}</aside>
      </div>
    </div>
  );
}
