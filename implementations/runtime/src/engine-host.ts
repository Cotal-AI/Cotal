/**
 * The version-2 entry for the driver's engine table: a run on the compiled engine, hosted.
 *
 * What this file owns is exactly the three decisions the engine leaves to its host, and nothing
 * the engine already decided:
 *
 *   - THE TRANSFORM STEP. The driver holds the author's source (a run record names the program an
 *     author wrote), so the module the engine executes is produced here, per attempt, by the pure
 *     `transform`. Nothing is cached: the transform re-validates, and a cached module would be a
 *     second answer to "what does this source compile to" with no way to notice the disagreement.
 *
 *   - THE EVALUATOR CHOICE, made by naming the worker entry and refusing every alternative. The
 *     entry is the compiled `worker-entry.js` of the installed `@cotal-ai/lang` — the file whose
 *     `lockdown()` and zero-endowment Compartment the engine suite grades — resolved through the
 *     package's own exports map. There is no in-process route here on purpose: evaluating the
 *     module in this process would either lock down the daemon's own realm or skip confinement,
 *     and both are decisions nobody made. A missing artifact is a loud refusal naming the build
 *     step, never a quiet fall back to the walker.
 *
 *   - WHERE THE EFFECTS LIVE. The driver's handler is a live object (sockets, a mesh client, a
 *     lease-bound appender), so the run uses the BRIDGED route: handler and durable store stay in
 *     this process, the thread forwards the seam over a MessagePort, and no credential enters the
 *     isolate that holds the program. The pending-entry-durable-before-the-effect ordering is the
 *     store's own await, unchanged, because the bridge preserves the async append contract.
 *
 * The driver's outcome contract is the walker's, so a failure that crosses the thread boundary is
 * rehydrated into the class `drive()` grades: L5010 back into `JournalAppendRejected` (from the
 * store failure this process itself just witnessed — the thread only reflected it), L5012 back
 * into `RunReleased`, and everything else into an error carrying the same name, code and message
 * it failed with inside the thread.
 */

import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  EffectError,
  Journal,
  JournalAppendRejected,
  RunReleased,
  assertNodeFloor,
  journalEntryKeyString,
  runInWorker,
  transform,
  type EffectHandler,
  type JournalEntry,
  type JournalStore,
  type RunPins,
  type RunResult,
  type WorkerRunFailed,
} from "@cotal-ai/lang";

/**
 * How often the host polls its own stop conditions (work horizon, pause) with NO bridge traffic to
 * ride on. The per-effect granularity the walker has does not come from this timer: every effect is
 * bracketed by durable appends, and the store below asks `shouldStop` on each one, so the flag is
 * current at every effect boundary the thread checks it at. What only the timer covers is a stop
 * with no append coming to carry it: one arriving in the worker's boot window, after the upfront
 * sample below but before the thread's first pre-effect check (measured: without the timer, one
 * effect the stop should have prevented is dispatched), and one arriving while an effect is parked
 * in this process for hours. A stop during a long PURE stretch is covered by neither the timer nor
 * anything else: `shouldStop`'s one reader in the language is the pre-effect check, on both
 * engines, so a program that computes without effecting runs to its fuel refusal (L4013) before
 * any stop is honoured. That is the language's own property, shared with the walker, and a stop
 * read at the fuel yield would be a change to both engines, not to this host.
 */
const STOP_POLL_MS = 100;

export interface EngineHostRequest {
  readonly source: string;
  readonly runId: string;
  readonly pins: RunPins;
  readonly handler: EffectHandler;
  readonly store: JournalStore;
  /** The activated prefix: recorded entries for a resume, empty for a fresh run. */
  readonly entries: readonly JournalEntry[];
  readonly shouldStop: () => string | undefined;
  readonly file?: string;
  readonly seed?: string;
  readonly effectCeiling?: number;
  readonly stepBudget?: number;
}

/**
 * The compiled worker entry of the installed `@cotal-ai/lang`, and the refusal when it is absent.
 *
 * `import.meta.resolve` answers from the exports map without touching the disk, so existence is
 * checked here: in this repo the artifact exists only after `pnpm --filter @cotal-ai/lang
 * build:emit`, and a driver that cannot name a confined evaluator does not get to invent one.
 */
export function resolveWorkerEntry(): URL {
  const url = new URL(import.meta.resolve("@cotal-ai/lang/engine/worker-entry"));
  if (!existsSync(fileURLToPath(url))) {
    throw new Error(
      `the compiled engine's worker entry is not built: ${fileURLToPath(url)} does not exist. ` +
        `The version-2 engine runs only the compiled artifact (its thread cannot load TypeScript sources); ` +
        `build it with \`pnpm --filter @cotal-ai/lang build:emit\`.`,
    );
  }
  return url;
}

/**
 * A store wrapper that remembers the failure it threw, so the class the thread reports back as
 * L5010 can be rebuilt from the facts THIS process witnessed rather than parsed out of a message.
 */
