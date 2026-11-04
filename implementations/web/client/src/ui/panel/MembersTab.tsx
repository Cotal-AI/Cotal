import { Delete02Icon } from "@hugeicons/core-free-icons";
import { useMemo, useRef, useState } from "react";
import { Icon } from "../../icons/Icon.tsx";
import { channelMembers } from "../../lib/members.js";
import { pillState } from "../../lib/membership.js";
import { displayNameOf, nameIndex } from "../../lib/names.js";
import { rosterRows } from "../../lib/roster.js";
import type { Controller } from "../../state/controller.js";
import { useStore } from "../../state/hooks.js";
import type { Store } from "../../state/store.js";
import type { ChannelRow, DashboardState, StoredMessage } from "../../state/types.js";
import { Avatar } from "../Avatar.tsx";
import { useBadgeOf } from "../identity.js";
import { MembershipPill } from "../MembershipPill.tsx";
import { StatusWord } from "../Status.tsx";
import { DeleteChannelDialog } from "./DeleteChannelDialog.tsx";

/** Stable empty list, so the store selector returns the same reference while nothing is open. */
const NONE: StoredMessage[] = [];

/** The part of the trigger button focus returns to. Spelled out rather than taken from the DOM lib,
 *  because the suites typecheck the components that render on the server with no DOM lib. */
type Focusable = { focus(): void };

/** How the channel delivers, as the Delivery row says it: its class, then its replay window
 *  ("durable, replay 24h"). Undefined for a channel whose policy the server has not sent yet (a row
 *  a live message created), rather than a guess. */
export function deliveryText(info: ChannelRow | undefined): string | undefined {
  if (info?.deliveryClass === undefined) return undefined;
  const parts: string[] = [info.deliveryClass];
  if (info.replay === true) parts.push(info.replayWindow === undefined ? "replay" : `replay ${info.replayWindow}`);
  return parts.join(", ");
}

/** The Members tab (mock section D, the panel): who is in the channel and which source says so, then
 *  the channel's own details and the way to delete it.
 *
 *  - Members are `channelMembers`: the broker's when its feed is authoritative, else who posted here.
 *    The pill names which, with the notes' tooltips. They are listed in the roster's order, waiting
 *    first, and a member the roster does not know is listed last by its id, with no status to show:
 *    no word and no dot.
 *  - Clicking a member picks it (`onPick`), which opens the Agent tab.
 *  - Delete channel opens the type-the-name dialog, and focus comes back to the button when it closes.
 *  - `now` is the time the pill measures the feed's age against. */
export function MembersTab({ store, controller, channel, now, onPick }: {
  store: Store<DashboardState>;
  controller: Controller | null;
  channel: string;
  now: number;
  onPick: (id: string) => void;
}) {
  const space = useStore(store, (s) => s.space);
  const roster = useStore(store, (s) => s.roster);
  const channels = useStore(store, (s) => s.channels);
  const membership = useStore(store, (s) => s.membership);
  const open = useStore(store, (s) => s.open);
  const messages = open?.channel === channel ? open.messages : NONE;
  const idx = useMemo(() => nameIndex(roster), [roster]);
  const everyone = useMemo(() => rosterRows(roster, { includeOffline: true }), [roster]);
  const members = useMemo(() => {
    const order = new Map(everyone.map((r, i) => [r.id, i]));
    const rank = (id: string) => order.get(id) ?? everyone.length;
    return channelMembers(channel, membership, channels.map((c) => c.channel), messages).sort((a, b) => rank(a.id) - rank(b.id));
  }, [channel, membership, channels, messages, everyone]);
  const badgeOf = useBadgeOf();
  const peers = useMemo(() => new Map(everyone.map((r) => [r.id, r])), [everyone]);
  const info = channels.find((c) => c.channel === channel);
  const delivery = deliveryText(info);
  const [deleting, setDeleting] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const n = members.length;
  return (
    <>
      <div className="v3-mhead">
        <span>
          <b style={{ color: "var(--ink)", fontWeight: 600 }}>{`#${channel}`}</b>
          {" · "}
          <span className="ui-num">{n}</span>
          {n === 1 ? " member" : " members"}
        </span>
        <span className="ui-sp" />
        <MembershipPill state={pillState(membership, now)} reason={membership.unreadable} />
      </div>
      {members.map((m) => {
        const r = peers.get(m.id);
        return (
          <button key={m.id} type="button" className="v3-mrow" data-member={m.id} data-source={m.source} onClick={() => onPick(m.id)}>
            <Avatar vendor={r?.harness} status={r?.status ?? "offline"} size={28} dot={r !== undefined} badge={r ? badgeOf(m.id) : undefined} />
            <span className="v3-mname">{r?.name ?? displayNameOf(m.id, idx)}{r?.role && <span>{r.role}</span>}</span>
            {r && <StatusWord row={r} />}
          </button>
        );
      })}
      <h5 style={{ marginTop: 14 }}>Channel</h5>
      <dl className="ui-kv" style={{ borderTop: 0, paddingTop: 0 }}>
        {info?.description && <><dt>Topic</dt><dd>{info.description}</dd></>}
        {delivery && <><dt>Delivery</dt><dd>{delivery}</dd></>}
        {info && <><dt>Messages</dt><dd className="ui-num">{info.messages}</dd></>}
      </dl>
      <button ref={trigger} type="button" className="ui-btn ui-btn-danger" style={{ marginTop: 4 }} onClick={() => setDeleting(true)}>
        <Icon icon={Delete02Icon} size={16} className="ui-ic ui-ic16" />
        Delete channel
      </button>
      {deleting && (
        <DeleteChannelDialog
          channel={channel}
          space={space}
          controller={controller}
          onClose={() => {
            setDeleting(false);
            (trigger.current as unknown as Focusable | null)?.focus();
          }}
        />
      )}
    </>
  );
}
