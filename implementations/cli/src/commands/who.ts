import { peerLabel, type FlagSpec, type FlagValues, type ParsedArgs, type Presence, type PresenceCondition } from "@cotal-ai/core";
import { CommandFailure, isCommandFailure, isConnectRefusal, isMeshRegistryError, jsonFlag, plainFlag, presentationOf, targetFlags, writeResult, type Cell, type Column, type OutputWarning, type Report, type Styled } from "@cotal-ai/workspace";
import { openTransient } from "../lib/transient.js";
import { registryFailure } from "../lib/registry-errors.js";
import { activityAge, c, presenceFacts } from "../ui.js";
import { readSeats, type SeatCensus } from "./agents.js";

const waitingFlag = { name: "waiting", type: "boolean", description: "only rows that are waiting or report a condition" } as const;
const allFlag = { name: "all", type: "boolean", description: "also list infrastructure endpoints such as the manager" } as const;
export const whoFlags = [...targetFlags, waitingFlag, allFlag, jsonFlag, plainFlag] as const satisfies readonly FlagSpec[];

/** How long `who` waits for the presence watch's first snapshot before it reports the roster incomplete. */
const SNAPSHOT_MS = 3_000;

/** One participant as `who` reports it. `managed` is whether a manager answered for this seat: `null`
 *  when no answering manager could say (and for infrastructure endpoints, which no manager runs). */
export interface WhoRow {
  readonly name: string;
  readonly id: string;
  readonly role: string | null;
  readonly kind: string;
  readonly status: Presence["status"];
  readonly condition: PresenceCondition | null;
  readonly activity: string | null;
  readonly statusSince: string | null;
  readonly activeAt: string | null;
  readonly attention: string | null;
  readonly harness: string | null;
  readonly model: string | null;
  readonly host: string | null;
  readonly managed: boolean | null;
  readonly lifecycleUid: string | null;
}

/** What `cotal who` read. `managers` says how `managed` was decided: no manager on the roster, every
 *  manager answered, only some did, this identity may not ask them, or the census could not be read. */
export interface WhoResult {
  readonly kind: "roster";
  readonly view: "current" | "stale" | "unpopulated";
  readonly managers: "none-present" | "complete" | "partial" | "denied" | "unread";
  readonly hidden: number;
  readonly items: WhoRow[];
}

const iso = (ms: number | undefined): string | null => (typeof ms === "number" && Number.isFinite(ms) ? new Date(ms).toISOString() : null);
const metaText = (p: Presence, key: string): string | null => {
  const value = p.card.meta?.[key];
  return typeof value === "string" && value ? value : null;
};
const isManager = (p: Presence): boolean => p.card.kind === "endpoint" && p.card.role === "manager" && p.status !== "offline";

/** What one manager census says about each seat, matched on the seat's incarnation. A seat a manager
 *  listed is managed. Only a census where every registered instance answered can say a seat is not:
 *  one manager (user mode, which answers for the caller's own seats) or an incomplete census leaves
 *  every other seat unknown, and says so. `warnings` are the parts the census could not read;
 *  `labels` say how far the identity's grant reached, which is not a part left unread. */
export function judgeSeats(census: Pick<SeatCensus, "items" | "target" | "partial" | "warnings">): {
  managers: "complete" | "partial";
  runs: (p: Pick<Presence, "lifecycleUid">) => boolean | null;
  warnings: OutputWarning[];
  labels: OutputWarning[];
} {
  const uids = new Set(census.items.map((row) => (row as { lifecycleUid?: unknown }).lifecycleUid).filter((uid): uid is string => typeof uid === "string"));
  const everyManager = census.target.scope === "all-managers" && !census.partial;
  const labels: OutputWarning[] = [];
  if (!everyManager && !census.partial)
    labels.push({ code: "MANAGED_SCOPE", target: census.target, message: "the manager answered for this identity's own seats only, so other seats show managed as unknown" });
  return {
    managers: everyManager ? "complete" : "partial",
    runs: (p) => (p.lifecycleUid !== undefined && uids.has(p.lifecycleUid) ? true : everyManager ? false : null),
    warnings: [...census.warnings],
    labels,
  };
}

