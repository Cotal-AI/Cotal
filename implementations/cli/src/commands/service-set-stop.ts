import * as prompts from "../lib/prompts.js";
import type { ParsedArgs } from "@cotal-ai/core";
import { ConfirmationRequired, CommandFailure, recordOperationSpace, isCommandFailure, oneLine, presentationOf, renderReport, terminalWidth, writeResult, type Report, type ServiceAdapterStopPlan } from "@cotal-ai/workspace";
import { personaCatalog } from "../lib/persona-files.js";
import { serviceDefinitionStore, type ServiceDefinitionSnapshot } from "../lib/service-definitions.js";
import { instanceProjection, observeServiceProcess, serviceInstances, type ServiceInstanceSnapshot } from "../lib/service-instances.js";
import { preflightProcessServiceStop, prepareNativeServiceStop, selectServiceInstance, stopProcessService } from "../lib/service-process.js";
import { STACK_DEFINITION, stackMemberFor } from "../lib/stack-journal.js";
import { canPrompt } from "./meshes-wizard.js";
import { yesRequired } from "../lib/confirmation-required.js";
import { nativeImpactView, unsavedServiceStep } from "./service-actions.js";
import { resolvePresetService, type PresetServiceTarget } from "../lib/service-preset-target.js";
import { announcePresetTarget, recordedProcessRefusal } from "./service-registry.js";

type Hold = ReturnType<ReturnType<typeof serviceDefinitionStore>["pin"]>;
interface Member { definition: ServiceDefinitionSnapshot; instance: ServiceInstanceSnapshot; requested: string; impact?: ServiceAdapterStopPlan }
interface MemberResult {
  name: string;
  instanceId: string;
  state: "not-attempted" | "cancelled" | "preview" | "original-process-gone" | "refused" | "unknown" | "failed";
  noOp: boolean;
  instance: ReturnType<typeof instanceProjection>;
  instanceObservation: "selection-before-stop" | "stop-result";
  impact: ServiceAdapterStopPlan | null;
  failureCode?: string;
}

function setView(rows: readonly MemberResult[], title: string): Report {
  return { sections: [{ title, blocks: [
    { kind: "table", columns: [{ key: "name", label: "Service" }, { key: "instance", label: "Full instance" }, { key: "host", label: "Execution host" }, { key: "state", label: "Stop result" }], rows: rows.map((row) => ({ name: row.name, instance: row.instanceId, host: row.instance.executionHost, state: { text: row.state.replaceAll("-", " "), tone: row.state === "original-process-gone" ? "ok" as const : row.state === "refused" || row.state === "failed" ? "failed" as const : "waiting" as const } })) },
    { kind: "lines", lines: ["Only the selected owned incarnations are controlled, in the displayed order. This is not atomic and completed stops are not rolled back. Process exit and a returned native stop do not prove descendant, authority or lease cleanup. Failed and unattempted members retain their labeled pre-stop snapshot; no fresh state is inferred."] },
  ] }] };
}

const BROKER_NAMES = new Set(["nats", "broker", STACK_DEFINITION.broker]);

/** Why the set refuses a name that reaches no saved definition, with the step a single named `down`
 *  names. A set never stops the broker, so a broker name names the bare `down` instead. */
function unmatchedMember(space: string, name: string, preset: boolean): CommandFailure {
  const stackName = BROKER_NAMES.has(name) ? undefined : stackMemberFor(space, name);
  return new CommandFailure("refused", "TARGET_NOT_FOUND", `${oneLine(name)} matches no saved definition${preset ? "" : " or preset"} in space ${oneLine(space)}; no service was stopped`, {
    target: { space, name },
    remedy: BROKER_NAMES.has(name) ? "a set of names never stops the broker; a bare cotal down stops it with the whole stack"
      : stackName ? `this space's controller stack names it ${stackName}; name ${stackName} instead, or run bare cotal down to stop the whole stack` : unsavedServiceStep(name, "stop"),
  });
}

function membersStillEligible(members: readonly Member[]): void {
  const processes = new Set<string>();
  for (const member of members) {
    preflightProcessServiceStop(member.definition, member.instance);
    const process = member.instance.record.value.process;
    if (process) {
      const key = `${member.instance.record.value.host.machine}:${member.instance.record.value.host.boot}:${process.pid}:${process.token}`;
      if (processes.has(key)) throw new CommandFailure("refused", "CONFLICT", "several selected records claim the same process incarnation; no service was stopped");
      processes.add(key);
    }
  }
}

function distinctNativeTargets(members: readonly Member[]): void {
  const seen = new Set<string>();
  for (const member of members) {
    const native = member.impact?.native;
    if (!native) continue;
    const key = JSON.stringify([native.endpoint, native.instanceId, native.owner, native.actor, native.lifecycleUid, native.epoch]);
    if (seen.has(key)) throw new CommandFailure("refused", "CONFLICT", "several selected records claim the same native incarnation; no service was stopped");
    seen.add(key);
  }
}

