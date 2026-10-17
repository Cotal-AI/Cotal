import { ArrowUpRight01Icon, ComputerTerminal01Icon, Message01Icon, StopCircleIcon } from "@hugeicons/core-free-icons";
import { useEffect, useMemo, useReducer } from "react";
import { Icon } from "../../icons/Icon.tsx";
import { ageText } from "../../lib/age.js";
import { messageRoute, shellArg } from "../../lib/compose.js";
import { agentChannels } from "../../lib/members.js";
import { partsToText } from "../../lib/parts.js";
import { rosterRows } from "../../lib/roster.js";
import { formatRoute, type Route } from "../../lib/route.js";
import type { Controller } from "../../state/controller.js";
import { useStore } from "../../state/hooks.js";
import type { Store } from "../../state/store.js";
import type { DashboardState } from "../../state/types.js";
import { AttentionMark } from "../Attention.tsx";
import { Avatar } from "../Avatar.tsx";
import { useBadgeOf } from "../identity.js";
import { focusComposer } from "../Composer.tsx";
import { CopyCommand } from "../CopyCommand.tsx";
import { clock as hhmm, harnessName, UNVERIFIED } from "../MessageRow.tsx";
import { StatusWord } from "../Status.tsx";
import { useSession } from "../views/SessionView.tsx";
import { SessionPreview } from "./SessionPreview.tsx";

/** How many of the agent's own messages in the open channel the tab lists, newest first. */
const RECENT = 3;
/** A recent message's text is cut to this many characters; the channel has the whole of it. */
const SNIPPET = 160;

/** The heartbeat's age redraws on this beat, so "2s ago" does not stand still between presence updates. */
const BEAT_MS = 1000;

/** The Agent tab (mock section D, the panel's second frame, and the agent states in section B): who
 *  the agent is, what it says it is doing, and the commands to reach its seat.
 *
 *  - The character at 72px, the name, and role · harness.
 *  - The status line: the status word (through `statusLabel`), the activity or "No current
 *    activity", and "Reported <hh:mm>" from when the status began. With no `statusSince` no time
 *    is given.
 *  - Message opens the operator's conversation with the agent, with its composer focused. Open
 *    session goes to the agent's session at `#/agent/<id>`. The attach and stop commands are for the
 *    reader to copy, with the name quoted for a shell when it needs it. Tab reaches them in that
 *    order, then the session's tool groups.
 *  - Under the profile, the Session section (agents mock S3): the last few steps, live. The tab
 *    keeps the agent's session open whatever the route; the section is left out while the centre
 *    shows this agent's session (`route`), which already has the steps.
 *  - Model reads "not reported" when the card has none. Attention shows only Do not disturb or
 *    Focus. The heartbeat is labelled as a heartbeat and reads its age from `now`, redrawn every second.
 *  - Channels are the agent's, decided as the Members tab decides them, with its quiet or muted
 *    modes. Skills are the card's. Recent lists its own messages in the open channel; one read from
 *    history carries the unverified mark, since history does not record who sent it.
 *  - An id the roster does not hold reads "Not on the roster". */
