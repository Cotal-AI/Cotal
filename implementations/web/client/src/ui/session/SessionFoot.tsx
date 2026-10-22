import { Icon } from "../../icons/Icon.tsx";
import { statusLabel, type RosterRow } from "../../lib/roster.js";
import { STATUS_ICON } from "../Status.tsx";
import { hhmm } from "../../lib/time.js";
import { useXfade } from "./xfade.js";

/** The footer under an agent's work (mock C and G, `ox-foot`), from presence and nothing else: the
 *  status shape, which never turns here, "<name> is <status>", and after it, dim:
 *  - working: the activity and when it was reported;
 *  - waiting: the same in the gold ink, never who or what it waits for;
 *  - idle: "No current activity.";
 *  - offline: when its last heartbeat came.
 *  The panel (`compact`) drops the activity. When presence changes the status the footer cross-fades,
 *  keyed by the status. */
export function SessionFoot({ row, compact = false }: { row: RosterRow; compact?: boolean }) {
  const icon = Object.hasOwn(STATUS_ICON, row.status) ? STATUS_ICON[row.status] : undefined;
  const status = statusLabel(row);
  const fade = useXfade(row.status);
  const activity = compact ? undefined : row.activity || undefined;
  let said: string | undefined;
  if (row.status === "working" || row.status === "waiting") {
    const reported = hhmm(row.statusSince);
    said = [activity && `${activity}.`, reported && `Reported ${reported}.`].filter(Boolean).join(" ") || undefined;
  } else if (row.status === "offline") {
    const beat = hhmm(row.ts);
    said = beat && `Last heartbeat ${beat}.`;
  } else if (row.status === "idle") {
    said = "No current activity.";
  }
  return (
    <div key={row.status} className={fade ? `ox-foot ${fade}` : "ox-foot"}>
      <span className={`v3-spill v3-s-${row.status}`}>{icon && <Icon icon={icon} size={16} className="ui-ic" />}</span>
      <b>{row.name}</b>
      {` is ${status} `}
      {said && <span className={row.status === "waiting" ? "ox-foot-wait" : undefined}>{said}</span>}
    </div>
  );
}