function sameImpact(before: ServiceAdapterStopPlan | undefined, after: ServiceAdapterStopPlan | undefined): boolean {
  if (!before || !after) return before === after;
  return before.scopeSha256 === after.scopeSha256 && before.withAgents === after.withAgents
    && before.native.endpoint === after.native.endpoint && before.native.instanceId === after.native.instanceId
    && before.native.owner === after.native.owner && before.native.actor === after.native.actor
    && before.native.lifecycleUid === after.native.lifecycleUid && before.native.epoch === after.native.epoch;
}

/** All members resolve before preflight. Reservations are acquired in sorted definition order
 *  only after confirmation; every member/impact is rechecked before the first stop. Native
 *  per-member guards still recheck at effect, and a later failure stops the sequence. */
export async function stopNamedServiceSet(args: ParsedArgs): Promise<void> {
  const presentation = presentationOf(args.values), interactive = canPrompt() && presentation !== "json";
  if (args.positionals.length < 2 || new Set(args.positionals).size !== args.positionals.length) throw new CommandFailure("refused", "USAGE_INVALID", "a service set needs several distinct definition names");
  const allowed = new Set(["space", "yes", "dry-run", "json", "plain"]);
  if (Object.keys(args.values).some((key) => !allowed.has(key))) throw new CommandFailure("refused", "USAGE_INVALID", "a service set accepts no per-member instance selector or unreviewed stop policy");
  const { space, root } = personaCatalog(args.values as { space?: string });
  recordOperationSpace(space);
  const store = serviceDefinitionStore(space), members: Member[] = [], presetTargets: PresetServiceTarget[] = [];
  for (const requested of args.positionals) {
    // A preset name reaches the service built on it, as a single named down does.
    let resolved: PresetServiceTarget | undefined;
    try { resolved = resolvePresetService(space, root, requested, "stop", args.values); }
    catch (error) {
      // The broker preset with no saved service built on it still names the broker.
      if (requested === "broker" && isCommandFailure(error) && error.code === "TARGET_NOT_FOUND") throw unmatchedMember(space, requested, true);
      throw error;
    }
    if (resolved?.recorded) throw recordedProcessRefusal(requested, resolved.recorded, space, "down");
    const name = resolved?.name ?? requested, definition = store.read(name);
    if (!definition) throw unmatchedMember(space, name, false);
    const same = members.find((member) => member.definition.name === name);
    if (same) throw new CommandFailure("refused", "USAGE_INVALID", `${oneLine(same.requested)} and ${oneLine(requested)} both name ${oneLine(name)}; name each service once, and no service was stopped`, { target: { space, name } });
    if (resolved) presetTargets.push(resolved);
    const instances = serviceInstances(space, name);
    let selected: ServiceInstanceSnapshot | undefined;
    if (instances.length > 1 && interactive) {
      const id = await prompts.select({ message: `Choose the full owned instance of ${oneLine(name)}`, options: instances.map((row) => ({ value: row.name, label: row.name, hint: `${oneLine(row.record.value.host.name)} · ${observeServiceProcess(row.record.value)}` })) });
      if (prompts.isCancel(id)) { writeResult(presentation, { command: "down", target: { space, names: args.positionals }, result: { kind: "service-set-stop-cancelled", stopped: false }, noOp: true }, () => ({ sections: [{ title: "Services kept", blocks: [{ kind: "lines", lines: ["No stop was submitted."] }] }] })); return; }
      selected = selectServiceInstance(instances, id);
    } else selected = selectServiceInstance(instances, undefined);
    members.push({ definition, instance: selected!, requested });
  }
  for (const resolved of presetTargets) announcePresetTarget(resolved, space, presentation);
  membersStillEligible(members);
  const target = { space, members: members.map((member) => ({ name: member.definition.name, instanceId: member.instance.name, ...(member.requested !== member.definition.name ? { requested: member.requested } : {}) })) };
  const rows: MemberResult[] = members.map((member) => ({ name: member.definition.name, instanceId: member.instance.name, state: "not-attempted", noOp: false, instance: instanceProjection(member.instance), instanceObservation: "selection-before-stop", impact: null }));
  if (args.values["dry-run"]) {
    const preview = rows.map((row): MemberResult => ({ ...row, state: "preview" }));
    writeResult(presentation, { command: "down", target, result: { kind: "service-set-stop-preview", rows: preview, dryRun: true, reserved: false, nativeImpactChecked: false, stopped: false } }, (result) => ({ sections: [...setView(result.rows, "Named service stop preview").sections, { blocks: [{ kind: "lines", lines: ["Metadata and owned process roles only. No provider code, native impact query, reservation, process signal or instance-record write was requested. This preview does not authorize a stop."] }] }] }));
    return;
  }
  if (!args.values.yes && !interactive) throw new ConfirmationRequired(yesRequired("stopping a named service set", presentation === "json"), { target, remedy: `run cotal down ${args.positionals.join(" ")} --yes to stop them; cotal down ${args.positionals.join(" ")} --dry-run shows what it stops` });
  for (const [index, member] of members.entries()) {
    member.impact = await prepareNativeServiceStop(member.definition, member.instance);
    rows[index]!.impact = member.impact ?? null;
  }
  distinctNativeTargets(members);
  if (presentation !== "json") console.log(renderReport({ space, sections: [...setView(rows, "Named service stop review").sections, ...members.flatMap((member) => member.impact ? nativeImpactView(member.impact).sections : [])] }, presentation, terminalWidth(process.stdout)));
  if (!args.values.yes) {
    const answer = await prompts.confirm({ message: "Stop all displayed owned service incarnations with only the displayed native impact?", initialValue: false });
    if (prompts.isCancel(answer) || !answer) {
      const kept = rows.map((row): MemberResult => ({ ...row, state: "cancelled" }));
      writeResult(presentation, { command: "down", target, result: { kind: "service-set-stop", rows: kept, cancelled: true, atomic: false, cleanup: "not-checked" }, noOp: true }, (result) => setView(result.rows, "Services kept"));
      return;
    }
  }
  const holds = new Map<string, Hold>(), releaseUnconfirmed: string[] = [];
  let failure: CommandFailure | undefined;
  try {
    for (const member of [...members].sort((a, b) => a.definition.name < b.definition.name ? -1 : a.definition.name > b.definition.name ? 1 : 0)) holds.set(member.definition.name, store.pin(member.definition));
    for (const hold of holds.values()) hold.check();
    membersStillEligible(members);
    for (const member of members) {
      const fresh = await prepareNativeServiceStop(member.definition, member.instance);
      if (!sameImpact(member.impact, fresh)) throw new CommandFailure("refused", "CONFLICT", "the complete reviewed native impact changed before the first stop; no service was stopped", { target });
      member.impact = fresh;
    }
    distinctNativeTargets(members);
    for (const hold of holds.values()) hold.check();
    membersStillEligible(members);
    for (const [index, member] of members.entries()) {
      try {
        const held = holds.get(member.definition.name);
        if (!held) throw new CommandFailure("refused", "CONFLICT", "a whole-set definition reservation is missing; this member was not stopped");
        held.check();
        const stopped = await stopProcessService(member.definition, member.instance, held, { plan: member.impact, withAgents: false });
        rows[index] = { ...rows[index]!, state: "original-process-gone", noOp: stopped.noOp, instance: instanceProjection(stopped.instance), instanceObservation: "stop-result" };
      } catch (error) {
        const classified = isCommandFailure(error) ? error : undefined;
        const uncertain = classified === undefined || classified.outcome === "unknown";
        rows[index] = { ...rows[index]!, state: uncertain ? "unknown" : classified?.outcome === "refused" ? "refused" : "failed", failureCode: classified?.code ?? "OPERATION_UNKNOWN" };
        const changed = rows.filter((row) => row.state === "original-process-gone" && !row.noOp);
        failure = new CommandFailure(uncertain ? "unknown" : changed.length ? "partial" : classified?.outcome ?? "unknown", uncertain ? "OPERATION_UNKNOWN" : changed.length ? "OPERATION_PARTIAL" : classified?.code ?? "OPERATION_UNKNOWN", "the named service set did not confirm every stop; later members were not attempted and completed stops were not rolled back", { target, changed: changed.map((row) => row.instance), remedy: "inspect the recorded instances before deciding another action; no failed or unknown stop was retried" });
        break;
      }
    }
  } catch (error) {
    const classified = isCommandFailure(error) ? error : undefined;
    failure = new CommandFailure(classified?.outcome ?? "unknown", classified?.code ?? "OPERATION_UNKNOWN", "whole-set reservation or impact preflight did not finish; no member stop was submitted", { target, remedy: "inspect the selected records and native impact before deciding another action; no target or policy was substituted" });
  } finally {
    for (const [name, hold] of [...holds.entries()].reverse()) {
      try { hold.release(); } catch { releaseUnconfirmed.push(name); }
    }
  }
  if (releaseUnconfirmed.length) {
    const uncertain = failure?.outcome === "unknown";
    failure = new CommandFailure(uncertain ? "unknown" : "partial", uncertain ? "OPERATION_UNKNOWN" : "OPERATION_PARTIAL", "local definition reservation release was not confirmed for every member; known stop outcomes are retained", { target, changed: rows.filter((row) => row.state === "original-process-gone" && !row.noOp).map((row) => row.instance), ...(failure ? { native: { code: failure.code, outcome: failure.outcome } } : {}), remedy: "retain the recorded identities and inspect reservation ownership; do not remove locks by pattern or retry unknown stops" });
  }
  writeResult(presentation, { command: "down", target, result: { kind: "service-set-stop", rows, atomic: false, cleanup: "not-checked", reservationRelease: "attempted-not-independently-verified", releaseUnconfirmed }, ...(failure ? { failure, completeness: "partial" as const } : { noOp: rows.every((row) => row.noOp) }) }, (result) => setView(result.rows, failure ? "Service set stop incomplete" : "Original service processes no longer present"));
}
