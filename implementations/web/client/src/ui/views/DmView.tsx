import { useMemo } from "react";
import { composeKey, composeTarget } from "../../lib/compose.js";
import { dmPairs, pairKey } from "../../lib/dms.js";
import { displayNameOf, nameIndex } from "../../lib/names.js";
import { rosterRows, type RosterRow } from "../../lib/roster.js";
import { useStore } from "../../state/hooks.js";
import type { Store } from "../../state/store.js";
import type { DashboardState } from "../../state/types.js";
import { Avatar } from "../Avatar.tsx";
import { useBadgeOf } from "../identity.js";
import { BetweenAgents, Composer, OutgoingRows } from "../Composer.tsx";
import { harnessName, UNVERIFIED } from "../MessageRow.tsx";
import { WorkingLine } from "../WorkingLine.tsx";
import { MessageList, usePinnedScroll } from "./ChannelView.tsx";

/** One direct message conversation, from `dmPairs`. The header is the peer the route names: its
 *  character, name, role and harness from the roster by id, and who it talks with. A route that names
 *  only the peer is a Message button's, so it opens the operator's conversation with the peer, and
 *  none when there is none yet: never another agent's conversation under a composer that posts to the
 *  peer. A conversation holding a row read from history says
 *  unverified, with the message rows' tooltip, because it was grouped by what the payload says about
 *  its own sender. A peer with no direct messages gets its header and a line saying so.
 *
 *  A view that posts to an agent (`composeTarget`) has the composer in its dock, and the operator's
 *  posts that no conversation holds yet follow the messages. A conversation between two agents says so
 *  in the dock's place, with Message for the operator's own conversation with the peer. The
 *  operator's own id reads "operator (you)" until the roster names it.
 *
 *  The conversation is found among the DMs alone, so a roster change does not regroup them.
 *
 *  Under the messages the working line (`WorkingLine`) names each party the roster holds whose
 *  status presence says is working.
 *
 *  WHEN A THREAD MAY BE CUT OFF. The page holds a window, the newest `DM_WINDOW` DMs space-wide, and
 *  nothing in it says where any one conversation started. Once a DM read has filled that window, or
 *  it has dropped a message (`dmsCut`), any conversation may have older messages outside it, including one whose
 *  oldest message held is not the window's oldest: it may have talked before the window opened and
 *  been quiet while other pairs filled it. So every conversation says "Earlier messages aren't
 *  loaded" while the window is cut, and none does while the window holds all the server had. That
 *  can say it of a conversation that did start inside the window, but it never calls a conversation
 *  complete when it may not be. */
export function DmView({ store, peer, with: other }: { store: Store<DashboardState>; peer: string; with?: string }) {
  const dms = useStore(store, (s) => s.dms);
  const roster = useStore(store, (s) => s.roster);
  const post = useStore(store, (s) => s.post);
  const self = useStore(store, (s) => s.operatorId);
  const idx = useMemo(() => nameIndex(roster), [roster]);
  const rows = useMemo(() => rosterRows(roster, { includeOffline: true }), [roster]);
  const peers = useMemo(() => new Map(rows.map((r) => [r.id, r])), [rows]);
  const cut = useStore(store, (s) => s.dmsCut);
  const withWhom = other ?? self ?? undefined;
  const conv = useMemo(() => {
    if (withWhom === undefined) return undefined;
    const key = pairKey(peer, withWhom);
    return dmPairs(dms).find((c) => c.key === key);
  }, [dms, peer, withWhom]);
  const me = peers.get(peer);
  const badgeOf = useBadgeOf();
  const name = displayNameOf(peer, idx, self);
  const sub = [me?.role, me?.harness && harnessName(me.harness)].filter(Boolean).join(" · ");
  const target = useMemo(() => composeTarget({ view: "dm", peer, with: other }, self), [peer, other, self]);
  const shown = useMemo(() => new Set(dms.map((m) => m.msg.id)), [dms]);
  const sent = useStore(store, (s) => (target ? s.drafts[composeKey(target)]?.outgoing.length ?? 0 : 0));
  const tail = conv?.messages[conv.messages.length - 1];
  const scroll = usePinnedScroll(conv?.key ?? peer, `${tail ? `${tail.msg.id}\u0001${tail.senderId ?? ""}` : ""}\u0002${sent}`);
  const toName = target?.kind === "dm" ? displayNameOf(target.to, idx, self) : "";
  const working = [...new Set([peer, withWhom])].map((id) => (id === undefined ? undefined : peers.get(id))).filter((r): r is RosterRow => r?.status === "working");
  return (
    <>
      <header className="ui-bar">
        <Avatar vendor={me?.harness} status={me?.status ?? "offline"} size={22} badge={me ? badgeOf(peer) : undefined} />
        <h1>{name}</h1>
        {sub && <span className="ui-topic">{sub}</span>}
        {conv && withWhom !== undefined && <span className="ui-topic">{`with ${displayNameOf(withWhom, idx, self)}`}</span>}
        {conv && !conv.verified && <span className="ui-unverified" title={UNVERIFIED}>unverified</span>}
      </header>
      <div className="ui-scroll" ref={scroll.ref} onScroll={scroll.onScroll}>
        {conv || sent > 0 ? (
          <div className="ui-col">
            {conv && cut && <div className="ui-cutoff">Earlier messages aren't loaded</div>}
            {conv && <MessageList messages={conv.messages} idx={idx} peers={peers} />}
            {target && <OutgoingRows store={store} target={target} shown={shown} />}
            <WorkingLine rows={working} />
          </div>
        ) : (
          <div className="ui-empty"><span>{`No direct messages with ${name} yet.`}</span></div>
        )}
      </div>
      {post && (target || other !== undefined) && (
        <div className="ui-dock">
          <div className="ui-dock-in">
            {target ? <Composer store={store} target={target} where={toName} to={`to ${toName}`} /> : <BetweenAgents peer={peer} name={name} selfId={self} />}
          </div>
        </div>
      )}
    </>
  );
}
