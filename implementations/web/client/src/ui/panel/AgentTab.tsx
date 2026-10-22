import { ArrowUpRight01Icon, Message01Icon } from "@hugeicons/core-free-icons";
import { useMemo } from "react";
import { Icon } from "../../icons/Icon.tsx";
import { messageRoute } from "../../lib/compose.js";
import { rosterRows } from "../../lib/roster.js";
import { formatRoute, type Route } from "../../lib/route.js";
import { clock as hhmm } from "../../lib/time.js";
import type { Controller } from "../../state/controller.js";
import { useStore } from "../../state/hooks.js";
import type { Store } from "../../state/store.js";
import type { DashboardState } from "../../state/types.js";
import { Avatar } from "../Avatar.tsx";
import { focusComposer } from "../Composer.tsx";
import { useBadgeOf } from "../identity.js";
import { harnessName } from "../MessageRow.tsx";
import { Button } from "../shadcn/button.tsx";
import { StatusWord } from "../Status.tsx";
import { useSession } from "../agent/work.ts";
import { SessionPreview } from "./SessionPreview.tsx";

/** The Agent tab, a peek at one agent (overhaul mock W, `tpl-peek-logic`): who it is, what it says it
 *  is doing, what it is doing now, and the way to its page.
 *
 *  - The character at 44px beside the name, and role · harness.
 *  - The status line: the status word (through `statusLabel`), the activity or "No current
 *    activity", and "Reported <hh:mm>" from when the status began. With no `statusSince` no time is
 *    given.
 *  - "Now" (`SessionPreview`): the current or last turn's last three steps. The tab holds the agent's
 *    work open whatever the route, unless its card says the plane is off; "Now" is left out while
 *    the centre shows this agent's page (`route`), which already has the steps.
 *  - "Open <name>'s page" goes to `#/agent/<id>`, and Message opens the operator's conversation with
 *    the agent with its composer focused. The commands, details, channels and skills are on the
 *    page's Profile tab.
 *  - An id the roster does not hold reads "Not on the roster". */
export function AgentTab({ store, controller = null, id, route }: {
  store: Store<DashboardState>;
  /** Opens and closes the agent's work that "Now" shows. Null before the dashboard has started. */
  controller?: Controller | null;
  id: string;
  /** The centre's route. On this agent's own page "Now" is left out. */
  route?: Route;
}) {
  const roster = useStore(store, (s) => s.roster);
  const self = useStore(store, (s) => s.operatorId);
  const entry = roster.find((p) => p.card.id === id);
  const plane = useMemo(() => (entry ? rosterRows([entry], { includeOffline: true })[0].events : undefined), [entry]);
  // The tab holds the agent's work open, not "Now", and it does so on every route. Opening the
  // agent's page in the centre hides "Now" but keeps this view, so the work is never closed and opened
  // again between the panel and the page. A plane the card says is off publishes nothing to watch, so
  // nothing is opened for it.
  useSession(entry && plane !== "off" ? controller : null, id);
  const badgeOf = useBadgeOf();
  if (!entry) return <p className="ui-nr">Not on the roster</p>;

  const row = rosterRows([entry], { includeOffline: true })[0];
  const sub = [row.role, row.harness && harnessName(row.harness)].filter(Boolean).join(" · ");
  const reported = typeof row.statusSince === "number" && Number.isFinite(row.statusSince) ? `Reported ${hhmm(new Date(row.statusSince))}` : undefined;
  return (
    <div className="ox-peek">
      <div className="ox-peek-who">
        <Avatar vendor={row.harness} status={row.status} size={44} badge={badgeOf(row.id)} />
        <div>
          <b>{row.name}</b>
          {sub && <div className="ui-sub">{sub}</div>}
        </div>
      </div>
      <div className="ui-sline">
        <StatusWord row={row} />
        <span style={{ color: "var(--ink)" }}>{row.activity || "No current activity"}</span>
        {reported && <small>{reported}</small>}
      </div>
      {!(route?.view === "agent" && route.id === id) && <SessionPreview store={store} id={id} />}
      <div className="ui-actions">
        <Button asChild size="sm" className="ox-btn">
          <a href={formatRoute({ view: "agent", id: row.id, tab: "work" })}>
            <Icon icon={ArrowUpRight01Icon} size={16} />
            {`Open ${row.name}'s page`}
          </a>
        </Button>
        <Button asChild variant="outline" size="sm" className="ox-btn">
          <a href={formatRoute(messageRoute(row.id, self))} onClick={() => focusComposer({ kind: "dm", to: row.id })}>
            <Icon icon={Message01Icon} size={16} />
            Message
          </a>
        </Button>
      </div>
    </div>
  );
}
