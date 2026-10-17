import { InformationCircleIcon } from "@hugeicons/core-free-icons";
import { Icon } from "../../icons/Icon.tsx";
import { Time } from "./Time.tsx";

/** An event the fold does not know, as a named marker and never skipped: its label as text and its
 *  time, drawn as quietly as a tool row. */
export function UnknownStep({ label, ts }: { label: string; ts?: number }) {
  return (
    <div className="ui-tc ui-tc-line">
      <Icon icon={InformationCircleIcon} size={16} className="ui-ic" />
      <span>{label}</span>
      <Time ts={ts} />
    </div>
  );
}
