import { ArrowUpRight01Icon } from "@hugeicons/core-free-icons";
import { useContext } from "react";
import { Icon } from "../icons/Icon.tsx";
import { statusLabel, type RosterRow } from "../lib/roster.js";
import { formatRoute } from "../lib/route.js";
import { Avatar } from "./Avatar.tsx";
import { useBadgeOf } from "./identity.js";
import { Marker, MarkerContent } from "./shadcn/marker.tsx";
import { SheetMenu } from "./sheet.js";

/** How many working agents the line names before "and <n> more". */
export const WORKING_SHOWN = 3;

/** Who is working, under a channel's or a conversation's messages (overhaul mock W, `tpl-typing-new`):
 *  one shadcn Marker per working agent in `rows`, at most three, then "and <n> more". Each says the
 *  character at 18px with no dot, the name, "is <statusLabel>", the activity presence reports,
 *  shimmering (`ox-shimmer`, plain under reduced motion), and View work, which goes to the agent's
 *  Work. On a phone (`SheetMenu`) the link reads View. Names, statuses and activity are the roster's,
 *  drawn as text. With nobody working nothing is drawn. The block is a polite live region. */
export function WorkingLine({ rows }: { rows: readonly RosterRow[] }) {
  const badgeOf = useBadgeOf();
  const phone = useContext(SheetMenu) !== null;
  if (rows.length === 0) return null;
  const more = rows.length - WORKING_SHOWN;
  return (
    <div className="ox-typing" role="status" aria-live="polite">
      {rows.slice(0, WORKING_SHOWN).map((r) => (
        <Marker key={r.id} className="ox-wline">
          <Avatar vendor={r.harness} status={r.status} size={18} dot={false} badge={badgeOf(r.id)} />
          <MarkerContent className="ox-wline-c">
            <b>{r.name}</b>
            {` is ${statusLabel(r)}`}
            {r.activity && <>{" "}<span className="ox-shimmer">{r.activity}</span></>}
          </MarkerContent>
          <a className="ox-act" href={formatRoute({ view: "agent", id: r.id, tab: "work" })}>
            {phone ? "View" : <>View work<Icon icon={ArrowUpRight01Icon} size={16} /></>}
          </a>
        </Marker>
      ))}
      {more > 0 && <div className="ox-wmore">{`and ${more} more`}</div>}
    </div>
  );
}
