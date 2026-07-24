import type { ParsedArgs, Presence } from "@cotal-ai/core";
import { openTransient, type ConnectValues } from "../lib/transient.js";
import { c, offlineDetail, statusBadge } from "../ui.js";

/** List the mesh presence roster, including infrastructure endpoints such as the manager. */
export async function endpoints(args: ParsedArgs): Promise<void> {
  const { ep, space } = await openTransient(args.values as ConnectValues, "endpoints");
  try {
    await ep.waitForPresenceSnapshot();
    printEndpoints(ep.getRoster(), space);
  } finally {
    await ep.stop();
  }
}

export function printEndpoints(roster: Presence[], space: string): void {
  if (!roster.length) {
    console.log(c.dim(`(no endpoints present in "${space}")`));
    return;
  }

  const counts = new Map<string, number>();
  for (const presence of roster) {
    const name = presence.card.name.toLowerCase();
    counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  const rows = roster
    .map((presence) => {
      const role = presence.card.role ? `/${presence.card.role}` : "";
      const duplicate = (counts.get(presence.card.name.toLowerCase()) ?? 0) > 1;
      return {
        presence,
        label: `${presence.card.name}${role}${duplicate ? ` [${presence.card.id}]` : ""}`,
        kind: presence.card.kind ?? "endpoint",
      };
    })
    .sort((a, b) => a.label.localeCompare(b.label));
  const labelWidth = Math.max(...rows.map((row) => row.label.length));
  const kindWidth = Math.max(...rows.map((row) => row.kind.length));
  for (const row of rows) {
    // An offline row must read as dead (issue #286): presence retains activity/ts on offline by
    // design, so qualify them — `last seen <relative>` plus `was: <activity>` — never a bare
    // activity that renders exactly like a live agent's.
    const detail =
      row.presence.status === "offline"
        ? `  ${c.dim(offlineDetail(row.presence))}`
        : row.presence.activity
          ? `  ${c.dim(row.presence.activity)}`
          : "";
    console.log(`${c.bold(row.label.padEnd(labelWidth))}  ${c.dim(row.kind.padEnd(kindWidth))}  ${statusBadge(row.presence.status)}${detail}`);
  }
}
