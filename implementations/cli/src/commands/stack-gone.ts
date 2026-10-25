/** The stop of a controller stack whose folder is gone. Its stack journal and broker configuration
 *  went with the folder, so no member's own stop policy can run. Each member is stopped from the
 *  instance records this machine keeps instead: a live member is sent SIGTERM at its creation-pinned
 *  process, manager first and broker last, after that process is checked to be the one the record
 *  pinned, and its observed exit is recorded on its instance record. Then the stack's saved
 *  definitions, their instance records and the registration naming the folder are removed, so the
 *  space can start in another folder. */
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ParsedArgs } from "@cotal-ai/core";
import {
  CommandFailure, ConfirmationRequired, assertRecordIdentity, canonicalRoot, getCurrent, isCommandFailure, localMeshesForRoot, oneLine, presentationOf,
  readProcessCommand, recordOperationSpace, removeMeshesByRoot, renderReport, terminalWidth, writeResult, type Report,
} from "@cotal-ai/workspace";
import * as prompts from "../lib/prompts.js";
import { cotalRoot } from "../lib/paths.js";
import { canPrompt } from "./meshes-wizard.js";
import { serviceDefinitionStore, type ServiceDefinitionSnapshot } from "../lib/service-definitions.js";
import { observeServiceProcess, serviceInstances, serviceInstanceStore, type ServiceInstanceSnapshot } from "../lib/service-instances.js";
import { assertNoServiceUnitAttempts } from "../lib/service-process.js";
import { refuseRecordedSupervisor } from "../lib/service-supervision.js";
import { STACK_DEFINITION, goneStackRoot, processGone, stackDefinitionsAt, type StackRole } from "../lib/stack-journal.js";

const STOP_ORDER: readonly StackRole[] = ["manager", "delivery", "auth", "broker"];
/** How long a member has to exit after SIGTERM. The manager first stops its agents by its default policy. */
const EXIT_WINDOW_MS: Readonly<Record<StackRole, number>> = { manager: 90_000, delivery: 30_000, auth: 30_000, broker: 30_000 };
const delay = (ms: number) => new Promise<void>((done) => setTimeout(done, ms));

interface Member { role: StackRole; definition: ServiceDefinitionSnapshot; instance: ServiceInstanceSnapshot; pid: number | null; live: boolean }
interface Stopped { role: StackRole; definition: string; instanceId: string; pid: number | null; result: "stopped" | "already-stopped"; signal?: "SIGTERM"; observedAt?: string }

/** The space and gone folder a whole-stack `down` names: `--space`, or else the space registered for
 *  this folder, or else, when this folder holds no `.cotal` of its own, the selected space. Undefined
 *  when that space's stack folder is not gone, or for a manifest, run or preserve stop. */
export function goneRootDown(values: ParsedArgs["values"]): { space: string; root: string } | undefined {
  if (["file", "run", "preserve-state", "store-dir"].some((flag) => values[flag] !== undefined)) return undefined;
  let space: string | undefined;
  try {
    if (typeof values.space === "string") space = values.space;
    else {
      const here = canonicalRoot(cotalRoot()), local = localMeshesForRoot(here);
      space = local.length === 1 ? local[0]!.space : local.length || existsSync(join(here, ".cotal")) && here !== canonicalRoot(homedir()) ? undefined : getCurrent();
    }
  } catch { return undefined; }
  const root = space === undefined ? undefined : goneStackRoot(space);
  return space !== undefined && root !== undefined ? { space, root } : undefined;
}

/** A refusal to connect to a space, restated when the folder its stack started in is gone: the seed
 *  went with it, and `down --space` stops the stack it left running. Any other refusal as it is. */
