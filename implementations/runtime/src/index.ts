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
  examples: [{ command: "cotal run", note: "list your workflow runs" }, { command: "cotal run start <file>", note: "start a workflow on your manager" }, { command: "cotal run show <run-id>", note: "read a run's state and recent journal" }],
  outputs: ["json", "plain"],
  reads: true,
  subcommands: [
    { name: "list", aliases: ["ps"], hidden: true, summary: "list recorded workflow runs", reads: true, outputs: ["json", "plain"] },
    { name: "start", flagNames: ["space", "server", "creds", "on", "file", "local", "admit-read", "admit-publish", "endpoint", "timeout", "json", "plain"], summary: "start a workflow on the manager", examples: [{ command: "cotal run start <file>", note: "start a workflow on your manager" }, { command: "cotal run start <file> --on <instance>", note: "start it on one named manager" }], usage: "cotal run start <file> [--on <instance>] [--timeout <dur>] [--json|--plain] | run start <file> --local --admit-read <channels> --admit-publish <channels> [--endpoint <ep>]", outputs: ["json", "plain"] },
    { name: "show", aliases: ["journal"], flagNames: ["space", "server", "creds", "on", "local", "endpoint", "json", "plain"], summary: "read recorded state, open requests and journal", examples: [{ command: "cotal run show <run-id>", note: "read a run's state and recent journal" }, { command: "cotal run show <run-id> --json", note: "the same as one JSON document" }], usage: "cotal run show <run-id> [--on <instance> | --local] [--endpoint <ep>] [--json|--plain]", reads: true, outputs: ["json", "plain"] },
    { name: "resume", flagNames: ["space", "server", "creds", "on", "file", "local", "endpoint", "timeout", "json", "plain"], summary: "resume a workflow from its recorded program", examples: [{ command: "cotal run resume <run-id>", note: "resume a stopped run from its recorded program" }], usage: "cotal run resume <run-id> [--on <instance>] [--timeout <dur>] [--json|--plain] | run resume <run-id> --local [--file <program>] [--endpoint <ep>]", outputs: ["json", "plain"] },
    { name: "answer", flagNames: ["space", "server", "creds", "on", "local", "endpoint", "by", "value", "artifact", "json", "plain"], summary: "answer an open checkpoint or ask", examples: [{ command: "cotal run answer <run-id> <step> --value '<json>'", note: "answer a step that waits for you" }], usage: "cotal run answer <run-id> <step> [--value <json>] [--artifact <ref>] [--on <instance> | --local --by <who>] [--endpoint <ep>] [--json|--plain]", outputs: ["json", "plain"] },
    { name: "amend", flagNames: ["space", "server", "creds", "on", "local", "endpoint", "by", "value", "artifact", "json", "plain"], summary: "record an amendment without reopening the pause", examples: [{ command: "cotal run amend <run-id> <step> --value '<json>'", note: "change an answer you already gave" }], usage: "cotal run amend <run-id> <step> [--value <json>] [--artifact <ref>] [--on <instance> | --local --by <who>] [--endpoint <ep>] [--json|--plain]", outputs: ["json", "plain"] },
    { name: "check", aliases: ["migrate"], flagNames: ["space", "server", "creds", "endpoint"], summary: "check an edited program against a recorded journal without committing it", examples: [{ command: "cotal run check <run-id> <file>", note: "check whether an edited program fits a run" }], usage: "cotal run check <run-id> <file> [--endpoint <ep>]", reads: true },
    { name: "revoke", flagNames: ["space", "server", "creds", "local", "by", "reason", "endpoint"], summary: "revoke run admission; it does not cancel work that touches no channel", examples: [{ command: "cotal run revoke <run-id> --local --by <who> --reason <text>", note: "revoke a local run's admission" }], usage: "cotal run revoke <run-id> --local --by <who> --reason <text> [--endpoint <ep>]" },
    ...(["validate", "plan", "simulate"] as const).map((name) => ({ name, flagNames: name === "simulate" ? ["handler", "json", "plain"] : ["json", "plain"], summary: name === "validate" ? "validate cotal-lang offline" : name === "plan" ? "show validated static call sites offline" : "simulate with explicit JSON results offline", examples: name === "validate" ? [{ command: "cotal run validate <file>", note: "check a workflow program offline" }] : name === "plan" ? [{ command: "cotal run plan <file>", note: "list the calls a program makes, offline" }] : [{ command: "cotal run simulate <file> --handler <results.json>", note: "run a program offline with canned results" }], usage: name === "simulate" ? "cotal run simulate <file> [--handler <results.json>] [--json|--plain]" : `cotal run ${name} <file> [--json|--plain]`, reads: true as const, prepareMeshTarget: false as const, outputs: ["json", "plain"] as const })),
    { name: "turns", flagNames: ["space", "server", "json", "plain"], summary: "read this managed seat's own assigned turns", examples: [{ command: "cotal run turns", note: "list the turns assigned to this agent" }], usage: "cotal run turns [--json|--plain]", reads: true, prepareMeshTarget: false, outputs: ["json", "plain"] },
    { name: "yield", flagNames: ["space", "server", "status", "to", "note", "json", "plain"], summary: "report this managed seat's assigned turn outcome", examples: [{ command: "cotal run yield <turn-id> --status done", note: "report your turn finished" }, { command: "cotal run yield <turn-id> --status handoff --to <agent>", note: "hand your turn to another agent" }], usage: "cotal run yield <turn-id> --status <done|blocked|handoff> [--to <agent>] [--note <text>] [--json|--plain]", prepareMeshTarget: false, outputs: ["json", "plain"] },
  ],
  validate: (args) => { workflowArguments(args); },
  flags: [
    ...targetFlags,
    { name: "on", type: "string", value: "<instance>", description: "hosted verbs only: pin one full manager instance as cotal ps prints it" },
    { name: "file", type: "string", short: "f", value: "<program>", description: "cotal-lang program source (start; resume --local when no program is recorded)", completion: "files" },
    { name: "local", type: "boolean", description: "drive in this process instead of on the manager (bare broker, or a run the manager cannot host)" },
    { name: "admit-read", type: "string", value: "<channels>", description: "start --local: the channels the run may read, comma-separated patterns or `none` (required; SPEC 14.8)" },
    { name: "admit-publish", type: "string", value: "<channels>", description: "start --local: the channels the run may post to, comma-separated patterns or `none` (required; SPEC 14.8)" },
    { name: "endpoint", type: "string", value: "<ep>", description: "endpoint the run record lives under (the run list, show, answer, amend; default: manager)" },
    { name: "timeout", type: "string", value: "<dur>", description: "default checkpoint timeout for this drive (default: 1h)" },
    { name: "by", type: "string", value: "<who>", description: "who is answering, amending or revoking (answer --local, amend --local, revoke; the manager records the caller for a hosted answer)" },
    { name: "reason", type: "string", value: "<text>", description: "revoke: why the run's admission is revoked, recorded on the marker (required)" },
    { name: "value", type: "string", value: "<json>", description: "checkpoint answer payload as JSON (answer, amend)" },
    { name: "artifact", type: "string", value: "<ref>", description: "artifact reference attached to the answer (answer, amend)" },
    { name: "adopt", type: "string", value: "<handle>", description: "REFUSED by `check`: it decides what a commit does with an orphan, and that verb only checks" },
    { name: "release", type: "string", value: "<handle>", description: "REFUSED by `check`: it decides what a commit does with an orphan, and that verb only checks" },
    { name: "discard-approvals", type: "boolean", description: "REFUSED by `check`: it decides what a commit does with a recorded decision, and that verb only checks" },
    { name: "page", type: "boolean", description: "hosted run list: one bounded diagnostic JSON page; requires --on and proves no absence or ownership" },
    { name: "limit", type: "string", value: "<n>", description: "run --page: row limit from 1 to 16 (default 8); byte and read bounds can return fewer. show: journal rows printed, 1 to 1000 (default 20)" },
    { name: "cursor", type: "string", value: "<cursor>", description: "run --page: continuation from the same manager instance, epoch and filter" },
    jsonFlag, plainFlag,
    { name: "handler", type: "string", value: "<results.json>", description: "simulate: explicit JSON simulation results; no JavaScript handler is executed", completion: "files" },
    { name: "status", type: "string", value: "<done|blocked|handoff>", description: "yield: the assigned turn's actual outcome" },
    { name: "to", type: "string", value: "<agent>", description: "yield: required destination for a handoff" },
    { name: "note", type: "string", value: "<text>", description: "yield: context for the turn outcome" },
  ],
  positionals: "[<command> …]",
  run: (args) => runWorkflowCommand(args),
};

registry.register(runCommand);
