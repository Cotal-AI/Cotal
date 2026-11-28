import { accessSync, constants, existsSync, lstatSync } from "node:fs";
import { join } from "node:path";
import {
  CotalEndpoint,
  globalConfigDir,
  isReachable,
  mintCreds,
  realDirNoSymlink,
  newIdentity,
  personaDir,
  type FlagValues,
  type ParsedArgs,
} from "@cotal-ai/core";
import {
  UnreadableConnectorSelection,
  stackRunsUnderOtherHome,
  accountInventory,
  authDir,
  isCommandFailure,
  readMaintenanceJournal,
  recordsElsewhereError,
  restoreRolledBackRuns,
  brokerAddressForDisplay,
  brokerUrlKey,
  canonicalRoot,
  codeSpan,
  CommandFailure,
  DELIVERY_PIDFILE,
  extensionsDir,
  findCotalRoot,
  meshesForRoot,
  migrateProjectTrust,
  resolveReadsLiveness,
  unsettledStackOperation,
  withdrawOperationNote,
  hasUserAuthState,
  homeCotalDir,
  installationWriter,
  cachedPreferences,
  resolvePreference,
  isWorkspaceTargetError,
  loadSoleSpaceAuth,
  localProcessPath,
  localProcessVisible,
  PREFERENCE_KEYS,
  preparedNeverStarted,
  presentationOf,
  stackJournalPath,
  readRenewalRecord,
  recordOperationSpace,
  resolveMeshTarget,
  writeResult,
  preferencesPath,
  preferencesFolderWarning,
  cotalDirLink,
  type LocalProcessContext,
  type MeshEntry,
  type MeshTarget,
  type OutputWarning,
  type Preferences,
} from "@cotal-ai/workspace";
import { localProcessSurface } from "../ext-loader.js";
import { cliVersion, cliProvenance, readExtensionVersions } from "../lib/version.js";
import { agentSkillsSkew } from "../lib/agent-skills.js";
import { managerHasDeliveryMarker } from "../lib/manager-proc.js";
import { signedInSpace } from "../lib/conversation-identity.js";
import { clientStatusRows, connectorHarnesses, connectorStatusRows, machineStatus, recordedWebUrl, webInstalled, type HarnessStatus } from "../lib/status.js";
import { legacyManagerStopped, statusRuntimeSpace } from "./status-legacy.js";
import { deliveryResponderState, deliveryRowSuffix, type DeliveryResponderState } from "../lib/delivery-responder.js";
import { brokerStoreWrite, storeFull } from "../lib/broker-store-health.js";
import { pidfileState, type PidfileState } from "./down.js";
import { selectResetTarget } from "./reset-store-apply.js";
import { displayCmd } from "../lib/self-exec.js";
import { shellWord } from "../lib/endpoint-errors.js";
import { readPersonas } from "../lib/personas.js";
import { defaultPersonaPin, directPersonaPath } from "../lib/spawn-defaults.js";
import { agentStatus } from "./agents.js";
import { invalidEnvironmentValues } from "./config.js";
import { canPrompt } from "./meshes-wizard.js";
import { onInstance, onRerun } from "../lib/control.js";
import { managerRosterHint } from "../lib/manager-choice.js";
import { serviceDefinitionProjection, serviceDefinitionStore } from "../lib/service-definitions.js";
import { instanceProjection, serviceInstances } from "../lib/service-instances.js";
import { readinessAddressSurvivors } from "../lib/service-process.js";
import { freshTeamAttemptSettled, listFreshTeamAttempts, listFreshTeamSummaries } from "../lib/team-fresh.js";
import { additiveTeamRecordedState, listAdditiveTeamAttempts } from "../lib/team-additive-attempt.js";
import { maintenanceNextStep } from "../lib/restore.js";
import {
  journalRecordedElsewhere,
  readStackJournal,
  serviceHeldRecords,
  STACK_ADAPTER,
  STACK_DEFINITION,
  stackRecordedWithoutManager,
  stackOperationBlock,
  unfinishedStackOperation, stackUpInProgress,
  type StackJournal,
  type StackOperationBlock,
} from "../lib/stack-journal.js";
import { cotalLinkHere, linkedCotalRemedy } from "../lib/paths.js";
import { rootStoreProblem } from "../lib/store-dir.js";
import { lostRecordsRecovery } from "./stack-lost-records.js";
import { readCursor } from "../seed/lock.js";
import { reconcileCursorPath } from "../seed/paths.js";
import {
  statusFlags,
  type Selected,
  type SelectedPreflight,
  UnregisteredRoot,
  type ProcessRow,
  type OwnedServiceStatus,
  type StatusResult,
  Gaps,
  type ManagerObservation,
} from "./status-model.js";
import { servedStack, folderStack, backupRecovery, statusView } from "./status-render.js";
import {
  expectedDeliveryHolder,
  localManagerInstanceId,
  userManagerStatus,
  managerNoService,
  processRecord,
  componentCredential,
  staticServiceAuth,
  type ManagerServiceStatus,
  managerServiceHealth,
  printComponentHealth,
} from "./status-health.js";
import { registryFallbackChecks, personaCatalog, readMeshes, readStackStoreWarnings, readSelected, readStatusPreflight, reportHeldRestartProblem, selectedRecovery, selectedStackStarting } from "./status-meshes.js";

export { managerNoService, deliveryLeaseAbsent } from "./status-health.js";

export { statusView } from "./status-render.js";

export { statusFlags } from "./status-model.js";
export type { StatusResult } from "./status-model.js";

function resolveSelected(cwd: string, values: FlagValues<typeof statusFlags>, offline: readonly string[]): Selected {
  try {
    const target = resolveMeshTarget(cwd, { server: values.server, space: values.space, offline });
    return target.source === "local-space" ? { ok: false, error: new UnregisteredRoot(target.root) } : { ok: true, target };
  } catch (e) {
    return { ok: false, error: e };
  }
}

/** The spaces this folder has registered whose broker does not answer. A folder's space is the
 *  target of a command run there only while it runs, so the brokers THIS FOLDER records are the ones
 *  dialed before the target resolves; no other recorded broker is dialed unless `--all` asks for it.
 *  A catalog-owned registration is registry preparation rather than broker discovery and is never
 *  probed, here or by the liveness sweep. A registry this cannot read is reported by `readMeshes`. */
async function folderSpacesOffline(cwd: string, values: FlagValues<typeof statusFlags>): Promise<string[]> {
  if (values.space !== undefined || values.server !== undefined) return [];
  let entries: readonly MeshEntry[];
  try {
    if (!resolveReadsLiveness(cwd)) return [];
    entries = meshesForRoot(findCotalRoot(cwd)).filter((m) => m.origin !== "catalog");
  } catch { return []; }
  const probed = await Promise.all(entries.map(async (m) => ((await isReachable(m.server, m.tlsRequired ? { tls: true } : {})) ? undefined : m.space)));
  return probed.filter((space): space is string => space !== undefined);
}