export function goneStackRefusal(failure: CommandFailure): CommandFailure {
  const { space, root } = (failure.target ?? {}) as { space?: unknown; root?: unknown };
  if (failure.code !== "DEPENDENCY_UNAVAILABLE" || typeof space !== "string" || typeof root !== "string") return failure;
  const gone = goneStackRoot(space);
  if (gone === undefined || canonicalRoot(gone) !== canonicalRoot(root)) return failure;
  return new CommandFailure("refused", "DEPENDENCY_UNAVAILABLE", `space "${space}" started in ${root}, and that folder is gone with the seed it held, so no credential for its stack can be made here`, {
    target: failure.target, remedy: `stop the stack it left running and free its name with cotal down --space ${space} --yes`,
  });
}

/** A gone folder's stop takes only --space, --yes, --dry-run and the presentation flags. */
export function validateGoneRootDownArguments(values: ParsedArgs["values"]): void {
  const allowed = new Set(["space", "yes", "dry-run", "json", "plain"]);
  const unsupported = Object.keys(values).filter((name) => !allowed.has(name) && values[name] !== undefined && !(Array.isArray(values[name]) && (values[name] as unknown[]).length === 0));
  if (unsupported.length) throw new CommandFailure("refused", "USAGE_INVALID", `the stack's folder is gone, so down stops its members by signal and takes only --space, --yes, --dry-run and presentation flags; ${unsupported.map((name) => `--${name}`).join(", ")} cannot apply, and nothing was stopped`, { remedy: "run it again without them" });
  if (values["dry-run"] === true && values.yes === true) throw new CommandFailure("refused", "USAGE_INVALID", "--yes acknowledges a guarded apply, not a read-only stack preview");
}

/** Every instance of the stack's saved definitions, in stop order. One whose process cannot be
 *  placed as running or gone, or that a native unit supervises, refuses before any signal. */
function readMembers(space: string, root: string): Member[] {
  const definitions = stackDefinitionsAt(space, root), members: Member[] = [];
  for (const role of STOP_ORDER) {
    const definition = definitions.find((row) => row.name === STACK_DEFINITION[role]);
    if (!definition) continue;
    assertNoServiceUnitAttempts(space, definition.name);
    for (const instance of serviceInstances(space, definition.name)) {
      refuseRecordedSupervisor(instance.record.value, "stop");
      const state = observeServiceProcess(instance.record.value);
      if (state !== "running" && !processGone(state)) throw new CommandFailure("refused", "LIFECYCLE_BLOCKED", `the ${role}'s instance ${instance.name} is ${state === "foreign-host" ? "recorded on another machine" : "unreadable or has an unresolved launch"}, so whether it runs is not known; no member was stopped`, {
        target: { space, root, definition: definition.name, instanceId: instance.name, process: state },
        remedy: `inspect it with cotal service status ${definition.name} --instance ${instance.name} --space ${space}`,
      });
      members.push({ role, definition, instance, pid: instance.record.value.process?.pid ?? null, live: state === "running" });
    }
  }
  return members;
}

function planView(space: string, root: string, members: readonly Member[]): Report {
  return { space, sections: [{ title: "Stack whose folder is gone", blocks: [
    { kind: "fields", rows: [["Space", space], ["Folder", { text: `${root} · gone`, tone: "failed" }]] },
    members.length ? { kind: "table", columns: [{ key: "role", label: "Member" }, { key: "definition", label: "Definition" }, { key: "instance", label: "Full instance" }, { key: "pid", label: "Pid" }, { key: "process", label: "Process" }],
      rows: members.map((member) => ({ role: member.role, definition: member.definition.name, instance: member.instance.name, pid: member.pid === null ? "none" : String(member.pid), process: { text: member.live ? "running" : "gone", tone: member.live ? "waiting" : "hint" } })) }
      : { kind: "lines", lines: ["No member has a recorded instance, so there is nothing to stop."] },
    { kind: "lines", lines: [
      "The folder's stack journal and broker configuration are not at that path, as when the folder was removed, moved or renamed, so no member's own stop can run. down --yes sends SIGTERM to each running member's recorded process, manager first and broker last, after it checks that the process is still the one its record pinned, and records each exit.",
      "Then it removes the stack's saved definitions and the registration naming the folder, so the space can start in another folder. The manager stops its agents by its default policy.",
    ] },
  ] }] };
}

