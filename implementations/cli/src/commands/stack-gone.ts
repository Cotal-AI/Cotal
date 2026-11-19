/** The stop of a controller stack whose folder is gone. Its stack journal and broker configuration
 *  went with the folder, so no member's own stop policy can run. Each member is stopped from the
 *  instance records this machine keeps instead: a live member is sent SIGTERM at its creation-pinned
 *  process, manager first and broker last, after that process is checked to be the one the record
 *  pinned, and its observed exit is recorded on its instance record. Then the stack's saved
 *  definitions, their instance records and the registration naming the folder are removed, so the
 *  space can start in another folder. */
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, readlinkSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ParsedArgs } from "@cotal-ai/core";
import {
  CommandFailure, ConfirmationRequired, assertRecordIdentity, canonicalRoot, findMesh, getCurrent, identityRecord, isCommandFailure, loadMeshes, localMeshesForRoot, loopbackListeners, oneLine, presentationOf, processesNaming,
  readProcessCommand, recordOperationSpace, removeMesh, removeMeshesByRoot, renderReport, writeResult, type Report,
} from "@cotal-ai/workspace";
import * as prompts from "../lib/prompts.js";
import { cotalRoot } from "../lib/paths.js";
import { canPrompt } from "./meshes-wizard.js";
import { serviceDefinitionStore, type ServiceDefinitionSnapshot } from "../lib/service-definitions.js";
import { observeServiceProcess, serviceInstances, serviceInstanceStore, type ServiceInstanceSnapshot } from "../lib/service-instances.js";
import { assertNoServiceUnitAttempts, pruneEmptyServiceSpace, removeInstanceSidecars, removeServiceLogs } from "../lib/service-process.js";
import { removeCustodyCapability } from "../lib/service-custody-win32.js";
import { refuseRecordedSupervisor } from "../lib/service-supervision.js";
import { STACK_DEFINITION, stackRecoveryHost, goneStackRoot, processGone, runningStackRoles, stackDefinitionsAt, type StackRole } from "../lib/stack-journal.js";

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
  const root = space === undefined ? undefined : goneStackRoot(space) ?? goneLegacyRoot(space);
  return space !== undefined && root !== undefined ? { space, root } : undefined;
}

/** A locally started retained stack whose process records and broker configuration went away. */
export function goneLegacyRoot(space: string): string | undefined {
  const mesh = findMesh(space);
  if (!mesh || mesh.origin === "manual" || mesh.origin === "catalog") return undefined;
  if (stackDefinitionsAt(space, mesh.root).length) return undefined;
  if (existsSync(mesh.root) && !existsSync(join(mesh.root, ".cotal", "nats"))) return undefined;
  return ["nats.pid", "auth/server.conf", "server-open.conf"].some((path) => existsSync(join(mesh.root, ".cotal", path))) ? undefined : mesh.root;
}

/** Find only this account's retained children with exact launch arguments and the registered cwd.
 *  An address alone never authorizes a signal, and a creation pin is rechecked before each stop. */
export function goneLegacyMembers(space: string, root: string): { role: StackRole; pid: number; token: string }[] {
  if (process.platform !== "linux") throw new CommandFailure("refused", "UNSUPPORTED", "finding a retained stack after its folder is deleted requires Linux process arguments and working directories; nothing was stopped");
  const mesh = findMesh(space);
  if (!mesh || mesh.root !== root) throw new CommandFailure("refused", "CONFLICT", "the deleted stack's registration changed; nothing was stopped");
  const found = processesNaming("");
  if (found.kind !== "pids") throw new CommandFailure("refused", "LIFECYCLE_BLOCKED", `could not inspect the deleted stack's processes (${found.why}); its registration was kept`);
  const members: { role: StackRole; pid: number; token: string }[] = [];
  for (const pid of found.pids) {
    let argv: string[], cwd: string;
    try {
      argv = readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0").filter(Boolean);
      cwd = readlinkSync(`/proc/${pid}/cwd`).replace(/ \(deleted\)$/, "");
    } catch { continue; }
    if (cwd !== root) continue;
    const option = (name: string, value: string): boolean => argv.some((arg, index) => arg === name && argv[index + 1] === value);
    let role: StackRole | undefined;
    if (option("--space", space) && option("--server", mesh.server)) {
      if (argv.includes("__daemon-manager")) role = "manager";
      else if (argv.includes("__daemon-deliver")) role = "delivery";
    }
    if (/(^|\/)nats-server$/.test(argv[0] ?? "") && ["auth/server.conf", "server-open.conf"].some((config) => option("-c", join(root, ".cotal", config)))) role = "broker";
    if (!role) continue;
    const identity = identityRecord(pid);
    if (!("token" in identity)) throw new CommandFailure("refused", "LIFECYCLE_BLOCKED", `the deleted stack's ${role} process ${pid} has no readable creation identity; nothing was stopped`);
    members.push({ role, pid, token: identity.token });
  }
  return members.sort((a, b) => STOP_ORDER.indexOf(a.role) - STOP_ORDER.indexOf(b.role));
}

