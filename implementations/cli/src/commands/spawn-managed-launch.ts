import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { hostname } from "node:os";
import {
  mintCreds,
  newIdentity,
  parseShareSelection,
  spawnNameError,
  resolveAuthProvider,
  GOAL_ENTITY_RUNNING_DETAIL_KIND,
  EP_UNDECLARED_ARG,
  seatCapFrom,
  transferBucket,
  writeTransfer,
  type Connector,
  type FlagValues,
  type AgentLifecycleRelease,
  type RuntimeProvider,
} from "@cotal-ai/core";
import {
  parseCommaList,
  brokerAddressForDisplay,
  CommandFailure,
  isCommandFailure,
  presentationOf,
  recordOperationWarning,
  renderReport,
  terminalWidth,
  wrapWords,
  writeResult,
  migrateProjectTrust,
  type OutputWarning,
  type RefusalCode,
  type Report,
  cachedPreferences,
  loadManagerInstanceIdentity,
  refreshRegistrationPolicy,
  resolveSeatControlTarget,
  connectUserControlOrExit,
  userViewAuth,
  oneLine,
  codeSpan,
  type ConnectFlags,
  type ControlAuth,
  type ControlTarget,
  DEFAULT_CONNECTOR,
  hintedConnector,
  manifestExtensionNames,
  OFFICIAL_CONNECTORS,
  type MeshTarget,
  recordOperationSpace,
  resolveMeshTarget,
  resolveControlTarget,
  parseLaunchModes,
} from "@cotal-ai/workspace";
import { readManagedLaunch, requestManagedLaunch, type ManagedLaunchResult } from "@cotal-ai/workspace/launch";
import { c, stderrLine } from "../ui.js";
import { displayCmd } from "../lib/self-exec.js";
import { localDiagnostic } from "../telemetry.js";
import { runningStackManagerPid, stackManagerAbsent, stackManagerStarting } from "../lib/stack-journal.js";
import { cliControl, failIfNotOk, onRerun } from "../lib/control.js";
import { askManagerFolder, managerPin, managerSelection, managersWithPersona, rerunOn, rerunWithCwd, type FolderCheck } from "../lib/manager-choice.js";
import { canPrompt } from "./meshes-wizard.js";
import { callerHarness, missingConnector, spawnPersona } from "../lib/spawn-defaults.js";
import { attachSeat, joinedAgentRows, noTerminalCommands, psSeatLabel } from "./agents.js";
import { AgentAlreadyRunning, heldAnswer, settleHeldName } from "../lib/held-name.js";
import { shellWord } from "../lib/endpoint-errors.js";
import { materializeExtension, preflightRuntime } from "../ext-loader.js";
import {
  askManager,
  describeUnanswered,
  liveManagerIds,
  managerRailGone,
  refuseUnregisteredManager,
  refuseWithoutLiveManager,
  START_TIMEOUT_MS,
  startStackManagerRemedy,
  withControlConnection,
} from "@cotal-ai/workspace/control";
import { spawnFlags, spawnModelRetry, spawnRerun } from "./spawn-flags.js";

/** Whether the installed manifest lists a connector named `name`. An unreadable manifest answers
 *  true, so the import's own refusal reports it. */
export function connectorListed(name: string): boolean {
  try { return manifestExtensionNames("connector").includes(name); } catch { return true; }
}

/** #867: the name a spawn sends must already be a mintable identity, and the check must not wait
 *  for the manager's round trip. `spawnNameError` is the SAME predicate the manager applies at its
 *  door (manager.ts `start`), so the operator sees core's own refusal — offending character,
 *  reservation reason, and the `_` remedy — before any request leaves. A courtesy only: the
 *  manager door stays the enforcement point; this is why the CLI passes the target mesh's auth
 *  mode rather than restating the grammar (static mode keys the actor on the nkey, not the name). */
export function refuseUnmintableName(name: string, userMode: boolean): void {
  const refusal = spawnNameError(name, { userMode });
  if (refusal) throw new CommandFailure("refused", "USAGE_INVALID", refusal, { selfContained: true });
}

/** Whether a managed launch can reach only this root's own manager: the instance it names, or else
 *  the only one the registry lists, is the one recorded under the target's root. An unread registry
 *  or an unreadable record proves nothing, and the launch then goes to whichever manager serves it. */
export function launchServedHere(t: { space: string; root?: string }, serving: string | undefined, live: readonly string[] | undefined): boolean {
  if (t.root === undefined) return false;
  let here: string | undefined;
  try { here = loadManagerInstanceIdentity(t.root, t.space)?.instanceId; } catch { return false; }
  if (here === undefined) return false;
  return serving !== undefined ? serving === here : live?.length === 1 && live[0] === here;
}

/** A runtime this root's own manager cannot launch on is refused before the launch is sent, through
 *  the installed-extension lookup `up --runtime` uses. A manager on another host reads that host's
 *  extensions, so a launch that may reach one sends the name and that manager decides. */
async function refuseRuntimeHere(runtime: string, t: { space: string; root?: string }, serving: string | undefined, live: readonly string[] | undefined): Promise<void> {
  if (!launchServedHere(t, serving, live)) return;
  try { await preflightRuntime(runtime); }
  catch (error) { throw new CommandFailure("refused", "DEPENDENCY_UNAVAILABLE", "the requested runtime did not pass preflight on this machine, where the selected manager runs; nothing was launched", { target: { space: t.space, managerInstanceId: serving ?? live?.[0] ?? null, runtime }, remedy: error instanceof Error ? error.message : "inspect the selected runtime provider" }); }
}

const channelList = (channels: readonly string[]): string => channels.length ? channels.join(", ") : "none";

export interface ManagedLaunchObserver {
  /** A native joined receipt, not task completion. A composite command owns its one envelope. */
  ready(result: ManagedLaunchResult, warnings: readonly OutputWarning[]): void;
}

