/**
 * Running a transformed program on the engine, in this process.
 *
 * Same signature and same `RunResult` as the walker's `run()`, so the differential suite can call
 * one and then the other with nothing between them but the engine under test. Everything a run is
 * pinned by — the source's hash, the seed, the logical epoch, the three limits — is resolved by the
 * SAME functions the walker resolves them with, because a second copy of that logic is a second
 * answer to "which run is this".
 *
 * THERE IS NO DEFAULT EVALUATOR, and that is the security posture rather than an inconvenience.
 * Turning a module string into a function is where confinement is either applied or lost, so the
 * caller supplies it: the differential suite hands in a plain evaluator because it is comparing two
 * engines on validator-accepted source in a test process, and the worker hands in one that evaluates
 * inside a locked-down Compartment with zero endowments. A default here would be an unconfined
 * production path that nobody chose and no reviewer would see.
 */

import { validate } from "../grammar.js";
import { RuntimeFault } from "../errors.js";
import { Journal, RunClock } from "../journal.js";
import { KeyScope, programHashOf } from "../keys.js";
import { bindPins, ENGINE_LANGUAGE_VERSION, resolvePins } from "../pins.js";
import type { RunOptions, RunResult } from "../interpret.js";
import { EngineFault, createEngine, type EngineCtx } from "./ctx.js";
import { EngineFrame, Signal, withFrame } from "./frame.js";

/**
 * The node below which this engine refuses to start, and the measurement the number comes from.
 *
 * Lane 1 set the wave's floor at 24 for AsyncContextFrame ALS. PROBED, that reason does not
 * reproduce on any path this engine takes, and the probes are the reason this constant is 22:
 *   ALS on node 22.23.2      9 of 9 shapes propagate - plain await, across the setTimeout macrotask
 *                            the fuel yield uses, both arms of a Promise.all, after a CUSTOM
 *                            THENABLE, across nextTick and setImmediate, and a nested run that
 *                            restores its parent. Identical on 26.7.0 and on 22 with
 *                            --experimental-async-context-frame.
 *   the seam on 22           the engine suite reaches the same checks it reaches on 26 until it
 *                            asks for a worker, below.
 *   the WORKER from `dist`   on node 22: identical answer, identical confinement (Date.now throws,
 *                            `process` undefined, 0 own globals), identical programHash, 74ms cold
 *                            against 51ms.
 * So NOTHING IN THE RUNTIME NEEDS 24, and a refusal at 24 would refuse environments this engine is
 * measured to work in. What fails on 22 is only the DEV path: a worker thread there does not apply
 * the parent's ESM loader hooks, so a `.ts` entry's own `../journal.js` is ERR_MODULE_NOT_FOUND -
 * measured three ways, the `.js` spelling, the `.ts` spelling, and an explicit
 * `execArgv: ["--import", "tsx"]` on the Worker, none of which changes it. That is not a runtime
 * bound and is not answered here: the Worker entry is an EXPLICIT INPUT of `runInWorker`, and the
 * engine suite's worker leg names a built artifact. See `worker.ts`.
 *
 * The number is a floor rather than an `engines` line because a package manager's warning is not a
 * refusal, and an engine whose frame plumbing rests on AsyncLocalStorage will not run on untested
 * ground and hope. It matches `engines` today; when a real RUNTIME reason to raise it appears, the
 * constant moves and the reason is written beside these.
 */
export const NODE_FLOOR = 22;

/**
 * Refuse a node below the floor, by MAJOR version.
 *
 * Pure in its argument so a suite can ask it about a version it is not running on; `runOnEngine`
 * calls it with the live one, which is the only call site.
 */
export function assertNodeFloor(version: string): void {
  const major = Number(version.split(".")[0]);
  if (Number.isFinite(major) && major < NODE_FLOOR) {
    throw new RuntimeFault(
      "L1000",
      `the cotal-lang engine requires node ${NODE_FLOOR} or newer and this is node ${version}. That is the floor this repo declares it supports and the lowest this engine was measured on; below it nothing here has been tested, and an engine whose frame plumbing rests on AsyncLocalStorage will not run on untested ground and hope.`,
    );
  }
}

/** What the transform emits: a closed expression taking the context as its call argument. */
export type ModuleFactory = (ctx: EngineCtx) => () => Promise<unknown>;

