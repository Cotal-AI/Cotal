import type { Readable, Writable } from "node:stream";
import { BASELINE_LIFECYCLE_ENDPOINT, findCommand, invokeCommand, registry, resolveService, type Command, type Presence } from "@cotal-ai/core";
import { CommandFailure, DEFAULT_MANAGER_NAME, codeSpan, instanceIdShaped, isCommandFailure, isConnectRefusal, renderReport, resolveMeshTarget, type Connection, resolveControlTarget, type ControlAuth } from "@cotal-ai/workspace";
import { cliControl, onInstance, onInstanceId } from "./control.js";
import { openEndpointConnection } from "./endpoint-client.js";
import { commandWord } from "./leading-flags.js";
import { shellWord } from "./endpoint-errors.js";
import { displayCmd } from "./self-exec.js";
import { openTransient } from "./transient.js";
import { askManager, liveManagerIds, managerCandidate, reportedManagerHost, severalLive, type ManagerCandidate } from "@cotal-ai/workspace/control";

/** The exchange's refusal of an unpinned manager-caller selection when it counts none of the caller's
 *  managers live: each one it registered has stopped, or none was registered. */
const NONE_LIVE = /remote manager for owner \S+ is unavailable \(\d+ gates?, none live\)|manager-caller selection found no manager candidate for owner /;

/** Whether `failure` refused an unpinned manager selection because none of your managers is live. */
export const noLiveManager = (failure: CommandFailure): boolean => failure.code === "PERMISSION_DENIED" && NONE_LIVE.test(failure.message);

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

/** The roster of the space `values` resolve to, read once, with the connection that read it. Only
 *  presence is read: it carries each manager's name, host and start, and a connection whose grant
 *  stops short of the channel registry still reads it. */
async function presenceOf(values: { space?: string; server?: string }): Promise<{ roster: Presence[]; connection: Connection }> {
  const { ep, connection } = await openTransient(values, "manager-candidates", { throwOnRefusal: true, presenceOnly: true, report: () => {} });
  try { return { roster: ep.getRoster(), connection }; } finally { await ep.stop().catch(() => {}); }
}

/** The roster of the space `values` resolve to, read once. */
export async function rosterOf(values: { space?: string; server?: string }): Promise<Presence[]> {
  return (await presenceOf(values)).roster;
}

/** A `--on` name or host that picks no single live manager, with the managers it could mean. */
export class ManagerPinUnmatched extends CommandFailure {
  constructor(readonly selector: string, readonly managers: readonly ManagerCandidate[], matched: number) {
    super("refused", matched ? "TARGET_AMBIGUOUS" : "TARGET_NOT_FOUND", matched
      ? `--on ${selector} matches ${matched} live managers, so it does not pick one`
      : `--on ${selector} is not the name, host or instance id of a live manager of yours`, {
      target: { on: selector },
      native: { detail: { managers } },
      remedy: managers.length ? "rerun it with --on naming one of the managers listed" : "start a manager with `cotal manager start`, then rerun it",
    });
  }
}

/** A named agent that the search found on no single manager: each of `managers` holds it, or each
 *  did not answer while every manager that answered lacks it. A terminal is asked `question`, among
 *  `managers` only. */
export class AgentManagerUnsettled extends CommandFailure {
  constructor(readonly question: string, readonly managers: readonly ManagerCandidate[], code: "TARGET_AMBIGUOUS" | "TARGET_UNAVAILABLE", message: string, target: Record<string, unknown>) {
    super("refused", code, message, { target, native: { detail: { managers } }, remedy: "rerun it with --on naming one of the managers listed" });
  }
}

const targetFlags = (values: { space?: unknown; server?: unknown }) =>
  ({ ...(typeof values.space === "string" ? { space: values.space } : {}), ...(typeof values.server === "string" ? { server: values.server } : {}) });

