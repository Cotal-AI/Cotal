import { Badge } from "#client/ui/shadcn/badge.tsx";
import { Tooltip, TooltipContent, TooltipTrigger } from "#client/ui/shadcn/tooltip.tsx";
import type { Pill } from "../lib/membership.js";

/** What the pill says for each state, and the class that draws its dot's shape (mock `ui-mpill`). */
const STATE: Record<Pill, { word: string; cls: string; title?: string }> = {
  live: { word: "live", cls: "ui-mdot-live", title: "From broker membership, served by the delivery daemon" },
  stale: { word: "stale", cls: "ui-mdot-stale", title: "The daemon's last report is older than 45 seconds, or has no time on it" },
  "traffic-only": { word: "traffic-only", cls: "ui-mdot-traffic", title: "No delivery daemon on an open mesh, so members come from who has posted" },
  unreadable: { word: "unreadable", cls: "ui-mdot-unread" },
};

/** The membership feed's state as a Badge with its dot: "Membership: live", "stale", "traffic-only"
 *  or "unreadable", the last one destructive. The words are `pillState`'s four states and
 *  docs/mesh-view.md quotes them. The note is its Tooltip and its screen reader text, and an unreadable
 *  pill's carries `reason`, the failure the read reported. */
export function MembershipPill({ state, reason }: { state: Pill; reason?: string }) {
  const s = STATE[state];
  const title = state === "unreadable" ? (reason ? `the read failed: ${reason}` : "the read failed") : s.title;
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Badge variant={state === "unreadable" ? "destructive" : "outline"}>
          <i className={`ui-mdot ${s.cls}`} />Membership: {s.word}<span className="ui-sr">{` ${title}`}</span>
        </Badge>
      </TooltipTrigger>
      <TooltipContent>{title}</TooltipContent>
    </Tooltip>
  );
}