/** Named-agent and infrastructure inputs choose different reads. */
export function validateStatusArguments(args: ParsedArgs): void {
  const values = args.values as FlagValues<typeof statusFlags>;
  if (!args.positionals.length && values.components && (values.json || values.plain || values.all))
    throw new CommandFailure("refused", "USAGE_INVALID", "--components checks the selected mesh and writes its own records - it takes no --json, --plain or --all", {
      remedy: `run ${values.server !== undefined && brokerAddressForDisplay(values.server) !== values.server ? "the same command" : codeSpan(onRerun(`${displayCmd()} status --components`, values, [...(values.wide ? ["--wide"] : []), ...(values.verbose ? ["--verbose"] : [])]))} without --json, --plain or --all`,
    });
  const presentation = presentationOf(values);
  if (args.positionals.length > 1 || args.positionals.length && !args.positionals[0]?.trim())
    throw new CommandFailure("refused", "USAGE_INVALID", "status takes at most one agent name");
  if (args.positionals.length && (args.values.all || args.values.components || args.values.wide || args.values.verbose))
    throw new CommandFailure("refused", "USAGE_INVALID", "a named agent status takes no --all, --components, --wide or --verbose");
  if (typeof values.on === "string") onInstance(values.on, onRerun("cotal status", values, [...args.positionals, ...(presentation === "rich" ? [] : [`--${presentation}`])]), managerRosterHint(values));
  if (!args.positionals.length && args.values.on !== undefined)
    throw new CommandFailure("refused", "USAGE_INVALID", "--on selects a named agent read, not infrastructure status");
  if (!args.positionals.length && args.values.creds !== undefined) {
    const space = typeof args.values.space === "string" && args.values.space.trim() ? args.values.space : undefined;
    if (space !== undefined) recordOperationSpace(space);
    throw new CommandFailure("refused", "UNSUPPORTED", "status does not accept --creds: infrastructure status reads local and registered meshes, and named agent status mints its own control caller", {
      ...(space !== undefined ? { target: { space } } : {}),
      remedy: "remove --creds and its value, then rerun the same command with the remaining arguments unchanged",
    });
  }
}

/** `cotal status` — detailed, read-only diagnostics for the local machine + selected mesh. */
export async function status(args: ParsedArgs): Promise<void> {
  validateStatusArguments(args);
  if (args.positionals.length) return agentStatus(args);
  const values = args.values as FlagValues<typeof statusFlags>;
  const presentation = presentationOf(values);
  const cwd = process.cwd();
  const root = findCotalRoot(cwd);
  const checks = await registryFallbackChecks(root, values);
  const offline = checks === undefined ? await folderSpacesOffline(cwd, values)
    : [...checks.values()].flatMap(({ entry, check }) => check === "reachable" ? [] : [entry.space]);
  const selected = resolveSelected(cwd, values, offline);
  const gaps = new Gaps();
  const hints: string[] = [];
  // A folder this account cannot read hides everything in it, so that is the one gap reported for it.
  const blocked = folderReadProblem(root);
  if (blocked) {
    gaps.add("FOLDER_UNREADABLE", `this folder ${root} cannot be read by this account (${blocked}), so nothing in it was read`, { root });
    hints.push(`make it readable by you, for example with chmod u+rx ${shellWord(root)}`);
  }
  // Every command warns about a preferences folder another account could write; status also lists its fix.
  const preferencesFolder = preferencesFolderWarning();
  if (preferencesFolder) hints.push(`protect the preferences folder: ${preferencesFolder.remedy}`);
  const machine = await readMachine(selected, gaps, hints);
  const installationChanging = gaps.warnings.some((warning) => warning.code === "INSTALLATION_CHANGING");
  const extensions = readExtensions(gaps);
  let seed: ReturnType<typeof readCursor>;
  try {
    const cursor = readCursor();
    if (cursor?.failed !== undefined) seed = cursor;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (!(error instanceof UnreadableConnectorSelection)) {
      const path = reconcileCursorPath();
      gaps.add("EXTENSIONS_UNREADABLE", `the connector seed cursor at ${path} could not be read${code ? ` (${code})` : ""}`, { path });
    }
  }
  const skewedExtensions = extensions.items?.filter((item) => item.package.startsWith("@cotal-ai/") && item.version !== machine.version) ?? [];
  const extensionWarnings: OutputWarning[] = skewedExtensions.length ? [{
    code: "EXTENSION_VERSION_SKEW",
    target: { version: machine.version, packages: skewedExtensions.map((item) => item.package) },
    message: `extension version skew: ${skewedExtensions.map((item) => `${item.package} is ${item.version}`).join(", ")}; this cotal is ${machine.version}. ${installationChanging
      ? "These versions may change. Check again when that command finishes."
      : `Run \`${displayCmd()} update --self\` to reconcile this installation.`}`,
  }] : [];
  if (extensionWarnings.length && !installationChanging) hints.push(`reconcile extension versions with \`${displayCmd()} update --self\``);
  // THE RESPONDER AXIS (#1576), read ONCE and threaded into the rows that would otherwise claim
  // health they never checked. It is read before the folder section because that section renders
  // the delivery process row, and a live pid means nothing without it.
  const preflightReport = await readStatusPreflight(selected, gaps, hints);
  const { preflight } = preflightReport;
  const responder = await readResponderAxis(selected, preflight, gaps);
  const { folder, stackStarting, recoveryBroker, recoveryMembers } = blocked ? { folder: unreadFolder(root, blocked), stackStarting: false, recoveryBroker: undefined, recoveryMembers: undefined } : await readFolder(root, selected, values, responder.state, gaps, hints);
  if (selected.ok) {
    try {
      const renewal = readRenewalRecord(selected.target.root, selected.target.space);
      if (renewal?.adoption?.ok === false) {
        gaps.add("RENEWAL_ADOPTION_REFUSED", "the recorded renewal adoption was refused; a bound delivery responder does not clear that finding", { root: selected.target.root, space: selected.target.space });
        hints.push("start or repair this space's manager, the renewal owner, so it re-signs the daemon credentials and the broker accepts them; do not respawn agents for this finding");
      }
    } catch (error) {
      gaps.add("RENEWAL_RECORD_UNREADABLE", (error as Error).message, { root: selected.target.root, space: selected.target.space });
      if (isCommandFailure(error) && error.remedy) hints.push(error.remedy);
    }
  }
  const { meshes, currentJournalUnreadable } = await readMeshes(cwd, selected, Boolean(values.all), gaps, offline, preflight, checks);
  const { maintenance, sourceMissing } = blocked
    ? { maintenance: { root, space: null, state: "unreadable", attemptId: null, next: null }, sourceMissing: false }
    : readMaintenance(root, gaps);
  const recovery = backupRecovery(maintenance, sourceMissing);
  const selectedHints: string[] = [], selectedStarting = selectedStackStarting(selected, folder, stackStarting);
  const target = recoveryMembers !== undefined ? selectedRecovery(selectedHints, recoveryMembers) : await readSelected(selected, responder, folder, gaps, selectedHints, preflightReport, Boolean(values.all), selectedStarting);
  const stoppedForeignListener = preflight?.ok === false && preflight.kind === "non-nats-listener" && preflight.pid !== undefined;
  // Address, journal, channel seed, and store problems can block the conditional store reset.
  if (!stoppedForeignListener && (target.resolved || target.code !== "SCHEMA_INVALID") && folder.storedState && folder.processSpace !== null && maintenance === null && !(target.channelSeedBlocksRestart && target.root === root) && !rootStoreProblem(root)) {
    const reset = storeResetTarget(root, folder.processSpace);
    // An explicit address is not evidence about a different broker's store.
    if (values.server === undefined || (reset && selected.ok && selected.target.space === reset.space
      && brokerUrlKey(selected.target.server) === brokerUrlKey(reset.server))) {
      const cmd = displayCmd();
      hints.push(reset !== undefined
        ? `if the stored JetStream state is stale: ${codeSpan(`${cmd} reset store ${shellWord(reset.space)}`)}, then \`up\` with your usual flags`
        : `if the stored JetStream state is stale: \`${cmd} clean store --force\`, then \`up\` with your usual flags (\`clean all\` also resets identity)`);
    }
  }
  // A held backup or missing preserved store blocks startup. Keep the selection's diagnostics,
  // but replace its ordinary restart advice with the journal's recovery step.
  if (recovery) hints.unshift(recovery);
  const recoveringOtherSpace = sourceMissing && maintenance !== null && (target.space !== maintenance.space || target.root !== undefined && !sameDir(target.root, maintenance.root));
  if (!recovery || recoveringOtherSpace) hints.push(...selectedHints);
  if (sourceMissing && maintenance?.space) withdrawOperationNote("FOLDER_SPACE_NOT_RUNNING", maintenance.space);
  if (!blocked) readStackStoreWarnings(root, gaps, hints);
  if (selected.ok && selected.target.origin === "up" && !sameDir(root, selected.target.root))
    readStackStoreWarnings(selected.target.root, gaps, hints, selected.target.space);
  // Replace the folder banner with the repair when startup is blocked under another selection.
  // `This folder's space` names any unsettled stack work, with the recovery step in Next.
  const heldRestartBlocked = !blocked && reportHeldRestartProblem(root, hints);
  const held = folderStack(folder, target);
  if (held && folder.stackBlock) withdrawOperationNote("FOLDER_SPACE_NOT_RUNNING", held.space);
  if (!recovery && !heldRestartBlocked && held && !stackStarting && !folder.stackBlock && !folder.stackUnfinished && unsettledStackOperation(held.root, held.space)) hints.push(`start it with \`cotal up\` in ${held.root}`);
  const services = readOwnedServices(selected, gaps);
  const bootAttempts: StatusResult["bootAttempts"] = blocked ? { root, state: "partial", observedAt: new Date().toISOString(), unsettled: [], additive: [], unreadable: [], elsewhere: [] } : readBootAttempts(root, gaps);
  const logged = selected.ok ? brokerStoreWrite(selected.target.root, selected.target.space) : undefined;
  // A store write failure holds until the broker restarts, so it is named before a full store.
  const full = selected.ok && target.resolved && target.storedBytes !== null && logged?.state !== "write-failed" ? storeFull(selected.target.root, selected.target.space, target.storedBytes) : undefined;
  const store = full ?? logged;
  const stackManager = selected.ok ? await readStackManager(selected.target, services) : undefined;
  const outsideStackManager = selected.ok && target.resolved && servedStack(folder, target) && folder.noManager && !folder.managerService && !stackManager
    && (target.connection === "ok" || target.connection === "reachable")
    ? await managerEndpoint(selected.target)
    : undefined;
  // Two readers can name the same unreadable record, so each hint is listed once.
  const result: StatusResult = { kind: "infrastructure", machine, extensions, folder, meshes, selected: target, services, bootAttempts, maintenance, ...(store ? { store } : {}), ...(stackManager ? { stackManager } : {}), ...(outsideStackManager ? { outsideStackManager } : {}), hints: seed?.failed !== undefined
    ? [`Fix the recorded cause first:\n${seed.failed}`, `Then run \`${displayCmd()} ext seed --repair\` before starting a space`, ...(recovery ? [recovery] : [])]
    : [...new Set(hints)] };
  const parts = gaps.warnings.length;
  // A preference variable `config set` would refuse is named, but it was read, so the run stays complete.
  // An unreadable preferences file is already a gap, so the variables are checked without it.
  let preferences: Preferences;
  try { preferences = cachedPreferences(); } catch { preferences = { schemaVersion: 1, revision: 0, defaults: {}, spaces: {} }; }
  const context = { preferences, space: selected.ok ? selected.target.space : undefined };
  const invalidValues = invalidEnvironmentValues(PREFERENCE_KEYS.map((key) => resolvePreference(key, context)));
  // An address a saved service's readiness checks that still answers with none of its instances
  // running is named, but it is not a part status failed to read, so the run stays complete.
  const survivors = selected.ok && services.state === "read" ? await readinessAddressSurvivors(selected.target.space) : [];
  migrateProjectTrust();
  writeResult(
    presentation,
    {
      command: "status",
      // A prepared or stopped space is still the one this report is for, so it heads the report too.
      target: { space: result.selected.space ?? null, scope: values.all ? "all" : "selected" },
      result,
      completeness: parts ? "partial" : "complete",
      warnings: [...gaps.warnings, ...extensionWarnings, ...invalidValues, ...survivors],
      ...(parts ? { partial: { message: `status could not read ${parts === 1 ? "one part" : `${parts} parts`} of what it reports; the warnings name ${parts === 1 ? "it" : "each"}` } } : {}),
    },
    (result) => statusView(result, Boolean(values.verbose), Boolean(values.all) || Boolean(values.wide), {
      interactive: presentation === "rich" && canPrompt(),
      preparedHarness: !selected.ok && isWorkspaceTargetError(selected.error) && selected.error.code === "not-started" && preparedNeverStarted(selected.error.details)
        ? preferences.spaces[selected.error.details.space]?.harness : undefined,
      seed, currentJournalUnreadable,
      recovery, stoppedForeignListener, stackStarting, selectedStarting,
    }),
  );
  if (values.components) await printComponentHealth(selected, store, target, meshes, recovery && !recoveringOtherSpace ? recovery : selectedHints[0], !target.resolved && selectedStarting ? target.message : undefined, recoveryBroker, recoveryMembers);
}

