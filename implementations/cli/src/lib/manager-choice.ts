import { BASELINE_LIFECYCLE_ENDPOINT, invokeCommand, remoteManagerActors, resolveService, type Presence } from "@cotal-ai/core";
import { CommandFailure, DEFAULT_MANAGER_NAME, instanceIdShaped, renderReport, resolveMeshTarget, terminalWidth } from "@cotal-ai/workspace";
import { askManager, liveManagerIds, onInstance, onInstanceId, resolveControlTarget } from "./control.js";
import { openEndpointConnection } from "./endpoint-client.js";
import { shellWord } from "./endpoint-errors.js";
import { displayCmd } from "./self-exec.js";
import { openTransient } from "./transient.js";

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
  readonly since: string | null;
}

/** How a manager is shown: the name it was started with, or `<host>/<runtime>` for one left at the
 *  default name, with the runtime read from its `supervisor (<runtime>)` activity. A manager whose
 *  presence names no host, as one started by a cotal before 0.100.0, is shown by its runtime. */
export function managerLabel(p: Presence): string {
  if (p.card.name !== DEFAULT_MANAGER_NAME) return p.card.name;
  const host = presenceHost(p);
  const runtime = /^supervisor \((.+)\)$/.exec(p.activity ?? "")?.[1];
  return host !== null && runtime ? `${host}/${runtime}` : host ?? runtime ?? p.card.name;
}

const presenceHost = (p: Presence): string | null => typeof p.card.meta?.host === "string" && p.card.meta.host ? p.card.meta.host : null;

const candidateOf = (instanceId: string, row: Presence | undefined): ManagerCandidate => ({
  name: row ? managerLabel(row) : null,
  instanceId,
  host: row ? presenceHost(row) : null,
  activity: row?.activity ?? null,
  since: row?.runtime ? new Date(row.runtime.startedAt).toISOString() : null,
});

/** Whether `selector` names `manager`: its given name, its host, or the `<host>/<runtime>` it is
 *  shown as. The default name "manager" names none of them. */
const selects = (manager: ManagerCandidate, selector: string): boolean =>
  (manager.name === selector && selector !== DEFAULT_MANAGER_NAME) || manager.host === selector;

/** The shortest `--on` value that picks `manager` out of `managers`: its name, its host, or its
 *  instance id. */
function selectorFor(manager: ManagerCandidate, managers: readonly ManagerCandidate[]): string {
  for (const selector of [manager.name, manager.host]) {
    if (selector !== null && selects(manager, selector) && managers.filter((m) => selects(m, selector)).length === 1) return selector;
  }
  return manager.instanceId;
}

/** The roster of the space `values` resolve to, read once. */
export async function rosterOf(values: { space?: string; server?: string }): Promise<Presence[]> {
  const { ep } = await openTransient(values, "manager-candidates", { throwOnRefusal: true, report: () => {} });
  try { return ep.getRoster(); } finally { await ep.stop().catch(() => {}); }
}

/** A `--on` name or host that picks no single live manager, with the managers it could mean. */
export class ManagerPinUnmatched extends CommandFailure {
  constructor(readonly selector: string, readonly managers: readonly ManagerCandidate[], matched: number) {
    super("refused", matched ? "TARGET_AMBIGUOUS" : "TARGET_NOT_FOUND", matched
      ? `--on ${selector} matches ${matched} live managers, so it does not pick one`
      : `--on ${selector} is not the name, host or instance id of a live manager of yours`, {
      target: { on: selector },
      native: { detail: { managers } },
      remedy: managers.length ? "rerun it with --on naming one of the managers listed" : "start a manager with cotal supervise, then rerun it",
    });
  }
}

const targetFlags = (values: { space?: unknown; server?: unknown }) =>
  ({ ...(typeof values.space === "string" ? { space: values.space } : {}), ...(typeof values.server === "string" ? { server: values.server } : {}) });

/** Your live managers on the user-auth mesh `flags` resolve to, as presence shows them. */
async function yourLiveManagers(flags: { space?: string; server?: string }): Promise<ManagerCandidate[]> {
  const { ep, connection } = await openTransient(flags, "manager-candidates", { throwOnRefusal: true, report: () => {} });
  let roster: Presence[];
  try { roster = ep.getRoster(); } finally { await ep.stop().catch(() => {}); }
  // Your managers' presence keys are `<owner>.manager_<instanceId>`, and a key is written only by
  // its holder, so the instance id is read from the key, never from what the card says.
  const prefix = `${connection.epCaller?.owner}.manager_`;
  return roster.flatMap((p) => {
    const instanceId = p.card.id.startsWith(prefix) ? p.card.id.slice(prefix.length) : "";
    return connection.epCaller !== undefined && p.card.role === "manager" && p.status !== "offline" && instanceIdShaped(instanceId) ? [candidateOf(instanceId, p)] : [];
  });
}

