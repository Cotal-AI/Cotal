import { NotificationOff01Icon, Plug01Icon, ServerStack01Icon, Settings01Icon, Target02Icon } from "@hugeicons/core-free-icons";
import { useEffect, useLayoutEffect, useMemo, useReducer, useRef, useState } from "react";
import type { RosterEntry } from "../../api/types.js";
import { Icon } from "../../icons/Icon.tsx";
import { ageText } from "../../lib/age.js";
import { oldestLiveBeat, rosterRows, STATUS_ORDER, statusLabel, type RosterRow } from "../../lib/roster.js";
import { useStore } from "../../state/hooks.js";
import type { Store } from "../../state/store.js";
import type { DashboardState } from "../../state/types.js";
import { Avatar } from "../Avatar.tsx";
import { clock as clockTime, harnessName } from "../MessageRow.tsx";
import { needsDetail } from "../NeedsCard.tsx";
import { STATUS_ICON, StatusWord, word } from "../Status.tsx";
import { EmptySpace } from "./EmptySpace.tsx";

/** How the roster is grouped: by status, or by the host each agent runs on. */
export type Grouping = "status" | "host";

/** Where this browser keeps the viewer's grouping. */
const KEY = "cotal.agents.group";

/** How often the heartbeat ages redraw. They count whole seconds, and nothing else would redraw them
 *  while every agent is silent. */
const TICK_MS = 1000;

/** The tooltips on the two attention badges (mock section D). */
const ATTENTION = {
  dnd: { label: "Do not disturb", icon: NotificationOff01Icon, color: "var(--uni-ink)", title: "Channel messages wait for its next turn. DMs and mentions still wake it." },
  focus: { label: "Focus", icon: Target02Icon, color: "var(--multi-ink)", title: "Channel messages stay in the channel. DMs and role requests still reach it." },
} as const;

/** The grouping this browser saved, or undefined when none is saved or storage is blocked. */
function readGrouping(): Grouping | undefined {
  try {
    const saved = globalThis.localStorage?.getItem(KEY);
    return saved === "status" || saved === "host" ? saved : undefined;
  } catch {
    return undefined;
  }
}

/** Save the grouping. A browser that blocks storage keeps the choice until the page closes, in the
 *  view's own state. */
function saveGrouping(group: Grouping): void {
  try {
    globalThis.localStorage?.setItem(KEY, group);
  } catch {
    // Blocked storage is a browser setting, not a fault.
  }
}

/** The parts of a row, the Waiting header and the list this view reaches into the DOM for. Spelled
 *  out rather than taken from the DOM lib, because the suites typecheck the components that render on
 *  the server with no DOM lib. */
interface Reached {
  focus(options?: { preventScroll?: boolean }): void;
  scrollIntoView?(options?: { block?: "start" }): void;
  dataset: Record<string, string | undefined>;
  ownerDocument: { activeElement: unknown; body: unknown };
  querySelectorAll(selector: string): ArrayLike<Reached>;
}

/** One section of the list: its header and the rows under it. */
interface Section {
  key: string;
  label: string;
  rows: RosterRow[];
}

/** The rows grouped by status: the four statuses in `STATUS_ORDER` (Waiting first), then one section
 *  for each other status the wire carries, so a status outside the four is listed, never dropped.
 *  A status with no rows has no section. */
function sectionsByStatus(rows: RosterRow[]): Section[] {
  const others = [...new Set(rows.map((r) => r.status).filter((s) => !STATUS_ORDER.includes(s)))].sort();
  return [...STATUS_ORDER, ...others]
    .map((status) => ({ key: status, label: word(status), rows: rows.filter((r) => r.status === status) }))
    .filter((s) => s.rows.length > 0);
}

/** The rows grouped by host, hosts in name order. An agent that reports no host is in a last section
 *  of its own, named for what the roster could not say. */
function sectionsByHost(rows: RosterRow[]): Section[] {
  const hosts = [...new Set(rows.map((r) => r.host).filter((h): h is string => h !== undefined))].sort((a, b) => a.localeCompare(b));
  const named = hosts.map((host) => ({ key: `host:${host}`, label: host, rows: rows.filter((r) => r.host === host) }));
  const unnamed = rows.filter((r) => r.host === undefined);
  return unnamed.length > 0 ? [...named, { key: "host:", label: "No host reported", rows: unnamed }] : named;
}

/** A row's role and harness, as `role · harness`, with whichever the card reports. */
const roleLine = (row: RosterRow): string => [row.role, row.harness === undefined ? undefined : harnessName(row.harness)].filter(Boolean).join(" · ");

/** What a row says under the name. An offline agent says when its last heartbeat was. A waiting one
 *  in the status grouping says what it reported and when, as its Needs card does (and so names no
 *  one it waits for and no duration). Anyone else says its own activity text. An agent with no
 *  activity says so, except a working one, which says its status through `statusLabel`, so
 *  progress that is unknown is never read as "no activity". */
