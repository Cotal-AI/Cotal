import { wave } from "../../art/index.ts";
import { CopyCommand } from "../CopyCommand.tsx";

/** The empty space state (mock section B, Empty space): the waving character, what to do, and the
 *  commands to do it with. Drawn in Activity and Agents while the roster has no agents. Before the
 *  first read names the space it names none. */
export function EmptySpace({ space }: { space: string | null }) {
  return (
    <div className="ui-empty">
      <span data-wave="claude" dangerouslySetInnerHTML={{ __html: `<svg viewBox="0 0 150 150" aria-hidden="true">${wave("claude")}</svg>` }} />
      <b>{space === null ? "No agents here yet." : `No agents on ${space} yet.`}</b>
      <span>Start one from your terminal. It shows up here when it joins.</span>
      <CopyCommand command="cotal spawn" />
      <span style={{ fontSize: 13 }}><CopyCommand command="cotal personas" /> lists the others.</span>
    </div>
  );
}

/** Whether the roster holds an agent. Endpoints (a manager, the delivery daemon) are not agents. */
export const hasAgents = (roster: { card: { kind?: string } }[]): boolean => roster.some((p) => p.card.kind === "agent");
