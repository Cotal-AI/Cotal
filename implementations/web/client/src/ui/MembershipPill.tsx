import type { Pill } from "../lib/membership.js";

/** What the pill says for each state, and the class that draws its dot (mock `ui-mpill`). */
const STATE: Record<Pill, { word: string; cls: string; title?: string }> = {
  live: { word: "live", cls: "ui-mpill-live", title: "From broker membership, served by the delivery daemon" },
  stale: { word: "stale", cls: "ui-mpill-stale" },
  "traffic-only": { word: "traffic-only", cls: "ui-mpill-traffic", title: "No delivery daemon on an open mesh, so members come from who has posted" },
  unreadable: { word: "unreadable", cls: "ui-mpill-unread" },
};

/** The membership feed's state as a pill: "Membership: live", "stale", "traffic-only" or
 *  "unreadable". The words are `pillState`'s four states and docs/mesh-view.md quotes them. */
export function MembershipPill({ state }: { state: Pill }) {
  const s = STATE[state];
  return (
    <span className={`ui-mpill ${s.cls}`} title={s.title}>
      <i />Membership: {s.word}
    </span>
  );
}