/** Your live managers on the user-auth mesh `flags` resolve to, as presence shows them. */
async function yourLiveManagers(flags: { space?: string; server?: string }): Promise<ManagerCandidate[]> {
  const { roster, connection } = await presenceOf(flags);
  // Your managers' presence keys are `<owner>.manager_<instanceId>`, and a key is written only by
  // its holder, so the instance id is read from the key, never from what the card says.
  const prefix = `${connection.epCaller?.owner}.manager_`;
  return roster.flatMap((p) => {
    const instanceId = p.card.id.startsWith(prefix) ? p.card.id.slice(prefix.length) : "";
    return connection.epCaller !== undefined && p.card.role === "manager" && p.status !== "offline" && instanceIdShaped(instanceId) ? [managerCandidate(instanceId, p)] : [];
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
        remedy: `cotal ps prints each manager's instance id; rerun it as \`${verb} --on <instance>\``,
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
      const service = await resolveService(connection.nc, connection.space, BASELINE_LIFECYCLE_ENDPOINT, connection.auth.epCaller!, { instanceId: manager.instanceId, deadlineMs: 5_000, commands: ["list-personas"] });
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
      const listed = await askManager(cliControl, pinned.space, pinned.server, "listPersonas", undefined, pinned.auth, "owner", 5_000, { instanceId });
      const personas = listed.ok ? (listed.data as { personas?: unknown } | undefined)?.personas : undefined;
      if (Array.isArray(personas) && personas.some((row) => (row as { name?: unknown } | null)?.name === persona)) holding.push(instanceId);
    } catch { /* a manager that cannot be asked is not named */ }
  }
  return holding;
}

/** A live manager of yours that runs an agent, with the shortest `--on` value that picks it. */
export interface RunningOn {
  readonly instanceId: string;
  readonly selector: string;
  readonly host: string | null;
}

/** Which live manager of yours runs the agent `name`, as each reports when asked: `custodian`, the
 *  manager a host says holds it, is asked first. `runsOn` is `null` when none reports it, and
 *  `custodian` is that manager when it is live, whether or not it reports the agent. A manager that
 *  cannot be asked is left out. On a static or open mesh the managers are those the space's
 *  registry lists. */
export async function whereAgentRuns(values: { space?: unknown; server?: unknown }, name: string, custodian?: string): Promise<{ runsOn: RunningOn | null; custodian: RunningOn | null }> {
  const flags = targetFlags(values);
  const user = resolveMeshTarget(process.cwd(), flags).mode === "user";
  let managers: ManagerCandidate[];
  if (user) managers = await yourLiveManagers(flags);
  else {
    const t = await resolveControlTarget(flags, "control-caller-privileged", undefined, { onRefusal: "throw" });
    managers = (await liveManagerIds(t.space, t.server, t.auth)).map((instanceId) => managerCandidate(instanceId, undefined));
  }
  const found = (m: ManagerCandidate): RunningOn => ({ instanceId: m.instanceId, selector: user ? selectorFor(m, managers) : m.instanceId, host: m.host });
  const kept = managers.find((m) => m.instanceId === custodian);
  for (const manager of kept ? [kept, ...managers.filter((m) => m !== kept)] : managers) {
    try {
      const pinned = await resolveControlTarget(flags, "control-caller-privileged", manager.instanceId, { onRefusal: "throw" });
      const row = await askManager(cliControl, pinned.space, pinned.server, "status", { name }, pinned.auth, "owner", 5_000, { instanceId: manager.instanceId });
      if (row.ok) return { runsOn: found(manager), custodian: kept ? found(kept) : null };
    } catch { /* a manager that cannot be asked is not named */ }
  }
  return { runsOn: null, custodian: kept ? found(kept) : null };
}

