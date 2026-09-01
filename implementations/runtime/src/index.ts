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
export { startRun, driveRun, PauseToken, type RunLease, type DriveRequest, type DriveOutcome, type AdoptingHandler } from "./run-driver.js";
export {
  MeshHandler,
  EpfSettleWatcher,
  CheckpointAnswerMissing,
  NotYetDurable,
  waitConsumerName,
  waitConsumerConfig,
  rearmOutstandingPauses,
  outstandingPauseTokens,
  type MeshHandlerBinding,
  type SettleWatcher,
} from "./mesh-handler.js";
export {
  resolveCheckpoint,
  openCheckpointToken,
  CheckpointNotOpen,
  type ResolveCheckpointDeps,
  type ResolveCheckpointRequest,
  type ResolveCheckpointResult,
} from "./resolve-checkpoint.js";
export { renderRunContext, UnrenderableNotice, type RunContextRender } from "./run-context.js";
export {
  migrateRun,
  commitMigration,
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

// Self-register `cotal run` — the workflow-run operator surface. Importing this package from a
// composition root (bin/run.ts) is what puts the command on the CLI; library users who import the
// driver API get the registration too, and it is inert until a dispatcher resolves it.
import { registry, type Command } from "@cotal-ai/core";
import { targetFlags } from "@cotal-ai/workspace";
import { runWorkflow as runWorkflowCommand } from "./run-command.js";

const runCommand: Command = {
  kind: "command",
  name: "run",
  group: "Manager",
  summary: "operate workflow runs — start, resume, list, inspect, answer",
  usage:
    "run <start --file <program> | resume <runId> --file <program> | ps | journal <runId> | answer <runId> <stepKey> --by <who> [--value <json>]> [--endpoint <ep>]",
  flags: [
    ...targetFlags,
    { name: "file", type: "string", short: "f", value: "<program>", description: "cotal-lang program source (start/resume; the record stores no source)" },
    { name: "endpoint", type: "string", value: "<ep>", description: "hosting endpoint for the run record (default: manager)" },
    { name: "timeout", type: "string", value: "<dur>", description: "default checkpoint timeout for this drive (default: 1h)" },
    { name: "by", type: "string", value: "<who>", description: "who is answering (answer; required)" },
    { name: "value", type: "string", value: "<json>", description: "checkpoint answer payload as JSON (answer)" },
    { name: "artifact", type: "string", value: "<ref>", description: "artifact reference attached to the answer (answer)" },
  ],
  positionals: "<start|resume|ps|journal|answer> …",
  run: (args) => runWorkflowCommand(args),
};

registry.register(runCommand);