/** Why this account cannot list or search `root`, or undefined when it can. */
function folderReadProblem(root: string): string | undefined {
  try { accessSync(root, constants.R_OK | constants.X_OK); return undefined; }
  catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return code === "EACCES" || code === "EPERM" ? code : undefined;
  }
}

/** The folder section for a folder this account cannot read: every part of it is unread. */
function unreadFolder(root: string, code: string): StatusResult["folder"] {
  const error = `${root} cannot be read by this account (${code})`;
  return { root, auth: { state: "unreadable", spaces: [], userAuth: false, error }, personas: { root: personaDir(root), default: "unreadable", demo: null, error }, launches: null, processes: null, processSpace: null, storedState: false, controllerStack: false, stackJournal: "unreadable", noManager: false, stackBlock: null };
}

/** The folder's maintenance journal, read only. An unreadable one is reported, never taken for none. */
function readMaintenance(root: string, gaps: Gaps): { maintenance: NonNullable<StatusResult["maintenance"]> | null; sourceMissing: boolean } {
  try {
    const journal = readMaintenanceJournal(root);
    if (!journal) return { maintenance: null, sourceMissing: false };
    const rolledBack = "restore" in journal ? restoreRolledBackRuns(journal) : undefined;
    const { attemptId, next, sourceMissing = false } = maintenanceNextStep(root, journal);
    return { maintenance: { root, space: journal.space, state: journal.state, attemptId, next, ...(rolledBack?.runs.length ? { rolledBackRuns: rolledBack.runs, ...(rolledBack.more ? { rolledBackRunsMore: rolledBack.more } : {}) } : {}) }, sourceMissing };
  } catch {
    gaps.add("MAINTENANCE_JOURNAL_UNREADABLE", "this folder's maintenance journal could not be read; no absent or settled state was inferred", { root });
    return { maintenance: { root, space: null, state: "unreadable", attemptId: null, next: null }, sourceMissing: false };
  }
}

