import { join } from "node:path";
import { codeSpan, cotalDirLink, isCommandFailure, isGenuineSpace, isMeshRegistryError, isWorkspaceTargetError, recordsElsewhereText, targetErrorSpace, workspaceErrorParts, type CommandFailure, type MeshTargetError } from "@cotal-ai/workspace";
import { legacyRestartAddressProblem } from "../lib/broker-service.js";
import { channelSeedRestartBlock } from "../lib/channel-seed.js";
import { linkedCotalRemedy } from "../lib/paths.js";
import { displayCmd, displayRemedy } from "../lib/self-exec.js";
import { serviceInstances } from "../lib/service-instances.js";
import { unusableStackJournal } from "../lib/stack-journal.js";
import { rootStoreProblem } from "../lib/store-dir.js";
import { stoppedStackAddressProblem } from "./stack-up.js";
import { servedStack, UnregisteredRoot, type Gaps, type SelectedResult, type StatusResult } from "./status-model.js";

type UnresolvedTarget = Extract<SelectedResult, { resolved: false }>;
type TargetRefusal = readonly [UnresolvedTarget, { name: "target"; verdict: "absent" | "refused"; facts: string[] }];

function targetRefusal(result: UnresolvedTarget, code: string, message: string, remedy?: string): TargetRefusal {
  return [result, { name: "target", verdict: code === "not-started" ? "absent" : "refused", facts: [code, remedy === undefined ? message : `${message} - ${displayRemedy(remedy)}`] }];
}

function recordRefusal(result: UnresolvedTarget, e: CommandFailure): TargetRefusal {
  return [result, { name: "target", verdict: "refused", facts: [e.code, e.message, ...(e.remedy ? [e.remedy] : [])] }];
}

function unusableServiceInstances(space: string): CommandFailure | undefined {
  try { serviceInstances(space); return undefined; }
  catch (error) { return isCommandFailure(error) && error.code === "SCHEMA_INVALID" ? error : undefined; }
}

async function workspaceRefusal(e: MeshTargetError, folder: StatusResult["folder"], gaps: Gaps, hints: string[]): Promise<TargetRefusal> {
  const { message, remedy, restartRoot } = workspaceErrorParts({ kind: "target", error: e });
  const d = e.details, stopped = e.code === "not-started", localRoot = stopped && !d.rootMissing ? d.root : undefined;
  const elsewhere = stopped ? recordsElsewhereText(d) : undefined;
  const held = stopped && d.stopped && !d.unsettled && d.root && d.space ? await stoppedStackAddressProblem(d.root, d.space) : undefined;
  const result: UnresolvedTarget = {
    resolved: false, code: e.code, message: elsewhere ?? (held ? `${message}; ${held.message}` : message),
    ...(d.space !== undefined && localRoot !== undefined ? { space: d.space, root: localRoot } : {}),
    ...(elsewhere !== undefined ? { space: targetErrorSpace(d)!, recordedRoot: d.recordedRoot! } : {}),
  };

  const journal = localRoot === undefined ? undefined : unusableStackJournal(localRoot);
  if (journal) {
    const step = journal.remedy ?? journal.message;
    if (!hints.includes(step)) hints.push(step);
    return recordRefusal(result, journal);
  }
  const blocked = (repair: string) => {
    hints.push(repair);
    return targetRefusal(result, e.code, message);
  };
  const instances = stopped && d.space !== undefined ? unusableServiceInstances(d.space) : undefined;
  if (instances) {
    gaps.add("SERVICE_INSTANCES_UNAVAILABLE", instances.remedy ? `${instances.message}; ${instances.remedy}` : instances.message, { space: d.space, ...(instances.target as object | null) });
    return blocked(instances.remedy ?? instances.message);
  }
  const store = localRoot === undefined ? undefined : rootStoreProblem(localRoot);
  if (store) return blocked(`${store.message}; ${store.remedy}`);
  if (restartRoot !== undefined) {
    const seed = channelSeedRestartBlock(restartRoot);
    if (seed) {
      Object.assign(result, { channelSeedBlocksRestart: true, root: restartRoot });
      return blocked(`Restart blocked: ${seed.message}. ${seed.remedy}`);
    }
    const legacy = d.lastRun ? await legacyRestartAddressProblem(d.server, `${displayCmd()} up`) : undefined;
    if (legacy) { result.message += `; ${legacy.message}`; return blocked(legacy.remedy); }
  }
  if (held) return blocked(held.remedy);
  if (restartRoot !== undefined || !d.unsettled || !servedStack(folder, result)) {
    hints.push(remedy === undefined ? message : displayRemedy(remedy));
  } else if (!folder.stackBlock && !folder.stackUnfinished) hints.push(`start it with ${codeSpan(`${displayCmd()} up`)} in ${d.root}`);
  return targetRefusal(result, e.code, message, remedy);
}

export async function readUnresolvedTarget(e: unknown, folder: StatusResult["folder"], gaps: Gaps, hints: string[], all: boolean): Promise<TargetRefusal> {
  if (isCommandFailure(e) && e.code === "SCHEMA_INVALID") {
    gaps.add(e.code, e.message, e.target);
    if (e.remedy) hints.push(e.remedy);
    return recordRefusal({ resolved: false, code: e.code, message: e.message }, e);
  }
  if (isMeshRegistryError(e)) {
    gaps.add("MESH_REGISTRY_UNREADABLE", e.message, { file: e.file });
    hints.push(e.message);
    return targetRefusal({ resolved: false, code: "registry-unreadable", message: e.message }, "SCHEMA_INVALID", e.message);
  }
  const cmd = displayCmd();
  const unstarted = e instanceof UnregisteredRoot ? e.root : isWorkspaceTargetError(e) && (e.code === "not-started" || e.code === "no-meshes") ? e.details.root : undefined;
  const link = unstarted === undefined ? undefined : cotalDirLink(unstarted);
  if (e instanceof UnregisteredRoot) {
    const message = `no space is registered or prepared here for ${e.root}`;
    hints.push(link === undefined ? `run \`${cmd} up\` in ${e.root} to start one, or select a space with \`${cmd} use <name>\`` : linkedCotalRemedy(e.root, link));
    return targetRefusal({ resolved: false, code: "unregistered-root", message: link === undefined ? message : linkedMessage(e.root, link, cmd) }, "unregistered-root", message);
  }
  if (!isWorkspaceTargetError(e)) throw e;
  if (unstarted !== undefined && link !== undefined) {
    hints.push(linkedCotalRemedy(unstarted, link));
    const { message, remedy } = workspaceErrorParts({ kind: "target", error: e });
    return targetRefusal({ resolved: false, code: "not-started", message: linkedMessage(unstarted, link, cmd) }, e.code, message, remedy);
  }
  if (!all && e.code === "ambiguous-target" && e.details.server === undefined && e.details.spaces && !isGenuineSpace(folder.root)) {
    hints.push(`check the registered spaces with \`${cmd} status --all\``);
    const { message, remedy } = workspaceErrorParts({ kind: "target", error: e });
    return targetRefusal({ resolved: false, code: e.code, message: `multiple spaces are registered but unchecked: ${(e.details.available ?? []).join(", ")}` }, e.code, message, remedy);
  }
  return workspaceRefusal(e, folder, gaps, hints);
}

function linkedMessage(root: string, link: string, cmd: string): string {
  return `${join(root, ".cotal")} is a link to ${link}, and a stack runs only from a folder whose .cotal is its own directory, so \`${cmd} up\` and \`${cmd} down\` refuse it there`;
}
