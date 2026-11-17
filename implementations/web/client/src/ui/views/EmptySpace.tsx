import { wave } from "../../art/index.ts";
import { CopyCommand } from "../CopyCommand.tsx";
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "#client/ui/shadcn/empty.tsx";

/** The empty space state (mock section B, Empty space): the waving character, what to do, and the
 *  commands to do it with. Drawn in Activity and Agents while the roster has no agents. Before the
 *  first read names the space it names none. */
export function EmptySpace({ space }: { space: string | null }) {
  return (
    <Empty>
      <EmptyHeader>
        <EmptyMedia data-wave="claude" dangerouslySetInnerHTML={{ __html: `<svg viewBox="0 0 150 150" width="150" height="150" overflow="visible" aria-hidden="true">${wave("claude")}</svg>` }} />
        <EmptyTitle>{space === null ? "No agents here yet." : `No agents on ${space} yet.`}</EmptyTitle>
        <EmptyDescription>Start one from your terminal. It shows up here when it joins.</EmptyDescription>
      </EmptyHeader>
      <EmptyContent>
        <CopyCommand command="cotal spawn" />
        <div><CopyCommand command="cotal personas" /> lists the others.</div>
      </EmptyContent>
    </Empty>
  );
}

/** Whether the roster holds an agent. Endpoints (a manager, the delivery daemon) are not agents. */
export const hasAgents = (roster: { card: { kind?: string } }[]): boolean => roster.some((p) => p.card.kind === "agent");