/** Stop one live member: identity and role are rechecked under its definition's lock, the record is
 *  marked stopping, the pinned process gets SIGTERM, and its exit is recorded as stopped. */
async function stopMember(space: string, member: Member): Promise<Stopped> {
  const hold = serviceDefinitionStore(space).pin(member.definition);
  try {
    const store = serviceInstanceStore(space);
    const current = store.read(member.instance.name);
    if (!current || current.hash !== member.instance.hash) throw new CommandFailure("refused", "CONFLICT", `the ${member.role}'s instance record changed before its stop; it was not signalled`, { target: { space, instanceId: member.instance.name } });
    const target = { ...current.record.value.process! };
    if (readProcessCommand(target.pid).kind !== "command" || assertRecordIdentity(target).kind !== "match") throw new CommandFailure("refused", "LIFECYCLE_BLOCKED", `the ${member.role}'s process ${target.pid} could not be shown to be the one its record pinned; it was not signalled`, { target: { space, instanceId: member.instance.name, pid: target.pid } });
    store.commit(current.name, current, { ...current.record.value, state: "stopping", requestId: randomUUID(), updatedAt: new Date().toISOString() });
    const stopping = store.read(current.name)!;
    try { process.kill(target.pid, "SIGTERM"); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw new CommandFailure("unknown", "OPERATION_UNKNOWN", `SIGTERM to the ${member.role}'s process ${target.pid} was not confirmed delivered; its record stays stopping`, { target: { space, instanceId: member.instance.name, pid: target.pid } }); }
    const deadline = Date.now() + EXIT_WINDOW_MS[member.role];
    while (Date.now() < deadline) {
      if (processGone(observeServiceProcess(stopping.record.value))) {
        const observedAt = new Date().toISOString();
        store.commit(stopping.name, stopping, { ...stopping.record.value, state: "stopped", readiness: "not-checked", adapterReadiness: undefined, updatedAt: observedAt });
        return { role: member.role, definition: member.definition.name, instanceId: member.instance.name, pid: target.pid, result: "stopped", signal: "SIGTERM", observedAt };
      }
      await delay(100);
    }
    throw new CommandFailure("unknown", "OPERATION_UNKNOWN", `the ${member.role}'s process ${target.pid} did not exit within ${EXIT_WINDOW_MS[member.role] / 1000} s of SIGTERM; it was not killed, and later members were not stopped`, {
      target: { space, instanceId: member.instance.name, pid: target.pid },
      remedy: `run cotal down --space ${space} --yes again once process ${target.pid} has exited`,
    });
  } finally { hold.release(); }
}

/** Remove each stack definition with its instance records, once none of their processes runs. */
function releaseDefinitions(space: string, root: string): string[] {
  const store = serviceDefinitionStore(space), instances = serviceInstanceStore(space), released: string[] = [];
  for (const definition of stackDefinitionsAt(space, root)) {
    assertNoServiceUnitAttempts(space, definition.name);
    store.commit(definition.name, definition, undefined, () => {
      for (const row of serviceInstances(space, definition.name)) {
        if (!processGone(observeServiceProcess(row.record.value))) throw new CommandFailure("refused", "CONFLICT", `the ${definition.name} instance ${row.name} runs again; its definition was kept`, { target: { space, instanceId: row.name } });
        instances.commit(row.name, row, undefined);
      }
    });
    released.push(definition.name);
  }
  return released;
}

