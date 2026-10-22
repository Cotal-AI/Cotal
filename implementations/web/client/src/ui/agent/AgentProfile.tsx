import { ComputerTerminal01Icon, StopCircleIcon } from "@hugeicons/core-free-icons";
import { useEffect, useMemo, useReducer } from "react";
import { ageText } from "../../lib/age.js";
import { shellArg } from "../../lib/compose.js";
import { agentChannels } from "../../lib/members.js";
import { rosterRows } from "../../lib/roster.js";
import { clock as hhmm } from "../../lib/time.js";
import { useStore } from "../../state/hooks.js";
import type { Store } from "../../state/store.js";
import type { DashboardState } from "../../state/types.js";
import { AttentionMark } from "../Attention.tsx";
import { Avatar } from "../Avatar.tsx";
import { CopyCommand } from "../CopyCommand.tsx";
import { useBadgeOf } from "../identity.js";
import { harnessName } from "../MessageRow.tsx";
import { StatusWord } from "../Status.tsx";

/** The heartbeat's age redraws on this beat, so "2s ago" does not stand still between presence updates. */
const BEAT_MS = 1000;

/** What the Work events row says for each value of the card's `ai.cotal.events`. */
const WORK_EVENTS = { on: "Published. Tool names, status and times only.", off: "Not published" } as const;

/** The Profile tab of an agent's page (mock C "Every tab", `tpl-profile-logic`): the approved Agent
 *  tab at reading width.
 *
 *  - The character at 88px, beside the status line: the status word (through `statusLabel`), the
 *    activity or "No current activity", and "Reported <hh:mm>" from when the status began. With no
 *    `statusSince` no time is given.
 *  - The attach and stop commands for the reader to copy, with the name quoted for a shell when it
 *    needs it.
 *  - Model reads "not reported" when the card has none. Attention shows only Do not disturb or
 *    Focus. The heartbeat is labelled as a heartbeat and reads its age from `clock`, redrawn every
 *    second. Work events says whether the card publishes the event plane: published, not published,
 *    or not reported when the card does not say.
 *  - Channels are the agent's, decided as the Members tab decides them, with its quiet or muted
 *    modes. Skills are the card's.
 *  - An id the roster does not hold reads "Not on the roster". */
export function AgentProfile({ store, id, clock = Date.now }: { store: Store<DashboardState>; id: string; clock?: () => number }) {
  const roster = useStore(store, (s) => s.roster);
  const channels = useStore(store, (s) => s.channels);
  const membership = useStore(store, (s) => s.membership);
  const activity = useStore(store, (s) => s.activity);
  const [, redraw] = useReducer((n: number) => n + 1, 0);
  useEffect(() => {
    const t = setInterval(redraw, BEAT_MS);
    return () => clearInterval(t);
  }, []);
  const badgeOf = useBadgeOf();
  const entry = roster.find((p) => p.card.id === id);
  const mine = useMemo(
    () => (entry ? agentChannels(id, membership, channels.map((c) => c.channel), activity, entry.channelModes) : { channels: [], wide: false }),
    [entry, id, membership, channels, activity],
  );
  if (!entry) return <p className="ui-nr">Not on the roster</p>;

  const row = rosterRows([entry], { includeOffline: true })[0];
  const reported = typeof row.statusSince === "number" && Number.isFinite(row.statusSince) ? `Reported ${hhmm(new Date(row.statusSince))}` : undefined;
  const skills = (entry.card.skills ?? []).map((s) => s.name).filter((s) => typeof s === "string" && s !== "");
  return (
    <div className="ox-profile">
      <div className="ui-big"><Avatar vendor={row.harness} status={row.status} size={88} dot={false} badge={badgeOf(row.id)} /></div>
      <div>
        <div className="ui-sline">
          <StatusWord row={row} />
          <span style={{ color: "var(--ink)" }}>{row.activity || "No current activity"}</span>
          {reported && <small>{reported}</small>}
        </div>
        <div className="ui-actions">
          <CopyCommand icon={ComputerTerminal01Icon} command={`cotal attach --name ${shellArg(row.name)}`} />
          <CopyCommand icon={StopCircleIcon} command={`cotal stop --name ${shellArg(row.name)}`} />
        </div>
        <dl className="ui-kv">
          {row.harness && <><dt>Harness</dt><dd>{harnessName(row.harness)}</dd></>}
          <dt>Model</dt>
          {row.model ? <dd className="ui-mono" style={{ fontSize: 12.5 }}>{row.model}</dd> : <dd className="ui-nr">not reported</dd>}
          {row.host && <><dt>Host</dt><dd>{row.host}</dd></>}
          {(row.attention === "dnd" || row.attention === "focus") && <><dt>Attention</dt><dd><AttentionMark attention={row.attention} /></dd></>}
          <dt>Heartbeat</dt>
          {Number.isFinite(row.ts) ? <dd className="ui-num">{ageText(clock() - row.ts)} ago</dd> : <dd className="ui-nr">not reported</dd>}
          <dt>Work events</dt>
          {row.events ? <dd>{WORK_EVENTS[row.events]}</dd> : <dd className="ui-nr">not reported</dd>}
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
      </div>
    </div>
  );
}