class WitnessedStore implements JournalStore {
  failure?: { entry: JournalEntry; reason: Error };

  /** `beforeAppend` is the stop check riding the append: every effect begins with a pending append
   *  and ends with a settled one, so asking here is the walker's own between-effects granularity. */
  constructor(
    private readonly inner: JournalStore,
    private readonly beforeAppend: () => void,
  ) {}

  async append(entry: JournalEntry): Promise<void> {
    this.beforeAppend();
    try {
      await this.inner.append(entry);
    } catch (e) {
      this.failure = { entry, reason: e as Error };
      throw e;
    }
  }
}

function rehydrate(failed: WorkerRunFailed, store: WitnessedStore): Error {
  if (failed.code === "L5010") {
    // The append that failed happened in this process; the thread's L5010 is its reflection. A
    // reflection with no witnessed failure behind it means the two sides disagree about what
    // happened, and that is said rather than papered over with a parsed message.
    if (store.failure === undefined) {
      return new Error(
        `the engine thread reported L5010 (journal append rejected) but this host's store recorded no failed append; the run cannot be graded: ${failed.message}`,
      );
    }
    return new JournalAppendRejected(journalEntryKeyString(store.failure.entry), store.failure.entry.state, store.failure.reason);
  }
  if (failed.code === "L5012") {
    return new RunReleased(failed.reason ?? failed.message);
  }
  // An effect failure carries its domain across whole, because callers branch on `kind` exactly as
  // they do when the walker raises the same class in-process.
  if (failed.code !== undefined && failed.kind !== undefined) {
    return new EffectError(failed.code, failed.kind, failed.message, failed.detail);
  }
  const e = new Error(failed.message);
  e.name = failed.name;
  if (failed.code !== undefined) (e as Error & { code?: string }).code = failed.code;
  return e;
}

/** Run or resume a program on the compiled engine, with the walker's `RunResult`. */
export async function runOnHostedEngine(req: EngineHostRequest): Promise<RunResult> {
  // The floor the engine itself enforces in the thread, asked here first: a driver below it must
  // refuse BEFORE it stamps a fresh run with a version it cannot execute.
  assertNodeFloor(process.versions.node);
  const entry = resolveWorkerEntry();
  const { module } = transform(req.source, req.file !== undefined ? { file: req.file } : {});
  // Assigned right after the worker exists; every append comes FROM that worker, so no check can
  // fire before the assignment. Publishing is idempotent and the reason is read where the run has
  // always read it.
  let publish: (reason: string) => void = () => {};
  const store = new WitnessedStore(req.store, () => {
    const reason = req.shouldStop();
    if (reason !== undefined) publish(reason);
  });

  const worker = runInWorker(
    {
      source: req.source,
      module,
      runId: req.runId,
      handler: "bridged",
      pins: req.pins,
      entries: req.entries,
      ...(req.file !== undefined ? { file: req.file } : {}),
      ...(req.seed !== undefined ? { seed: req.seed } : {}),
      ...(req.effectCeiling !== undefined ? { effectCeiling: req.effectCeiling } : {}),
      ...(req.stepBudget !== undefined ? { stepBudget: req.stepBudget } : {}),
    },
    { entry, bridge: { handler: req.handler, store } },
  );
  publish = (reason) => worker.stop(reason);

  // A horizon that passed before the run began is published before the thread's first pre-effect
  // check, so the run stops with ZERO effects — the same answer the walker gives.
  const already = req.shouldStop();
  if (already !== undefined) worker.stop(already);

  // The host's stop conditions with no bridge traffic to ride on; see STOP_POLL_MS. The callback
  // runs on the timer's own stack, where a throwing `shouldStop` would otherwise become an
  // UNCAUGHT exception that bypasses every catch the driver holds and leaves the worker running -
  // the walker route surfaces the same throw inside the driver's try, so this route must answer
  // the same way: stop the run, and re-raise the fault from the await below, on the caller's
  // stack. (The same throw at an append boundary already answers honestly: the store's
  // before-append check rejects that append, and the run is graded through the L5010 path.)
  let pollFault: unknown;
  const poll = setInterval(() => {
    try {
      const reason = req.shouldStop();
      if (reason !== undefined) worker.stop(reason);
    } catch (e) {
      pollFault = e ?? new Error("the host's stop check threw a falsy value");
      clearInterval(poll);
      worker.stop("the host's stop check itself threw; the driver re-raises the fault");
    }
  }, STOP_POLL_MS);

  try {
    const result = await worker.done;
    if (pollFault !== undefined) throw pollFault;
    if (!result.ok) throw rehydrate(result, store);
    return {
      value: result.value,
      journal: new Journal({ run: req.runId, entries: result.entries }),
      programHash: result.programHash,
      pins: result.pins,
      steps: result.steps,
    };
  } finally {
    clearInterval(poll);
  }
}
