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
  type MeshHandlerBinding,
  type SettleWatcher,
} from "./mesh-handler.js";
export {
  resolveCheckpoint,
  locateOpenCheckpoint,
  answerOpenCheckpoint,
  openCheckpointToken,
  CheckpointNotOpen,
  type OpenCheckpoint,
  type ResolveCheckpointDeps,
  type ResolveCheckpointRequest,
  type ResolveCheckpointResult,
} from "./resolve-checkpoint.js";
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
export { cotalLangRunHost } from "./run-host.js";

// Self-register `cotal run` — the workflow-run operator surface — and the `run-host` the manager
// drives runs through (SPEC 14.3). Importing this package from a composition root (bin/run.ts) is
// what puts the command on the CLI and the host in the manager's reach; library users who import
// the driver API get both registrations too, and they are inert until a dispatcher or a manager
// resolves them.
import { registry, type Command } from "@cotal-ai/core";
import { targetFlags } from "@cotal-ai/workspace";
import { runWorkflow as runWorkflowCommand } from "./run-command.js";
import { cotalLangRunHost as runHost } from "./run-host.js";

registry.register(runHost);

const runCommand: Command = {
  kind: "command",
  name: "run",
  group: "Manager",
  summary: "operate workflow runs — start, resume, list, inspect, answer (hosted by the manager)",
  usage:
    "run <start --file <program> [--timeout <dur>] | resume <runId> [--local --file <program>] | ps [--endpoint <ep>] | journal <runId> [--endpoint <ep>] | answer <runId> <stepKey> [--value <json>] [--artifact <ref>] [--endpoint <ep>] [--local --by <who>]> [--local]",
  flags: [
    ...targetFlags,
    { name: "file", type: "string", short: "f", value: "<program>", description: "cotal-lang program source (start; resume --local when no program is recorded)" },
    { name: "local", type: "boolean", description: "drive in this process instead of on the manager (bare broker, or a run the manager cannot host)" },
    { name: "endpoint", type: "string", value: "<ep>", description: "endpoint the run record lives under (ps, journal, answer; default: manager)" },
    { name: "timeout", type: "string", value: "<dur>", description: "default checkpoint timeout for this drive (default: 1h)" },
    { name: "by", type: "string", value: "<who>", description: "who is answering (answer --local only; the manager records the caller)" },
    { name: "value", type: "string", value: "<json>", description: "checkpoint answer payload as JSON (answer)" },
    { name: "artifact", type: "string", value: "<ref>", description: "artifact reference attached to the answer (answer)" },
  ],
  positionals: "<start|resume|ps|journal|answer> …",
  run: (args) => runWorkflowCommand(args),
};

registry.register(runCommand);