/** Local boot and additive intents are recovery coordinates, not evidence of native state. */
function readBootAttempts(root: string, gaps: Gaps): NonNullable<StatusResult["bootAttempts"]> {
  // A refusal with its own cause, such as a root other local accounts can write, is named.
  const because = (error: unknown) => isCommandFailure(error) ? ` (${error.message})` : "";
  const result: NonNullable<StatusResult["bootAttempts"]> = { root, state: "not-checked", observedAt: new Date().toISOString(), unsettled: [], additive: [], unreadable: [], elsewhere: [] };
  // A `.cotal` link that leads nowhere leaves this folder no records of its own, and the walk to a
  // root passes over it.
  const here = cotalLinkHere();
  if (here?.dangling) gaps.add("COTAL_DIR_DANGLING", `this folder's .cotal links to ${here.target}, which does not exist, so this folder has no records of its own; remove the link and prepare this folder with ${codeSpan(`cotal space create <space> --root ${shellWord(here.root)}`)}`, { root: here.root, path: here.path, link: here.target });
  // Neither inventory is read through a link; the folder it leads to reports its own.
  const link = cotalDirLink(root);
  if (link !== undefined) {
    result.state = "partial";
    gaps.add("COTAL_DIR_LINKED", `this folder's .cotal is a link to ${link}, so its fresh boot and additive attempt inventories were not read through it; ${linkedCotalRemedy(root, link)}`, { root, link });
    return result;
  }
  try {
    if (!realDirNoSymlink(root, ".cotal")) return result;
    const attempts = listFreshTeamAttempts(root), summaries = listFreshTeamSummaries(root);
    const byId = new Map(summaries.valid.map((summary) => [summary.deploymentId, summary]));
    result.unsettled = attempts.valid.filter((attempt) => !freshTeamAttemptSettled(attempt, byId.get(attempt.deploymentId)))
      .map(({ deploymentId, space, server, createdAt }) => ({ deploymentId, space, server: brokerAddressForDisplay(server) ?? "not displayable", createdAt }));
    result.elsewhere = summaries.elsewhere.map(({ deploymentId, root: recordedRoot }) => ({ deploymentId, root: recordedRoot }));
    const unreadable = [...attempts.refused, ...summaries.refused].map(({ path }) => path);
    result.unreadable.push(...unreadable);
    if (unreadable.length) gaps.add("FRESH_BOOT_RECORD_UNREADABLE", "one or more fresh boot attempts or returned summaries are unreadable; their outcomes were not treated as absent", { root, paths: unreadable });
  } catch (error) {
    result.state = "partial";
    gaps.add("FRESH_BOOT_RECORD_UNAVAILABLE", `this folder's fresh boot attempt inventory could not be read${because(error)}; no empty inventory was inferred`, { root });
  }
  try {
    const additive = listAdditiveTeamAttempts(root);
    result.additive = additive.valid.map((attempt) => ({ deploymentId: attempt.deploymentId, space: attempt.space, server: brokerAddressForDisplay(attempt.server) ?? "not displayable", createdAt: attempt.createdAt, recordedState: additiveTeamRecordedState(attempt, additive) }));
    const unreadable = additive.refused.map(({ path }) => path);
    result.unreadable.push(...unreadable);
    if (unreadable.length) gaps.add("ADDITIVE_ATTEMPT_UNREADABLE", "one or more additive attempts are unreadable; their effects were not treated as absent", { root, paths: unreadable });
  } catch (error) {
    result.state = "partial";
    gaps.add("ADDITIVE_ATTEMPT_UNAVAILABLE", `this folder's additive attempt inventory could not be read${because(error)}; no empty inventory was inferred`, { root });
  }
  if (result.state !== "partial") result.state = result.unreadable.length ? "partial" : "read";
  result.observedAt = new Date().toISOString();
  return result;
}

/** Separate the new owned-controller records from legacy pidfiles and remote registrations.
 *  An unreadable family is null and makes the report partial, never a complete empty list. */
function readOwnedServices(selected: Selected, gaps: Gaps): OwnedServiceStatus {
  const result: OwnedServiceStatus = { space: selected.ok ? selected.target.space : null, state: "not-checked", observedAt: new Date().toISOString(), atomicSnapshot: false, definitions: null, instances: null, scope: "selected-space local owned records; no remote registration or fresh endpoint probe" };
  if (!selected.ok) return result;
  const space = selected.target.space;
  try { result.definitions = serviceDefinitionStore(space).list().map(serviceDefinitionProjection); }
  catch (error) {
    const causeCode = isCommandFailure(error) ? error.code : "TARGET_UNAVAILABLE";
    gaps.add("SERVICE_DEFINITIONS_UNAVAILABLE", `the selected space's owned service definitions could not be read (${causeCode}); no empty inventory or repair was inferred`, { space, causeCode });
  }
  // By definition, then instance, as the definitions are listed: the store orders them by their
  // random instance IDs, so the rows changed order whenever a member started under a new one.
  const byName = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;
  try { result.instances = serviceInstances(space).map(instanceProjection).sort((a, b) => byName(a.definition, b.definition) || byName(a.instanceId, b.instanceId)); }
  catch (error) {
    const causeCode = isCommandFailure(error) ? error.code : "TARGET_UNAVAILABLE";
    gaps.add("SERVICE_INSTANCES_UNAVAILABLE", `the selected space's owned service instance observations could not be established (${causeCode}); no stopped, empty or serving state was inferred`, { space, causeCode });
  }
  result.state = result.definitions === null || result.instances === null ? "partial" : "read";
  result.observedAt = new Date().toISOString();
  return result;
}

async function readMachine(selected: Selected, gaps: Gaps, hints: string[]): Promise<StatusResult["machine"]> {
  const m = await machineStatus();
  let defaults: StatusResult["machine"]["defaults"] = null;
  try {
    const context = { preferences: cachedPreferences(), space: selected.ok ? selected.target.space : undefined };
    const persona = resolvePreference("persona", context);
    defaults = { harness: resolvePreference("harness", context).value, persona: persona.value };
    if (selected.ok) {
      let path: string | undefined;
      try {
        path = directPersonaPath(selected.target.root, persona.value!);
        defaults.harness = resolvePreference("harness", { ...context, pin: defaultPersonaPin(path, persona.winner?.source === "default") }).value;
      } catch (error) {
        defaults.harness = null;
        gaps.add("DEFAULT_PERSONA_UNREADABLE", "the default launch persona could not be read and validated; its effective harness is unknown", { path: path ?? (error as NodeJS.ErrnoException).path });
      }
    }
  } catch (e) {
    // The refusal names the file and its problem, and its remedy is the next step.
    gaps.add("PREFERENCES_UNREADABLE", `the saved agent defaults could not be read: ${(e as Error).message}`, { path: preferencesPath() });
    if (isCommandFailure(e) && e.remedy) hints.push(e.remedy);
  }
  let connectors: HarnessStatus[] | null = null;
  const integrations: StatusResult["machine"]["integrations"] = [];
  try {
    connectors = connectorHarnesses();
  } catch (e) {
    gaps.add("CONNECTORS_UNREADABLE", `the installed connectors could not be listed: ${(e as Error).message}`);
  }
  // Loading a connector's provider waits for a command that is changing the installation. Status is
  // a read: it reports that command and leaves the rows unread.
  const writer = installationWriter();
  if (writer) {
    gaps.add("INSTALLATION_CHANGING", `another cotal command (pid ${writer.pid}) is changing this installation, so the application rows were not read`, { pid: writer.pid });
    hints.push("run `cotal status` again when that command finishes");
  } else if (connectors) {
    const signedIn = selected.ok && selected.target.mode === "user" ? await signedInSpace(selected.target) : undefined;
    for (const r of await connectorStatusRows(connectors, signedIn)) integrations.push({ name: r.label, state: r.state, text: r.text });
    for (const r of await clientStatusRows(signedIn)) integrations.push({ name: r.label, state: r.state, text: r.text, client: true });
  }
  let installed: boolean | null = null;
  let installedError: string | null = null;
  try {
    installed = webInstalled();
  } catch (e) {
    installedError = (e as Error).message;
    gaps.add("WEB_UNREADABLE", `the web extension's record could not be read: ${installedError}`);
  }
  let url: string | null = null;
  let urlError: string | null = null;
  try {
    url = (selected.ok ? recordedWebUrl({ root: selected.target.root, space: selected.target.space }) : undefined) ?? null;
  } catch (e) {
    // An unreadable `web.pid` or session record is named on the row, like the folder's process rows,
    // so the rest of status still prints.
    urlError = (e as Error).message;
    gaps.add("WEB_UNREADABLE", `the dashboard's records could not be read: ${urlError}`);
  }
  return {
    version: cliVersion(),
    node: process.version,
    platform: `${process.platform === "darwin" ? "macOS" : process.platform === "win32" ? "Windows" : process.platform === "linux" ? "Linux" : process.platform} ${process.arch}`,
    install: cliProvenance(),
    nats: m.nats,
    natsServer: m.natsServer,
    natsProblem: m.natsProblem,
    integrations,
    defaults,
    connectors: connectors?.map((h) => ({ name: h.name, requires: [...h.requires], missing: h.missing })) ?? null,
    skills: readSkills(gaps),
    web: { installed, installedError, url, urlError },
  };
}

