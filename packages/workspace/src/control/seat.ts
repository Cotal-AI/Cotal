import { remoteManagerActors, type Presence } from "@cotal-ai/core";
import { isConnectRefusal, type ConnectFlags } from "../connect.js";
import { resolveControlTarget } from "../control-target.js";
import { DEFAULT_MANAGER_NAME } from "../manager-name.js";
import { CommandFailure, isCommandFailure } from "../output.js";
import { askManager, readFailure, scatterManager, type ControlClient, type ManagerReply, type ScatterInstanceReply } from "./manager.js";

/** The exchange's refusal of an unpinned manager-caller selection while several of the caller's own
 *  managers are live: their count, the owner and the instance ids. */
const SEVERAL_LIVE = /(\d+) live remote manager candidates for owner (\S+) \(([^)]*)\)/;

/** One live manager a refused selection could have chosen, with what presence says about it. */
export interface ManagerCandidate {
  /** The manager's name, or `<host>/<runtime>` for one started without a name. */
  readonly name: string | null;
  readonly instanceId: string;
  readonly host: string | null;
  readonly activity: string | null;
  /** The runtime it spawns agents through, read from its activity; null when presence does not
   *  carry it. */
  readonly runtime: string | null;
  /** Whether a seat it spawns can be attached in a terminal, as it reports: `none` means no
   *  `cotal attach` and no attached foreground spawn can open one there. Null when presence does
   *  not carry it, as for a manager started by a cotal before 0.104.0. */
  readonly terminal: "stream" | "none" | null;
  readonly since: string | null;
}

/** How a manager is shown: the name it was started with, or `<host>/<runtime>` for one left at the
 *  default name, with the runtime read from its `supervisor (<runtime>)` activity. A manager whose
 *  presence names no host, as one started by a cotal before 0.100.0, is shown by its runtime. */
export function managerLabel(p: Presence): string {
  if (p.card.name !== DEFAULT_MANAGER_NAME) return p.card.name;
  const host = presenceHost(p);
  const runtime = presenceRuntime(p);
  return host !== null && runtime ? `${host}/${runtime}` : host ?? runtime ?? p.card.name;
}

const presenceHost = (p: Presence): string | null => typeof p.card.meta?.host === "string" && p.card.meta.host ? p.card.meta.host : null;

/** The runtime a manager reports, read from its `supervisor (<runtime>)` activity. */
const presenceRuntime = (p: Presence): string | null => /^supervisor \((.+)\)$/.exec(p.activity ?? "")?.[1] ?? null;

/** What a manager reports about attaching to its seats' terminals. Only the two values it writes
 *  are taken; anything else, an absent key included, is "it did not say". */
const presenceTerminal = (p: Presence): "stream" | "none" | null =>
  p.card.meta?.terminal === "stream" ? "stream" : p.card.meta?.terminal === "none" ? "none" : null;

export const managerCandidate = (instanceId: string, row: Presence | undefined): ManagerCandidate => ({
  name: row ? managerLabel(row) : null,
  instanceId,
  host: row ? presenceHost(row) : null,
  activity: row?.activity ?? null,
  runtime: row ? presenceRuntime(row) : null,
  terminal: row ? presenceTerminal(row) : null,
  since: row?.runtime ? new Date(row.runtime.startedAt).toISOString() : null,
});

/** The managers `instanceIds` name, as `known` shows them, or by instance id alone. */
export const managersByInstance = (instanceIds: readonly string[], known: readonly ManagerCandidate[] = []): ManagerCandidate[] =>
  instanceIds.map((instanceId) => known.find((m) => m.instanceId === instanceId) ?? managerCandidate(instanceId, undefined));


/** The managers an unpinned manager selection refused to choose between, with what the roster
 *  says about each, or undefined when `failure` is not that refusal. A roster that cannot be read
 *  leaves the instance ids, and `unread` says why: its refusal's message and remedy. */
export async function severalLive(failure: CommandFailure, readRoster: () => Promise<readonly Presence[]>): Promise<{ managers: ManagerCandidate[]; unread?: string } | undefined> {
  const found = failure.code === "PERMISSION_DENIED" ? SEVERAL_LIVE.exec(failure.message) : null;
  if (!found) return undefined;
  const owner = found[2]!;
  const ids = found[3]!.split(",").map((id) => id.trim()).filter(Boolean);
  let roster: readonly Presence[] = [];
  let unread: string | undefined;
  try { roster = await readRoster(); } catch (error) {
    const refusal = isCommandFailure(error) ? error : isConnectRefusal(error) ? error.failure() : undefined;
    const why = refusal ? [refusal.message, refusal.remedy].filter(Boolean).join("; ") : error instanceof Error ? error.message : String(error);
    unread = `names unavailable: ${why}`;
  }
  const managers = ids.map((instanceId) => managerCandidate(instanceId, roster.find((p) => p.card.id === `${owner}.${remoteManagerActors(instanceId).supervisor}` && p.status !== "offline")));
  return { managers, unread };
}

