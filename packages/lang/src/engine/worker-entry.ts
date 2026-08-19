/**
 * Inside the thread: lockdown, one Compartment, and the run.
 *
 * THIS FILE IS THE CONFINEMENT. `lockdown()` runs ONCE, here, at module load and before anything of
 * the run exists - it is irreversible and realm-wide, so it belongs at the top of a realm nobody
 * else owns. Each run then gets a Compartment with ZERO ENDOWMENTS and the transform's module is
 * evaluated in it; the context is the CALL ARGUMENT, not a global (seam ruling 1), so the program's
 * `globalThis` is empty and the seam is a value it was handed rather than a name it can reach.
 *
 * MEASURED HERE, at ses@2.3.0 on node v26.7.0, rather than assumed:
 *   inside a Compartment      `Date.now()` and `Math.random()` THROW in secure mode; `process` is
 *                             undefined; `globalThis` has 0 own keys; and
 *                             `(function(){}).constructor("return typeof process")()` throws
 *                             "Function.prototype.constructor is not a valid constructor"
 *   confinement, not hiding   `({}).constructor === Object` is still true, deliberately: the program
 *                             shares the realm's intrinsics, it just cannot reach out of it
 *   the START compartment     KEEPS Date.now, Math.random and process - which is what lets the host
 *                             half of this thread (the journal, the effect path, the handler) work
 *                             normally around a program that cannot touch any of them
 *
 * WHAT IS NOT HERE, on purpose: no wall-clock timeout, no `terminate()` on a deadline. A thread
 * killed mid-effect leaves a journal saying a step is pending and nothing that can settle it. The
 * step budget (L4013) and the shared stop flag are the only two things that end a run.
 */

import { parentPort, workerData } from "node:worker_threads";
import "ses";
import { Journal } from "../journal.js";
import { RuntimeFault } from "../errors.js";
import { assertCrossable } from "../values.js";
import type { EffectHandler } from "../effects.js";
import { runOnEngine } from "./host.js";
import type { EngineCtx } from "./ctx.js";
import type { WorkerRunRequest, WorkerRunResult } from "./worker.js";

// ONCE PER THREAD, and before the run exists.
lockdown();

if (parentPort === null) throw new Error("cotal-lang engine worker: no parent port; this module is a worker entry, not a library");
const port = parentPort;

const { request, stop } = workerData as { request: WorkerRunRequest; stop: SharedArrayBuffer };

/**
 * The run's cancellation, read where it has always been read.
 *
 * Synchronous by necessity - the effect path asks between effects - which is why it is shared memory
 * rather than a message. The length is loaded atomically because the writer publishes it last.
 */
const stopLength = new Int32Array(stop, 0, 1);
const stopBytes = new Uint8Array(stop, 4);
const shouldStop = (): string | undefined => {
  const n = Atomics.load(stopLength, 0);
  // `.slice` copies out of shared memory: a decoder is not handed a buffer that can change under it.
  return n > 0 ? new TextDecoder().decode(stopBytes.slice(0, n)) : undefined;
};

/**
 * The confined evaluator: a Compartment per run, with nothing in it.
 *
 * `runOnEngine` takes this rather than defaulting to one, and that is the security posture rather
 * than an inconvenience - turning a module string into a function is exactly where confinement is
 * applied or lost, so the caller says which it is and a reviewer can see it.
 */
const confined = (module: string): ((ctx: EngineCtx) => () => Promise<unknown>) => {
  const compartment = new Compartment();
  const factory = compartment.evaluate(module) as unknown;
  if (typeof factory !== "function") {
    throw new RuntimeFault(
      "L1000",
      `the transformed module must evaluate to a function taking the context, and this one evaluated to ${typeof factory}`,
    );
  }
  return factory as (ctx: EngineCtx) => () => Promise<unknown>;
};

async function buildHandler(): Promise<EffectHandler> {
  const mod = (await import(request.handler.module)) as Record<string, unknown>;
  const name = request.handler.export ?? "createHandler";
  const make = mod[name];
  if (typeof make !== "function") {
    throw new RuntimeFault(
      "L1000",
      `${request.handler.module} has no \`${name}\` export that is a function. A handler is not serialisable - it holds sockets, a client and a clock - so the request names a module and the thread builds it: that export takes the config and answers an EffectHandler.`,
    );
  }
  return (make as (config: unknown) => EffectHandler)(request.handler.config);
}

async function run(): Promise<WorkerRunResult> {
  const handler = await buildHandler();
  const result = await runOnEngine(request.source, request.module, {
    runId: request.runId,
    handler,
    evaluate: confined,
    shouldStop,
    ...(request.file !== undefined ? { file: request.file } : {}),
    ...(request.pins !== undefined ? { pins: request.pins } : {}),
    ...(request.entries !== undefined ? { journal: new Journal({ run: request.runId, entries: request.entries }) } : {}),
    onLog: (line) => port.postMessage({ kind: "log", line: { scope: line.scope, values: [...line.values] } }),
  });
  // THE RUN'S VALUE CROSSES A BOUNDARY, so it answers to the language's own crossing rule rather
  // than to the structured-clone algorithm's. A function reaching this line would otherwise fail as
  // a DataCloneError naming a host algorithm, when what happened is that a run tried to return
  // something that cannot be recorded.
  //
  // ABSENCE IS NOT A VALUE and is not put through a rule about values: a program whose last line is
  // a statement ends with no value at all, and the walker reports exactly that, so asserting here
  // would refuse the ordinary case. Measured: the first worker cell written refused its own fixture
  // with `undefined ... Use null when you mean "no value"` before this line said so.
  if (result.value !== undefined) assertCrossable(result.value, "the value this run returned");
  return {
    ok: true,
    value: result.value,
    entries: result.journal.entries(),
    pins: result.pins,
    programHash: result.programHash,
    steps: result.steps,
  };
}

run().then(
  (result) => port.postMessage({ kind: "result", result }),
  (e: unknown) => {
    const err = e as { code?: string; name?: string; message?: string };
    port.postMessage({
      kind: "result",
      result: {
        ok: false,
        ...(typeof err?.code === "string" ? { code: err.code } : {}),
        name: typeof err?.name === "string" ? err.name : "Error",
        message: typeof err?.message === "string" ? err.message : String(e),
      } satisfies WorkerRunResult,
    });
  },
);
