import * as prompts from "../lib/prompts.js";
import { homedir } from "node:os";
import { isAbsolute } from "node:path";
import { isReachable, realDirNoSymlink, type ParsedArgs } from "@cotal-ai/core";
import {
  acquireMaintenanceLock, assertSingleSpaceBroker, authDir, brokerAddressForDisplay,
  canonicalRoot, CommandFailure, findMesh, loadMeshes, localMeshesForRoot, oneLine,
  presentationOf, readMaintenanceJournal, releaseMaintenanceLock, writeResult, type Report,
} from "@cotal-ai/workspace";
import { liveMeshProcesses, removeLocalState, safeStoreCleanupPath } from "./clean.js";
import { canPrompt } from "./meshes-wizard.js";
import { instanceProjection, serviceInstances } from "../lib/service-instances.js";
import { readLocalServiceCensus } from "../lib/service-census.js";
import { listLedgerFiles } from "../lib/manifest/ledger.js";
import { freshTeamAttemptSettled, listFreshTeamAttempts, listFreshTeamSummaries } from "../lib/team-fresh.js";
import { listAdditiveTeamAttempts, retainedAdditiveTeamAttempts } from "../lib/team-additive-attempt.js";

/** An unresolved service process, supervisor receipt or native attempt may still own the store,
 * including an orphan receipt with no instance. Pidfile absence cannot settle that custody. */
export function assertNoRecordedServiceOwner(space: string): void {
  const census = readLocalServiceCensus(space);
  const blockers = serviceInstances(space).map(instanceProjection).filter((row) =>
    row.supervisorRecord.mechanism !== "none-recorded" || !["gone", "previous-boot", "foreign-pid"].includes(row.observedProcess));
  if (blockers.length || census.supervisors.length || census.nativeAttempts.length)
    throw new CommandFailure("refused", "LIFECYCLE_BLOCKED", "a service instance, supervisor receipt or retained native attempt may still own this space's store; no stopped reset is authorized", { target: { space, instanceIds: blockers.map((row) => row.instanceId), supervisors: census.supervisors.map((row) => row.instanceId), attempts: census.nativeAttempts.map((row) => row.attemptId) } });
}

/** A matching local address is a blocker; the absence of a match proves no broker exclusivity. */
export function assertNoExactBrokerPeer(space: string, server: string): void {
  const peers = loadMeshes().filter((row) => row.space !== space && row.server === server);
  if (peers.length) throw new CommandFailure("refused", "LIFECYCLE_BLOCKED", "another registered space names the exact broker address for this store; reset did not remove a potentially shared tenant's data", { target: { space, otherSpaces: peers.map((row) => row.space) }, remedy: "inspect both registrations and the original store owner; unmatched aliases and remote tenants are not excluded by this check" });
}

/** A local additive ledger is a blocker, never store ownership authority. */
export function assertNoAdditiveLedger(root: string, space: string): void {
  let records: ReturnType<typeof listLedgerFiles>, additiveAttempts: ReturnType<typeof listAdditiveTeamAttempts>;
  let attempts: ReturnType<typeof listFreshTeamAttempts>, summaries: ReturnType<typeof listFreshTeamSummaries>;
  try { records = listLedgerFiles(root, { requireReadable: true }); additiveAttempts = listAdditiveTeamAttempts(root); attempts = listFreshTeamAttempts(root); summaries = listFreshTeamSummaries(root); }
  catch { throw new CommandFailure("refused", "TARGET_UNAVAILABLE", "the root's deployment records could not be inspected; store reset was not submitted", { target: { space, root } }); }
  if (records.valid.length || records.refused.length)
    throw new CommandFailure("refused", "LIFECYCLE_BLOCKED", "additive ownership ledgers or unreadable ledger records remain under this root; store reset did not remove their resources", { target: { space, root, deploymentIds: records.valid.map(({ ledger }) => ledger.runId), unreadable: records.refused.map(({ path }) => path) }, remedy: "inspect and finish each additive deployment's own lifecycle before resetting its store" });
  if (retainedAdditiveTeamAttempts(additiveAttempts).length || additiveAttempts.refused.length)
    throw new CommandFailure("refused", "LIFECYCLE_BLOCKED", "an unsettled additive attempt or returned additive deployment remains; store reset did not erase its possibly owned resources", { target: { space, root, deploymentIds: retainedAdditiveTeamAttempts(additiveAttempts).map((attempt) => attempt.deploymentId), unreadable: additiveAttempts.refused.map(({ path }) => path) } });
  const byId = new Map(summaries.valid.map((summary) => [summary.deploymentId, summary]));
  const unsettled = attempts.valid.filter((attempt) => !freshTeamAttemptSettled(attempt, byId.get(attempt.deploymentId)));
  if (unsettled.length || attempts.refused.length || summaries.refused.length)
    throw new CommandFailure("refused", "LIFECYCLE_BLOCKED", "an unsettled fresh boot attempt or unreadable boot record remains; store reset did not infer that its broker is stopped", { target: { space, root, unsettledIds: unsettled.map((attempt) => attempt.deploymentId), unreadable: [...attempts.refused, ...summaries.refused].map(({ path }) => path) }, remedy: "inspect the original fresh boot and its process custody before a stopped-store reset" });
}

