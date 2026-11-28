import { existsSync, lstatSync, readdirSync, rmSync } from "node:fs";
import { displayCmd } from "../lib/self-exec.js";
import { homedir } from "node:os";
import { basename, join, relative, resolve } from "node:path";
import { type CompletionResult, type ParsedArgs } from "@cotal-ai/core";
import {
  CommandFailure,
  codeSpan,
  ConfirmationRequired,
  isCommandFailure,
  localRecordName,
  oneLine,
  presentationOf,
  renderReport,
  assertSingleSpaceBroker,
  authDir,
  loadMeshes,
  maintenanceLockHolder,
  meshesForRoot,
  localProcessPath,
  localProcessPathCandidates,
  canonicalRoot,
  brokerAddressForDisplay,
  findMesh,
  findPreparedSpace,
  getCurrent,
  localProcessOwnerStatus,
  legacyStackElsewhere,
  legacyStackOtherHome,
  stackHomeRemedy,
  localMeshesForRoot,
  preparedSpaceAt,
  retainedLegacyBroker,
  retainedOpenSpace,
  soleSpaceOf,
  writeResult,
  type Report,
  readMaintenanceJournal,
  readMaintenanceLockHolder,
  readBrokerPolicy,
  readContainedRecord,
  keepsRegistration,
  recordMesh,
  removeMeshesByRoot,
  DELIVERY_PIDFILE,
  MANAGER_DELIVERY_AWARE_MARKER,
  MANAGER_PIDFILE,
  AUTH_PIDFILE,
  NATS_PIDFILE,
  WEB_PIDFILE,
  type LocalProcess,
  type LocalProcessContext,
} from "@cotal-ai/workspace";
import {
  isReachable,
  MANAGER_START_PAYLOAD_FLOOR,
  realDirNoSymlink,
} from "@cotal-ai/core";
import { localProcessSurface } from "../ext-loader.js";
import { c, stderrLine } from "../ui.js";
import { cotalRoot, linkedCotalRefusal } from "../lib/paths.js";
import { verifyIdentityPin } from "@cotal-ai/workspace";
import { resolveRuntimeSpace } from "../lib/status.js";
import { interruptedStartBroker } from "../lib/legacy-start.js";
import { downManifest } from "./down-manifest.js";
import { refuseLiveUnrecordedDaemons } from "./down-live-lease.js";
import { listLedgerFiles } from "../lib/manifest/ledger.js";
import { loadManifest, manifestPathFailure } from "../lib/manifest/index.js";
import { freshTeamAttemptSettled, listFreshTeamAttempts, listFreshTeamSummaries } from "../lib/team-fresh.js";
import { additiveTeamRecordedState, listAdditiveTeamAttempts, retainedAdditiveTeamAttempts } from "../lib/team-additive-attempt.js";
import { retainedRemovalRemedy } from "../lib/team-text.js";
import { service, serviceComplete, validateServiceArguments } from "./service-registry.js";
import { stopNamedServiceSet } from "./service-set-stop.js";
import { readLocalServiceCensus } from "../lib/service-census.js";
import { assertNoLiveServices, bareDownServicesView, liveServicesRefusal, planBareDownServices, type BareDownService } from "./down-services.js";
import { assertEndpointUnreachable } from "../lib/endpoint-cut.js";
import { processRecorded, stopInFlight, stopLocalProcess, UnattributableRecord, unattributableRecordSteps } from "../lib/local-process-stop.js";
import { stopManager } from "../lib/manager-proc.js";
import { removeDeliveryCredentials, stopDelivery } from "../lib/delivery-proc.js";
import { localDiagnostic } from "../telemetry.js";
import { controllerStackRecorded, downInOwningRoot, deliveryLeaseAfterStop, nothingRunning, sameDown, stackDown, stackRootElsewhere, validateStackDownArguments } from "./stack-down.js";
import { noticeBetweenSteps } from "../lib/interrupt-notice.js";
import { blockedDownRootRemedy, goneRootDown, goneRootStackDown, refuseInaccessibleDownRoot, validateGoneRootDownArguments } from "./stack-gone.js";
import { readStackJournal, recordedProcessLine, recordedProcessesUnder } from "../lib/stack-journal.js";
import { ownStdoutErrors } from "../lib/stdout-owner.js";
import { canPrompt } from "./meshes-wizard.js";
import * as prompts from "../lib/prompts.js";
import { yesRequired } from "../lib/confirmation-required.js";
import { shellWord } from "../lib/endpoint-errors.js";
import { sleep, processAlive, assertSessionStores, preserveStateDown, pidfileState } from "./down-preserve.js";
export { unmanagedEndpointLabel, processAlive, mayBeRunning, retainedPrincipalKeys, assertSeatsCheckpointable, captureSeatCheckpoints, assertControlPlaneQuiesced, readPresenceWithoutConsumer, pidfileState } from "./down-preserve.js";
export type { PidfileState } from "./down-preserve.js";
/** Complete selective component names without importing installed packages. */
export function downComplete(argv: string[]): CompletionResult {
  if (argv.some((word) => word === "-f" || word === "--file" || word === "--run"))
    return { items: [], directive: "nofiles" };
  if ((argv[argv.length - 1] ?? "").startsWith("-")) return { items: [], directive: "nofiles" };
  return serviceComplete(["stop", ...(argv.length ? argv : [""])]);
}

/** The stop to run in the project a `.cotal` link names. A relative store path is pinned to this
 *  invocation, because the retry runs in another folder. */
function linkedDownRetry(values: ParsedArgs["values"]): string {
  const requested = values as { file?: string; run?: string; space?: string; instance?: string; "store-dir"?: string; "session-store"?: string[]; "abandon-stop"?: string; "abandon-launch"?: string; "dry-run"?: boolean; yes?: boolean; "with-agents"?: boolean; "preserve-state"?: boolean; json?: boolean; plain?: boolean };
  const word = (flag: string, value: string | undefined): string => value === undefined ? "" : ` --${flag}${value.startsWith("-") ? "=" : " "}${shellWord(flag === "store-dir" || flag === "session-store" || flag === "file" ? resolve(value) : value)}`;
  const stores = (requested["session-store"] ?? []).map((path) => word("session-store", path)).join("");
  const flags = ["dry-run", "yes", "with-agents", "preserve-state", "json", "plain"].filter((flag) => requested[flag as keyof typeof requested] === true).map((flag) => ` --${flag}`).join("");
  return `cotal down${word("file", requested.file)}${word("run", requested.run)}${word("space", requested.space)}${word("instance", requested.instance)}${word("store-dir", requested["store-dir"])}${stores}${word("abandon-stop", requested["abandon-stop"])}${word("abandon-launch", requested["abandon-launch"])}${flags}`;
}

function namedStopArguments(args: ParsedArgs): ParsedArgs {
  return { ...args, positionals: ["stop", args.positionals[0]!] };
}

/** Refuse a known mismatch. Only a matching local startup record can carry confirmation to a root-scoped retry. */
function checkLegacyStopSpace({ space, ...flags }: ParsedArgs["values"]): boolean {
  if (typeof space !== "string" || !bareStop(flags) || flags["with-agents"] !== undefined) return false;
  let current: string | undefined, project: string | undefined;
  let source = "prepared";
  try {
    const root = canonicalRoot(cotalRoot());
    current = preparedSpaceAt(root)?.space;
    if (current === undefined && flags["dry-run"] !== true) {
      const local = localMeshesForRoot(root), sole = local[0];
      if (local.length === 1 && sole?.origin === "up" && !sole.stoppedByDown) {
        current = sole.space;
        source = "recorded";
      }
    }
    if (current !== undefined && current !== space) project = findPreparedSpace(space)?.root;
  } catch { /* A project lookup is only for the diagnostic. */ }
  if (current !== undefined && current !== space) {
    throw new CommandFailure("refused", "UNSUPPORTED", `--space ${JSON.stringify(space)} does not match the space ${JSON.stringify(current)} ${source} in this folder; nothing was stopped`, {
      remedy: project === undefined ? `locate the project root for space ${JSON.stringify(space)} before retrying` : `retry from the project root for space ${JSON.stringify(space)} at ${oneLine(project)}`,
    });
  }
  return source === "recorded" && current === space;
}

/** Named stops use only the owned-service controller. Multiple definitions require complete
 *  set selection, reservation and impact preflight. Legacy bare-stack integration stays separate. */
