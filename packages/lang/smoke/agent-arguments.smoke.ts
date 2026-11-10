import assert from "node:assert/strict";
import { runOnEngine, type ModuleFactory } from "../src/engine/host.js";
import { run, type RunOptions } from "../src/interpret.js";
import { Journal } from "../src/journal.js";
import { SimHandler } from "../src/sim.js";
import { transform } from "../src/transform/index.js";
import { emitSentinel } from "@cotal-ai/smoke-kit";

const engines = {
  walker: run,
  engine: (source: string, options: RunOptions) => runOnEngine(source, transform(source).module, {
    ...options,
    evaluate: (module) => new Function(`return (${module});`)() as ModuleFactory,
  }),
};
const calls = [
  ["ask", (v: string) => `await ask(${v}, { name: "q", schema: {} })`, "argument 1"],
  ["turn", (v: string) => `await turn(${v}, { name: "q" })`, "argument 1"],
  ["monitor", (v: string) => `await monitor(${v})`, "argument 1"],
  ["replied", (v: string) => `replied(${v})`, "argument 1"],
  ["down", (v: string) => `down(${v})`, "argument 1"],
  ["message", (v: string) => `message(channel("room"), { from: ${v} })`, "`from`"],
  ["notify", (v: string) => `await notify([${v}], { decision: "ok", outcome: "done" })`, "argument 1 of `notify`[0]"],
  ["conclave", (v: string) => `await conclave([${v}], async (room) => {}, { name: "q" })`, "argument 1 of `conclave`[0]"],
] as const;
const malformed = ['"bob"', "null", "undefined", "42", "false", "[]", "{}", '{ agent: 4, persona: "p" }', '{ agent: "", persona: "p" }', '{ agent: "bob" }', '{ agent: "bob", persona: "p", kind: "other" }'];
let count = 0;
for (const [engine, execute] of Object.entries(engines)) {
  for (const [name, source, where] of calls) {
    for (const value of malformed) {
      // An omitted sender filter is valid, including an option whose value is undefined.
      if (name === "message" && value === "undefined") continue;
      const runId = `${engine}-${count++}`;
      const journal = new Journal({ run: runId });
      await assert.rejects(execute(source(value), { runId, journal, handler: new SimHandler({}) }), (e: unknown) => {
        const fault = e as { code?: string; message?: string };
        return fault.code === "L3050" && fault.message?.includes(`\`${name}\``) === true
          && fault.message.includes(where) && fault.message.includes("returned handle");
      }, `${engine}: ${name} refuses ${value} with its argument and remedy`);
      assert.equal(journal.entries().length, 0, `${engine}: ${name} refuses before journal or dispatch`);
    }
  }
  for (const name of ["notify", "conclave"]) {
    const source = name === "notify"
      ? 'await notify("bob", { decision: "ok", outcome: "done" })'
      : 'await conclave("bob", async (room) => {}, { name: "q" })';
    await assert.rejects(execute(source, { runId: `${engine}-list-${name}`, handler: new SimHandler({}) }), /L3050.*array of agent handles/);
    count++;
  }
  for (const origin of ['await spawn("p")', 'await participant()', '{ agent: "old.worker", persona: "p" }']) {
    const source = `const a = ${origin};
      await monitor(a);
      replied(a);
      down(a);
      message(channel("room"), { from: a });
      message(channel("room"), { from: undefined });
      await notify([a], { decision: "ok", outcome: "done" });
      await conclave([a], async (room) => {}, { name: "team" });
      await turn(a, { name: "q" });
      await ask(a, { name: "answer", schema: {} });`;
    const result = await execute(source, {
      runId: `${engine}-control-${count++}`,
      handler: new SimHandler({ turns: { q: { status: "done" } }, asks: { answer: {} } }),
    });
    assert(result.journal.entries().every((e) => e.status === "ok"), `${engine}: ${origin} remains usable`);
  }
}
emitSentinel({ passed: count, failed: 0 });
