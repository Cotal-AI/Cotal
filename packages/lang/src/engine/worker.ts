/**
 * One worker thread per run, and the boundary a run's request and answer cross.
 *
 * WHY A THREAD AT ALL. `lockdown()` is irreversible and realm-wide: it hardens the intrinsics of the
 * whole isolate, and a host process that also serves a mesh client, a journal store and a CLI cannot
 * accept that on its own behalf. A worker gives the run its own realm to harden, and gives the host
 * an isolate whose intrinsics it still owns.
 *
 * WHAT ACTUALLY CROSSES. The run happens INSIDE the thread - the seam, the journal and the effect
 * host - and the request comes in, the result goes out, with log lines streamed between. The
 * HANDLER has two routes, chosen by what the handler is. One that can be built from cloneable
 * config is named BY MODULE and constructed in the thread, whole. One that cannot - a live object
 * holding sockets, a mesh client, a lease-bound appender - STAYS IN THE HOST, and the thread
 * forwards the effect seam over a MessagePort (`bridge.ts`): every `EffectHandler` member except
 * `now()` is async, and the journal's durable half (`JournalStore.append`) is a Promise the
 * journal awaits before any effect fires, so both survive a port hop with the awaits lining up
 * exactly as they line up over a PubAck. What is genuinely synchronous is `now()` and the stop
 * flag, and both go over shared memory. An earlier form of this header ruled the bridge out by
 * claiming "every journal.* call in the effect path" is synchronous; the durable append never was,
 * and the in-memory reads that are never leave the thread.
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

import { MessageChannel, Worker, type MessagePort } from "node:worker_threads";
import type { EffectHandler } from "../effects.js";
import type { JournalEntry, JournalStore } from "./../journal.js";
import type { RunPins } from "../pins.js";
import { serviceBridge } from "./bridge.js";

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
  /**
   * `"bridged"` keeps the handler in the host: the thread forwards the effect seam over a
   * MessagePort instead of constructing a handler, and the caller supplies the live handler and
   * store via {@link WorkerRunOptions.bridge}. Exactly one of the two must be chosen — a request
   * naming both routes, or neither, is a caller that has not decided where its effects run.
   */
  readonly handler: WorkerHandlerSpec | "bridged";
  readonly pins?: RunPins;
  /** A resume: the recorded entries, rebuilt into the run's journal inside the thread. */
  readonly entries?: readonly JournalEntry[];
  readonly file?: string;
  /**
   * The caller's loose limits and seed, forwarded so the thread's `bindPins` performs the same
   * agreement check (L5009) the in-process engines perform: with pins present these must agree or
   * be absent, and dropping them at this boundary would silently skip that refusal.
   */
  readonly seed?: string;
  readonly effectCeiling?: number;
  readonly stepBudget?: number;
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
  /**
   * `RunReleased.reason` (L5012), carried as the field it is so a host rebuilding the class does
   * not have to parse its own sentence back out of the message.
   */
  readonly reason?: string;
  /**
   * An `EffectError`'s domain fields, carried so a host can rebuild the class whole: `kind` is what
   * failure handling branches on and `detail` is a recorded value, already fenced at its throw
   * site. Present together with `code` exactly when the run failed as an effect failure.
   */
  readonly kind?: string;
  readonly detail?: Readonly<Record<string, unknown>>;
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

/**
 * What a stop with nothing to say arrives as.
 *
 * The length is the publish signal, so a zero-length reason would be no stop at all; the previous
 * spelling floored it at 1 and the run read the one byte that happened to be there. MEASURED through
 * the real thread: `stop("")` ended the run with a sentence whose last character was a NUL. A stop is
 * an operator's act and it may not arrive as a control character, so a reason with no bytes is given
 * this one - a sentence, and true.
 */
const NO_REASON = "the operator asked this run to stop and gave no reason";

/** Write a stop reason into shared memory: the bytes first, then the length that publishes them. */
function publishStop(buffer: SharedArrayBuffer, reason: string): void {
  // `encodeInto`, NOT encode-then-slice: it fills the room with WHOLE code points and reports how
  // many bytes that took, so a reason too long for the buffer is cut BETWEEN characters instead of
  // through one. Measured through the real thread before the change: a three-byte character
  // straddling the last byte of the buffer reached the run as U+FFFD, the replacement character, on
  // the end of the operator's own sentence.
  const room = new Uint8Array(buffer, STOP_HEADER, STOP_CAPACITY);
  const { written } = new TextEncoder().encodeInto(reason === "" ? NO_REASON : reason, room);
  // LENGTH LAST, and with Atomics: it is what makes the bytes visible, so a reader can never see a
  // length that promises bytes the writer has not finished writing.
  Atomics.store(new Int32Array(buffer, 0, 1), 0, written);
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
  /**
   * The live seam a `"bridged"` request runs against: the host's handler and its durable store.
   * Required exactly when the request says `"bridged"`; see {@link WorkerRunRequest.handler}.
   */
  readonly bridge?: { readonly handler: EffectHandler; readonly store: JournalStore };
}

/**
 * Run a transformed program in its own locked-down thread.
 *
 * The worker is terminated when the run answers, however it answers: one thread per run is the whole
 * point, and a thread that outlives its run is a realm holding a journal nobody is reading.
 */
export function runInWorker(request: WorkerRunRequest, options: WorkerRunOptions): WorkerRun {
  // ONE ROUTE, DECIDED, before a thread exists to be wrong in. A bridged request with no seam has
  // nowhere to run its effects; a module-named handler beside a live seam is two answers to where
  // the effects live, and picking one silently would be this module deciding the caller's
  // confinement posture for it.
  if ((request.handler === "bridged") !== (options.bridge !== undefined)) {
    throw new Error(
      request.handler === "bridged"
        ? `request ${request.runId} names the bridged handler route but no bridge seam was supplied; pass options.bridge with the live handler and store`
        : `request ${request.runId} names a module handler and a bridge seam at once; a run's effects live in the thread or in the host, not both`,
    );
  }
  const stop = new SharedArrayBuffer(STOP_HEADER + STOP_CAPACITY);
  let host: { readonly clock: SharedArrayBuffer; close(): void } | undefined;
  let bridge: { port: MessagePort; clock: SharedArrayBuffer } | undefined;
  if (options.bridge !== undefined) {
    const channel = new MessageChannel();
    host = serviceBridge(channel.port1, options.bridge);
    bridge = { port: channel.port2, clock: host.clock };
  }
  // Two literal spellings rather than one spread, so the crossing audit in the engine suite reads
  // exactly what the thread is handed in each route off this source.
  const worker =
    bridge !== undefined
      ? new Worker(options.entry, { workerData: { request, stop, bridge }, transferList: [bridge.port] })
      : new Worker(options.entry, { workerData: { request, stop } });

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
  }).finally(() => {
    // The seam closes AFTER the thread is gone, so no in-flight effect answers into a closed port;
    // terminate() returns a promise and the close rides its settlement.
    void worker.terminate().finally(() => host?.close());
  });

  return { done, stop: (reason) => publishStop(stop, reason) };
}