export function managedLaunchView(r: ManagedLaunchResult, server?: string): Report {
  const concrete = [r.name, r.space, r.managerInstanceId].every((value) => /^[A-Za-z0-9_-]+$/.test(value));
  const explicitServer = server === undefined ? undefined : brokerAddressForDisplay(server);
  const broker = explicitServer === undefined ? "" : ` --server ${shellWord(explicitServer)}`;
  const target = concrete ? `${r.name} --space ${r.space}${broker} --on ${r.managerInstanceId}` : `<name> --space <space>${broker} --on <manager-instance>`;
  const mesh = r.streamsTerminal === false ? noTerminalCommands(r.name, r.space, server) : undefined;
  return { sections: [
    { title: "Agent joined", blocks: [
      { kind: "fields", rows: [["Agent", psSeatLabel({ name: r.name, id: r.id })], ["Identity", r.id], ["Lifecycle", r.lifecycleUid], ["Space", r.space], ["Manager receipt", r.managerInstanceId], ["Original request", r.intent?.requestId ?? r.request?.requestId ?? "not recorded"], ["Accepted goal", r.request?.goalId ?? "not reported"], ["Application", r.harness], ["Runtime", mesh ? `${r.runtime} · no terminal stream` : r.runtime], ["Role", r.role ?? "not recorded"], ...(r.acl ? [["Granted", `read ${channelList(r.acl.effective.allowSubscribe)} · post ${channelList(r.acl.effective.allowPublish)}; asked for read ${channelList(r.acl.requested.allowSubscribe)} · post ${channelList(r.acl.requested.allowPublish)}`] as [string, string]] : []), ["Model request", r.requestedModel ?? "persona/manager precedence; not inspected"], ["View", mesh ? `not attached; the seat runs in the manager's ${r.runtime} session` : r.detached ? "not attached" : "attaching to the allocated incarnation"]] },
      { kind: "lines", lines: [{ text: "The manager confirmed presence readiness. This is not proof that the kickoff task completed.", tone: "hint" }] },
    ] },
    ...(mesh ? [{ title: "Next", blocks: [
      { kind: "commands" as const, items: [
        { command: mesh.watch, description: "Follow this mesh, this agent's messages included" },
        { command: mesh.send, description: "Give the agent work over the mesh" },
        { command: `${displayCmd()} status ${target}`, description: "Read the agent's reported state" },
      ] },
      { kind: "lines" as const, lines: [{ text: `${displayCmd()} attach is not available here: the ${r.runtime} runtime streams no terminal.`, tone: "hint" as const }] },
    ] }] : r.detached ? [{ title: "Next", blocks: [{ kind: "commands" as const, items: [
      { command: `${displayCmd()} attach ${target}`, description: concrete ? "Return to this allocated incarnation's manager" : "Use the full identities recorded above" },
      { command: `${displayCmd()} status ${target}`, description: "Read the agent's reported state" },
    ] }] }] : []),
  ] };
}

/** The auth mode of the mesh `flags` name, or undefined when they name no registered mesh, which
 *  the launch's own resolve then reports. */
function meshMode(flags: { space?: string; server?: string }): string | undefined {
  try { return resolveMeshTarget(process.cwd(), { space: flags.space, server: flags.server }).mode; }
  catch { return undefined; }
}

/** Shared managed launch. The manager resolves its persona and returns real readiness before
 *  any view opens. Detach changes terminal attachment, not the launch or caller authority. */
