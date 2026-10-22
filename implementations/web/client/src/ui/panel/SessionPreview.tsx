import { CancelCircleIcon } from "@hugeicons/core-free-icons";
import { useMemo } from "react";
import { Icon } from "../../icons/Icon.tsx";
import { displayNameOf, nameIndex } from "../../lib/names.js";
import { rosterRows, type RosterRow } from "../../lib/roster.js";
import { foldWork, turnTitle, type SessionFrame, type Turn, type WorkItem } from "../../lib/session.js";
import { useStore } from "../../state/hooks.js";
import type { Store } from "../../state/store.js";
import type { DashboardState } from "../../state/types.js";
import { PlaneNote } from "../session/PlaneNote.tsx";
import { conditionOf, useOwnMessages } from "../views/AgentPage.tsx";
import { useNow } from "../work/useNow.ts";
import { WorkList } from "../work/WorkList.tsx";

/** How many steps of the turn the peek shows, the newest. The agent's page has the rest. */
export const PEEK_STEPS = 3;
/** A stable empty list, so the fold is not redone while nothing is held. */
const NO_FRAMES: SessionFrame[] = [];

/** The tail of `turn` that holds its newest `n` shown steps (no prompt, no reasoning). Hidden steps
 *  among them stay, so the trailing work is the turn's own. */
function lastSteps(turn: Turn, n: number): Turn {
  let shown = 0;
  let from = turn.steps.length;
  while (from > 0 && shown < n) {
    const s = turn.steps[--from]!;
    if (s.kind !== "prompt" && s.kind !== "reasoning") shown++;
  }
  return { ...turn, steps: turn.steps.slice(from) };
}

/** The peek's heading: "Now" over the current turn, else "Last turn", with the whole turn's title on
 *  the right, counting while the turn is current, and its failed calls. */
function NowHead({ turn, current, row }: { turn: Turn; current: boolean; row: RosterRow }) {
  const now = useNow(current);
  const { title, failed } = turnTitle(turn, row.status, now);
  return (
    <div className="ui-lt-head ox-now-head">
      <h5>{current ? "Now" : "Last turn"}</h5>
      <span className="ox-now-t">
        {title}
        {failed !== undefined && (
          <>
            {", "}
            <span className="ox-fail"><Icon icon={CancelCircleIcon} size={16} />{failed}</span>
          </>
        )}
      </span>
    </div>
  );
}

/** The Agent tab peek's "Now" (overhaul mock W, `tpl-peek-logic`): what the agent is doing, from its
 *  event plane, at panel size.
 *
 *  - It draws what is held and opens nothing: the Agent tab holds the agent's work open, whatever the
 *    route.
 *  - While a turn is open and presence says the agent is working or waiting, "Now" over that turn's
 *    last three steps, with "Working for" (or "Open for") counting on the right. Otherwise "Last
 *    turn" over the last turn's last three, with how long it took. The title is the whole turn's, so
 *    a failed call in a step left out still counts. With no turn held, nothing.
 *  - The steps are `WorkList`'s compact form: a run of calls as its group's title line, no prompt, no
 *    reasoning, no description but a running call's and no footer.
 *  - When the card says the plane is off, only the note that it publishes nothing.
 *
 *  Names and status come from the roster by id, never from a frame. An id the roster does not hold
 *  draws nothing. */
export function SessionPreview({ store, id }: { store: Store<DashboardState>; id: string }) {
  const roster = useStore(store, (s) => s.roster);
  const self = useStore(store, (s) => s.operatorId);
  const frames = useStore(store, (s) => s.sessions[id]?.frames) ?? NO_FRAMES;
  const posts = useOwnMessages(store, id);
  const entry = roster.find((p) => p.card.id === id);
  const row = useMemo(() => (entry ? rosterRows([entry], { includeOffline: true })[0] : undefined), [entry]);
  const condition = useMemo(() => conditionOf(entry), [entry]);
  const nameOf = useMemo(() => {
    const idx = nameIndex(roster);
    return (who: string) => displayNameOf(who, idx, self);
  }, [roster, self]);
  const work = useMemo(() => foldWork(frames, posts), [frames, posts]);
  if (!row) return null;
  if (row.events === "off") return <PlaneNote>{`${row.name} publishes no work events.`}</PlaneNote>;
  const turns = work.items.filter((i: WorkItem): i is Turn => i.kind === "turn");
  const open = turns.findLast((t) => t.outcome === "open" && !t.superseded);
  const current = open !== undefined && (row.status === "working" || row.status === "waiting");
  const turn = current ? open : turns.at(-1);
  if (!turn) return null;
  return (
    <>
      <NowHead turn={turn} current={current} row={row} />
      <WorkList work={{ items: [lastSteps(turn, PEEK_STEPS)], toolStatus: work.toolStatus }} row={row} compact condition={condition} nameOf={nameOf} />
    </>
  );
}
