import { useState, type ReactNode } from "react";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "../shadcn/tooltip.tsx";

/** A failed call's line with the tooltip that says what the connector does not publish (mock C). It
 *  loads on its own, the first time a failed call is drawn, so Radix's tooltip stays out of the
 *  first load.
 *
 *  The line is a button, so the words open on keyboard focus and on hover, and a tap or a click
 *  toggles them, which a phone has no other way to do: Radix would close a tooltip on a click, so the
 *  click handler stops that. Escape or a tap elsewhere closes them. */
export default function FailedTip({ line, words }: { line: ReactNode; words: string }) {
  const [open, setOpen] = useState(false);
  return (
    <TooltipProvider>
      <Tooltip open={open} onOpenChange={setOpen}>
        <TooltipTrigger
          type="button"
          className="ox-tip"
          onClick={(e) => {
            e.preventDefault();
            setOpen(!open);
          }}
        >
          {line}
        </TooltipTrigger>
        <TooltipContent className="ox-tipc" sideOffset={4}>{words}</TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}