export async function launchManagedPersona(
  values: FlagValues<typeof spawnFlags>,
  positionals: string[],
  events: boolean | undefined,
  launchOptions: Record<string, string> | undefined,
  observer?: ManagedLaunchObserver,
): Promise<void> {
  // WHICH file the manager loads — the exact foreground precedence (`--config` > positional >
  // `COTAL_DEFAULT_PERSONA` > `default`). Identity is separate:
  // when `--name` is given it OVERRIDES the file's `name:` (foreground's `requested`), threaded
  // as the op's `identity` so it is never silently dropped in detached mode.
  let on = await managerPin(values, spawnRerun(values, positionals));
  // From a managed seat's own shell the launch is the SEAT's, as its `cotal_spawn` tool is: the
  // manager records the seat as the spawner, so the seat can stop the child it asked for (#718).
  // `--on` keeps the pin on that path too.
  const flags = { space: values.space, server: values.server, creds: values.creds };
  const seatIntent = Boolean(process.env.COTAL_NAME || process.env.COTAL_ID || process.env.COTAL_LIFECYCLE_UID || process.env.COTAL_ACCEPTED_TOKEN);
  if (seatIntent && values.creds !== undefined) throw new CommandFailure("refused", "USAGE_INVALID", "a managed seat's child launch uses that seat's own caller, not a --creds override");
  let cwd = values.cwd;
  // On a terminal, a pinned manager that is not known to run on this host is asked which of its
  // folders the agent works in, unless -C names one. One resolve, dropped again here, answers
  // everything that question needs: that the mesh runs and the pin names a manager that is running,
  // which manager an unpinned launch on a user-auth mesh goes to (the exchange picks your only live
  // one, and the launch is pinned to it so the question asks about the manager that runs the
  // agent), and the host that manager reports. So an unknown --on or a stopped mesh is refused
  // before anything is asked, and the question still holds no manager credential: a typed folder is
  // checked under a view of that manager acquired after it is answered, and the launch acquires its
  // own below. A manager that has stopped by the time the launch is sent is refused there and goes
  // to no other manager.
  if (cwd === undefined && !seatIntent && canPrompt() && (on !== undefined || (values.creds === undefined && meshMode(flags) === "user"))) {
    const probe = await resolveControlTarget(flags, "control-caller-privileged", on, { onRefusal: "throw" });
    const pin = on ?? probe.auth.managerInstanceId;
    if (pin !== undefined) {
      if (!probe.auth.bearer) await refuseUnregisteredManager(probe.space, probe.server, probe.auth, pin);
      on = pin;
      const selection = await managerSelection(values, pin, probe);
      if (selection.manager.host !== hostname()) {
        const folder = await askManagerFolder(selection, process.argv.slice(2), (path) => checkFolder(flags, pin, path));
        if (folder === null) process.exit(0);
        cwd = folder;
      }
    }
  }
  let seat: Awaited<ReturnType<typeof resolveSeatControlTarget>>;
  if (seatIntent) {
    try { seat = await resolveSeatControlTarget({ ...flags, space: flags.space ?? process.env.COTAL_SPACE }, on); }
    catch { throw new CommandFailure("refused", "AUTH_REQUIRED", "the launching seat's own credential could not be verified; no operator identity was substituted"); }
    if (!seat) throw new CommandFailure("refused", "UNSUPPORTED", "the managed seat cannot act as itself through this CLI; missing/mismatched caller context and user-auth self impersonation do not fall back to the operator");
  }
  const t = seat ?? await resolveControlTarget(flags, "control-caller-privileged", on, { onRefusal: "throw" });
  recordOperationSpace(t.space);
  let policy: typeof t.policy;
  try {
    policy = await refreshRegistrationPolicy(t);
  } catch {
    throw new CommandFailure("refused", "TARGET_UNAVAILABLE", "the selected registration policy could not be observed; no manager launch was submitted");
  }
  // #867: refuse an unmintable identity BEFORE the round trip. On this path the persona is
  //  resolved manager-side, so the effective identity is `--name` alone — when it is absent the
  //  manager applies the same spawnNameError to the file's `name:` at its own door.
  if (values.name !== undefined) refuseUnmintableName(values.name, t.mode === "user");
  const eventsRequired = policy?.events === "required";
  if (eventsRequired && events === false) {
    throw new CommandFailure("refused", "PERMISSION_DENIED", `space "${t.space}" requires the event plane by registration policy; no launch was submitted`);
  }
  const live = on === undefined && !t.auth.bearer ? await refuseWithoutLiveManager(t.space, t.server, t.auth, { space: t.space, managerInstanceId: null, managerEpoch: null }, "launch an agent") : undefined;
  // A pin the registry does not list is refused at once; only a registered manager is waited on.
  if (on !== undefined && !t.auth.bearer) await refuseUnregisteredManager(t.space, t.server, t.auth, on);
  if (values.runtime !== undefined) await refuseRuntimeHere(values.runtime.trim(), t, on ?? t.auth.managerInstanceId, live);
  migrateProjectTrust();
  const { ref, from: personaFrom } = spawnPersona(values.config, positionals, { space: t.space, preferences: cachedPreferences() });
  const managerConfigRef = values.config ?? (personaFrom !== undefined ? ref : undefined);
  const defaultAgent = callerHarness(t.space);
  let resumeClaim: { claim: string; agent: string } | undefined;
  if (values.resume !== undefined) {
    // Without a flag the harness is the persona pin or a default, which only the target manager
    // can read: ask it, so the carry looks with the connector the launch runs (#2899).
    const agent = values.agent ?? await launchAgentOrExit(t, on, { name: ref, config: managerConfigRef, defaultAgent });
    // The carry and its transfer-writer view stay on the mesh selected for this launch.
    const claim = await carryTranscript({ ...flags, space: t.space, server: t.server }, on, values.resume, agent);
    if (claim !== undefined) resumeClaim = { claim, agent };
  }
  // The report that answers names the mesh in its heading, so this block names it once, in a field.
  const toStdout = !observer && presentationOf(values) !== "json";
  (toStdout ? console.log : console.error)(renderReport({ sections: [{ title: "Managed launch", blocks: [{ kind: "fields", rows: [["Space", t.space], ["Manager selector", on ?? t.auth.managerInstanceId ?? "native class selection"], ["Persona", ref], ["File source", managerConfigRef ? `${managerConfigRef} · manager execution host` : "selected manager's persona catalog"], ["File transfer", "none"]] }, { kind: "lines", lines: [{ text: "The accepting manager validates its own visible file before allocation. No local file is uploaded, and a pin never selects a replacement manager.", tone: "hint" }] }] }] }, presentationOf(values) === "plain" ? "plain" : "rich", toStdout ? process.stdout : process.stderr));
  for (const line of wrapWords("waiting for the manager: it answers when it refuses the launch, or when the agent joins or exits …", terminalWidth(process.stderr))) console.error(c.dim(line));
  const start = () => requestManagedLaunch({
    persona: ref,
    identity: values.name,
    role: values.role,
    // #869: keep an explicit `--agent` and the invoking operator's default (COTAL_DEFAULT_AGENT or a
    // saved harness preference) in separate fields. Collapsing them made the default
    // indistinguishable from a flag, so it beat the persona pin; dropping it instead changed detached
    // semantics whenever the manager's own environment differed. The manager applies flag > file >
    // caller default > manager default.
    agent: values.agent,
    defaultAgent,
    config: managerConfigRef,
    model: values.model,
    variant: values.variant,
    modes: parseLaunchModes(values.mode),
    ...(values.restarts !== undefined ? { supervise: { restarts: Number(values.restarts), windowMs: Number(values["restart-window"]) } } : {}),
    launchOptions,
    cwd,
    resume: values.resume,
    resumeClaim,
    prompt: values.prompt,
    shareTools: parseShareSelection(values["share-tools"]),
    subscribe: parseCommaList(values.subscribe),
    allowSubscribe: parseCommaList(values["allow-subscribe"]),
    allowPublish: parseCommaList(values["allow-publish"]),
    // #373: send the bit only when the operator chose it. On an events-required space the
    // policy still forces the plane on (the manager refuses a non-admin caller on such a space
    // anyway, so the operator must hold the admin tier for the spawn to succeed at all).
    events: eventsRequired ? true : events,
    ...(values["no-event-payloads"] || policy?.eventPayloads === "withheld" ? { eventPayloads: false } : {}),
    ...(values.runtime !== undefined ? { runtime: values.runtime.trim() } : {}),
    // #159 B1: the manager replies only on a REAL outcome (presence join / process exit / ~30s
    // readiness backstop) — the start request must outlive that window, not the 5s op default.
    // `--on <instance>` pins the spawn to that exact manager instance (P2 item 3 multi-manager).
  }, (args) => askManager(cliControl, t.space, t.server, "start", args, t.auth, "owner", START_TIMEOUT_MS, { instanceId: on }));
  // A refusal before execution launched nothing, so the launch is sent again once a name held by a
  // lifecycle that is not running is released. A name that runs is not launched a second time.
  let reply: Awaited<ReturnType<typeof start>>;
  try {
    let mesh: MeshTarget | undefined;
    try { mesh = resolveMeshTarget(process.cwd(), { space: flags.space, server: flags.server }); } catch { /* no registered mesh: nothing to release */ }
    reply = await settleHeldName(flags, start, (o) => "value" in o && !o.value.ok && o.value.nativeOutcome === "not-executed"
      ? heldAnswer({ code: o.value.code, details: o.value.details, message: o.value.error ?? "" }, values.name) : undefined, meshRelease(mesh));
  } catch (e) {
    if (!(e instanceof AgentAlreadyRunning)) throw e;
    if (observer) throw new CommandFailure("refused", "CONFLICT", `${e.message}; nothing new was launched`, { target: { space: t.space, agent: e.agent, managerInstanceId: e.manager?.instanceId ?? null } });
    return reportAlreadyRunning(e, values, t.space, t.server);
  }
  const target = { space: t.space, managerInstanceId: reply.managerInstanceId ?? on ?? null, managerEpoch: reply.managerEpoch ?? null, ...(reply.intent ? { requestId: reply.intent.requestId, requestedGoalId: reply.intent.requestedGoalId ?? null } : {}), ...(reply.request ? { acceptedGoalId: reply.request.goalId ?? null } : {}) };
  // A launch whose process the manager reports running is starting: one that waits for the operator at
  // a screen its harness names was ready once it ran, and one that did not join in time may still be
  // coming up or sitting at a prompt. Either way the operator is sent to its terminal.
  const started = reply.ok ? reply.data as { name?: unknown; id?: unknown; lifecycleUid?: unknown; waitingFor?: unknown } | undefined : undefined;
  const running = !reply.ok && reply.code === "uncertain" && reply.details?.some((d) => d.kind === GOAL_ENTITY_RUNNING_DETAIL_KIND) === true;
  const startedName = typeof started?.name === "string" ? started.name : reply.request?.allocation?.name;
  if (!observer && reply.managerInstanceId && startedName && (typeof started?.waitingFor === "string" || running)) {
    const expected = typeof started?.id === "string" && typeof started.lifecycleUid === "string" ? { id: started.id, lifecycleUid: started.lifecycleUid } : undefined;
    return reportStarting({ name: startedName, managerInstanceId: reply.managerInstanceId, ...(typeof started?.waitingFor === "string" ? { waitingFor: started.waitingFor } : {}), ...(expected ? { expected } : {}) }, values, t.space, t.server, target);
  }
  if (!reply.ok) {
    const refusal: Record<string, RefusalCode> = { "permission-denied": "PERMISSION_DENIED", "unauthenticated": "AUTH_REQUIRED", "not-found": "TARGET_NOT_FOUND", "unavailable": "TARGET_UNAVAILABLE", "bad-request": "SCHEMA_INVALID", "failed-precondition": "LIFECYCLE_BLOCKED", "already-exists": "CONFLICT", "conflict": "CONFLICT", "unimplemented": "UNSUPPORTED" };
    const code = reply.code === undefined ? undefined : refusal[reply.code];
    const native = { code: reply.code, outcome: reply.nativeOutcome, ...(reply.request || reply.intent ? { detail: { request: reply.request ?? null, intent: reply.intent ?? null, observation: reply.observationCause ?? null } } : {}) };
    // The broker attested that no manager received an unpinned launch: none takes the class queue.
    if (on === undefined && !t.auth.bearer && reply.unanswered && reply.nativeOutcome === "not-executed")
      throw await unservedClassLaunch(seat ? undefined : flags, t, values.agent ?? defaultAgent, { target, native });
    // A pinned describe that drew no answer means the launch was never sent, as ps and stop --on say.
    if (on !== undefined && describeUnanswered(reply))
      throw new CommandFailure("refused", "TARGET_UNAVAILABLE", `manager instance ${on} did not answer, so the launch was not sent and nothing was launched`, { target, native: { code: reply.code, ...(reply.error ? { detail: oneLine(reply.error) } : {}) }, remedy: "cotal ps shows which managers answer; rerun the spawn on one of them with --on <instance>" });
    // So does an unpinned one: no manager answered, and the launch was never published.
    if (on === undefined && describeUnanswered(reply)) throw unansweredClassLaunch(t, { target, native: { code: reply.code, ...(reply.error ? { detail: oneLine(reply.error) } : {}) } });
    // The owner's seat cap. Keyed on the marker, not the code: the numbers are what a script acts
    // on, and the remedy is the operator's knob, neither of which a code alone can carry. It is a
    // CONFLICT with the seats this owner already holds, the same shape as a pinned-name collision:
    // nothing here is unreachable or unauthorized, and freeing one seat admits the launch.
    const cap = seatCapFrom(reply);
    if (cap !== undefined)
      throw new CommandFailure("refused", "CONFLICT", reply.error ? oneLine(reply.error) : "the manager refused the launch: this owner is at its seat cap", {
        target, native: { code: reply.code, outcome: reply.nativeOutcome, detail: { owner: cap.owner, seats: cap.seats, cap: cap.cap } },
        remedy: `nothing was launched; stop one of this owner's seats with \`cotal stop --name <name>\`, or ask the operator who runs that manager to restart it with a higher --seat-cap (it admits ${cap.cap} per owner)`,
      });
    // A manager without the connector: it is added where that manager runs, not on this machine.
    const absent = reply.nativeOutcome === "not-executed" && reply.error !== undefined ? hintedConnector(reply.error) : undefined;
    if (absent !== undefined) {
      const answered = reply.managerInstanceId ?? on;
      throw new CommandFailure("refused", "DEPENDENCY_UNAVAILABLE", `no connector "${absent}" is installed on ${answered ? await managerNamed(seat ? undefined : flags, t, answered) : "the manager"}; nothing was launched`, { target, native,
        remedy: `add it where that manager runs, such as ${extAddFor(absent)}, then restart that manager; it reads its agent applications when it starts` });
    }
    if (reply.nativeOutcome === "not-executed" && code) {
      // A manager without the persona: it is created on that manager's host, or the spawn goes to
      // another live manager whose catalog has it.
      const missing = managerConfigRef === undefined && reply.error?.startsWith(`no persona "${ref}"`) === true;
      const elsewhere = missing ? await managersWithPersona(flags, reply.managerInstanceId ?? on, ref).catch((): string[] => []) : [];
      throw new CommandFailure("refused", code, reply.error ? oneLine(reply.error) : "the manager refused the launch before execution", { target, native, remedy: elsewhere.length
        ? `nothing was launched; ${elsewhere.length === 1 ? "this manager of yours has" : "these managers of yours have"} ${ref === "default" ? "a default persona" : `persona "${ref}"`}: ${elsewhere.map((selector) => rerunOn(process.argv.slice(2), selector)).join(" or ")}`
        : missing && ref === "default" && reply.error?.startsWith('no persona "default" in the catalog of manager ')
          ? `nothing was launched; in the project shown above on the manager's host, run ${codeSpan(`cotal persona create default --space ${shellWord(t.space)} --prompt 'You are an agent on the Cotal mesh.' --subscribe ''`)}, then run the spawn again`
        : missing ? "nothing was launched; create that file on the manager's host, then run the spawn again"
        // This CLI refused before sending, so the manager reported nothing; the refusal names the side to update.
        : reply.details?.some((d) => d.kind === EP_UNDECLARED_ARG) ? "nothing was launched; update the side the refusal names, then run the spawn again"
        : "nothing was launched; fix what the manager reported, then run the spawn again" });
    }
    // A committed `failed` terminal is the manager's answer: the launch ran and failed, as an agent
    // that exits at once does, and the manager says why.
    if (reply.code === "failed") {
      const retry = spawnModelRetry(values, positionals, reply.error);
      throw new CommandFailure("failed", "OPERATION_FAILED", reply.error ? oneLine(reply.error) : "the manager reported that the launch failed", {
        target, native, ...(retry ? { remedy: retry, remedyIsCommand: true } : { remedy: "fix what the manager reported, then run the spawn again" }),
      });
    }
    const unknown = reply.nativeOutcome !== "executed" || reply.unanswered;
    throw new CommandFailure(unknown ? "unknown" : "failed", unknown ? "OPERATION_UNKNOWN" : "OPERATION_FAILED", reply.error ? oneLine(reply.error) : "the manager did not confirm launch readiness", { target, native, remedy: "inspect `cotal ps` and the selected manager before retrying; this launch was not submitted again" });
  }
  const { result, eventsNotice, startupNotice } = readManagedLaunch(reply, { space: t.space, requestedModel: values.model ?? null, detached: values.detach === true }, target);
  const { streamsTerminal } = result;
  const presentation = presentationOf(values);
  const warnings: OutputWarning[] = [
    ...(eventsNotice ? [{ code: "EVENT_PLANE_NOTICE", target, message: eventsNotice }] : []),
    ...(startupNotice ? [{ code: "STARTUP_NOTICE", target, message: `${result.name} joined, but ${startupNotice}` }] : []),
  ];
  if (observer) {
    try { observer.ready(result, warnings); }
    catch { throw new CommandFailure("partial", "OPERATION_PARTIAL", "the agent joined, but the composite command could not record its native readiness; no replacement was launched", { target, changed: [result], remedy: "inspect the original agent and manager before another launch" }); }
  } else writeResult(presentation, { command: "spawn", target, result, warnings }, (r) => managedLaunchView(r, values.server));
  if (values.detach) return;
  // A runtime that streams no terminal has none to attach, so this launch does not ask for one: the
  // seat is up, the receipt above says where it runs and what reaches it, and the command is done.
  // Asking anyway is the whole of this failure mode - the manager's refusal is correct and cannot
  // be retried, and turning a launch that did everything the runtime allows into a partial told the
  // operator to reattach, which that runtime cannot do either.
  if (streamsTerminal === false) return;
  // A partial names the step that works on this seat, on the manager that runs it: ps, then attach
  // where the runtime streams a terminal, or its own session where it streams none.
  const where = `--space ${shellWord(t.space)} --on ${shellWord(result.managerInstanceId)}`;
  const ps = `${displayCmd()} ps ${where}`;
  const next = async (): Promise<string> => (streamsTerminal ?? await registeredStreamsTerminal(result.runtime, t.space)) === false
    ? `nothing was relaunched; check the agent with ${codeSpan(ps)} and watch it in the manager's ${result.runtime} session, which has no terminal to attach`
    : `nothing was relaunched; check the agent with ${codeSpan(ps)}, then attach to it with ${codeSpan(`${displayCmd()} attach ${shellWord(result.name)} ${where}`)}`;
  let verdict: Awaited<ReturnType<typeof attachSeat>>;
  try {
    verdict = await attachSeat({ space: t.space, server: t.server, creds: values.creds, name: result.name, expectedTarget: { id: result.id, lifecycleUid: result.lifecycleUid }, asSeat: seat !== undefined }, { on: result.managerInstanceId, reconnect: true, onRefusal: "throw" });
  } catch (e) {
    throw new CommandFailure("partial", "OPERATION_PARTIAL", "the agent joined, but its terminal could not be attached; it was not relaunched", { target, changed: [result], native: { detail: oneLine((e as Error).message) }, remedy: await next() });
  }
  // A manager too old to report the terminal says so by refusing the attach, and that refusal ends
  // the launch as a reported one does. Since #4845 it carries a marker. Before it, the manager refused
  // with the runtime's own text and the code an agent that is not running also gets, so that refusal
  // counts only for a runtime this CLI's own registry declares streams no terminal.
  if (verdict.kind === "failed" && streamsTerminal === null && (verdict.refusal?.noTerminal || (verdict.refusal?.code === "failed-precondition" && await registeredStreamsTerminal(result.runtime, t.space) === false))) {
    stderrLine("", `the ${result.runtime} runtime has no terminal to attach, so none was opened; the agent runs in the manager's ${result.runtime} session`, c.dim);
    return;
  }
  if (verdict.kind === "failed") throw new CommandFailure("partial", "OPERATION_PARTIAL", "the agent joined, but attachment did not complete; no replacement was launched", { target, changed: [result], native: { detail: oneLine(verdict.message) }, remedy: await next() });
  if (verdict.kind === "gone" && observer) throw new CommandFailure("partial", "OPERATION_PARTIAL", "the agent joined, but its exact native terminal was unavailable before setup could open the view; no replacement was launched", { target, changed: [result], remedy: `check the original lifecycle with ${codeSpan(ps)} before another startup` });
  console.error(renderReport({ sections: [{ title: verdict.kind === "gone" ? "Attach target unavailable" : verdict.reason === "detached" ? "Detached" : "Attach session ended", blocks: [{ kind: "fields", rows: joinedAgentRows(result) }, { kind: "lines", lines: [{ text: "Leaving the view sent no stop request. The original lifecycle was not replaced.", tone: "hint" }] }] }] }, "rich", process.stderr));
}

