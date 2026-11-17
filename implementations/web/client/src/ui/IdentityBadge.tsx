import type { CSSProperties } from "react";
import type { Badge } from "../lib/identity.js";

/** Below this avatar size the badge is a colour dot with no letter: a name sits beside it or in the
 *  tooltip. */
const LETTER_FROM = 26;

/** The initial badge, bottom left of an avatar box (mock B2): the letter on the slot's fill. Under
 *  26px it draws the colour with no letter. Offline greys the fill and keeps the letter. It is
 *  hidden from assistive technology; the name beside it is the label. */
export function IdentityBadge({ letter, slot, size, offline }: Badge & { size: number; offline: boolean }) {
  const dot = size < LETTER_FROM;
  const className = ["ui-idb", [...letter].length > 1 && "ui-idb-2", dot && "ui-idb-dot", offline && "ui-idb-off"].filter(Boolean).join(" ");
  return (
    <i className={className} style={{ "--bf": `var(--id-${slot})` } as CSSProperties} aria-hidden="true">
      {dot ? null : letter}
    </i>
  );
}
