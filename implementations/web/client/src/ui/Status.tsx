import { HourglassIcon, Loading03Icon, Moon02Icon, UnavailableIcon } from "@hugeicons/core-free-icons";
import type { IconSvgElement } from "@hugeicons/react";
import { Icon } from "../icons/Icon.tsx";
import { statusLabel, type RosterRow, type Status } from "../lib/roster.js";

/** Each status's own shape, so a status never rests on colour alone: hourglass for waiting, the
 *  loading spokes for working, a moon for idle and a struck circle for offline (mock section A). */
const ICON: Record<Status, IconSvgElement> = {
  waiting: HourglassIcon,
  working: Loading03Icon,
  idle: Moon02Icon,
  offline: UnavailableIcon,
};

/** A status word with its first letter raised: "waiting" reads "Waiting". */
const word = (s: string): string => s.charAt(0).toUpperCase() + s.slice(1);

/** The avatar's status dot. Its class gives each status its own shape (filled, half, ring, dashed)
 *  and it names the status to a screen reader. */
export function StatusDot({ status }: { status: Status }) {
  return <i className={`ui-st ui-st-${status}`} role="img" aria-label={word(status)} />;
}

/** A status as icon and word, in the status pill. The word is `statusLabel`'s, so a working agent
 *  whose connector reports no progress reads "Working · progress unknown". A status outside the
 *  four has no icon to draw and shows its word alone. */
export function StatusWord({ row }: { row: RosterRow }) {
  const icon = Object.hasOwn(ICON, row.status) ? ICON[row.status] : undefined;
  return (
    <span className={`v3-spill v3-s-${row.status}`}>
      {icon && <Icon icon={icon} size={16} className="ui-ic ui-ic16" />}
      {word(statusLabel(row))}
    </span>
  );
}
