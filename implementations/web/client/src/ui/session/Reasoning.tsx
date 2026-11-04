import { Brain02Icon } from "@hugeicons/core-free-icons";
import { Icon } from "../../icons/Icon.tsx";
import { TraceCollapsible, TraceCollapsibleContent, TraceCollapsibleTrigger, TraceIcon, TraceLine, TraceTitle } from "../shadcn/trace.tsx";
import { withCut } from "./SaidBlock.tsx";

/** Reasoning, if a frame ever carries it (mock C): full view only, closed by default, and when opened
 *  shown dim as plain text, never mixed into the prose. */
export function Reasoning({ text, cut }: { text: string; cut: boolean }) {
  return (
    <TraceCollapsible>
      <TraceCollapsibleTrigger className="ox-trig">
        <TraceLine className="ox-line">
          <TraceIcon><Icon icon={Brain02Icon} size={16} /></TraceIcon>
          <TraceTitle>Reasoning</TraceTitle>
        </TraceLine>
      </TraceCollapsibleTrigger>
      <TraceCollapsibleContent className="ox-cc">
        <div className="ox-think">{withCut(text, cut)}</div>
      </TraceCollapsibleContent>
    </TraceCollapsible>
  );
}
