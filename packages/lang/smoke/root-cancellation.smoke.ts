import assert from "node:assert/strict";
import { emitSentinel } from "@cotal-ai/smoke-kit";
import { Cancelled, RootCancellation, RunReleased, type EffectContext, type SleepRequest } from "../src/effects.js";
import { run } from "../src/interpret.js";
import { SimHandler } from "../src/sim.js";
import { transform } from "../src/transform/index.js";
import { runInWorker } from "../src/engine/worker.js";
import { Journal, type JournalEntry } from "../src/journal.js";

const entry = new URL("../dist/engine/worker-entry.js", import.meta.url);
const source = 'await sleep("1s"); await sleep("1s");';
let passed = 0;
function check(name: string, value: unknown): void {
  assert.ok(value, name);
  passed++;
  console.log(`  ok ${name}`);
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}
class Parked extends SimHandler {
  calls = 0;
  heard: string[] = [];
  entered = deferred<void>();
  release = deferred<void>();
  override async sleep(_req: SleepRequest, ctx: EffectContext): Promise<null> {
    this.calls++;
    ctx.signal.onCancel((reason) => { this.heard.push(reason); this.release.resolve(); });
    if (ctx.signal.cancelled) this.release.resolve();
    this.entered.resolve();
    await this.release.promise;
    if (ctx.signal.cancelled) throw new Cancelled(ctx.signal.reason ?? "cancelled");
    return null;
  }
}

for (const engine of ["walker", "worker"] as const) {
  for (const at of ["boot", "parked"] as const) {
    const handler = new Parked({});
    const cancellation = new RootCancellation();
    const entries: JournalEntry[] = [];
    const store = { append: async (row: JournalEntry) => { entries.push(row); } };
    const runId = `root-${engine}-${at}`;
    if (at === "boot") cancellation.cancel("first reason");
    let done: Promise<unknown>;
    let remove: (() => void) | undefined;
    if (engine === "walker") {
      done = run(source, { runId, handler, cancellation, journal: new Journal({ run: runId, store }) })
        .then(() => ({ ok: true }), (error: unknown) => ({ ok: false, cancelled: error instanceof Cancelled, error }));
    } else {
      const worker = runInWorker({ source, module: transform(source).module, runId, handler: "bridged" }, { entry, bridge: { handler, store } });
      remove = cancellation.subscribe((reason) => worker.cancel(reason));
      done = worker.done;
    }
    const timeout = setTimeout(() => { handler.release.resolve(); }, 5_000);
    try {
      if (at === "parked") {
        await Promise.race([handler.entered.promise, done.then(() => { throw new Error("run ended before entering the park"); })]);
        cancellation.cancel("first reason");
        cancellation.cancel("later reason");
      }
      const result = await done as { ok: boolean; class?: string; cancelled?: boolean; reason?: string; error?: Cancelled };
      check(`${engine} ${at}: distinct root cancellation outcome`, !result.ok && (engine === "worker" ? result.class === "cancelled" : result.cancelled));
      check(`${engine} ${at}: first reason survives`, (result.reason ?? result.error?.reason) === "first reason");
      check(`${engine} ${at}: no next effect dispatch`, handler.calls === (at === "boot" ? 0 : 1));
      check(`${engine} ${at}: bridge/handler receives only the parked cancellation`, handler.heard.length === (at === "boot" ? 0 : 1));
      check(`${engine} ${at}: journal cancellation is durable before outcome`, at === "boot" ? entries.length === 0 : entries.some(row => row.state === "settled" && row.status === "cancelled"));
    } finally {
      clearTimeout(timeout);
      remove?.();
    }
  }

  const handler = new Parked({});
  let pause: string | undefined;
  const runId = `release-${engine}`;
  const worker = engine === "worker"
    ? runInWorker({ source, module: transform(source).module, runId, handler: "bridged" }, { entry, bridge: { handler, store: { append: async () => {} } } })
    : undefined;
  const done = worker ? worker.done : run(source, { runId, handler, shouldStop: () => pause })
    .then(() => ({ ok: true }), (error: unknown) => ({ ok: false, released: error instanceof RunReleased }));
  await handler.entered.promise;
  pause = "boundary release";
  worker?.stop(pause);
  check(`${engine}: release does not cancel a parked effect`, handler.heard.length === 0);
  handler.release.resolve();
  const result = await done as { ok: boolean; class?: string; released?: boolean };
  check(`${engine}: release retains its distinct boundary outcome`, !result.ok && (worker ? result.class === "released" : result.released));
  check(`${engine}: released run performs no next effect`, handler.calls === 1);
}

const token = new RootCancellation();
let calls = 0;
const remove = token.subscribe(() => { calls++; });
remove();
token.cancel("done");
check("removed root listener is not retained", calls === 0);
token.subscribe(() => { calls++; });
check("late root subscription receives the latched reason", calls === 1);
emitSentinel({ passed, failed: 0 });
