import { CancelCircleIcon, CommandLineIcon, File01Icon, FileEditIcon, HourglassIcon, InboxDownloadIcon, SentIcon, UnavailableIcon, Wrench01Icon } from "@hugeicons/core-free-icons";
import type { IconSvgElement } from "@hugeicons/react";
import { Icon } from "../../icons/Icon.tsx";
import { callDescription, callTitle, shownName, type CallState, type ToolCall, type ToolKind } from "../../lib/session.js";
import { useXfade } from "../session/xfade.js";
import { Spinner } from "../shadcn/spinner.tsx";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "../shadcn/tooltip.tsx";
import { TraceDescription, TraceIcon, TraceLine, TraceTitle } from "../shadcn/trace.tsx";
import { useNow } from "./useNow.ts";

const KIND_ICON: Readonly<Record<ToolKind, IconSvgElement>> = {
  command: CommandLineIcon,
  edit: FileEditIcon,
  write: FileEditIcon,
  read: File01Icon,
  send: SentIcon,
  dm: SentIcon,
  inbox: InboxDownloadIcon,
  other: Wrench01Icon,
};

/** The icon for a kind of call: a command line, a file being edited, a file, a sent message, the
 *  inbox, and the wrench for any other tool. */
export const kindIcon = (kind: ToolKind): IconSvgElement => KIND_ICON[kind];

/** What a failed call's tooltip says. The marker carries only that the call returned an error. */
const FAILED_COMMAND = "The connector reports the call returned an error. It doesn't publish the error text or the command.";
const FAILED_OTHER = "The connector reports the call returned an error. It doesn't publish the error text or the tool's input.";

/** The icon for a call in `state`: the spinner while it runs, the cross when it failed, the hourglass
 *  while it waits, the struck circle when no result arrived, and otherwise its kind's. */
function callIcon(call: ToolCall, state: CallState) {
  if (state === "running") return <Spinner />;
  const icon = state === "failed" ? CancelCircleIcon : state === "pending" ? HourglassIcon : state === "noResult" ? UnavailableIcon : kindIcon(call.kind);
  return <Icon icon={icon} size={16} />;
}

/** One tool call (mock B1, C and G, `sh-line`): its icon, a title that says what kind of call it was
 *  and how it went, and a description with the tool name in `<code>` as text (capped at 64 characters,
 *  the whole name in its `title`) and its time.
 *
 *  - running: the spinner, `status="running"` with the title's shimmer and `role="status"`, and the
 *    seconds counting. Only the latest running line of a list shimmers: the others pass
 *    `shimmer={false}` and keep the spinner and the count.
 *  - failed: the cross, `status="error"`, and a tooltip that says what the connector does not publish.
 *  - pending and noResult: the hourglass or the struck circle, `status="pending"`, and when it started.
 *  - done: the kind's icon and how long it took. called: `Called <name>` and its time only.
 *
 *  When the state changes the line mounts afresh and cross-fades in (`useXfade`), so the spinner,
 *  title and time turn into the final ones together. The name, title and times are React text. */
export function ToolLine({ call, state, shimmer = true, className }: { call: ToolCall; state: CallState; shimmer?: boolean; className?: string }) {
  const now = useNow(state === "running");
  const fade = useXfade(state);
  const tone = state === "running" ? (shimmer ? "running" : undefined) : state === "failed" ? "error" : state === "pending" || state === "noResult" ? "pending" : undefined;
  const desc = callDescription(call, state, now);
  const name = shownName(call.name);
  const classes = ["ox-line", className, fade].filter(Boolean).join(" ");
  const line = (
    <TraceLine key={state} status={tone} role={tone === "running" ? "status" : undefined} className={classes}>
      <TraceIcon>{callIcon(call, state)}</TraceIcon>
      <TraceTitle title={state === "called" ? call.full : undefined}>{callTitle(call.kind, state, call.name)}</TraceTitle>
      {" "}
      {desc && (
        <TraceDescription>
          {state === "called" ? desc : <><code title={call.full}>{name}</code>{desc.slice(name.length)}</>}
        </TraceDescription>
      )}
    </TraceLine>
  );
  if (state !== "failed") return line;
  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger type="button" className="ox-tip">{line}</TooltipTrigger>
        <TooltipContent className="ox-tipc" sideOffset={4}>{call.kind === "command" ? FAILED_COMMAND : FAILED_OTHER}</TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}
