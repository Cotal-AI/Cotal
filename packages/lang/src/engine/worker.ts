/**
 * One worker thread per run, and the boundary a run's request and answer cross.
 *
 * WHY A THREAD AT ALL. `lockdown()` is irreversible and realm-wide: it hardens the intrinsics of the
 * whole isolate, and a host process that also serves a mesh client, a journal store and a CLI cannot
 * accept that on its own behalf. A worker gives the run its own realm to harden, and gives the host
 * an isolate whose intrinsics it still owns.
 *
 * WHAT ACTUALLY CROSSES. The whole run happens INSIDE the thread - the seam, the journal, the effect
 * host and the handler. That is not an optimisation: `handler.now()` and every `journal.*` call in
 * the effect path are SYNCHRONOUS, and a proxy over a message port is not. So the request names the
 * handler by module and the worker constructs it there, and what crosses is a request in and a
 * result out, with log lines streamed between.
 *
 * CANCELLATION IS THE ONE EXCEPTION, and it is why there is a SharedArrayBuffer here. `shouldStop`
 * is read synchronously, between effects, so it cannot be a message either. The host writes a reason
 * into shared memory and the run reads it where it always read it. There is NO wall-clock timeout
 * and no `terminate()` on a deadline: a thread killed mid-effect leaves the journal saying a step is
 * pending forever, and the step budget plus this flag are the only two things that end a run.
 *
 * Measured on this floor (node v26.7.0, ses@2.3.0): lockdown 4.5ms, ONCE per thread; a Compartment
 * after it 0.03ms, so the per-run cost is the thread, not the confinement; cold start to first
 * message, lockdown included, 22.8-26.4ms over three spawns.
 */

import { Worker } from "node:worker_threads";
import type { JournalEntry } from "./../journal.js";
import type { RunPins } from "../pins.js";

/** Where the reason's byte length lives in the shared stop buffer; the bytes follow it. */
const STOP_HEADER = 4;
/** Room for the reason. A reason is a sentence, and one that does not fit is truncated, not dropped. */
const STOP_CAPACITY = 512;

export interface WorkerHandlerSpec {
  /**
   * The module to import INSIDE the thread. An absolute `file:` URL or a bare package specifier.
   *
   * A handler is not serialisable and must not be: it holds sockets, a mesh client and a clock. What
   * crosses is its NAME.
   */
  readonly module: string;
  /** The export to call. It takes `config` and answers an `EffectHandler`. */
  readonly export?: string;
  /** Handed to that export, verbatim. Must be structured-cloneable, being all that crosses. */
  readonly config?: unknown;
}

export interface WorkerRunRequest {
  readonly source: string;
  readonly module: string;
  readonly runId: string;
  readonly handler: WorkerHandlerSpec;
  readonly pins?: RunPins;
  /** A resume: the recorded entries, rebuilt into the run's journal inside the thread. */
  readonly entries?: readonly JournalEntry[];
  readonly file?: string;
}

export interface WorkerRunOk {
  readonly ok: true;
  readonly value: unknown;
  readonly entries: readonly JournalEntry[];
  readonly pins: RunPins;
  readonly programHash: string;
  readonly steps: number;
}

export interface WorkerRunFailed {
  readonly ok: false;
  /** The language code where there is one (`L4013`, `L5011`), so a caller can branch as it always has. */
  readonly code?: string;
  readonly name: string;
  readonly message: string;
}

export type WorkerRunResult = WorkerRunOk | WorkerRunFailed;

export interface WorkerRun {
  /** The run's answer. It rejects only for a worker that died without one. */
  readonly done: Promise<WorkerRunResult>;
  /**
   * Ask the run to stop, with a reason.
   *
   * It is a request, not a kill: the run reads it between effects and at a fuel yield, finishes what
   * is already in flight, and ends through its own cancellation path with the journal consistent.
   */
  stop(reason: string): void;
}