async function goneLegacyDown(space: string, root: string, values: ParsedArgs["values"]): Promise<void> {
  const target = { space, root }, presentation = presentationOf(values);
  const members = goneLegacyMembers(space, root);
  const mesh = findMesh(space)!;
  if (mesh.mode === "user") throw new CommandFailure("refused", "UNSUPPORTED", "the deleted retained stack uses user authentication, whose service cannot be recovered from these process arguments; its registration was kept", { target });
  if (loadMeshes().some((other) => other.space !== space && other.server === mesh.server)) throw new CommandFailure("refused", "LIFECYCLE_BLOCKED", "another space names this broker address; no deleted-stack process was stopped", { target });
  if (loopbackListeners(mesh.server).some((pid) => !members.some((member) => member.role === "broker" && member.pid === pid))) throw new CommandFailure("refused", "LIFECYCLE_BLOCKED", "the broker address has a listener that cannot be attributed to this deleted stack; nothing was stopped", { target });
  const report = (): Report => ({ space, sections: [{ title: "Retained stack whose folder is gone", blocks: [
    { kind: "lines", lines: [`Folder: ${root}`, ...members.map((member) => `${member.role}: pid ${member.pid}`), "Each process gets SIGTERM, manager first and broker last. The manager uses its default agent policy."] },
  ] }] });
  if (values["dry-run"] === true) {
    writeResult(presentation, { command: "down", target, result: { kind: "gone-root-stack-stop-preview", ...target, members }, noOp: true }, report);
    return;
  }
  if (!values.yes) throw new ConfirmationRequired("stopping a retained stack whose folder is gone requires --yes", { target, remedy: `run \`cotal down --space ${space} --yes\`; \`cotal down --space ${space} --dry-run\` lists its processes` });
  const stopped: { role: StackRole; pid: number; result: "stopped" | "already-stopped" }[] = [];
  for (const member of members) {
    const identity = assertRecordIdentity(member);
    if (identity.kind === "gone" || identity.kind === "mismatch") { stopped.push({ role: member.role, pid: member.pid, result: "already-stopped" }); continue; }
    if (identity.kind !== "match") throw new CommandFailure("refused", "LIFECYCLE_BLOCKED", `the ${member.role} process ${member.pid} could not be verified; its registration was kept`, { target });
    try { process.kill(member.pid, "SIGTERM"); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; }
    const deadline = Date.now() + EXIT_WINDOW_MS[member.role];
    while (Date.now() < deadline && assertRecordIdentity(member).kind === "match") await delay(100);
    const after = assertRecordIdentity(member);
    if (after.kind !== "gone" && after.kind !== "mismatch") throw new CommandFailure("unknown", "OPERATION_UNKNOWN", `the ${member.role} process ${member.pid} has not confirmed exit; later members were not stopped and its registration was kept`, { target, changed: stopped, remedy: `run \`cotal down --space ${space} --yes\` again once it exits` });
    stopped.push({ role: member.role, pid: member.pid, result: "stopped" });
  }
  if (goneLegacyMembers(space, root).length) throw new CommandFailure("partial", "OPERATION_PARTIAL", "another retained stack process appeared during shutdown; the registration was kept", { target, changed: stopped });
  removeMeshesByRoot(root, space);
  writeResult(presentation, { command: "down", target, result: { kind: "gone-root-stack-stop", ...target, members: stopped, releasedDefinitions: [] } }, () => ({ space, sections: [{ title: "Stack stopped; its folder was gone", blocks: [{ kind: "lines", lines: stopped.map((member) => `${member.role} (pid ${member.pid}): ${member.result}`) }] }] }));
}

