import { lstatSync, readFileSync, rmSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve as resolvePath } from "node:path";
import { type CompletionResult, type ParsedArgs } from "@cotal-ai/core";
import {
  CommandFailure,
  localRecordName,
  presentationOf,
  abortMaintenanceCut,
  acquireMaintenanceLock,
  assertSingleSpaceBroker,
  authDir,
  beginMaintenanceCut,
  clearPreservationCommitIntent,
  clearPreservationPrepareIntent,
  completeMaintenanceCut,
  loadMeshes,
  meshesForRoot,
  localProcessPath,
  localProcessPathCandidates,
  canonicalRoot,
  brokerAddressForDisplay,
  findMesh,
  localMeshesForRoot,
  writeResult,
  type Report,
  readMaintenanceJournal,
  readMaintenanceResumeDocument,
  readPreservationCommitIntent,
  readPreservationPrepareIntent,
  readStoreIdentity,
  recordPreservationManagerCommit,
  releaseMaintenanceLock,
  removeMeshesByRoot,
  sameStoreIdentity,
  writePreservationCommitIntent,
  writePreservationPrepareIntent,
  DELIVERY_PIDFILE,
  MANAGER_DELIVERY_AWARE_MARKER,
  MANAGER_PIDFILE,
  WEB_PIDFILE,
  type LocalProcess,
  type LocalProcessContext,
  MAINTENANCE_RESUME_DOCUMENT_VERSION,
  writeMaintenanceResumeDocument,
  loadSeatWriterGeneration,
  materializeFromManifest,
  type MaintenanceResumeDescriptor,
  seatCheckpointDir,
  type SeatCheckpoint,
  type JsonValue,
} from "@cotal-ai/workspace";
import { jetstreamManager } from "@nats-io/jetstream";
import type { NatsConnection } from "@nats-io/transport-node";
import {
  DEV_OWNER,
  dialerFor,
  isReachable,
  realDirNoSymlink,
  LEASE_TTL_MS,
  MANAGER_LEASE_KEY,
  MANAGER_LEASE_TTL_MS,
  deliveryBucket,
  managerBucket,
  presenceBucket,
  parsePrincipalKey,
  principalKey,
  standaloneConnectOpts,
  type Connector,
  type ManagerLeaseInfo,
  type Presence,
} from "@cotal-ai/core";
import { localProcessSurface } from "../ext-loader.js";
import { c } from "../ui.js";
import { cotalRoot } from "../lib/paths.js";
import { parsePid, probeLiveness, readPidfile } from "@cotal-ai/workspace";
import { resolveRuntimeSpace } from "../lib/status.js";
import { downManifest } from "./down-manifest.js";
import { listLedgerFiles } from "../lib/manifest/ledger.js";
import { freshTeamAttemptSettled, listFreshTeamAttempts, listFreshTeamSummaries } from "../lib/team-fresh.js";
import { additiveTeamRecordedState, listAdditiveTeamAttempts, retainedAdditiveTeamAttempts } from "../lib/team-additive-attempt.js";
import { service, serviceComplete, validateServiceArguments } from "./service-registry.js";
import { stopNamedServiceSet } from "./service-set-stop.js";
import { readLocalServiceCensus } from "../lib/service-census.js";
import { askManager, resolveControlTarget } from "../lib/control.js";
import { connectOrExit, userViewAuthOrExit } from "../lib/connect.js";
import { waitForEndpointUnreachable } from "../lib/endpoint-cut.js";
import { captureSeatCheckpoint } from "../lib/seat-capture.js";
import { processRecorded, stopLocalProcess } from "../lib/local-process-stop.js";
import { stopManager } from "../lib/manager-proc.js";
import { removeDeliveryCredentials, stopDelivery } from "../lib/delivery-proc.js";
import { controllerStackRecorded, stackDown, validateStackDownArguments } from "./stack-down.js";

/** The fields a checkpoint reads off one retained inventory entry. The manager owns
 *  `ManagerResumeAgent`; the CLI never imports it, because implementations do not depend on each
 *  other, so the coordinator states the shape it actually reads. */
interface ManagerResumeAgentShape {
  name: string;
  identity: { lifecycleUid: string };
  launch: {
    connector: string;
    cwd?: string;
    sessionId?: string;
    sessionStatePath?: string;
    unresolvedLaunchOptionKeys?: string[];
    source: { configSha256: string; manifestSha256?: string; hash?: string };
  };
}

/** Complete selective component names without importing installed packages. */
export function downComplete(argv: string[]): CompletionResult {
  if (argv.some((word) => word === "-f" || word === "--file" || word === "--run"))
    return { items: [], directive: "nofiles" };
  if ((argv[argv.length - 1] ?? "").startsWith("-")) return { items: [], directive: "nofiles" };
  return serviceComplete(["stop", ...(argv.length ? argv : [""])]);
}

function namedStopArguments(args: ParsedArgs): ParsedArgs {
  return { ...args, positionals: ["stop", args.positionals[0]!] };
}

/** Named stops use only the owned-service controller. Multiple definitions require complete
 *  set selection, reservation and impact preflight. Legacy bare-stack integration stays separate. */
export function validateDownArguments(args: ParsedArgs): void {
  presentationOf(args.values);
  if (args.positionals.length) {
    for (const name of args.positionals) localRecordName(name);
    if (args.values["with-agents"] !== undefined) throw new CommandFailure("refused", "USAGE_INVALID", "named down does not accept --with-agents; no flag was dropped", { remedy: "use cotal service stop <manager-name> --instance <full-id> --with-agents for the exact owned manager and its native impact review" });
    if (args.values.instance !== undefined && args.positionals.length !== 1) throw new CommandFailure("refused", "USAGE_INVALID", "--instance qualifies one service name, never a multi-service set");
    const allowed = new Set(["space", "instance", "yes", "dry-run", "json", "plain"]);
    if (Object.keys(args.values).some((name) => !allowed.has(name))) throw new CommandFailure("refused", "USAGE_INVALID", "named down accepts only space, instance, confirmation, preview and presentation flags; no whole-stack or manifest option was ignored");
    if (new Set(args.positionals).size !== args.positionals.length) throw new CommandFailure("refused", "USAGE_INVALID", "name each service once; duplicate targets were not silently collapsed");
    for (const name of args.positionals) validateServiceArguments({ ...args, positionals: ["stop", name] });
    return;
  }
  if (args.values.instance !== undefined) throw new CommandFailure("refused", "USAGE_INVALID", "--instance needs one explicit service definition name");
  if (controllerStackRecorded(cotalRoot())) return validateStackDownArguments(cotalRoot(), args.values);
  if (args.values["dry-run"] === true && args.values.yes === true) throw new CommandFailure("refused", "USAGE_INVALID", "--yes acknowledges a guarded apply, not a read-only stack preview");
  if ((args.values.json !== undefined || args.values.plain !== undefined) && args.values["dry-run"] === true && args.values.file === undefined && args.values.run === undefined && args.values["preserve-state"] === undefined && args.values["store-dir"] === undefined && args.values["session-store"] === undefined) return;
  if (args.values.yes !== undefined) throw new CommandFailure("refused", "UNSUPPORTED", "--yes applies only to a controller stack, and this root has none; a bare stop here needs no --yes, and nothing was stopped", { remedy: "run `cotal down` from this root without --yes" });
  if (args.values.json !== undefined || args.values.plain !== undefined) throw new CommandFailure("refused", "UNSUPPORTED", "--json and --plain apply only to a controller stack or a --dry-run preview; a bare stop here prints its own lines, and nothing was stopped", { remedy: "run `cotal down` from this root without --json or --plain; `cotal down --dry-run --json` reads this root's stack" });
}

