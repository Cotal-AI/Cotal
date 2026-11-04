import { InformationCircleIcon } from "@hugeicons/core-free-icons";
import type { ReactNode } from "react";
import { Icon } from "../../icons/Icon.tsx";

/** A quiet note about the agent's event plane (mock S and C, `ui-plane`): what it carries, or that
 *  it is off. */
export function PlaneNote({ children }: { children: ReactNode }) {
  return (
    <div className="ui-plane">
      <Icon icon={InformationCircleIcon} size={16} className="ui-ic" />
      <span>{children}</span>
    </div>
  );
}