/**
 * WHERE does the named seat live? A `stop` or `attach` can only be served by the manager actually
 * HOSTING the seat, and the class queue does not know which one that is — so without this the verb
 * is answered by whichever instance wins the race and fails on a seat that plainly exists.
 *
 * This is a POSITIVE lookup, not a retry after a miss, and that is forced by measurement: a manager
 * asked about a seat it does not host answers `not-found: no agent "<n>"` — the SAME code and the
 * same message it gives for a name that exists nowhere. "Hosted elsewhere" and "does not exist" are
 * indistinguishable from a single manager's answer, so a caller that retried on a miss would scatter
 * for a typo and, worse, could only ever report the ambiguous message. Asking every instance is the
 * only construction that can tell the two apart — which is also what lets the error finally say
 * which case it is.
 *
 * Costs a second one-shot instrument. The scatter's freeze read belongs to the PRIVILEGED tier;
 * `stop`/`attach` mint ADMIN, which is denied that read deliberately ("the admin tier never
 * scatters"). Rather than widen admin for convenience, the lookup runs as its own privileged
 * instrument and the admin instrument is then minted pinned to the answer.
 *
 * On a user-auth mesh there is no scatter: the exchange refuses an unpinned selection while several
 * of your managers are live, and names them, so each is read as `ps` reads them. `managers` is that
 * set, as presence shows it.
 */
export type SeatLocation =
  | { kind: "pin"; instanceId: string }
  | { kind: "unpinned" } // one instance, or a mode that cannot scatter — no ambiguity to resolve
  /** The registry lists no live manager, so no instance can host the seat or be asked for it. */
  | { kind: "no-manager"; space: string; native: { code?: string; detail: string } }
  /** More than one instance that answered runs a seat of that name; `instances` names them. */
  | { kind: "several"; instances: string[]; space?: string; managers?: readonly ManagerCandidate[] }
  /** Every instance answered and none hosts the seat; `instances` names them. `space` is set by
   *  {@link locateSeat}, which knows it. */
  | { kind: "absent"; checked: number; instances: string[]; space?: string; managers?: readonly ManagerCandidate[] }
  /** #1638 item 3: the search could not settle. At least one registered instance did not answer
   *  FOR ITSELF, so the seat may be sitting on it; absence is not what was established. */
  | { kind: "unknown"; answered: number; silent: string[]; refused: { instanceId: string; error: string }[]; space?: string; managers?: readonly ManagerCandidate[] };

/** Exported for the console, which drives the same targeted verbs (`stop`/`attach`) from
 *  inside a TUI and so needs the THROWING resolve: an unreachable mesh there is a notice on the
 *  status line, never a `process.exit` that blanks the screen. The CLI commands keep the default. */
export async function locateSeat(
  client: ControlClient,
  v: ConnectFlags,
  name: string,
  opts: { onRefusal?: "exit" | "throw" } = {},
): Promise<SeatLocation> {
  // User control authority selects one manager; it does not grant the registry reads needed
  // to scatter. Carry that selection into the targeted command's fresh credential.
  let probe: Awaited<ReturnType<typeof resolveControlTarget>>;
  try {
    probe = await resolveControlTarget(v, "control-caller-privileged", undefined, opts);
  } catch (e) {
    // The exchange would not pick one of your several live managers and named them, so each is asked
    // which seats it runs, as `ps` reads them. A manager whose read fails has not answered for itself.
    const managers = await refusedManagers(client, e, v);
    if (!managers) throw e;
    let space: string | undefined;
    const instances: ScatterInstanceReply[] = [];
    for (const manager of managers) {
      try {
        const asked = await askYourManagers(client, v, "ps", [manager]);
        space ??= asked.space;
        instances.push(...asked.instances);
      } catch (error) {
        instances.push({ instanceId: manager.instanceId, reachable: true, error: error instanceof Error ? error.message : String(error) });
      }
    }
    const loc = locateSeatIn(instances, name);
    return loc.kind === "several" || loc.kind === "absent" || loc.kind === "unknown" ? { ...loc, ...(space !== undefined ? { space } : {}), managers } : loc;
  }
  if (probe.auth.managerInstanceId !== undefined) return { kind: "pin", instanceId: probe.auth.managerInstanceId };
  if (probe.auth.bearer) return { kind: "unpinned" };
  const scatter = await scatterManager(client, probe.space, probe.server, "ps", probe.auth, probe.spaceAuth);
  if (!scatter.ok && scatter.noLiveManager) return { kind: "no-manager", space: probe.space, native: { code: scatter.code, detail: scatter.error } };
  if (!scatter.ok) return { kind: "unpinned" }; // cannot locate ⇒ behave exactly as before, never worse
  const loc = locateSeatIn(scatter.instances, name);
  return loc.kind === "several" || loc.kind === "absent" || loc.kind === "unknown" ? { ...loc, space: probe.space } : loc;
}