/** Whether `runtime` streams a terminal, as a provider registered in this CLI or installed as its
 *  extension declares it. Null when this CLI has no such provider, or it does not say. */
async function registeredStreamsTerminal(runtime: string, space: string): Promise<boolean | null> {
  try {
    const declared: unknown = (await materializeExtension<RuntimeProvider>({ kind: "runtime", name: runtime })).create({ session: `cotal-${space}` }).streamsTerminal;
    return typeof declared === "boolean" ? declared : null;
  } catch { return null; }
}

/** The mesh's release of one agent lifecycle, when `mesh` is a remote user-auth mesh that advertises
 *  an agent-provisioning endpoint and the auth provider can call it there. */
export function meshRelease(mesh: MeshTarget | undefined): ((lifecycleUid: string, agent: string) => Promise<AgentLifecycleRelease>) | undefined {
  const ua = mesh?.mode === "user" && mesh.userAuth?.remote ? mesh.userAuth : undefined;
  const url = ua?.endpoints?.agentProvisioningUrl;
  if (!ua || !url) return undefined;
  const provider = resolveAuthProvider();
  if (!provider.releaseAgentLifecycle) return undefined;
  return (lifecycleUid, agent) => provider.releaseAgentLifecycle!({ url, idpUrl: ua.idp.url, lifecycleUid, actor: agent });
}