/** `cotal who`: the live roster of the selected space, with whether a manager runs each seat. */
export async function who(args: ParsedArgs): Promise<void> {
  const v = args.values as FlagValues<typeof whoFlags>;
  const presentation = presentationOf(v);
  const scope = v.all ? "all" : v.waiting ? "waiting" : "agents";
  const warnings: OutputWarning[] = [];
  // How far this identity's grant reaches. The roster is still read in full, so these are reported
  // with the warnings but do not make the run partial.
  const labels: OutputWarning[] = [];
  const errors: string[] = [];
  const { ep, space } = await openTransient(v, "who", {
    throwOnRefusal: true,
    report: (level, e) => (level === "error" ? errors.push(e.message) : console.error(c.yellow(`! ${e.message}`))),
  }).catch((e: unknown) => {
    if (isMeshRegistryError(e)) throw registryFailure(e);
    if (isConnectRefusal(e) || isCommandFailure(e)) throw e;
    const message = e instanceof Error ? e.message : String(e);
    if (/permission/i.test(message))
      throw new CommandFailure("refused", "PERMISSION_DENIED", `this identity may not read the roster: ${message}`);
    throw new CommandFailure("failed", "OPERATION_FAILED", `could not open the roster: ${message}`);
  });
  const target = { space, scope };
  let roster: Presence[];
  let view: WhoResult["view"];
  try {
    await ep.waitForPresenceSnapshot(SNAPSHOT_MS);
    const pv = ep.presenceView();
    view = pv.state;
    roster = ep.getRoster();
    if (pv.state === "unpopulated")
      warnings.push({ code: "ROSTER_INCOMPLETE", target, message: `the roster snapshot did not finish within ${SNAPSHOT_MS / 1000}s, so rows may be missing` });
    if (pv.state === "stale")
      warnings.push({ code: "ROSTER_STALE", target, message: `no presence update arrived within the liveness window, so rows are last-known as of ${iso(pv.staleSince)}` });
    for (const message of errors) warnings.push({ code: "ROSTER_ERROR", target, message });
  } finally {
    await ep.stop();
  }

  // Whether a manager runs a seat is the managers' answer, matched on the seat's incarnation. With no
  // manager on the roster none can be running one, so nothing is asked.
  let managers: WhoResult["managers"] = "none-present";
  let runs = (_p: Presence): boolean | null => false;
  if (roster.some(isManager)) {
    try {
      const judged = judgeSeats(await readSeats(v, "ps", undefined));
      managers = judged.managers;
      runs = judged.runs;
      warnings.push(...judged.warnings);
      labels.push(...judged.labels);
    } catch (e) {
      if (!isCommandFailure(e) && !isConnectRefusal(e)) throw e;
      const failure = isConnectRefusal(e) ? e.failure() : e;
      runs = () => null;
      if (failure.code === "PERMISSION_DENIED") {
        managers = "denied";
        labels.push({ code: "MANAGERS_DENIED", target, message: "this identity may not ask the managers which seats they run, so every seat shows managed as unknown" });
      } else {
        managers = "unread";
        warnings.push({ code: "MANAGERS_UNREAD", target, message: `could not ask the managers which seats they run: ${failure.message}` });
      }
    }
  }

  const counts = new Map<string, number>();
  for (const p of roster) counts.set(p.card.name.toLowerCase(), (counts.get(p.card.name.toLowerCase()) ?? 0) + 1);
  const listed = roster.filter((p) => v.all || p.card.kind !== "endpoint");
  const items = listed
    .filter((p) => !v.waiting || p.status === "waiting" || p.condition !== undefined)
    .map((p): WhoRow => ({
      name: p.card.name,
      id: p.card.id,
      role: p.card.role ?? null,
      kind: p.card.kind ?? "endpoint",
      status: p.status,
      condition: p.condition ?? null,
      activity: p.activity ?? null,
      statusSince: iso(p.statusSince),
      activeAt: iso(p.activeAt),
      attention: p.attention ?? null,
      harness: metaText(p, "connector"),
      model: metaText(p, "model"),
      host: metaText(p, "host"),
      managed: p.card.kind === "endpoint" ? null : runs(p),
      lifecycleUid: p.lifecycleUid ?? null,
    }))
    .sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
  const result: WhoResult = { kind: "roster", view, managers, hidden: roster.length - listed.length, items };
  const unread = warnings.length;
  writeResult(
    presentation,
    {
      command: "who",
      target,
      result,
      completeness: unread ? "partial" : "complete",
      warnings: [...warnings, ...labels],
      ...(unread ? { partial: { message: `who could not read ${unread === 1 ? "one part" : `${unread} parts`} of what it reports; the warnings name ${unread === 1 ? "it" : "each"}` } } : {}),
    },
    (r) => whoView(r, space, Boolean(v.all), (name) => (counts.get(name.toLowerCase()) ?? 0) > 1, roster),
  );
}

