import type { Pill } from "../lib/membership.js";

/** What the pill says for each state, and the class that draws its dot (mock `ui-mpill`). */
const STATE: Record<Pill, { word: string; cls: string; title?: string }> = {
  live: { word: "live", cls: "ui-mpill-live", title: "From broker membership, served by the delivery daemon" },
  stale: { word: "stale", cls: "ui-mpill-stale", title: "The daemon's last report is older than 45 seconds, or has no time on it" },
  "traffic-only": { word: "traffic-only", cls: "ui-mpill-traffic", title: "No delivery daemon on an open mesh, so members come from who has posted" },
  unreadable: { word: "unreadable", cls: "ui-mpill-unread" },
};

/** The membership feed's state as a pill: "Membership: live", "stale", "traffic-only" or
 *  "unreadable". The words are `pillState`'s four states and docs/mesh-view.md quotes them. An
 *  unreadable pill's tooltip carries `reason`, the failure the read reported. */
export function MembershipPill({ state, reason }: { state: Pill; reason?: string }) {
  const s = STATE[state];
  const title = state === "unreadable" ? (reason ? `the read failed: ${reason}` : "the read failed") : s.title;
  return (
    <span className={`ui-mpill ${s.cls}`} title={title}>
      <i />Membership: {s.word}
    </span>
  );
}
