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
export { startRun, driveRun, PauseToken, type RunLease, type DriveRequest, type DriveOutcome } from "./run-driver.js";
export {
  MeshHandler,
  EpfSettleWatcher,
  CheckpointAnswerMissing,
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