const STATUS_TONE: Record<Presence["status"], Styled["tone"]> = { working: "ok", waiting: "waiting", idle: undefined, offline: "hint" };
const STATUS_MARK: Record<Presence["status"], string> = { working: "●", waiting: "◐", idle: "○", offline: "⨯" };

function whoView(r: WhoResult, space: string, all: boolean, duplicate: (name: string) => boolean, roster: readonly Presence[]): Report {
  const now = Date.now();
  const byId = new Map(roster.map((p) => [p.card.id, p]));
  const columns: Column[] = [
    { key: "name", label: "Agent" },
    ...(all ? [{ key: "kind", label: "Kind" }] : []),
    { key: "status", label: "State" },
    { key: "attention", label: "Attention" },
    { key: "harness", label: "Application" },
    { key: "model", label: "Model" },
    { key: "host", label: "Host" },
    { key: "managed", label: "Managed" },
    { key: "activity", label: "Activity" },
  ];
  const rows = r.items.map((row): Record<string, Cell> => {
    const p = byId.get(row.id);
    const facts = p ? presenceFacts(p, now) : { condition: "", ages: "" };
    const label = peerLabel({ name: row.name, ...(row.role ? { role: row.role } : {}) });
    return {
      name: duplicate(row.name) ? `${label} [${row.id}]` : label,
      kind: row.kind,
      status: { text: `${row.status === "working" ? "working · progress unknown" : row.status}${facts.condition}`, tone: STATUS_TONE[row.status], mark: STATUS_MARK[row.status] },
      attention: row.attention ?? "-",
      harness: row.harness ?? "-",
      model: row.model ?? "-",
      host: row.host ?? "-",
      managed: row.managed === null ? (row.kind === "endpoint" ? "-" : { text: "unknown", tone: "waiting" }) : row.managed ? "yes" : "no",
      activity: `${row.activity ?? ""}${p && row.activity ? activityAge(p, now) : ""}${facts.ages.replace(/^ · /, row.activity ? " · " : "")}` || "-",
    };
  });
  const notes: Cell[] = [];
  if (!r.items.length) notes.push({ text: `no ${all ? "participants" : "agents"} present in ${space}`, tone: "hint" });
  if (r.hidden && !all) notes.push({ text: `${r.hidden} infrastructure ${r.hidden === 1 ? "endpoint is" : "endpoints are"} not listed; \`cotal who --all\` lists them`, tone: "hint" });
  return {
    sections: [
      {
        title: `Who's here · ${space}`,
        blocks: [
          ...(r.items.length ? [{ kind: "table" as const, columns, rows }] : []),
          ...(notes.length ? [{ kind: "lines" as const, lines: notes }] : []),
        ],
      },
    ],
  };
}