/** A refusal to connect to a space, restated when the folder its stack started in is gone: the seed
 *  went with it, and `down --space` stops the stack it left running. Any other refusal as it is. */
export function goneStackRefusal(failure: CommandFailure): CommandFailure {
  const { space, root } = (failure.target ?? {}) as { space?: unknown; root?: unknown };
  if (!["DEPENDENCY_UNAVAILABLE", "TARGET_UNAVAILABLE"].includes(failure.code) || typeof space !== "string" || typeof root !== "string") return failure;
  const gone = goneStackRoot(space);
  if (gone === undefined || canonicalRoot(gone) !== canonicalRoot(root)) return failure;
  const native = findMesh(space);
  const nativeRunning = native?.nativeHost === stackRecoveryHost() && native.nativeMembers?.some((member) => assertRecordIdentity(member.process).kind === "match");
  if (!nativeRunning && runningStackRoles(space).length === 0) return failure;
  return new CommandFailure("refused", "DEPENDENCY_UNAVAILABLE", `space "${space}" started in ${root}, and that folder is gone with the seed it held, so no credential for its stack can be made here`, {
    target: failure.target, remedy: `stop the stack it left running and free its name with \`cotal down --space ${space} --yes\``,
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
        remedy: `inspect it with \`cotal service status ${definition.name} --instance ${instance.name} --space ${space}\``,
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
      remedy: `run \`cotal down --space ${space} --yes\` again once process ${target.pid} has exited`,
    });
  } finally { hold.release(); }
}

/** Remove each stack definition with its instance records, once none of their processes runs. */
function releaseDefinitions(space: string, root: string): string[] {
  const store = serviceDefinitionStore(space), instances = serviceInstanceStore(space), released: string[] = [], retired: string[] = [];
  for (const definition of stackDefinitionsAt(space, root)) {
    assertNoServiceUnitAttempts(space, definition.name);
    store.commit(definition.name, definition, undefined, () => {
      for (const row of serviceInstances(space, definition.name)) {
        if (!processGone(observeServiceProcess(row.record.value))) throw new CommandFailure("refused", "CONFLICT", `the ${definition.name} instance ${row.name} runs again; its definition was kept`, { target: { space, instanceId: row.name } });
        instances.commit(row.name, row, undefined);
        removeCustodyCapability(space, row.record.value.custody);
        removeInstanceSidecars(space, row.name, row.record.value.launchRequestId);
        retired.push(row.name);
      }
    });
    released.push(definition.name);
  }
  removeServiceLogs(space, retired);
  pruneEmptyServiceSpace(space);
  return released;
}