/** Cotal's authored skills reach non-Claude harnesses through the cross-vendor `~/.agents/skills`
 *  directory (Codex, Cursor, OpenCode, Gemini CLI, Windsurf). Those harnesses have no remote update, so
 *  surface a stale/missing/retired drop here and point at the skills-only write (`cotal setup --skills`).
 *  A corrupt skills bundle throws (fail-loud); we report that as an integrity error rather than "none shipped". */
function readSkills(gaps: Gaps): StatusResult["machine"]["skills"] {
  let skew;
  try {
    skew = agentSkillsSkew();
  } catch (e) {
    const message = isCommandFailure(e) && e.remedy ? `${e.message}. ${e.remedy}` : (e as Error).message;
    gaps.add("SKILLS_UNREADABLE", `the skills bundle could not be read: ${message}`);
    return { state: "unreadable", total: 0, behind: 0, retired: 0, error: message };
  }
  const behind = skew.filter((s) => s.state !== "current");
  const retired = behind.filter((s) => s.state === "retired").length;
  const state = !behind.length ? "current" : behind.every((s) => s.state === "missing") ? "not-installed" : "behind";
  return { state, total: skew.length, behind: behind.length, retired, error: null };
}

/** The installed extensions (seeded built-in connectors + operator `ext add`s) with their pinned
 *  versions. The root plus an explicit empty state answers "where do these live / is anything
 *  installed", which is ambiguous on a fresh binary before its first seed. Versions are the manifest
 *  pin (add-time), not a live on-disk/host-compat check. */
function readExtensions(gaps: Gaps): StatusResult["extensions"] {
  let root: string;
  try { root = extensionsDir(); }
  catch (error) {
    if (!(error instanceof UnreadableConnectorSelection)) throw error;
    // The existing result requires a path. Use the containing config directory, not an invented
    // extension prefix, and leave the inventory explicitly unknown.
    gaps.add("EXTENSIONS_UNREADABLE", error.message);
    return { root: globalConfigDir(), items: null };
  }
  const { versions, unreadable, remedy } = readExtensionVersions();
  if (unreadable !== undefined) gaps.add("EXTENSIONS_UNREADABLE", `the extensions manifest could not be read: ${unreadable}${remedy ? `. ${remedy}` : ""}`);
  return { root, items: unreadable === undefined ? versions.map((e) => ({ package: e.pkg, label: e.label, version: e.version })) : null };
}

/** Read the delivery responder axis for the bare-status rows (#1576).
 *
 *  ONE SHORT-LIVED READ-ONLY CONNECTION, and it must never turn status into a command that fails.
 *  Everything that can go wrong here — no resolvable target, an unreachable broker, a user-auth mesh
 *  where status is forbidden to mint, a cred minted before the read grant existed — yields `unknown`,
 *  which the renderer states as "unchecked" rather than implying either health. The one thing it may
 *  not do is return `bound` on a failed read; that is the false green this whole change removes.
 *
 *  USER MODE IS DELIBERATELY `unknown` RATHER THAN CONNECTED. The flip forbids status from
 *  static-minting on a user-auth mesh, and borrowing the operator's bearer for a health probe is a
 *  bigger decision than this fix should make silently. Those operators get the axis from
 *  `--components`, and the row says so instead of guessing.
 *
 *  `leased` says whether the read found a delivery lease record. An open mesh runs no delivery
 *  daemon, so there a missing lease is the normal state rather than an unbound responder. */
async function readResponderAxis(selected: Selected, preflight: SelectedPreflight, gaps: Gaps): Promise<{ state: DeliveryResponderState; leased: boolean }> {
  let leased = false;
  if (!selected.ok) return { state: "unknown", leased };
  const target = selected.target;
  if (target.mode === "user") return { state: "unknown", leased };
  let holder: string | undefined;
  try { holder = await expectedDeliveryHolder(target); }
  catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    gaps.add("DELIVERY_CREDENTIAL_UNREADABLE", isCommandFailure(error) && error.remedy ? `${message}; ${error.remedy}` : message, { root: target.root, space: target.space });
    return { state: "unknown", leased };
  }
  try {
    if (!preflight?.ok) return { state: "unknown", leased };
    const id = newIdentity();
    const creds = target.auth ? await mintCreds(target.auth, id, "observer") : undefined;
    const ep = new CotalEndpoint({
      space: target.space,
      servers: target.server,
      tls: target.tlsRequired,
      creds,
      channels: [],
      consume: false,
      registerPresence: false,
      watchPresence: false,
      watchChannels: false,
      card: { id: id.id, name: "status-responder", kind: "endpoint" },
    });
    ep.on("error", () => {});
    // NAMED, not anonymous, because the warning census requires every registration in this tree to
    // declare its disposition and be findable by name (`bin/smoke/endpoint-warning-consumers`). An
    // anonymous handler is an unnamed consumer, which is the thing that census exists to refuse.
    // This probe is a one-shot lease read whose own result is the verdict: a recoverable side-channel
    // warning would add noise to a row that already says `unchecked` when the read does not land.
    const ignoreResponderWarning = () => {};
    ep.on("warning", ignoreResponderWarning);
    await ep.start();
    try {
      // The holder is resolved BEFORE the read so a dead daemon's surviving `ready:true` cannot be
      // mistaken for the live one's (#837): `ready` alone says some daemon bound recently enough that
      // its record has not expired, which is not the question this row asks.
      //
      // This surface reduces a FAILED read to `unchecked`, which is exactly what
      // `deliveryResponderState` encapsulates, so it is called here rather than hand-rolled. The
      // `--components` surface deliberately does NOT use it: that surface must tell a missing lease
      // stream apart from a refused read, and flattening both to `unknown` would erase a
      // distinction it reports.
      const state = await deliveryResponderState(
        async () => { const lease = await ep.readDeliveryLease(0); leased = lease !== undefined; return lease; },
        holder,
      );
      // A daemon killed before it could release shard 0 leaves its ready row, which names this
      // folder's credential, until the bucket TTL removes it. When this folder's delivery pidfile
      // names a process that is gone, that row is the dead daemon's, the same rule `up` waits on.
      const deadLocal = processRecord(DELIVERY_PIDFILE, { root: target.root, space: target.space }).kind === "dead";
      const journal = readStackJournal(target.root)?.journal;
      const member = journal?.space === target.space ? journal.members.find((row) => row.role === "delivery") : undefined;
      const instance = member?.instanceId && serviceInstances(target.space, STACK_DEFINITION.delivery).find((row) => row.name === member.instanceId);
      const deadInstance = instance && ["gone", "foreign-pid", "previous-boot"].includes(instanceProjection(instance).observedProcess);
      return { state: state === "bound" && holder !== undefined && (deadLocal || deadInstance) ? "stale" : state, leased };
    } finally {
      await ep.stop().catch(() => {});
    }
  } catch {
    return { state: "unknown", leased };
  }
}