export interface EngineRunOptions extends RunOptions {
  /**
   * Turn the emitted module string into its factory. See the note above: no default, on purpose.
   * It must return the value of a CLOSED function expression with zero free identifiers.
   */
  readonly evaluate: (module: string) => ModuleFactory;
}

/**
 * Run a transformed program.
 *
 * `source` is the original program: it is validated here and its hash is the run's identity, exactly
 * as on the walker. `module` is the transform's output for that source. They are both taken because
 * the run is pinned to the SOURCE — a run record names the program an author wrote, not the string a
 * compiler produced — and because the validator's refusals must arrive before anything is journalled,
 * whichever engine is about to execute.
 */
export async function runOnEngine(source: string, module: string, options: EngineRunOptions): Promise<RunResult> {
  // BEFORE ANYTHING, including the validator: a run that cannot be trusted to carry its frame is not
  // a run whose refusals mean anything either.
  assertNodeFloor(process.versions.node);
  validate(source, options.file);
  const programHash = programHashOf(source);

  // A RESUME MAY NOT DECLINE TO SAY WHICH RUN IT IS RESUMING. Re-resolving the pins for a run handed
  // history but no pins is a different run wearing the same journal: the clock moves to the resuming
  // host and the seed falls back to the runId default, so both the logical epoch and every pure draw
  // change, and nothing refuses, because nothing can — neither is a recorded fact a replay could
  // diverge on. A journal with NO entries is a fresh run being handed a store, and stays allowed.
  if (options.pins === undefined && options.journal !== undefined && options.journal.entries().length > 0) {
    throw new RuntimeFault(
      "L5021",
      `run ${options.runId} was handed a journal with ${options.journal.entries().length} recorded step(s) but no pins. The pins are what decide `
        + `the run's logical epoch and its seed, so resolving them again here would make this a different run against a journal that was not `
        + `written for it — silently, because neither the clock nor a pure draw is a recorded fact the replay could diverge on.\n\n`
        + `Options\n  pass the pins from the run record\n  start a fresh run instead of resuming this journal`,
    );
  }

  const pins =
    options.pins !== undefined
      ? bindPins(options.pins, options, ENGINE_LANGUAGE_VERSION)
      : resolvePins(options, options.handler.now(), ENGINE_LANGUAGE_VERSION);

  // The journal and the run must be the same run: request ids derive from the runId while recorded
  // results come from the journal, so a mismatch submits work under one identity and resolves it
  // against another's history.
  if (options.journal !== undefined && options.journal.run !== options.runId) {
    throw new RuntimeFault(
      "L5011",
      `this run is ${options.runId} but it was handed the journal of run ${options.journal.run}; a run resumes only from its own journal`,
    );
  }
  const journal = options.journal ?? new Journal({ run: options.runId });

  const engine = createEngine({
    runId: options.runId,
    programHash,
    journal,
    handler: options.handler,
    pins,
    ...(options.onLog !== undefined ? { onLog: options.onLog } : {}),
    ...(options.shouldStop !== undefined ? { shouldStop: options.shouldStop } : {}),
  });

  // The run clock starts at the run's LOGICAL epoch, not at this host's clock: a run resumed on
  // another machine hours later must see the same `now()` before its first effect as the run that
  // wrote the journal, or the branch it takes is a property of when it was resumed.
  const frame = new EngineFrame(new KeyScope(), new RunClock(pins.startedAt), new Signal());

  const factory = options.evaluate(module);
  // THE RUN BOUNDARY IS THE SECOND PLACE A NATIVE ReferenceError CAN SURFACE - the first is an
  // emitted catch, and `caught` refuses it there. A program with no `try` around the bad read has
  // nothing to route it through, so it arrives here, and here it must not look like a program error
  // either. See `EngineFault`: zero free identifiers means this can only be the engine's own bug.
  const value = await withFrame(frame, async () => {
    try {
      return await factory(engine.ctx)();
    } catch (e) {
      throw e instanceof ReferenceError ? new EngineFault(e) : e;
    }
  });

  return { value, journal, programHash, pins, steps: engine.steps() };
}

/** Re-run a transformed program against an existing journal. Journalled effects return recorded results. */
export async function resumeOnEngine(
  source: string,
  module: string,
  journal: Journal,
  options: Omit<EngineRunOptions, "journal">,
): Promise<RunResult> {
  journal.resetConsumed();
  return await runOnEngine(source, module, { ...options, journal });
}
