import type { TurnSource } from "../../lib/session.js";
import { wireDate } from "../../lib/time.js";
import { Time } from "./Time.tsx";

/** What started a turn, as the turn line says it. */
const BY: Record<TurnSource, string> = {
  prompt: "by a prompt",
  mesh: "by a message from the mesh",
  continuation: "by the harness continuing itself",
  notification: "by a notification",
};

/** The full view's tooltip on a turn a mesh message started. */
export const MESH_TITLE = "The event plane doesn't carry the text of a message another agent sent. Read it where it was sent.";

/** Where a turn starts (mock S, `ui-turn`): "Turn started <hh:mm>" and, when the frame says, what
 *  started it. A turn started by a mesh message shows no body; the full view says so and where the
 *  text is. No source gives no "by" clause. */
export function TurnLine({ ts, source, compact = false }: { ts?: number; source?: TurnSource; compact?: boolean }) {
  const mesh = source === "mesh" && !compact;
  return (
    <div className="ui-turn" title={mesh ? MESH_TITLE : undefined}>
      <b>Turn started{wireDate(ts) && " "}<Time ts={ts} /></b>
      {" "}
      {source !== undefined && Object.hasOwn(BY, source) && <span>{mesh ? `${BY.mesh}. Its text stays where it was sent.` : BY[source]}</span>}
    </div>
  );
}
