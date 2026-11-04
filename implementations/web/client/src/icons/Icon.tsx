import { HugeiconsIcon, type IconSvgElement } from "@hugeicons/react";

/** A Hugeicons free icon, Stroke Rounded at stroke 1.5: 18 in headers, 16 inline, 22 in the rail.
 *  `className` carries the mock's `ui-ic` size rules (`ui-ic ui-ic16` inline), which reach an icon
 *  only through its class. */
export function Icon({ icon, size = 18, className }: { icon: IconSvgElement; size?: 16 | 18 | 22; className?: string }) {
  return <HugeiconsIcon icon={icon} size={size} strokeWidth={1.5} className={className} aria-hidden="true" />;
}
