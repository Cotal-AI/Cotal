import { ArrowRight01Icon, Brain02Icon } from "@hugeicons/core-free-icons";
import { useState } from "react";
import { Icon } from "../../icons/Icon.tsx";
import { withCut } from "./SaidBlock.tsx";

/** Reasoning, if a frame ever carries it (mock C, `ui-think`): full view only, collapsed by default,
 *  and when opened shown dim as plain text, never mixed into the prose. */
export function Reasoning({ text, cut }: { text: string; cut: boolean }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="ui-tg ui-think" data-open={open ? "" : undefined}>
      <button type="button" aria-expanded={open} onClick={() => setOpen(!open)}>
        <Icon icon={Brain02Icon} size={16} className="ui-ic" />
        <span>Reasoning</span>
        <Icon icon={ArrowRight01Icon} size={16} className="ui-ic ui-tg-chev" />
      </button>
      {open && <div className="ui-think-body">{withCut(text, cut)}</div>}
    </div>
  );
}
