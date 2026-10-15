import { NotificationOff01Icon, Target02Icon } from "@hugeicons/core-free-icons";
import type { IconSvgElement } from "@hugeicons/react";
import { Icon } from "../icons/Icon.tsx";

/** The two attention modes that show, each with its icon, word, colour and the notes' tooltip.
 *  `open` attention, or none, shows nothing. */
const ATTENTION: Record<"dnd" | "focus", { icon: IconSvgElement; word: string; color: string; title: string }> = {
  dnd: { icon: NotificationOff01Icon, word: "Do not disturb", color: "var(--uni-ink)", title: "Channel messages wait for its next turn. DMs and mentions still wake it." },
  focus: { icon: Target02Icon, word: "Focus", color: "var(--multi-ink)", title: "Channel messages stay in the channel. DMs and role requests still reach it." },
};

/** An agent's attention as the mock draws it: Do not disturb or Focus with its icon and tooltip, and
 *  nothing at all for open attention or a mode the dashboard does not know. The Agents view rows and
 *  the Agent tab both draw it. */
export function AttentionMark({ attention }: { attention: string | undefined }) {
  if (attention === undefined || !Object.hasOwn(ATTENTION, attention)) return null;
  const a = ATTENTION[attention as keyof typeof ATTENTION];
  return (
    <span className="v3-meta" style={{ color: a.color }} title={a.title}>
      <Icon icon={a.icon} size={16} className="ui-ic ui-ic16" />
      {a.word}
    </span>
  );
}
