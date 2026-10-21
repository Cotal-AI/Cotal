import { homedir } from "node:os";
import { isAbsolute, resolve } from "node:path";
import { isReachable, realDirNoSymlink, type CompletionResult, type FlagSpec, type ParsedArgs } from "@cotal-ai/core";
import { assertSingleSpaceBroker, authDir, brokerAddressForDisplay, canonicalRoot, CommandFailure, jsonFlag, loadMeshes, localMeshesForRoot, plainFlag, presentationOf, readMaintenanceJournal, writeResult, type Report } from "@cotal-ai/workspace";
import { liveMeshProcesses, safeStoreCleanupPath } from "./clean.js";
import { assertResetEligible, resetStoreApply, selectResetTarget } from "./reset-store-apply.js";
import { instanceProjection, serviceInstances } from "../lib/service-instances.js";
import { readLocalServiceCensus } from "../lib/service-census.js";
import { listLedgerFiles } from "../lib/manifest/ledger.js";
import { freshTeamAttemptSettled, listFreshTeamAttempts, listFreshTeamSummaries } from "../lib/team-fresh.js";
import { additiveTeamRecordedState, listAdditiveTeamAttempts } from "../lib/team-additive-attempt.js";

export const resetFlags = [jsonFlag, plainFlag,
  { name: "dry-run", type: "boolean", description: "inspect local store, maintenance and process records without deleting anything" },
  { name: "yes", short: "y", type: "boolean", description: "confirm the exact named stopped-store or local-identity reset in a script; not accepted with a preview" },
] as const satisfies readonly FlagSpec[];

export function resetComplete(argv: string[]): CompletionResult {
  if (argv.length <= 1) return { items: [{ value: "store" }, { value: "space" }], directive: "nofiles" };
  if (argv.length === 2 && (argv[0] === "store" || argv[0] === "space")) {
    try { return { items: loadMeshes().filter((entry) => entry.origin === "up").map((entry) => ({ value: entry.space })), directive: "nofiles" }; }
    catch { return { items: [], directive: "nofiles" }; }
  }
  return { items: [], directive: "nofiles" };
}

export function validateResetArguments(args: ParsedArgs): void {
  presentationOf(args.values);
  const [kind, space, ...extra] = args.positionals;
  if ((kind !== "store" && kind !== "space") || !space?.trim() || extra.length)
    throw new CommandFailure("refused", "USAGE_INVALID", "use reset store <space> or reset space <space> with an exact local space name");
  if (args.values["dry-run"] === true && args.values.yes === true)
    throw new CommandFailure("refused", "USAGE_INVALID", "--yes belongs to a guarded reset apply, not --dry-run");
}

/** A registered local root is selection, not deletion authority. Native maintenance, process,
 *  storage ownership and identity checks are still required before any reset can be offered. */
