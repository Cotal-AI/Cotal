/**
 * `@cotal-ai/runtime` — where a cotal-lang run is HOSTED.
 *
 * `packages/lang` is the language: the parser and validator, the effect interface, the step journal,
 * the interpreter, the simulator, the dry run. It depends on nothing in this repo, and that
 * independence is what lets a program be tested without a broker. This package is the other half:
 * the mesh bindings that make a run durable and drivable — the journal's storage over the
 * activation barrier, the effect handler over the real planes, and the run driver hosted on the
 * manager daemon.
 */
export { RunJournalStore, RunJournalUnavailable } from "./journal-store.js";
export { startRun, driveRun, PauseToken, type RunLease, type DriveRequest, type DriveOutcome, type AdoptingHandler, type SeatAdoptingHandler } from "./run-driver.js";
export {
  MeshHandler,
  EpfSettleWatcher,
  CheckpointAnswerMissing,
  waitConsumerName,
  waitConsumerConfig,
  rearmOutstandingPauses,
  outstandingPauseTokens,
  readSupervise,
  spawnArgs,
  canonicalCwd,
  type MeshHandlerBinding,
  type SettleWatcher,
} from "./mesh-handler.js";
export {
  resolveCheckpoint,
  locateOpenCheckpoint,
  answerOpenCheckpoint,
  locateAcceptedAnswer,
  amendAcceptedAnswer,
  type AcceptedAnswer,
  type OpenCheckpoint,
  type ResolveCheckpointDeps,
  type ResolveCheckpointRequest,
  type ResolveCheckpointResult,
} from "./resolve-checkpoint.js";
export { openCheckpointToken, settledPauseToken, CheckpointNotOpen, CheckpointNotAmendable } from "@cotal-ai/lang";
export { renderRunContext, UnrenderableNotice, type RunContextRender } from "./run-context.js";
export {
  migrateRun,
  commitMigration,
  migrationSeats,
  MigrationNotAdmissible,
  type MigrateRequest,
  type MigrateReport,
  type MigrateOrphan,
  type MigrateOverrides,
  type MigrateDivergence,
  type OrphanVerdict,
} from "./migrate.js";
export {
  planFork,
  commitFork,
  ForkNotAdmissible,
  CutJournal,
  CutReached,
  type ForkRequest,
  type ForkPlan,
  type ForkRefusal,
  type ForkCommitResult,
} from "./fork.js";
export { runWorkflow } from "./run-command.js";
export { cotalLangRunHost, journalOutcomeOf, journalStepRow } from "./run-host.js";

// Self-register `cotal run` — the workflow-run operator surface — and the `run-host` the manager
// drives runs through (SPEC 14.3). Importing this package from a composition root (bin/run.ts) is
// what puts the command on the CLI and the host in the manager's reach; library users who import
// the driver API get both registrations too, and they are inert until a dispatcher or a manager
// resolves them.
import { registry, type Command } from "@cotal-ai/core";
import { jsonFlag, plainFlag, targetFlags } from "@cotal-ai/workspace";
import { runWorkflow as runWorkflowCommand, workflowArguments } from "./run-command.js";
import { cotalLangRunHost as runHost } from "./run-host.js";

registry.register(runHost);

