import type { IconSvgElement } from "@hugeicons/react";
import type { ReactNode } from "react";
import { Icon } from "../../icons/Icon.tsx";
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "#client/ui/shadcn/empty.tsx";

/** A session with nothing to list (mock C): an icon, a title, what to know (`children`), and what
 *  the reader can do about it (`action`). */
export function SessionEmpty({ icon, title, children, action }: { icon: IconSvgElement; title: string; children?: ReactNode; action?: ReactNode }) {
  return (
    <Empty>
      <EmptyHeader>
        <EmptyMedia variant="icon">
          <Icon icon={icon} />
        </EmptyMedia>
        <EmptyTitle>{title}</EmptyTitle>
        {children && <EmptyDescription>{children}</EmptyDescription>}
      </EmptyHeader>
      {action && <EmptyContent>{action}</EmptyContent>}
    </Empty>
  );
}
