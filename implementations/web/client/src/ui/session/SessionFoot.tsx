import type { ReactNode } from "react";
import { Icon } from "../../icons/Icon.tsx";
import { statusLabel, type RosterRow } from "../../lib/roster.js";
import { STATUS_ICON } from "../Status.tsx";
import { hhmm } from "./Time.tsx";

/** The live footer under a session (mock S and C, `ui-sess-foot`), from presence and nothing else:
 *  the status shape, "<name> is <status>", and
 *  - working: the moving dots unless progress is unknown (as ChannelView's working line), then the
 *    activity;
 *  - waiting: what the agent reported and when, in the gold ink, never who or what it waits for;
 *  - offline: when its last heartbeat came.
 *  The panel (`compact`) drops the activity. */
export function SessionFoot({ row, compact = false }: { row: RosterRow; compact?: boolean }) {
  const icon = Object.hasOwn(STATUS_ICON, row.status) ? STATUS_ICON[row.status] : undefined;
  const status = statusLabel(row);
  const activity = compact ? undefined : row.activity || undefined;
  let tail: ReactNode;
  if (row.status === "working") {
    tail = (
      <>
        {` is ${status} `}
        {row.progress?.kind !== "unknown" && <span className="ui-dots"><i /><i /><i /></span>}
        {activity && <span>{activity}</span>}
      </>
    );
  } else if (row.status === "waiting") {
    const reported = hhmm(row.statusSince);
    const said = [activity && `${activity}.`, reported && `Reported ${reported}.`].filter(Boolean).join(" ");
    tail = <>{` is ${status} `}{said && <span style={{ color: "var(--gold-ink)" }}>{said}</span>}</>;
  } else if (row.status === "offline") {
    const beat = hhmm(row.ts);
    tail = beat ? ` is ${status}. Last heartbeat ${beat}.` : ` is ${status}.`;
  } else {
    tail = ` is ${status}`;
  }
  return (
    <div className="ui-sess-foot">
      <span className={`v3-spill v3-s-${row.status}`}>{icon && <Icon icon={icon} size={16} className="ui-ic" />}</span>
      <b>{row.name}</b>
      {tail}
    </div>
  );
}
