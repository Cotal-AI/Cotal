// One foreign-error case per process: a broken bridge must not strand the parent test suite.
import assert from "node:assert/strict";
import { MessageChannel } from "node:worker_threads";
import { runInWorker } from "../dist/engine/worker.js";
import { bridgedSeam, serviceBridge } from "../dist/engine/bridge.js";
import { SimHandler } from "../dist/sim.js";

const cases = [
  { expression: '(() => { const e = new Error("native"); e.name = 7; return e; })()', name: "Error", message: "native" },
  { expression: '(() => { const e = new Error("native"); e.message = 17; return e; })()', name: "Error", message: "Error: 17" },
  { expression: '(() => { const e = new Error("native"); e.message = null; return e; })()', name: "Error", message: "Error: null" },
  { expression: '(() => { const e = new Error("native"); e.message = Symbol("message"); return e; })()', name: "Error", message: "<unprintable thrown value>" },
  { expression: '({ get name() { throw new Error("name-getter"); }, message: "original" })', name: "Error", message: "original" },
  { expression: '({ name: "Foreign", get message() { throw new Error("message-getter"); } })', name: "Foreign", message: "[object Object]" },
  { expression: '(() => { const e = new Error("native"); let n = 0; Object.defineProperty(e, "message", { get() { if (++n === 1) return 17; throw new Error("second-read"); } }); return e; })()', name: "Error", message: "<unprintable thrown value>" },
  { expression: '({ toString() { return "original-handler-failure"; }, get [Symbol.toStringTag]() { throw new Error("tag-getter"); } })', name: "Error", message: "original-handler-failure" },
  { expression: '({ get message() { throw new Error("message-getter"); }, toString() { throw new Error("coercion-failure"); } })', name: "Error", message: "<unprintable thrown value>" },
  { expression: '(() => { const e = new Error("native"); e.name = () => 1; return e; })()', name: "Error", message: "native" },
  { expression: '(() => { const e = new Error("native"); e.message = () => 1; return e; })()', name: "Error", message: undefined },
];
const selected = cases[Number(process.argv[2])];
assert.ok(selected);
const route = process.argv[3];
const entry = new URL("../dist/engine/worker-entry.js", import.meta.url);
const handler = { module: new URL("./_sim-handler.mjs", import.meta.url).href, config: {} };
const source = 'log("foreign-error");';
let result;
if (route === "bridge") {
  const { port1, port2 } = new MessageChannel();
  const host = serviceBridge(port1, { handler: new SimHandler({}), store: { append: async () => { throw Function(`return ${selected.expression}`)(); } } });
  try {
    const remote = bridgedSeam(port2, host.clock);
    try { await remote.store.append({}); assert.fail("foreign throw unexpectedly succeeded"); }
    catch (error) { result = { name: error.name, message: error.message }; }
  } finally { host.close(); port1.close(); port2.close(); }
} else {
  const control = await runInWorker({ source, module: "(ctx) => async () => { await ctx.fuel(); return 1; }", runId: "hostile-error", handler }, { entry }).done;
  assert.ok(control.ok);
  const module = `(ctx) => async () => { await ctx.fuel(); throw ${selected.expression}; }`;
  result = await runInWorker({ source, module, runId: "hostile-error", ...(route === "inspection" ? { handler: "inspection", pins: control.pins, entries: control.entries } : { handler }) }, { entry }).done;
  assert.equal(result.ok, false);
  assert.equal(result.class, "error");
}
assert.equal(result.name, selected.name);
assert.equal(typeof result.message, "string");
if (selected.message !== undefined) assert.equal(result.message, selected.message);
else assert.ok(result.message.startsWith("Error: ") && !result.message.includes("DataCloneError"));
console.log("foreign error answered as strings");
