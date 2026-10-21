import { peerLabel, presenceText, type FlagSpec, type ParsedArgs, type Presence } from "@cotal-ai/core";
import { jsonFlag, plainFlag, presentationOf, renderReport, targetFlags, terminalWidth, writeResult, type Report } from "@cotal-ai/workspace";
import { activityAge, presenceFacts } from "../ui.js";
import { openTransient, type ConnectValues } from "../lib/transient.js";

export const endpointsFlags = [...targetFlags, jsonFlag, plainFlag] as const satisfies readonly FlagSpec[];

function rowsOf(roster: readonly Presence[]) {
  return roster.map((presence) => ({
    name: presence.card.name,
    label: peerLabel(presence.card),
    id: presence.card.id,
    kind: presence.card.kind,
    role: presence.card.role ?? null,
    reportedStatus: presence.status,
    facts: presenceFacts(presence),
    activity: presence.activity ?? null,
    activityAge: activityAge(presence),
  })).sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
}

/** Authorized live presence, not the endpoint-registration or saved-reference inventory. */
export async function endpoints(args: ParsedArgs): Promise<void> {
  const presentation = presentationOf(args.values);
  const { ep, space } = await openTransient(args.values as ConnectValues, "endpoints", { throwOnRefusal: true });
  let items: ReturnType<typeof rowsOf>;
  try {
    await ep.waitForPresenceSnapshot();
    items = rowsOf(ep.getRoster());
  } finally { await ep.stop(); }
  writeResult(presentation, { command: "endpoints", target: { space }, result: { kind: "live-presence", scope: "authorized live presence including agents and infrastructure", items } }, (result) => endpointsView(result.items, space));
}

export function printEndpoints(roster: Presence[], space: string): void {
  console.log(renderReport(endpointsView(rowsOf(roster), space), "rich", terminalWidth(process.stdout)));
}

function endpointsView(items: ReturnType<typeof rowsOf>, space: string): Report {
  return { sections: [
    { title: `Live presence · ${space}`, blocks: [items.length ? {
      kind: "table",
      columns: [{ key: "name", label: "Participant" }, { key: "kind", label: "Kind" }, { key: "state", label: "Reported state" }, { key: "activity", label: "Activity" }, { key: "id", label: "Identity" }],
      rows: items.map((item) => ({
        name: { text: item.label, tone: "command" },
        kind: item.kind ?? "not reported",
        state: { text: `${item.reportedStatus === "working" ? "working · progress unknown" : item.reportedStatus}${item.facts.condition}${item.facts.ages}`, tone: item.reportedStatus === "waiting" ? "waiting" : "hint" },
        activity: item.activity ? `${presenceText(item.activity)}${item.activityAge}` : "not reported",
        id: item.id,
      })),
    } : { kind: "lines", lines: ["No participants in this presence snapshot."] },
    { kind: "lines", lines: [{ text: "Live presence includes agents and infrastructure. It is not the saved-reference or service-registration inventory, and reported activity is not task completion.", tone: "hint" }] }] },
    { title: "Next", blocks: [{ kind: "commands", items: [{ command: "cotal who", description: "Read the agent roster and its reported work signals" }, { command: "cotal endpoint describe <endpoint>", description: "Resolve a native endpoint's verified command contract" }] }] },
  ] };
}
