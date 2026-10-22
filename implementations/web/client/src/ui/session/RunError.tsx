import { AlertCircleIcon } from "@hugeicons/core-free-icons";
import { Icon } from "../../icons/Icon.tsx";
import { wireDate } from "../../lib/time.js";
import { Time } from "./Time.tsx";

/** A condition presence reports for the agent: its code, quoted as it came, and when it began. */
export interface RunErrorCondition { code: string; since?: number }

/** A failed turn (mock C, `ui-runerr`). The plane says only that the run failed, so the part says
 *  that and that the plane gives no reason. A reason shows only when presence reports a condition. */
export function RunError({ ts, condition }: { ts?: number; condition?: RunErrorCondition }) {
  return (
    <div className="ui-runerr">
      <Icon icon={AlertCircleIcon} size={18} className="ui-ic" />
      <b>{wireDate(ts) ? <>Turn failed at <Time ts={ts} /></> : "Turn failed"}</b>
      <span>The event plane doesn't say why.</span>
      {condition !== undefined && (
        <span>
          Presence reports <code>{condition.code}</code>
          {wireDate(condition.since) && <> since <Time ts={condition.since} /></>}.
        </span>
      )}
    </div>
  );
}
