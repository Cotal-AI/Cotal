import { Alert02Icon } from "@hugeicons/core-free-icons";
import { Icon } from "../icons/Icon.tsx";
import { Alert, AlertDescription, AlertTitle } from "#client/ui/shadcn/alert.tsx";
import { Tooltip, TooltipContent, TooltipTrigger } from "#client/ui/shadcn/tooltip.tsx";
import { staleLines, staleView } from "../lib/shellText.js";
import { useStore } from "../state/hooks.js";
import type { Store } from "../state/store.js";
import type { DashboardState } from "../state/types.js";

/** The stale marker under the sidebar head (mock section B): which sources are showing their last
 *  good value (`stale: peers, activity`, `partial: activity`), with each source's reason in the
 *  Tooltip, a line each, and in screen reader text. Recovery clears it rather than hiding old text:
 *  label and tooltip both come from `staleView`, and with nothing stale no marker is drawn. Under the
 *  label sit the plain sentences `staleLines` writes, one per kind of mark ("Showing what we last
 *  read at 10:51. Retrying."). The sidebar's copy is `#stale`. A second copy in the Activity header
 *  (`inHeader`) has no id, so the page keeps one element with that id, and draws the label only,
 *  as the header bar has room for. The marker states a standing condition, so it is a note that
 *  screen readers do not announce as it changes. */
export function StaleMarker({ store, inHeader = false }: { store: Store<DashboardState>; inHeader?: boolean }) {
  const stale = useStore(store, (s) => s.stale);
  const view = staleView(stale);
  if (view.hidden) return null;
  const lines = inHeader ? [] : staleLines(stale);
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Alert role="note" id={inHeader ? undefined : "stale"} className={inHeader ? "w-auto" : "mx-2 my-1 w-auto"}>
          <Icon icon={Alert02Icon} />
          <AlertTitle>{view.text}</AlertTitle>
          {lines.length > 0 && <AlertDescription>{lines.map((line) => <div key={line}>{line}</div>)}</AlertDescription>}
          {view.title && <div className="ui-sr">{view.title}</div>}
        </Alert>
      </TooltipTrigger>
      {view.title && (
        <TooltipContent className="flex-col items-start">
          {view.title.split("\n").map((line) => <span key={line}>{line}</span>)}
        </TooltipContent>
      )}
    </Tooltip>
  );
}
