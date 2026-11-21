import { existsSync, lstatSync, readFileSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import {
  CommandFailure,
  isCommandFailure,
  isMeshRegistryError,
  preparedRecordSpace,
  preparedSpacesDir,
  logicalExecutionEntry,
  resolveControlTarget,
  ConnectRefusal,
  isConnectRefusal,
  isWorkspaceTargetError,
  localMeshesForRoot,
  preparedNeverStarted,
  pruneStaleMeshes,
  renderWorkspaceError,
  resolveMeshTarget,
  type ControlTarget,
  type MeshTarget,
  type MeshTargetErrorDetails,
} from "@cotal-ai/workspace";
import { entryScript } from "../seed/paths.js";
import { c } from "../ui.js";
import { assertEndpointUnreachable } from "../lib/endpoint-cut.js";
import { isCliEntry, supervisorMayServe } from "../lib/manager-proc.js";
import { processGone, readStackJournal, stackScopeRefusals } from "../lib/stack-journal.js";
import { observeServiceProcess, serviceInstances, serviceInstanceStore } from "../lib/service-instances.js";
import { legacyManagerReport, legacySeatLabel, type LegacyManagerReport } from "../lib/legacy-manager-report.js";
import { recordedStackRemedy, type RecordedStackRemedy } from "../lib/recorded-stack-remedy.js";
import { askManager } from "@cotal-ai/workspace/control";
import { cliControl } from "../lib/control.js";
import { managerPin } from "../lib/manager-choice.js";
import { localUpdateManagers, recordedUpdateManagers, type UpdateManager } from "../lib/update-managers.js";
import { assertRecordIdentity, brokerAddressKey, brokerUrlKey } from "@cotal-ai/workspace";
import { message } from "./update-process.js";

/** The "no mesh running" target refusal: no recorded mesh on this machine, or every recorded mesh
 *  down with none selected. Either way no manager is running. A mesh selected with `--space` or
 *  from inside its project, a named space, a broken record, or a dead broker each still names a
 *  manager this command was asked about, unless {@link isStoppedLocalMesh} proved that mesh stopped
 *  before the control connect. */
function isNoMeshRefusal(e: unknown): boolean {
  return e instanceof ConnectRefusal && isWorkspaceTargetError(e.cause) && e.cause.code === "no-meshes";
}

/** Whether `target` is a mesh this machine runs, stopped: no `cotal supervise` process here may be
 *  serving its space and nothing listens at its recorded broker. Both are required. A manager
 *  outlives its broker and reconnects when it returns, so a refused connection alone leaves its
 *  custody in place; a supervisor whose argv names this space or none, a peer that accepts, answers
 *  or stalls, a mesh registered by hand, or a `--server` the operator named may still have a manager
 *  behind it. A project that only ran setup has no registry entry yet; its implicit local default
 *  is eligible for the same process and listener checks, but an explicit server is not. */
export async function isStoppedLocalMesh(target: MeshTarget): Promise<boolean> {
  const registered = localMeshesForRoot(target.root).some((m) => m.space === target.space && m.server === target.server);
  if (!registered && target.source !== "local-space") return false;
  if (supervisorMayServe(target.space)) return false;
  return assertEndpointUnreachable(target.server).then(() => true, () => false);
}

/** A prepared controller that completed down or failed to start any member is cold only while its
 *  own instance records prove every process gone, no supervisor may serve it, and its broker has no listener.
 *  The target resolver refuses before returning a MeshTarget for this lifecycle. */
async function stoppedController(d: MeshTargetErrorDetails, server: string | undefined): Promise<boolean> {
  if (typeof d.space !== "string" || typeof d.root !== "string" || !d.stopped ||
      d.rootMissing === true || d.unsettled !== undefined || d.home !== undefined || d.stackSpace !== undefined) return false;
  const journal = readStackJournal(d.root)?.journal;
  if (!journal || journal.space !== d.space) return false;
  const completedDown = journal.operation.kind === "down" && journal.operation.phase === "completed";
  const failedStart = journal.operation.kind === "up" && journal.operation.phase === "failed" &&
    journal.members.every(member => (member.state === "failed" || member.state === "not-attempted") && !member.process && !member.replacement);
  if (!completedDown && !failedStart) return false;
  if (server !== undefined && brokerUrlKey(server) !== brokerUrlKey(journal.server)) return false;
  const instances = serviceInstances(d.space);
  if (journal.members.some((member) => member.instanceId !== null &&
      !instances.some((row) => row.name === member.instanceId && row.record.value.definition === member.definition))) return false;
  if (instances.some((row) => !["stopped", "failed"].includes(row.record.value.state) || !processGone(observeServiceProcess(row.record.value)))) return false;
  if (supervisorMayServe(d.space)) return false;
  const brokerStopped = await assertEndpointUnreachable(journal.server).then(() => true, () => false);
  stackScopeRefusals(journal, `\`cotal update --space ${d.space}\``, { brokerStopped });
  return brokerStopped;
}

/** The refusal sentence this command prints. A {@link MeshTargetError} arrives RAW here — the
 *  control resolver rethrows the codes it does not absorb before the connect helper can wrap them —
 *  so its `message` is the resolver's bare, command-agnostic text, with none of the recovery copy
 *  every other surface shows. Render it the way `status` and `ps` do, dropping the rendered line's
 *  own `✗` because this one is already printed under the command's marker; a `ConnectRefusal`
 *  already carries that rendering as its message. Keep a CommandFailure's recovery step too. */
export function refusal(e: unknown): string {
  const text = isWorkspaceTargetError(e)
    ? renderWorkspaceError({ kind: "target", error: e }).replace(/^✗ /, "")
    : message(e);
  const remedy = e instanceof CommandFailure ? e.remedy : undefined;
  return remedy === undefined ? text : `${text}\n\nNext\n  ${remedy}`;
}

/** The running meshes an `ambiguous-target` named, or undefined when this refusal names none to act
 *  on (several tenants on one root, an unreadable account record) and so stands. */
function runningSpaces(e: unknown): string[] | undefined {
  if (!isWorkspaceTargetError(e) || e.code !== "ambiguous-target") return undefined;
  const spaces = e.details.spaces;
  return spaces && spaces.length > 1 ? spaces : undefined;
}

/**
 * The continuity read for every manager this update is asked about, not just one of them.
 *
 * `update --self` replaces the single `cotal-ai` install every running manager on the machine
 * shares, so with no `--space` / `--server` / `--creds` the question is asked about all of them.
 * Reporting one and staying silent about the rest is a partial answer; refusing outright leaves the
 * operator with no continuity report at all. So an ambiguous target is enumerated and read once per
 * running mesh, and every one of them is observed before this returns and anything is written
 * (#1620). A `legacy` verdict on any of them makes the whole run not a hot update. A selector flag
 * still selects one, and every other refusal stands.
 */
export async function reportRunningManagers(
  flags: Record<string, unknown>,
  readOne: (flags: Record<string, unknown>) => Promise<"none" | "legacy"> = readManagerContinuity,
  census: (flags: Record<string, unknown>) => readonly UpdateManager[] = localUpdateManagers,
  options: { retainGraph?: boolean } = {},
): Promise<"none" | "legacy"> {
  // Raw credentials are an explicit off-registry target, not an install-wide discovery request.
  if (typeof flags.creds === "string") return readOne(flags);
  const on = typeof flags.on === "string" ? await managerPin(flags, "cotal update") : undefined;
  const observed = census({ ...flags, on });
  // A Manager of another home is named and left alone. It never changes which of this home's
  // Managers are selected, nor whether the selected mesh is read.
  for (const manager of observed) if (manager.ownership === "foreign") await readUpdateManagerContinuity(manager, flags, readOne, options);
  const local = observed.filter(manager => manager.ownership !== "foreign");
  const selected = local.filter(manager =>
    (typeof flags.space !== "string" || manager.space === flags.space) &&
    (typeof flags.server !== "string" || brokerAddressKey(manager.server) === brokerAddressKey(flags.server)) &&
    (on === undefined || manager.instanceId === on));
  if (selected.length) {
    let verdict: "none" | "legacy" = "none";
    for (const manager of selected) {
      if (await readUpdateManagerContinuity(manager, flags, readOne, options) === "legacy") verdict = "legacy";
    }
    return verdict;
  }
  if (on !== undefined && local.length) throw new Error(`--on ${on} does not name a local Manager sharing this installation`);
  try {
    return await readOne(flags);
  } catch (e) {
    const selected = ["space", "server", "creds", "on"].some((name) => typeof flags[name] === "string");
    const spaces = selected ? undefined : runningSpaces(e);
    if (!spaces) throw e;
    console.log(c.dim(`${spaces.length} meshes running; reading each manager's continuity`));
    let verdict: "none" | "legacy" = "none";
    for (const space of spaces) {
      console.log(c.bold(space));
      // Every manager is read, including after a legacy verdict: the report is about all of them,
      // and stopping at the first would reintroduce the partial answer from the other direction.
      if (await readOne({ ...flags, space }) === "legacy") verdict = "legacy";
      else console.log(c.dim("  manager custody carries this update"));
    }
    return verdict;
  }
}

/** Read one known local Manager without requiring another home's credentials. */
export async function readUpdateManagerContinuity(
  manager: UpdateManager,
  flags: Record<string, unknown>,
  readOne: (flags: Record<string, unknown>) => Promise<"none" | "legacy"> = readManagerContinuity,
  options: { retainGraph?: boolean } = {},
): Promise<"none" | "legacy"> {
  if (typeof flags.creds === "string") return readOne(flags);
  const pin = () => {
    if (manager.process && assertRecordIdentity(manager.process).kind !== "match") throw new Error(`local Manager ${manager.instanceId} changed during its continuity read`);
  };
  pin();
  if (manager.ownership === "foreign") {
    console.log(`Manager pid ${manager.pid}, instance unavailable in space ${JSON.stringify(manager.space)} at ${JSON.stringify(manager.root)} keeps running the version it loaded until it is restarted from its own home; its root is not registered in this home.`);
    pin();
    return "none";
  }
  try {
    const verdict = await readOne({ ...flags, space: manager.space, server: manager.server, on: manager.instanceId });
    pin();
    return verdict;
  } catch (error) {
    pin();
    const cause = isConnectRefusal(error) ? error.cause as { code?: unknown } | undefined : undefined;
    if (!options.retainGraph || !manager.process || typeof flags.creds === "string" || !isConnectRefusal(error) || error.code !== "AUTH_REQUIRED" ||
        (error.native?.code !== "CREDENTIALS_MISSING" && cause?.code !== "signed-out")) throw error;
    console.log(`Manager ${manager.instanceId} in space ${JSON.stringify(manager.space)} at ${JSON.stringify(manager.root)} keeps running the version it loaded until it is restarted from its own home; this home has no credentials for its space.`);
    return "none";
  }
}

/** Link the answering Manager to the controller's live process before excluding its installation. */
function isForeignStackManager(target: ControlTarget, status: { instanceId?: unknown; lifecycleUid?: unknown } | undefined, installedEntry?: string): boolean {
  if (process.platform !== "linux" || !target.root || !status || typeof status.instanceId !== "string" || typeof status.lifecycleUid !== "string") return false;
  try {
    const journal = readStackJournal(target.root)?.journal;
    if (!journal || journal.operation.kind !== "up" || journal.operation.phase !== "completed" || journal.space !== target.space || brokerAddressKey(journal.server) !== brokerAddressKey(target.server)) return false;
    const member = journal.members.find(row => row.role === "manager");
    if (!member?.instanceId || !member.process) return false;
    const instance = serviceInstanceStore(target.space).read(member.instanceId)?.record.value;
    const native = instance?.adapterReadiness?.native;
    if (!instance?.process || instance.definition !== member.definition || instance.state !== "running" ||
        instance.process.pid !== member.process.pid || instance.process.token !== member.process.token ||
        native?.instanceId !== status.instanceId || native.lifecycleUid !== status.lifecycleUid || observeServiceProcess(instance) !== "running") return false;
    const argv = readFileSync(`/proc/${instance.process.pid}/cmdline`, "utf8").split("\0");
    // The controller places only the optional global color flag after its Node entry.
    const verb = argv.indexOf("__service-manager");
    const launch = argv[verb - (argv[verb - 1] === "--no-color" ? 2 : 1)];
    if (!launch || !isAbsolute(launch)) return false;
    const entry = realpathSync(launch);
    const own = realpathSync(installedEntry ?? logicalExecutionEntry() ?? entryScript());
    return entry !== own && isCliEntry(entry) && assertRecordIdentity(instance.process).kind === "match";
  } catch {
    // An unreadable record or launch entry cannot prove a different installation.
    return false;
  }
}

export async function readManagerContinuity(flags: Record<string, unknown>, options: { readOnly?: boolean; retainGraph?: boolean; installedEntry?: string } = {}): Promise<"none" | "legacy"> {
  const { readMeshRegistry } = await import("@cotal-ai/workspace");
  const registry = readMeshRegistry();
  if (registry.unusable.length) throw registry.unusable[0];
  const local = registry.entries.filter(entry => entry.mode !== "user" &&
    (typeof flags.space !== "string" || flags.space === entry.space) &&
    (typeof flags.server !== "string" || brokerAddressKey(flags.server) === brokerAddressKey(entry.server)));
  const { goneStackRoot } = await import("../lib/stack-journal.js");
  const gone = typeof flags.creds === "string" ? [] : local.filter(entry => !existsSync(entry.root) || goneStackRoot(entry.space) !== undefined);
  for (const entry of gone) console.log(`  ${entry.space}: folder is gone; leaving its processes untouched, continuity not checked`);
  if (gone.length && gone.length === local.length) return "none";
  if (gone.length) {
    let verdict: "none" | "legacy" = "none";
    for (const entry of local.filter(entry => !gone.includes(entry))) {
      if (await readManagerContinuity({ ...flags, space: entry.space, server: entry.server }, options) === "legacy") verdict = "legacy";
    }
    return verdict;
  }
  // `--on` names the manager whose custody this install carries. An owner with several live
  // managers on a user-auth mesh (one per machine, say) gets the exchange's selection refusal
  // without it, naming `--on` as the remedy; the flag has to exist here for that remedy to be real,
  // and it has to reach the MINT below, since a credential cannot gain an instance rail after it is
  // issued. A name or host resolves to an instance id the same way `ps` resolves it.
  let on = await managerPin(flags, "cotal update");
  // #2158: a remote user mesh's manager runs under another install, on another machine. Replacing
  // THIS machine's binary interrupts no manager there, so there is no custody here to preserve and
  // no answer from that mesh's exchange can change what this install does. Peek the mode the same
  // way the control resolver's own peek does (offline-swept when no space is named, `--space`
  // unfiltered) and skip the mint entirely for a remote entry, before it ever reaches the exchange.
  // The control resolve below reads the same sweep, so the whole chain sees one liveness verdict.
  let sweep: Awaited<ReturnType<typeof pruneStaleMeshes>> | undefined;
  let remoteSpace: string | undefined;
  if (typeof flags.creds !== "string") {
    const space = typeof flags.space === "string" ? flags.space : undefined;
    const server = typeof flags.server === "string" ? flags.server : undefined;
    let peek: MeshTarget | undefined;
    try {
      // This sweep only probes. Read-only staged checks need the same liveness verdict.
      sweep = await pruneStaleMeshes(server, space === undefined ? "targets" : "brokers");
      peek = resolveMeshTarget(process.cwd(), { server, space, ...sweep });
    } catch (e) {
      // An unreadable prepared record is not evidence about Manager custody. The updater can
      // leave it alone only if it was not asked for a broker or instance and has no potentially
      // running registration or supervisor to check for the affected target.
      if (isMeshRegistryError(e) && e.refusal === "PERMISSION_DENIED" && dirname(e.file) === preparedSpacesDir()) {
        const name = preparedRecordSpace(e.file);
        if (name !== undefined && server === undefined && on === undefined &&
            !registry.entries.some(entry => space === undefined ? !sweep?.offline.includes(entry.space) : entry.space === space) &&
            !supervisorMayServe(name, options.installedEntry)) return "none";
      }
      if (!isWorkspaceTargetError(e)) throw e;
      // Sudo can inspect another account's project without owning its controller records.
      // The install-wide census already preserves its Manager. Do not borrow that account's
      // authority or reinterpret its implicit project as this home's selected mesh.
      if (e.code === "not-started" && typeof e.details.root === "string" && typeof e.details.stackSpace === "string" &&
          e.details.recordedRoot === undefined && process.getuid &&
          !["space", "server", "creds", "on"].some(key => typeof flags[key] === "string") &&
          (() => { const directory = lstatSync(join(e.details.root!, ".cotal")); return directory.isDirectory() && directory.uid !== process.getuid!(); })()) {
        console.log(`  ${e.details.stackSpace}: controller records in ${e.details.root} belong to another account; leaving its records and processes untouched, continuity not checked`);
        return "none";
      }
      // Prepared-only spaces have no registry entry for the gone-root check above.
      // As with a registered gone root, leave its records and processes untouched.
      if (e.code === "not-started" && e.details.rootMissing === true) {
        console.log(`  ${e.details.space}: folder is gone; leaving its processes untouched, continuity not checked`);
        return "none";
      }
      if (e.code === "not-started" && e.details.recordedRoot !== undefined) {
        console.log(c.dim(`  ${e.details.stackSpace ?? e.details.root}: stack records in ${e.details.root} belong to ${e.details.recordedRoot}; leaving its records and processes untouched, continuity not checked`));
        return "none";
      }
      // A refused legacy start can leave a rendered broker config without ever starting a member.
      // That file cannot prove custody or its absence. Leave the project alone without claiming
      // continuity, rather than requiring a successful start before a software update.
      if (e.code === "not-started" && e.details.lastRun === true) {
        console.log(c.dim(`  ${e.details.stackSpace ?? e.details.root}: retained broker configuration in ${e.details.root}; leaving its records and processes untouched, continuity not checked`));
        return "none";
      }
      // A space prepared here that never started (`cotal setup --configure-only`, `space create`)
      // has no broker, no stack journal and no manager: a supervisor serves a started stack, and
      // this one never launched a member, so there is nothing this update could interrupt. Run from
      // its folder, or with it selected or named, the resolver refuses it as not started before
      // dialing anything, which is the right answer for a command that needs a mesh and the wrong
      // one for a software update, which needs only to know that no manager here holds custody.
      if (e.code === "not-started" && preparedNeverStarted(e.details)) {
        console.log(c.dim(`  ${e.details.space}: prepared in ${e.details.root}, not started; no manager running`));
        return "none";
      }
      if (e.code === "not-started" && await stoppedController(e.details, server)) {
        console.log(c.dim(`  ${e.details.space}: stopped; no manager running`));
        return "none";
      }
      if (e.code !== "unknown-space" && e.code !== "no-meshes") throw e;
    }
    // The skip holds only while no supervisor that loaded THIS install may be serving that space.
    // A `cotal manager start` or `cotal supervise` process here that loaded this install and serves a
    // remote mesh is read like a local manager. A supervisor whose command resolves in another
    // install is untouched by replacing this one, so it is no custody here, the same as a manager
    // that runs on another machine.
    if (peek?.mode === "user" && peek.userAuth?.remote === true) {
      remoteSpace = peek.space;
      const recorded = on === undefined ? recordedUpdateManagers({ space: peek.space, server: peek.server }, options.installedEntry) : [];
      if (recorded.length > 1) {
        let verdict: "none" | "legacy" = "none";
        for (const manager of recorded) {
          if (manager.process && assertRecordIdentity(manager.process).kind !== "match") throw new Error(`local Manager ${manager.instanceId} changed before its continuity read`);
          if (await readManagerContinuity({ ...flags, space: manager.space, server: manager.server, on: manager.instanceId }, options) === "legacy") verdict = "legacy";
        }
        return verdict;
      }
      if (recorded.length === 1) on = recorded[0]!.instanceId;
      if (on === undefined && process.platform !== "win32" && !supervisorMayServe(peek.space, options.installedEntry)) {
        console.log(c.dim(`  ${peek.space}: this mesh's manager runs elsewhere; no custody on this machine`));
        return "none";
      }
      console.log(c.dim(`  ${peek.space}: a manager for this mesh runs on this machine; reading its custody`));
    }
    // Explicit and in-folder targets are not filtered by the resolver's offline set.
    if (peek && sweep?.offline.includes(peek.space) && on === undefined &&
        !supervisorMayServe(peek.space, options.installedEntry)) return "none";
    // #3559: `cotal down` then `cotal update` is the cold path past a `legacy` verdict, so a stopped
    // mesh is no custody rather than a refusal. Decided before the control connect, whose user-mode
    // exchange would refuse on the stopped auth service first.
    if (peek && remoteSpace === undefined && await isStoppedLocalMesh(peek)) {
      console.log(c.dim(`  ${peek.space}: stopped; no manager running`));
      return "none";
    }
  }
  let target: ControlTarget;
  try {
    target = await resolveControlTarget({
      ...(typeof flags.space === "string" ? { space: flags.space } : {}),
      ...(typeof flags.server === "string" ? { server: flags.server } : {}),
      ...(typeof flags.creds === "string" ? { creds: flags.creds } : {}),
      ...sweep,
    }, "control-caller-admin", on, { onRefusal: "throw", readOnly: true });
  } catch (e) {
    const failure = e instanceof ConnectRefusal ? e.failure() : isCommandFailure(e) ? e : undefined;
    if (remoteSpace !== undefined && on === undefined && e instanceof ConnectRefusal && failure?.code === "PERMISSION_DENIED" && /\(view "manager-caller"\) was refused: manager-caller selection found (?:[2-9]|\d{2,}) live remote manager candidates for owner \S+ \([A-Za-z0-9_, -]+\); exactly one is required, so name one with --on <instanceId>/.test(failure.message)) {
      console.log(`  ${remoteSpace}: several Managers are live and no local instance could be identified; continuing the software update.`);
      return "none";
    }
    // No running manager means no custody to preserve and nothing this update could interrupt. Only
    // the "no mesh running" refusal reads as "none": no recorded mesh, or every recorded mesh down
    // with none selected. A selected stopped mesh was already read above; a named space that is not
    // running, a broken record, or a broker that did not answer still names a manager this command
    // was asked about, and stays a refusal.
    if (isNoMeshRefusal(e)) return "none";
    throw e;
  }
  const pin = on === undefined ? {} : { instanceId: on };
  const status = await askManager(cliControl, target.space, target.server, "managerStatus", undefined, target.auth, "owner", undefined, pin);
  if (!status.ok) {
    // The MARKER, not the sentence. `unanswered` is the structural fact `epRailFailure` sets from
    // core's answer-provenance marker; the headline beside it is operator prose and is now scoped to
    // the rail the caller rode (#1630), so this call, which runs under an issued control caller, saw
    // the headline naming the versioned rail and threw instead of reporting "none". Unpinned, an
    // unanswered reply is the verdict that no manager holds custody. Pinned, it is a manager the
    // operator named and this command could not read, which is not "none".
    if (status.unanswered && on === undefined) return "none";
    throw new Error(status.error ?? "manager status request failed");
  }
  if (typeof flags.creds !== "string" && isForeignStackManager(target, status.data as { instanceId?: unknown; lifecycleUid?: unknown } | undefined, options.installedEntry)) return "none";
  const seats = await askManager(cliControl, target.space, target.server, "ps", undefined, target.auth, "owner", undefined, pin);
  if (!seats.ok) throw new Error(seats.error ?? "manager seat inventory request failed");
  if (options.retainGraph) {
    const custody = (status.data as { custody?: unknown } | undefined)?.custody;
    if (custody === undefined || custody === "legacy") console.log(`Standalone Manager ${on ?? "(instance unavailable)"} in ${JSON.stringify(target.space)} keeps its loaded execution generation; no restart or seat stop is requested. New launches remain subject to the extension generation check.`);
    return "none";
  }
  const report = await legacyManagerReport(
    (status.data ?? {}) as { custody?: unknown },
    Array.isArray(seats.data)
      ? seats.data.map((seat) => {
          const row = seat as { name?: unknown; agent?: unknown; id?: unknown };
          const id = typeof row.id === "string" && row.id.trim() ? row.id : undefined;
          return { name: typeof row.name === "string" ? row.name : "", agent: typeof row.agent === "string" ? row.agent : "", ...(id ? { id } : {}) };
        })
      : [],
  );
  if (!report) return "none";
  const remedy = typeof flags.creds === "string" ? undefined : recordedStackRemedy(target.root, target.space, target.server, (status.data ?? {}) as { instanceId?: unknown; lifecycleUid?: unknown });
  printLegacyReport(report, target.space, undefined, console.log, on, remedy);
  return "legacy";
}

/** Name legacy custody and the cold update sequence without guessing its hosting lifecycle.
 *  An endpoint identity is not a saved service instance or proof of its original starter.
 *  The third argument is retained for callers, but an unverified stop command is not a remedy. */
export function printLegacyReport(
  report: LegacyManagerReport,
  space: string,
  _stop: string | undefined = undefined,
  out: (line: string) => void = console.log,
  manager?: string,
  recorded?: RecordedStackRemedy,
): void {
  out(c.yellow("! legacy manager custody: PTY continuity is impossible; this update is not a hot update"));
  out(`  Manager ${manager ?? "(instance unavailable)"} in space ${JSON.stringify(space)}: ${report.seats.length} seats`);
  for (const seat of report.seats)
    out(c.dim(`  ${legacySeatLabel(seat)}: ${seat.continuity}`));
  if (recorded) {
    out(`  Recorded stack root: ${recorded.root}`);
    out("  This is a manual cold update. The listed seats end and are not restarted. Nothing was stopped by this command.");
    out("  Run these commands in order:");
    for (const command of recorded.commands) out(`    ${command}`);
    return;
  }
  out("  Cannot determine this Manager's original hosting command. Obtain its exact stop and start commands before stopping it; do not infer a service instance from its Manager identity.");
  out("  Next: stop this Manager through its original host, ending any seats listed above; run `cotal update --self`, then restart through that host with the original start command. This is a cold update, including for a Manager with 0 seats.");
}
