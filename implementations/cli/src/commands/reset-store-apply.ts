import * as prompts from "../lib/prompts.js";
import { lstatSync, readlinkSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { isReachable, realDirNoSymlink, type ParsedArgs } from "@cotal-ai/core";
import {
  ConfirmationRequired,
  acquireMaintenanceLock, assertSingleSpaceBroker, authDir, brokerAddressForDisplay,
  canonicalRoot, CommandFailure, findMesh, findPreparedSpace, isCommandFailure, loadMeshes, localMeshesForRoot, oneLine,
  presentationOf, readBrokerPolicy, readMaintenanceJournal, releaseMaintenanceLock, STORE_CONTENTS, storeContentsText, writeResult, type Block, type Report, type Section,
} from "@cotal-ai/workspace";
import { liveMeshProcesses, removeLocalState, safeStoreCleanupPath } from "./clean.js";
import { refuseSharedStoreRemoval } from "../lib/store-dir.js";
import { canPrompt } from "./meshes-wizard.js";
import { instanceProjection, serviceInstances } from "../lib/service-instances.js";
import { readLocalServiceCensus } from "../lib/service-census.js";
import { listLedgerFiles } from "../lib/manifest/ledger.js";
import { acquireStackOperationLock, readStackJournal, stackNeverStarted } from "../lib/stack-journal.js";
import type { StackRuns } from "../lib/stack-runs.js";
import { freshTeamAttemptSettled, listFreshTeamAttempts, listFreshTeamSummaries } from "../lib/team-fresh.js";
import { listAdditiveTeamAttempts, retainedAdditiveTeamAttempts } from "../lib/team-additive-attempt.js";
import { reportOnInterrupt } from "../lib/interrupt-report.js";

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

/** The runs the stack journal's last down recorded, or undefined when it holds no down with them. */
export function runsAtLastDown(root: string): StackRuns | undefined {
  try {
    const operation = readStackJournal(root)?.journal.operation;
    return operation?.kind === "down" ? operation.runs : undefined;
  } catch { return undefined; }
}

/** How many recorded runs were waiting for an answer, as one clause. */
function runCounts(runs: Extract<StackRuns, { read: true }>): string {
  const listed = runs.runs.length + runs.omitted;
  const waiting = runs.runs.filter((row) => row.waiting?.length).length;
  return `${listed} workflow run${listed === 1 ? "" : "s"} that had not finished, ${waiting} of them waiting for an answer, and ${runs.finished} finished run${runs.finished === 1 ? "" : "s"}`;
}

/** The recorded runs as report blocks, for the preview and the receipt. `remedy` names how to read
 *  them live when nothing usable was recorded. */
export function storeRunBlocks(runs: StackRuns | undefined, remedy: string | undefined): Block[] {
  if (runs === undefined) return [{ kind: "lines", lines: [{ text: `No run list was recorded: the last down predates it or did not stop this stack.${remedy ? ` ${remedy}` : ""}`, tone: "waiting" }] }];
  if (!runs.read) return [{ kind: "lines", lines: [{ text: `The last down, at ${runs.observedAt}, could not read the runs: ${runs.reason}.${remedy ? ` ${remedy}` : ""}`, tone: "waiting" }] }];
  const rows = runs.runs.flatMap((row) => (row.waiting === null ? [{ step: "not read", asks: "" }] : row.waiting.length ? row.waiting : [{ step: "none", asks: "" }]).map((wait, index) => ({ run: index ? "" : row.runId, state: index ? "" : row.state, step: wait.step, asks: wait.asks })));
  return [
    { kind: "lines", lines: [`As of the last down, at ${runs.observedAt}, the store held ${runCounts(runs)}.`] },
    ...(rows.length ? [{ kind: "table" as const, columns: [{ key: "run", label: "Run" }, { key: "state", label: "State" }, { key: "step", label: "Waiting step" }, { key: "asks", label: "Request" }], rows }] : []),
    ...(runs.omitted ? [{ kind: "lines" as const, lines: [`${runs.omitted} more unfinished run${runs.omitted === 1 ? " is" : "s are"} not listed.`] }] : []),
  ];
}

/** The preview's Store contents section, which `reset store` and `reset space` share: what removing
 *  the store at `root` removes, and the runs its last down recorded. None when no store is present. */
export function storeContentsSection(removed: readonly string[], runs: StackRuns | undefined, root: string): Section[] {
  return removed.length ? [{ title: "Store contents", blocks: [
    { kind: "lines", lines: [`Removing the store removes ${storeContentsText(removed)}. A run still waiting for an answer goes with it and cannot be answered or resumed afterwards.`] },
    ...storeRunBlocks(runs, `Only the broker reads the store, and it is stopped. To see the runs, run cotal up and cotal run ps from ${root}, then cotal down --yes.`),
  ] }] : [];
}

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
  catch (error) {
    // A journal refusal names the file and its way out.
    if (isCommandFailure(error)) throw error;
    throw new CommandFailure("refused", "TARGET_UNAVAILABLE", "the prepared root's stack journal could not be read; no reset target was inferred", { target: { space, root } });
  }
  // A legacy root has no stack journal, and its down removes the registration a reset selects, so it
  // is cleared with clean from that root instead.
  if (!root || !recorded || recorded.journal.space !== space)
    throw new CommandFailure("refused", "TARGET_NOT_FOUND", `${command} needs a space this machine started; this one has no local registration and no stopped controller stack`, { target: { space }, remedy: `if it ran from a legacy root, whose down removes the registration a reset selects, run cotal clean ${command === "reset space" ? "all" : "store"} --force from that root, adding --store-dir <dir> if it used a custom store; cotal space lists the spaces this machine still registers` });
  const journal = recorded.journal, operation = journal.operation;
  if (stackNeverStarted(journal))
    throw new CommandFailure("refused", "TARGET_NOT_FOUND", `${command} found nothing to reset: no member of this root's controller stack ever started, so no broker wrote a store; nothing was removed`, { target: { space, root }, remedy: `start it with cotal up from ${root}` });
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

/** The recorded store as a reset may remove it, with its directory identity pinned when it exists,
 *  or a refusal that names the path and why: a link is named with the directory it points to. */
export function resetStorePath(root: string, storeDir: string | undefined, where: { space: string; root: string }, review: string): ReturnType<typeof safeStoreCleanupPath> {
  try { return safeStoreCleanupPath(root, storeDir); }
  catch (error) {
    if (error instanceof CommandFailure) throw error;
    const path = resolve(storeDir ?? join(root, ".cotal", "nats"));
    let linked: string | undefined;
    try {
      // A dangling link has no real path, so its own target is named instead.
      if (lstatSync(path).isSymbolicLink()) {
        try { linked = realpathSync.native(path); } catch { linked = readlinkSync(path); }
      }
    } catch { linked = undefined; }
    if (linked !== undefined)
      throw new CommandFailure("refused", "CONFLICT", `the recorded store path ${path} is a link to ${linked}, and a reset removes only a real directory; nothing was removed`, { target: { ...where, storeDir: path, linkTarget: linked }, remedy: `replace the link with the directory it points to, then run ${review} again` });
    throw new CommandFailure("refused", "CONFLICT", `the recorded store path ${path} is not one real directory the reset may remove (${(error as Error).message}); nothing was removed`, { target: { ...where, storeDir: path } });
  }
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
  const store = resetStorePath(root, target.storeDir, where, review);
  if (store.identity) refuseSharedStoreRemoval(store.path, space);
  let maintenance: ReturnType<typeof readMaintenanceJournal>, running: string[], legacy: boolean, stoppedByDown: boolean;
  try {
    maintenance = readMaintenanceJournal(root); running = liveMeshProcesses(root, space, true);
    const stack = readStackJournal(root)?.journal;
    legacy = target.source === "registration" && stack?.space !== space;
    stoppedByDown = stack?.operation.kind === "down" && stack.operation.phase === "completed";
  }
  catch { throw new CommandFailure("refused", "CONFLICT", "the root's maintenance journal or process records could not be read; nothing was removed", { target: where }); }
  // A legacy root's `down` drops its registration, so no reset can select it afterwards. The step
  // after that stop is the clean the reset runs, from the root, naming only a custom store.
  const storeFlag = target.storeDir !== undefined && resolve(target.storeDir) !== join(root, ".cotal", "nats") ? ` --store-dir ${target.storeDir}` : "";
  const afterStop = !legacy ? `run ${review}`
    : command === "reset store" ? `remove its stored streams with cotal clean store${storeFlag} --force there`
    : `remove its store and identity with cotal clean all${storeFlag} --force there`;
  if (maintenance)
    throw new CommandFailure("refused", "LIFECYCLE_BLOCKED", `this root retains a maintenance attempt in state ${maintenance.state}; a reset does not override it`, { target: where, remedy: "finish it, or recover it with its recorded restore recovery or fallback cleanup, before a reset" });
  // A `down` records a member that exited without a stop as already stopped, which settles it for a
  // reset. One that a completed `down` did not record gets its receipt only from a full restart.
  if (running.length)
    throw new CommandFailure("refused", "LIFECYCLE_BLOCKED", `the space may still run here (${running.join("; ")}); nothing was removed`, { target: { ...where, processes: running }, remedy: running.some((row) => row.includes("no stop receipt"))
      ? stoppedByDown
        ? `a member exited without a recorded stop: start the stack with cotal up and stop it with cotal down --yes from ${root}, then run ${review}`
        : `a member exited without a recorded stop: record it with cotal down --yes from ${root}, then run ${review}`
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
    throw new ConfirmationRequired("reset store needs a terminal confirmation or --yes with an exact space name in a script", { target: { space }, remedy: `inspect cotal reset store ${space} --dry-run first, then run cotal reset store ${space} --yes` });
  const selected = selectResetTarget(space, "reset store");
  if (selected.tlsRequired || /^(?:tls|wss):\/\//i.test(selected.server))
    throw new CommandFailure("refused", "UNSUPPORTED", "a credless broker probe cannot establish that a TLS-first listener is stopped; no store reset was attempted", { target: { space }, remedy: "use a trusted TLS-aware stopped-broker check before a guarded reset can be offered" });
  const root = selected.root;
  const target = { space, root };
  if (root === canonicalRoot(homedir()) || selected.storeDir !== undefined && !isAbsolute(selected.storeDir))
    throw new CommandFailure("refused", "CONFLICT", "the selected root or custom store path is not a safe absolute project target", { target });
  // From here an interrupt says what the reset left, and releases the lock so the next run does not find it held.
  let lock: ReturnType<typeof acquireMaintenanceLock> | undefined;
  let submitted = false;
  const stopReporting = reportOnInterrupt(presentation, "reset", () => submitted
    ? new CommandFailure("unknown", "OPERATION_UNKNOWN", "reset store was interrupted while it removed the stopped store; part of it may remain", { target, remedy: `see what remains with cotal reset store ${space} --dry-run before you run it again` })
    : new CommandFailure("failed", "OPERATION_FAILED", "reset store was interrupted before it removed anything; the store is as it was", { target, remedy: `run cotal reset store ${space} --yes again` }),
  () => { if (lock) releaseMaintenanceLock(lock); });
  const expected = await assertResetEligible(selected, "reset store");
  const recordedRuns = runsAtLastDown(root);
  if (!yes) {
    const answer = await prompts.confirm({ message: `Delete only the stopped store at ${oneLine(expected.path)} for ${oneLine(space)} on ${oneLine(brokerAddressForDisplay(selected.server) ?? "the recorded broker")}? Its ${storeContentsText(STORE_CONTENTS)} go with it${recordedRuns?.read ? ` (as of the last down: ${runCounts(recordedRuns)})` : ""}. Trust, credentials and registration stay.`, initialValue: false });
    if (prompts.isCancel(answer) || !answer) {
      stopReporting();
      writeResult(presentation, { command: "reset", target, result: { kind: "reset-store", confirmed: false, deleted: false }, noOp: true }, (): Report => ({ sections: [{ title: "Store kept", blocks: [{ kind: "lines", lines: ["No store path was removed."] }] }] }));
      return;
    }
  }
  // A live holder, such as a racing `up`, is named by its pid, as whole-stack commands name it.
  try { lock = acquireStackOperationLock(root); }
  catch (error) {
    if (isCommandFailure(error)) throw error;
    throw new CommandFailure("refused", "CONFLICT", "the exclusive local maintenance lock could not be acquired; no store was removed", { target });
  }
  let removed: string[] | undefined;
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
    stopReporting();
  }
  if (failure) throw failure;
  const paths = removed ?? [];
  const records = selected.source === "registration" ? "kept" : "none; the prepared record and stack journal stay";
  writeResult(presentation, { command: "reset", target, result: { kind: "reset-store", space, removedPaths: paths, removedContents: paths.length ? STORE_CONTENTS : [], removedRuns: paths.length ? recordedRuns ?? null : null, trustRemoved: false, credentialsRemoved: false, registrationRemoved: false, selectedBy: selected.source }, ...(paths.length ? {} : { noOp: true }) }, (data): Report => ({ sections: [{ title: data.removedPaths.length ? "Store removed" : "Store already absent", blocks: [
    { kind: "fields", rows: [["Space", data.space], ["Store path", expected.path], ...(data.removedContents.length ? [["Removed with it", storeContentsText(data.removedContents)]] as [string, string][] : []), ["Trust and credentials", "kept"], ["Registration", records]] },
    { kind: "lines", lines: data.removedPaths.length ? data.removedPaths : ["No store directory existed at the pinned path."] },
  ] }, ...(data.removedPaths.length ? [{ title: "Workflow runs removed", blocks: storeRunBlocks(recordedRuns, undefined) }] : []), { title: "Next", blocks: [{ kind: "commands", items: [{ command: "cotal up", description: `Start ${space} again on an empty store, from ${root}` }] }] }] }));
}
