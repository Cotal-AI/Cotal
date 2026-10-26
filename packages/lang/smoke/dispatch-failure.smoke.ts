import assert from "node:assert/strict";
import {
  Cancelled, EffectError, EffectRefused, Journal, JournalAppendRejected, RunHeld, SimHandler,
  WALKER_LANGUAGE_VERSION, resolvePins, resume, run,
  type EffectContext, type JournalEntry, type ObserveRequest, type SleepRequest,
} from "../dist/index.js";

const PROGRAMS = {
  waitUntil: 'await waitUntil(() => 1, { name: "poll", every: "1s", deadline: "10s" });',
  sleep: 'await sleep("1s", { name: "nap" });',
};

// A getter observes the actual recorder's call stack without replacing or editing production code.
// Equal journal shapes alone cannot distinguish one recorder from two copies that agree today.
for (const [kind, source] of Object.entries(PROGRAMS)) {
  const cases = [
    { name: "plain error", make: () => new Error("boom 3661"), code: "L4000", errorKind: "handler-fault" },
    { name: "null", make: () => null, code: "L4000", errorKind: "handler-fault" },
    { name: "language code", make: () => ({ code: "L6001", message: "unscripted" }), code: "L6001", errorKind: "handler-fault" },
    { name: "foreign code", make: () => ({ code: "EIO", message: "io" }), code: "L4000", errorKind: "handler-fault" },
    { name: "faithful detail", make: () => new EffectError("L6002", "scripted", "detail", { value: 1 }), code: "L6002", errorKind: "scripted", faithful: true },
    { name: "invalid detail", make: () => new EffectError("L6002", "scripted", "detail", { fn: () => 1 }), code: "L4000", errorKind: "handler-fault" },
  ];
  for (const cell of cases) {
    const failure = cell.make();
    class Throwing extends SimHandler {
      async observe(): Promise<boolean> { this.advance(7); throw failure; }
      async sleep(): Promise<null> { this.advance(7); throw failure; }
    }
    const journal = new Journal({ run: "dispatch-failure" });
    let raised: unknown;
    await assert.rejects(run(source, { runId: "dispatch-failure", journal, handler: new Throwing({}) }), (e: unknown) => {
      raised = e;
      return e instanceof EffectError && e.code === cell.code && e.kind === cell.errorKind;
    });
    const [entry] = journal.entries();
    assert.equal(journal.entries().length, 1);
    assert.equal(entry?.kind, kind);
    assert.equal(entry?.status, "failed");
    assert.equal(entry?.endedAt, 7);
    assert.equal(entry?.error?.code, cell.code);
    assert.equal(entry?.error?.kind, cell.errorKind);
    assert.equal(entry?.error?.message, (raised as EffectError).message);
    if (failure instanceof Error) assert.equal(entry?.error?.stack, failure.stack);
    else assert.equal(entry?.error?.stack, undefined);
    if (cell.faithful) {
      assert.equal(raised, failure);
      assert.deepEqual(entry?.error?.detail, { value: 1 });
    }
    if (cell.name === "invalid detail") {
      assert.notEqual(raised, failure);
      assert.equal(entry?.error?.detail, undefined);
      assert.match(entry?.error?.message ?? "", /detail could not be recorded/);
    }
    console.log(`ok ${kind}: ${cell.name}`);
  }

  const recorderStacks: string[] = [];
  const failure = { message: "recorder witness", get stack() {
    recorderStacks.push(new Error("recorder witness").stack ?? "");
    return "Error: recorder witness";
  } };
  class Witness extends SimHandler {
    async observe(): Promise<boolean> { this.advance(7); throw failure; }
    async sleep(): Promise<null> { this.advance(7); throw failure; }
  }
  const times: unknown[] = [];
  await run(`try { ${source} } catch (e) { log(now()); }`, {
    runId: "recorder-witness", handler: new Witness({}), onLog: (line) => times.push(...line.values),
  });
  assert.deepEqual(times, [7], "a caught dispatch failure advances the logical clock");
  assert.equal(recorderStacks.length, 1, "the recorder reads the thrown stack once");
  assert.match(recorderStacks[0]!, /\bat settleThrown\b/, `${kind} must reach the common failure recorder`);
  console.log(`ok ${kind}: live dispatch reaches settleThrown and advances the clock`);

  for (const refused of [false, true]) {
    const failure = refused ? new EffectRefused("L5016", "not supported") : new Cancelled("stopped");
    class Stopping extends SimHandler {
      async observe(): Promise<boolean> { throw failure; }
      async sleep(): Promise<null> { throw failure; }
    }
    const journal = new Journal({ run: "stopping" });
    const pins = resolvePins({ runId: "stopping" }, 0, WALKER_LANGUAGE_VERSION);
    await assert.rejects(run(source, { runId: "stopping", journal, handler: new Stopping({}), pins }), (e: unknown) =>
      refused ? e instanceof RunHeld && e.code === "L5025" : e === failure);
    assert.equal(journal.entries()[0]?.status, refused ? "refused" : "cancelled");
    if (refused) {
      assert.deepEqual(journal.entries()[0]?.error, { code: "L5016", kind: "refused", message: "not supported" });
      const resumed = await resume(source, journal, { runId: "stopping", handler: new SimHandler({}), pins });
      assert.equal(resumed.journal.entries()[0]?.status, "ok");
    }
    console.log(`ok ${kind}: ${refused ? "refusal can resume on a capable host" : "cancellation preserves identity"}`);
  }

  // A real append refusal during handler dispatch must leave the pending entry untouched.
  const rows: JournalEntry[] = [];
  let rejection: unknown;
  const journal = new Journal({ run: "append-rejection", store: { append: async (entry) => {
    if (rows.length > 0) throw new Error("store unavailable");
    rows.push(entry);
  } } });
  class Binding extends SimHandler {
    private async bind(ctx: EffectContext): Promise<never> {
      try { await ctx.bind({ id: "external" }); } catch (e) { rejection = e; throw e; }
      throw new Error("binding should have been rejected");
    }
    async observe(_req: ObserveRequest, ctx: EffectContext): Promise<boolean> { return this.bind(ctx); }
    async sleep(_req: SleepRequest, ctx: EffectContext): Promise<null> { return this.bind(ctx); }
  }
  await assert.rejects(run(source, { runId: "append-rejection", journal, handler: new Binding({}) }), (e: unknown) =>
    e === rejection && e instanceof JournalAppendRejected);
  assert.equal(rows.length, 1);
  assert.equal(journal.entries()[0]?.state, "pending");
  assert.equal(journal.entries()[0]?.error, undefined);
  console.log(`ok ${kind}: journal append rejection is not settled as a handler fault`);
}
