import { oneLine, type Report } from "@cotal-ai/workspace";
import type { FeedEntry, MeshSnapshot } from "./view/mesh-view.js";

export const watchViews = ["activity", "events", "messages", "roster", "channels", "waiting", "dms", "topology"] as const;
export type WatchFilter = typeof watchViews[number];
export const WATCH_TEXT_LIMIT = 16_384;
export const isFeedView = (filter: WatchFilter): boolean => ["activity", "events", "messages", "dms"].includes(filter);

export function matchesWatchFilter(entry: FeedEntry, filter: WatchFilter): boolean {
  if (filter === "activity") return true;
  if (filter === "events") return entry.events === true;
  if (filter === "messages") return entry.events !== true;
  return filter === "dms" && entry.delivery === "unicast";
}

export function observedText(text: string): { text: string; omittedCodeUnits: number } {
  let shown = text.slice(0, WATCH_TEXT_LIMIT);
  if (shown.length && /[\uD800-\uDBFF]/u.test(shown.at(-1)!)) shown = shown.slice(0, -1);
  return { text: shown, omittedCodeUnits: text.length - shown.length };
}

export function feedLine(entry: FeedEntry): string {
  const date = new Date(entry.ts);
  const time = Number.isFinite(date.getTime()) ? date.toLocaleTimeString(undefined, { hour12: false, hour: "2-digit", minute: "2-digit", second: "2-digit" }) : "time not reported";
  const sender = entry.from.name || entry.from.id;
  const destination = entry.channel ? `#${entry.channel}` : entry.toService ? `role ${entry.toService}` : `DM to ${entry.toIds?.join(", ") || "not attributed"}`;
  const body = observedText(entry.text);
  if (entry.events) {
    try {
      const event: unknown = JSON.parse(entry.text);
      if (event && typeof event === "object" && "type" in event && typeof event.type === "string") return oneLine(`${time}  ${sender}  reported ${event.type.toLowerCase().replaceAll("_", " ")}`);
    } catch { /* A non-JSON event remains attributed text. */ }
  }
  return oneLine(`${time}  ${sender}  ${destination}  ${body.text}${body.omittedCodeUnits ? ` [${body.omittedCodeUnits} text code units not shown]` : ""}`);
}

/** Read views use facts already normalized by MeshView, without inferring task or membership state. */
export function watchReport(snapshot: MeshSnapshot, filter: WatchFilter): Report {
  const hint = "This observer's snapshot, not a complete history or proof of task completion.";
  if (filter === "roster" || filter === "waiting") {
    const rows = filter === "waiting" ? snapshot.signals.waiting : snapshot.agents;
    return { sections: [{ title: filter === "waiting" ? "Reported waiting" : "Agent roster", blocks: [rows.length ? {
      kind: "table", columns: [{ key: "name", label: "Agent" }, { key: "role", label: "Role" }, { key: "state", label: "Reported state" }, { key: "activity", label: "Reported activity" }, { key: "id", label: "Identity" }],
      rows: rows.map((row) => ({ name: row.card.name, role: row.card.role ?? "none", state: { text: row.status, tone: row.status === "waiting" ? "waiting" : "hint" }, activity: row.activity || "not reported", id: row.card.id })),
    } : { kind: "lines", lines: [filter === "waiting" ? "No waiting report in this observer snapshot." : "No agents in this observer snapshot."] },
    { kind: "lines", lines: [{ text: filter === "waiting" ? "Presence carries heartbeat time, not how long a task has waited. No blocked-duration estimate is made." : hint, tone: "hint" }] }] }] };
  }
  if (filter === "channels") return { sections: [{ title: "Observed channels", blocks: [snapshot.channels.length ? {
    kind: "table", columns: [{ key: "channel", label: "Channel" }, { key: "retained", label: "Retained count" }, { key: "arrivals", label: "Observed arrivals" }],
    rows: snapshot.channels.map((row) => ({ channel: `#${row.channel}`, retained: String(row.messages), arrivals: String(row.arrivals) })),
  } : { kind: "lines", lines: ["No channels in the current observer model."] }, { kind: "lines", lines: [{ text: "Counts come from MeshView's broker reads and this observer's arrivals. Retention may cap a count; arrivals are not a complete history count.", tone: "hint" }] }] }] };
  if (filter === "topology") {
    const feed = snapshot.membership.snapshot;
    const names = new Map([...snapshot.agents, ...snapshot.endpoints].map((row) => [row.card.id, row.card.name]));
    return { sections: [{ title: "Observed subscription topology", blocks: [
      { kind: "fields", rows: [["Membership poll", feed?.asOf === undefined ? "not established" : new Date(feed.asOf).toISOString()], ["Latest membership read", snapshot.membership.unreadable ? "failed; last snapshot retained" : feed?.asOf === undefined ? "not established" : "snapshot available"]] },
      feed?.members.length ? { kind: "table", columns: [{ key: "name", label: "Participant" }, { key: "id", label: "Identity" }, { key: "live", label: "Observed live patterns" }, { key: "durable", label: "Durable channels" }], rows: feed.members.map((row) => ({ name: names.get(row.id) ?? "name not observed", id: row.id, live: row.live.join(", ") || "none recorded", durable: row.durable.join(", ") || "none recorded" })) } : { kind: "lines", lines: [feed?.asOf === undefined ? "Membership is not established; an empty graph cannot be inferred." : "No member rows in the last successful membership snapshot."] },
      { kind: "lines", lines: [{ text: "Broker-derived subscription patterns and durable membership, not authorization grants, task dependencies or agent success. Wildcards remain patterns rather than invented edges.", tone: "hint" }] },
    ] }] };
  }
  return { sections: [{ title: filter === "dms" ? "Authorized direct-message observations" : `Observed ${filter}`, blocks: [
    { kind: "lines", lines: snapshot.feed.filter((entry) => matchesWatchFilter(entry, filter)).map(feedLine) },
    { kind: "lines", lines: [{ text: hint, tone: "hint" }] },
  ] }] };
}