/** Whether presence on the mesh `values` resolve to shows a live peer named `name`. */
export async function nameOnline(values: { space?: unknown; server?: unknown }, name: string): Promise<boolean> {
  return (await rosterOf(targetFlags(values))).some((p) => p.card.name === name && p.status !== "offline");
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

/** Hosted `cotal run` verbs take `--on` only as the full instance id `cotal ps` prints
 *  (docs/cli.mdx). A name or `<host>/<runtime>` that other commands accept is refused
 *  `USAGE_INVALID` there, so a remedy for those verbs must name the instance id.
 *  The command word is the registered name or any alias the registry claims for it
 *  (`r` in implementations/runtime/src/index.ts). Local, offline and seat-only run
 *  commands take no `--on`, so they are left alone. */
const OFFLINE_RUN_VERBS = ["validate", "plan", "simulate", "turns", "yield", "revoke", "check"];
const hostedRunArgv = (argv: readonly string[]): boolean => {
  const end = argv.indexOf("--");
  const words = (end === -1 ? argv : argv.slice(0, end)).filter((word) => word !== "cotal");
  // The dispatcher reads the command after leading output and global flags (commandWord).
  // A remedy that looks only at words[0] would miss `cotal --json run` and suggest a name.
  const word = commandWord(words);
  const command = word === undefined ? undefined : findCommand(registry.all<Command>("command"), word);
  if ((command?.name ?? word) !== "run") return false;
  if (words.includes("--local")) return false;
  const at = words.indexOf(word!);
  const verb = words[at + 1];
  return verb === undefined || !OFFLINE_RUN_VERBS.includes(verb);
};

/** The command again on each manager. Hosted run verbs are pinned by instance id; every other
 *  command keeps the shortest selector that picks the manager. */
const reruns = (managers: readonly ManagerCandidate[], argv: readonly string[]): string => {
  const byInstance = hostedRunArgv(argv);
  return `rerun it on one: ${managers.map((m) => rerunOn(argv, byInstance ? m.instanceId : selectorFor(m, managers))).join(" or ")}`;
};
/** What a manager's row says about its backend: the runtime it spawns through and whether a
 *  terminal attaches to a seat it starts, so the choice is informed before anything is launched. A
 *  manager whose presence carries neither falls back to the activity line it does carry. */
function runtimeCell(m: ManagerCandidate): string | null {
  if (m.runtime === null) return m.activity;
  if (m.terminal === null) return `${m.runtime} · terminal attach not reported`;
  return m.terminal === "stream" ? `${m.runtime} · terminal attach` : `${m.runtime} · no terminal attach`;
}

/** Your managers newest first, as each is offered in a question: by name, with its instance id and
 *  the host, backend and process start its presence reports. */
export function managerOptions(managers: readonly ManagerCandidate[]): { newest: ManagerCandidate[]; options: { value: number; label: string; hint: string }[] } {
  const newest = [...managers].sort((a, b) => (b.since ?? "").localeCompare(a.since ?? ""));
  return { newest, options: newest.map((m, index) => ({ value: index, label: m.name ?? m.instanceId, hint: [m.instanceId, m.host ?? "host not reported (started by an older cotal)", runtimeCell(m), m.since ? `since ${m.since}` : null, index === 0 ? "most recent" : null].filter(Boolean).join(" · ") })) };
}

/** Record `chosen` as this terminal's pick among `managers` and write the `Manager chosen` receipt,
 *  with `argv` again pinned to it, to stderr. */
function choose(chosen: ManagerCandidate, managers: readonly ManagerCandidate[], argv: readonly string[]): ManagerCandidate {
  pick = { manager: chosen, selector: selectorFor(chosen, managers) };
  process.stderr.write(`${renderReport({ sections: [{ title: "Manager chosen", blocks: [
    { kind: "fields", rows: [["Manager", chosen.name ?? chosen.instanceId], ["Instance", chosen.instanceId], ["Host", chosen.host ?? "not reported (started by an older cotal)"]] },
    { kind: "lines", lines: [{ text: `To choose it without this question: ${codeSpan(rerunOn(argv, pick.selector))}`, tone: "hint" }] },
  ] }] }, "rich", process.stderr)}\n`);
  return chosen;
}

/**
 * The manager to rerun a command on, asked on this terminal after its unpinned manager selection
 * was refused among several live managers, or after a named agent was found on no single manager,
 * when only the managers that hold it or did not answer are listed: the most recently started is
 * listed first and is the default. A roster that cannot be read leaves the instance ids, with a
 * line above the question that says why. The question and the chosen manager are written to stderr,
 * so `--json` output stays whole. The pick is the `--on` the refusal's Next reruns with, and the
 * refusal came before any effect. Undefined for any other failure, and null when the question is
 * cancelled.
 */
export async function pickManager(failure: CommandFailure, readRoster: () => Promise<readonly Presence[]>, argv: readonly string[]): Promise<ManagerCandidate | null | undefined> {
  const unsettled = failure instanceof AgentManagerUnsettled ? failure : undefined;
  const several = unsettled ? undefined : await severalLive(failure, readRoster);
  const managers = unsettled ? [...unsettled.managers] : several?.managers;
  if (!managers?.length) return undefined;
  const { newest, options } = managerOptions(managers);
  const prompts = await import("./prompts.js");
  if (several?.unread) prompts.log.warn(prompts.logLines(several.unread, process.stderr), { output: process.stderr });
  const picked = await prompts.select({
    message: unsettled?.question ?? `${managers.length} of your managers are live. Which one should run this?`,
    options,
    initialValue: 0,
    output: process.stderr,
  });
  if (prompts.isCancel(picked)) {
    prompts.cancel("nothing was done - no manager was chosen", { output: process.stderr });
    return null;
  }
  return choose(newest[picked]!, managers, argv);
}

/**
 * Where a spawn that names no launch mode runs, asked on this terminal when several of your
 * managers are live on the user-auth mesh `values` resolve to: in this terminal, the default, or
 * launched by one of them and attached here, as `--on` does. The managers are the ones the exchange
 * counts for an unpinned manager selection, read from its refusal, and shown as {@link pickManager}
 * shows them. A selection it grants instead is
 * dropped, and so is any refusal of a manager selection, which leaves the spawn in this terminal; any
 * other failure is thrown. No manager credential is held while the question waits. Undefined when
 * nothing is asked or this terminal is chosen, and null when the question is cancelled.
 */
export async function askSpawnPlace(values: { space?: unknown; server?: unknown }, argv: readonly string[]): Promise<ManagerCandidate | null | undefined> {
  const flags = targetFlags(values);
  let mode: string | undefined;
  try { mode = resolveMeshTarget(process.cwd(), flags).mode; } catch { /* not a registered mesh: the spawn resolves its own target */ }
  if (mode !== "user") return undefined;
  let failure: CommandFailure | undefined;
  try {
    await resolveControlTarget(flags, "control-caller-privileged", undefined, { onRefusal: "throw" });
  } catch (error) {
    failure = isCommandFailure(error) ? error : isConnectRefusal(error) ? error.failure() : undefined;
    if (!failure) throw error;
  }
  if (!failure) return undefined;
  const several = await severalLive(failure, () => rosterOf(flags));
  if (!several) {
    if (failure.code === "PERMISSION_DENIED") return undefined;
    throw failure;
  }
  const { managers } = several;
  const { newest, options } = managerOptions(managers);
  const prompts = await import("./prompts.js");
  if (several.unread) prompts.log.warn(prompts.logLines(several.unread, process.stderr), { output: process.stderr });
  const picked = await prompts.select({
    message: `${managers.length} of your managers are live. Where should the agent run?`,
    options: [{ value: -1, label: "This terminal", hint: "default" }, ...options],
    initialValue: -1,
    output: process.stderr,
  });
  if (prompts.isCancel(picked)) {
    prompts.cancel("nothing was done - no place was chosen", { output: process.stderr });
    return null;
  }
  return picked === -1 ? undefined : choose(newest[picked]!, managers, argv);
}

/** A manager with the `--on` value that picks it. */
export interface ManagerSelection {
  readonly manager: ManagerCandidate;
  readonly selector: string;
}

/** The manager this terminal picked for the running command, if it picked one. */
let pick: ManagerSelection | undefined;

/** The manager that `instanceId` names, as this terminal picked it or as your live managers'
 *  presence shows it, with the `--on` value that picks it. Presence is read with the roster's
 *  read-only view, so no manager credential is acquired. Off a user-auth mesh, whose presence does
 *  not carry instance ids, and for a manager presence does not show, `target` asks that manager for
 *  its own host, the one `cotal ps` prints as its reported host. Without a target, or for a manager
 *  that does not answer, its host is unknown. */
export async function managerSelection(
  values: { on?: unknown; space?: unknown; server?: unknown },
  instanceId: string,
  target?: { space: string; server: string; auth: ControlAuth },
): Promise<ManagerSelection> {
  if (pick?.manager.instanceId === instanceId) return pick;
  const flags = targetFlags(values);
  let mode: string | undefined;
  try { mode = resolveMeshTarget(process.cwd(), flags).mode; } catch { /* not a registered mesh: presence names no instance */ }
  const shown = mode === "user" ? (await yourLiveManagers(flags)).find((m) => m.instanceId === instanceId) : undefined;
  const manager = shown ?? managerCandidate(instanceId, undefined);
  if (manager.host !== null || target === undefined) return { manager, selector: String(values.on ?? instanceId) };
  const host = await reportedManagerHost(cliControl, target.space, target.server, target.auth, instanceId);
  return { manager: { ...manager, host: host ?? null }, selector: String(values.on ?? instanceId) };
}

/** A folder a manager resolved on its host with `resolve-cwd`, or its reason for refusing the path. */
export type FolderCheck = { readonly cwd: string } | { readonly refusal: string };

/** `argv` with `-C <folder>` before a `--` that ends the flags. */
function withCwd(argv: readonly string[], folder: string): string[] {
  const end = argv.indexOf("--");
  return end === -1 ? [...argv, "-C", folder] : [...argv.slice(0, end), "-C", folder, ...argv.slice(end)];
}

/** `argv` again with the `-C` and `--on` that send `folder` with the launch and ask nothing: what
 *  the folder question's receipt offers, and the way past a check that could not be made. */
export const rerunWithCwd = (argv: readonly string[], folder: string, selector: string): string =>
  rerunOn(withCwd(argv, folder), selector);

/** What a launch without `-C` uses, as the folder question and its receipt name it. */
const MANAGER_WORKSPACE = "Manager's workspace (default)";

/**
 * The folder on the selected manager's host that an agent it launches works in, asked on this
 * terminal. Enter keeps the manager's workspace, where a launch without `-C` runs, and gives
 * undefined. A typed path is passed as typed to `check`, which has that manager resolve it on its
 * host, because only the manager knows its own path rules. A path it refuses is shown with the
 * manager's reason and asked again, with the typed text to edit.
 * The question and a `Folder chosen` receipt go to `io.output`, stderr by default. Null when the
 * question is cancelled.
 */
export async function askManagerFolder(
  selection: ManagerSelection,
  argv: readonly string[],
  check: (path: string) => Promise<FolderCheck>,
  io: { input?: Readable; output?: Writable } = {},
): Promise<string | null | undefined> {
  const output = io.output ?? process.stderr;
  const host = selection.manager.host ?? "the manager's host";
  const prompts = await import("./prompts.js");
  let typed = "";
  for (;;) {
    const answer = await prompts.text({
      message: `Which folder on ${host} should the agent work in?`,
      placeholder: `${MANAGER_WORKSPACE}; type an absolute path to change it`,
      initialValue: typed,
      input: io.input,
      output,
    });
    if (prompts.isCancel(answer)) {
      prompts.cancel("nothing was done - no folder was chosen", { output });
      return null;
    }
    typed = answer ?? "";
    const checked = typed ? await check(typed) : undefined;
    if (checked && "refusal" in checked) {
      prompts.log.warn(prompts.logLines(`the manager on ${host} cannot use it: ${checked.refusal}`, output), { output });
      continue;
    }
    const folder = checked?.cwd;
    output.write(`${renderReport({ sections: [{ title: "Folder chosen", blocks: [
      { kind: "fields", rows: [["Folder", folder ?? MANAGER_WORKSPACE], ["Host", selection.manager.host ?? "not reported"]] },
      ...(folder === undefined ? [] : [{ kind: "lines" as const, lines: [{ text: `To choose it without this question: ${codeSpan(rerunWithCwd(argv, folder, selection.selector))}`, tone: "hint" as const }] }]),
    ] }] }, "rich", output as NodeJS.WriteStream)}\n`);
    return folder;
  }
}

/** `failure` restated as the choice it is, when it is the refusal of an unpinned manager selection
 *  among several live managers, a `--on` that picked no single manager, or a named agent found on
 *  no single manager: each manager by name, with its instance id and the host, activity and process
 *  start its presence reports, and a Next that reruns `argv` on each. The outcome and code are kept.
 *  The roster is read only for the unpinned refusal, and one that cannot be read leaves the instance
 *  ids. Undefined for any other failure. */
export async function managerChoiceFailure(
  failure: CommandFailure,
  readRoster: () => Promise<readonly Presence[]>,
  argv: readonly string[],
): Promise<CommandFailure | undefined> {
  if (failure instanceof ManagerPinUnmatched || failure instanceof AgentManagerUnsettled) {
    if (!failure.managers.length) return undefined;
    return new CommandFailure(failure.outcome, failure.code, failure.message, { target: failure.target, native: failure.native, remedy: reruns(failure.managers, argv), cause: failure });
  }
  const managers = (await severalLive(failure, readRoster))?.managers;
  if (!managers) return undefined;
  return new CommandFailure(failure.outcome, failure.code, `${managers.length} of your managers are live, and this command needs exactly one of them`, {
    target: failure.target,
    native: { detail: { managers } },
    remedy: reruns(managers, argv),
    cause: failure,
  });
}
