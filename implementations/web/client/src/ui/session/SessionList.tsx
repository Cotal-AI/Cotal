import { useEffect, useRef, type ReactNode } from "react";
import type { RosterRow } from "../../lib/roster.js";
import type { SessionStep } from "../../lib/session.js";
import { PostRow } from "./PostRow.tsx";
import { PromptBlock } from "./PromptBlock.tsx";
import { Reasoning } from "./Reasoning.tsx";
import { RunError, type RunErrorCondition } from "./RunError.tsx";
import { SaidBlock } from "./SaidBlock.tsx";
import { SessionFoot } from "./SessionFoot.tsx";
import { Time } from "./Time.tsx";
import { ToolGroup } from "./ToolGroup.tsx";
import { ToolRow } from "./ToolRow.tsx";
import { TurnLine } from "./TurnLine.tsx";
import { UnknownStep } from "./UnknownStep.tsx";

/** What the list has drawn for one agent: every key it has shown, and the keys that rose in. */
interface Seen { id: string; known: Set<string>; rising: Set<string> }

/** Which steps rise in. A step rises when it is live and was not in the list the last time it drew,
 *  and keeps its class after, so a later render never cuts its animation short. Nothing rises on
 *  the list's first draw for an agent, so history and whatever was already there when the view
 *  mounted appear in place. A new agent id starts over. */
function useRising(steps: readonly SessionStep[], id: string): (step: SessionStep) => boolean {
  const seen = useRef<Seen | undefined>(undefined);
  const now = seen.current?.id === id ? seen.current : undefined;
  useEffect(() => {
    const cur = seen.current;
    if (cur?.id !== id) {
      seen.current = { id, known: new Set(steps.map((s) => s.key)), rising: new Set() };
      return;
    }
    for (const s of steps) {
      if (cur.known.has(s.key)) continue;
      cur.known.add(s.key);
      if (s.live) cur.rising.add(s.key);
    }
  });
  return (step) => now !== undefined && (now.rising.has(step.key) || (step.live && !now.known.has(step.key)));
}

/** One step as its part draws it. */
function part(step: SessionStep, compact: boolean, highlight: string | undefined, condition: RunErrorCondition | undefined): ReactNode {
  switch (step.kind) {
    case "turn":
      return <TurnLine ts={step.ts} source={step.source} compact={compact} />;
    case "prompt":
      return <PromptBlock text={step.text} cut={step.cut} />;
    case "said":
      return <SaidBlock text={step.text} cut={step.cut} />;
    case "tools":
      return step.calls.length === 1 ? <ToolRow call={step.calls[0]!} /> : <ToolGroup calls={step.calls} compact={compact} />;
    case "turnEnd":
      return <div className="ui-tend">Turn ended <Time ts={step.ts} /></div>;
    case "runError":
      return <RunError ts={step.ts} condition={condition} />;
    case "reasoning":
      return <Reasoning text={step.text} cut={step.cut} />;
    case "post":
      return <PostRow msg={step.msg} channel={step.channel} compact={compact} highlight={highlight !== undefined && step.msg.id === highlight} />;
    case "unknown":
      return <UnknownStep label={step.label} ts={step.ts} />;
  }
}

/** The steps in order, each wrapped in a div with class "ui-in" when the step is live and new since
 *  the last render, and the run error's condition only on the last step. Then the footer from the
 *  roster row.
 *
 *  - The panel (`compact`, the `ui-lt` container) never draws a prompt or reasoning.
 *  - `condition` is the agent's presence condition. Presence says what holds now, so it explains a
 *    failed turn only when that turn is the last step.
 *  - `highlight` is the id of the post the reader arrived from.
 *  - The "ui-in" class names the rise; its keyframes are the view's. */
export function SessionList({ steps, row, compact = false, condition, highlight }: {
  steps: readonly SessionStep[];
  row: RosterRow;
  compact?: boolean;
  condition?: RunErrorCondition;
  highlight?: string;
}) {
  const shown = compact ? steps.filter((s) => s.kind !== "prompt" && s.kind !== "reasoning") : steps;
  const rises = useRising(shown, row.id);
  const last = shown.length - 1;
  return (
    <div className={compact ? "ui-lt" : "ui-sess"}>
      {shown.map((step, i) => (
        <div key={step.key} className={rises(step) ? "ui-in" : undefined}>
          {part(step, compact, highlight, i === last ? condition : undefined)}
        </div>
      ))}
      <SessionFoot row={row} compact={compact} />
    </div>
  );
}