/**
 * WHAT THE SCATTER ESTABLISHED about one seat name — the whole decision, as a function of the rows
 * alone, so it is gradable without a broker.
 *
 * ANSWERED FOR ITSELF means an instance returned its own roster. A slot that never answered and one
 * that answered with a REFUSAL are the same fact for this search: neither stated which seats it
 * hosts, so neither licenses a conclusion about a seat that might be sitting on it (#1638 item 3).
 * The refusal half is the reachable-but-errored row `scatterManager` reports, which the older
 * filter counted as a manager that had looked and found nothing.
 *
 * Absence is a claim about the WHOLE space, so it is concluded only when the whole space answered.
 * A name that more than one answering instance runs picks none of them.
 */
export function locateSeatIn(instances: readonly ScatterInstanceReply[], name: string): SeatLocation {
  const reachable = instances.filter((i) => i.reachable);
  const silent = instances.filter((i) => !i.reachable).map((i) => i.instanceId);
  if (reachable.length <= 1 && !silent.length) return { kind: "unpinned" };
  const answered = reachable.filter((i) => i.error === undefined);
  const refused = reachable.filter((i) => i.error !== undefined).map((i) => ({ instanceId: i.instanceId, error: i.error as string }));
  const hosts = answered.filter((i) => ((i.data as { name?: unknown }[] | undefined) ?? []).some((r) => r.name === name));
  if (hosts.length === 1) return { kind: "pin", instanceId: hosts[0]!.instanceId };
  if (hosts.length > 1) return { kind: "several", instances: hosts.map((i) => i.instanceId).sort() };
  if (silent.length || refused.length) return { kind: "unknown", answered: answered.length, silent, refused };
  return { kind: "absent", checked: answered.length, instances: answered.map((i) => i.instanceId).sort() };
}

/** The console's wording for a seat the whole space proved absent. Main's richer `seatMissRefusal`
 *  needs the `unknown` variant too; the console (and `attachSeat`'s returned verdict) only ever
 *  hold a proved `absent`, so this stays the narrow shape their call sites guarantee. */
export function seatNotFoundMessage(loc: { checked: number }, name: string, verb?: string): string {
  const remedy = verb ? ` To address it directly: \`${verb} --on <instance>\` (the whole id, as printed).` : "";
  return `no managed agent "${name}" on any of the ${loc.checked} reachable manager instance(s) in this space.${remedy}`;
}

/**
 * What a `stop`/`attach`/`input` that did not find its seat TELLS the operator — and the difference
 * between the two things it can mean (#1638 item 3).
 *
 * ABSENT is a claim about the whole space and is only made when the whole space answered for
 * itself. A registration that gave no answer within the deadline is NOT told to "retry": a manager
 * whose host died never deregisters, so its row stays in the registry indefinitely and answers
 * nothing, and a retry against it loops forever. Say what is known (registered, silent), what it
 * may mean (a live slow host OR a dead registration), and the two real actions.
 *
 * UNKNOWN is the other case and it used to print as the first one. The seat may be sitting on the
 * instance that did not answer, so "no managed agent <name>" was a definite negative drawn from an
 * incomplete search — and it names the instance COUNT, which is the shape a reader believes.
 * Measured on a live mesh: a seat that `ps` listed as running the whole time was reported absent,
 * and the same command with `--on` succeeded first time. A retry loop that reads the old sentence
 * as "already gone" stops looking for a seat that is still running.
 *
 * SEVERAL names each instance that runs a seat of that name, since picking one would act on a seat
 * the operator may not mean.
 */