/** A bare stack preview is a local record census, never an effect plan or stop authority. */
function previewWholeStack(args: ParsedArgs): void {
  const root = canonicalRoot(cotalRoot());
  const selectedSpace = args.values.space as string | undefined;
  const target = { root, ...(selectedSpace ? { space: selectedSpace } : {}) };
  if (root === canonicalRoot(homedir())) throw new CommandFailure("refused", "CONFLICT", "the machine home is not an isolated project root for a whole-stack preview", { target });
  let mesh: NonNullable<ReturnType<typeof findMesh>>;
  let maintenance: ReturnType<typeof readMaintenanceJournal>;
  let components: Array<{ name: string; label: string; pidfile: string; recorded: boolean; liveness: "alive" | "dead" | "unknown"; pid: number | null; note: string | null }>;
  let services: ReturnType<typeof readLocalServiceCensus>;
  let additiveRecords: ReturnType<typeof listLedgerFiles>, additiveAttempts: ReturnType<typeof listAdditiveTeamAttempts>;
  let bootAttempts: ReturnType<typeof listFreshTeamAttempts>, bootSummaries: ReturnType<typeof listFreshTeamSummaries>;
  let otherBrokerRegistrations: Array<{ space: string; root: string; origin: string }>;
  // A root with no control directory, or with no stack registered at it, holds no stack. That is a
  // plain miss, not records that could not be read.
  const noStack = () => new CommandFailure("refused", "TARGET_NOT_FOUND", "there is no stack at this folder's root, so there is nothing to preview", { target, remedy: "run `cotal down --dry-run` from the folder where `cotal up` started the stack" });
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
    additiveRecords = listLedgerFiles(root, { requireReadable: true });
    additiveAttempts = listAdditiveTeamAttempts(root);
    bootAttempts = listFreshTeamAttempts(root); bootSummaries = listFreshTeamSummaries(root);
  } catch (error) {
    if (error instanceof CommandFailure) throw error;
    throw new CommandFailure("refused", "CONFLICT", "the local stack, process or service records, or maintenance state could not be inspected consistently; no stop target was inferred", { target });
  }
  const byBootId = new Map(bootSummaries.valid.map((summary) => [summary.deploymentId, summary]));
  const unsettledBootAttempts = bootAttempts.valid.filter((attempt) => !freshTeamAttemptSettled(attempt, byBootId.get(attempt.deploymentId)));
  const result = { kind: "whole-stack-local-preview", space: mesh.space, root, recordedBroker: brokerAddressForDisplay(mesh.server) ?? null,
    maintenance: maintenance?.state ?? "none-recorded", withAgentsRequested: args.values["with-agents"] === true,
    components, ...services, otherBrokerRegistrations,
    additiveLedgers: additiveRecords.valid.map(({ ledger }) => ({ deploymentId: ledger.runId, space: ledger.space, agents: ledger.created.agents.length, channels: ledger.created.channels.length })),
    unreadableAdditiveLedgers: additiveRecords.refused.map(({ path }) => path),
    retainedAdditiveAttempts: additiveAttempts.valid.map((attempt) => ({ deploymentId: attempt.deploymentId, space: attempt.space, server: brokerAddressForDisplay(attempt.server) ?? "not displayable", createdAt: attempt.createdAt, recordedState: additiveTeamRecordedState(attempt, additiveAttempts) })),
    unreadableAdditiveAttempts: additiveAttempts.refused.map(({ path }) => path),
    unsettledBootAttempts: unsettledBootAttempts.map((attempt) => ({ deploymentId: attempt.deploymentId, space: attempt.space, server: brokerAddressForDisplay(attempt.server) ?? "not displayable", createdAt: attempt.createdAt })),
    unreadableBootRecords: [...bootAttempts.refused, ...bootSummaries.refused].map(({ path }) => path),
    brokerSharing: "exact recorded address matches only; aliases and live tenants not checked", agentImpact: "not-established", serviceInstanceScope: "selected-space workstation records only; root ownership and live state not established",
    dryRun: true, effectAttempted: false, reserved: false };
  writeResult(presentationOf(args.values), { command: "down", target: { root, space: mesh.space }, result,
    completeness: "partial", partial: { message: "Pidfiles, additive ledgers, service records, supervisor receipts and retained attempts are not a complete owned stack or native agent-impact plan. No process identity, service root ownership, broker sharing or stop authority was established." } }, (data): Report => ({ sections: [
    { title: "Whole-stack local inspection", blocks: [{ kind: "fields", rows: [["Space", data.space], ["Root", data.root], ["Maintenance", data.maintenance], ["Saved service definitions", String(data.serviceDefinitions.length)], ["Saved service instances", String(data.serviceRecords.length)], ["Supervisor receipts", String(data.supervisors.length)], ["Retained native attempts", String(data.nativeAttempts.length)], ["Other exact-address registrations", String(data.otherBrokerRegistrations.length)], ["Additive ledgers", String(data.additiveLedgers.length)], ["Unreadable additive ledgers", String(data.unreadableAdditiveLedgers.length)], ["Retained additive deployments", String(data.retainedAdditiveAttempts.length)], ["Unreadable additive attempts", String(data.unreadableAdditiveAttempts.length)], ["Unsettled fresh attempts", String(data.unsettledBootAttempts.length)], ["Unreadable fresh records", String(data.unreadableBootRecords.length)], ["Deprovision agents", data.withAgentsRequested ? "requested; impact unknown" : "not requested; process impact unknown"], ["Stop authority", "not established"]] }, { kind: "lines", lines: [{ text: "This is a read of local records, not a stop plan. Liveness does not prove identity, and service, broker-sharing and agent consequences are not checked. No process was signalled.", tone: "waiting" }] }] },
    { title: "Recorded broker address matches", blocks: [data.otherBrokerRegistrations.length ? { kind: "table", columns: [{ key: "space", label: "Other space" }, { key: "root", label: "Recorded root" }, { key: "origin", label: "Registration" }], rows: data.otherBrokerRegistrations.slice(0, 100) } : { kind: "lines", lines: ["No other registration uses this exact broker address in the local workstation registry."] }, { kind: "lines", lines: [...(data.otherBrokerRegistrations.length > 100 ? ["Additional exact-address matches are in JSON."] : []), "An exact-address match is a sharing warning. No match is not proof of an exclusive broker: aliases, remote tenants and live attachments were not checked."] }] },
    { title: "Recorded additive deployments", blocks: [data.additiveLedgers.length ? { kind: "table", columns: [{ key: "id", label: "Deployment" }, { key: "space", label: "Recorded space" }, { key: "agents", label: "Agent rows" }, { key: "channels", label: "Channel rows" }], rows: data.additiveLedgers.slice(0, 100).map((row) => ({ id: row.deploymentId, space: row.space, agents: String(row.agents), channels: String(row.channels) })) } : { kind: "lines", lines: ["No readable additive ledgers under this project root."] }, { kind: "lines", lines: [...(data.additiveLedgers.length > 100 ? ["Additional additive ledgers are in JSON."] : []), ...data.unreadableAdditiveLedgers.slice(0, 100).map((path) => `Unreadable ledger: ${path}`), ...(data.unreadableAdditiveLedgers.length > 100 ? ["Additional unreadable paths are in JSON."] : []), "An additive ledger is not whole-stack ownership. A recorded or unreadable one blocks the retained bare apply; this preview changes nothing."] }] },
    { title: "Retained additive deployments", blocks: [data.retainedAdditiveAttempts.length ? { kind: "table", columns: [{ key: "id", label: "Deployment" }, { key: "space", label: "Space" }, { key: "state", label: "Recorded state" }, { key: "time", label: "Intent recorded" }], rows: data.retainedAdditiveAttempts.slice(0, 100).map((attempt) => ({ id: attempt.deploymentId, space: attempt.space, state: attempt.recordedState, time: attempt.createdAt })) } : { kind: "lines", lines: ["No readable additive attempts under this root."] }, { kind: "lines", lines: [...data.unreadableAdditiveAttempts.slice(0, 100).map((path) => `Unreadable additive attempt: ${path}`), ...(data.retainedAdditiveAttempts.length > 100 || data.unreadableAdditiveAttempts.length > 100 ? ["Additional attempts or paths are in JSON."] : []), "Unsettled or unremoved additive deployments block the legacy bare stop. A full matched static agent-retirement receipt releases only its original deployment's blocker; all other ownership and process guards remain."] }] },
    { title: "Fresh boot attempts", blocks: [data.unsettledBootAttempts.length ? { kind: "table", columns: [{ key: "deploymentId", label: "Deployment" }, { key: "space", label: "Space" }, { key: "server", label: "Recorded broker" }, { key: "createdAt", label: "Intent recorded" }], rows: data.unsettledBootAttempts.slice(0, 100) } : { kind: "lines", lines: ["No unsettled readable fresh boot attempts under this root."] }, { kind: "lines", lines: [...data.unreadableBootRecords.slice(0, 100).map((path) => `Unreadable fresh record: ${path}`), ...(data.unsettledBootAttempts.length > 100 || data.unreadableBootRecords.length > 100 ? ["Additional attempts or unreadable paths are in JSON."] : []), "An unsettled fresh attempt or unreadable record blocks the retained bare apply; a missing summary does not prove the broker never started."] }] },
    { title: "Local process records", blocks: [data.components.length ? { kind: "table", columns: [{ key: "name", label: "Component" }, { key: "state", label: "Pidfile probe" }, { key: "record", label: "Recorded" }, { key: "pid", label: "PID" }], rows: data.components.map((row) => ({ name: row.label, state: row.liveness, record: row.recorded ? "yes" : "no", pid: row.pid === null ? "not pinned" : String(row.pid) })) } : { kind: "lines", lines: ["No local process descriptors were found."] }] },
    { title: "Selected-space service definitions", blocks: [data.serviceDefinitions.length ? { kind: "table", columns: [{ key: "name", label: "Definition" }, { key: "launch", label: "Launch type" }, { key: "instances", label: "Instance records" }], rows: data.serviceDefinitions.slice(0, 100).map((row) => ({ name: row.name, launch: row.launch, instances: String(row.instanceRecords) })) } : { kind: "lines", lines: ["No saved service definitions in this space's workstation store."] }, ...(data.serviceDefinitions.length > 100 ? [{ kind: "lines" as const, lines: ["Additional definitions are in JSON."] }] : [])] },
    { title: "Selected-space service instances", blocks: [data.serviceRecords.length ? { kind: "table", columns: [{ key: "definition", label: "Definition" }, { key: "instance", label: "Full instance" }, { key: "state", label: "Recorded state" }, { key: "host", label: "Recorded host" }], rows: data.serviceRecords.slice(0, 100).map((row) => ({ definition: row.definition, instance: row.instanceId, state: row.recordedState, host: row.host })) } : { kind: "lines", lines: ["No saved service instances in this space's workstation store."] }, { kind: "lines", lines: [...(data.serviceRecords.length > 100 ? ["Additional service records are in JSON."] : []), "These records are scoped by space, not proven owned by this project root. Their recorded state is not live process or supervisor status; no instance was selected for stopping."] }] },
    { title: "Recorded native supervisors", blocks: [data.supervisors.length ? { kind: "table", columns: [{ key: "definition", label: "Definition" }, { key: "instance", label: "Full instance" }, { key: "mechanism", label: "Mechanism" }, { key: "unit", label: "Recorded unit" }], rows: data.supervisors.slice(0, 100).map((row) => ({ definition: row.definition, instance: row.instanceId, mechanism: row.mechanism, unit: row.unit })) } : { kind: "lines", lines: ["No supervisor receipts in this space's workstation store."] }, { kind: "lines", lines: [...(data.supervisors.length > 100 ? ["Additional supervisor receipts are in JSON."] : []), "A receipt is not a live unit observation or authority to stop it. No native service status request was made."] }] },
    { title: "Retained native attempts", blocks: [data.nativeAttempts.length ? { kind: "table", columns: [{ key: "kind", label: "Action" }, { key: "definition", label: "Definition" }, { key: "instance", label: "Full instance" }, { key: "step", label: "Step" }, { key: "position", label: "Position" }], rows: data.nativeAttempts.slice(0, 100).map((row) => ({ kind: row.kind, definition: row.definition, instance: row.instanceId, step: row.step, position: row.position })) } : { kind: "lines", lines: ["No retained install, uninstall or unit-action attempts in this space's workstation store."] }, { kind: "lines", lines: [...(data.nativeAttempts.length > 100 ? ["Additional attempts and their full IDs are in JSON."] : []), "A submitted or unknown step may already have changed native state. This preview neither reconciles nor retries it."] }] },
  ] }));
}

