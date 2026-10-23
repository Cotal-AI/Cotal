import * as prompts from "../lib/prompts.js";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { isReachable, realDirNoSymlink, type ParsedArgs } from "@cotal-ai/core";
import {
  acquireMaintenanceLock, assertSingleSpaceBroker, authDir, brokerAddressForDisplay,
  canonicalRoot, CommandFailure, findMesh, findPreparedSpace, loadMeshes, localMeshesForRoot, oneLine,
  presentationOf, readBrokerPolicy, readMaintenanceJournal, releaseMaintenanceLock, writeResult, type Report,
} from "@cotal-ai/workspace";
import { liveMeshProcesses, removeLocalState, safeStoreCleanupPath } from "./clean.js";
import { canPrompt } from "./meshes-wizard.js";
import { instanceProjection, serviceInstances } from "../lib/service-instances.js";
import { readLocalServiceCensus } from "../lib/service-census.js";
import { listLedgerFiles } from "../lib/manifest/ledger.js";
import { readStackJournal } from "../lib/stack-journal.js";
import { freshTeamAttemptSettled, listFreshTeamAttempts, listFreshTeamSummaries } from "../lib/team-fresh.js";
import { listAdditiveTeamAttempts, retainedAdditiveTeamAttempts } from "../lib/team-additive-attempt.js";

/** What a named reset acts on. A running or crashed space is selected by its locally started
 *  registration. A controller stack that a completed `down` stopped has none: its prepared record
 *  and stack journal at the same root name its broker address, store and mode, and both stay after
 *  the reset so a later `up` starts it again. Selection is not deletion authority; every eligibility
 *  check still runs. */
export interface ResetTarget {
  space: string;
  root: string;
  server: string;
  storeDir: string | undefined;
  mode: "auth" | "open" | "user";
  tlsRequired: boolean;
  remoteUser: boolean;
  source: "registration" | "stopped-stack";
  /** The records the selection came from, compared again before any removal. */
  fingerprint: string;
}

export type ResetCommand = "reset store" | "reset space";

export function selectResetTarget(space: string, command: ResetCommand): ResetTarget {
  let entry: ReturnType<typeof findMesh>, prepared: ReturnType<typeof findPreparedSpace>;
  try { entry = findMesh(space); prepared = findPreparedSpace(space); }
  catch { throw new CommandFailure("refused", "TARGET_UNAVAILABLE", "the local registration could not be read; no reset target was inferred", { target: { space } }); }
  if (entry) {
    if (entry.origin !== "up") throw new CommandFailure("refused", "TARGET_NOT_FOUND", `${command} needs a space this machine started; a manual or discovered registration grants no storage authority`, { target: { space }, remedy: `see where it runs with cotal space show ${space}` });
    return { space, root: canonicalRoot(entry.root), server: entry.server, storeDir: entry.storeDir, mode: entry.mode, tlsRequired: entry.tlsRequired === true, remoteUser: entry.userAuth?.remote === true, source: "registration", fingerprint: JSON.stringify(entry) };
  }
  const root = prepared ? canonicalRoot(prepared.root) : undefined;
  let recorded: ReturnType<typeof readStackJournal>;
  try { recorded = root ? readStackJournal(root) : undefined; }
  catch { throw new CommandFailure("refused", "TARGET_UNAVAILABLE", "the prepared root's stack journal could not be read; no reset target was inferred", { target: { space, root } }); }
  if (!root || !recorded || recorded.journal.space !== space)
    throw new CommandFailure("refused", "TARGET_NOT_FOUND", `${command} needs a space this machine started; this one has no local registration and no stopped controller stack`, { target: { space }, remedy: `see the space with cotal space show ${space}` });
  const journal = recorded.journal, operation = journal.operation;
  if (operation.kind !== "down" || operation.phase !== "completed")
    throw new CommandFailure("refused", "LIFECYCLE_BLOCKED", `the controller stack's last operation is ${operation.kind} ${operation.phase}, and ${command} needs it stopped by a completed down; nothing was removed`, { target: { space, root }, remedy: `stop it with cotal down --yes from ${root}, then run cotal ${command} ${space} --dry-run` });
  if (!journal.broker)
    throw new CommandFailure("refused", "CONFLICT", "this stopped stack was recorded before its broker store was kept, so no store path was inferred; nothing was removed", { target: { space, root }, remedy: `start it once with cotal up --store-dir <original store dir> --space ${space}, which records the store, then cotal down --yes` });
  let policy: ReturnType<typeof readBrokerPolicy>;
  try { policy = readBrokerPolicy(root); }
  catch { throw new CommandFailure("refused", "CONFLICT", "the root's recorded broker transport policy is unreadable; no plaintext or TLS mode was inferred", { target: { space, root } }); }
  return { space, root, server: journal.server, storeDir: journal.broker.storeDir, mode: journal.mode, tlsRequired: policy?.transport.kind === "tls-required", remoteUser: false, source: "stopped-stack", fingerprint: JSON.stringify({ prepared, journal: recorded.sha256 }) };
}

