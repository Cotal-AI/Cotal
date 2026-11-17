import { InformationCircleIcon } from "@hugeicons/core-free-icons";
import type { ReactNode } from "react";
import { Icon } from "../../icons/Icon.tsx";
import { Alert, AlertAction, AlertDescription } from "#client/ui/shadcn/alert.tsx";

/** A quiet note about the agent's event plane (mock S and C): what it carries, or that it is off,
 *  and what the reader can do about it (`action`). It is drawn with the page, so it is a note that
 *  screen readers do not announce. */
export function PlaneNote({ children, action }: { children: ReactNode; action?: ReactNode }) {
  return (
    <Alert role="note" className="mb-2">
      <Icon icon={InformationCircleIcon} />
      <AlertDescription>{children}</AlertDescription>
      {action && <AlertAction>{action}</AlertAction>}
    </Alert>
  );
}