/** Keep the retained pidfile sweep from crossing known service custody or an exact recorded
 *  broker-sharing boundary. This is not a complete live ownership or agent-impact proof. */
function guardLegacyBareDown(): void {
  const root = canonicalRoot(cotalRoot());
  const target = { root };
  if (root === canonicalRoot(homedir())) throw new CommandFailure("refused", "CONFLICT", "the machine home is not an isolated whole-stack stop root; no process was signalled", { target });
  let mesh: NonNullable<ReturnType<typeof findMesh>>;
  try {
    if (!realDirNoSymlink(root, ".cotal")) throw new Error("missing project control directory");
    // A root that hosts several spaces refuses before the registration lookup, naming them.
    try { assertSingleSpaceBroker(authDir(root), "bare down"); }
    catch (error) { throw new CommandFailure("refused", "CONFLICT", (error as Error).message, { target }); }
    const local = localMeshesForRoot(root), sole = local[0];
    if (local.length !== 1 || sole?.origin !== "up") throw new Error("no unique locally started stack at this root");
    mesh = sole;
  } catch (error) {
    if (error instanceof CommandFailure) throw error;
    throw new CommandFailure("refused", "CONFLICT", "the local root has no unique owned stack registration and real control directory; no whole-stack stop target was inferred", { target });
  }
  const scoped = { root, space: mesh.space };
  const maintenance = readMaintenanceJournal(root);
  // A validated active restore is complete, so its retained journal does not fence ordinary stop.
  // Pending transitions and a journal naming another space still cannot authorize this sweep.
  if (maintenance && (maintenance.state !== "active" || maintenance.space !== mesh.space)) throw new CommandFailure("refused", "LIFECYCLE_BLOCKED", "this stack retains a maintenance transition; ordinary bare down did not bypass it", { target: { ...scoped, state: maintenance.state } });
  let ledgers: ReturnType<typeof listLedgerFiles>;
  try { ledgers = listLedgerFiles(root, { requireReadable: true }); }
  catch { throw new CommandFailure("refused", "TARGET_UNAVAILABLE", "the root's additive ledger directory could not be inspected; bare down did not infer that it owns every resource", { target: scoped }); }
  if (ledgers.valid.length || ledgers.refused.length)
    throw new CommandFailure("refused", "LIFECYCLE_BLOCKED", "additive ownership ledgers or unreadable ledger records remain under this root; bare down did not adopt or stop their resources", { target: { ...scoped, deploymentIds: ledgers.valid.map(({ ledger }) => ledger.runId), unreadable: ledgers.refused.map(({ path }) => path) }, remedy: "finish each additive deployment's own lifecycle before a guarded whole-stack stop" });
  let additiveAttempts: ReturnType<typeof listAdditiveTeamAttempts>;
  try { additiveAttempts = listAdditiveTeamAttempts(root); }
  catch { throw new CommandFailure("refused", "TARGET_UNAVAILABLE", "the additive attempt inventory could not be read; bare down did not infer an empty resource set", { target: scoped }); }
  if (retainedAdditiveTeamAttempts(additiveAttempts).length || additiveAttempts.refused.length)
    throw new CommandFailure("refused", "LIFECYCLE_BLOCKED", "an additive attempt or returned additive deployment remains under this root; legacy bare down did not adopt its resources", { target: { ...scoped, deploymentIds: retainedAdditiveTeamAttempts(additiveAttempts).map((attempt) => attempt.deploymentId), unreadable: additiveAttempts.refused.map(({ path }) => path) } });
  let attempts: ReturnType<typeof listFreshTeamAttempts>, summaries: ReturnType<typeof listFreshTeamSummaries>;
  try { attempts = listFreshTeamAttempts(root); summaries = listFreshTeamSummaries(root); }
  catch { throw new CommandFailure("refused", "TARGET_UNAVAILABLE", "fresh boot attempt or summary records could not be read; bare down did not infer stop authority", { target: scoped }); }
  const returned = new Map(summaries.valid.map((summary) => [summary.deploymentId, summary]));
  const unsettled = attempts.valid.filter((attempt) => !freshTeamAttemptSettled(attempt, returned.get(attempt.deploymentId)));
  if (unsettled.length || attempts.refused.length || summaries.refused.length)
    throw new CommandFailure("refused", "LIFECYCLE_BLOCKED", "a fresh boot attempt is unsettled or a boot record unreadable; legacy bare down did not stop a process whose original launch outcome is unknown", { target: { ...scoped, unsettledIds: unsettled.map((row) => row.deploymentId), unreadable: [...attempts.refused, ...summaries.refused].map(({ path }) => path) }, remedy: "inspect the original boot and process custody before any stop; the pidfile sweep is not recovery" });
  const other = loadMeshes().filter((row) => row.space !== mesh.space && row.server === mesh.server);
  if (other.length) throw new CommandFailure("refused", "LIFECYCLE_BLOCKED", "another registered space names this exact broker address; bare down did not stop its shared listener", { target: { ...scoped, otherSpaces: other.map((row) => row.space) }, remedy: "inspect both registrations and their native ownership; an exact-address match is a blocker, while no match does not prove exclusivity" });
  const services = readLocalServiceCensus(mesh.space);
  if (services.serviceRecords.length || services.supervisors.length || services.nativeAttempts.length)
    throw new CommandFailure("refused", "LIFECYCLE_BLOCKED", "service-controller custody or a retained native attempt exists in this space; the legacy pidfile sweep did not stop its broker", { target: { ...scoped, instances: services.serviceRecords.map((row) => row.instanceId), supervisors: services.supervisors.map((row) => row.instanceId), attempts: services.nativeAttempts.map((row) => row.attemptId) }, remedy: "inspect the full service instances and attempts; whole-stack service-controller apply is not integrated" });
}

