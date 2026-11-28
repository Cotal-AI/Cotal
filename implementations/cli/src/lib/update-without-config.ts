import { dirname, isAbsolute } from "node:path";
import type { ParsedArgs } from "@cotal-ai/core";
import { claimUpdateClosureAccess, clearUpdateRecovery, codeSpan, connectorConfigModeProblem, exitCode, logicalExecutionEntry, observeUpdateVersion, readUpdateRecovery, recordConnectorReconciliationDeferred, recordUpdateReleaseHold, updateClosureOwner, UPDATE_HOUR_MS, writeResult, writeUpdateRecovery, type UpdateRecovery } from "@cotal-ai/workspace";
import { compareSemver } from "../seed/reconcile.js";
import { checkReleaseArchives, deferStagingFailure, handleLatestVersionFailure, latestVersion, offlineUpdateMessage, registryNetworkFailure } from "../commands/update-release.js";
import type { ExecutionReplacement, UpdateRuntime } from "../commands/update.js";
import { displayCmd } from "./self-exec.js";
import { CommandFailure, clearConnectorActivationDeferral } from "@cotal-ai/workspace";

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
  const next = gap.owned ? `run ${codeSpan(`${gap.remedy} && ${displayCmd()} update`)}` : `${gap.remedy}, then run ${codeSpan(`${displayCmd()} update`)}`;
  const reason = `Connector reconciliation and daemon activation are waiting: ${gap.failure.message}. To finish, ${next}.`;
  const json = args.values.json === true;
  const human = json ? { ...rt, out: () => {}, err: () => {} } : rt;
  const report = (version: string, releaseInstalled = false) => {
    if (json) writeResult("json", { command: "update", target: null, completeness: "partial", result: { version, releaseInstalled, reconciliation: "deferred" }, partial: { message: reason } }, () => ({ sections: [] }));
    else { rt.err(reason); process.exitCode = exitCode("partial", "OPERATION_PARTIAL"); }
  };
  const current = rt.version();
  rt.connectorConfigDeferred = true;
  if (args.values.self !== true) { report(current); return; }
  const latest = latestVersion(rt);
  if (!latest.ok) {
    const code = await handleLatestVersionFailure(latest, current, human, offlineUpdateMessage(false), false);
    if (code !== 0 && json) throw new CommandFailure("failed", "OPERATION_FAILED", "the cotal-ai version check failed; no release was installed");
    report(current);
    if (code !== 0) process.exitCode = code;
    return;
  }
  if (compareSemver(latest.version, current) <= 0) {
    human.out("No newer CLI version.");
    recordConnectorReconciliationDeferred(current, false);
    report(current);
    return;
  }
  const version = latest.version;
  if (rt.env.COTAL_AUTO_UPDATE === "1") {
    const next = await observeUpdateVersion(version) + UPDATE_HOUR_MS;
    if (Date.now() < next) { recordUpdateReleaseHold(version, next); report(current); return; }
  }
  if (!rt.prepareExecution || !rt.executionGlobalRoot || !rt.recoverExecution) throw gap.failure;
  rt.preflightExecution?.();
  const root = rt.executionGlobalRoot();
  if (!isAbsolute(root)) throw new Error("cannot identify the installed CLI for update");
  let execution: ExecutionReplacement | undefined;
  let releaseGlobal: (() => void) | undefined;
  let releaseClosure: (() => void) | undefined;
  try {
    human.out(`Checking cotal-ai@${version} release archives`);
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
      const entry = logicalExecutionEntry();
      if (entry) clearConnectorActivationDeferral(entry, version);
      throw error;
    }
    clearUpdateRecovery();
    execution.complete?.();
    recordConnectorReconciliationDeferred(version, true);
    human.out(`✓ cotal-ai@${version} installed`);
    report(version, true);
  } catch (error) {
    if (!execution && deferStagingFailure(error, version, human, false)) { report(current); return; }
    if (!execution && registryNetworkFailure(error)) { human.out(offlineUpdateMessage(false)); report(current); return; }
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
    else recordConnectorReconciliationDeferred(record.target, true);
    clearUpdateRecovery();
    if (!published && entry) clearConnectorActivationDeferral(entry, record.target);
    execution.complete?.();
    if (!published) return { entry: execution.entry, version: record.previous };
  } finally { try { releaseClosure?.(); } finally { release(); } }
}
