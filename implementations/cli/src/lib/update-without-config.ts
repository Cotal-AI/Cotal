import { dirname, isAbsolute } from "node:path";
import type { ParsedArgs } from "@cotal-ai/core";
import { claimUpdateClosureAccess, clearUpdateRecovery, codeSpan, connectorConfigModeProblem, logicalExecutionEntry, observeUpdateVersion, readUpdateRecovery, recordUpdateCompletion, recordUpdateReleaseHold, updateClosureOwner, UPDATE_HOUR_MS, writeUpdateRecovery, type UpdateRecovery } from "@cotal-ai/workspace";
import { compareSemver } from "../seed/reconcile.js";
import { checkReleaseArchives, deferStagingFailure, handleLatestVersionFailure, latestVersion, offlineUpdateMessage, registryNetworkFailure } from "../commands/update-release.js";
import type { ExecutionReplacement, UpdateRuntime } from "../commands/update.js";
import { displayCmd } from "./self-exec.js";

type ModeProblem = NonNullable<ReturnType<typeof connectorConfigModeProblem>>;

export async function maybeUpdateWithoutConnectorConfig(args: ParsedArgs, rt: UpdateRuntime, recover: () => Promise<{ entry: string; version: string; resumed?: true } | undefined>): Promise<{ entry?: string } | undefined> {
  const gap = connectorConfigModeProblem();
  if (!gap) return;
  const restored = await recover();
  if (restored && (args.values.self !== true || restored.resumed)) return {};
  if (restored && restored.version !== rt.version()) return { entry: restored.entry };
  await updateWithoutConnectorConfig(args, rt, gap);
  return {};
}

async function updateWithoutConnectorConfig(args: ParsedArgs, rt: UpdateRuntime, gap: ModeProblem): Promise<void> {
  if (readUpdateRecovery()) throw gap.failure;
  const next = gap.owned ? `run ${codeSpan(`${gap.remedy} && ${displayCmd()} update`)}` : `ask the owner to protect the folder, then run ${codeSpan(`${displayCmd()} update`)}`;
  const reason = `Connector reconciliation and daemon activation are waiting: ${gap.failure.message}. To finish, ${next}.`;
  const report = () => rt.err(reason);
  const current = rt.version();
  if (args.values.self !== true) { rt.connectorConfigDeferred = true; report(); return; }
  rt.connectorConfigDeferred = true;
  const latest = latestVersion(rt);
  if (!latest.ok) {
    const code = await handleLatestVersionFailure(latest, current, rt, offlineUpdateMessage(false), false);
    if (code !== 0) process.exitCode = code;
    report();
    return;
  }
  if (compareSemver(latest.version, current) <= 0) {
    rt.out("No newer CLI version.");
    recordUpdateCompletion(current, "up to date; connector reconciliation is waiting for folder protection", true);
    report();
    return;
  }
  const version = latest.version;
  if (rt.env.COTAL_AUTO_UPDATE === "1") {
    const next = await observeUpdateVersion(version) + UPDATE_HOUR_MS;
    if (Date.now() < next) { recordUpdateReleaseHold(version, next); return; }
  }
  if (!rt.prepareExecution || !rt.executionGlobalRoot || !rt.recoverExecution) throw gap.failure;
  rt.preflightExecution?.();
  const root = rt.executionGlobalRoot();
  if (!isAbsolute(root)) throw new Error("cannot identify the installed CLI for update");
  let execution: ExecutionReplacement | undefined;
  let releaseGlobal: (() => void) | undefined;
  let releaseClosure: (() => void) | undefined;
  try {
    rt.out(`Checking cotal-ai@${version} release archives`);
    await checkReleaseArchives(version, rt);
    releaseGlobal = rt.claimGlobalUpdate(root);
    releaseClosure = claimUpdateClosureAccess();
    if (readUpdateRecovery()) throw new Error("an update is already pending; no new version was published");
    if (rt.globalVersion?.(root) !== current) throw new Error("the installed CLI changed during update; run the installed CLI again");
    execution = await rt.prepareExecution(version, root, reason);
    await execution.preflight(args.values);
    writeUpdateRecovery({ previous: current, target: version, installed: current, phase: "replacing", owner: updateClosureOwner(), execution: execution.journal, reconcileWithoutSnapshot: true, reason, admission: { disposition: "deferred", occupied: null, hostedSpaces: [], reason } });
    try {
      execution.publish();
      execution.verify(version);
    } catch (error) {
      execution.restore();
      execution.verify(current);
      clearUpdateRecovery();
      throw error;
    }
    clearUpdateRecovery();
    execution.complete?.();
    recordUpdateCompletion(version, `updated to ${version}; connector reconciliation is waiting for folder protection`, true);
    rt.out(`✓ cotal-ai@${version} installed`);
    report();
  } catch (error) {
    if (!execution && deferStagingFailure(error, version, rt, false)) return;
    if (!execution && registryNetworkFailure(error)) { rt.out(offlineUpdateMessage(false)); return; }
    throw error;
  } finally {
    try { execution?.discard?.(); }
    finally { try { releaseClosure?.(); } finally { releaseGlobal?.(); } }
  }
}

/** Finish or restore only the protected execution journal. No connector snapshot was taken. */
export function isCliOnlyUpdate(record: UpdateRecovery): record is UpdateRecovery & { execution: string } {
  return !record.snapshot && record.execution !== undefined && record.reconcileWithoutSnapshot === true && record.admission?.disposition === "deferred";
}

export function recoverUpdateWithoutConnectorConfig(rt: UpdateRuntime, observed: UpdateRecovery & { execution: string }): { entry: string; version: string } | undefined {
  const entry = logicalExecutionEntry();
  const root = rt.executionGlobalRoot?.() ?? (entry && dirname(dirname(dirname(entry))));
  if (!root || !rt.recoverExecution) throw new Error("cannot identify the interrupted CLI-only update");
  const release = rt.claimGlobalUpdate(root);
  let releaseClosure: (() => void) | undefined;
  try {
    releaseClosure = claimUpdateClosureAccess(true);
    const record = readUpdateRecovery();
    if (!record) return;
    if (!isCliOnlyUpdate(record) || record.execution !== observed.execution) throw new Error("the interrupted update journal changed; retry the update");
    const execution = rt.recoverExecution(record.execution, true);
    const published = execution.verifyPublished?.(record.target) === true;
    if (!published) { execution.restore(); execution.verify(record.previous); }
    clearUpdateRecovery();
    execution.complete?.();
    if (!published) return { entry: execution.entry, version: record.previous };
  } finally { try { releaseClosure?.(); } finally { release(); } }
}