const runCommand: Command = {
  kind: "command",
  name: "run",
  aliases: ["r"],
  group: "Manager",
  summary: "operate workflow runs — start, resume, list, inspect, answer, amend (hosted by the manager), revoke",
  usage: "cotal run [start <file> | show <run-id> | resume <run-id> | answer <run-id> <step> | amend <run-id> <step> | check <run-id> <file> | revoke <run-id> | validate <file> | plan <file> | simulate <file> | turns | yield <turn-id>] [--on <manager-instance>]",
  outputs: ["json", "plain"],
  reads: true,
  subcommands: [
    { name: "list", aliases: ["ps"], hidden: true, summary: "list recorded workflow runs", reads: true, outputs: ["json", "plain"] },
    { name: "start", summary: "start a workflow on the manager", outputs: ["json", "plain"] },
    { name: "show", aliases: ["journal"], summary: "read recorded state, open requests and journal", reads: true, outputs: ["json", "plain"] },
    { name: "resume", summary: "resume a workflow from its recorded program", outputs: ["json", "plain"] },
    { name: "answer", summary: "answer an open checkpoint or ask", outputs: ["json", "plain"] },
    { name: "amend", summary: "record an amendment without reopening the pause", outputs: ["json", "plain"] },
    { name: "check", aliases: ["migrate"], summary: "check an edited program against a recorded journal without committing it", reads: true },
    { name: "revoke", summary: "revoke run admission under the existing local authority" },
    ...(["validate", "plan", "simulate"] as const).map((name) => ({ name, summary: name === "validate" ? "validate cotal-lang offline" : name === "plan" ? "show validated static call sites offline" : "simulate with explicit JSON results offline", reads: true as const, prepareMeshTarget: false as const, outputs: ["json", "plain"] as const })),
    { name: "turns", summary: "read this managed seat's own assigned turns", reads: true, prepareMeshTarget: false, outputs: ["json", "plain"] },
    { name: "yield", summary: "report this managed seat's assigned turn outcome", prepareMeshTarget: false, outputs: ["json", "plain"] },
  ],
  validate: (args) => { workflowArguments(args); },
  flags: [
    ...targetFlags,
    { name: "on", type: "string", value: "<instance>", description: "hosted verbs only: pin one full manager instance as cotal ps prints it" },
    { name: "file", type: "string", short: "f", value: "<program>", description: "cotal-lang program source (start; resume --local when no program is recorded)" },
    { name: "local", type: "boolean", description: "drive in this process instead of on the manager (bare broker, or a run the manager cannot host)" },
    { name: "admit-read", type: "string", value: "<channels>", description: "start --local: the channels the run may read, comma-separated patterns or `none` (required; SPEC 14.8)" },
    { name: "admit-publish", type: "string", value: "<channels>", description: "start --local: the channels the run may post to, comma-separated patterns or `none` (required; SPEC 14.8)" },
    { name: "endpoint", type: "string", value: "<ep>", description: "endpoint the run record lives under (ps, journal, answer, amend; default: manager)" },
    { name: "timeout", type: "string", value: "<dur>", description: "default checkpoint timeout for this drive (default: 1h)" },
    { name: "by", type: "string", value: "<who>", description: "who is answering, amending or revoking (answer --local, amend --local, revoke; the manager records the caller for a hosted answer)" },
    { name: "reason", type: "string", value: "<text>", description: "revoke: why the run's admission is revoked, recorded on the marker (required)" },
    { name: "value", type: "string", value: "<json>", description: "checkpoint answer payload as JSON (answer, amend)" },
    { name: "artifact", type: "string", value: "<ref>", description: "artifact reference attached to the answer (answer, amend)" },
    { name: "adopt", type: "string", value: "<handle>", description: "REFUSED by `migrate`: it decides what a commit does with an orphan, and that verb only checks" },
    { name: "release", type: "string", value: "<handle>", description: "REFUSED by `migrate`: it decides what a commit does with an orphan, and that verb only checks" },
    { name: "discard-approvals", type: "boolean", description: "REFUSED by `migrate`: it decides what a commit does with a recorded decision, and that verb only checks" },
    { name: "page", type: "boolean", description: "hosted ps: one bounded diagnostic JSON page; requires --on and proves no absence or ownership" },
    { name: "limit", type: "string", value: "<n>", description: "ps --page: row limit from 1 to 16 (default 8); byte and read bounds can return fewer" },
    { name: "cursor", type: "string", value: "<cursor>", description: "ps --page: continuation from the same manager instance, epoch and filter" },
    jsonFlag, plainFlag,
    { name: "handler", type: "string", value: "<results.json>", description: "simulate: explicit JSON simulation results; no JavaScript handler is executed" },
    { name: "status", type: "string", value: "<done|blocked|handoff>", description: "yield: the assigned turn's actual outcome" },
    { name: "to", type: "string", value: "<agent>", description: "yield: required destination for a handoff" },
    { name: "note", type: "string", value: "<text>", description: "yield: context for the turn outcome" },
  ],
  positionals: "[<command> …]",
  run: (args) => runWorkflowCommand(args),
};

registry.register(runCommand);