export function validateDownArguments(args: ParsedArgs): void {
  presentationOf(args.values);
  for (const flag of ["file", "run"] as const) {
    const value = args.values[flag];
    if (typeof value === "string" && !value.trim())
      throw new CommandFailure("refused", "USAGE_INVALID", `--${flag} is empty, so it names no ${flag === "file" ? "manifest" : "deployment run"}; nothing was stopped or written`, { remedy: `name a ${flag === "file" ? "manifest with --file <cotal.yaml>" : "deployment with --run <id>"}, or omit --${flag} to stop the folder's stack` });
  }
  if (args.positionals.length) {
    for (const name of args.positionals) localRecordName(name);
    if (args.values["with-agents"] !== undefined) throw new CommandFailure("refused", "USAGE_INVALID", "named down does not accept --with-agents; no flag was dropped", { remedy: "use `cotal service stop <manager-name> --instance <full-id> --with-agents` for the exact owned manager and its native impact review" });
    if (args.values.instance !== undefined && args.positionals.length !== 1) throw new CommandFailure("refused", "USAGE_INVALID", "--instance qualifies one service name, never a multi-service set");
    const allowed = new Set(["space", "instance", "yes", "dry-run", "json", "plain"]);
    if (Object.keys(args.values).some((name) => !allowed.has(name))) throw new CommandFailure("refused", "USAGE_INVALID", "named down accepts only space, instance, confirmation, preview and presentation flags; no whole-stack or manifest option was ignored");
    if (new Set(args.positionals).size !== args.positionals.length) throw new CommandFailure("refused", "USAGE_INVALID", "name each service once; duplicate targets were not silently collapsed");
    for (const name of args.positionals) validateServiceArguments({ ...args, positionals: ["stop", name] });
    return;
  }
  // A `.cotal` that is a link, or leads nowhere, is refused before anything reads through it.
  const linked = linkedCotalRefusal("down", undefined, () => linkedDownRetry(args.values));
  if (linked) throw linked;
  if (args.values.instance !== undefined) throw new CommandFailure("refused", "USAGE_INVALID", "--instance needs one explicit service definition name");
  if (goneRootDown(args.values)) return validateGoneRootDownArguments(args.values);
  if (controllerStackRecorded(cotalRoot())) return validateStackDownArguments(cotalRoot(), args.values);
  refuseStackElsewhere(args.values);
  if (args.values["abandon-stop"] !== undefined) throw new CommandFailure("refused", "UNSUPPORTED", "--abandon-stop applies only to a controller stack's member stop, and this root has none; nothing was abandoned");
  if (args.values["abandon-launch"] !== undefined) throw new CommandFailure("refused", "UNSUPPORTED", "--abandon-launch applies only to a controller stack's member launch, and this root has none; nothing was abandoned");
  if (args.values["dry-run"] === true && args.values.yes === true) throw new CommandFailure("refused", "USAGE_INVALID", "--yes acknowledges a guarded apply, not a read-only stack preview");
  if (args.values["preserve-state"] === true) {
    if (args.values["with-agents"]) throw new CommandFailure("refused", "USAGE_INVALID", "--preserve-state cannot be combined with --with-agents");
    if (args.values.file || args.values.run || args.values["dry-run"] || args.values.space)
      throw new CommandFailure("refused", "USAGE_INVALID", "--preserve-state is bare-whole-stack only and cannot be combined with components, --space, --file, --run, or --dry-run");
  }
  if (typeof args.values.file === "string" && args.values.run === undefined && recordedStackPreview()) {
    if (args.values["dry-run"] === true) {
      validatePreviewManifest(args.values.file);
    } else if (Object.entries(args.values).every(([name, value]) => value === undefined || ["file", "yes", "dry-run", "json", "plain"].includes(name))) {
      throw new CommandFailure("refused", "UNSUPPORTED", "file-form apply requires an additive deployment ledger; this folder records a stack started by up, so nothing was stopped", {
        target: { root: canonicalRoot(cotalRoot()), file: args.values.file },
        remedy: "run `cotal down` from this stack's root; no run ID is needed",
      });
    }
  }
  if ((args.values.json !== undefined || args.values.plain !== undefined) && args.values["dry-run"] === true && args.values.run === undefined && args.values["preserve-state"] === undefined && args.values["store-dir"] === undefined && args.values["session-store"] === undefined && (args.values.file === undefined || typeof args.values.file === "string" && recordedStackPreview())) return;
  // A folder holding another folder's registered space answers with a refusal, not with the lines a
  // bare stop prints, so structured output carries it rather than refusing the flag.
  if ((args.values.json !== undefined || args.values.plain !== undefined) && !(stoppedLegacyStack(args.values) || bareStop(args.values) && (readMaintenanceJournal(cotalRoot())?.state === "ready" || recordsElsewhere(canonicalRoot(cotalRoot()), "stop")))) {
    // A missing stop target keeps its diagnosis in every presentation mode.
    if (bareStop(args.values)) {
      const absent = noOwnedStack(canonicalRoot(cotalRoot()));
      if (absent.code === "TARGET_NOT_FOUND") throw absent;
    }
    if (args.values["preserve-state"] === true) {
      const { "store-dir": storeDir, "session-store": sessionStores } = args.values as { "store-dir"?: string; "session-store"?: string[] };
      const retry = [sameDown(args.values), ...(storeDir === undefined ? [] : [`--store-dir=${shellWord(storeDir)}`]),
        ...(sessionStores ?? []).map((path) => `--session-store=${shellWord(path)}`)].join(" ");
      throw new CommandFailure("refused", "UNSUPPORTED", "this stack's preserved cut does not support --json or --plain, and nothing was stopped", {
        remedy: `run ${codeSpan(retry)} from this root`,
      });
    }
    const sameSpace = checkLegacyStopSpace(args.values);
    if (args.values.file !== undefined || args.values.run !== undefined) {
      const preview = args.values["dry-run"] === true;
      throw new CommandFailure("refused", "UNSUPPORTED", `a legacy deployment ${preview ? "preview" : "teardown"} does not support --json or --plain`, {
        remedy: `omit --${args.values.json ? "json" : "plain"} from the original command; keep ${preview ? "--dry-run and " : ""}the same deployment selection`, selfContained: true,
      });
    }
    const retry = bareStop(args.values) || sameSpace ? sameDown(args.values) : `${displayCmd()} down`;
    throw new CommandFailure("refused", "UNSUPPORTED", "--json and --plain apply only to a controller stack, a --dry-run preview, a stack that is already stopped or a folder whose records name another folder's space; a bare stop here prints its own lines, and nothing was stopped", { remedy: `run ${codeSpan(retry)} from this root without --json or --plain; \`${displayCmd()} down --dry-run --json\` reads this root's stack` });
  }
}

/** A bare `down` stops only the stack of the folder it runs in. When this folder's root holds no
 *  stack and the space named by `--space`, or else the selected one, is a stack this machine started
 *  at another folder, refuse with that space and its root, so the remedy is a `down` that stops it.
 *  A folder with its own `.cotal` keeps the selected space from applying; a `--space` it holds no
 *  registration for still names that root. */
function refuseStackElsewhere(values: ParsedArgs["values"]): void {
  if (values.file !== undefined || values.run !== undefined) return;
  const here = canonicalRoot(cotalRoot());
  let space: string | undefined, root: string | undefined;
  try {
    const local = localMeshesForRoot(here);
    if (typeof values.space === "string" ? local.some((mesh) => mesh.space === values.space) : local.length || existsSync(join(here, ".cotal")) && here !== canonicalRoot(homedir())) return;
    space = typeof values.space === "string" ? values.space : getCurrent();
    root = space === undefined ? undefined : stackRootElsewhere(space, here);
  } catch { return; }
  if (root === undefined || space === undefined) return;
  refuseInaccessibleDownRoot(root, space);
  throw localDiagnostic(new CommandFailure("refused", "TARGET_NOT_FOUND", `${values.space === undefined ? `the selected space "${space}" is` : `--space ${space} names`} a stack rooted at ${root}, and \`cotal down\` stops only the stack of the folder it runs in; this folder has none, so nothing was stopped`, { target: { root: here, space, stackRoot: root }, remedy: downInOwningRoot(root, values) }));
}

/** The one route that stops the stack `up` starts from the machine home. */
const MACHINE_HOME_STOP = "stop the machine-home stack with `cotal down --preserve-state`, which keeps its state for the next `cotal up`";