/** A managed launch whose process runs but has not joined the mesh: say where it runs and, when its
 *  harness waits for the operator, at which screen. A terminal attaches to an operator screen at once,
 *  even with -d, and to a starting agent only when the spawn was not detached; otherwise the attach
 *  command is printed. */
async function reportStarting(start: { name: string; managerInstanceId: string; waitingFor?: string; expected?: { id: string; lifecycleUid: string } }, values: FlagValues<typeof spawnFlags>, space: string, server: string, target: Record<string, unknown>): Promise<void> {
  const selection = await managerSelection(values, start.managerInstanceId).catch(() => undefined);
  const selector = selection?.selector ?? start.managerInstanceId, host = selection?.manager.host ?? null;
  const explicitServer = values.server === undefined ? undefined : brokerAddressForDisplay(values.server);
  const attach = `${onRerun(`${displayCmd()} attach`, { space, server: explicitServer }, [start.name])} --on ${shellWord(selector)}`;
  const presentation = presentationOf(values);
  const now = presentation !== "json" && canPrompt() && (start.waitingFor !== undefined || !values.detach);
  const place = `on ${selector}${host && host !== selector ? ` (${host})` : ""}`;
  writeResult(presentation, {
    command: "spawn",
    target,
    result: { kind: "managed-launch-running", name: start.name, managerInstanceId: start.managerInstanceId, host, waitingFor: start.waitingFor ?? null, attach },
  }, (r) => ({ sections: [{ title: r.waitingFor ? "Waiting for you" : "Agent starting", blocks: [{ kind: "lines", lines: [
    r.waitingFor ? `${r.name} is running ${place} and waiting for you at ${r.waitingFor}.` : `${r.name} is running ${place} and has not joined the mesh yet; it may still be starting or waiting at a prompt.`,
    { text: now ? "Attaching to it now." : `Attach to it: ${codeSpan(r.attach)}`, tone: "hint" },
  ] }] }] }));
  if (!now) return;
  const verdict = await attachSeat({ space, server, creds: values.creds, name: start.name, ...(start.expected ? { expectedTarget: start.expected } : {}) }, { on: start.managerInstanceId, reconnect: true, onRefusal: "throw" });
  if (verdict.kind === "failed") stderrLine("! ", `${start.name} could not be attached: ${verdict.message}; attach to it with ${codeSpan(attach)}`, c.yellow);
}

