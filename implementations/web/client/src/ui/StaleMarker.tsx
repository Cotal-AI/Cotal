import { Alert02Icon } from "@hugeicons/core-free-icons";
import { Icon } from "../icons/Icon.tsx";
import { staleView } from "../lib/shellText.js";
import { useStore } from "../state/hooks.js";
import type { Store } from "../state/store.js";
import type { DashboardState } from "../state/types.js";

/** The stale marker under the sidebar head (mock section B): which sources are showing their last
 *  good value (`stale: peers, activity`, `partial: activity`), with each source's reason in the
 *  tooltip. Recovery clears it rather than hiding old text: label and tooltip both come from
 *  `staleView`, which empties them when nothing is stale. The sidebar's copy is `#stale`; a second
 *  copy (the Activity header's) passes `id={null}`, so the page keeps one element with that id. */
export function StaleMarker({ store, id = "stale" }: { store: Store<DashboardState>; id?: string | null }) {
  const stale = useStore(store, (s) => s.stale);
  const view = staleView(stale);
  return (
    <div className="ui-stale" id={id ?? undefined} hidden={view.hidden} title={view.title}>
      <Icon icon={Alert02Icon} size={16} className="ui-ic" />
      <div><b>{view.text}</b></div>
    </div>
  );
}