async function readFolder(root: string, selected: Selected, values: FlagValues<typeof statusFlags>, responder: DeliveryResponderState, gaps: Gaps, hints: string[]): Promise<{ folder: StatusResult["folder"]; stackStarting: boolean; recoveryBroker?: number; recoveryMembers?: { role: string; pid: number }[] }> {
  let stackJournal: NonNullable<StatusResult["folder"]["stackJournal"]>;
  try { stackJournal = lstatSync(stackJournalPath(root), { throwIfNoEntry: false }) === undefined ? "absent" : "present"; }
  catch { stackJournal = "unreadable"; }
  const folder = (auth: StatusResult["folder"]["auth"], processes: ProcessRow[] | null = null, storedState = false, processSpace: string | null = null, controllerStack = false, noManager = false, stackBlock: StackOperationBlock | null = null,
  stackUnfinished: StatusResult["folder"]["stackUnfinished"] = null): StatusResult["folder"] => ({
    root,
    auth,
    ...folderPersonas(root, selected, values, gaps, hints),
    processes,
    processSpace,
    storedState,
    controllerStack,
    stackJournal,
    noManager,
    stackBlock,
    stackUnfinished,
  });
  const unreadable = (error: string, hint: string) => {
    gaps.add("AUTH_UNREADABLE", `this folder's trust material could not be read: ${error}`, { root });
    hints.push(hint);
    return { folder: folder({ state: "unreadable", spaces: [], userAuth: false, error }), stackStarting: false };
  };
  // The inventory READ itself can throw (an EACCES/ELOOP on `.cotal/auth`, not just a bad record):
  // `accountInventory` lets that propagate so the broker-wide guards fail CLOSED, but status is the
  // recovery command and must report any trust material it cannot read. Frame the unreadable auth
  // dir and stop.
  let spaces: string[];
  let corrupt: string[];
  try {
    ({ spaces, corrupt } = accountInventory(authDir(root)));
  } catch (e) {
    return unreadable(`auth dir unreadable · ${(e as Error).message}`, `check permissions on ${authDir(root)} - broker-wide commands refuse while the tenant list cannot be read`);
  }
  // Status is the command the broker-wide refusals send the operator to, so it must DESCRIBE every
  // state those refusals can name - crashing on one is a dead end in the exact recovery flow. An
  // unreadable record means the tenant list is uncertain: report it (the space-blind sole-load
  // below would throw on it).
  if (corrupt.length > 0)
    return unreadable(
      `${corrupt.length} unreadable account record(s) · ${corrupt.join(", ")}`,
      `repair or remove ${corrupt.map((f) => join(authDir(root), f)).join(", ")} - broker-wide commands refuse while the tenant list is uncertain`,
    );
  // A root holding several accounts has no single "this folder's space", and the process rows below
  // are keyed by one. Report the tenant list instead of letting the space-blind read throw.
  if (spaces.length > 1) return { folder: folder({ state: "spaces", spaces, userAuth: false, error: null }), stackStarting: false };
  // The inventory shape-check is necessary but not sufficient: a record can carry non-empty
  // account fields yet fail COMPOSITION (a malformed account JWT, or one signed by a foreign
  // operator - `composeSpaceAuth` throws on both). Status is the recovery command the broker-wide
  // refusals point at, so it must report any record it cannot load with guidance, not crash on
  // the ones the cheap shape gate lets through. Frame the load failure the same as an unreadable
  // record and stop.
  let auth: ReturnType<typeof loadSoleSpaceAuth>;
  try {
    auth = loadSoleSpaceAuth(authDir(root));
  } catch (e) {
    return unreadable(`unreadable trust material · ${(e as Error).message.split(" - ")[0]}`, (e as Error).message);
  }
  const userDisk = Boolean(auth && hasUserAuthState(root, auth.space));
  let journal: StackJournal | undefined, elsewhere = false, unusable = false;
  try { journal = readStackJournal(root)?.journal; }
  catch (error) {
    // A journal no command can use is named with its way out, in the warnings and under Next;
    // the rest of the report still stands.
    if (isCommandFailure(error) && (error.code === "SCHEMA_INVALID" || error.code === "PERMISSION_DENIED")) {
      unusable = true;
      stackJournal = "unreadable";
      gaps.add(error.code === "PERMISSION_DENIED" ? "STACK_JOURNAL_UNREADABLE" : "STACK_JOURNAL_INVALID", error.remedy ? `${error.message}; ${error.remedy}` : error.message, { root });
      if (error.remedy) hints.push(error.remedy);
    }
    // A journal another folder recorded, as a copy or a moved folder keeps it: clean store refuses here.
    elsewhere = isCommandFailure(error) && error.code === "CONFLICT";
  }
  const activeStartup = journal !== undefined && stackUpInProgress(journal);
  const recovered = journal ? lostRecordsRecovery(journal, selected.ok ? undefined : selected.error, root) : undefined;
  const verifiedMembers = recovered && recovered.length > 0 ? recovered : undefined;
  const recoveryBroker = verifiedMembers?.find((row) => row.role === "broker")?.pid;
  // A root whose records show two spaces running has no single answer, the
  // same shape as the multi-account case above. The process rows below are keyed by one space, so
  // report that state and stop rather than crashing in the recovery command that names it.
  let space: string;
  try {
    space = auth?.space ?? statusRuntimeSpace(root, selected.ok ? selected.target : undefined, journal?.mode === "open" && (activeStartup || recoveryBroker !== undefined) ? journal.space : undefined);
  } catch (e) {
    hints.push((e as Error).message);
    return { folder: folder({ state: "none", spaces: [], userAuth: false, error: null }), stackStarting: false };
  }
  const context: LocalProcessContext = { root, space, userAuth: userDisk };
  const processes: ProcessRow[] = [];
  let nats: PidfileState | undefined;
  for (const component of localProcessSurface().filter((component) => localProcessVisible(component, context)).sort((a, b) => (a.order ?? 50) - (b.order ?? 50))) {
    let state: PidfileState;
    try {
      state = pidfileState(localProcessPath(component.pidFile, context));
    } catch (e) {
      // `localProcessPath` throws on an ambiguous record and `pidfileState` on one it cannot read, so
      // `clean` and `down` refuse to act on either. Status is the recovery command: name the failed
      // read on this row and report the rest.
      gaps.add("PIDFILE_UNREADABLE", `the ${component.name} pidfile could not be read: ${(e as Error).message}`, { root, space, process: component.name });
      processes.push({ name: component.name, state: "unreadable", pid: null, detail: `pidfile unreadable · ${(e as Error).message}` });
      continue;
    }
    if (state.liveness === "unknown") {
      const path = localProcessPath(component.pidFile, context);
      gaps.add("PIDFILE_UNATTRIBUTABLE", `the ${component.name} pidfile ${path} cannot establish process state: ${state.note ?? "pid liveness unknown"}`, { root, space, process: component.name });
      hints.push(`inspect ${path} and its process before restoring or removing that pidfile; no stopped state was inferred`);
    }
    if (component.name === "nats") nats = state;
    // #2073: a live manager pid used to print green `running` on the pidfile alone, which is how
    // a manager whose service rail had died read as healthy for hours. One probe of the service
    // endpoint now decides the row; see `managerProcess`.
    if (component.name === "manager") {
      const pinned = verifiedMembers?.find((row) => row.role === "manager");
      processes.push(pinned ? { name: "manager", state: "running", pid: pinned.pid, detail: "verified from the stack journal; service instance record missing" } : await managerProcess(selected.ok ? selected.target : undefined, state, context.space, gaps));
    }
    // THE #1576 ROW. A live delivery PID is not the fact an operator needs; the responder is.
    // A live pid alone read as `delivery running (pid N)` identically over a bound responder and one
    // that never bound. The detail names which it is, and when unbound it names the CONSEQUENCE
    // rather than a reconcile that has not happened yet.
    else processes.push(processRow(component.name, state, component.name === "delivery" ? deliveryDetail(state.liveness === "alive", responder) : null));
  }
  // A legacy store can persist after its broker stops. A controller broker has no legacy pidfile.
  // Only its instance record or verified recovery pin can establish that broker's state.
  const controllerStack = journal?.space === space;
  const brokerIndex = processes.findIndex((row) => row.name === "nats");
  if (brokerIndex !== -1) processes[brokerIndex] = unusable
    ? { name: "nats", state: "unreadable", pid: null, detail: "stack journal unreadable; no broker stopped state was inferred" }
    : brokerProcess(processes[brokerIndex]!, controllerStack ? journal : undefined, gaps, recoveryBroker);
  const managerIndex = !unusable && !controllerStack && (nats?.liveness === "alive" || nats?.liveness === "dead")
    ? processes.findIndex((row) => row.name === "manager" && row.state === "stopped" && row.pid === null)
    : -1;
  if (managerIndex !== -1 && legacyManagerStopped(root, space, localManagerInstanceId(root, space)))
    processes[managerIndex] = { ...processes[managerIndex]!, detail: "stopped" };
  const noManager = journal !== undefined && controllerStack && stackRecordedWithoutManager(journal);
  const stackStarting = controllerStack && activeStartup;
  // Name settlement blocks only when no active startup writer holds the stack.
  let stackBlock: StackOperationBlock | null = null;
  if (journal && controllerStack && !stackStarting) try { stackBlock = stackOperationBlock(journal) ?? null; } catch { stackBlock = null; }
  // One that left the stack part way is named with the command that finishes it.
  let stackUnfinished: StatusResult["folder"]["stackUnfinished"] = null;
  if (journal && controllerStack && !stackStarting && !stackBlock) try { stackUnfinished = unfinishedStackOperation(journal) ?? null; } catch { stackUnfinished = null; }
  // A copy or a moved folder keeps the stack journal another folder recorded, and its store is that
  // stack's. Clean store refuses there with the step the journal's refusal names.
  let copiedStack = false;
  if (!controllerStack) try { copiedStack = journalRecordedElsewhere(root)?.journal.space === space; } catch { copiedStack = false; }
  // A legacy root keeps no journal, so its space registered for another folder says the same.
  let legacyElsewhere = false;
  if (!controllerStack && !elsewhere && !copiedStack) try { legacyElsewhere = recordsElsewhereError(root) !== undefined; } catch { legacyElsewhere = false; }
  const storedState = !unusable && !controllerStack && !elsewhere && !copiedStack && !legacyElsewhere && nats?.liveness !== "alive" && existsSync(join(root, ".cotal", "nats"));
  // A stack started with --no-manager can still have a manager: a `manager` preset service run here.
  let managerService: StatusResult["folder"]["managerService"] = null;
  if (noManager && journal) try {
    const held = serviceHeldRecords(root, journal.space).find((row) => row.record.name === "manager");
    managerService = held ? { definition: held.definition, instanceId: held.instanceId } : null;
  } catch { managerService = null; }
  let heldServices: StatusResult["folder"]["heldServices"] = [];
  if (controllerStack && journal) try {
    heldServices = serviceHeldRecords(root, journal.space).map((row) => ({ definition: row.definition, instanceId: row.instanceId, record: row.record.name, pid: row.record.pid! }));
  } catch { heldServices = null; }
  return { folder: { ...folder({ state: auth ? "space" : "none", spaces: auth ? [auth.space] : [], userAuth: userDisk, error: null }, processes, storedState, space, controllerStack, noManager, stackBlock, stackUnfinished), managerService, heldServices }, stackStarting, ...(controllerStack && recoveryBroker !== undefined ? { recoveryBroker } : {}), ...(controllerStack && verifiedMembers !== undefined ? { recoveryMembers: verifiedMembers } : {}) };
}