/** An unresolved service process, supervisor receipt or native attempt may still own the store,
 * including an orphan receipt with no instance. Pidfile absence cannot settle that custody. */
export function assertNoRecordedServiceOwner(space: string): void {
  const census = readLocalServiceCensus(space);
  const blockers = serviceInstances(space).map(instanceProjection).filter((row) =>
    row.supervisorRecord.mechanism !== "none-recorded" || !["gone", "previous-boot", "foreign-pid"].includes(row.observedProcess));
  if (blockers.length || census.supervisors.length || census.nativeAttempts.length)
    throw new CommandFailure("refused", "LIFECYCLE_BLOCKED", "a service instance, supervisor receipt or retained native attempt may still own this space's store; no stopped reset is authorized", { target: { space, instanceIds: blockers.map((row) => row.instanceId), supervisors: census.supervisors.map((row) => row.instanceId), attempts: census.nativeAttempts.map((row) => row.attemptId) }, remedy: `inspect each with cotal service --space ${space} and stop it before another reset` });
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

/** Every check a stopped-store or identity reset runs before it is offered, and again under the
 *  maintenance lock. Each refusal names one reason and the command that clears it. Returns the
 *  store path, with its directory identity pinned when it exists. */
export async function assertResetEligible(target: ResetTarget, command: ResetCommand): Promise<ReturnType<typeof safeStoreCleanupPath>> {
  const { space, root } = target, where = { space, root }, review = `cotal ${command} ${space} --dry-run`;
  let current: ResetTarget | undefined;
  try { current = selectResetTarget(space, command); } catch { current = undefined; }
  if (current?.fingerprint !== target.fingerprint || current.source !== target.source)
    throw new CommandFailure("refused", "CONFLICT", "the space's registration, prepared record or stack journal changed since it was read; nothing was removed", { target: where, remedy: `review it again with ${review}` });
  const local = localMeshesForRoot(root);
  if (!realDirNoSymlink(root, ".cotal") || (target.source === "registration" ? local.length !== 1 || local[0]?.space !== space : local.length !== 0))
    throw new CommandFailure("refused", "CONFLICT", "the root is not one isolated local space with a real .cotal directory; no broker-wide reset scope was inferred", { target: { ...where, localSpaces: local.map((mesh) => mesh.space) } });
  try { assertSingleSpaceBroker(authDir(root), command); }
  catch { throw new CommandFailure("refused", "CONFLICT", "the root's broker holds several spaces or an unreadable tenant record; a single-space reset cannot be scoped", { target: where }); }
  let store: ReturnType<typeof safeStoreCleanupPath>;
  try { store = safeStoreCleanupPath(root, target.storeDir); }
  catch { throw new CommandFailure("refused", "CONFLICT", "the recorded store path is not one real directory the reset may remove; nothing was removed", { target: { ...where, storeDir: target.storeDir ?? null } }); }
  let maintenance: ReturnType<typeof readMaintenanceJournal>, running: string[], legacy: boolean;
  try { maintenance = readMaintenanceJournal(root); running = liveMeshProcesses(root, space); legacy = target.source === "registration" && readStackJournal(root)?.journal.space !== space; }
  catch { throw new CommandFailure("refused", "CONFLICT", "the root's maintenance journal or process records could not be read; nothing was removed", { target: where }); }
  // A legacy root's `down` drops its registration, so no reset can select it afterwards. The step
  // after that stop is the clean the reset runs, from the root, naming only a custom store.
  const storeFlag = target.storeDir !== undefined && resolve(target.storeDir) !== join(root, ".cotal", "nats") ? ` --store-dir ${target.storeDir}` : "";
  const afterStop = !legacy ? `run ${review}`
    : command === "reset store" ? `remove its stored streams with cotal clean store${storeFlag} --force there`
    : `remove its store and identity with cotal clean all${storeFlag} --force there`;
  if (maintenance)
    throw new CommandFailure("refused", "LIFECYCLE_BLOCKED", `this root retains a maintenance attempt in state ${maintenance.state}; a reset does not override it`, { target: where, remedy: "finish it, or recover it with its recorded restore recovery or fallback cleanup, before a reset" });
  if (running.length)
    throw new CommandFailure("refused", "LIFECYCLE_BLOCKED", `the space may still run here (${running.join("; ")}); nothing was removed`, { target: { ...where, processes: running }, remedy: running.some((row) => row.includes("no stop receipt"))
      ? `a member exited without a recorded stop: start the stack with cotal up and stop it with cotal down --yes from ${root}, then run ${review}`
      : `stop it with cotal down from ${root}, then ${afterStop}` });
  try {
    assertNoRecordedServiceOwner(space);
    assertNoAdditiveLedger(root, space);
    assertNoExactBrokerPeer(space, target.server);
  } catch (error) {
    if (error instanceof CommandFailure) throw error;
    throw new CommandFailure("refused", "CONFLICT", "the space's service, deployment or registration records could not be inspected; nothing was removed", { target: where });
  }
  let answers: boolean;
  try { answers = await isReachable(target.server); }
  catch { throw new CommandFailure("refused", "CONFLICT", "the recorded broker address could not be probed; a stopped broker was not inferred", { target: where }); }
  if (answers)
    throw new CommandFailure("refused", "LIFECYCLE_BLOCKED", `something still answers at the recorded broker address ${brokerAddressForDisplay(target.server) ?? "of this space"}; nothing was removed`, { target: where, remedy: `stop the space with cotal down from ${root}, or stop whatever listens there, then ${afterStop}` });
  return store;
}

/** Named store-only cleanup. Trust, credentials, service definitions and registration remain. */
export async function resetStoreApply(space: string, args: ParsedArgs): Promise<void> {
  const presentation = presentationOf(args.values);
  const yes = args.values.yes === true;
  if (!yes && (!canPrompt() || presentation === "json"))
    throw new CommandFailure("refused", "USAGE_INVALID", "reset store needs a terminal confirmation or --yes with an exact space name in a script", { target: { space }, remedy: `inspect reset store ${space} --dry-run first` });
  const selected = selectResetTarget(space, "reset store");
  if (selected.tlsRequired || /^(?:tls|wss):\/\//i.test(selected.server))
    throw new CommandFailure("refused", "UNSUPPORTED", "a credless broker probe cannot establish that a TLS-first listener is stopped; no store reset was attempted", { target: { space }, remedy: "use a trusted TLS-aware stopped-broker check before a guarded reset can be offered" });
  const root = selected.root;
  const target = { space, root };
  if (root === canonicalRoot(homedir()) || selected.storeDir !== undefined && !isAbsolute(selected.storeDir))
    throw new CommandFailure("refused", "CONFLICT", "the selected root or custom store path is not a safe absolute project target", { target });
  const expected = await assertResetEligible(selected, "reset store");
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
    const pinned = await assertResetEligible(selected, "reset store");
    if (pinned.path !== expected.path || Boolean(pinned.identity) !== Boolean(expected.identity) || pinned.identity && (pinned.identity.dev !== expected.identity?.dev || pinned.identity.ino !== expected.identity?.ino)) throw new Error("store identity changed");
    submitted = true;
    removed = await removeLocalState(root, { includeAuth: false, space, storeDir: selected.storeDir, expectedStore: expected });
  } catch (error) {
    failure = error instanceof CommandFailure ? error : submitted
      ? new CommandFailure("unknown", "OPERATION_UNKNOWN", "the stopped store removal did not confirm its complete outcome; it was not retried", { target, native: { outcome: "unknown", detail: { path: expected.path } }, remedy: "inspect the original path and maintenance state before deciding whether to retry" })
      : new CommandFailure("refused", "CONFLICT", "the pinned store identity changed before cleanup; nothing was removed", { target, remedy: `review it again with cotal reset store ${space} --dry-run` });
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
  const records = selected.source === "registration" ? "kept" : "none; the prepared record and stack journal stay";
  writeResult(presentation, { command: "reset", target, result: { kind: "reset-store", space, removedPaths: paths, trustRemoved: false, credentialsRemoved: false, registrationRemoved: false, selectedBy: selected.source }, ...(paths.length ? {} : { noOp: true }) }, (data): Report => ({ sections: [{ title: data.removedPaths.length ? "Store removed" : "Store already absent", blocks: [
    { kind: "fields", rows: [["Space", data.space], ["Store path", expected.path], ["Trust and credentials", "kept"], ["Registration", records]] },
    { kind: "lines", lines: data.removedPaths.length ? data.removedPaths : ["No store directory existed at the pinned path."] },
  ] }, { title: "Next", blocks: [{ kind: "commands", items: [{ command: "cotal up", description: `Start ${space} again on an empty store, from ${root}` }] }] }] }));
}
