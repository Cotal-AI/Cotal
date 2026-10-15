// The roster as the dashboard shows it: rows, ordering, counts, and the one place that writes the
// honest progress text.
import type { PresenceView, RosterEntry } from "../api/types.js";
import type { StaleMark } from "./snapshot.js";

export type Status = "working" | "waiting" | "idle" | "offline";

/** Waiting first: the Agents view leads with who needs a human. */
export const STATUS_ORDER: Status[] = ["waiting", "working", "idle", "offline"];

export interface RosterRow {
  id: string;
  name: string;
  role?: string;
  status: Status;
  activity?: string;
  harness?: string;
  host?: string;
  attention?: string;
  model?: string;
  /** Last heartbeat (Presence.ts), not work progress and not status-entered-at. */
  ts: number;
  statusSince?: number;
  progress?: { kind: "unknown" };
}

// `card.meta` is free-form advisory display metadata, so a reserved key is read only when it is a string.
const metaText = (meta: Record<string, unknown> | undefined, key: string): string | undefined => {
  const v = meta?.[key];
  return typeof v === "string" ? v : undefined;
};

/** A status's place in `STATUS_ORDER`. The wire can carry a status outside the four, which sorts
 *  after all of them rather than before them. */
const rank = (status: string): number => {
  const i = STATUS_ORDER.indexOf(status as Status);
  return i === -1 ? STATUS_ORDER.length : i;
};

/** The roster shaped for a list: online only unless asked, sorted by status then name. */
export function rosterRows(roster: RosterEntry[], opts: { includeOffline?: boolean } = {}): RosterRow[] {
  return roster
    .filter((p) => opts.includeOffline || p.status !== "offline")
    .sort((a, b) => rank(a.status) - rank(b.status) || a.card.name.localeCompare(b.card.name))
    .map((p): RosterRow => ({
      id: p.card.id,
      name: p.card.name,
      role: p.card.role,
      status: p.status,
      activity: p.activity,
      harness: metaText(p.card.meta, "connector"),
      host: metaText(p.card.meta, "host"),
      attention: p.attention, // open/absent both render as nothing
      model: metaText(p.card.meta, "model"),
      ts: p.ts,
      statusSince: p.statusSince,
      progress: p.progress,
    }));
}

/** How many rows hold each of the four statuses. A row whose status is none of them counts toward
 *  none, so no count becomes `NaN`. */
export function statusCounts(rows: RosterRow[]): Record<Status, number> {
  const counts: Record<Status, number> = { working: 0, waiting: 0, idle: 0, offline: 0 };
  for (const r of rows) if (STATUS_ORDER.includes(r.status)) counts[r.status] += 1;
  return counts;
}

export const waiting = (rows: RosterRow[]): RosterRow[] => rows.filter((r) => r.status === "waiting");

/** Stalest heartbeat among LIVE rows only. Offline ages grow forever and are pure noise in a
 *  golden-signal slot; among live rows this catches a lapsed heartbeat before the offline flip. */
export function oldestLiveBeat(rows: RosterRow[]): number | undefined {
  const beats = rows.filter((r) => r.status !== "offline" && typeof r.ts === "number").map((r) => r.ts);
  return beats.length ? Math.min(...beats) : undefined;
}

export const statusLabel = (p: Pick<RosterRow, "status" | "progress">): string => p.status === "working" && p.progress?.kind === "unknown" ? "working · progress unknown" : p.status;

/** The observer's own presence watch, not a peer. A stall past TTL is "the window went blind", not
 *  "everyone left": the page keeps last-known online rows and names the roster source stale. */
export function presenceViewMark(view: PresenceView): StaleMark | undefined {
  if (!view || view.fresh) return undefined;
  if (view.state === "unpopulated") return { kind: "refused", name: "roster", reason: "observer presence snapshot still loading" };
  const since = Number.isFinite(view.staleSince) ? new Date(view.staleSince).toISOString() : "unknown";
  const mark: StaleMark = { kind: "refused", name: "roster", reason: `observer presence watch silent since ${since}` };
  return Number.isFinite(view.staleSince) ? { ...mark, since: view.staleSince } : mark;
}