/** A bare stack preview is a local record census, never an effect plan or stop authority. */
function previewWholeStack(args: ParsedArgs): void {
  const root = canonicalRoot(cotalRoot());
  const selectedSpace = args.values.space as string | undefined;
  const target = { root, ...(selectedSpace ? { space: selectedSpace } : {}) };
  // A stack an earlier release started in the machine home is read like any other; only its stop differs.
  const home = root === canonicalRoot(homedir());
  let mesh: NonNullable<ReturnType<typeof findMesh>>;
  let maintenance: ReturnType<typeof readMaintenanceJournal>;
  let components: Array<{ name: string; label: string; pidfile: string; recorded: boolean; liveness: "alive" | "dead" | "unknown"; pid: number | null; note: string | null }>;
  let services: ReturnType<typeof readLocalServiceCensus>, serviceChecks: BareDownService[];
  let additiveRecords: ReturnType<typeof listLedgerFiles>, additiveAttempts: ReturnType<typeof listAdditiveTeamAttempts>;
  let bootAttempts: ReturnType<typeof listFreshTeamAttempts>, bootSummaries: ReturnType<typeof listFreshTeamSummaries>;
  let otherBrokerRegistrations: Array<{ space: string; root: string; origin: string }>;
  // A root with no control directory, or with no stack registered at it, holds no stack. That is a
  // plain miss, not records that could not be read.
  const noStack = () => noStackHere(target, "preview");
  try {
    try { lstatSync(join(root, ".cotal")); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") throw noStack(); throw error; }
    if (!realDirNoSymlink(root, ".cotal")) throw new Error("missing project control directory");
    const local = localMeshesForRoot(root), sole = local[0];
    if (!local.length) throw noStack();
    if (local.length !== 1 || sole?.origin !== "up") throw new Error("no unique locally started stack at this root");
    const candidate = selectedSpace ? findMesh(selectedSpace) : sole;
    if (!candidate || candidate.origin !== "up" || candidate.space !== sole.space || canonicalRoot(candidate.root) !== root) throw new Error("space does not belong to the selected root");
    mesh = candidate;
    assertSingleSpaceBroker(authDir(root), "down preview");
    otherBrokerRegistrations = loadMeshes().filter((row) => row.space !== mesh.space && row.server === mesh.server)
      .map((row) => ({ space: row.space, root: row.root, origin: row.origin ?? "not recorded" }));
    maintenance = readMaintenanceJournal(root);
    const context: LocalProcessContext = { root, space: mesh.space };
    components = localProcessSurface().map((component) => {
      const pidfile = localProcessPath(component.pidFile, context);
      const state = pidfileState(pidfile);
      return { name: component.name, label: component.label, pidfile, recorded: processRecorded(component, context), liveness: state.liveness, pid: state.pid ?? null, note: state.note ?? null };
    });
    services = readLocalServiceCensus(mesh.space);
    serviceChecks = planBareDownServices(mesh.space);
    additiveRecords = listLedgerFiles(root, { requireReadable: true });
    additiveAttempts = listAdditiveTeamAttempts(root);
    bootAttempts = listFreshTeamAttempts(root); bootSummaries = listFreshTeamSummaries(root);
  } catch (error) {
    if (error instanceof CommandFailure) throw error;
    throw new CommandFailure("refused", "CONFLICT", "the local stack, process or service records, or maintenance state could not be inspected consistently; no stop target was inferred", { target });
  }
  const homeRuns = home && components.some((row) => row.liveness !== "dead");
  const byBootId = new Map(bootSummaries.valid.map((summary) => [summary.deploymentId, summary]));
  const unsettledBootAttempts = bootAttempts.valid.filter((attempt) => !freshTeamAttemptSettled(attempt, byBootId.get(attempt.deploymentId)));
  // A preview reports the service refusal the real stop would give instead of refusing itself.
  const refusal = liveServicesRefusal(mesh.space, serviceChecks, "down");
  const result = { kind: "whole-stack-local-preview", space: mesh.space, root, recordedBroker: brokerAddressForDisplay(mesh.server) ?? null,
    maintenance: maintenance?.state ?? "none-recorded", withAgentsRequested: args.values["with-agents"] === true,
    components, ...services, serviceChecks, otherBrokerRegistrations,
    additiveLedgers: additiveRecords.valid.map(({ ledger }) => ({ deploymentId: ledger.runId, space: ledger.space, agents: ledger.created.agents.length, channels: ledger.created.channels.length })),
    unreadableAdditiveLedgers: additiveRecords.refused.map(({ path }) => path),
    retainedAdditiveAttempts: additiveAttempts.valid.map((attempt) => ({ deploymentId: attempt.deploymentId, space: attempt.space, server: brokerAddressForDisplay(attempt.server) ?? "not displayable", createdAt: attempt.createdAt, recordedState: additiveTeamRecordedState(attempt, additiveAttempts) })),
    unreadableAdditiveAttempts: additiveAttempts.refused.map(({ path }) => path),
    unsettledBootAttempts: unsettledBootAttempts.map((attempt) => ({ deploymentId: attempt.deploymentId, space: attempt.space, server: brokerAddressForDisplay(attempt.server) ?? "not displayable", createdAt: attempt.createdAt })),
    unreadableBootRecords: [...bootAttempts.refused, ...bootSummaries.refused].map(({ path }) => path),
    brokerSharing: "exact recorded address matches only; aliases and live tenants not checked", agentImpact: "not-established", serviceInstanceScope: "selected-space workstation records only; root ownership and live state not established",
    dryRun: true, effectAttempted: false, reserved: false };
  writeResult(presentationOf(args.values), { command: "down", target: { root, space: mesh.space }, result,
    ...(refusal ? { warnings: [{ code: refusal.code, target: refusal.target, message: `the real stop would refuse: ${refusal.message}${refusal.remedy ? `; ${refusal.remedy}` : ""}` }] } : {}),
    completeness: "partial", partial: { message: "Pidfiles, additive ledgers, service records, supervisor receipts and retained attempts are not a complete owned stack or native agent-impact plan. No process identity, service root ownership, broker sharing or stop authority was established." } }, (data): Report => ({ sections: [
    { title: "Whole-stack local inspection", blocks: [{ kind: "fields", rows: [["Space", data.space], ["Root", data.root], ["Maintenance", data.maintenance], ["Saved service definitions", String(data.serviceDefinitions.length)], ["Saved service instances", String(data.serviceRecords.length)], ["Supervisor receipts", String(data.supervisors.length)], ["Retained native attempts", String(data.nativeAttempts.length)], ["Other exact-address registrations", String(data.otherBrokerRegistrations.length)], ["Additive ledgers", String(data.additiveLedgers.length)], ["Unreadable additive ledgers", String(data.unreadableAdditiveLedgers.length)], ["Retained additive deployments", String(data.retainedAdditiveAttempts.length)], ["Unreadable additive attempts", String(data.unreadableAdditiveAttempts.length)], ["Unsettled fresh attempts", String(data.unsettledBootAttempts.length)], ["Unreadable fresh records", String(data.unreadableBootRecords.length)], ["Deprovision agents", data.withAgentsRequested ? "requested; impact unknown" : "not requested; process impact unknown"], ["Stop authority", "not established"]] }, { kind: "lines", lines: [{ text: "This is a read of local records, not a stop plan. Liveness does not prove identity, and service, broker-sharing and agent consequences are not checked. No process was signalled.", tone: "waiting" }] }] },
    { title: "Recorded broker address matches", blocks: [data.otherBrokerRegistrations.length ? { kind: "table", columns: [{ key: "space", label: "Other space" }, { key: "root", label: "Recorded root" }, { key: "origin", label: "Registration" }], rows: data.otherBrokerRegistrations.slice(0, 100) } : { kind: "lines", lines: ["No other registration uses this exact broker address in the local workstation registry."] }, { kind: "lines", lines: [...(data.otherBrokerRegistrations.length > 100 ? ["Additional exact-address matches are in JSON."] : []), "An exact-address match is a sharing warning. No match is not proof of an exclusive broker: aliases, remote tenants and live attachments were not checked."] }] },
    { title: "Recorded additive deployments", blocks: [data.additiveLedgers.length ? { kind: "table", columns: [{ key: "id", label: "Deployment" }, { key: "space", label: "Recorded space" }, { key: "agents", label: "Agent rows" }, { key: "channels", label: "Channel rows" }], rows: data.additiveLedgers.slice(0, 100).map((row) => ({ id: row.deploymentId, space: row.space, agents: String(row.agents), channels: String(row.channels) })) } : { kind: "lines", lines: ["No readable additive ledgers under this project root."] }, { kind: "lines", lines: [...(data.additiveLedgers.length > 100 ? ["Additional additive ledgers are in JSON."] : []), ...data.unreadableAdditiveLedgers.slice(0, 100).map((path) => `Unreadable ledger: ${path}`), ...(data.unreadableAdditiveLedgers.length > 100 ? ["Additional unreadable paths are in JSON."] : []), "An additive ledger is not whole-stack ownership. A recorded or unreadable one blocks the retained bare apply; this preview changes nothing."] }] },
    { title: "Retained additive deployments", blocks: [data.retainedAdditiveAttempts.length ? { kind: "table", columns: [{ key: "id", label: "Deployment" }, { key: "space", label: "Space" }, { key: "state", label: "Recorded state" }, { key: "time", label: "Intent recorded" }], rows: data.retainedAdditiveAttempts.slice(0, 100).map((attempt) => ({ id: attempt.deploymentId, space: attempt.space, state: attempt.recordedState, time: attempt.createdAt })) } : { kind: "lines", lines: ["No readable additive attempts under this root."] }, { kind: "lines", lines: [...data.unreadableAdditiveAttempts.slice(0, 100).map((path) => `Unreadable additive attempt: ${path}`), ...(data.retainedAdditiveAttempts.length > 100 || data.unreadableAdditiveAttempts.length > 100 ? ["Additional attempts or paths are in JSON."] : []), "Unsettled or unremoved additive deployments block the legacy bare stop. A full matched static agent-retirement receipt releases only its original deployment's blocker; all other ownership and process guards remain."] }] },
    { title: "Fresh boot attempts", blocks: [data.unsettledBootAttempts.length ? { kind: "table", columns: [{ key: "deploymentId", label: "Deployment" }, { key: "space", label: "Space" }, { key: "server", label: "Recorded broker" }, { key: "createdAt", label: "Intent recorded" }], rows: data.unsettledBootAttempts.slice(0, 100) } : { kind: "lines", lines: ["No unsettled readable fresh boot attempts under this root."] }, { kind: "lines", lines: [...data.unreadableBootRecords.slice(0, 100).map((path) => `Unreadable fresh record: ${path}`), ...(data.unsettledBootAttempts.length > 100 || data.unreadableBootRecords.length > 100 ? ["Additional attempts or unreadable paths are in JSON."] : []), "An unsettled fresh attempt or unreadable record blocks the retained bare apply; a missing summary does not prove the broker never started."] }] },
    { title: "Local process records", blocks: [data.components.length ? { kind: "table", columns: [{ key: "name", label: "Component" }, { key: "state", label: "Pidfile probe" }, { key: "record", label: "Recorded" }, { key: "pid", label: "PID" }], rows: data.components.map((row) => ({ name: row.label, state: row.liveness, record: row.recorded ? "yes" : "no", pid: row.pid === null ? "not pinned" : String(row.pid) })) } : { kind: "lines", lines: ["No local process descriptors were found."] }] },
    { title: "Selected-space service definitions", blocks: [data.serviceDefinitions.length ? { kind: "table", columns: [{ key: "name", label: "Definition" }, { key: "launch", label: "Launch type" }, { key: "instances", label: "Instance records" }], rows: data.serviceDefinitions.slice(0, 100).map((row) => ({ name: row.name, launch: row.launch, instances: String(row.instanceRecords) })) } : { kind: "lines", lines: ["No saved service definitions in this space's workstation store."] }, ...(data.serviceDefinitions.length > 100 ? [{ kind: "lines" as const, lines: ["Additional definitions are in JSON."] }] : [])] },
    { title: "Selected-space service instances", blocks: [data.serviceRecords.length ? { kind: "table", columns: [{ key: "definition", label: "Definition" }, { key: "instance", label: "Full instance" }, { key: "state", label: "Recorded state" }, { key: "host", label: "Recorded host" }], rows: data.serviceRecords.slice(0, 100).map((row) => ({ definition: row.definition, instance: row.instanceId, state: row.recordedState, host: row.host })) } : { kind: "lines", lines: ["No saved service instances in this space's workstation store."] }, { kind: "lines", lines: [...(data.serviceRecords.length > 100 ? ["Additional service records are in JSON."] : []), "These records are scoped by space, not proven owned by this project root. Their recorded state is not live process or supervisor status; the next section observes each process on this host."] }] },
    ...(data.serviceChecks.length ? bareDownServicesView(data.space, data.serviceChecks).sections : [{ title: "Services bare down checks first", blocks: [{ kind: "lines" as const, lines: ["No saved service instance in this space, so none blocks bare down."] }] }]),
    { title: "Recorded native supervisors", blocks: [data.supervisors.length ? { kind: "table", columns: [{ key: "definition", label: "Definition" }, { key: "instance", label: "Full instance" }, { key: "mechanism", label: "Mechanism" }, { key: "unit", label: "Recorded unit" }], rows: data.supervisors.slice(0, 100).map((row) => ({ definition: row.definition, instance: row.instanceId, mechanism: row.mechanism, unit: row.unit })) } : { kind: "lines", lines: ["No supervisor receipts in this space's workstation store."] }, { kind: "lines", lines: [...(data.supervisors.length > 100 ? ["Additional supervisor receipts are in JSON."] : []), "A receipt is not a live unit observation or authority to stop it. No native service status request was made."] }] },
    { title: "Retained native attempts", blocks: [data.nativeAttempts.length ? { kind: "table", columns: [{ key: "kind", label: "Action" }, { key: "definition", label: "Definition" }, { key: "instance", label: "Full instance" }, { key: "step", label: "Step" }, { key: "position", label: "Position" }], rows: data.nativeAttempts.slice(0, 100).map((row) => ({ kind: row.kind, definition: row.definition, instance: row.instanceId, step: row.step, position: row.position })) } : { kind: "lines", lines: ["No retained install, uninstall or unit-action attempts in this space's workstation store."] }, { kind: "lines", lines: [...(data.nativeAttempts.length > 100 ? ["Additional attempts and their full IDs are in JSON."] : []), "A submitted or unknown step may already have changed native state. This preview neither reconciles nor retries it."] }] },
    ...(!home ? [] : homeRuns
      ? [{ title: "Next", blocks: [{ kind: "commands" as const, items: [{ command: "cotal down --preserve-state", description: "Stop the machine-home stack and keep its state for the next `cotal up`" }] }] }]
      : [{ title: "Next", blocks: [{ kind: "lines" as const, lines: ["No process of the machine-home stack is running, so there is nothing to stop."] }] }]),
  ] }));
}

/** Read the manifest before previewing a recorded stack without an additive ledger. */
function validatePreviewManifest(file: string): void {
  try { loadManifest(file, undefined, "preview"); }
  catch (error) {
    throw manifestPathFailure(error, { file }) ?? new CommandFailure("refused", "SCHEMA_INVALID", `cannot read ${file}: ${(error as Error).message}`, { target: { file } });
  }
}

/** A file-form dry-run previews this root's recorded stack when the manifest can be read and no
 *  additive ledger exists. A ledger, or a file that cannot be read, stays on the ledger teardown,
 *  which fails closed. */
function recordedStackPreview(): boolean {
  try {
    const root = canonicalRoot(cotalRoot());
    const local = localMeshesForRoot(root);
    const sole = local[0];
    if (local.length !== 1 || sole?.origin !== "up" || canonicalRoot(sole.root) !== root) return false;
    const ledgers = listLedgerFiles(root, { requireReadable: true });
    return ledgers.valid.length === 0 && ledgers.refused.length === 0;
  } catch { return false; }
}

/** A bare stop, its preview included: no flag beyond --dry-run, --with-agents, --yes and the
 *  presentation flags. */
function bareStop(values: ParsedArgs["values"]): boolean {
  return Object.entries(values).every(([name, value]) => ["dry-run", "with-agents", "yes", "json", "plain"].includes(name) || value === undefined || Array.isArray(value) && value.length === 0);
}

/** Whether any process record (`*.pid`) remains in `<root>/.cotal`. */
const pidRecordsUnder = (root: string): boolean => readdirSync(join(root, ".cotal")).some((name) => name.endsWith(".pid"));

/** A legacy root whose stack is not running, told apart from a folder that never had one. No
 *  registration names the root, because its own down removed the last one, or only the one a space
 *  named after its folder keeps ({@link keepsRegistration}), and no `*.pid` record remains at the top
 *  of its `.cotal`. The root still holds the broker configuration a start rendered
 *  there (`server-open.conf`, or `auth/server.conf` in auth mode) or a space prepared there. When the
 *  root names its space, none of that space's saved services runs either. Undefined when any of that
 *  is missing, so bare down refuses rather than guess. `started` says whether a start rendered that
 *  broker configuration. `nothingRunning` reads every other record a local-process descriptor names
 *  under the root, for any space, before it answers. */
function stoppedLegacyStack(values: ParsedArgs["values"]): { root: string; space?: string; started: boolean; retired: boolean } | undefined {
  const { space: requested, ...flags } = values;
  if (!bareStop(flags) || (requested !== undefined && values["with-agents"] !== undefined)) return undefined;
  const root = canonicalRoot(cotalRoot());
  if (root === canonicalRoot(homedir()) || !realDirNoSymlink(root, ".cotal") || pidRecordsUnder(root)) return undefined;
  const registered = meshesForRoot(root);
  const kept = registered.length === 1 && registered[0]!.origin !== "manual" && registered[0]!.origin !== "catalog" && keepsRegistration(registered[0]!) ? registered[0] : undefined;
  if (registered.length && !kept) return undefined;
  let space: string | undefined;
  try { space = soleSpaceOf(authDir(root)) ?? kept?.space; } catch { return undefined; }
  // A root whose space this machine registers for ANOTHER folder holds that space's records, not a
  // stack of its own that is merely stopped. Reporting it as one sent the operator to `cotal up`
  // here, which takes the name over from the folder the stack runs in. Leave it to the refusal
  // that names that folder.
  if (space !== undefined && legacyStackElsewhere(root, space)) return undefined;
  const prepared = preparedSpaceAt(root);
  const started = existsSync(join(root, ".cotal", "server-open.conf")) || existsSync(join(authDir(root), "server.conf"));
  if (!prepared && !started) return undefined;
  space ??= prepared?.space;
  // An explicit name only qualifies a never-started prepared root; it cannot select a legacy stop.
  if (requested !== undefined) {
    if (typeof requested !== "string" || started || kept || prepared?.space !== requested || space !== requested) return undefined;
    refuseSpaceElsewhere(root, requested, values);
  }
  if (space !== undefined && planBareDownServices(space).some((row) => row.action !== "already-stopped")) return undefined;
  const retired = kept?.space === space && kept?.stoppedByDown === true && kept.stoppedWithAgents === true;
  return { root, ...(space === undefined ? {} : { space }), started, retired };
}

/** The refusal for a folder with no stack. Its next step is the folder that holds one, or, when this
 *  machine has started or registered no stack at all, starting one, as `cotal status` says. A
 *  registry this cannot read may hold one. */
function noStackHere(target: { root: string; space?: string }, action: "stop" | "preview"): CommandFailure {
  const records = recordsElsewhere(target.root, action);
  if (records) return records;
  let elsewhere: boolean;
  try { elsewhere = loadMeshes().some((mesh) => mesh.origin !== "manual" && mesh.origin !== "catalog"); } catch { elsewhere = true; }
  if (!elsewhere) return new CommandFailure("refused", "TARGET_NOT_FOUND", `there is no stack at this folder's root, and this machine has no stack started or registered, so there is nothing to ${action}`, { target, remedy: `run \`${displayCmd()} up\` in a project` });
  return new CommandFailure("refused", "TARGET_NOT_FOUND", `there is no stack at this folder's root, so there is nothing to ${action}`, { target, remedy: `run \`${displayCmd()} down${action === "preview" ? " --dry-run" : ""}\` from the folder where \`${displayCmd()} up\` started the stack` });
}

/** Why bare down found no stack of its own at this root, with the one step that moves it on. */
function noOwnedStack(root: string): CommandFailure {
  const target = { root };
  const absent = noStackHere(target, "stop");
  const unclassified = new CommandFailure("refused", "CONFLICT", "the local root has no unique owned stack registration and real control directory; no whole-stack stop target was inferred", { target, remedy: "run `cotal status` here to see what this folder records" });
  if (!existsSync(join(root, ".cotal"))) return absent;
  if (!realDirNoSymlink(root, ".cotal")) return unclassified;
  let local: ReturnType<typeof localMeshesForRoot>, registered: number;
  try { local = localMeshesForRoot(root); registered = meshesForRoot(root).length; } catch { return unclassified; }
  if (local.length > 1)
    return new CommandFailure("refused", "CONFLICT", `${local.length} registrations name this root (${local.map((mesh) => `"${mesh.space}"`).join(", ")}); bare down did not pick one to stop`, {
      target: { root, spaces: local.map((mesh) => mesh.space) },
      remedy: "remove the one that does not run here with `cotal space forget <name>`",
    });
  // Records of a space registered for another folder are real records, so the unclassified refusal
  // below sent the operator to `cotal status`, which did not say so either.
  const records = recordsElsewhere(root, "stop");
  if (records) return records;
  // A registration of any kind, or a process record no registration explains, is a stack this
  // cannot classify.
  if (registered || pidRecordsUnder(root)) return unclassified;
  return absent;
}

/** The space this root's own records name, when this machine registered it for another folder. A
 *  root whose last start left its broker configuration still holds that space's trust, so a copied,
 *  renamed or taken-over folder reads as one with a stack of its own until the registration is
 *  asked where that space runs. Undefined when the root configured no broker, names no single space,
 *  or holds that space's own registration. */
function legacyRootElsewhere(root: string): { space: string; recordedRoot: string; remedy: string } | undefined {
  try {
    const retained = retainedLegacyBroker(root);
    if (!retained) return undefined;
    const space = retained.open ? retainedOpenSpace(root) : soleSpaceOf(authDir(root));
    if (space === undefined) return undefined;
    const elsewhere = legacyStackElsewhere(root, space);
    return elsewhere && { space, ...elsewhere };
  } catch { return undefined; }
}

/** The refusal for a folder holding the records of a space this machine registers for another
 *  folder: a copy of it, the folder a later `up` took the name over from, or this folder moved out
 *  of its recorded path. It names that folder and the step that reaches the stack there, because a
 *  `cotal up` here would refuse the name or take it over rather than start what the folder holds. */
function recordsElsewhere(root: string, action: "stop" | "preview"): CommandFailure | undefined {
  const elsewhere = legacyRootElsewhere(root);
  return elsewhere && new CommandFailure("refused", "CONFLICT", `this folder holds the records of "${elsewhere.space}", which is registered for ${elsewhere.recordedRoot}, not for this folder, so there is no stack here to ${action}`, {
    target: { root, space: elsewhere.space, recordedRoot: elsewhere.recordedRoot },
    remedy: elsewhere.remedy,
  });
}

/** Keep the retained pidfile sweep from crossing an exact recorded broker-sharing boundary or
 *  stopping the broker under a saved service that still runs. This is not a complete live ownership
 *  or agent-impact proof. */
function guardLegacyBareDown(): { space: string; server: string; mode?: string } {
  const root = canonicalRoot(cotalRoot());
  const target = { root };
  if (root === canonicalRoot(homedir())) {
    // `up` starts no stack in the home, so one that records none has nothing to stop.
    if (!existsSync(join(root, ".cotal")) || !localMeshesForRoot(root).length && !pidRecordsUnder(root)) throw noOwnedStack(root);
    throw new CommandFailure("refused", "CONFLICT", "the machine home is not an isolated whole-stack stop root; no process was signalled", { target, remedy: MACHINE_HOME_STOP });
  }
  let mesh: { readonly space: string; readonly server: string; readonly mode?: string };
  try {
    if (!realDirNoSymlink(root, ".cotal")) throw new Error("missing project control directory");
    // A root that hosts several spaces refuses before the registration lookup, naming them.
    try { assertSingleSpaceBroker(authDir(root), "bare down"); }
    catch (error) { throw new CommandFailure("refused", "CONFLICT", (error as Error).message, { target }); }
    const local = localMeshesForRoot(root), sole = local[0];
    // A start interrupted before it registered its space left its broker with no registration. The
    // root's own files name that space and address, and the guards below apply to it unchanged.
    const interrupted = local.length ? undefined : interruptedStartBroker(root);
    if (interrupted) mesh = interrupted;
    else if (local.length !== 1 || sole?.origin !== "up") throw new Error("no unique locally started stack at this root");
    else mesh = sole;
  } catch (error) {
    if (error instanceof CommandFailure) throw error;
    throw noOwnedStack(root);
  }
  const scoped = { root, space: mesh.space };
  const maintenance = readMaintenanceJournal(root);
  // A validated active restore is complete, so its retained journal does not fence ordinary stop.
  // Pending transitions and a journal naming another space still cannot authorize this sweep.
  if (maintenance && (maintenance.state !== "active" || maintenance.space !== mesh.space)) throw new CommandFailure("refused", "LIFECYCLE_BLOCKED", "this stack retains a maintenance transition; ordinary bare down did not bypass it", { target: { ...scoped, state: maintenance.state } });
  let ledgers: ReturnType<typeof listLedgerFiles>;
  try { ledgers = listLedgerFiles(root, { requireReadable: true }); }
  catch (error) { if (isCommandFailure(error)) throw error; throw new CommandFailure("refused", "TARGET_UNAVAILABLE", "the root's additive ledger directory could not be inspected; bare down did not infer that it owns every resource", { target: scoped }); }
  if (ledgers.valid.length || ledgers.refused.length)
    throw new CommandFailure("refused", "LIFECYCLE_BLOCKED", "additive ownership ledgers or unreadable ledger records remain under this root; bare down did not adopt or stop their resources", { target: { ...scoped, deploymentIds: ledgers.valid.map(({ ledger }) => ledger.runId), unreadable: ledgers.refused.map(({ path }) => path) }, remedy: [
      ...ledgers.valid.map(({ ledger }) => `run \`cotal down --run ${ledger.runId}\` to tear down additive deployment ${ledger.runId}`),
      ...ledgers.refused.map(({ path, why }) => `repair the unreadable record (${why}), then run \`cotal down --run ${basename(path, ".json")}\``),
      "then run `cotal down` again",
    ].join("; ") });
  let additiveAttempts: ReturnType<typeof listAdditiveTeamAttempts>;
  try { additiveAttempts = listAdditiveTeamAttempts(root); }
  catch (error) { if (isCommandFailure(error)) throw error; throw new CommandFailure("refused", "TARGET_UNAVAILABLE", "the additive attempt inventory could not be read; bare down did not infer an empty resource set", { target: scoped }); }
  if (retainedAdditiveTeamAttempts(additiveAttempts).length || additiveAttempts.refused.length)
    throw new CommandFailure("refused", "LIFECYCLE_BLOCKED", "an additive attempt or returned additive deployment remains under this root; legacy bare down did not adopt its resources", { target: { ...scoped, deploymentIds: retainedAdditiveTeamAttempts(additiveAttempts).map((attempt) => attempt.deploymentId), unreadable: additiveAttempts.refused.map(({ path }) => path) }, remedy: retainedRemovalRemedy(retainedAdditiveTeamAttempts(additiveAttempts).map((attempt) => attempt.deploymentId), additiveAttempts.refused.map(({ path }) => path), "cotal down") });
  let attempts: ReturnType<typeof listFreshTeamAttempts>, summaries: ReturnType<typeof listFreshTeamSummaries>;
  try { attempts = listFreshTeamAttempts(root); summaries = listFreshTeamSummaries(root); }
  catch (error) { if (isCommandFailure(error)) throw error; throw new CommandFailure("refused", "TARGET_UNAVAILABLE", "fresh boot attempt or summary records could not be read; bare down did not infer stop authority", { target: scoped }); }
  const returned = new Map(summaries.valid.map((summary) => [summary.deploymentId, summary]));
  const unsettled = attempts.valid.filter((attempt) => !freshTeamAttemptSettled(attempt, returned.get(attempt.deploymentId)));
  if (unsettled.length || attempts.refused.length || summaries.refused.length)
    throw new CommandFailure("refused", "LIFECYCLE_BLOCKED", "a fresh boot attempt is unsettled or a boot record unreadable; legacy bare down did not stop a process whose original launch outcome is unknown", { target: { ...scoped, unsettledIds: unsettled.map((row) => row.deploymentId), unreadable: [...attempts.refused, ...summaries.refused].map(({ path }) => path) }, remedy: "inspect the original boot and process custody before any stop; the pidfile sweep is not recovery" });
  const other = loadMeshes().filter((row) => row.space !== mesh.space && row.server === mesh.server);
  // The stop is refused because this listener answers for more than one registration, so the
  // operator needs the command that takes the other registration off this address. Each other space
  // is named with its own `space forget`, which `cotal space show` reads first and which refuses
  // while that space runs, and the stop to run again once the address is this stack's alone.
  if (other.length) throw new CommandFailure("refused", "LIFECYCLE_BLOCKED", "another registered space names this exact broker address; bare down did not stop its shared listener", { target: { ...scoped, otherSpaces: other.map((row) => row.space) }, remedy: [
    ...other.map(({ space }) => {
      const name = `${space.startsWith("-") ? "-- " : ""}${shellWord(space)}`;
      return `read ${JSON.stringify(space)} with ${codeSpan(`cotal space show ${name}`)}, stop it in its own folder, then take it off this address with ${codeSpan(`cotal space forget ${name}`)}`;
    }),
    "then run `cotal down` again",
  ].join("; ") });
  assertNoLiveServices(mesh.space, "down");
  return { space: mesh.space, server: mesh.server, mode: mesh.mode };
}

/** Before any legacy stop or stopped receipt, let a foreground launch finish starting its daemons. */
async function awaitForegroundStartup(root: string, preview: boolean): Promise<void> {
  const starting = () => {
    const holder = readMaintenanceLockHolder(root);
    return holder?.operation === "foreground up" && localProcessOwnerStatus(holder.owner) !== "dead" ? holder.owner : undefined;
  };
  const owner = starting();
  if (!owner) return;
  const refusal = () => new CommandFailure("refused", "LIFECYCLE_BLOCKED", `a foreground \`cotal up\` (pid ${owner.pid}) is still starting this stack; nothing was stopped`, {
    target: { root, holderPid: owner.pid },
    remedy: "press Ctrl-C in the terminal running `cotal up`, or wait for startup to finish and retry `cotal down --yes`",
  });
  const broker = verifyIdentityPin(join(root, ".cotal", NATS_PIDFILE));
  if (preview || broker.kind !== "match" || !localMeshesForRoot(root).some((mesh) => mesh.origin === "up")) throw refusal();
  const deadline = Date.now() + 20_000;
  for (let current = starting(); current; current = starting()) {
    if (current.id !== owner.id || Date.now() >= deadline) throw refusal();
    await sleep(200);
  }
}

/** Bare down reads each process record it stops where the record lies, as the stopped-stack census
 *  does. A record that read leaves unread (a link on its path, a record that is not a regular file,
 *  is larger than a record, cannot be opened or changes while it is read) refuses before the first
 *  stop, naming where reading stopped: no process behind it is read, signalled or unrecorded. */
function refuseUncontainedRecords(components: readonly LocalProcess[], context: LocalProcessContext): void {
  const unread = new Map<string, string>();
  for (const component of components) {
    const record = readContainedRecord(context.root, localProcessPath(component.pidFile, context));
    if (record.state === "unread" && !unread.has(record.at)) unread.set(record.at, recordedProcessLine({ name: component.name, path: relative(context.root, record.at), note: record.why }));
  }
  if (!unread.size) return;
  const paths = [...unread.keys()].map((at) => relative(context.root, at));
  throw new CommandFailure("refused", "LIFECYCLE_BLOCKED", `process records under this root cannot be read in place (${[...unread.values()].join("; ")}), so bare down stopped nothing; it does not read or signal through them`, {
    target: { root: context.root, space: context.space, processes: [...unread.values()] },
    remedy: `check ${paths.join(", ")}; stop each process where it was started, and replace a link with this stack's own record or remove it, then run \`cotal down\` again`,
  });
}

/** A stop or preview from another folder names the stack's root only for a local registration.
 *  A manual or catalog entry records where the connection is used, not where the stack runs. */
function refuseSpaceElsewhere(root: string, space: string, values: ParsedArgs["values"]): void {
  let at: string | undefined, connection: boolean;
  try {
    const mesh = findMesh(space);
    at = mesh?.root ?? findPreparedSpace(space)?.root;
    connection = mesh?.origin === "manual" || mesh?.origin === "catalog";
  } catch { return; }
  if (at === undefined || at === root || existsSync(at) && canonicalRoot(at) === canonicalRoot(root)) return;
  if (connection) throw localDiagnostic(new CommandFailure("refused", "TARGET_NOT_FOUND", `the connection to space "${space}" is registered at ${at}; its registration does not identify the folder that started the stack`, {
    target: { root, space, registeredRoot: at }, remedy: downInOwningRoot(undefined, values),
  }));
  refuseInaccessibleDownRoot(at, space);
  let controller = false;
  try { controller = readStackJournal(at)?.journal.space === space; } catch { /* named with the legacy stop */ }
  const stop = controller ? "cotal down --yes" : "cotal down";
  throw localDiagnostic(new CommandFailure("refused", "TARGET_NOT_FOUND", `the stack of space "${space}" is recorded at ${at}, not at this folder's root, and \`cotal down\` stops only the stack recorded where it runs`, {
    target: { root, space, spaceRoot: at },
    remedy: values["dry-run"] ? downInOwningRoot(at, values) : blockedDownRootRemedy(at, stop) ?? `run \`${stop}\` in ${at}; to stop one saved service, run \`cotal service stop <service-name> --space ${space}\``,
  }));
}

/** `cotal down`. It owns stdout's errors for its whole run, so a reader that goes away, as with
 *  `| head -1`, no longer ends it between a member's stop request and that stop's confirmation. The
 *  stop runs to its end, and the exit status is the stop's own. */
export async function down(args: ParsedArgs): Promise<void> {
  const releaseOutput = ownStdoutErrors(() => {});
  try { await downCommand(args); }
  finally { releaseOutput(); }
}

/** One named service is a thin native-controller alias. The retained bare-stack and manifest
 *  paths below have not yet been replaced by the approved whole-stack controller. */
async function downCommand(args: ParsedArgs): Promise<void> {
  validateDownArguments(args);
  if (args.positionals.length > 1) return stopNamedServiceSet(args);
  if (args.positionals.length) return service(namedStopArguments(args), "down");
  const gone = goneRootDown(args.values);
  if (gone) return goneRootStackDown(gone.space, gone.root, args.values);
  if (controllerStackRecorded(cotalRoot())) return stackDown(cotalRoot(), args.values);
  const ownerHome = legacyStackOtherHome(cotalRoot());
  if (ownerHome !== undefined) throw new CommandFailure("refused", "TARGET_UNAVAILABLE", "this folder's running stack belongs to another Cotal home; nothing was stopped", { target: { root: cotalRoot(), home: ownerHome }, remedy: stackHomeRemedy(ownerHome) });
  const values = args.values as { file?: string; run?: string; "dry-run"?: boolean; "preserve-state"?: boolean; "with-agents"?: boolean; "store-dir"?: string; "session-store"?: string[]; space?: string };
  // A legacy root whose stack is already stopped: a bare down and its preview stop nothing.
  const bare = bareStop(args.values);
  if (bare || stoppedLegacyStack(args.values)) {
    const root = canonicalRoot(cotalRoot());
    await awaitForegroundStartup(root, !bare || values["dry-run"] === true);
    const maintenance = readMaintenanceJournal(root);
    if (bare && maintenance?.state === "ready") {
      const space = maintenance.space, server = maintenance.cut.launch.server;
      const target = { root, space, server, state: maintenance.state };
      const blocked = (why: string) => new CommandFailure("refused", "LIFECYCLE_BLOCKED", `this stack's preserved cut is ready, but ${why}; nothing was stopped`, { target, remedy: "run `cotal status` to inspect the stack and its maintenance state" });
      const busy = () => {
        const holder = maintenanceLockHolder(root);
        return holder !== undefined && holder !== "dead";
      };
      const mayRun = () => recordedProcessesUnder(root, [space]).length > 0 || planBareDownServices(space).some((row) => row.action !== "already-stopped");
      if (busy()) throw blocked("a maintenance operation still holds the root");
      if (mayRun())
        throw blocked("recorded processes may still be running");
      try { await assertEndpointUnreachable(server); }
      catch { throw blocked("the recorded broker address could not be confirmed offline"); }
      // An up can begin during the listener probe. Do not let a changed cut authorize the receipt.
      const current = readMaintenanceJournal(root);
      if (busy() || current?.state !== "ready" || current.cut.attemptId !== maintenance.cut.attemptId || mayRun())
        throw blocked("the stack changed while it was checked");
      if (values["with-agents"] === true) throw blocked("stopping agents requires a running manager");
      return writeResult(presentationOf(args.values), { command: "down", target, result: { kind: "stack-not-running", ...target }, noOp: true }, () => ({ space, sections: [
        { title: `The stack in ${root} is already stopped`, blocks: [{ kind: "lines", lines: ["The preserved cut is ready and was left unchanged."] }] },
        { title: "Next", blocks: [{ kind: "commands", items: [{ command: "cotal status", description: "See the next maintenance step" }] }] },
      ] }));
    }
    const stopped = maintenance && maintenance.state !== "active" ? undefined : stoppedLegacyStack(args.values);
    // A root that never started a stack never ran a manager, so it has no agents to stop.
    if (stopped) {
      const { started, retired, ...target } = stopped;
      // Missing pidfiles are not proof the daemons stopped. A live lease refuses before this
      // answers that nothing is running, and before the broker is stopped.
      await refuseLiveUnrecordedDaemons(localProcessSurface(), { root: target.root, space: target.space ?? resolveRuntimeSpace(process.cwd()) });
      await awaitForegroundStartup(root, true);
      return nothingRunning(presentationOf(args.values), target, values["with-agents"] === true && started && !retired, [], values["dry-run"] === true);
    }
  }
  if (values["dry-run"] && !values.file && !values.run && !values["preserve-state"] && !values["store-dir"] && !values["session-store"]?.length) {
    if (values.space) refuseSpaceElsewhere(cotalRoot(), values.space, args.values);
    return previewWholeStack(args);
  }
  if (values["with-agents"] && (values.file || values.run || values.space))
    throw new CommandFailure("refused", "USAGE_INVALID", "--with-agents is bare-whole-stack only and cannot be combined with components, --space, --file, or --run");
  if (values["preserve-state"]) {
    assertSingleSpaceBroker(authDir(cotalRoot()), "cotal down");
    await preserveStateDown(values["store-dir"], assertSessionStores(values["session-store"] ?? []));
    return;
  }
  if (values["store-dir"]) throw new CommandFailure("refused", "USAGE_INVALID", "--store-dir is only valid with down --preserve-state");
  if (values["session-store"]?.length) throw new CommandFailure("refused", "USAGE_INVALID", "--session-store is only valid with down --preserve-state");
  if ((values.file || values.run) && values.space) {
    throw new CommandFailure("refused", "USAGE_INVALID", "component names and --space cannot be combined with --file or --run");
  }
  if (values.file && values["dry-run"] && values.run === undefined && recordedStackPreview()) {
    validatePreviewManifest(values.file);
    return previewWholeStack(args);
  }
  if (values.file || values.run) {
    await downManifest(values.file ?? "<run>", { run: values.run, dryRun: Boolean(values["dry-run"]) });
    return;
  }
  if (values.space) {
    const sameSpace = checkLegacyStopSpace(args.values);
    refuseSpaceElsewhere(cotalRoot(), values.space, args.values);
    throw new CommandFailure("refused", "USAGE_INVALID", "a bare stop takes no --space: `cotal down` stops the stack recorded at this folder's root", {
      target: { root: cotalRoot(), space: values.space },
      remedy: `run ${codeSpan(sameSpace ? sameDown(args.values) : `${displayCmd()} down`)} without --space from the stack's root; to stop one saved service, run \`cotal service stop <service-name> --space <space>\``,
    });
  }
  const guarded = guardLegacyBareDown();
  const selected = localProcessSurface()
    .sort((a, b) => Number(Boolean(a.stopLast)) - Number(Boolean(b.stopLast)) || (a.order ?? 50) - (b.order ?? 50));
  // A `down` that touches this folder's stack stops the shared broker and its per-space daemons;
  // none of them can address one space, so a multi-space root is refused up front rather than at
  // the space-blind pidfile lookup below.
  assertSingleSpaceBroker(authDir(cotalRoot()), "cotal down");
  let folderContext: LocalProcessContext | undefined;
  const folderCtx = (): LocalProcessContext => (folderContext ??= { root: cotalRoot(), space: resolveRuntimeSpace(process.cwd()) });
  refuseUncontainedRecords(selected, folderCtx());
  if (args.values.yes !== true) {
    const target = { root: folderCtx().root, space: guarded.space };
    if (!canPrompt()) {
      const command = `${displayCmd()} down${values["with-agents"] ? " --with-agents" : ""}`;
      throw new ConfirmationRequired(yesRequired("stopping the whole local stack", false), { target, remedy: `run \`${command} --yes\` to stop it. \`${command} --dry-run\` shows its local records` });
    }
    const records = () => selected.map((component) => {
      const path = localProcessPath(component.pidFile, folderCtx());
      return { path, recorded: processRecorded(component, folderCtx()), pid: readContainedRecord(target.root, path), identity: readContainedRecord(target.root, `${path}.identity`) };
    });
    const reviewedRecords = JSON.stringify(records());
    console.log(renderReport({ space: guarded.space, sections: [{ title: "Whole-stack stop", blocks: [
      { kind: "fields", rows: [["Root", target.root], ["Stop recorded components", selected.filter((component) => processRecorded(component, folderCtx())).map((component) => component.label).join(", ") || "none"], ["Retire managed agents", values["with-agents"] ? "requested" : "not requested"]] },
      { kind: "lines", lines: ["These are retained local records, not a verified process or agent-impact plan. The existing ownership and stop guards still apply."] },
    ] }] }, "rich", process.stdout));
    const answer = await prompts.confirm({ message: `Stop ${oneLine(guarded.space)}'s whole local stack?`, initialValue: false });
    if (prompts.isCancel(answer) || !answer) {
      console.log("Cancelled; no process was stopped.");
      return;
    }
    // Input can wait indefinitely. A prior scope check cannot authorize the stack now present.
    const changed = () => new CommandFailure("refused", "CONFLICT", "the local stack changed while confirmation waited; no process was stopped", { target, remedy: "run `cotal down` again to review the current stack" });
    if (cotalRoot() !== target.root) throw changed();
    validateDownArguments(args);
    if (controllerStackRecorded(target.root)) throw changed();
    await awaitForegroundStartup(target.root, false);
    const current = guardLegacyBareDown();
    if (current.space !== guarded.space || current.server !== guarded.server || resolveRuntimeSpace(process.cwd()) !== folderCtx().space) throw changed();
    refuseUncontainedRecords(selected, folderCtx());
    if (JSON.stringify(records()) !== reviewedRecords) throw changed();
  }
  // A signal ends the stop where it is, and the notice names the members it stopped and those still
  // running. One that lands after a member was signalled waits for that member's exit, so its stop is
  // reported first; a second one ends the stop at once and names that member. Once every member is
  // stopped, the cleanup below finishes first.
  const stopped: string[] = [];
  let cleaning = false, cleaned = false;
  const interrupt = noticeBetweenSteps(() => legacyStopInterruptNotice(selected, folderCtx(), stopped, stopInFlight(), cleaned), () => cleaning || stopInFlight() !== undefined);
  // The stop's lines follow the space they stop, as every other report of down begins.
  console.log(`${renderReport({ space: guarded.space, sections: [] }, "rich", process.stdout)}\n`);
  // Every dry run returned or was refused above, so from here on this is the whole-stack stop of
  // this folder's root.

  let any = false;
  let allStopped = true;
  let retiredAgents = false;
  const unattributable: UnattributableRecord[] = [];
  let deliveryLease: Awaited<ReturnType<typeof deliveryLeaseAfterStop>> | undefined;
  // A missing manager or delivery pidfile is not proof those daemons stopped. They renew leases
  // while they run, so a live lease with no pidfile refuses before the broker is stopped.
  await refuseLiveUnrecordedDaemons(selected, { ...folderCtx(), space: guarded.space });
  for (const component of selected) {
    await interrupt.between();
    const recorded = processRecorded(component, folderCtx());
    any = recorded || any;
    if (component.stopLast && !allStopped) {
      stderrLine("✗ ", `not stopping ${component.label} because an earlier component did not stop`, c.red);
      continue;
    }
    try {
      const context = folderCtx();
      if (component.name === "manager") await stopManager(context.space, { withAgents: values["with-agents"], onRetired: () => { retiredAgents = true; } });
      else if (component.name === "delivery") {
        await stopDelivery(context.space, { preserveCredentials: true });
        // The daemon's exit does not prove its release committed: it gives the release two seconds
        // and then exits anyway. The row it leaves is recognised by the next up only through this
        // daemon's credential, so the lease is read while the broker still runs.
        if (guarded.mode !== "open") deliveryLease = await deliveryLeaseAfterStop(context.root, context.space, guarded.server);
      }
      else await stopLocalProcess(component, context);
      if (recorded) stopped.push(component.label);
    } catch (e) {
      allStopped = false;
      if (e instanceof UnattributableRecord) unattributable.push(e);
      stderrLine("✗ ", `${(e as Error).message}`, c.red);
      // A live manager may still need delivery. Do not tear down anything under a refused stop.
      if (component.name === "manager") break;
    }
  }
  if (!allStopped) {
    stderrLine("✗ ", "not cleanly stopped - keeping artifacts and the registry entry", c.red);
    // A record that names no process is removed only by the operator, once they know no process of
    // that component still runs here. Nothing cotal reads can show that, so the step says so first.
    if (unattributable.length) {
      const steps = unattributable.map((record) => unattributableRecordSteps(record.label, record.path));
      console.log(`\n${renderReport({ sections: [{ title: "Next", blocks: [
        { kind: "lines", lines: steps.map((step) => step.check) },
        { kind: "commands", items: [...steps.map((step) => step.removal), { command: sameDown(args.values), description: "Then stop the stack" }] },
      ] }] }, "rich", process.stdout)}`);
    }
    await interrupt.between();
    interrupt.release();
    process.exitCode = 1;
    return;
  }
  cleaning = true;

  if (deliveryLease === "held" || deliveryLease === "unread")
    stderrLine("! ", deliveryLease === "held"
      ? "the delivery daemon exited without releasing shard 0 of its lease, so its credential stays; the next `cotal up` waits for the lease to expire"
      : "the delivery lease could not be read after the delivery daemon stopped, so its credential stays; the next `cotal up` waits out a lease that still names it", c.yellow);
  else if (selected.some((component) => component.name === "delivery"))
    await removeDeliveryCredentials(folderCtx().space);

  for (const component of selected) {
    for (const artifact of component.artifacts ?? []) rmSync(localProcessPath(artifact, folderCtx()), { force: true });
  }

  // Pidfiles are the only thing this stack owns. A registered broker that answers with no pidfile
  // is a different situation: something is running that `down` did not start and must not stop.
  // This runs BEFORE the registry sweep below, which drops this root's records. Probing after that
  // sweep would find nothing and print "Nothing running" about a broker that is still up.
  // Owned components (a detached web, a manager) do not change the question: stopping them is not
  // the same as this stack owning the broker. The probe runs on every bare down that holds no
  // nats pidfile, AFTER their owned artifacts cleared, so those components stop exactly as they
  // do with no broker present.
  const unowned = await liveUnownedBrokers(folderCtx());
  if (unowned.length) {
    for (const broker of unowned) {
      console.error(c.red(
        `Broker for "${broker.space}" is running at ${broker.server}, but no pidfile records it. ` +
        `cotal down will not stop a process it did not start. ` +
        `Stop that broker with the supervisor that started it, or remove the registration with \`cotal meshes rm ${broker.space}\`.`,
      ));
    }
    process.exit(1);
  }

  // The broker owns the mesh registry entry and transient whole-mesh launch material, so they go
  // with it. A space named after its own folder keeps its registration, as a controller stack keeps
  // its prepared record, so the name stays this folder's while it is stopped and another folder's
  // bare `up` cannot take it. `space forget` frees it.
  if (selected.some((component) => component.clearsMesh)) {
    const root = folderCtx().root;
    rmSync(join(root, ".cotal", "run"), { recursive: true, force: true });
    const retained = localMeshesForRoot(root).find(keepsRegistration);
    removeMeshesByRoot(root, undefined, retained?.space);
    if (any && retained?.space === guarded.space && retained.server === guarded.server)
      recordMesh({ ...retained, stoppedByDown: true, stoppedWithAgents: retiredAgents ? true : undefined });
  }
  cleaning = false;
  cleaned = true;
  await interrupt.between();
  interrupt.release();
  if (!any) {
    console.error(c.red("Nothing running for the local stack (no recorded pidfiles)."));
    process.exit(1);
  }
  let payload: number | undefined;
  // The retained policy determines the restart, not whether the stop succeeded.
  try { if (guarded.mode === "open") payload = readBrokerPolicy(folderCtx().root)?.maxPayload; }
  catch { return; }
  const restart = payload !== undefined && payload < MANAGER_START_PAYLOAD_FLOOR ? "up --no-manager" : "up";
  console.log(`\n${renderReport({ sections: [{ title: "Next", blocks: [{ kind: "commands", items: [{ command: `${displayCmd()} ${restart}`, description: "Start it again" }] }] }] }, "rich", process.stdout)}`);
}

/** What an interrupted bare down of a legacy stack left: the members it stopped, the ones still
 *  running, and the down that finishes the stop. `cut` is a member a second signal left signalled
 *  with its exit not confirmed. */
function legacyStopInterruptNotice(members: readonly LocalProcess[], context: LocalProcessContext, stopped: readonly string[], cut: LocalProcess | undefined, cleaned: boolean): string {
  const running = members.filter((member) => processAlive(member, context)).map((member) => member.label);
  const done = stopped.length ? `${stopped.join(", ")} ${stopped.length === 1 ? "was" : "were"} stopped` : "no member was stopped";
  const left = running.length ? `${running.join(", ")} ${running.length === 1 ? "is" : "are"} still running` : "no member is running";
  const head = `Interrupted while stopping the stack in ${canonicalRoot(context.root)}; ${done}, and ${left}.`;
  if (cut) return `${head} The stop of ${cut.label} is not confirmed. Run \`cotal down --yes\` to finish the stop.`;
  if (running.length) return `${head} Run \`cotal down --yes\` to finish the stop.`;
  return cleaned ? `${head} Run \`cotal up\` to start it again.` : `${head} Run \`cotal down --yes\` to finish its cleanup.`;
}

/** Registered brokers for this root that answer and have no nats pidfile. Never a kill list. */
async function liveUnownedBrokers(context: LocalProcessContext): Promise<Array<{ space: string; server: string }>> {
  const nats = localProcessSurface().find((component) => component.name === "nats");
  if (!nats || processRecorded(nats, context)) return [];
  const matching = meshesForRoot(context.root);
  const live: Array<{ space: string; server: string }> = [];
  for (const mesh of matching) {
    if (await isReachable(mesh.server)) live.push({ space: mesh.space, server: mesh.server });
  }
  return live;
}

/**
 * Compatibility inventory for `clean`; lifecycle commands use the registered descriptors above.
 *
 * ABSOLUTE paths, and EVERY name each record has been written under. The runtime records are
 * `{space}` templates now, so only the local-process seam may expand one, and a sweeper that named
 * just the canonical spelling would leave a pre-upgrade `manager.pid` behind on exactly the root a
 * full reset is for. Built from the CANDIDATE list rather than {@link localProcessPath}: a deleter
 * must name what it removes, and the resolver refuses on a root holding both spellings.
 */
export function pidfileTargets(space: string, root: string): Array<[file: string, label: string]> {
  const context: LocalProcessContext = { root, space };
  const every = (template: string, label: string): Array<[string, string]> =>
    localProcessPathCandidates(template, context).map((p) => [p, label]);
  return [
    ...every(MANAGER_PIDFILE, "manager"),
    ...every(MANAGER_DELIVERY_AWARE_MARKER, "manager delivery-aware marker"),
    ...every(DELIVERY_PIDFILE, "delivery daemon"),
    ...every(AUTH_PIDFILE, "user-auth service"),
    ...every(WEB_PIDFILE, "web dashboard"),
    ...every(NATS_PIDFILE, "nats-server"),
  ];
}