/** Named store-only cleanup. Trust, credentials, service definitions and registration remain. */
export async function resetStoreApply(space: string, args: ParsedArgs): Promise<void> {
  const presentation = presentationOf(args.values);
  const yes = args.values.yes === true;
  if (!yes && (!canPrompt() || presentation === "json"))
    throw new CommandFailure("refused", "USAGE_INVALID", "reset store needs a terminal confirmation or --yes with an exact space name in a script", { target: { space }, remedy: `inspect reset store ${space} --dry-run first` });
  let selected: ReturnType<typeof findMesh>;
  try { selected = findMesh(space); }
  catch { throw new CommandFailure("refused", "TARGET_UNAVAILABLE", "the local registration could not be read; no store was selected", { target: { space } }); }
  if (!selected || selected.origin !== "up") throw new CommandFailure("refused", "TARGET_NOT_FOUND", "reset store requires an exact locally started registration", { target: { space } });
  if (selected.tlsRequired === true || /^(?:tls|wss):\/\//i.test(selected.server))
    throw new CommandFailure("refused", "UNSUPPORTED", "a credless broker probe cannot establish that a TLS-first listener is stopped; no store reset was attempted", { target: { space }, remedy: "use a trusted TLS-aware stopped-broker check before a guarded reset can be offered" });
  const root = canonicalRoot(selected.root);
  const target = { space, root };
  if (root === canonicalRoot(homedir()) || selected.storeDir !== undefined && !isAbsolute(selected.storeDir))
    throw new CommandFailure("refused", "CONFLICT", "the selected root or custom store path is not a safe absolute project target", { target });
  let expected: ReturnType<typeof safeStoreCleanupPath>;
  try {
    if (!realDirNoSymlink(root, ".cotal") || localMeshesForRoot(root).length !== 1 || localMeshesForRoot(root)[0]?.space !== space) throw new Error("root ownership ambiguous");
    assertSingleSpaceBroker(authDir(root), "reset store");
    expected = safeStoreCleanupPath(root, selected.storeDir);
    if (readMaintenanceJournal(root)) throw new Error("maintenance journal active");
    if (liveMeshProcesses(root, space).length) throw new Error("recorded process might run");
    assertNoRecordedServiceOwner(space);
    assertNoAdditiveLedger(root, space);
    assertNoExactBrokerPeer(space, selected.server);
    if (await isReachable(selected.server)) throw new Error("broker endpoint reachable");
  } catch (error) {
    if (error instanceof CommandFailure) throw error;
    throw new CommandFailure("refused", "LIFECYCLE_BLOCKED", "the registered root, store identity, maintenance state, recorded processes or broker endpoint cannot be proven eligible for a stopped-store reset", { target });
  }
  if (!yes) {
    const answer = await prompts.confirm({ message: `Delete only the stopped store at ${oneLine(expected.path)} for ${oneLine(space)} on ${oneLine(brokerAddressForDisplay(selected.server) ?? "the recorded broker")}? Trust, credentials and registration stay.`, initialValue: false });
    if (prompts.isCancel(answer) || !answer) {
      writeResult(presentation, { command: "reset", target, result: { kind: "reset-store", confirmed: false, deleted: false }, noOp: true }, (): Report => ({ sections: [{ title: "Store kept", blocks: [{ kind: "lines", lines: ["No store path was removed."] }] }] }));
      return;
    }
  }
  let lock: ReturnType<typeof acquireMaintenanceLock>;
  try { lock = acquireMaintenanceLock(root); }
  catch { throw new CommandFailure("refused", "CONFLICT", "the exclusive local maintenance lock could not be acquired; no store was removed", { target }); }
  let removed: string[] | undefined;
  let submitted = false;
  let failure: CommandFailure | undefined;
  try {
    const current = findMesh(space);
    if (!current || current.origin !== "up" || current.ts !== selected.ts || current.server !== selected.server || current.root !== selected.root || current.storeDir !== selected.storeDir || current.mode !== selected.mode || current.tlsRequired !== selected.tlsRequired)
      throw new CommandFailure("refused", "CONFLICT", "the local registration changed before reset; no store removal was submitted", { target });
    if (!realDirNoSymlink(root, ".cotal") || localMeshesForRoot(root).length !== 1 || localMeshesForRoot(root)[0]?.space !== space) throw new Error("root ownership changed");
    assertSingleSpaceBroker(authDir(root), "reset store");
    if (readMaintenanceJournal(root)) throw new Error("maintenance state changed");
    if (liveMeshProcesses(root, space).length) throw new Error("recorded process might run");
    assertNoRecordedServiceOwner(space);
    assertNoAdditiveLedger(root, space);
    assertNoExactBrokerPeer(space, current.server);
    if (await isReachable(current.server)) throw new Error("broker endpoint reachable");
    const pinned = safeStoreCleanupPath(root, current.storeDir);
    if (pinned.path !== expected.path || Boolean(pinned.identity) !== Boolean(expected.identity) || pinned.identity && (pinned.identity.dev !== expected.identity?.dev || pinned.identity.ino !== expected.identity?.ino)) throw new Error("store identity changed");
    submitted = true;
    removed = await removeLocalState(root, { includeAuth: false, space, storeDir: current.storeDir, expectedStore: expected });
  } catch (error) {
    failure = error instanceof CommandFailure ? error : submitted
      ? new CommandFailure("unknown", "OPERATION_UNKNOWN", "the stopped store removal did not confirm its complete outcome; it was not retried", { target, native: { outcome: "unknown", detail: { path: expected.path } }, remedy: "inspect the original path and maintenance state before deciding whether to retry" })
      : new CommandFailure("refused", "CONFLICT", "the root, maintenance state, recorded processes, endpoint or pinned store identity changed before cleanup; nothing was removed", { target });
  } finally {
    try { releaseMaintenanceLock(lock); }
    catch {
      if (!failure) failure = removed
        ? new CommandFailure("partial", "OPERATION_PARTIAL", "the store cleanup returned but maintenance lock release was not confirmed", { target, changed: removed, native: { outcome: "unknown" } })
        : new CommandFailure("failed", "OPERATION_FAILED", "maintenance lock release was not confirmed; no store cleanup was submitted", { target });
    }
  }
  if (failure) throw failure;
  const paths = removed ?? [];
  writeResult(presentation, { command: "reset", target, result: { kind: "reset-store", space, removedPaths: paths, trustRemoved: false, credentialsRemoved: false, registrationRemoved: false }, ...(paths.length ? {} : { noOp: true }) }, (data): Report => ({ sections: [{ title: data.removedPaths.length ? "Store removed" : "Store already absent", blocks: [
    { kind: "fields", rows: [["Space", data.space], ["Store path", expected.path], ["Trust and credentials", "kept"], ["Registration", "kept"]] },
    { kind: "lines", lines: data.removedPaths.length ? data.removedPaths : ["No store directory existed at the pinned path."] },
  ] }] }));
}
