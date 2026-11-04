import { useEffect, useRef } from "react";
import type { RosterRow } from "../../lib/roster.js";
import type { Turn as WorkTurn, Work, WorkItem } from "../../lib/session.js";
import { PlaneNote } from "../session/PlaneNote.tsx";
import type { RunErrorCondition } from "../session/RunError.tsx";
import { SessionFoot } from "../session/SessionFoot.tsx";
import { Trace } from "../shadcn/trace.tsx";
import { Rise, Step, TurnEnd, type Keyed } from "./Step.tsx";
import { Turn } from "./Turn.tsx";

/** What the list has drawn for one agent: every key it has shown, and the keys that rose in. */
interface Seen { id: string; known: Set<string>; rising: Set<string> }

/** Every item, turn step and call the list can draw, each by its key. */
function keyed(items: readonly WorkItem[]): Keyed[] {
  const out: Keyed[] = [];
  const add = (steps: readonly WorkItem[]) => {
    for (const s of steps) {
      out.push(s);
      if (s.kind === "turn") add(s.steps);
      else if (s.kind === "tools") out.push(...s.calls);
    }
  };
  add(items);
  return out;
}

/** Which items rise in. One rises when it is live and was not in the list the last time it drew, and
 *  keeps its class after, so a later render never cuts its animation short. Nothing rises on the
 *  list's first draw for an agent, so history, Load earlier and whatever was there when the view
 *  mounted appear in place. A new agent id starts over. */
function useRising(items: readonly WorkItem[], id: string): (item: Keyed) => boolean {
  const seen = useRef<Seen | undefined>(undefined);
  const now = seen.current?.id === id ? seen.current : undefined;
  useEffect(() => {
    const all = keyed(items);
    const cur = seen.current;
    if (cur?.id !== id) {
      seen.current = { id, known: new Set(all.map((s) => s.key)), rising: new Set() };
      return;
    }
    for (const s of all) {
      if (cur.known.has(s.key)) continue;
      cur.known.add(s.key);
      if (s.live) cur.rising.add(s.key);
    }
  });
  return (item) => now !== undefined && (now.rising.has(item.key) || (item.live && !now.known.has(item.key)));
}

/** The turn open by default: the one holding the post the reader arrived at, else the open turn (the
 *  latest that is still open and not superseded), else the last turn. Every other turn starts closed. */
function openByDefault(items: readonly WorkItem[], highlight: string | undefined): WorkTurn | undefined {
  const turns = items.filter((i): i is WorkTurn => i.kind === "turn");
  const holder = highlight === undefined ? undefined : turns.find((t) => t.steps.some((s) => s.kind === "post" && s.msg.id === highlight));
  return holder ?? turns.findLast((t) => t.outcome === "open" && !t.superseded) ?? turns.at(-1);
}

/** Every item of a Work in order (mock B1 `tpl-work-logic`): loose steps, turns, loose turn ends, then
 *  the footer from presence. `compact` is the panel's peek (mock W, `tpl-peek-logic`): a turn draws as
 *  its steps with no line of its own, a run of calls as its group's title line, no prompt, no
 *  reasoning, no links on posts, no description but a running call's, and no footer.
 *
 *  - A connector that reports no tool status gets the note above the list that says so (mock C).
 *  - Each item sits in a div with class "ui-in" while it rises in.
 *  - `condition` is the agent's presence condition. Presence says what holds now, so it explains a
 *    failed turn only when that turn is the list's last item.
 *  - `highlight` is the id of the post the reader arrived from; its turn opens.
 *  - `nameOf` names a roster id, for the "Sent to" of a direct message.
 *
 *  Names, statuses and activity come from the roster row, never from a frame. */
export function WorkList({ work, row, highlight, compact = false, condition, nameOf }: {
  work: Work;
  row: RosterRow;
  highlight?: string;
  compact?: boolean;
  condition?: RunErrorCondition;
  nameOf: (id: string) => string;
}) {
  const rises = useRising(work.items, row.id);
  const opened = openByDefault(work.items, highlight);
  const ctx = { row, toolStatus: work.toolStatus, compact, nameOf, ...(highlight === undefined ? {} : { highlight }) };
  const shown = (s: WorkItem) => !compact || (s.kind !== "prompt" && s.kind !== "reasoning");
  const last = work.items.at(-1);
  const step = (s: Exclude<WorkItem, WorkTurn>, turn: WorkTurn | undefined, trailing: boolean, cond: RunErrorCondition | undefined) => (
    <div key={s.key} className={rises(s) ? "ox-step ui-in" : "ox-step"}>
      {s.kind === "turnEnd" ? <TurnEnd ts={s.ts} /> : <Step step={s} turn={turn} trailing={trailing} ctx={ctx} condition={cond} />}
    </div>
  );
  return (
    <Rise.Provider value={rises}>
      <Trace className={compact ? "ox-work ox-compact" : "ox-work"}>
        {!work.toolStatus && (
          <PlaneNote>{`${row.name}'s connector reports which tools it calls but not when they finish, so Work can't show running, done or failed. A connector that reports tool results shows them here once ${row.name} restarts on it.`}</PlaneNote>
        )}
        {work.items.filter(shown).map((item) => {
          if (item.kind !== "turn") return step(item, undefined, item === last, item === last ? condition : undefined);
          if (compact) {
            // As in Turn: a run error closes the turn, so the calls before it are still its trailing work.
            const trailing = item.steps.findLast((s) => s.kind !== "runError");
            const end = item.steps.at(-1);
            return item.steps.filter(shown).map((s) => step(s, item, s === trailing, item === last && s === end ? condition : undefined));
          }
          return (
            <div key={item.key} className={rises(item) ? "ox-step ui-in" : "ox-step"}>
              <Turn turn={item} row={row} toolStatus={work.toolStatus} defaultOpen={item === opened} highlight={highlight}
                condition={item === last ? condition : undefined} nameOf={nameOf} />
            </div>
          );
        })}
        {!compact && <SessionFoot row={row} />}
      </Trace>
    </Rise.Provider>
  );
}