/** The agent a spawn asked for already runs, so nothing new is launched: say where it runs, then
 *  attach to it in this terminal unless the spawn was detached or cannot attach, or print the
 *  command that does. */
export async function reportAlreadyRunning(running: AgentAlreadyRunning, values: { detach?: boolean; creds?: string; json?: boolean; plain?: boolean; server?: string }, space: string, server: string | undefined): Promise<void> {
  const where = running.manager;
  const explicitServer = values.server === undefined ? undefined : brokerAddressForDisplay(values.server);
  const attach = where ? `${onRerun(`${displayCmd()} attach`, { space, server: explicitServer }, [running.agent])} --on ${shellWord(where.selector)}` : null;
  const presentation = presentationOf(values);
  const now = where !== null && !values.detach && presentation !== "json" && canPrompt();
  const place = where ? `on ${where.selector}${where.host && where.host !== where.selector ? ` (${where.host})` : ""}` : "on the mesh, not on a manager of yours";
  writeResult(presentation, {
    command: "spawn",
    target: { space, agent: running.agent, managerInstanceId: where?.instanceId ?? null },
    result: { kind: "already-running", name: running.agent, managerInstanceId: where?.instanceId ?? null, host: where?.host ?? null, attach },
    noOp: true,
  }, (r) => ({ sections: [{ title: "Already running", blocks: [{ kind: "lines", lines: [
    `${r.name} is already running ${place}; nothing new was launched.`,
    { text: now ? "Attaching to it now." : r.attach ? `Attach to it: ${codeSpan(r.attach)}` : "To start a second agent, pick another name with --name <other>.", tone: "hint" },
  ] }] }] }));
  if (!now) return;
  const verdict = await attachSeat({ space, server, creds: values.creds, name: running.agent }, { on: where!.instanceId, reconnect: true, onRefusal: "throw" });
  if (verdict.kind === "failed") stderrLine("! ", `${running.agent} could not be attached: ${verdict.message}; attach to it with ${codeSpan(attach!)}`, c.yellow);
}

/** Whether the manager `on` pins can launch an agent in `path`, answered by its `resolve-cwd` over
 *  a view of that manager acquired for this check alone. A path it cannot use is its refusal, which
 *  the question shows and asks again. A check it does not answer refuses the launch: the reason
 *  rides the structured cause rather than the sentence, because a responder's own words there are
 *  an internal subject and a spec reference, and the way past it is `-C <dir>`, which sends the
 *  folder with the launch and asks nothing. */
