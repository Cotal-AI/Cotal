import { useMemo } from "react";
import { dmPeers } from "../../lib/dms.js";
import { displayNameOf, nameIndex } from "../../lib/names.js";
import { rosterRows } from "../../lib/roster.js";
import { useStore } from "../../state/hooks.js";
import type { Store } from "../../state/store.js";
import type { DashboardState } from "../../state/types.js";
import { Avatar } from "../Avatar.tsx";
import { harnessName, UNVERIFIED } from "../MessageRow.tsx";
import { MessageList, usePinnedScroll } from "./ChannelView.tsx";

/** One direct message conversation, from `dmPeers`. The header is the peer the route names: its
 *  character, name, role and harness from the roster by id, and who it talks with. A route that names
 *  only the peer opens its newest conversation. A conversation holding a row read from history says
 *  unverified, with the message rows' tooltip, because it was grouped by what the payload says about
 *  its own sender. A peer with no direct messages gets its header and a line saying so. */
export function DmView({ store, peer, with: other }: { store: Store<DashboardState>; peer: string; with?: string }) {
  const dms = useStore(store, (s) => s.dms);
  const roster = useStore(store, (s) => s.roster);
  const idx = useMemo(() => nameIndex(roster), [roster]);
  const rows = useMemo(() => rosterRows(roster, { includeOffline: true }), [roster]);
  const peers = useMemo(() => new Map(rows.map((r) => [r.id, r])), [rows]);
  const convs = useMemo(() => dmPeers(dms, roster).find((p) => p.id === peer)?.conversations ?? [], [dms, roster, peer]);
  const conv = other === undefined ? convs[0] : convs.find((c) => c.with === other);
  const me = peers.get(peer);
  const name = displayNameOf(peer, idx);
  const sub = [me?.role, me?.harness && harnessName(me.harness)].filter(Boolean).join(" · ");
  const tail = conv?.messages[conv.messages.length - 1];
  const scroll = usePinnedScroll(conv?.key ?? peer, tail && `${tail.msg.id}\u0001${tail.senderId ?? ""}`);
  return (
    <>
      <header className="ui-bar">
        <Avatar vendor={me?.harness} status={me?.status ?? "offline"} size={22} />
        <h1>{name}</h1>
        {sub && <span className="ui-topic">{sub}</span>}
        {conv && <span className="ui-topic">{`with ${displayNameOf(conv.with, idx)}`}</span>}
        {conv && !conv.verified && <span className="ui-unverified" title={UNVERIFIED}>unverified</span>}
      </header>
      <div className="ui-scroll" ref={scroll.ref} onScroll={scroll.onScroll}>
        {conv ? (
          <div className="ui-col">
            <MessageList messages={conv.messages} idx={idx} peers={peers} />
          </div>
        ) : (
          <div className="ui-empty"><span>{`No direct messages with ${name} yet.`}</span></div>
        )}
      </div>
    </>
  );
}