/** `cotal down` for a controller stack whose folder is gone. */
export async function goneRootStackDown(space: string, root: string, values: ParsedArgs["values"]): Promise<void> {
  validateGoneRootDownArguments(values);
  recordOperationSpace(space);
  const presentation = presentationOf(values), target = { space, root };
  if (!stackDefinitionsAt(space, root).length) {
    const native = findMesh(space);
    // Only pre-pin registrations use process discovery. Never fall back around a recorded pin.
    if (native?.origin !== "up" || (native.nativeHost === undefined && native.nativeMembers === undefined)) return goneLegacyDown(space, root, values);
    if (native.nativeHost !== stackRecoveryHost()) throw new CommandFailure("refused", "TARGET_UNAVAILABLE", "the native stack registration does not pin this machine, boot and account; no process was stopped", { target, remedy: "restore the project folder, then stop its stack from the launching machine and account" });
    const members = native.nativeMembers;
    if (!members?.length) throw new CommandFailure("refused", "TARGET_UNAVAILABLE", "the stack's folder is gone and its registration has no creation-pinned members; no process was stopped", { target, remedy: "restore the project folder to its recorded path, then run `cotal down --yes` there" });
    for (const member of members) {
      const identity = assertRecordIdentity(member.process).kind;
      if (identity !== "match" && identity !== "gone" && identity !== "mismatch") throw new CommandFailure("refused", "TARGET_UNAVAILABLE", `the ${member.role}'s recorded process identity cannot be checked; nothing was stopped`, { target });
    }
    const stopped: { role: StackRole; pid: number; result: "stopped" | "already-stopped" }[] = [];
    if (values["dry-run"] !== true) {
      if (!values.yes) throw new ConfirmationRequired("stopping the creation-pinned members of a missing folder requires --yes", { target, remedy: `run \`cotal down --space ${space} --yes\`` });
      for (const member of [...members].sort((a, b) => STOP_ORDER.indexOf(a.role) - STOP_ORDER.indexOf(b.role))) {
        const before = assertRecordIdentity(member.process).kind;
        if (before === "gone" || before === "mismatch") {
          stopped.push({ role: member.role, pid: member.process.pid, result: "already-stopped" });
          continue;
        }
        if (before !== "match") throw new CommandFailure("refused", "TARGET_UNAVAILABLE", `the ${member.role}'s process identity became unavailable; later members were not stopped`, { target });
        try { process.kill(member.process.pid, "SIGTERM"); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw new CommandFailure("unknown", "OPERATION_UNKNOWN", `SIGTERM to the ${member.role} was not confirmed; later members were not stopped`, { target }); }
        const deadline = Date.now() + EXIT_WINDOW_MS[member.role];
        while (assertRecordIdentity(member.process).kind === "match" && Date.now() < deadline) await delay(100);
        const after = assertRecordIdentity(member.process).kind;
        if (after !== "gone" && after !== "mismatch") throw new CommandFailure("unknown", "OPERATION_UNKNOWN", `the ${member.role}'s exit after SIGTERM was not confirmed; later members were not stopped`, { target });
        stopped.push({ role: member.role, pid: member.process.pid, result: "stopped" });
      }
      removeMesh(space);
    }
    const preview = values["dry-run"] === true;
    const result = preview
      ? { kind: "gone-root-stack-stop-preview", ...target, members }
      : { kind: "gone-root-stack-stop", ...target, members: stopped, releasedDefinitions: [] };
    writeResult(presentation, { command: "down", target, result, noOp: preview }, () => ({ space, sections: [{ title: values["dry-run"] ? "Missing-folder stack preview" : "Stack stopped; its folder was gone", blocks: [{ kind: "lines", lines: [root, ...members.map((member) => `${member.role}: pid ${member.process.pid}`)] }] }] }));
    return;
  }
  const members = readMembers(space, root);
  if (values["dry-run"] === true) {
    writeResult(presentation, { command: "down", target, result: { kind: "gone-root-stack-stop-preview", ...target, members: members.map((member) => ({ role: member.role, definition: member.definition.name, instanceId: member.instance.name, pid: member.pid, process: member.live ? "running" : "gone" })) }, noOp: true }, () => {
      const view = planView(space, root, members);
      return { ...view, sections: [...view.sections, { title: "Preview", blocks: [{ kind: "lines", lines: ["Nothing was stopped or written."] }] }] };
    });
    return;
  }
  if (!values.yes && !(canPrompt() && presentation !== "json")) throw new ConfirmationRequired(`stopping the stack of ${space}, whose folder ${root} is gone, requires --yes outside an interactive terminal`, { target, remedy: `run \`cotal down --space ${space} --yes\` to stop it; \`cotal down --space ${space} --dry-run\` shows what it stops` });
  if (presentation !== "json") console.log(renderReport(planView(space, root, members), presentation, process.stdout));
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
      throw new CommandFailure(error.outcome === "unknown" ? "unknown" : "partial", error.outcome === "unknown" ? "OPERATION_UNKNOWN" : "OPERATION_PARTIAL", `${error.message}; the members before it were stopped and the saved definitions were kept`, { target: error.target, changed: stopped.filter((row) => row.result === "stopped"), remedy: error.remedy ?? `run \`cotal down --space ${space} --yes\` again` });
    }
  }
  let released: string[];
  try { released = releaseDefinitions(space, root); removeMeshesByRoot(root, space); }
  catch (error) {
    throw new CommandFailure("partial", "OPERATION_PARTIAL", `every member stopped, but removing the saved definitions or the registration did not confirm (${error instanceof Error ? error.message : String(error)})`, { target, changed: stopped, remedy: `run \`cotal down --space ${space} --yes\` again` });
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
      { command: `cotal space create ${space} --adopt --root <folder>`, description: "If the folder was moved or renamed, adopt its records where it is now, which keeps its history, then run `cotal up` there" },
      { command: `cotal space create ${space}`, description: "Otherwise prepare the space in another folder, then run `cotal up` there" },
    ] }] },
  ] }));
}