/**
 * `--on` as a manager instance id. A value with the shape of an instance id is used as it is. Any
 * other value is a manager's name or host: on a user-auth mesh it is matched against your live
 * managers in presence and pins the one it matches. No match, or more than one, is refused with the
 * candidates. On a static or open mesh a manager's presence does not carry its instance id, so a
 * name is refused there and the instance id is asked for.
 */
export async function managerPin(values: { on?: unknown; space?: unknown; server?: unknown }, verb: string): Promise<string | undefined> {
  const on = onInstance(values.on === undefined ? undefined : String(values.on), verb);
  if (on === undefined || instanceIdShaped(on)) return on;
  const flags = targetFlags(values);
  let mode: string | undefined;
  try { mode = resolveMeshTarget(process.cwd(), flags).mode; } catch { /* not a registered mesh: only an instance id can pin */ }
  if (mode !== "user") {
    try { onInstanceId(on, verb); } catch (error) {
      throw new CommandFailure("refused", "USAGE_INVALID", `${(error as Error).message}. A manager's name or host is taken only on a user-auth mesh`, {
        target: { on },
        remedy: `cotal ps prints each manager's instance id; rerun it as ${verb} --on <instance>`,
        selfContained: true,
      });
    }
  }
  const managers = await yourLiveManagers(flags);
  const matched = managers.filter((m) => selects(m, on));
  if (matched.length === 1) return matched[0]!.instanceId;
  throw new ManagerPinUnmatched(on, matched.length ? matched : managers, matched.length);
}

/** Your other live managers whose catalog holds `persona`, each as the shortest `--on` value that
 *  picks it. A manager that does not answer is left out. */
export async function managersWithPersona(values: { space?: unknown; server?: unknown }, exclude: string | undefined, persona: string): Promise<string[]> {
  const flags = targetFlags(values);
  if (resolveMeshTarget(process.cwd(), flags).mode !== "user") return registeredManagersWithPersona(flags, exclude, persona);
  const managers = await yourLiveManagers(flags);
  const holding: ManagerCandidate[] = [];
  for (const manager of managers.filter((m) => m.instanceId !== exclude)) {
    let connection: Awaited<ReturnType<typeof openEndpointConnection>> | undefined;
    try {
      connection = await openEndpointConnection(flags, "control-caller-privileged", BASELINE_LIFECYCLE_ENDPOINT, manager.instanceId);
      const service = await resolveService(connection.nc, connection.space, BASELINE_LIFECYCLE_ENDPOINT, connection.auth.epCaller!, { instanceId: manager.instanceId, deadlineMs: 5_000 });
      // The list names every persona in the catalog; a card it cannot show you is listed by name.
      const listed = service.commands.has("list-personas") ? (await invokeCommand(connection.nc, connection.space, service, "list-personas", undefined, { deadlineMs: 5_000 })).reply : undefined;
      const personas = listed?.ok ? (listed.data as { personas?: unknown } | undefined)?.personas : undefined;
      if (Array.isArray(personas) && personas.some((row) => (row as { name?: unknown } | null)?.name === persona)) holding.push(manager);
    } catch { /* a manager that cannot be asked is not named */ }
    finally { await connection?.nc.close().catch(() => {}); }
  }
  return holding.map((m) => selectorFor(m, managers));
}

/** {@link managersWithPersona} on a static or open mesh, whose presence carries no instance id: the
 *  live managers the space's registry lists, each asked pinned to its instance and named by it. */
async function registeredManagersWithPersona(flags: { space?: string; server?: string }, exclude: string | undefined, persona: string): Promise<string[]> {
  const t = await resolveControlTarget(flags, "control-caller-privileged", undefined, { onRefusal: "throw" });
  const holding: string[] = [];
  for (const instanceId of (await liveManagerIds(t.space, t.server, t.auth)).filter((id) => id !== exclude)) {
    try {
      const pinned = await resolveControlTarget(flags, "control-caller-privileged", instanceId, { onRefusal: "throw" });
      const listed = await askManager(pinned.space, pinned.server, "listPersonas", undefined, pinned.auth, "owner", 5_000, { instanceId });
      const personas = listed.ok ? (listed.data as { personas?: unknown } | undefined)?.personas : undefined;
      if (Array.isArray(personas) && personas.some((row) => (row as { name?: unknown } | null)?.name === persona)) holding.push(instanceId);
    } catch { /* a manager that cannot be asked is not named */ }
  }
  return holding;
}

/** `argv` with `--on` set to `selector`, replacing a `--on` it already holds. `--on` goes before a
 *  `--` that ends the flags, so it is still read as a flag. */
function withPin(argv: readonly string[], selector: string): string[] {
  const end = argv.indexOf("--");
  const words = end === -1 ? [...argv] : argv.slice(0, end);
  const rest = end === -1 ? [] : argv.slice(end);
  const at = words.findIndex((word) => word === "--on" || word.startsWith("--on="));
  if (at === -1) return [...words, "--on", selector, ...rest];
  return [...words.slice(0, at), "--on", selector, ...words.slice(at + (words[at] === "--on" ? 2 : 1)), ...rest];
}

