import { CommandLineIcon, File01Icon, FileEditIcon, InboxDownloadIcon, SentIcon, Wrench01Icon } from "@hugeicons/core-free-icons";
import type { IconSvgElement } from "@hugeicons/react";
import { Icon } from "../../icons/Icon.tsx";
import type { ToolCall } from "../../lib/session.js";
import { Time } from "./Time.tsx";

const ICONS: Record<string, IconSvgElement> = {
  Bash: CommandLineIcon,
  Write: FileEditIcon,
  Edit: FileEditIcon,
  Read: File01Icon,
  cotal_send: SentIcon,
  cotal_dm: SentIcon,
  cotal_inbox: InboxDownloadIcon,
};

/** The icon for a tool's short name, and the wrench for any tool without one of its own. */
export const toolIcon = (name: string): IconSvgElement => (Object.hasOwn(ICONS, name) ? ICONS[name]! : Wrench01Icon);

/** One call (mock S, `ui-tc`): its icon, its short name as text with the full name as the tooltip,
 *  and its time. The plane carries no input, result or outcome, so there is nothing else to draw and
 *  no spinner: a call was made, which is not the same as still running. `line` is the standalone
 *  form, a group of one. */
export function CallRow({ call, line = false }: { call: ToolCall; line?: boolean }) {
  return (
    <div className={line ? "ui-tc ui-tc-line" : "ui-tc"}>
      <Icon icon={toolIcon(call.name)} size={16} className="ui-ic" />
      <code title={call.full}>{call.name}</code>
      <Time ts={call.ts} />
    </div>
  );
}

/** A tool call with no other call beside it: the `ui-tc-line` row. */
export function ToolRow({ call }: { call: ToolCall }) {
  return <CallRow call={call} line />;
}
