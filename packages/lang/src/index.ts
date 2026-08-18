/**
 * cotal-lang: the restricted-JS workflow language.
 *
 * A program orchestrates turns and events, never message content: agents read their own channels
 * and speak for themselves, and the program only decides who acts next. Determinism is by
 * construction rather than by convention, because the interpreter has nothing nondeterministic to
 * offer, and durability is a step journal keyed by name rather than by position.
 *
 * This package is pure: it depends on nothing else in the repo, so the validator, the key
 * machinery, and the simulation handler run with no broker and no mesh.
 */

export {
  CATALOG,
  LangError,
  LangErrors,
  codeFrame,
  type CalleeDoc,
  type LangErrorCode,
  type LangErrorInit,
  type LangErrorJson,
  type SourceSpan,
} from "./errors.js";

export {
  BUILTINS,
  EFFECT_KINDS,
  EVENT_CONSTRUCTORS,
  FORBIDDEN_GLOBALS,
  HOST_GLOBAL_HINTS,
  PRIMITIVES,
  PURE_PRIMITIVES,
  RESERVED_NAMES,
  STEP_NAME_RE,
  VALUE_NAMES,
  primitiveDoc,
  type EffectKind,
  type PrimitiveSpec,
} from "./primitives.js";

export {
  ADMITTED_NODES,
  FORBIDDEN_CHILDREN,
  FORBIDDEN_NODES,
  KNOWN_NODES,
  STRUCTURAL_NODES,
} from "./syntax.js";

export { MUTATING_METHODS } from "./library.js";

export { validate, type ValidateResult } from "./grammar.js";

export {
  RunDivergence,
  RuntimeFault,
  ScopeBranchMissing,
  UnwalkableScope,
  resume,
  run,
  type RunOptions,
  type RunResult,
} from "./interpret.js";

export { Prng, assertCrossable, deepFreeze } from "./values.js";

export {
  LANGUAGE_VERSION,
  PIN_DEFAULTS,
  PinMismatch,
  bindPins,
  resolvePins,
  type PinnableOptions,
  type RunPins,
} from "./pins.js";

export {
  Cancelled,
  RunReleased,
  EffectError,
  type AgentHandleValue,
  type AskRequest,
  type CancelSignal,
  type ChannelHandleValue,
  type CheckpointRaw,
  type CheckpointRequest,
  type CheckpointResultValue,
  type ConclaveRequest,
  type EffectContext,
  type EffectHandler,
  type EventDescriptor,
  type MonitorRequest,
  type NotifyFact,
  type NotifyRequest,
  type SleepRequest,
  type SpawnRequest,
  type TurnRequest,
  type TurnResultValue,
  type TurnStatus,
  type WaitRequest,
} from "./effects.js";

export {
  DurationError,
  isDuration,
  parseDuration,
} from "./duration.js";

export {
  RecordingHandler,
  dryRun,
  renderReport,
  type DryRunOptions,
  type DryRunReport,
  type PlannedAgent,
  type PlannedCheckpoint,
  type PlannedEffect,
} from "./dryrun.js";

export {
  SimHandler,
  SimUnscriptedError,
  type Scripted,
  type SimFault,
  type SimScript,
} from "./sim.js";

export { notifyFactViolation } from "./notify-fact.js";

export {
  Journal,
  JournalAppendRejected,
  JournalReadOnlyError,
  RunClock,
  journalEntryKeyString,
  type EntryError,
  type EntryState,
  type EntryStatus,
  type JournalEntry,
  type JournalInit,
  type JournalStore,
  type LookupVerdict,
} from "./journal.js";

export {
  DIGEST_PREFIX,
  KeyScope,
  branchKeys,
  digest,
  programHashOf,
  scopePathString,
  stepKeyEquals,
  stepKeyString,
  type ScopeFrame,
  type ScopeKind,
  type StepKey,
} from "./keys.js";