export function AgentTab({ store, controller = null, id, channel, route, clock }: {
  store: Store<DashboardState>;
  /** Opens and closes the session the Session section shows. Null before the dashboard has started. */
  controller?: Controller | null;
  id: string;
  /** The channel the route has open, whose messages Recent lists. */
  channel: string | null;
  /** The centre's route. On this agent's own session the Session section is left out. */
  route?: Route;
  clock: () => number;
}) {
  const roster = useStore(store, (s) => s.roster);
  const channels = useStore(store, (s) => s.channels);
  const membership = useStore(store, (s) => s.membership);
  const activity = useStore(store, (s) => s.activity);
  const open = useStore(store, (s) => s.open);
  const self = useStore(store, (s) => s.operatorId);
  const [, redraw] = useReducer((n: number) => n + 1, 0);
  useEffect(() => {
    const t = setInterval(redraw, BEAT_MS);
    return () => clearInterval(t);
  }, []);
  const entry = roster.find((p) => p.card.id === id);
  const plane = useMemo(() => (entry ? rosterRows([entry], { includeOffline: true })[0].events : undefined), [entry]);
  // The tab holds the agent's session open, not the Session section, and it does so on every route.
  // Opening the agent's session in the centre hides the section but keeps this view, so the session
  // is never closed and opened again between the panel and the full view. A plane the card says is
  // off publishes nothing to watch, so no session is opened for it.
  useSession(entry && plane !== "off" ? controller : null, id);
  const badgeOf = useBadgeOf();
  const mine = useMemo(
    () => (entry ? agentChannels(id, membership, channels.map((c) => c.channel), activity, entry.channelModes) : { channels: [], wide: false }),
    [entry, id, membership, channels, activity],
  );
  if (!entry) return <p className="ui-nr">Not on the roster</p>;

  const row = rosterRows([entry], { includeOffline: true })[0];
  const sub = [row.role, row.harness && harnessName(row.harness)].filter(Boolean).join(" · ");
  const reported = typeof row.statusSince === "number" && Number.isFinite(row.statusSince) ? `Reported ${hhmm(new Date(row.statusSince))}` : undefined;
  const skills = (entry.card.skills ?? []).map((s) => s.name).filter((s) => typeof s === "string" && s !== "");
  const recent = open !== null && open.channel === channel
    ? open.messages.filter((m) => m.senderId === id || (m.senderId === undefined && m.msg.from?.id === id)).slice(-RECENT).reverse()
    : [];
  return (
    <>
      <div className="ui-profile">
        <div className="ui-big"><Avatar vendor={row.harness} status={row.status} size={72} dot={false} badge={badgeOf(row.id)} /></div>
        <h4>{row.name}</h4>
        {sub && <div className="ui-sub">{sub}</div>}
        <div className="ui-sline">
          <StatusWord row={row} />
          <span style={{ color: "var(--ink)" }}>{row.activity || "No current activity"}</span>
          {reported && <small>{reported}</small>}
        </div>
        <div className="ui-actions">
          <a className="ui-btn ui-btn-primary" href={formatRoute(messageRoute(row.id, self))} onClick={() => focusComposer({ kind: "dm", to: row.id })}>
            <Icon icon={Message01Icon} size={16} className="ui-ic ui-ic16" />
            Message
          </a>
          <a className="ui-btn" href={formatRoute({ view: "agent", id: row.id })}>
            <Icon icon={ArrowUpRight01Icon} size={16} className="ui-ic ui-ic16" />
            Open session
          </a>
          <CopyCommand icon={ComputerTerminal01Icon} command={`cotal attach --name ${shellArg(row.name)}`} />
          <CopyCommand icon={StopCircleIcon} command={`cotal stop --name ${shellArg(row.name)}`} />
        </div>
      </div>
      {!(route?.view === "agent" && route.id === id) && <SessionPreview store={store} id={id} />}
      <dl className="ui-kv">
        {row.harness && <><dt>Harness</dt><dd>{harnessName(row.harness)}</dd></>}
        <dt>Model</dt>
        {row.model ? <dd className="ui-mono" style={{ fontSize: 12.5 }}>{row.model}</dd> : <dd className="ui-nr">not reported</dd>}
        {row.host && <><dt>Host</dt><dd>{row.host}</dd></>}
        {(row.attention === "dnd" || row.attention === "focus") && <><dt>Attention</dt><dd><AttentionMark attention={row.attention} /></dd></>}
        <dt>Heartbeat</dt>
        {Number.isFinite(row.ts) ? <dd className="ui-num">{ageText(clock() - row.ts)} ago</dd> : <dd className="ui-nr">not reported</dd>}
      </dl>
      {(mine.wide || mine.channels.length > 0) && (
        <>
          <h5>Channels</h5>
          {mine.wide && <div className="ui-chrow"><span>Reads every channel</span><span /></div>}
          {mine.channels.map((c) => (
            <div key={c.channel} className="ui-chrow"><span>{`#${c.channel}`}</span><span>{c.mode ?? ""}</span></div>
          ))}
        </>
      )}
      {skills.length > 0 && (
        <>
          <h5 style={{ marginTop: 10 }}>Skills</h5>
          <div className="ui-tags">{skills.map((s) => <span key={s} className="ui-chip">{s}</span>)}</div>
        </>
      )}
      {recent.length > 0 && (
        <>
          <h5>Recent</h5>
          {recent.map(({ msg, senderId }) => {
            const text = partsToText(msg.parts);
            const at = Number.isFinite(msg.ts) ? new Date(msg.ts) : undefined;
            return (
              <div key={`${msg.id}\u0001${senderId ?? ""}`} className="ui-mini">
                {at && <time dateTime={at.toISOString()}>{hhmm(at)}</time>}
                {text.length > SNIPPET ? `${text.slice(0, SNIPPET)}…` : text}
                {senderId === undefined && <>{" "}<span className="ui-unverified" title={UNVERIFIED}>unverified</span></>}
              </div>
            );
          })}
        </>
      )}
    </>
  );
}
