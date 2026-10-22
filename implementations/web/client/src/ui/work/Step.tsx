import { InformationCircleIcon, Tick02Icon } from "@hugeicons/core-free-icons";
import { createContext, useContext, useState, type CSSProperties } from "react";
import { Icon } from "../../icons/Icon.tsx";
import type { RosterRow } from "../../lib/roster.js";
import { callState, type CallState, type Turn, type WorkStep } from "../../lib/session.js";
import { PostRow } from "../session/PostRow.tsx";
import { PromptBlock } from "../session/PromptBlock.tsx";
import { Reasoning } from "../session/Reasoning.tsx";
import { RunError, type RunErrorCondition } from "../session/RunError.tsx";
import { SaidBlock } from "../session/SaidBlock.tsx";
import { Time } from "../session/Time.tsx";
import { useXfade } from "../session/xfade.js";
import { TraceDescription, TraceIcon, TraceLine, TraceTitle } from "../shadcn/trace.tsx";
import { ToolGroup, type CallAt } from "./ToolGroup.tsx";
import { ToolLine } from "./ToolLine.tsx";

/** Something the list draws, by its key, and whether every frame it came from arrived live. */
export interface Keyed { key: string; live: boolean }

/** Whether a step, a turn or a call rises in (`ui-in`). `WorkList` provides it. */
export const Rise = createContext<(item: Keyed) => boolean>(() => false);

/** What every step of one list shares: the agent's roster row, whether its connector reports tool
 *  status, the panel's size, the post the reader arrived at, and a display name for a roster id. */
export interface StepContext {
  row: RosterRow;
  toolStatus: boolean;
  compact: boolean;
  highlight?: string;
  nameOf: (id: string) => string;
}

/** The calls that may draw as one group: every one finished, failed or simply called. */
const SETTLED: ReadonlySet<CallState> = new Set(["done", "failed", "called"]);

/** One `tools` step. Two or more settled calls draw as a closed `ToolGroup`, or in the panel's peek
 *  (`compact`) as its title line; otherwise each call is its own `ToolLine`, and only the latest
 *  running one shimmers. A call that joins after the step drew
 *  rises in.
 *
 *  When the last call of a run ends, the lines fold into the group: the group cross-fades in where the
 *  first line was, and the lines after it fold up beneath it (`ox-fold`) and leave once that animation
 *  ends. A group there at the first paint draws in place. */
function ToolStep({ step, at, toolStatus, compact }: { step: WorkStep & { kind: "tools" }; at: CallAt; toolStatus: boolean; compact: boolean }) {
  const rises = useContext(Rise);
  const states = step.calls.map((c) => callState(c, { ...at, toolStatus }));
  const grouped = step.calls.length >= 2 && states.every((s) => SETTLED.has(s));
  const fade = useXfade(grouped ? "group" : "lines");
  const [was, setWas] = useState(grouped);
  const [folding, setFolding] = useState(false);
  if (was !== grouped) {
    setWas(grouped);
    setFolding(grouped);
  }
  if (grouped) {
    return (
      <>
        <ToolGroup key="group" calls={step.calls} at={at} toolStatus={toolStatus} line={compact} className={fade} />
        {folding && (
          <div className="ox-fold" aria-hidden="true" style={{ "--fold-n": step.calls.length - 1 } as CSSProperties} onAnimationEnd={() => setFolding(false)}>
            {step.calls.slice(1).map((c, i) => <ToolLine key={c.key} call={c} state={states[i + 1]!} />)}
          </div>
        )}
      </>
    );
  }
  const latest = states.lastIndexOf("running");
  return (
    <>
      {step.calls.map((c, i) => (
        <ToolLine key={c.key} call={c} state={states[i]!} shimmer={i === latest} className={i > 0 && rises(c) ? "ui-in" : undefined} />
      ))}
    </>
  );
}

/** A RUN_FINISHED whose turn began before the window: the tick, "Turn ended" and its time. */
export function TurnEnd({ ts }: { ts?: number }) {
  return (
    <TraceLine className="ox-line">
      <TraceIcon><Icon icon={Tick02Icon} size={16} /></TraceIcon>
      <TraceTitle>Turn ended</TraceTitle>
      {" "}
      <TraceDescription><Time ts={ts} /></TraceDescription>
    </TraceLine>
  );
}

/** An event the fold does not know, named and never skipped: its label as text and its time. */
function UnknownStep({ label, ts }: { label: string; ts?: number }) {
  return (
    <TraceLine className="ox-line">
      <TraceIcon><Icon icon={InformationCircleIcon} size={16} /></TraceIcon>
      <TraceTitle>{label}</TraceTitle>
      {" "}
      <TraceDescription><Time ts={ts} /></TraceDescription>
    </TraceLine>
  );
}

/** One step of a turn, or a loose one, as its part draws it. `turn` is the turn holding it, `trailing`
 *  whether it is that turn's last step (or the list's last loose item), and `condition` presence's
 *  condition, handed only to the last item of the list. The panel draws no prompt and no reasoning. */
export function Step({ step, turn, trailing, ctx, condition }: {
  step: WorkStep;
  turn?: Turn;
  trailing: boolean;
  ctx: StepContext;
  condition?: RunErrorCondition;
}) {
  switch (step.kind) {
    case "prompt":
      return ctx.compact ? null : <PromptBlock text={step.text} cut={step.cut} />;
    case "reasoning":
      return ctx.compact ? null : <Reasoning text={step.text} cut={step.cut} />;
    case "said":
      return <SaidBlock text={step.text} cut={step.cut} compact={ctx.compact} />;
    case "tools":
      return <ToolStep step={step} at={{ turn, trailing, status: ctx.row.status }} toolStatus={ctx.toolStatus} compact={ctx.compact} />;
    case "post":
      return (
        <PostRow
          msg={step.msg}
          agent={ctx.row.id}
          {...(step.channel !== undefined ? { channel: step.channel } : { to: step.to, toName: ctx.nameOf(step.to ?? "") })}
          compact={ctx.compact}
          highlight={ctx.highlight !== undefined && step.msg.id === ctx.highlight}
        />
      );
    case "runError":
      return <RunError ts={step.ts} condition={condition} />;
    case "unknown":
      return <UnknownStep label={step.label} ts={step.ts} />;
  }
}