export async function reset(args: ParsedArgs): Promise<void> {
  validateResetArguments(args);
  const [kind, space] = args.positionals as ["store" | "space", string];
  if (kind === "space") {
    const { resetSpaceApply } = await import("./reset-space-apply.js");
    return resetSpaceApply(space, args);
  }
  if (args.values["dry-run"] !== true) return resetStoreApply(space, args);
  const mesh = selectResetTarget(space, "reset store");
  const root = mesh.root;
  if (root === canonicalRoot(homedir())) throw new CommandFailure("refused", "CONFLICT", "the machine home is not an isolated project root for a reset preview", { target: { space } });
  try {
    if (!realDirNoSymlink(root, ".cotal")) throw new Error("the recorded project root has no real Cotal control directory");
    const tenants = localMeshesForRoot(root);
    if (mesh.source === "registration" ? tenants.length !== 1 || tenants[0]?.space !== space : tenants.length !== 0) throw new Error("several or no locally owned spaces share the selected root");
    assertSingleSpaceBroker(authDir(root), `reset ${kind}`);
  } catch { throw new CommandFailure("refused", "CONFLICT", "the recorded root cannot be established as one isolated local space with a real control directory; no broker-wide reset scope was inferred", { target: { space, root } }); }
  if (mesh.storeDir !== undefined && !isAbsolute(mesh.storeDir)) throw new CommandFailure("refused", "CONFLICT", "the recorded custom store path is not absolute; no working-directory-relative reset target was adopted", { target: { space, root } });
  let store: ReturnType<typeof safeStoreCleanupPath>;
  let maintenance: ReturnType<typeof readMaintenanceJournal>;
  let possibleProcesses: string[];
  let serviceOwners: Array<{ instanceId: string; process: string; supervisor: string }>;
  let serviceCensus: ReturnType<typeof readLocalServiceCensus>;
  let additiveRecords: ReturnType<typeof listLedgerFiles>, additiveAttempts: ReturnType<typeof listAdditiveTeamAttempts>;
  let bootAttempts: ReturnType<typeof listFreshTeamAttempts>, bootSummaries: ReturnType<typeof listFreshTeamSummaries>;
  let otherBrokerRegistrations: Array<{ space: string; root: string; origin: string }>;
  try {
    store = safeStoreCleanupPath(root, mesh.storeDir);
    maintenance = readMaintenanceJournal(root);
    possibleProcesses = liveMeshProcesses(root, space);
    serviceOwners = serviceInstances(space).map(instanceProjection).map((row) => ({ instanceId: row.instanceId, process: row.observedProcess, supervisor: row.supervisorRecord.mechanism }));
    serviceCensus = readLocalServiceCensus(space);
    additiveRecords = listLedgerFiles(root, { requireReadable: true });
    additiveAttempts = listAdditiveTeamAttempts(root);
    bootAttempts = listFreshTeamAttempts(root); bootSummaries = listFreshTeamSummaries(root);
    const broker = mesh.server;
    otherBrokerRegistrations = loadMeshes().filter((row) => row.space !== space && row.server === broker).map((row) => ({ space: row.space, root: row.root, origin: row.origin ?? "not recorded" }));
  } catch (error) {
    if (error instanceof CommandFailure) throw error;
    throw new CommandFailure("refused", "CONFLICT", "the local store path, identity candidates, additive ledgers, maintenance journal, service custody or process liveness could not be inspected safely; no reset target was accepted", { target: { space, root } });
  }
  const byBootId = new Map(bootSummaries.valid.map((summary) => [summary.deploymentId, summary]));
  const unsettledBootAttempts = bootAttempts.valid.filter((attempt) => !freshTeamAttemptSettled(attempt, byBootId.get(attempt.deploymentId)));
  let brokerProbe: "credless-broker-response" | "no-credless-response" | "probe-failed";
  try { brokerProbe = await isReachable(mesh.server) ? "credless-broker-response" : "no-credless-response"; }
  catch { brokerProbe = "probe-failed"; }
  // The verdict runs the apply's own checks, read-only: the first one that refuses is the reason.
  let refusal: CommandFailure | undefined;
  if (mesh.tlsRequired || /^(?:tls|wss):\/\//i.test(mesh.server))
    refusal = new CommandFailure("refused", "UNSUPPORTED", "a credless broker probe cannot establish that a TLS-first listener is stopped, so reset store is not offered", { target: { space }, remedy: "use a trusted TLS-aware stopped-broker check before a guarded reset can be offered" });
  else {
    try { await assertResetEligible(mesh, "reset store"); }
    catch (error) { if (!(error instanceof CommandFailure)) throw error; refusal = error; }
  }
  const applyVerdict = refusal ? { offered: false, code: refusal.code, reason: refusal.message, remedy: refusal.remedy ?? null } : { offered: true };
  const result = { kind: "reset-local-impact-preview", operation: kind, space, root,
    recordedStorePath: mesh.storeDir ?? resolve(root, ".cotal", "nats"), storePathSource: mesh.source === "stopped-stack" ? "stack-journal" : mesh.storeDir ? "registration" : "legacy-default",
    inspectedStorePath: store.path, storeState: store.identity ? "real-directory-with-pinned-identity" : "absent-at-inspection",
    identityImpact: "preserve trust, credentials and registration",
    maintenance: maintenance?.state ?? "none-recorded", possibleProcesses, serviceOwners, serviceCensus, otherBrokerRegistrations,
    additiveLedgers: additiveRecords.valid.map(({ ledger }) => ({ deploymentId: ledger.runId, space: ledger.space, agents: ledger.created.agents.length, channels: ledger.created.channels.length })),
    unreadableAdditiveLedgers: additiveRecords.refused.map(({ path }) => path),
    retainedAdditiveAttempts: additiveAttempts.valid.map((attempt) => ({ deploymentId: attempt.deploymentId, server: brokerAddressForDisplay(attempt.server) ?? "not displayable", createdAt: attempt.createdAt, recordedState: additiveTeamRecordedState(attempt, additiveAttempts) })),
    unreadableAdditiveAttempts: additiveAttempts.refused.map(({ path }) => path),
    unsettledBootAttempts: unsettledBootAttempts.map((attempt) => ({ deploymentId: attempt.deploymentId, server: brokerAddressForDisplay(attempt.server) ?? "not displayable", createdAt: attempt.createdAt })),
    unreadableBootRecords: [...bootAttempts.refused, ...bootSummaries.refused].map(({ path }) => path),
    brokerSharing: "exact local registration matches only; aliases and live tenants not checked", brokerProbe,
    identityInventory: "not-applicable", exactIdentityPaths: "not-applicable",
    applyVerdict, dryRun: true, effectAttempted: false, persisted: false };
  // A preview that read what it could succeeds. It is partial in what it proves, which the
  // verdict's apply rechecks under the maintenance lock.
  writeResult(presentationOf(args.values), { command: "reset", target: { space, root }, result, completeness: "partial" }, (data): Report => ({ sections: [
    { title: "Verdict", blocks: refusal
      ? [{ kind: "lines", lines: [{ text: `reset store ${space} would refuse (${refusal.code}): ${refusal.message}`, tone: "failed" }, ...(refusal.remedy ? [`Next: ${refusal.remedy}`] : [])] }]
      : [{ kind: "lines", lines: [{ text: `reset store ${space} is offered. The apply runs every check again under the root's maintenance lock.`, tone: "ok" }] },
        { kind: "commands", items: [{ command: `cotal reset store ${space} --yes`, description: "Remove only this stopped store" }] }] },
    { title: "Reset local impact", blocks: [{ kind: "fields", rows: [["Scope", data.operation], ["Space", data.space], ["Recorded root", data.root], ["Store candidate", data.recordedStorePath], ["Inspected path", data.inspectedStorePath], ["Store state", data.storeState], ["Identity", data.identityImpact], ["Maintenance", data.maintenance], ["Broker probe", data.brokerProbe], ["Recorded processes that may run", data.possibleProcesses.length ? data.possibleProcesses.join(", ") : "none found in legacy pidfiles"], ["Service instance records", String(data.serviceOwners.length)], ["Supervisor receipts", String(data.serviceCensus.supervisors.length)], ["Retained native attempts", String(data.serviceCensus.nativeAttempts.length)], ["Additive ledgers", String(data.additiveLedgers.length)], ["Unreadable additive ledgers", String(data.unreadableAdditiveLedgers.length)], ["Retained additive deployments", String(data.retainedAdditiveAttempts.length)], ["Unreadable additive attempts", String(data.unreadableAdditiveAttempts.length)], ["Unsettled fresh attempts", String(data.unsettledBootAttempts.length)], ["Unreadable fresh records", String(data.unreadableBootRecords.length)], ["Other exact-address registrations", String(data.otherBrokerRegistrations.length)], ["Identity inventory", data.identityInventory], ["Exact identity paths", data.exactIdentityPaths]] }, { kind: "lines", lines: [{ text: "The local reads are not a maintenance lock, exclusive custody or broker stop proof. A negative credless probe may miss TLS-first listeners. Provider-owned secrets, full deletion paths and broker exclusivity remain unproved. No process was stopped and no file or registration was removed.", tone: "waiting" }] }] },
    { title: "Additive ownership at root", blocks: [
      data.additiveLedgers.length ? { kind: "table", columns: [{ key: "deploymentId", label: "Deployment ID" }, { key: "space", label: "Space" }, { key: "agents", label: "Agents" }, { key: "channels", label: "Channels" }], rows: data.additiveLedgers.slice(0, 100).map((row) => ({ ...row, agents: String(row.agents), channels: String(row.channels) })) } : { kind: "lines", lines: ["No readable additive ledger was found under this root."] },
      ...(data.unreadableAdditiveLedgers.length ? [{ kind: "lines" as const, lines: ["Unreadable ledger paths:", ...data.unreadableAdditiveLedgers.slice(0, 100)] }] : []),
      { kind: "lines", lines: [...(data.additiveLedgers.length > 100 || data.unreadableAdditiveLedgers.length > 100 ? ["Additional ledger records are in JSON."] : []), "A readable or unreadable ledger blocks store reset. Root-local records are not proof of live ownership or full broker tenancy."] },
    ] },
    { title: "Retained additive deployments", blocks: [data.retainedAdditiveAttempts.length ? { kind: "table", columns: [{ key: "deploymentId", label: "Deployment" }, { key: "recordedState", label: "Recorded state" }, { key: "createdAt", label: "Intent recorded" }], rows: data.retainedAdditiveAttempts.slice(0, 100) } : { kind: "lines", lines: ["No readable additive attempts were found under this root."] }, { kind: "lines", lines: [...data.unreadableAdditiveAttempts.slice(0, 100).map((path) => `Unreadable additive attempt: ${path}`), ...(data.retainedAdditiveAttempts.length > 100 || data.unreadableAdditiveAttempts.length > 100 ? ["Additional attempts or paths are in JSON."] : []), "An unsettled or unremoved additive deployment blocks store reset. A complete matched static agent-retirement receipt releases only that known blocker; it does not establish store ownership or broker exclusivity."] }] },
    { title: "Fresh boot attempts", blocks: [data.unsettledBootAttempts.length ? { kind: "table", columns: [{ key: "deploymentId", label: "Deployment" }, { key: "server", label: "Recorded broker" }, { key: "createdAt", label: "Intent recorded" }], rows: data.unsettledBootAttempts.slice(0, 100) } : { kind: "lines", lines: ["No unsettled readable fresh boot attempts were found under this root."] }, { kind: "lines", lines: [...data.unreadableBootRecords.slice(0, 100).map((path) => `Unreadable fresh record: ${path}`), ...(data.unsettledBootAttempts.length > 100 || data.unreadableBootRecords.length > 100 ? ["Additional attempts or unreadable records are in JSON."] : []), "An unsettled attempt or unreadable record blocks stopped-store reset. A missing summary does not establish that no broker started."] }] },
    { title: "Recorded broker address matches", blocks: [data.otherBrokerRegistrations.length ? { kind: "table", columns: [{ key: "space", label: "Other space" }, { key: "root", label: "Recorded root" }, { key: "origin", label: "Registration" }], rows: data.otherBrokerRegistrations.slice(0, 100) } : { kind: "lines", lines: ["No other registration uses this exact address in the local workstation registry."] }, { kind: "lines", lines: [...(data.otherBrokerRegistrations.length > 100 ? ["Additional exact-address matches are in JSON."] : []), "A match blocks store reset. No match does not prove broker exclusivity against aliases, remote tenants or live attachments."] }] },
    ...(data.serviceOwners.length ? [{ title: "Recorded service instances", blocks: [{ kind: "table" as const, columns: [{ key: "id", label: "Instance" }, { key: "process", label: "Process" }, { key: "supervisor", label: "Supervisor" }], rows: data.serviceOwners.slice(0, 100).map((row) => ({ id: row.instanceId, process: row.process, supervisor: row.supervisor })) }, ...(data.serviceOwners.length > 100 ? [{ kind: "lines" as const, lines: ["Additional service records are in JSON."] }] : [])] }] : []),
    ...((data.serviceCensus.supervisors.length || data.serviceCensus.nativeAttempts.length) ? [{ title: "Selected-space native custody", blocks: [
      { kind: "table" as const, columns: [{ key: "kind", label: "Record" }, { key: "definition", label: "Definition" }, { key: "instance", label: "Full instance" }, { key: "detail", label: "Recorded unit or step" }], rows: [
        ...data.serviceCensus.supervisors.map((row) => ({ kind: row.mechanism, definition: row.definition, instance: row.instanceId, detail: row.unit })),
        ...data.serviceCensus.nativeAttempts.map((row) => ({ kind: row.kind, definition: row.definition, instance: row.instanceId, detail: `${row.step} · ${row.position}` })),
      ].slice(0, 100) },
      { kind: "lines" as const, lines: [...(data.serviceCensus.supervisors.length + data.serviceCensus.nativeAttempts.length > 100 ? ["Additional custody records are in JSON."] : []), "These space-scoped records are not attributed to this project root. An orphan receipt or submitted attempt may still front native state; reset apply rechecks them and does not clear them."] },
    ] }] : []),
  ] }));
}
