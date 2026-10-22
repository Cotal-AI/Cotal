import { CancelCircleIcon, Wrench01Icon } from "@hugeicons/core-free-icons";
import type { IconSvgElement } from "@hugeicons/react";
import { Icon } from "../../icons/Icon.tsx";
import type { Status } from "../../lib/roster.js";
import { callState, groupDescription, groupTitle, type ToolCall, type ToolKind, type Turn } from "../../lib/session.js";
import { Trace, TraceCollapsible, TraceCollapsibleContent, TraceCollapsibleTrigger, TraceDescription, TraceIcon, TraceLine, TraceTitle } from "../shadcn/trace.tsx";
import { kindIcon, ToolLine } from "./ToolLine.tsx";

/** Where a run of calls sits, for `callState`: its turn (none when loose), whether it is the trailing
 *  work, and what presence says the agent is doing. */
export interface CallAt { turn?: Turn; trailing: boolean; status: Status }

/** The group's icon: its most frequent kind's, and the wrench on a tie. A connector that reports no
 *  tool status gets the wrench, as its title names tools rather than kinds. */
function groupIcon(calls: readonly ToolCall[], toolStatus: boolean): IconSvgElement {
  if (!toolStatus) return Wrench01Icon;
  const counts = new Map<ToolKind, number>();
  for (const c of calls) counts.set(c.kind, (counts.get(c.kind) ?? 0) + 1);
  const top = Math.max(...counts.values());
  const leaders = [...counts].filter(([, n]) => n === top);
  return leaders.length === 1 ? kindIcon(leaders[0]![0]) : Wrench01Icon;
}

/** Two or more finished calls with nothing between them (mock B1 and C, a nested `sh-coll`): closed by
 *  default, its title the counts of calls per kind (`groupTitle`), with ", " and the cross and
 *  "<n> failed" in the destructive ink when any failed, and its description the step count and span
 *  (`groupDescription`). Open, it holds a Trace of each call's `ToolLine`. A closed group mounts none
 *  of them. */
export function ToolGroup({ calls, at, toolStatus, className }: { calls: readonly ToolCall[]; at: CallAt; toolStatus: boolean; className?: string }) {
  const { title, failed } = groupTitle(calls, toolStatus);
  return (
    <TraceCollapsible className={className}>
      <TraceCollapsibleTrigger className="ox-trig">
        <TraceLine className="ox-line">
          <TraceIcon><Icon icon={groupIcon(calls, toolStatus)} size={16} /></TraceIcon>
          <TraceTitle>
            {title}
            {failed > 0 && (
              <>
                {", "}
                <span className="ox-fail"><Icon icon={CancelCircleIcon} size={16} />{`${failed} failed`}</span>
              </>
            )}
          </TraceTitle>
          {" "}
          <TraceDescription>{groupDescription(calls, toolStatus)}</TraceDescription>
        </TraceLine>
      </TraceCollapsibleTrigger>
      <TraceCollapsibleContent className="ox-cc">
        <Trace className="ox-calls">
          {calls.map((c) => <ToolLine key={c.key} call={c} state={callState(c, { ...at, toolStatus })} />)}
        </Trace>
      </TraceCollapsibleContent>
    </TraceCollapsible>
  );
}