/** `argv` again as a command line, pinned to `selector`. */
export const rerunOn = (argv: readonly string[], selector: string): string => [displayCmd(), ...withPin(argv, selector).map(shellWord)].join(" ");

/** The command again on each manager, by the shortest selector that picks it. */
const reruns = (managers: readonly ManagerCandidate[], argv: readonly string[]): string =>
  `rerun it on one: ${managers.map((m) => rerunOn(argv, selectorFor(m, managers))).join(" or ")}`;

/** The managers an unpinned manager selection refused to choose between, with what the roster
 *  says about each, or undefined when `failure` is not that refusal. A roster that cannot be read
 *  leaves the instance ids. */
async function severalLive(failure: CommandFailure, readRoster: () => Promise<readonly Presence[]>): Promise<ManagerCandidate[] | undefined> {
  const found = failure.code === "PERMISSION_DENIED" ? SEVERAL_LIVE.exec(failure.message) : null;
  if (!found) return undefined;
  const owner = found[2]!;
  const ids = found[3]!.split(",").map((id) => id.trim()).filter(Boolean);
  let roster: readonly Presence[] = [];
  try { roster = await readRoster(); } catch { /* the instance ids still name the choice */ }
  return ids.map((instanceId) => candidateOf(instanceId, roster.find((p) => p.card.id === `${owner}.${remoteManagerActors(instanceId).supervisor}` && p.status !== "offline")));
}

/**
 * The manager to rerun a command on, asked on this terminal after its unpinned manager selection
 * was refused among several live managers: the most recently started is listed first and is the
 * default. The question and the chosen manager are written to stderr, so `--json` output stays
 * whole. The pick is the `--on` the refusal's Next reruns with, and the refusal came before any
 * effect. Undefined for any other failure, and null when the question is cancelled.
 */
export async function pickManager(failure: CommandFailure, readRoster: () => Promise<readonly Presence[]>, argv: readonly string[]): Promise<ManagerCandidate | null | undefined> {
  const managers = await severalLive(failure, readRoster);
  if (!managers) return undefined;
  const newest = [...managers].sort((a, b) => (b.since ?? "").localeCompare(a.since ?? ""));
  const prompts = await import("./prompts.js");
  const picked = await prompts.select({
    message: `${managers.length} of your managers are live. Which one should run this?`,
    options: newest.map((m, index) => ({ value: index, label: m.name ?? m.instanceId, hint: [m.instanceId, m.host ?? "host not reported (started by an older cotal)", m.activity, m.since ? `since ${m.since}` : null, index === 0 ? "most recent" : null].filter(Boolean).join(" · ") })),
    initialValue: 0,
    output: process.stderr,
  });
  if (prompts.isCancel(picked)) {
    prompts.cancel("nothing was done - no manager was chosen", { output: process.stderr });
    return null;
  }
  const chosen = newest[picked]!;
  process.stderr.write(`${renderReport({ sections: [{ title: "Manager chosen", blocks: [
    { kind: "fields", rows: [["Manager", chosen.name ?? chosen.instanceId], ["Instance", chosen.instanceId], ["Host", chosen.host ?? "not reported (started by an older cotal)"]] },
    { kind: "lines", lines: [{ text: `To choose it without this question: ${rerunOn(argv, selectorFor(chosen, managers))}`, tone: "hint" }] },
  ] }] }, "rich", terminalWidth(process.stderr))}\n`);
  return chosen;
}

/** `failure` restated as the choice it is, when it is the refusal of an unpinned manager selection
 *  among several live managers, or a `--on` that picked no single manager: each manager by name,
 *  with its instance id and the host, activity and process start its presence reports, and a Next
 *  that reruns `argv` on each. The outcome and code are kept. The roster is read only for the
 *  unpinned refusal, and one that cannot be read leaves the instance ids. Undefined for any other
 *  failure. */
export async function managerChoiceFailure(
  failure: CommandFailure,
  readRoster: () => Promise<readonly Presence[]>,
  argv: readonly string[],
): Promise<CommandFailure | undefined> {
  if (failure instanceof ManagerPinUnmatched) {
    if (!failure.managers.length) return undefined;
    return new CommandFailure(failure.outcome, failure.code, failure.message, { target: failure.target, native: failure.native, remedy: reruns(failure.managers, argv), cause: failure });
  }
  const managers = await severalLive(failure, readRoster);
  if (!managers) return undefined;
  return new CommandFailure(failure.outcome, failure.code, `${managers.length} of your managers are live, and this command needs exactly one of them`, {
    target: failure.target,
    native: { detail: { managers } },
    remedy: reruns(managers, argv),
    cause: failure,
  });
}
