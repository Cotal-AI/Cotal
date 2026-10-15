import { Copy01Icon } from "@hugeicons/core-free-icons";
import type { IconSvgElement } from "@hugeicons/react";
import { Icon } from "../icons/Icon.tsx";

/** The part of `navigator` copying needs. Spelled out rather than taken from the DOM lib, because
 *  the suites typecheck the components that render on the server with no DOM lib. */
type Clipboard = { writeText(text: string): Promise<void> };

/** Put `text` on the clipboard. A page with no clipboard (one served over plain http from another
 *  host) cannot copy, and says so on the console rather than pretending it did. */
function copy(text: string): void {
  const clipboard = (globalThis as { navigator?: { clipboard?: Clipboard } }).navigator?.clipboard;
  if (!clipboard) {
    console.error("copying needs the clipboard, which this page cannot reach");
    return;
  }
  clipboard.writeText(text).catch((err) => console.error("copying the command failed:", err));
}

/** A command the reader can run themselves, as code beside a Copy button (mock section B). `icon`,
 *  when given, says what the command does ahead of it, as the Agent tab's attach and stop rows do. */
export function CopyCommand({ command, icon }: { command: string; icon?: IconSvgElement }) {
  return (
    <span className="ui-cmd">
      {icon && <Icon icon={icon} size={16} className="ui-ic ui-ic16" />}
      <code>{command}</code>
      <button type="button" onClick={() => copy(command)}>
        <Icon icon={Copy01Icon} size={16} className="ui-ic" />
        Copy
      </button>
    </span>
  );
}
