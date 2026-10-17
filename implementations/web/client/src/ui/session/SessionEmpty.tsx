import type { IconSvgElement } from "@hugeicons/react";
import type { ReactNode } from "react";
import { Icon } from "../../icons/Icon.tsx";

/** A session with nothing to list (mock C, `ui-sess-empty`): an icon, a title, and what to know. */
export function SessionEmpty({ icon, title, children }: { icon: IconSvgElement; title: string; children?: ReactNode }) {
  return (
    <div className="ui-sess-empty">
      <Icon icon={icon} size={22} className="ui-ic" />
      <b>{title}</b>
      {children}
    </div>
  );
}