/** Write a stop reason into shared memory: the bytes first, then the length that publishes them. */
function publishStop(buffer: SharedArrayBuffer, reason: string): void {
  const bytes = new TextEncoder().encode(reason).subarray(0, STOP_CAPACITY);
  new Uint8Array(buffer, STOP_HEADER).set(bytes);
  // LENGTH LAST, and with Atomics: it is what makes the bytes visible, so a reader can never see a
  // length that promises bytes the writer has not finished writing.
  Atomics.store(new Int32Array(buffer, 0, 1), 0, Math.max(bytes.length, 1));
}

/**
 * THE WORKER ENTRY IS AN INPUT, not something this module derives.
 *
 * A thread's entry is a FILE ON DISK, and which file that is depends on how the caller was built and
 * installed - not on anything this module can see about itself. From the compiled package it is
 * `new URL("./worker-entry.js", import.meta.url)` resolved in the compiled module; a suite that
 * wants to grade the SHIPPED artifact names that artifact; a bundler that rewrote the layout names
 * what it produced. So the composition root passes it, and this module makes no guess.
 *
 * It was derived here, and the derivation was measurably wrong. Running from TypeScript sources,
 * node 22 does not apply the parent's ESM loader hooks to a worker thread: a `.js` entry is
 * ERR_MODULE_NOT_FOUND, and the `.ts` entry gets exactly one step further before dying on its own
 * `../journal.js`. Inherited execArgv already carries tsx's `--import` into the thread and an
 * explicit `execArgv: ["--import", "tsx"]` adds it again; neither changes the answer. No spelling
 * this module could pick makes a `.ts` tree runnable in a thread on that node - the answer is to run
 * the BUILD, which is a fact about the caller. Making the entry an argument is what lets the caller
 * say so, and it is why nothing here is version-conditional.
 */
export interface WorkerRunOptions {
  /**
   * The module the thread starts at: `engine/worker-entry`, in whatever build the caller is running.
   * A `file:` URL or an absolute path.
   */
  readonly entry: URL | string;
  /** Called for each `log` the run emits, as it emits it. */
  readonly onLog?: (line: { scope: string; values: readonly unknown[] }) => void;
}

/**
 * Run a transformed program in its own locked-down thread.
 *
 * The worker is terminated when the run answers, however it answers: one thread per run is the whole
 * point, and a thread that outlives its run is a realm holding a journal nobody is reading.
 */
export function runInWorker(request: WorkerRunRequest, options: WorkerRunOptions): WorkerRun {
  const stop = new SharedArrayBuffer(STOP_HEADER + STOP_CAPACITY);
  const worker = new Worker(options.entry, { workerData: { request, stop } });

  const done = new Promise<WorkerRunResult>((resolve, reject) => {
    let answered = false;
    worker.on("message", (m: { kind: "log"; line: { scope: string; values: readonly unknown[] } } | { kind: "result"; result: WorkerRunResult }) => {
      if (m.kind === "log") {
        options.onLog?.(m.line);
        return;
      }
      // AN UNKNOWN KIND IS A DISAGREEMENT ABOUT THE PROTOCOL, and it is refused rather than read as
      // an answer. This branch used to be `else`, so a thread posting anything unexpected resolved
      // the run with `undefined` and the real result arrived after nobody was listening - a run
      // reporting success with no value, from a boundary that had already gone wrong.
      if (m.kind !== "result") {
        answered = true;
        reject(new Error(`cotal-lang engine worker sent a message kind this host does not know (${String((m as { kind?: unknown }).kind)}); the thread and the host disagree about the boundary`));
        return;
      }
      answered = true;
      resolve(m.result);
    });
    worker.on("error", (e: Error) => reject(e));
    worker.on("exit", (code) => {
      // A worker that exits without answering has taken the run's outcome with it, and saying so is
      // the only honest thing left: the journal may hold a pending step and only the store knows.
      if (!answered) reject(new Error(`cotal-lang engine worker exited with code ${code} before the run answered`));
    });
  }).finally(() => void worker.terminate());

  return { done, stop: (reason) => publishStop(stop, reason) };
}
