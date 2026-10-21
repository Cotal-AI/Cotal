/** The read-only eligibility gate for a team boot that resumes one exact stopped controller stack
 *  whose manager was never attempted. It reads the stack journal, each member's saved definition
 *  and exact instance record, and each role's own native terminal evidence. It writes nothing and
 *  infers no stop from process absence: a member whose role has no stronger native stop evidence
 *  than a settled stopped record, released custody and gone process is named as such, and any
 *  unknown, partial or unresolved state refuses. The result binds the exact bytes it read so the
 *  caller can recheck them under its maintenance lock before the first effect. */
import { createHash } from "node:crypto";
import {
  AUTH_PIDFILE, CommandFailure, DELIVERY_PIDFILE, MANAGER_PIDFILE, MANAGER_SHUTDOWN_INTENT, canonicalLocalProcessPath, canonicalRoot,
  readLocalRecordSource, stopReservationPath,
} from "@cotal-ai/workspace";
import { serviceDefinitionStore } from "./service-definitions.js";
import { observeServiceProcess, serviceInstances, serviceInstanceStore } from "./service-instances.js";
import { assertNoServiceUnitAttempts, removableServiceInstances } from "./service-process.js";
import { serviceSupervisorStore } from "./service-supervision.js";
import { freshTeamAttemptSettled, listFreshTeamAttempts, listFreshTeamSummaries } from "./team-fresh.js";
import { readStackJournal, stackMaintenanceFence, stackRoleApplies, STACK_ADAPTER, STACK_DEFINITION, type StackJournal, type StackRole } from "./stack-journal.js";

/** What a member's stop is proved by. `kernel-exit`: the broker's exact-exit receipt. `process-exit`:
 *  the generic stop's own receipt that it signalled this pinned process and saw it exit, plus the
 *  settled record and released native custody. `process`: the same without that receipt, the
 *  strongest evidence an earlier generic stop recorded. Both generic kinds are accepted here. */
export type StackResumeEvidence = "kernel-exit" | "process-exit" | "process";

export interface StackResumeBinding {
  root: string;
  space: string;
  server: string;
  mode: StackJournal["mode"];
  journalSha256: string;
  priorDown: string;
  broker: NonNullable<StackJournal["broker"]>;
  members: { role: StackRole; definition: string; definitionRevision: string; definitionSha256: string; instanceId: string; instanceRevision: string; instanceSha256: string; evidence: StackResumeEvidence }[];
  manager: { definition: "absent" };
}

const refuse = (code: "LIFECYCLE_BLOCKED" | "CONFLICT" | "TARGET_UNAVAILABLE", message: string, target: Record<string, unknown>, remedy?: string): never => {
  throw new CommandFailure("refused", code, message, { target, ...(remedy ? { remedy } : {}) });
};

/** Exact custody record of a role's native child; present means it may still be held. */
function custodyRetained(root: string, space: string, template: string): boolean {
  return readLocalRecordSource(canonicalLocalProcessPath(template, { root, space }), 128, true) !== undefined;
}