function activityText(row: RosterRow, grouping: Grouping): string {
  if (row.status === "offline") return `Last heartbeat ${clockTime(new Date(row.ts))}`;
  if (row.status === "waiting" && grouping === "status") return needsDetail(row) || "No current activity";
  const activity = row.activity?.trim();
  if (activity) return activity;
  return row.status === "working" ? word(statusLabel(row)) : "No current activity";
}

/** One agent: character, name, role and harness, activity, the attention badge when there is one
 *  (open shows nothing), and its host, or its status word under the host grouping. The row is a
 *  button; picking it tells the caller which agent. */
function AgentRow({ row, grouping, selected, onPick }: { row: RosterRow; grouping: Grouping; selected: boolean; onPick?: (id: string) => void }) {
  const attention = row.attention === "dnd" || row.attention === "focus" ? ATTENTION[row.attention] : undefined;
  const waiting = row.status === "waiting" && grouping === "status";
  return (
    <button
      type="button"
      className={row.status === "offline" ? "v3-arow v3-arow-off" : "v3-arow"}
      data-agent={row.id}
      aria-current={selected ? "true" : undefined}
      onClick={() => onPick?.(row.id)}
    >
      <Avatar vendor={row.harness} status={row.status} size={36} />
      <span>
        <span className="v3-aname"><b>{row.name}</b><span>{roleLine(row)}</span></span>
        <span className="v3-aact" style={waiting ? { color: "var(--gold-ink)" } : undefined}>{activityText(row, grouping)}</span>
      </span>
      {attention ? (
        <span className="v3-meta" style={{ color: attention.color }} title={attention.title}>
          <Icon icon={attention.icon} size={16} className="ui-ic ui-ic16" />{attention.label}
        </span>
      ) : <span />}
      {grouping === "host" ? (
        <StatusWord row={row} />
      ) : row.host !== undefined ? (
        <span className="v3-meta"><Icon icon={ServerStack01Icon} size={16} className="ui-ic" />{row.host}</span>
      ) : <span />}
    </button>
  );
}

/** The endpoints under the agents: a manager or a delivery daemon is on the mesh but is no agent,
 *  so it has no status group. An endpoint the roster holds offline says so. */
function Endpoints({ rows }: { rows: RosterRow[] }) {
  return (
    <div className="v3-epsec">
      <div className="v3-ghead" style={{ paddingTop: 12 }}>
        <Icon icon={Plug01Icon} size={16} className="ui-ic" />
        <span style={{ color: "var(--dim)" }}>Endpoints</span>
        <span className="v3-count">{rows.length}</span>
      </div>
      {rows.map((r) => (
        <div key={r.id} className="v3-eprow">
          <span className={r.status === "offline" ? "ui-av ui-av-ep ui-av-off" : "ui-av ui-av-ep"}><Icon icon={Settings01Icon} size={16} className="ui-ic ui-ic16" /></span>
          <b>{r.name}</b>
          <span>{[r.role, r.host, r.status === "offline" ? word(r.status) : undefined].filter(Boolean).join(" · ")}</span>
        </div>
      ))}
    </div>
  );
}

/** The Agents view (mock section A1 and the Agents frame of section D): the agents grouped by status,
 *  Waiting first and empty groups hidden, or by host, with the Status and Host toggle in the header;
 *  the endpoints below; and, in the status grouping, how old the stalest live heartbeat is.
 *
 *  - Names, roles, harnesses and hosts come from the roster by id; agent text is plain text.
 *  - `group` is the grouping the address asks for. Without one the viewer's saved grouping is used,
 *    read once the page is drawn so a server render never touches storage, and a toggle click is
 *    saved for next time. Blocked storage costs only the saving.
 *  - `focusWaiting` (the Needs route) scrolls the Waiting section into view and marks it, when there
 *    is one.
 *  - `selected` is the agent the details panel shows (`aria-current` on its row) and `onPick` is
 *    called with the id of a row the reader opens. The view holds neither, so a row that moves to
 *    another group when its agent changes status stays selected, and keeps keyboard focus if it had it.
 *  - While the roster has no agent the empty space state stands in for the list.
 *  - When the observer's own presence watch is silent the header says how many agents were last seen,
 *    the rows dim, and the heartbeat line goes, since its ages would be of a roster no longer heard.
 *
 *  `clock` is the time the heartbeat ages count from. */
