import { peerLabel, presenceText, type FlagSpec, type ParsedArgs, type Presence, type PresenceStamps } from "@cotal-ai/core";
import { jsonFlag, recordOperationSpace, plainFlag, presentationOf, renderReport, targetFlags, terminalWidth, writeResult, type Report } from "@cotal-ai/workspace";
import { activityAge, presenceFacts } from "../ui.js";
import { openTransient, type ConnectValues } from "../lib/transient.js";

export const endpointsFlags = [...targetFlags, jsonFlag, plainFlag] as const satisfies readonly FlagSpec[];

const iso = (ms: number | undefined): string | null => (typeof ms === "number" && Number.isFinite(ms) ? new Date(ms).toISOString() : null);
const epoch = (at: string | null): number | undefined => (at === null ? undefined : Date.parse(at));

/** The presence values of each row. The report words the condition and the ages from them. */
function rowsOf(roster: readonly Presence[]) {
  return roster.map((presence) => ({
    name: presence.card.name,
    id: presence.card.id,
    kind: presence.card.kind,
    role: presence.card.role ?? null,
    reportedStatus: presence.status,
    condition: presence.condition ?? null,
    statusSince: iso(presence.statusSince),
    activity: presence.activity ?? null,
    activitySince: presence.activity ? iso(presence.activitySince) : null,
    activeAt: iso(presence.activeAt),
  })).sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
}

type Row = ReturnType<typeof rowsOf>[number];

const stampsOf = (item: Row): PresenceStamps & { condition?: Presence["condition"] } => ({
  condition: item.condition ?? undefined,
  statusSince: epoch(item.statusSince),
  activity: item.activity ?? undefined,
  activitySince: epoch(item.activitySince),
  activeAt: epoch(item.activeAt),
});

const factsText = (item: Row): string => {
  const { condition, ages } = presenceFacts(stampsOf(item));
  return condition + ages;
};

/** Authorized live presence, not the endpoint-registration or saved-reference inventory. */
export async function endpoints(args: ParsedArgs): Promise<void> {
  const presentation = presentationOf(args.values);
  const { ep, space } = await openTransient(args.values as ConnectValues, "endpoints", { throwOnRefusal: true });
  recordOperationSpace(space);
  let items: Row[];
  try {
    await ep.waitForPresenceSnapshot();
    items = rowsOf(ep.getRoster());
  } finally { await ep.stop(); }
  writeResult(presentation, { command: "endpoints", target: { space }, result: { kind: "live-presence", scope: "authorized live presence including agents and infrastructure", items } }, (result) => endpointsView(result.items, space));
}

export function printEndpoints(roster: Presence[], space: string): void {
  console.log(renderReport(endpointsView(rowsOf(roster), space), "rich", terminalWidth(process.stdout)));
}

function endpointsView(items: readonly Row[], space: string): Report {
  return { sections: [
    { title: `Live presence · ${space}`, blocks: [items.length ? {
      kind: "table",
      columns: [{ key: "name", label: "Participant" }, { key: "role", label: "Role" }, { key: "kind", label: "Kind" }, { key: "state", label: "Reported state" }, { key: "activity", label: "Activity" }, { key: "id", label: "Identity" }],
      rows: items.map((item) => ({
        // The bare name, which `endpoint describe` takes; the role has its own column.
        name: { text: peerLabel({ name: item.name }), tone: "command" },
        role: item.role === null ? "none" : peerLabel({ name: item.role }),
        kind: item.kind ?? "not reported",
        state: { text: `${item.reportedStatus === "working" ? "working · progress unknown" : item.reportedStatus}${factsText(item)}`, tone: item.reportedStatus === "waiting" ? "waiting" : "hint" },
        activity: item.activity ? `${presenceText(item.activity)}${activityAge(stampsOf(item))}` : "not reported",
        id: item.id,
      })),
    } : { kind: "lines", lines: ["No participants in this presence snapshot."] },
    { kind: "lines", lines: [{ text: "Live presence includes agents and infrastructure. It is not the saved-reference or service-registration inventory, and reported activity is not task completion.", tone: "hint" }] }] },
    { title: "Next", blocks: [{ kind: "commands", items: [{ command: "cotal who", description: "Read the agent roster and its reported work signals" }, { command: "cotal endpoint describe <endpoint>", description: "Resolve a native endpoint's verified command contract" }] }] },
  ] };
}