/** `cotal down` for a controller stack whose folder is gone. */
export async function goneRootStackDown(space: string, root: string, values: ParsedArgs["values"]): Promise<void> {
  validateGoneRootDownArguments(values);
  recordOperationSpace(space);
  const presentation = presentationOf(values), target = { space, root };
  const members = readMembers(space, root);
  if (values["dry-run"] === true) {
    writeResult(presentation, { command: "down", target, result: { kind: "gone-root-stack-stop-preview", ...target, members: members.map((member) => ({ role: member.role, definition: member.definition.name, instanceId: member.instance.name, pid: member.pid, process: member.live ? "running" : "gone" })) }, noOp: true }, () => {
      const view = planView(space, root, members);
      return { ...view, sections: [...view.sections, { title: "Preview", blocks: [{ kind: "lines", lines: ["Nothing was stopped or written."] }] }] };
    });
    return;
  }
  if (!values.yes && !(canPrompt() && presentation !== "json")) throw new ConfirmationRequired(`stopping the stack of ${space}, whose folder ${root} is gone, requires --yes outside an interactive terminal`, { target, remedy: `run \`cotal down --space ${space} --yes\` to stop it; \`cotal down --space ${space} --dry-run\` shows what it stops` });
  if (presentation !== "json") console.log(renderReport(planView(space, root, members), presentation, terminalWidth(process.stdout)));
  if (!values.yes) {
    const answer = await prompts.confirm({ message: `Stop every displayed member of ${oneLine(space)}'s stack by signal and remove its saved definitions?`, initialValue: false });
    if (prompts.isCancel(answer) || !answer) {
      writeResult(presentation, { command: "down", target, result: { kind: "gone-root-stack-stop", ...target, cancelled: true }, noOp: true, warnings: [{ code: "USER_CANCELLED", target, message: "no member was stopped" }] }, () => planView(space, root, members));
      return;
    }
  }
  const stopped: Stopped[] = [];
  for (const member of members) {
    if (!member.live) { stopped.push({ role: member.role, definition: member.definition.name, instanceId: member.instance.name, pid: member.pid, result: "already-stopped" }); continue; }
    try { stopped.push(await stopMember(space, member)); }
    catch (error) {
      if (!isCommandFailure(error) || !stopped.some((row) => row.result === "stopped")) throw error;
      throw new CommandFailure(error.outcome === "unknown" ? "unknown" : "partial", error.outcome === "unknown" ? "OPERATION_UNKNOWN" : "OPERATION_PARTIAL", `${error.message}; the members before it were stopped and the saved definitions were kept`, { target: error.target, changed: stopped.filter((row) => row.result === "stopped"), remedy: error.remedy ?? `run cotal down --space ${space} --yes again` });
    }
  }
  let released: string[];
  try { released = releaseDefinitions(space, root); removeMeshesByRoot(root, space); }
  catch (error) {
    throw new CommandFailure("partial", "OPERATION_PARTIAL", `every member stopped, but removing the saved definitions or the registration did not confirm (${error instanceof Error ? error.message : String(error)})`, { target, changed: stopped, remedy: `run cotal down --space ${space} --yes again` });
  }
  writeResult(presentation, { command: "down", target, result: { kind: "gone-root-stack-stop", ...target, members: stopped, releasedDefinitions: released } }, (): Report => ({ space, sections: [
    { title: "Stack stopped; its folder was gone", blocks: [
      { kind: "fields", rows: [["Space", space], ["Folder", `${root} · gone`]] },
      { kind: "table", columns: [{ key: "role", label: "Member" }, { key: "instance", label: "Full instance" }, { key: "pid", label: "Pid" }, { key: "state", label: "Result" }], rows: stopped.map((row) => ({ role: row.role, instance: row.instanceId, pid: row.pid === null ? "none" : String(row.pid), state: { text: row.result === "stopped" ? "stopped by SIGTERM" : "already stopped", tone: "ok" } })) },
      { kind: "lines", lines: [`Removed the saved definitions ${released.join(", ") || "(none were saved)"} and the registration naming the folder.${existsSync(root) ? ` The broker wrote ${root} back while it ran; that folder was left as it is.` : ""}`] },
    ] },
    // A folder moved or renamed with its records keeps the journal, store and trust, and adopting them
    // where it is now keeps its history, as `up` run there names.
    { title: "Next", blocks: [{ kind: "commands", items: [
      { command: `cotal space create ${space} --adopt --root <folder>`, description: "If the folder was moved or renamed, adopt its records where it is now, which keeps its history, then run cotal up there" },
      { command: `cotal space create ${space}`, description: "Otherwise prepare the space in another folder, then run cotal up there" },
    ] }] },
  ] }));
}