export function stackResumeEligibility(rootInput: string, space: string, expected: { server: string; mode: StackJournal["mode"] }, ownAttempt?: string): StackResumeBinding {
  const root = canonicalRoot(rootInput);
  const snapshot = readStackJournal(root);
  if (!snapshot) return refuse("TARGET_UNAVAILABLE", "this root records no controller stack to resume", { root, space });
  const journal = snapshot.journal, target = { root, space, operation: journal.operation.id };
  if (journal.space !== space || journal.server !== expected.server || journal.mode !== expected.mode)
    refuse("CONFLICT", "the recorded stack names another space, broker address or auth mode than this manifest; nothing was resumed", { ...target, recorded: { space: journal.space, server: journal.server, mode: journal.mode } });
  if (journal.operation.kind !== "down" || journal.operation.phase !== "completed")
    refuse("LIFECYCLE_BLOCKED", "the recorded stack's last operation is not a completed whole-stack stop; only a confirmed stopped stack is resumed", { ...target, last: { kind: journal.operation.kind, phase: journal.operation.phase } }, `stop it with cotal down, or inspect its members with cotal service --space ${space}`);
  if (!journal.broker) refuse("LIFECYCLE_BLOCKED", "the recorded stack predates its recorded broker inputs; its store and cap cannot be frozen, so it is not resumed by a team boot", target, `restart it once with its original store named explicitly (cotal up --store-dir <original store dir> [--max-file-store <bytes>] [--host <host>] --space ${space}), which records the inputs, then cotal down, then run this team boot again`);
  // A settled restore of this stack does not fence its own up and down, but its cut ran a manager,
  // and a team boot resumes only a stack whose manager never launched.
  const maintenance = stackMaintenanceFence(root, journal);
  if (maintenance.admittedRestore) refuse("LIFECYCLE_BLOCKED", "this stack was restored from a preserved cut whose manager already ran; a team boot resumes only a stopped stack whose manager never launched, so nothing was resumed", { ...target, admittedRestore: maintenance.admittedRestore }, "start the restored stack with cotal up");
  if (maintenance.fenced) refuse("LIFECYCLE_BLOCKED", "this root retains a maintenance or recovery attempt; nothing was resumed", target);
  // A previously booted team is never adopted: any recorded fresh boot attempt for this root, settled
  // or not, means a manifest launch was already planned for this stack.
  let attempts, summaries;
  try { attempts = listFreshTeamAttempts(root); summaries = listFreshTeamSummaries(root); }
  catch { return refuse("TARGET_UNAVAILABLE", "fresh boot records under this root could not be read; no earlier boot was assumed absent", target); }
  if (attempts.valid.some((row) => row.deploymentId !== ownAttempt) || attempts.refused.length || summaries.valid.length || summaries.refused.length)
    refuse("LIFECYCLE_BLOCKED", "this root records an earlier team boot; a stopped stack that already carried a team is not resumed with another one", { ...target, attempts: attempts.valid.map((row) => ({ deploymentId: row.deploymentId, settled: freshTeamAttemptSettled(row, summaries.valid.find((summary) => summary.deploymentId === row.deploymentId)) })) }, "inspect it with cotal team show <deployment-id>");
  if (serviceSupervisorStore(space).list().length) refuse("LIFECYCLE_BLOCKED", "an OS supervisor receipt remains for this space; the controller stack is not resumed beside it", target);

  // The manager must never have been attempted: no instance anywhere, no retained custody, stop
  // request, reservation or shutdown intent, and a definition that is absent or never launched.
  const managerRow = journal.members.find((row) => row.role === "manager")!;
  if (managerRow.instanceId !== null || managerRow.state !== "not-attempted") refuse("LIFECYCLE_BLOCKED", "the recorded stack's manager was attempted before; a team boot does not adopt a previously launched manager or its agents", { ...target, manager: managerRow });
  if (serviceInstances(space, STACK_DEFINITION.manager).length) refuse("LIFECYCLE_BLOCKED", "a manager instance record exists for this space; a team boot does not adopt it", target);
  const managerPid = canonicalLocalProcessPath(MANAGER_PIDFILE, { root, space });
  if (custodyRetained(root, space, MANAGER_PIDFILE) || readLocalRecordSource(stopReservationPath(managerPid), 128, true) !== undefined || readLocalRecordSource(canonicalLocalProcessPath(MANAGER_SHUTDOWN_INTENT, { root, space }), 8192, true) !== undefined)
    refuse("LIFECYCLE_BLOCKED", "manager custody, a stop reservation or a shutdown intent remains for this space; nothing was resumed", target);
  assertNoServiceUnitAttempts(space, STACK_DEFINITION.manager);
  // A never-attempted manager has no saved definition: neither the withheld-login path nor
  // `--no-manager` defines one. Any saved stack manager definition was shaped by another writer or
  // an earlier launch, and it is never adopted or rewritten. The first manager runtime is therefore
  // the manifest's own preflighted request; there is no earlier pin to honor.
  if (serviceDefinitionStore(space).read(STACK_DEFINITION.manager)) refuse("LIFECYCLE_BLOCKED", "a saved stack manager definition exists although the manager was never attempted; it is not adopted or rewritten", { ...target, definition: STACK_DEFINITION.manager }, `inspect it with cotal service show ${STACK_DEFINITION.manager} --space ${space}`);

  const members: StackResumeBinding["members"] = [];
  for (const row of journal.members) {
    if (row.role === "manager") continue;
    if (!stackRoleApplies(journal.mode, row.role)) continue;
    if (row.instanceId === null || !["stopped", "already-stopped"].includes(row.state))
      refuse("LIFECYCLE_BLOCKED", `the recorded ${row.role} member has no confirmed stop in the last whole-stack stop; nothing was resumed`, { ...target, member: row });
    const definition = serviceDefinitionStore(space).read(row.definition);
    if (!definition || definition.record.value.launch.type !== "adapter" || definition.record.value.launch.adapter !== STACK_ADAPTER[row.role] || definition.record.value.launch.options.root !== root)
      refuse("LIFECYCLE_BLOCKED", `the recorded ${row.role} definition is missing or belongs to another adapter or root; nothing was resumed`, { ...target, definition: row.definition });
    const instances = serviceInstances(space, row.definition);
    if (instances.length !== 1 || instances[0]!.name !== row.instanceId) refuse("LIFECYCLE_BLOCKED", `the ${row.role} definition does not hold exactly the recorded instance; nothing was resumed`, { ...target, definition: row.definition, recorded: row.instanceId, found: instances.map((item) => item.name) });
    const instance = serviceInstanceStore(space).read(row.instanceId!)!;
    const value = instance.record.value;
    if (value.definitionRevision !== definition!.record.revision) refuse("LIFECYCLE_BLOCKED", `the recorded ${row.role} instance belongs to another definition revision; nothing was resumed`, { ...target, instanceId: row.instanceId });
    if (value.state !== "stopped") refuse("LIFECYCLE_BLOCKED", `the recorded ${row.role} instance is not settled stopped; nothing was resumed`, { ...target, instanceId: row.instanceId, state: value.state });
    // The existing removable-instance contract: gone process, terminal native receipts where the
    // role requires them, and no install, removal, unit action or supervisor.
    removableServiceInstances(space, row.definition);
    const observed = observeServiceProcess(value);
    if (observed !== "gone" && observed !== "previous-boot") refuse("LIFECYCLE_BLOCKED", `the recorded ${row.role} process is not provably gone; nothing was resumed`, { ...target, instanceId: row.instanceId, process: observed });
    let evidence: StackResumeEvidence;
    if (row.role === "broker") {
      if (value.kernelStopRequired !== true || !value.kernelStop) refuse("LIFECYCLE_BLOCKED", "the recorded broker has no exact kernel-exit receipt from its last stop; nothing was resumed", { ...target, instanceId: row.instanceId });
      evidence = "kernel-exit";
    } else {
      // Auth service and delivery declare no native stop policy. Their strongest recorded stop
      // evidence is the settled record plus released native custody; retained custody refuses.
      if (custodyRetained(root, space, row.role === "auth" ? AUTH_PIDFILE : DELIVERY_PIDFILE))
        refuse("LIFECYCLE_BLOCKED", `the ${row.role} child's native custody record remains; its stop is not proved and nothing was resumed`, { ...target, instanceId: row.instanceId });
      evidence = value.processStop ? "process-exit" : "process";
    }
    members.push({ role: row.role, definition: row.definition, definitionRevision: definition!.record.revision, definitionSha256: definition!.hash, instanceId: row.instanceId!, instanceRevision: instance.record.revision, instanceSha256: instance.hash, evidence });
  }
  return { root, space, server: journal.server, mode: journal.mode, journalSha256: snapshot.sha256, priorDown: journal.operation.id, broker: journal.broker!, members, manager: { definition: "absent" } };
}

/** Recheck under the caller's lock that every bound record is byte-identical to what the gate read. */
export function recheckStackResume(binding: StackResumeBinding, ownAttempt?: string): void {
  const again = stackResumeEligibility(binding.root, binding.space, { server: binding.server, mode: binding.mode }, ownAttempt);
  const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
  if (digest(again) !== digest(binding)) throw new CommandFailure("refused", "CONFLICT", "the stopped stack's journal, definitions or instance records changed after the team boot checked them; nothing was started", { target: { root: binding.root, space: binding.space, operation: binding.priorDown } });
}
