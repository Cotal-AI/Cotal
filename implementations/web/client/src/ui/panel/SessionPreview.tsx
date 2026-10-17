import { useMemo } from "react";
import { rosterRows } from "../../lib/roster.js";
import { foldSession, type SessionFrame } from "../../lib/session.js";
import type { Controller } from "../../state/controller.js";
import { useStore } from "../../state/hooks.js";
import type { Store } from "../../state/store.js";
import type { DashboardState, StoredMessage } from "../../state/types.js";
import { LiveChip } from "../session/LiveChip.tsx";
import { PlaneNote } from "../session/PlaneNote.tsx";
import { SessionList } from "../session/SessionList.tsx";
import { conditionOf, useSession } from "../views/SessionView.tsx";

/** How many steps the panel shows, the newest. The full view has the rest. */
export const PREVIEW_STEPS = 6;
/** Stable empty lists, so the fold is not redone while no session is held. */
const NO_FRAMES: SessionFrame[] = [];
const NO_POSTS: StoredMessage[] = [];

/** The last six steps at panel size, live, under a "Session" heading with the LiveChip (agents mock
 *  S3, `tpl-lt-engine`).
 *
 *  - It opens `id`'s session on mount and closes it in the same effect's cleanup, so it shares the
 *    store's count of views with the full view.
 *  - The steps are the compact list's: never a prompt or reasoning. The six are counted after those
 *    are left out, and `SessionList` draws the footer under them.
 *  - Live shows on the same terms as in the full view: the read went through, the card does not say
 *    the plane is off, and the agent is online.
 *  - When the card says the plane is off, the section is only the note, and no session is opened.
 *
 *  Names and status come from the roster by id, never from a frame. An id the roster does not hold
 *  draws nothing. */
export function SessionPreview({ store, controller, id }: { store: Store<DashboardState>; controller: Controller | null; id: string }) {
  const roster = useStore(store, (s) => s.roster);
  const session = useStore(store, (s) => s.sessions[id]);
  const entry = roster.find((p) => p.card.id === id);
  const row = useMemo(() => (entry ? rosterRows([entry], { includeOffline: true })[0] : undefined), [entry]);
  const off = row?.events === "off";
  // A plane that is off publishes nothing to watch, so no session is opened for it.
  useSession(off ? null : controller, id);
  const condition = useMemo(() => conditionOf(entry), [entry]);
  const frames = session?.frames ?? NO_FRAMES;
  const posts = session?.posts ?? NO_POSTS;
  const steps = useMemo(
    () => foldSession(frames, posts).filter((s) => s.kind !== "prompt" && s.kind !== "reasoning").slice(-PREVIEW_STEPS),
    [frames, posts],
  );
  if (!row) return null;
  const live = session?.load === "ok" && !off && row.status !== "offline";
  return (
    <>
      <div className="ui-lt-head">
        <h5>Session</h5>
        {live && <LiveChip name={row.name} />}
      </div>
      {off ? (
        <div className="ui-lt">
          <PlaneNote>{`${row.name} publishes no session events. Open session shows its posts only.`}</PlaneNote>
        </div>
      ) : (
        <SessionList steps={steps} row={row} compact condition={condition} />
      )}
    </>
  );
}
