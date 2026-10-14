import { HugeiconsIcon, type IconSvgElement } from "@hugeicons/react";

/** A Hugeicons free icon, Stroke Rounded at stroke 1.5: 18 in headers, 16 inline, 22 in the rail. */
export function Icon({ icon, size = 18 }: { icon: IconSvgElement; size?: 16 | 18 | 22 }) {
  return <HugeiconsIcon icon={icon} size={size} strokeWidth={1.5} aria-hidden="true" />;
}
