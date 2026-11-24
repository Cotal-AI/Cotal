import { peerLabel, presenceText, type FlagSpec, type ParsedArgs, type Presence, type PresenceStamps } from "@cotal-ai/core";
import { brokerAddressForDisplay, jsonFlag, recordOperationSpace, plainFlag, presentationOf, renderReport, targetFlags, writeResult, type Report } from "@cotal-ai/workspace";
import { activityAge, presenceFacts } from "../ui.js";
import { onRerun } from "../lib/control.js";
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
  const values = args.values as ConnectValues;
  const { ep, space, connection } = await openTransient(values, "endpoints", { throwOnRefusal: true });
  recordOperationSpace(space);
  let items: Row[];
  try {
    await ep.waitForPresenceSnapshot();
    items = rowsOf(ep.getRoster());
  } finally { await ep.stop(); }
  const format = presentation === "plain" ? ["--plain"] : [];
  const rosterCommand = values.server !== undefined && brokerAddressForDisplay(values.server) !== values.server ? null :
    onRerun("cotal who", values, [...(values.creds === undefined ? [] : [`--creds=${values.creds}`]), ...format]);
  // Native contract reads need a registered, authenticated target and cannot reuse a raw presence credential.
  const describeCommand = (connection.mode !== "auth" && connection.mode !== "user") || connection.source === "local-space" || brokerAddressForDisplay(connection.server) !== connection.server ? null :
    onRerun("cotal endpoint describe <endpoint>", { space, server: connection.server }, format);
  writeResult(presentation, { command: "endpoints", target: { space }, result: { kind: "live-presence", scope: "authorized live presence including agents and infrastructure", items } }, (result) => endpointsView(result.items, space, rosterCommand, describeCommand));
}

export function printEndpoints(roster: Presence[], space: string): void {
  console.log(renderReport(endpointsView(rowsOf(roster), space), "rich", process.stdout));
}

function endpointsView(items: readonly Row[], space: string, rosterCommand: string | null = "cotal who", describeCommand: string | null = null): Report {
  return { sections: [
    { title: `Live presence · ${space}`, blocks: [items.length ? {
      kind: "table",
      columns: [{ key: "name", label: "Participant" }, { key: "role", label: "Role" }, { key: "kind", label: "Kind" }, { key: "state", label: "Reported state" }, { key: "activity", label: "Activity" }, { key: "id", label: "Identity" }],
      rows: items.map((item) => ({
        // The bare name, which `endpoint describe` takes; the role has its own column. A blank
        // name or role is not a label.
        name: { text: item.name.trim() ? peerLabel({ name: item.name }) : item.id, tone: "command" },
        role: item.role !== null && item.role.trim() ? peerLabel({ name: item.role }) : "none",
        kind: item.kind ?? "not reported",
        state: { text: `${item.reportedStatus === "working" ? "working · progress unknown" : item.reportedStatus}${factsText(item)}`, tone: item.reportedStatus === "waiting" ? "waiting" : "hint" },
        activity: item.activity && item.activity.trim() ? `${presenceText(item.activity)}${activityAge(stampsOf(item))}` : "not reported",
        id: item.id,
      })),
    } : { kind: "lines", lines: ["No participants in this presence snapshot."] },
    { kind: "lines", lines: [{ text: "Live presence includes agents and infrastructure. It is not the saved-reference or service-registration inventory, and reported activity is not task completion.", tone: "hint" }] }] },
    { title: "Next", blocks: [
      ...(rosterCommand === null ? [{ kind: "lines" as const, lines: ["To read the agent roster, run `cotal who` with the same target flags."] }] : []),
      { kind: "commands", items: [
        ...(rosterCommand === null ? [] : [{ command: rosterCommand, description: "Read the agent roster and its reported work signals" }]),
        ...(describeCommand === null ? [] : [{ command: describeCommand, description: "Resolve a native endpoint's verified command contract" }]),
      ] },
      ...(describeCommand === null ? [{ kind: "lines" as const, lines: ["To read a verified contract, run `cotal endpoint describe` with the same `--space` and `--server` on a registered authenticated target. If you pass `--creds`, use a paired native caller file, not a presence credential."] }] : []),
    ] },
  ] };
}
