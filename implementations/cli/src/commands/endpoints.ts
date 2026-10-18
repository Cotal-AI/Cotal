import { peerLabel, presenceText, unaddressableByName, type ParsedArgs, type Presence } from "@cotal-ai/core";
import { openTransient, type ConnectValues } from "../lib/transient.js";
import { activityAge, c, presenceDetail, statusBadge } from "../ui.js";

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

  // `cotal send dm` resolves from a transient that never joins the roster, so no row is self.
  const needsId = unaddressableByName(roster);
  const rows = roster
    .map((presence) => ({
      presence,
      label: `${peerLabel(presence.card)}${needsId.has(presence.card.id) ? ` [${presence.card.id}]` : ""}`,
      kind: presence.card.kind ?? "endpoint",
    }))
    .sort((a, b) => a.label.localeCompare(b.label));
  const labelWidth = Math.max(...rows.map((row) => row.label.length));
  const kindWidth = Math.max(...rows.map((row) => row.kind.length));
  for (const row of rows) {
    const activity = row.presence.activity ? `  ${c.dim(presenceText(row.presence.activity) + activityAge(row.presence))}` : "";
    const condition = presenceDetail(row.presence);
    console.log(`${c.bold(row.label.padEnd(labelWidth))}  ${c.dim(row.kind.padEnd(kindWidth))}  ${statusBadge(row.presence.status)}${condition}${activity}`);
  }
}