export function seatMissRefusal(
  name: string,
  verb: string,
  loc: Extract<SeatLocation, { kind: "absent" | "unknown" | "several" }>,
): string {
  const address = `To address one directly: \`${verb} --on <instance>\` (the whole id, as printed).`;
  if (loc.kind === "several")
    return `"${name}" is held on each of ${loc.instances.length} manager instances (${loc.instances.join(", ")}), so this command does not pick one. ${address}`;
  if (loc.kind === "absent")
    return `no managed agent "${name}" on any of the ${loc.checked} reachable manager instance(s) in this space (${loc.instances.join(", ")}).`;
  const silent = loc.silent.length
    ? ` ${loc.silent.length} registered manager instance(s) gave no answer within the deadline (${loc.silent.join(", ")}). Either that host is alive but slow, or it died and its registration was never removed; if it is dead, deregister it.`
    : "";
  const refused = loc.refused.length
    ? ` ${loc.refused.length} refused the read rather than answering (${loc.refused.map((r) => `${r.instanceId}: ${r.error}`).join("; ")}).`
    : "";
  return `could not establish where "${name}" is: ${loc.answered} manager instance(s) answered and none hosts it, but ${loc.silent.length + loc.refused.length} did not answer for themselves, so this is NOT a report that it is gone — it may be running on one of those.${silent}${refused} ${address}`;
}

/** A manager read that failed, as the classified failure. For a user-mode manager view that the
 *  broker refused before any responder saw the call, the broker does not say which row was missing,
 *  so this names the documented requirement for these reads instead of asserting a cause, and keeps
 *  the native refusal as it was. A refusal the manager answered, such as a retiring caller's, already
 *  states its own reason. */
export function managerReadFailure(reply: ManagerReply, target: Record<string, unknown>, command: string, userAuth: boolean): CommandFailure {
  const failure = readFailure(reply, target);
  if (!userAuth || failure.code !== "PERMISSION_DENIED" || reply.nativeOutcome !== "not-executed" || reply.answered) return failure;
  return new CommandFailure(failure.outcome, failure.code, failure.message, {
    target,
    remedy: `on a user-auth mesh, the manager's \`${command}\` read is documented to need the \`admin\` scope on your actor grant; \`spawn\` alone does not carry it. Check what your row holds with \`cotal auth grants\``,
    ...(failure.native ? { native: failure.native } : {}),
  });
}

/** The managers an unpinned manager selection refused to choose between, when `e` is that refusal. */
export async function refusedManagers(client: ControlClient, e: unknown, v: ConnectFlags): Promise<ManagerCandidate[] | undefined> {
  const failure = isCommandFailure(e) ? e : isConnectRefusal(e) ? e.failure() : undefined;
  return failure ? (await severalLive(failure, () => client.roster(v)))?.managers : undefined;
}

/** Each of `managers` asked `command` through its own one-instance view, one after another, as the
 *  slots of a class scatter: the rows of one that answered, the refusal of one that answered with an
 *  error, and as silent one that did not answer or whose view was refused. The host its presence
 *  reports is kept for display. A read the broker refused before any manager saw it is thrown,
 *  because every view of the same grant is refused the same way. */
export async function askYourManagers(client: ControlClient, v: ConnectFlags, command: "ps" | "slots", managers: readonly ManagerCandidate[]): Promise<{ space?: string; mode?: string; instances: ScatterInstanceReply[] }> {
  let space: string | undefined, mode: string | undefined;
  const instances: ScatterInstanceReply[] = [];
  for (const { instanceId, host } of managers) {
    let t: Awaited<ReturnType<typeof resolveControlTarget>>;
    try {
      t = await resolveControlTarget(v, "control-caller-privileged", instanceId, { onRefusal: "throw" });
    } catch (e) {
      if (!isCommandFailure(e) && !isConnectRefusal(e)) throw e;
      instances.push({ instanceId, reachable: false });
      continue;
    }
    space ??= t.space;
    mode ??= t.mode;
    const reply = await askManager(client, t.space, t.server, command, undefined, t.auth, "owner", undefined, { instanceId });
    if (reply.ok) instances.push({ instanceId, reachable: true, data: reply.data, ...(host ? { reportedHost: host } : {}) });
    else if (reply.answered) instances.push({ instanceId, reachable: true, error: reply.error ?? "the manager refused the read", ...(reply.code ? { code: reply.code } : {}) });
    else if (reply.unanswered) instances.push({ instanceId, reachable: false });
    else throw managerReadFailure(reply, { space: t.space, scope: "manager", managerInstanceId: instanceId }, command, true);
  }
  return { ...(space !== undefined ? { space } : {}), ...(mode !== undefined ? { mode } : {}), instances };
}
