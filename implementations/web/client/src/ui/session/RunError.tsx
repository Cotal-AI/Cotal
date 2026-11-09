import { AlertCircleIcon } from "@hugeicons/core-free-icons";
import { Icon } from "../../icons/Icon.tsx";
import { Alert, AlertDescription, AlertTitle } from "#client/ui/shadcn/alert.tsx";
import { wireDate } from "../../lib/time.js";
import { Time } from "./Time.tsx";

/** A condition presence reports for the agent: its code, quoted as it came, and when it began. */
export interface RunErrorCondition { code: string; since?: number }

/** A failed turn (mock C). The plane says only that the run failed, so the part says that and that
 *  the plane gives no reason. A reason shows only when presence reports a condition. It is drawn
 *  with the turn it ends, so it is a note that screen readers do not announce. */
export function RunError({ ts, condition }: { ts?: number; condition?: RunErrorCondition }) {
  return (
    <Alert variant="destructive" role="note">
      <Icon icon={AlertCircleIcon} />
      <AlertTitle>{wireDate(ts) ? <>Turn failed at <Time ts={ts} /></> : "Turn failed"}</AlertTitle>
      <AlertDescription>
        <div>The event plane doesn't say why.</div>
        {condition !== undefined && (
          <div>
            Presence reports <code>{condition.code}</code>
            {wireDate(condition.since) && <> since <Time ts={condition.since} /></>}.
          </div>
        )}
      </AlertDescription>
    </Alert>
  );
}