/** One named service is a thin native-controller alias. The retained bare-stack and manifest
 *  paths below have not yet been replaced by the approved whole-stack controller. */
export async function down(args: ParsedArgs): Promise<void> {
  validateDownArguments(args);
  if (args.positionals.length > 1) return stopNamedServiceSet(args);
  if (args.positionals.length) return service(namedStopArguments(args), "down");
  // A root whose stack the service controller owns stops only through its recorded members.
  if (controllerStackRecorded(cotalRoot())) return stackDown(cotalRoot(), args.values);
  const values = args.values as { file?: string; run?: string; "dry-run"?: boolean; "preserve-state"?: boolean; "with-agents"?: boolean; "store-dir"?: string; "session-store"?: string[]; space?: string };
  if (values["dry-run"] && !values.file && !values.run && !values["preserve-state"] && !values["store-dir"] && !values["session-store"]?.length) return previewWholeStack(args);
  if (values["preserve-state"] && values["with-agents"])
    throw new CommandFailure("refused", "USAGE_INVALID", "--preserve-state cannot be combined with --with-agents");
  if (values["with-agents"] && (values.file || values.run || values.space))
    throw new CommandFailure("refused", "USAGE_INVALID", "--with-agents is bare-whole-stack only and cannot be combined with components, --space, --file, or --run");
  if (values["preserve-state"]) {
    if (values.file || values.run || values["dry-run"] || values.space)
      throw new CommandFailure("refused", "USAGE_INVALID", "--preserve-state is bare-whole-stack only and cannot be combined with components, --space, --file, --run, or --dry-run");
    assertSingleSpaceBroker(authDir(cotalRoot()), "cotal down");
    await preserveStateDown(values["store-dir"], assertSessionStores(values["session-store"] ?? []));
    return;
  }
  if (values["store-dir"]) throw new CommandFailure("refused", "USAGE_INVALID", "--store-dir is only valid with down --preserve-state");
  if (values["session-store"]?.length) throw new CommandFailure("refused", "USAGE_INVALID", "--session-store is only valid with down --preserve-state");
  if ((values.file || values.run) && values.space) {
    throw new CommandFailure("refused", "USAGE_INVALID", "component names and --space cannot be combined with --file or --run");
  }
  if (values.file || values.run) {
    await downManifest(values.file ?? "<run>", { run: values.run, dryRun: Boolean(values["dry-run"]) });
    return;
  }
  if (values.space)
    throw new CommandFailure("refused", "USAGE_INVALID", "a bare stop takes no --space: `cotal down` stops the stack recorded at this folder's root", {
      target: { root: cotalRoot(), space: values.space },
      remedy: "run `cotal down` without --space from the stack's root; to stop one saved service, run `cotal service stop <service-name> --space <space>`",
    });
  guardLegacyBareDown();
  // Every dry run returned or was refused above, so from here on this is the whole-stack stop of
  // this folder's root.
  const selected = localProcessSurface()
    .sort((a, b) => Number(Boolean(a.stopLast)) - Number(Boolean(b.stopLast)) || (a.order ?? 50) - (b.order ?? 50));
  // A `down` that touches this folder's stack stops the shared broker and its per-space daemons;
  // none of them can address one space, so a multi-space root is refused up front rather than at
  // the space-blind pidfile lookup below.
  assertSingleSpaceBroker(authDir(cotalRoot()), "cotal down");
  let folderContext: LocalProcessContext | undefined;
  const folderCtx = (): LocalProcessContext => (folderContext ??= { root: cotalRoot(), space: resolveRuntimeSpace(process.cwd()) });

  let any = false;
  let allStopped = true;
  for (const component of selected) {
    any = processRecorded(component, folderCtx()) || any;
    if (component.stopLast && !allStopped) {
      console.error(c.red(`✗ not stopping ${component.label} because an earlier component did not stop`));
      continue;
    }
    try {
      const context = folderCtx();
      if (component.name === "manager") await stopManager(context.space, { withAgents: values["with-agents"] });
      else if (component.name === "delivery") await stopDelivery(context.space, { preserveCredentials: true });
      else await stopLocalProcess(component, context);
    } catch (e) {
      allStopped = false;
      console.error(c.red(`✗ ${(e as Error).message}`));
    }
  }
  if (!allStopped) {
    console.error(c.red("✗ not cleanly stopped - keeping artifacts and the registry entry"));
    process.exitCode = 1;
    return;
  }

  if (selected.some((component) => component.name === "delivery"))
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
  // with it.
  if (selected.some((component) => component.clearsMesh)) {
    rmSync(join(folderCtx().root, ".cotal", "run"), { recursive: true, force: true });
    removeMeshesByRoot(folderCtx().root);
  }
  if (!any) {
    console.error(c.red("Nothing running for the local stack (no recorded pidfiles)."));
    process.exit(1);
  }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
// The pid parser + liveness probe are the SHARED pid-attribution contract (`lib/pid.ts`), the same
// one `auth-proc` uses - so `cotal down`'s stop of the auth-service (a callout SIGNER) attributes a
// torn pidfile exactly as the direct helper does, instead of the old unbounded parser + two-state
// probe that mapped a kernel-unsignalable value to "dead" and orphaned the process under a clean
// stop. `isAlive` = the probe says the process EXISTS; every caller below feeds it a parsed pid.
export const isAlive = (pid: number): boolean => probeLiveness(pid) === "alive";

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

export function processAlive(component: LocalProcess, context: LocalProcessContext): boolean {
  const raw = readPidfile(localProcessPath(component.pidFile, context));
  if (raw === undefined) return false;
  const pid = parsePid(raw);
  return pid !== undefined && isAlive(pid);
}

/** Whether a component MIGHT still be running. It fails CLOSED on uncertainty. A component with NO
 *  pidfile, an EMPTY husk, or a valid pid PROVEN dead (ESRCH) is not running. ANY other state - an
 *  unparsable/unattributable record, or a valid pid that is alive or whose liveness cannot be
 *  confirmed (`unknown`) - MIGHT be running. `down --preserve-state` asks it to fence an uncertain
 *  delivery daemon, to treat an uncertain manager as alive, and to refuse to call a cut complete.
 *  `processAlive` collapses unparsable and `unknown` to "not alive", which is fine for "is it worth
 *  stopping" but WRONG for those questions: it would count a live auth signer behind a torn pidfile
 *  as stopped. Only an ESRCH-confirmed death (or no record) clears a component. */
export function mayBeRunning(component: LocalProcess, context: LocalProcessContext): boolean {
  const raw = readPidfile(localProcessPath(component.pidFile, context));
  if (!raw) return false; // no record, or an empty pre-protocol husk: no process behind it
  const pid = parsePid(raw);
  if (pid === undefined) return true; // unattributable content: cannot prove it gone → may be running
  return probeLiveness(pid) !== "dead"; // alive OR unknown → may be running; only ESRCH clears it
}

/** The principal keys of every retained agent in a preservation inventory — the dot-form ids that
 *  appear in the presence roster, so a caller can tell which retained agents are still live. */
export function retainedPrincipalKeys(inventory: unknown): Set<string> {
  const agents = ((inventory as { agents?: Array<{
    identity?: { mode?: string; id?: string; owner?: string; actor?: string };
  }> }).agents ?? []);
  return new Set(agents.map((agent) => {
    if (agent.identity?.mode === "user" && agent.identity.owner && agent.identity.actor)
      return principalKey(agent.identity.owner, agent.identity.actor).key;
    if (agent.identity?.id) return principalKey(DEV_OWNER, agent.identity.id).key;
    return undefined;
  }).filter((id): id is string => Boolean(id)));
}

/**
 * The operator's `--session-store` paths, resolved and proven to be directories.
 *
 * There is no default and nothing is inferred from a connector name: this repository does not know
 * where a harness keeps its transcript, and a guess recorded as a fact would produce a checkpoint
 * promising `exact` over bytes nobody chose. A path that does not exist or is not a directory is
 * refused HERE, before a single process is stopped, because a cut that discovers it after the stack
 * is down costs the operator the whole cut.
 */
function assertSessionStores(paths: readonly string[]): string[] {
  return paths.map((path) => {
    const resolved = resolvePath(path);
    let stat;
    try {
      stat = statSync(resolved);
    } catch (error) {
      throw new CommandFailure("refused", "USAGE_INVALID", `--session-store ${resolved} cannot be read (${(error as NodeJS.ErrnoException).code ?? (error as Error).message}); name the harness transcript store directory for this host`);
    }
    if (!stat.isDirectory())
      throw new CommandFailure("refused", "USAGE_INVALID", `--session-store ${resolved} is not a directory; name the harness transcript store directory for this host`);
    return resolved;
  });
}

async function preserveStateDown(storeOverride?: string, sessionStores: readonly string[] = []): Promise<void> {
  const root = cotalRoot();
  const matching = loadMeshes().filter((mesh) => mesh.root === root);
  if (matching.length !== 1)
    throw new CommandFailure("refused", matching.length ? "TARGET_AMBIGUOUS" : "TARGET_NOT_FOUND", `down --preserve-state requires exactly one recorded mesh for this root; found ${matching.length}, and nothing was stopped`, { target: { root, spaces: matching.map((mesh) => mesh.space) } });
  const mesh = matching[0];
  const storeDir = storeOverride ? resolveStore(storeOverride) : join(root, ".cotal", "nats");
  // The store cap the broker was started with travels with the store, so the resume re-renders it.
  const cap: { maxFileStore?: number } = mesh.maxFileStore !== undefined ? { maxFileStore: mesh.maxFileStore } : {};
  const lock = acquireMaintenanceLock(root);
  try {
    const additiveAttempts = listAdditiveTeamAttempts(root);
    if (retainedAdditiveTeamAttempts(additiveAttempts).length || additiveAttempts.refused.length) throw new CommandFailure("refused", "LIFECYCLE_BLOCKED", "an additive attempt or returned additive deployment remains; preserve-state down did not fold its resources into the retained stack", { target: { root, space: mesh.space, deploymentIds: retainedAdditiveTeamAttempts(additiveAttempts).map((attempt) => attempt.deploymentId), unreadable: additiveAttempts.refused.map(({ path }) => path) } });
    const all = localProcessSurface();
    const context: LocalProcessContext = { root, space: mesh.space };
    const existing = readMaintenanceJournal(root);
    if (existing && existing.state !== "cut-intent" && existing.state !== "cut-committed" && existing.state !== "ready")
      throw new Error(`cannot preserve while maintenance state is ${existing.state}`);
    if (existing && (existing.space !== mesh.space || existing.mode !== mesh.mode ||
        !sameStoreIdentity(existing.source, readStoreIdentity(storeDir)) || existing.cut.launch.server !== mesh.server))
      throw new Error(`preservation retry ${existing.cut.attemptId} does not match the current mesh launch`);
    if (existing?.state === "ready") {
      await waitForEndpointUnreachable(mesh.server);
      console.log(c.dim(`state for "${mesh.space}" is already preserved and offline`));
      return;
    }

    let attemptId: string;
    let resume;
    // Set when recovery force-commits a cut whose manager died AFTER stopping children (commit-intent
    // present): the shared commit block below is then skipped — the cut is already committed.
    let managerCommitJournaled = false;
    if (existing?.state === "cut-intent" || existing?.state === "cut-committed") {
      attemptId = existing.cut.attemptId;
      resume = existing.resume;
      if (existing.state === "cut-intent") {
        // A cut-intent retry must not depend on volatile manager memory: re-prepare the SAME
        // attempt (idempotent on the fenced manager, a fresh fence on a restarted one) and prove
        // the re-prepared inventory is byte-identical to the journaled resume document.
        const manager = all.find((component) => component.name === "manager");
        if (!manager) throw new Error("local process registry has no manager descriptor");
        if (!mayBeRunning(manager, context)) { // fail-closed: an uncertain manager is treated as alive, not dead
          const committing = readPreservationCommitIntent(root);
          if (!committing || committing.attemptId !== attemptId) {
            // No commit intent recorded: the child-stopping RPC was never invoked, so nothing was
            // stopped with suppression. Safe to abandon instead of wedging.
            abortMaintenanceCut(lock);
            clearPreservationPrepareIntent(lock);
            throw new Error(`preservation attempt ${attemptId} lost its manager before commit; the cut intent was aborted - heal the stack with \`cotal up\` if needed, then rerun \`cotal down --preserve-state\``);
          }
          // Commit intent is durable: the manager was asked to stop its children and may already have
          // done so. Deleting the cut here would lose the retained inventory (this was the bug). While
          // the broker outlives the manager in this window, confirm no retained principal is still live
          // before finishing forward; if the broker is already gone we cannot check, but preserving the
          // cut still beats deleting it. Then journal cut-committed and finish WITHOUT the dead manager.
          if (await isReachable(mesh.server)) {
            const retained = retainedPrincipalKeys(readMaintenanceResumeDocument(root, existing.resume).inventory);
            if (retained.size) {
              const stillLive = (await readPresenceWithoutConsumer(mesh.space, mesh.server))
                .roster.filter((presence) => retained.has(presence.card.id)).map((presence) => presence.card.id);
              if (stillLive.length)
                throw new Error(`preservation attempt ${attemptId} lost its manager mid-commit and ${stillLive.length} retained principal(s) are still live (${stillLive.join(", ")}); the cut intent is PRESERVED for inspection - stop them, then rerun \`cotal down --preserve-state\``);
            }
          }
          recordPreservationManagerCommit(lock, { operation: "commitPreservation", attemptId, state: "preserved" });
          clearPreservationCommitIntent(lock);
          clearPreservationPrepareIntent(lock);
          managerCommitJournaled = true;
        }
        if (!managerCommitJournaled) {
        const retryTarget = await resolveControlTarget({ space: mesh.space, server: mesh.server }, "control-caller-admin");
        // Plane-3 fence precedes the re-prepared inventory, exactly as on the fresh path.
        const retryDelivery = all.find((component) => component.name === "delivery");
        if (retryDelivery && mayBeRunning(retryDelivery, context)) await stopLocalProcess(retryDelivery, context); // fence an uncertain delivery too (stopLocalProcess throws loud on unattributable → abort)
        const reprepared = await askManager(retryTarget.space, retryTarget.server, "preparePreservation", { attemptId }, retryTarget.auth, "any", 60_000);
        const replan = reprepared.ok ? reprepared.data as { inventory?: unknown; failures?: unknown[]; state?: string } : undefined;
        if (!replan?.inventory || (replan.failures?.length ?? 0) !== 0 || (replan.state !== "prepared" && replan.state !== "preserved"))
          throw new Error(reprepared.error ?? "manager could not re-prepare the recorded preservation attempt");
        try {
          writeMaintenanceResumeDocument(lock, {
            version: MAINTENANCE_RESUME_DOCUMENT_VERSION,
            inventory: replan.inventory as JsonValue,
            launch: { attemptId, space: mesh.space, server: mesh.server, storeDir, ...cap, mode: mesh.mode },
          });
        } catch (cause) {
          // A restarted manager prepared a DIFFERENT inventory: the journaled cut no longer
          // matches reality. Release its fence and abandon the stale intent; a rerun cuts fresh.
          try {
            await askManager(retryTarget.space, retryTarget.server, "abortPreservation", { attemptId }, retryTarget.auth, "any", 30_000);
          } catch { /* best effort - the fence dies with the manager */ }
          abortMaintenanceCut(lock);
          clearPreservationPrepareIntent(lock);
          throw new Error(`preservation attempt ${attemptId} no longer matches its manager's inventory (${(cause as Error).message}); the stale cut intent was aborted - rerun \`cotal down --preserve-state\``);
        }
        }
      }
    } else {
      // The attempt binding is durable BEFORE the manager is fenced: a crash between manager
      // preparation and the cut-intent journal retries with the exact attempt the manager holds.
      const intent = readPreservationPrepareIntent(root);
      if (intent) {
        if (intent.space !== mesh.space || intent.mode !== mesh.mode || intent.server !== mesh.server || intent.storeDir !== storeDir)
          throw new Error(`preservation prepare intent ${intent.attemptId} does not match the current mesh launch; inspect .cotal/maintenance before retrying`);
        attemptId = intent.attemptId;
      } else {
        attemptId = `preserve-${Date.now()}-${process.pid}`;
        writePreservationPrepareIntent(lock, {
          attemptId, space: mesh.space, mode: mesh.mode, server: mesh.server, storeDir,
        });
      }
      const target = await resolveControlTarget({ space: mesh.space, server: mesh.server }, "control-caller-admin");
      // Fence Plane 3 BEFORE any inventory work: with the delivery daemon stopped, no durable
      // join/leave can mutate MEMBERS at or after the moment the inventory is taken.
      const delivery = all.find((component) => component.name === "delivery");
      if (delivery && mayBeRunning(delivery, context)) await stopLocalProcess(delivery, context); // fence an uncertain delivery: no MEMBERS mutation may race the inventory
      const prepared = await askManager(
        target.space,
        target.server,
        "preparePreservation",
        { attemptId },
        target.auth,
        "any",
        60_000,
      );
      let plan: { inventory?: unknown; failures?: unknown[]; state?: string } | undefined;
      try {
        if (!prepared.ok) throw new Error(prepared.error ?? "manager preservation prepare failed");
        plan = prepared.data as { inventory?: unknown; failures?: unknown[]; state?: string } | undefined;
        if (!plan?.inventory || (plan.failures?.length ?? 0) !== 0 || (plan.state !== "prepared" && plan.state !== "preserved"))
          throw new Error("manager returned an invalid or incomplete preservation plan");
        const retainedPrincipals = retainedPrincipalKeys(plan.inventory);
        let observed = await readPresenceWithoutConsumer(mesh.space, mesh.server);
        retainedPrincipals.add(observed.managerId);
        let unmanaged = observed.roster.filter((presence) => !retainedPrincipals.has(presence.card.id));
        if (unmanaged.length) {
          await sleep(11_000); // Let stopped predecessor presence and manager leases expire before refusing.
          observed = await readPresenceWithoutConsumer(mesh.space, mesh.server);
          retainedPrincipals.add(observed.managerId);
          unmanaged = observed.roster.filter((presence) => !retainedPrincipals.has(presence.card.id));
        }
        if (unmanaged.length)
          throw new Error(`cannot preserve while unmanaged endpoints are live: ${unmanaged.map((presence) => `${presence.card.name} (${presence.card.id})`).join(", ")} (manager lease holder: ${observed.managerId})`);
        // A seat that cannot be checkpointed is refused HERE, at prepare time, while every child is
        // still running. This reads only the prepared inventory, so it needs nothing that stopping
        // would provide, and refusing after the stack is down would cost the operator a running mesh
        // to tell them the cut was never going to complete.
        assertSeatsCheckpointable(plan.inventory);
      } catch (cause) {
        // A refused prepare (or a live-unmanaged / uncheckpointable refusal) must not leave the
        // manager fenced in "preserving" mode with no running preservation to finish: abort the
        // attempt (best effort, the same shape as the stale-inventory retry above) and clear the
        // intent, so the operator is left with a running, unfenced mesh and the refusal reason.
        try {
          await askManager(target.space, target.server, "abortPreservation", { attemptId }, target.auth, "any", 30_000);
        } catch { /* best effort - the fence dies with the manager */ }
        clearPreservationPrepareIntent(lock);
        throw cause;
      }
      resume = writeMaintenanceResumeDocument(lock, {
        version: MAINTENANCE_RESUME_DOCUMENT_VERSION,
        inventory: plan.inventory as JsonValue,
        launch: {
          attemptId,
          space: mesh.space,
          server: mesh.server,
          storeDir,
          ...cap,
          mode: mesh.mode,
        },
      });
      beginMaintenanceCut(lock, {
        attemptId,
        space: mesh.space,
        mode: mesh.mode,
        sourcePath: storeDir,
        resume,
        launch: { server: mesh.server, storeDir, ...cap },
      });
      clearPreservationPrepareIntent(lock);
    }

    // Stop the children through the manager, then journal cut-committed. A commit-intent marker is
    // written FIRST (the stop RPC is about to execute) and cleared once cut-committed is durable, so a
    // crash in the gap leaves proof the stop may already have run — recovery finishes forward instead
    // of deleting the cut. `managerCommitJournaled` means a dead-manager recovery already committed above.
    if (existing?.state !== "cut-committed" && !managerCommitJournaled) {
      const manager = all.find((component) => component.name === "manager");
      if (!manager) throw new Error("local process registry has no manager descriptor");
      // This one DELIBERATELY keeps `processAlive` (provably alive), not `mayBeRunning`: here we must
      // USE the manager to prove every retained child stopped, so anything short of provably-alive -
      // dead OR uncertain - must fail closed and preserve the cut. `processAlive` already returns
      // false on `unknown`, so an uncertain manager throws here rather than being trusted to attest.
      if (!processAlive(manager, context))
        throw new Error("cannot complete preservation because the attempt-bound manager is not alive to prove every retained child stopped; recovery must preserve the cut-intent journal for inspection");
      // Fault window: cut-intent journaled but the child-stopping RPC not yet invoked (no commit
      // intent). A crash here is genuinely pre-commit — recovery MUST still abort, not finish forward.
      if (process.env.COTAL_SMOKE_EXIT_AFTER_CUT_INTENT_BEFORE_COMMIT === "1") process.exit(93);
      writePreservationCommitIntent(lock, { attemptId });
      const target = await resolveControlTarget({ space: mesh.space, server: mesh.server }, "control-caller-admin");
      const commit = await askManager(
        target.space,
        target.server,
        "commitPreservation",
        { attemptId },
        target.auth,
        "any",
        120_000,
      );
      if (!commit.ok) throw new Error(commit.error ?? "manager preservation commit was incomplete");
      const result = commit.data as { state?: string; failures?: unknown[] } | undefined;
      if (result?.state !== "preserved" || (result.failures?.length ?? 0) !== 0)
        throw new Error("manager could not prove every retained child stopped");
      // Fault window: the manager has COMMITTED (children stopped, preservation irreversible) but the
      // coordinator has not yet journaled cut-committed. A crash here leaves the journal at cut-intent
      // WITH the commit-intent marker set — the exact window recovery must not treat as pre-commit.
      if (process.env.COTAL_SMOKE_EXIT_AFTER_MANAGER_STOP_BEFORE_JOURNAL === "1") process.exit(92);
      recordPreservationManagerCommit(lock, { operation: "commitPreservation", attemptId, state: "preserved" });
      clearPreservationCommitIntent(lock);
      if (process.env.COTAL_SMOKE_EXIT_AFTER_PRESERVATION_MANAGER_COMMIT === "1") process.exit(90);
    }

    const rank = (component: LocalProcess): number => {
      if (component.name === "delivery") return 20;
      if (component.name === "manager") return 30;
      if (component.name === "auth") return 40;
      if (component.stopLast) return 100;
      return 10;
    };
    const ranked = [...all].sort((a, b) => rank(a) - rank(b) || (a.order ?? 50) - (b.order ?? 50));
    // The quiescence proof runs BETWEEN two stop phases. Everything it proves dead — the
    // lease-holding daemons, delivery and manager — stops before it. The user-auth service holds no
    // lease, so the proof does not cover it, and on a USER mesh the proof's own broker connect
    // exchanges through that service: stop it first and the cut can no longer prove itself, ending
    // at cut-committed with the broker still up. It stops after the proof, still before the broker.
    const afterQuiescence = (component: LocalProcess): boolean => component.stopLast || component.name === "auth";
    for (const component of ranked.filter((component) => !afterQuiescence(component)))
      await stopLocalProcess(component, context);
    // Wire-truth quiescence while the broker still answers: every control-plane daemon must be
    // provably lease-dead, not merely pidfile-absent, before the broker stops and ready publishes.
    // An already-unreachable broker is itself the proof - nothing can mutate broker-resident state
    // through a dead endpoint, and the final unreachable check below re-verifies it.
    if (await isReachable(mesh.server)) await assertControlPlaneQuiesced(mesh.space, mesh.server);
    // rank() keeps auth (40) ahead of the broker (stopLast, 100) within this phase.
    for (const component of ranked.filter(afterQuiescence))
      await stopLocalProcess(component, context);
    // Fail-closed: a component we cannot PROVE stopped (unattributable/unknown pidfile) leaves the
    // cut partial - it must not be silently counted as gone, or `unknown` becomes a "successful cut".
    const stillRunning = all.filter((component) => mayBeRunning(component, context));
    if (stillRunning.length)
      throw new Error(`preservation cut is partial; still running (or liveness unconfirmed): ${stillRunning.map((component) => component.name).join(", ")}`);
    await waitForEndpointUnreachable(mesh.server);
    // Step 7 and 8 of the cut. ONLY here: the manager has proven every child exited
    // (`commitPreservation` above returned state "preserved" with no failures) and the whole stack
    // is down, so nothing is writing to a working tree or a transcript. A capture any earlier races
    // the harness by construction.
    const captured = await captureSeatCheckpoints(root, mesh.space, resume, seatCheckpointDir(root, attemptId), sessionStores);
    completeMaintenanceCut(lock, {
      attemptId,
      observedAt: new Date().toISOString(),
      managerCommit: { operation: "commitPreservation", attemptId, state: "preserved" },
      stopped: { manager: true, broker: true, localProcesses: true },
      listener: { endpoint: mesh.server, unreachable: true },
    });
    console.log(c.green(`✓ preserved state for "${mesh.space}"`));
    console.log(c.dim(`  source: ${storeDir}`));
    console.log(c.dim(`  resume inventory: ${join(root, ".cotal", "maintenance", "v1", resume.file)}`));
    for (const seat of captured)
      console.log(c.dim(`  checkpoint: ${seat.name} (${seat.session.continuity}, generation ${seat.generation}) -> ${join(seatCheckpointDir(root, attemptId), seat.name)}`));
    console.log(c.dim("  stack remains stopped; create a backup or deliberately resume with `cotal up`"));
  } finally {
    releaseMaintenanceLock(lock);
  }
}

/**
 * Refuse any seat the cut could not checkpoint, from the prepared inventory alone.
 *
 * Called at prepare time, before a single child is stopped. The capture itself must wait until the
 * stack is proven down, but the DECISION about whether a capture is possible reads only the
 * inventory, so it belongs where the operator still has a running mesh.
 *
 * A seat the manager would refuse to resume is refused here too, with the manager's own wording:
 * `Manager.inventoryReferenceError` says `imperative launch options have no non-secret durable
 * source`, and a checkpoint inherits that refusal rather than writing something that will not
 * reproduce the seat.
 */
export function assertSeatsCheckpointable(inventory: unknown): void {
  for (const entry of ((inventory as { agents?: ManagerResumeAgentShape[] }).agents ?? [])) {
    const keys = entry.launch?.unresolvedLaunchOptionKeys ?? [];
    if (keys.length)
      throw new Error(`imperative launch options have no non-secret durable source (${keys.join(", ")}): seat ${entry.name} cannot be checkpointed`);
    if (!entry.launch?.cwd) throw new Error(`seat ${entry.name} has no launch cwd to capture`);
  }
}

/** Capture one checkpoint per retained seat, after the cut has proven the whole stack down. */
export async function captureSeatCheckpoints(
  root: string,
  space: string,
  resume: MaintenanceResumeDescriptor,
  destination: string,
  sessionStores: readonly string[],
): Promise<SeatCheckpoint[]> {
  const document = readMaintenanceResumeDocument(root, resume);
  const inventory = document.inventory as { agents?: ManagerResumeAgentShape[] } | undefined;
  const agents = inventory?.agents ?? [];
  const sealed: SeatCheckpoint[] = [];
  for (const entry of agents) {
    // Re-asserted over the document that was actually written, not the plan read at prepare time.
    assertSeatsCheckpointable({ agents: [entry] });
    const cwd = entry.launch.cwd as string;
    // The generation this cut is taken at, from what this host holds. A destination claims the
    // successor by exclusive create before it launches anything.
    const held = loadSeatWriterGeneration(root, space, entry.name);
    const connector = await connectorCapabilities(entry.launch.connector);
    // The store is applied to every CONTINUATION-CAPABLE seat and to no other. A connector that
    // does not reopen a session has nothing to reopen it from, and carrying a transcript for it
    // would put harness bytes in an artifact that can never use them.
    const carriesSession = Boolean(connector?.supportsSessionContinuation);
    sealed.push(captureSeatCheckpoint(join(destination, entry.name), entry, {
      cwd,
      space,
      name: entry.name,
      lifecycleUid: entry.identity.lifecycleUid,
      generation: held?.generation ?? 0,
      workspaceRoot: root,
      profile: {
        configSha256: entry.launch.source.configSha256,
        ...(entry.launch.source.manifestSha256 ? { manifestSha256: entry.launch.source.manifestSha256 } : {}),
        ...(entry.launch.source.hash ? { hash: entry.launch.source.hash } : {}),
      },
      connector,
      ...(entry.launch.sessionId ? { sessionId: entry.launch.sessionId } : {}),
      ...(carriesSession && entry.launch.sessionStatePath ? { sessionStatePath: entry.launch.sessionStatePath } : {}),
      ...(carriesSession && sessionStores.length ? { sessionStorePaths: sessionStores } : {}),
    }));
  }
  return sealed;
}

/** Resolve a connector's DECLARED capabilities. An unresolvable connector is `undefined`, which
 *  `sessionContinuityClass` reads as drain-only: unknown capabilities are default-deny and no
 *  continuation promise may be inferred from a package name or a host-local probe. */
async function connectorCapabilities(name: string): Promise<Pick<Connector, "supportsResume" | "supportsSessionContinuation" | "supportsFreshStart"> | undefined> {
  try {
    return await materializeFromManifest<Connector>({ kind: "connector", name });
  } catch {
    return undefined;
  }
}

function resolveStore(path: string): string {
  const resolved = path.startsWith("/") ? path : join(process.cwd(), path);
  return resolved;
}

/** Direct Get one KV subject's last value without creating any consumer. `allowEmpty` treats a
 *  DEL/PURGE tombstone as absence instead of an error. */
async function directKvValue<T>(
  nc: NatsConnection,
  stream: string,
  subject: string,
  allowEmpty = false,
): Promise<T | undefined> {
  const response = await nc.request(
    `$JS.API.STREAM.MSG.GET.${stream}`,
    JSON.stringify({ last_by_subj: subject }),
    { timeout: 5_000 },
  );
  const body = JSON.parse(new TextDecoder().decode(response.data)) as {
    message?: { data?: string; hdrs?: string };
    error?: { description?: string };
  };
  if (body.error) throw new Error(`maintenance inventory read failed: ${body.error.description ?? "JetStream error"}`);
  if (!body.message?.data) {
    const headers = body.message?.hdrs ? Buffer.from(body.message.hdrs, "base64").toString("utf8") : "";
    if (allowEmpty && /^KV-Operation:\s*(?:DEL|PURGE)\s*$/im.test(headers)) return undefined;
    throw new Error(`maintenance inventory is missing ${subject}`);
  }
  return JSON.parse(Buffer.from(body.message.data, "base64").toString("utf8")) as T;
}

/** Wire-truth control-plane quiescence: a live manager/delivery daemon renews its lease
 *  continuously, so the cut publishes `ready` only once BOTH lease buckets hold no live value —
 *  a dead daemon's lease expires by TTL, a pidless live one keeps renewing and is refused here.
 *  Pidfiles are hints; leases are proof. */
export async function assertControlPlaneQuiesced(space: string, server: string): Promise<void> {
  const resolved = await connectOrExit({ space, server }, "deployer");
  const user = resolved.bearer ? await userViewAuthOrExit(resolved, "deployer") : undefined;
  const nc = await dialerFor(server)({
    servers: server,
    ...standaloneConnectOpts({ ...(user ?? { creds: resolved.creds }), tls: resolved.tls }),
    maxReconnectAttempts: 0,
  });
  try {
    const jsm = await jetstreamManager(nc);
    const liveKeys = async (bucket: string): Promise<string[]> => {
      let subjects: string[];
      try {
        const info = await jsm.streams.info(`KV_${bucket}`, { subjects_filter: `$KV.${bucket}.>` });
        subjects = Object.keys(info.state.subjects ?? {});
      } catch (error) {
        if (/stream not found/i.test((error as Error).message)) return [];
        throw error;
      }
      const live: string[] = [];
      for (const subject of subjects) {
        if (await directKvValue(nc, `KV_${bucket}`, subject, true) !== undefined) live.push(subject);
      }
      return live;
    };
    const deadline = Date.now() + Math.max(LEASE_TTL_MS, MANAGER_LEASE_TTL_MS) + 5_000;
    for (;;) {
      const deliveryLive = await liveKeys(deliveryBucket(space));
      const managerLive = await liveKeys(managerBucket(space));
      if (deliveryLive.length === 0 && managerLive.length === 0) return;
      if (Date.now() >= deadline)
        throw new Error(`control-plane leases are still live past their TTL (delivery: ${deliveryLive.length}, manager: ${managerLive.length}); a pidless daemon may still be running - the cut refuses to publish ready`);
      await sleep(500);
    }
  } finally {
    await nc.drain().catch(() => {});
  }
}

/** Read current KV subjects by Direct Get so the cut check leaves no ephemeral/native consumer.
 *
 *  Exported for the gated tombstone cell. A regression test for the lease walk has to run through
 *  THIS function, not a transcription of it: a copy carries its own `allowEmpty` parameter, so it
 *  stays green when the argument at the real call site is removed and proves nothing about the fix. */
export async function readPresenceWithoutConsumer(space: string, server: string): Promise<{ roster: Presence[]; managerId: string }> {
  const resolved = await connectOrExit({ space, server }, "deployer");
  const user = resolved.bearer ? await userViewAuthOrExit(resolved, "deployer") : undefined;
  const nc = await dialerFor(server)({
    servers: server,
    ...standaloneConnectOpts({ ...(user ?? { creds: resolved.creds }), tls: resolved.tls }),
    maxReconnectAttempts: 0,
  });
  try {
    const directValue = async <T>(stream: string, subject: string, allowEmpty = false): Promise<T | undefined> =>
      directKvValue<T>(nc, stream, subject, allowEmpty);
    const bucket = presenceBucket(space);
    const stream = `KV_${bucket}`;
    const prefix = `$KV.${bucket}.`;
    const info = await (await jetstreamManager(nc)).streams.info(stream, { subjects_filter: `${prefix}>` });
    const roster: Presence[] = [];
    for (const subject of Object.keys(info.state.subjects ?? {})) {
      const presence = await directValue<unknown>(stream, subject, true);
      if (presence === undefined) continue; // A positively identified KV tombstone has no value bytes.
      if (!isPresenceRow(presence, subject.slice(prefix.length))) throw new Error(`presence record ${subject} is malformed`);
      roster.push(presence);
    }
    // ENUMERATE THE PER-INSTANCE LEASE KEYS. P2 item 3 demoted this bucket from a single `lease` key to
    // one `lease.<instanceId>` per manager, and NOTHING WRITES THE BARE PREFIX ANY MORE — the supervisor's
    // grant is `$KV.<bucket>.lease.*`, which does not even cover it, so no writer can legalise it. Reading
    // the bare subject threw inside `directKvValue` on every preserve-state cut, which meant the holder
    // guard on the next line was unreachable and the operator saw "maintenance inventory read failed"
    // instead. Same STREAM.INFO + point-get shape as `liveKeys` above: no consumer, no new grant.
    const leaseBucket = managerBucket(space);
    const leaseStream = `KV_${leaseBucket}`;
    // `lease.*`, not `lease.>`: `managerLeaseKey` is contractually ONE lowercase-alnum token, so `*`
    // matches exactly the key space that can exist while `>` would additionally admit a malformed
    // multi-token key. Matches `readManagerLease`'s filter — two probes of one bucket disagreeing on
    // their wildcard is drift the next reader has to adjudicate from scratch.
    const leaseInfo = await (await jetstreamManager(nc)).streams.info(leaseStream, { subjects_filter: `$KV.${leaseBucket}.${MANAGER_LEASE_KEY}.*` });
    let lease: ManagerLeaseInfo | undefined;
    for (const subject of Object.keys(leaseInfo.state.subjects ?? {})) {
      // `allowEmpty` MUST be true here. STREAM.INFO lists tombstoned subjects, so a cleanly stopped
      // manager's released key is in this walk; without it `directKvValue` THROWS on the tombstone
      // instead of returning undefined, and the cut dies naming a dead manager's key before a live
      // holder later in the list is ever examined. `Object.keys` order decides whether it fires, so
      // it is a coin flip on exactly the clean-stop scenario. Both sibling walks in this function
      // (`liveKeys`, the presence roster) already pass true; this one was copied from them without it.
      const held = await directValue<ManagerLeaseInfo>(leaseStream, subject, true);
      if (held?.holder) { lease = held; break; }
    }
    if (!lease?.holder) throw new Error("manager lease has no authoritative holder principal");
    return { roster, managerId: parsePrincipalKey(lease.holder) ? lease.holder : principalKey(DEV_OWNER, lease.holder).key };
  } finally {
    await nc.drain().catch(() => {});
  }
}

/** Whether a decoded presence value carries a `card.id` equal to the KV `key` it was read under,
 *  which the cut matches against the retained principals, and the string `card.name` its refusal
 *  names. A participant may write any value under its own key, so only the key is the identity its
 *  write grant proves. A value that fails refuses the inventory: reading it as absent would drop a
 *  live participant from the unmanaged-endpoints refusal. */
function isPresenceRow(value: unknown, key: string): value is Presence {
  if (typeof value !== "object" || value === null) return false;
  const card = (value as { card?: unknown }).card;
  if (typeof card !== "object" || card === null) return false;
  const { id, name } = card as { id?: unknown; name?: unknown };
  return id === key && typeof name === "string";
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
    ...every("auth-service.{space}.pid", "user-auth service"),
    ...every(WEB_PIDFILE, "web dashboard"),
    ...every("nats.pid", "nats-server"),
  ];
}

/** `liveness` keeps `probeLiveness`'s three states so each caller picks its direction: a presence
 *  reader requires `"alive"`, a destructive guard proceeds only on `"dead"`. No record and an empty
 *  husk are `"dead"`; unattributable content and a removal reservation are `"unknown"`, because
 *  `cotal down` refuses them as possibly fronting a live process. */
export type PidfileState = { pid?: number; liveness: "alive" | "dead" | "unknown"; note?: string };

/** Shared hardened pid probe: positive integers only, and EPERM means the process exists. */
export function pidfileState(path: string): PidfileState {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8").trim();
  } catch (e) {
    // A process removes its own record on exit, so the file can be gone by the time it is read.
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return { liveness: "dead", note: "no pidfile" };
    throw e;
  }
  if (raw.startsWith("removing:")) return { liveness: "unknown", note: "extension removal in progress" };
  const pid = parsePid(raw);
  if (!pid) return { liveness: raw ? "unknown" : "dead", note: "bad pidfile" };
  const liveness = probeLiveness(pid);
  if (liveness === "alive") return { pid, liveness };
  return { pid, liveness, note: liveness === "dead" ? "stale pidfile" : "liveness unknown" };
}