async function checkFolder(flags: ConnectFlags, on: string, path: string): Promise<FolderCheck> {
  const t = await resolveControlTarget(flags, "control-caller-privileged", on, { onRefusal: "throw" });
  const reply = await askManager(cliControl, t.space, t.server, "resolveCwd", { cwd: path }, t.auth, "owner", undefined, { instanceId: on });
  const cwd = reply.ok ? (reply.data as { cwd?: unknown } | undefined)?.cwd : undefined;
  if (typeof cwd === "string") return { cwd };
  if (!reply.ok && reply.code === "failed-precondition" && reply.error) return { refusal: oneLine(reply.error) };
  throw new CommandFailure("refused", "TARGET_UNAVAILABLE", `the folder ${JSON.stringify(path)} could not be checked with manager instance ${on}, so nothing was launched`, {
    target: { space: t.space, managerInstanceId: on },
    ...(reply.error ? { native: { ...(reply.code ? { code: reply.code } : {}), detail: { reason: oneLine(reply.error) } } } : {}),
    remedy: `send the folder with the launch instead of answering the question: ${codeSpan(rerunWithCwd(process.argv.slice(2), path, on))}`,
  });
}

/** Why no manager received an unpinned launch. A manager whose boot inventory found no agent
 *  application available leaves the class queue. When every live one that answered reports that on
 *  its instance rail, distinguish an empty connector inventory from installed but unavailable ones.
 *  A manager the broker affirms gone is skipped and named in a warning, so its registration costs
 *  no deadline and hides no reason. A seat
 *  (`flags` undefined) does not read the census as the operator. `agent` is the harness this caller
 *  would choose, for the install hint. */
async function unservedClassLaunch(flags: ConnectFlags | undefined, t: ControlTarget, agent: string | undefined, at: { target: object; native: object }): Promise<CommandFailure> {
  const census = flags ? await classLaunchCensus(flags, t).catch(() => undefined) : undefined;
  for (const instanceId of census?.gone ?? [])
    recordOperationWarning({ code: "MANAGER_SILENT", target: { space: t.space, managerInstanceId: instanceId }, message: `manager ${instanceId} was skipped: its registration is stale (the broker reports nothing subscribed on its rail; its host is gone and never deregistered)` });
  if (census?.noApplication && census.unavailable.length) {
    return new CommandFailure("refused", "DEPENDENCY_UNAVAILABLE", `no manager of yours takes unpinned launches: installed agent applications are unavailable (${census.unavailable.join("; ")}); nothing was launched`, { ...at,
      remedy: `install or repair the reported applications and dependencies on the named manager hosts. If the PATH used to start each manager needs to change, restart it under its own supervisor. For a saved manager service, use \`cotal service restart <name> --yes\`. For a foreground \`cotal up\` stack, stop it with \`cotal down --yes\` from its project folder or Ctrl-C in its terminal. This stops the broker and hosted workflow runs and can stop agents. Repeat the original foreground start with the updated PATH${census.empty.length ? `. No connectors are installed on ${census.empty.join(", ")}: add one there, such as ${extAddFor(agent ?? DEFAULT_CONNECTOR)}` : ""}.` });
  }
  if (census?.noApplication) {
    return new CommandFailure("refused", "DEPENDENCY_UNAVAILABLE", `no manager of yours takes unpinned launches: none ${census.gone.length ? "that answered " : ""}has an agent application installed${census.managers.length ? ` (${census.managers.join(", ")})` : ""}; nothing was launched`, { ...at,
      remedy: `add one where ${census.managers.length > 1 ? "one of them" : "that manager"} runs, such as ${extAddFor(agent ?? DEFAULT_CONNECTOR)}, then restart that manager; it reads its agent applications when it starts` });
  }
  return new CommandFailure("refused", "TARGET_UNAVAILABLE", "no manager of yours received this unpinned launch; nothing was launched", { ...at, remedy: "run the spawn again, or pin one manager with --on <instance> from `cotal ps`" });
}

/** Why no manager answered an unpinned launch's describe, so the launch was never sent. This root's
 *  own stack says why when it records one, in the words `ps` uses for the same silence. */
function unansweredClassLaunch(t: ControlTarget, at: { target: object; native: object }): CommandFailure {
  const refused = (message: string, remedy: string) => new CommandFailure("refused", "TARGET_UNAVAILABLE", `${message}, so the launch was not sent and nothing was launched`, { ...at, remedy });
  if (t.root !== undefined && stackManagerStarting(t.root, t.space)) return refused("the stack's manager is starting", "run the spawn again once `cotal up` reports the manager started");
  if (t.root !== undefined && stackManagerAbsent(t.root, t.space, { unanswered: true })) return refused("no manager is running for this space", startStackManagerRemedy(t.space, t.server));
  const pid = t.root === undefined ? undefined : runningStackManagerPid(t.root, t.space);
  if (pid !== undefined) return refused(`this space's stack manager (pid ${pid}) is running but did not answer`, `if it stays unresponsive, end that process with kill -KILL ${pid}; then bare \`cotal up\` starts the manager again`);
  return refused("no manager answered", "cotal ps shows which managers answer; run the spawn again once one does");
}

/** What the registered managers say about unpinned launches. `noApplication` holds when one answered
 *  and each one that answered says it runs agents but takes no unpinned launch; `gone` lists the
 *  managers skipped because the broker affirms nothing subscribed on their rail. Status has no
 *  scatter route, so each is read pinned to its instance, racing the rail probe: whichever settles
 *  first stops the other, so neither a live manager nor a gone one is waited out. */
async function classLaunchCensus(flags: ConnectFlags, t: ControlTarget): Promise<{ noApplication: boolean; gone: string[]; managers: string[]; unavailable: string[]; empty: string[] }> {
  const gone: string[] = [];
  const managers: string[] = [];
  const unavailable: string[] = [];
  const empty: string[] = [];
  for (const instanceId of await liveManagerIds(t.space, t.server, t.auth)) {
    const pinned = await resolveControlTarget(flags, "control-caller-privileged", instanceId, { onRefusal: "throw" });
    const settled = new AbortController();
    const status = await Promise.race([
      managerRailGone(pinned.space, pinned.server, pinned.auth, instanceId, settled.signal).then((isGone) => isGone ? undefined : new Promise<never>(() => {})),
      askManager(cliControl, pinned.space, pinned.server, "managerStatus", undefined, pinned.auth, "owner", 5_000, { instanceId, signal: settled.signal }),
    ]).finally(() => settled.abort());
    if (status === undefined) {
      gone.push(instanceId);
      continue;
    }
    const data = status.data as { classSpawn?: unknown; execution?: unknown; host?: unknown; connectors?: { agent: string; state: string; reason?: string }[] } | undefined;
    if (!status.ok || data?.classSpawn !== false || data.execution === "none") return { noApplication: false, gone, managers, unavailable, empty };
    const manager = managerAt(instanceId, data.host);
    managers.push(manager);
    if (data.connectors?.length) {
      for (const connector of data.connectors.filter(row => row.state === "unavailable"))
        unavailable.push(`${manager}: ${connector.agent}: ${oneLine(connector.reason ?? "unavailable at manager startup")}`);
    } else empty.push(manager);
  }
  return { noApplication: managers.length > 0, gone, managers, unavailable, empty };
}

