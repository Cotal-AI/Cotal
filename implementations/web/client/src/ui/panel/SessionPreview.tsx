import { useMemo } from "react";
import { displayNameOf, nameIndex } from "../../lib/names.js";
import { rosterRows } from "../../lib/roster.js";
import { foldWork, type SessionFrame, type Work, type WorkItem } from "../../lib/session.js";
import { useStore } from "../../state/hooks.js";
import type { Store } from "../../state/store.js";
import type { DashboardState, StoredMessage } from "../../state/types.js";
import { LiveChip } from "../session/LiveChip.tsx";
import { PlaneNote } from "../session/PlaneNote.tsx";
import { conditionOf } from "../views/SessionView.tsx";
import { WorkList } from "../work/WorkList.tsx";

/** How many steps the panel shows, the newest. The full view has the rest. */
export const PREVIEW_STEPS = 6;
/** Stable empty lists, so the fold is not redone while no session is held. */
const NO_FRAMES: SessionFrame[] = [];
const NO_POSTS: StoredMessage[] = [];

/** `work` cut to its newest `n` steps, prompts and reasoning not counted. A loose step counts one and a
 *  turn counts its steps: the oldest turn kept keeps only its newest steps, and older items are left
 *  out. A loose turn end counts nothing. */
function recentWork(work: Work, n: number): Work {
  const shown = (s: WorkItem) => s.kind !== "prompt" && s.kind !== "reasoning" && s.kind !== "turnEnd";
  const kept: WorkItem[] = [];
  let left = n;
  for (let i = work.items.length - 1; i >= 0 && left > 0; i--) {
    const item = work.items[i]!;
    if (item.kind === "turn") {
      const steps = item.steps.filter(shown);
      kept.unshift(steps.length > left ? { ...item, steps: steps.slice(-left) } : item);
      left -= Math.min(left, steps.length);
    } else {
      kept.unshift(item);
      if (shown(item)) left--;
    }
  }
  return { items: kept, toolStatus: work.toolStatus };
}

/** The last six steps at panel size, live, under a "Session" heading with the LiveChip (agents mock
 *  S3, `tpl-lt-engine`). It stands in until the panel's peek replaces it.
 *
 *  - It draws the session and opens nothing: the Agent tab holds the session open, whatever the
 *    route, so hiding this section beside the full view never closes the session.
 *  - The steps are `WorkList`'s in its compact form: never a prompt or reasoning, no turn
 *    descriptions and no post links. The six are counted after those are left out, and `WorkList`
 *    draws the footer under them.
 *  - Live shows on the same terms as in the full view: the feed is connected, the read went through,
 *    the card does not say the plane is off, and the agent is online.
 *  - When the card says the plane is off, the section is only the note.
 *
 *  Names and status come from the roster by id, never from a frame. An id the roster does not hold
 *  draws nothing. */
export function SessionPreview({ store, id }: { store: Store<DashboardState>; id: string }) {
  const roster = useStore(store, (s) => s.roster);
  const self = useStore(store, (s) => s.operatorId);
  const session = useStore(store, (s) => s.sessions[id]);
  const connection = useStore(store, (s) => s.connection);
  const entry = roster.find((p) => p.card.id === id);
  const row = useMemo(() => (entry ? rosterRows([entry], { includeOffline: true })[0] : undefined), [entry]);
  const off = row?.events === "off";
  const condition = useMemo(() => conditionOf(entry), [entry]);
  const nameOf = useMemo(() => {
    const idx = nameIndex(roster);
    return (who: string) => displayNameOf(who, idx, self);
  }, [roster, self]);
  const frames = session?.frames ?? NO_FRAMES;
  const posts = session?.posts ?? NO_POSTS;
  const work = useMemo(() => recentWork(foldWork(frames, posts), PREVIEW_STEPS), [frames, posts]);
  if (!row) return null;
  const live = connection === "connected" && session?.load === "ok" && !off && row.status !== "offline";
  return (
    <>
      <div className="ui-lt-head">
        <h5>Session</h5>
        {live && <LiveChip name={row.name} />}
      </div>
      {off ? (
        <div className="ox-compact">
          <PlaneNote>{`${row.name} publishes no session events. Open session shows its posts only.`}</PlaneNote>
        </div>
      ) : (
        <WorkList work={work} row={row} compact condition={condition} nameOf={nameOf} />
      )}
    </>
  );
}
