import { ArrowUpRight01Icon, BubbleChatIcon, HashtagIcon } from "@hugeicons/core-free-icons";
import type { CotalMessage } from "../../api/types.js";
import { Icon } from "../../icons/Icon.tsx";
import { partsToText } from "../../lib/parts.js";
import type { RosterRow } from "../../lib/roster.js";
import { formatRoute } from "../../lib/route.js";
import type { StoredMessage } from "../../state/types.js";
import { Avatar } from "../Avatar.tsx";
import { useBadgeOf } from "../identity.js";
import { SessionEmpty } from "../session/SessionEmpty.tsx";
import { Time } from "../session/Time.tsx";
import { Marker, MarkerContent, MarkerIcon } from "../shadcn/marker.tsx";
import { Prose } from "../work/Prose.tsx";

/** The messages an agent sent to one place: a channel (`channel`) or one counterpart (`to`), newest
 *  first. */
export interface MessageGroup { key: string; channel?: string; to?: string; rows: CotalMessage[] }

/** A message's time for ordering; one with no time sorts as the oldest. */
const timeOf = (m: CotalMessage): number => (Number.isFinite(m.ts) ? m.ts : Number.NEGATIVE_INFINITY);

/** The agent's own verified messages (`own`, from `useOwnMessages`) by place (mock C "Every tab",
 *  `tpl-msgs-logic`): a group per channel it posted in and per party it sent a direct message to, each
 *  newest first, and the groups by their newest message. */
export function messageGroups(own: readonly StoredMessage[]): MessageGroup[] {
  const groups = new Map<string, MessageGroup>();
  for (const { msg } of own) {
    const channel = typeof msg.channel === "string" ? msg.channel : undefined;
    const to = channel === undefined && typeof msg.to === "string" ? msg.to : undefined;
    if (channel === undefined && to === undefined) continue;
    const key = channel !== undefined ? `channel:${channel}` : `dm:${to}`;
    let group = groups.get(key);
    if (!group) groups.set(key, (group = { key, ...(channel !== undefined ? { channel } : { to }), rows: [] }));
    group.rows.push(msg);
  }
  const all = [...groups.values()];
  for (const g of all) g.rows.sort((a, b) => timeOf(b) - timeOf(a));
  return all.sort((a, b) => timeOf(b.rows[0]!) - timeOf(a.rows[0]!));
}

/** One message as a row: the agent's avatar and name, where it went, its time, the link to where it
 *  was sent, and its body through `Prose`. */
function Row({ msg, row, place, href, label }: { msg: CotalMessage; row: RosterRow; place: string; href: string; label: string }) {
  const badgeOf = useBadgeOf();
  return (
    <div className="ui-msg ox-msg" data-post={msg.id}>
      <div className="ui-gut"><Avatar vendor={row.harness} status={row.status} size={34} dot={false} badge={badgeOf(row.id)} /></div>
      <div>
        <div className="ui-mh">
          <b>{row.name}</b>
          <span className="ui-role">{place}</span>
          <Time ts={msg.ts} />
          <span className="ui-sp" />
          <a className="ox-act" href={href}>
            {label}
            <Icon icon={ArrowUpRight01Icon} size={16} />
          </a>
        </div>
        <Prose className="ui-tx" src={partsToText(msg.parts)} />
      </div>
    </div>
  );
}

/** The Messages tab of an agent's page: what it sent on this page, by place, newest first (`groups`,
 *  from `messageGroups`). A channel's marker is the hash, `#<channel>` and how many posts; its rows
 *  say "in #<channel>" and open the channel. A conversation's marker is the bubble, "Direct
 *  messages" and how many went to whom; its rows say "to <name>" and open the conversation. With
 *  none, it says so. Under it, that older messages are in each channel's history.
 *
 *  `row` is the agent's roster row and `nameOf` names a roster id, so no name comes from a payload. */
export function AgentMessages({ groups, row, nameOf }: { groups: readonly MessageGroup[]; row: RosterRow; nameOf: (id: string) => string }) {
  return (
    <div className="ox-msgs">
      {groups.length === 0 && <SessionEmpty icon={BubbleChatIcon} title={`No messages from ${row.name} on this page yet`} />}
      {groups.map((g) => {
        const n = g.rows.length;
        if (g.channel !== undefined) {
          const channel = g.channel;
          const href = formatRoute({ view: "channel", channel });
          return (
            <section key={g.key} className="ox-msg-group">
              <Marker className="ox-marker">
                <MarkerIcon><Icon icon={HashtagIcon} size={16} /></MarkerIcon>
                <MarkerContent><b>{`#${channel}`}</b>{` · ${n === 1 ? "1 post" : `${n} posts`}`}</MarkerContent>
              </Marker>
              {g.rows.map((msg) => <Row key={msg.id} msg={msg} row={row} place={`in #${channel}`} href={href} label={`Open in #${channel}`} />)}
            </section>
          );
        }
        const to = g.to ?? "";
        const name = nameOf(to);
        const href = formatRoute({ view: "dm", peer: row.id, with: to });
        return (
          <section key={g.key} className="ox-msg-group">
            <Marker className="ox-marker">
              <MarkerIcon><Icon icon={BubbleChatIcon} size={16} /></MarkerIcon>
              <MarkerContent><b>Direct messages</b>{` · ${n} with ${name}`}</MarkerContent>
            </Marker>
            {g.rows.map((msg) => <Row key={msg.id} msg={msg} row={row} place={`to ${name}`} href={href} label="Open conversation" />)}
          </section>
        );
      })}
      <p className="ox-msgs-more">Older messages are in each channel's history.</p>
    </div>
  );
}