/** A manager as a refusal names it: its instance id, and the host its own status reports. */
const managerAt = (instanceId: string, host: unknown): string => typeof host === "string" && host ? `manager ${instanceId} on host ${host}` : `manager ${instanceId}`;

/** {@link managerAt} for one manager, read pinned to it. A seat (`flags` undefined) reads with its
 *  own caller, and a status that cannot be read leaves the host out. */
async function managerNamed(flags: ConnectFlags | undefined, t: ControlTarget, instanceId: string): Promise<string> {
  try {
    const pinned = flags ? await resolveControlTarget(flags, "control-caller-privileged", instanceId, { onRefusal: "throw" }) : t;
    const status = await askManager(cliControl, pinned.space, pinned.server, "managerStatus", undefined, pinned.auth, "owner", 5_000, { instanceId });
    return managerAt(instanceId, status.ok ? (status.data as { host?: unknown } | undefined)?.host : undefined);
  } catch {
    return managerAt(instanceId, undefined);
  }
}

/** The `cotal ext add` that installs connector `name`, quoted for a refusal. */
const extAddFor = (name: string): string => OFFICIAL_CONNECTORS[name] ? `\`cotal ext add ${OFFICIAL_CONNECTORS[name]}\`` : `\`cotal ext add <npm-package>\` for "${name}"`;

/** The harness the manager's `spawn` resolves for this persona, read with the same fields `start` sends. */
async function launchAgentOrExit(t: ControlTarget, on: string | undefined, fields: { name: string; config?: string; defaultAgent?: string }): Promise<string> {
  const reply = await askManager(cliControl, t.space, t.server, "resolveAgent", fields, t.auth, "owner", undefined, { instanceId: on });
  failIfNotOk(reply);
  return (reply.data as { agent: string }).agent;
}

/**
 * Carry a session this host holds to the manager instance a detached resume launches on, and return
 * the claim its `spawn` names (#1499, docs/design/resume-transfer.md section 2). Undefined when this
 * host holds no session `id`: the id then resolves on the manager's host as it always has. Only the
 * connector can tell a local session from one that lives on the manager's host, so a connector this
 * CLI cannot load is refused.
 */
async function carryTranscript(flags: ConnectFlags, on: string | undefined, id: string, agent: string): Promise<string | undefined> {
  let connector: Connector;
  try { connector = await materializeExtension<Connector>({ kind: "connector", name: agent }); }
  catch (error) {
    if (isCommandFailure(error)) throw error;
    if (!connectorListed(agent)) throw missingConnector(agent, { space: flags.space });
    throw new CommandFailure("refused", "DEPENDENCY_UNAVAILABLE", `resume: ${oneLine((error as Error).message)}`);
  }
  let found: { path: string; title?: string } | undefined;
  try {
    found = connector.resumeTranscript?.find(id, process.env);
  } catch (error) {
    throw localDiagnostic(isCommandFailure(error) ? error : new CommandFailure("refused", "USAGE_INVALID", `resume: ${(error as Error).message}`, { selfContained: true }));
  }
  if (found === undefined) return undefined;
  if (on === undefined) {
    throw localDiagnostic(new CommandFailure("refused", "USAGE_INVALID", `resume: session ${id} is held on this host, and carrying it needs one manager instance`, {
      remedy: "pass --on <instance>", selfContained: true,
    }));
  }
  const bytes = readFileSync(found.path);
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const t = await resolveControlTarget(flags, "control-caller-admin", on);
  recordOperationSpace(t.space);
  const bucket = transferBucket(t.space, on);
  const writer = await transferWriterOrExit(flags, t, on, sha256);
  let sent = 0;
  let chunks = 0;
  for (;;) {
    const reply = await askManager(cliControl, t.space, t.server, "transcriptReceive", {
      sha256, size: bytes.length, source: id, sourceHost: hostname(), ...(found.title ? { title: found.title } : {}),
    }, t.auth, "owner", undefined, { instanceId: on });
    failIfNotOk(reply);
    const answer = reply.data as { state: "upload" } | { state: "staged"; claim: string };
    if (answer.state === "staged") {
      console.log(c.dim(`carried session ${id} to ${on}: sha256:${sha256}, ${sent} of ${bytes.length} bytes sent in ${chunks} chunks`));
      return answer.claim;
    }
    const pass = await withControlConnection(t.server, writer, (nc) => writeTransfer(nc, bucket, bytes));
    sent += pass.sent;
    chunks += pass.chunks;
  }
}

/** The transfer writer instrument for one object in one instance's bucket (design section 6), once
 *  the transcript is hashed: minted from this host's copy of the mesh's signing seed, or on a
 *  user-auth mesh exchanged from the operator's login as a `transfer-writer` view. An open mesh
 *  enforces no grants, so a bare connection writes there. */
async function transferWriterOrExit(flags: ConnectFlags, t: ControlTarget, instanceId: string, hex: string): Promise<ControlAuth> {
  if (t.mode === "open") return { tls: t.auth.tls };
  if (t.mode === "user") {
    const conn = await connectUserControlOrExit(flags);
    try {
      const view = await userViewAuth(conn, "transfer-writer", { transferWriter: { instanceId, hex } });
      return { bearer: view.bearer, sentinelCreds: view.sentinelCreds, tls: conn.tls };
    } catch (e) {
      stderrLine("✗ ", `resume: ${(e as Error).message}`, c.red);
      process.exit(1);
    }
  }
  if (t.mode !== "auth" || !t.spaceAuth) {
    stderrLine("✗ ", "resume: carrying a session mints a transfer writer from this mesh's signing seed, and this host holds none for it (an off-registry connection)", c.red);
    process.exit(1);
  }
  return { creds: await mintCreds(t.spaceAuth, newIdentity(), "transfer-writer", { transferWriter: { instanceId, hex } }), tls: t.auth.tls };
}