/** The folder's persona catalog, which must never let a catalog imply a `spawn` the operator does
 *  not have.
 *
 *  The row used to read `personas  default` in green under "This Folder" while `cotal spawn` in the
 *  same second refused with "no default persona yet". Both were right about their OWN root and
 *  neither NAMED it: the folder's catalog is `<cwd-root>/.cotal/agents`, and spawn loads the
 *  RESOLVED mesh's `target.personaRoot`, which is a different directory whenever `cotal use`, a
 *  `--space`, or the registry's sole entry points elsewhere. The listed names and the launchable
 *  names were disjoint sets.
 *
 *  So: always name the root each summary describes, and say whether the folder's catalog is the one
 *  a bare spawn launches from (`launches`): true when the two roots are one directory, false when the
 *  selected mesh's root differs, null when no mesh resolves and nothing is launchable here. */
function folderPersonas(root: string, selected: Selected, values: FlagValues<typeof statusFlags>, gaps: Gaps, hints: string[]): Pick<StatusResult["folder"], "personas" | "launches"> {
  const personas = personaCatalog(root, gaps);
  if (!selected.ok) return { personas, launches: null };
  if (sameDir(personaDir(root), selected.target.personaRoot)) return { personas, launches: true };
  let folderHasPersonas = false;
  try { folderHasPersonas = readPersonas(root).length > 0; } catch { /* personaCatalog already reports the unreadable catalog */ }
  if (folderHasPersonas) hints.push(
    `a bare \`${displayCmd()} spawn\` uses the selected mesh, NOT this folder - personas in ${personaDir(root)} will not launch until you run it from that mesh's root or select it (\`${displayCmd()} use <space>\`${values.space ? "" : ", or pass `--space`"})`,
  );
  return { personas, launches: false };
}

/** The one space whose `reset store <space>` selects this root's store: the folder's own, or one this
 *  machine registered here, which a stopped folder no longer resolves to. A legacy root whose down
 *  removed that registration has none, and the reset's refusal names clean instead. */
function storeResetTarget(root: string, space: string): ReturnType<typeof selectResetTarget> | undefined {
  let names: string[];
  try { names = [...new Set([space, ...meshesForRoot(root).map((mesh) => mesh.space)])]; } catch { return undefined; }
  const reached = names.flatMap((name) => {
    try {
      const target = selectResetTarget(name, "reset store");
      return sameDir(target.root, root) ? [target] : [];
    } catch { return []; }
  });
  return reached.length === 1 ? reached[0] : undefined;
}

/** Do two catalog paths denote the SAME directory? `canonicalRoot` (realpath, `resolve` fallback
 *  for a path not on disk) is the repo's one spelling for this: a raw `===` reads a symlinked or
 *  8.3-short-name spelling of one directory as two, which here would fabricate a divergence and
 *  send the operator chasing a split that does not exist. */
function sameDir(a: string, b: string): boolean {
  return canonicalRoot(a) === canonicalRoot(b);
}

function processRow(name: string, p: PidfileState, detail: string | null): ProcessRow {
  if (p.liveness === "alive") return { name, state: "running", pid: p.pid ?? null, detail };
  return { name, state: p.liveness === "unknown" ? "unknown" : "stopped", pid: p.pid ?? null, detail: p.note ?? null };
}

/** A controller broker has no legacy pidfile. Observe its saved process identity instead, keeping
 *  the pidfile result as a separate fact. A failed owned-record read never selects the legacy row. */
