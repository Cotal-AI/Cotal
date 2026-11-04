import { Alert02Icon } from "@hugeicons/core-free-icons";
import { Icon } from "../icons/Icon.tsx";
import { staleLines, staleView } from "../lib/shellText.js";
import { useStore } from "../state/hooks.js";
import type { Store } from "../state/store.js";
import type { DashboardState } from "../state/types.js";

/** The stale marker under the sidebar head (mock section B): which sources are showing their last
 *  good value (`stale: peers, activity`, `partial: activity`), with each source's reason in the
 *  tooltip. Recovery clears it rather than hiding old text: label and tooltip both come from
 *  `staleView`, which empties them when nothing is stale. Under the label sit the plain sentences
 *  `staleLines` writes, one per kind of mark ("Showing what we last read at 10:51. Retrying."). The
 *  sidebar's copy is `#stale`; a second copy (the Activity header's) passes `id={null}`, so the page
 *  keeps one element with that id. The header bar has room for the label only, so the stylesheet hides the
 *  sentences there. */
export function StaleMarker({ store, id = "stale" }: { store: Store<DashboardState>; id?: string | null }) {
  const stale = useStore(store, (s) => s.stale);
  const view = staleView(stale);
  return (
    <div className="ui-stale" id={id ?? undefined} hidden={view.hidden} title={view.title}>
      <Icon icon={Alert02Icon} size={16} className="ui-ic" />
      <div><b>{view.text}</b>{staleLines(stale).map((line) => <span key={line}>{line}</span>)}</div>
    </div>
  );
}
