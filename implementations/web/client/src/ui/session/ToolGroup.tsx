import { ArrowRight01Icon, Wrench01Icon } from "@hugeicons/core-free-icons";
import { useState } from "react";
import { Icon } from "../../icons/Icon.tsx";
import { toolGroupLabel, type ToolCall } from "../../lib/session.js";
import { CallRow } from "./ToolRow.tsx";
import { useXfade } from "./xfade.js";

/** A run of two or more tool calls with no text between (mock S, `ui-tg`): quiet, collapsed by
 *  default, and open on a click. The label and the names slot are `toolGroupLabel`'s; the panel
 *  (`compact`) drops the names slot. When a call joins, the label and the names cross-fade in place,
 *  keyed by their text. */
export function ToolGroup({ calls, compact = false }: { calls: readonly ToolCall[]; compact?: boolean }) {
  const [open, setOpen] = useState(false);
  const { label, names } = toolGroupLabel(calls);
  const fadeLabel = useXfade(label);
  const fadeNames = useXfade(names);
  return (
    <div className="ui-tg" data-open={open ? "" : undefined}>
      <button type="button" aria-expanded={open} onClick={() => setOpen(!open)}>
        <Icon icon={Wrench01Icon} size={16} className="ui-ic" />
        <span key={label} className={fadeLabel}>{label}</span>
        {!compact && <span key={names} className={fadeNames ? `ui-tg-names ${fadeNames}` : "ui-tg-names"}>{names}</span>}
        <Icon icon={ArrowRight01Icon} size={16} className="ui-ic ui-tg-chev" />
      </button>
      {open && (
        <div className="ui-tg-list">
          {/* Calls only ever append to a group, so a call's place in it is a stable key. */}
          {calls.map((call, i) => <CallRow key={i} call={call} />)}
        </div>
      )}
    </div>
  );
}