function brokerProcess(legacy: ProcessRow, journal: StackJournal | undefined, gaps: Gaps, recoveryBroker?: number): ProcessRow {
  const { state, pid, detail } = legacy;
  const row: ProcessRow = { ...legacy, source: journal ? "owned-service" : "legacy-pidfile", legacyPidfile: { state, pid, detail }, ownedService: null };
  if (!journal) return row;
  if (recoveryBroker !== undefined) return { ...row, state: "running", pid: recoveryBroker, detail: "verified from the stack journal; service instance record missing" };
  const recordedHome = journal.recovery?.home;
  if (recordedHome !== homeCotalDir() && stackRunsUnderOtherHome(journal.root, journal)) {
    const detail = recordedHome === undefined ? "stack member records are missing from this Cotal home" : `stack member records belong to ${recordedHome}`;
    if (recordedHome === undefined) gaps.add("FOLDER_BROKER_UNAVAILABLE", `owned broker observation unavailable · ${detail}`, { root: journal.root, space: journal.space });
    return { ...row, state: "unknown", pid: null, detail };
  }
  try {
    const instances = serviceInstances(journal.space, STACK_DEFINITION.broker);
    if (instances.length === 0) {
      if (journal.members.some((member) => member.role === "broker" && (member.instanceId !== null || member.replacement !== undefined)))
        throw new Error("the stack's recorded broker instance is missing");
      return { ...row, state: "stopped", pid: null, detail: "no owned broker instance" };
    }
    const definition = serviceDefinitionStore(journal.space).read(STACK_DEFINITION.broker)?.record.value;
    const launch = definition?.launch;
    if (launch?.type !== "adapter" || launch.adapter !== STACK_ADAPTER.broker || launch.options.root !== journal.root)
      throw new Error("the owned broker definition does not name this folder");
    if (instances.length !== 1) throw new Error(`expected one owned broker instance, found ${instances.length}`);
    const owned = instanceProjection(instances[0]!);
    row.ownedService = { definition: owned.definition, instanceId: owned.instanceId, observedProcess: owned.observedProcess, recordedState: owned.recordedState, pid: owned.pid };
    row.state = owned.observedProcess === "running" ? "running"
      : ["gone", "previous-boot", "foreign-pid"].includes(owned.observedProcess) ? "stopped"
      : owned.observedProcess === "unreadable" ? "unreadable" : "unknown";
    row.pid = owned.pid;
    row.detail = `owned service ${owned.definition}: ${owned.observedProcess}`;
    if (row.state === "unreadable") gaps.add("FOLDER_BROKER_UNAVAILABLE", row.detail, { root: journal.root, space: journal.space });
  } catch (error) {
    row.state = "unreadable";
    row.pid = null;
    row.detail = `owned broker observation unavailable · ${(error as Error).message}`;
    gaps.add("FOLDER_BROKER_UNAVAILABLE", row.detail, { root: journal.root, space: journal.space });
  }
  return row;
}

/** Bare status's manager row, #2073: a live pid alone is not proof the manager serves — that was
 *  exactly the incident (a lease holder whose service rail had died stayed `running` for hours).
 *  So a live manager pid gets ONE probe of its own service endpoint before the row is reported. This
 *  adds one request to every bare `status` call for a live manager pid.
 *
 *  Three outcomes:
 *  - answered: `running` with the delivery-aware detail.
 *  - a DEFINITIVE no-answer: `managerNoService`, the predicate `managerHealth`'s not-serving branch also uses
 *    (`unansweredRequest`, or an `EpEnvelopeError` whose `cause` satisfies `isStreamNotFound`): `not-serving` with
 *    `service endpoint not answering`, plus the marker error when the marker could not be read.
 *  - any other failure (a refused probe, an `unavailable` user-mode credential): `running` with
 *    `service unchecked`, so a failed probe never reads as a dead rail.
 *
 *  A dead/stopped pid never reaches the probe at all (the early return below), so a stopped manager
 *  still reads as stopped, not `not-serving` — a dead pid is not a live pid that will not answer. */
async function managerProcess(target: MeshTarget | undefined, state: PidfileState, space: string, gaps: Gaps): Promise<ProcessRow> {
  if (state.liveness !== "alive") return processRow("manager", state, null);
  const details: string[] = [];
  let deliveryAware = false;
  try {
    deliveryAware = managerHasDeliveryMarker(state.pid!, space);
    details.push(deliveryAware ? "delivery-aware" : "old/unknown build");
  } catch (e) {
    // The marker reader throws so `up` and the delivery preflight refuse to act on a marker they
    // cannot read. Status is the recovery command: name the failed read on this row and report the rest.
    details.push(`delivery-aware marker unreadable: ${(e as Error).message}`);
    gaps.add("MARKER_UNREADABLE", `the manager's delivery-aware marker could not be read: ${(e as Error).message}`, { space, process: "manager" });
  }
  const running = (extra?: string): ProcessRow => ({ name: "manager", state: "running", pid: state.pid ?? null, detail: [...details, ...(extra ? [extra] : [])].join(" · ") });
  if (!target) return running();
  const localId = target.mode === "user" ? localManagerInstanceId(target.root, space) : undefined;
  // A live pid whose instance is not on this root must not take an unpinned answer.
  if (target.mode === "user" && localId === undefined) return running("service unchecked");
  const { endpoint } = await managerEndpoint(target, localId);
  if (endpoint === "not-answering")
    return { name: "manager", state: "not-serving", pid: state.pid ?? null, detail: ["service endpoint not answering", ...details.filter((d) => d.startsWith("delivery-aware marker unreadable"))].join(" · ") };
  return running(endpoint === "unchecked" ? "service unchecked" : undefined);
}

/** One probe of the space's manager service endpoint. Only a definitive no-answer is
 *  `not-answering`; a refused probe or an `unavailable` user-mode credential is `unchecked`, so a
 *  failed probe never reads as a dead rail. The operator's credential calls the class rail, so with
 *  `instanceId` an answer from another manager instance is `unchecked` too. Omitting
 *  `instanceId` leaves the answer unpinned, for a probe that is not attributing a local process. */
async function managerEndpoint(target: MeshTarget, instanceId?: string): Promise<ManagerObservation> {
  try {
    let status: ManagerServiceStatus;
    if (target.mode === "user") {
      const credential = await componentCredential(target);
      if (credential.kind !== "user") return { endpoint: "unchecked" };
      status = await userManagerStatus(target, instanceId);
    } else {
      status = await managerServiceHealth(target, await staticServiceAuth(target.auth));
    }
    if (instanceId !== undefined && status.instanceId !== instanceId) return { endpoint: "unchecked" };
    return { endpoint: "answered", ...(typeof status.instanceId === "string" && status.instanceId ? { instanceId: status.instanceId } : {}) };
  } catch (e) {
    return { endpoint: managerNoService(e) ? "not-answering" : "unchecked" };
  }
}

/** A controller stack's manager is an owned service, and its instance record reads `running` while
 *  the process lives, a hung one included. So a running stack manager gets the probe the legacy
 *  manager row gets. In user mode only an answer from the instance this root persisted counts. */
async function readStackManager(target: MeshTarget, services: OwnedServiceStatus): Promise<StatusResult["stackManager"]> {
  const row = services.instances?.find((item) => item.definition === STACK_DEFINITION.manager && item.observedProcess === "running");
  if (!row?.pid) return undefined;
  const pin = target.mode === "user" ? localManagerInstanceId(target.root, target.space) : row.nativeEndpoint?.instanceId;
  if (target.mode === "user" && pin === undefined) return { instanceId: row.instanceId, pid: row.pid, endpoint: "unchecked" };
  const { endpoint } = await managerEndpoint(target, pin);
  return { instanceId: row.instanceId, pid: row.pid, endpoint };
}

/** The delivery row's responder detail (#1576). An unbound responder is not a footnote about a
 *  component: while it holds, the mesh cannot spawn, retire or accept a join, and the whole reported
 *  incident is that this read as ordinary. `unknown` names `--components`, because an unchecked axis
 *  must not look like a diagnosis in either direction. */
function deliveryDetail(live: boolean, responder: DeliveryResponderState): string | null {
  return deliveryRowSuffix(live, responder, `${displayCmd()} status --components`).replace(/^ · /, "") || null;
}