export function AgentsView({ store, group, focusWaiting = false, selected = null, onPick, clock = Date.now }: {
  store: Store<DashboardState>;
  group?: Grouping;
  focusWaiting?: boolean;
  selected?: string | null;
  onPick?: (id: string) => void;
  clock?: () => number;
}) {
  const roster = useStore(store, (s) => s.roster);
  const space = useStore(store, (s) => s.space);
  const stale = useStore(store, (s) => s.stale);
  const [grouping, setGrouping] = useState<Grouping>(group ?? "status");
  const [, redraw] = useReducer((n: number) => n + 1, 0);
  const waitingHead = useRef<HTMLDivElement>(null);
  const list = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => setGrouping(group ?? readGrouping() ?? "status"), [group]);
  useEffect(() => {
    const id = setInterval(redraw, TICK_MS);
    return () => clearInterval(id);
  }, []);

  const split = useMemo(() => {
    const isAgent = (p: RosterEntry) => p.card.kind === "agent";
    return { agents: rosterRows(roster.filter(isAgent), { includeOffline: true }), endpoints: rosterRows(roster.filter((p) => !isAgent(p)), { includeOffline: true }) };
  }, [roster]);
  const { agents, endpoints } = split;
  const sections = grouping === "status" ? sectionsByStatus(agents) : sectionsByHost(agents);
  const hasWaiting = sections.some((s) => s.key === "waiting") && grouping === "status";

  useLayoutEffect(() => {
    if (!focusWaiting || !hasWaiting) return;
    const head = waitingHead.current as unknown as Reached | null;
    head?.focus({ preventScroll: true });
    head?.scrollIntoView?.({ block: "start" });
  }, [focusWaiting, hasWaiting]);

  // A row that changes group is moved or rebuilt by React, which drops the focus it held. Note which
  // row has focus while rendering, before anything moves, and put the focus back once the commit has.
  const reached = list.current as unknown as Reached | null;
  const heldBy = (reached?.ownerDocument.activeElement as Partial<Reached> | null | undefined)?.dataset?.agent ?? null;
  const held = useRef<string | null>(null);
  held.current = heldBy;
  useLayoutEffect(() => {
    const id = held.current;
    if (id === null) return;
    const rows = (list.current as unknown as Reached | null)?.querySelectorAll("[data-agent]") ?? [];
    Array.from(rows).find((e) => e.dataset.agent === id)?.focus({ preventScroll: true });
  });

  const choose = (next: Grouping) => {
    setGrouping(next);
    saveGrouping(next);
  };

  const now = clock();
  const live = agents.filter((r) => r.status !== "offline").length;
  const lastSeen = stale.some((m) => m.name === "roster");
  const beat = oldestLiveBeat(agents);
  const empty = agents.length === 0;
  return (
    <>
      <header className="ui-bar">
        <h1>Agents</h1>
        {!empty && (
          <span className="ui-topic">
            {lastSeen ? (
              <><span className="ui-num">{live}</span> last seen</>
            ) : (
              <><span className="ui-num">{live}</span> live, <span className="ui-num">{agents.length - live}</span> offline{space === null ? "" : ` on ${space}`}</>
            )}
          </span>
        )}
        <span className="ui-sp" />
        {!empty && (
          <span className="v3-toggle" role="group" aria-label="Group by">
            <button type="button" aria-pressed={grouping === "status"} onClick={() => choose("status")}>Status</button>
            <button type="button" aria-pressed={grouping === "host"} onClick={() => choose("host")}>Host</button>
          </span>
        )}
      </header>
      <div className="ui-scroll">
        <div className={lastSeen ? "ui-col s-lastseen" : "ui-col"} style={{ maxWidth: 900 }}>
          {empty && <EmptySpace space={space} />}
          {!empty && (
            <div key={grouping} ref={list} className={grouping === "status" ? "v3-by-status" : "v3-by-host"}>
              {sections.flatMap((section) => {
                const status = grouping === "status" ? section.key : undefined;
                const known = status !== undefined && Object.hasOwn(STATUS_ICON, status);
                return [
                  <div
                    key={`head:${section.key}`}
                    className={known ? `v3-ghead v3-s-${status}` : "v3-ghead"}
                    role="heading"
                    aria-level={2}
                    ref={status === "waiting" ? waitingHead : undefined}
                    tabIndex={status === "waiting" ? -1 : undefined}
                    data-focused={status === "waiting" && focusWaiting ? "true" : undefined}
                  >
                    {known && <Icon icon={STATUS_ICON[status as keyof typeof STATUS_ICON]} size={16} className="ui-ic" />}
                    {grouping === "host" && <Icon icon={ServerStack01Icon} size={16} className="ui-ic" />}
                    <span style={{ color: status === "offline" ? "var(--dim)" : "var(--ink)" }}>{section.label}</span>
                    <span className="v3-count">{section.rows.length}</span>
                  </div>,
                  ...section.rows.map((row) => (
                    <AgentRow key={`row:${row.id}`} row={row} grouping={grouping} selected={selected === row.id} onPick={onPick} />
                  )),
                ];
              })}
              {grouping === "status" && !lastSeen && beat !== undefined && Number.isFinite(beat) && (
                <div className="v3-eprow" style={{ paddingLeft: 66, fontSize: 12.5 }}>
                  Oldest heartbeat among live agents: <span className="ui-num">{ageText(now - beat)}</span> ago
                </div>
              )}
            </div>
          )}
          {endpoints.length > 0 && <Endpoints rows={endpoints} />}
        </div>
      </div>
    </>
  );
}
