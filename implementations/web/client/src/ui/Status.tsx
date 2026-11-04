import { HourglassIcon, Loading03Icon, Moon02Icon, UnavailableIcon } from "@hugeicons/core-free-icons";
import type { IconSvgElement } from "@hugeicons/react";
import { Icon } from "../icons/Icon.tsx";
import { Badge } from "#client/ui/shadcn/badge.tsx";
import { statusLabel, type RosterRow, type Status } from "../lib/roster.js";

/** Each status's own shape, so a status never rests on colour alone: hourglass for waiting, the
 *  loading spokes for working, a moon for idle and a struck circle for offline (mock section A). */
export const STATUS_ICON: Record<Status, IconSvgElement> = {
  waiting: HourglassIcon,
  working: Loading03Icon,
  idle: Moon02Icon,
  offline: UnavailableIcon,
};

/** A status word with its first letter raised: "waiting" reads "Waiting". */
export const word = (s: string): string => s.charAt(0).toUpperCase() + s.slice(1);

/** The avatar's status dot. Its class gives each status its own shape (filled, half, ring, dashed)
 *  and it names the status to a screen reader. */
export function StatusDot({ status }: { status: Status }) {
  return <i className={`ui-st ui-st-${status}`} role="img" aria-label={word(status)} />;
}

/** The class of a status's icon where it may turn: the working spokes turn (`ox-spin`, which stops
 *  under reduced motion), and every other status stands still. */
export const statusIconClass = (status: string, base: string): string => (status === "working" ? `${base} ox-spin` : base);

/** Each status's Badge variant. Waiting asks for the operator, so it is the solid badge; working is
 *  filled, and idle and offline are outlined. */
const STATUS_VARIANT: Record<Status, "default" | "secondary" | "outline"> = {
  waiting: "default",
  working: "secondary",
  idle: "outline",
  offline: "outline",
};

/** A status as icon and word in a Badge. The word is `statusLabel`'s, so a working agent reads
 *  "Working", and its spokes turn while presence says so. A status outside the four has no icon to
 *  draw and shows its word alone, outlined. */
export function StatusWord({ row }: { row: RosterRow }) {
  const icon = Object.hasOwn(STATUS_ICON, row.status) ? STATUS_ICON[row.status] : undefined;
  const variant = Object.hasOwn(STATUS_VARIANT, row.status) ? STATUS_VARIANT[row.status] : "outline";
  return (
    <Badge variant={variant}>
      {icon && <Icon icon={icon} data-icon="inline-start" className={row.status === "working" ? "ox-spin" : undefined} />}
      {word(statusLabel(row))}
    </Badge>
  );
}
