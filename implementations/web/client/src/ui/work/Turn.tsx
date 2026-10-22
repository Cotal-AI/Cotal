import { AlertCircleIcon, CancelCircleIcon, HourglassIcon, Tick02Icon, UnavailableIcon } from "@hugeicons/core-free-icons";
import { useContext, useState } from "react";
import { Icon } from "../../icons/Icon.tsx";
import type { RosterRow } from "../../lib/roster.js";
import { turnDescription, turnTitle, type Turn as WorkTurn } from "../../lib/session.js";
import type { RunErrorCondition } from "../session/RunError.tsx";
import { Spinner } from "../shadcn/spinner.tsx";
import { Trace, TraceCollapsible, TraceCollapsibleContent, TraceCollapsibleTrigger, TraceDescription, TraceIcon, TraceLine, TraceTitle } from "../shadcn/trace.tsx";
import { Rise, Step } from "./Step.tsx";
import { useNow } from "./useNow.ts";

/** A turn's line: its icon, its title and its description. It holds the turn's clock, so while the
 *  title counts ("Working for", "Open for") only this line redraws each second, not the steps. */
function TurnHead({ turn, row, compact }: { turn: WorkTurn; row: RosterRow; compact: boolean }) {
  const current = turn.outcome === "open" && !turn.superseded;
  const live = current && row.status === "working";
  const now = useNow(current && (row.status === "working" || row.status === "waiting"));
  const { title, failed } = turnTitle(turn, row.status, now);
  const description = compact ? "" : turnDescription(turn);
  const icon = live ? <Spinner className="ox-live" />
    : <Icon icon={turn.outcome === "finished" ? Tick02Icon : turn.outcome === "failed" ? AlertCircleIcon : current && row.status === "waiting" ? HourglassIcon : UnavailableIcon} size={16} />;
  return (
    <TraceLine status={turn.outcome === "failed" ? "error" : undefined} className="ox-line">
      <TraceIcon>{icon}</TraceIcon>
      <TraceTitle>
        {live ? <b>{title}</b> : title}
        {failed !== undefined && (
          <>
            {", "}
            <span className="ox-fail"><Icon icon={CancelCircleIcon} size={16} />{failed}</span>
          </>
        )}
      </TraceTitle>
      {" "}
      {description && <TraceDescription>{description}</TraceDescription>}
    </TraceLine>
  );
}

/** One turn (mock B1 `tpl-turn1` to `tpl-turn3`, C "Idle" and "A run error"): a collapsible whose
 *  trigger is the turn's line and whose content is its steps.
 *
 *  - The icon says how it went: the green spinner while it is open and presence says working (the
 *    only turn icon that turns), the hourglass while it is open and the agent waits, the tick once it
 *    finished, the alert in the destructive ink when it failed, and the struck circle when no end
 *    arrived.
 *  - The title is `turnTitle`'s, bold while the turn is live, then ", ", the cross and the failed
 *    calls in the destructive ink when any failed. It never shimmers. While it counts ("Working for",
 *    "Open for") it redraws every second.
 *  - The description is `turnDescription`'s. The panel (`compact`) leaves it out, and draws no
 *    prompt and no reasoning.
 *  - `defaultOpen` opens it until the reader opens or closes it. Closed, it mounts none of its steps,
 *    so a collapsed turn never loads Shiki.
 *  - `condition` is presence's condition, for a run error that is the list's last item. */
export function Turn({ turn, row, toolStatus, defaultOpen, highlight, condition, compact = false, nameOf }: {
  turn: WorkTurn;
  row: RosterRow;
  toolStatus: boolean;
  defaultOpen: boolean;
  highlight?: string;
  condition?: RunErrorCondition;
  compact?: boolean;
  nameOf: (id: string) => string;
}) {
  const rises = useContext(Rise);
  const [chosen, setChosen] = useState<boolean | undefined>(undefined);
  const open = chosen ?? defaultOpen;
  const ctx = { row, toolStatus, compact, nameOf, ...(highlight === undefined ? {} : { highlight }) };
  const last = turn.steps.at(-1);
  // A failed turn's run error closes it rather than following its work, so the calls before it are
  // still the trailing work: they read "No result arrived", never "Called".
  const work = turn.steps.findLast((s) => s.kind !== "runError");
  const shown = compact ? turn.steps.filter((s) => s.kind !== "prompt" && s.kind !== "reasoning") : turn.steps;
  return (
    <TraceCollapsible open={open} onOpenChange={setChosen}>
      <TraceCollapsibleTrigger className="ox-trig">
        <TurnHead turn={turn} row={row} compact={compact} />
      </TraceCollapsibleTrigger>
      <TraceCollapsibleContent className="ox-cc">
        <Trace className="ox-turn">
          {shown.map((s) => (
            <div key={s.key} className={rises(s) ? "ox-step ui-in" : "ox-step"}>
              <Step step={s} turn={turn} trailing={s === work} ctx={ctx} condition={s === last ? condition : undefined} />
            </div>
          ))}
        </Trace>
      </TraceCollapsibleContent>
    </TraceCollapsible>
  );
}
