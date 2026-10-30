import assert from "node:assert/strict";
import { MessageChannel } from "node:worker_threads";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { runInWorker } from "../src/engine/worker.js";
import { bridgedSeam, serviceBridge } from "../src/engine/bridge.js";
import { SimHandler } from "../src/sim.js";
import { messageOf } from "../src/errors.js";
import { emitSentinel } from "@cotal-ai/smoke-kit";

let passed = 0, failed = 0;
function check(name: string, ok: boolean, detail?: unknown) {
  if (ok) passed++;
  else { failed++; console.error(`FAIL: ${name}`, detail); }
}
const entry = new URL("../dist/engine/worker-entry.js", import.meta.url);
const handler = { module: new URL("./_sim-handler.mjs", import.meta.url).href, config: {} };
const source = 'log("fixture");';
const successful = await runInWorker({ source, module: "(ctx) => async () => { await ctx.fuel(); return 1; }", runId: "error-shape", handler }, { entry }).done;
assert.ok(successful.ok, "real worker control must run before inspecting its recorded pins");
check("native worker control completes", successful.value === 1);

const cases = [
  { label: "plain named object", expression: '({ name: "ForeignFailure", message: "precise failure" })', value: { name: "ForeignFailure", message: "precise failure" }, name: "ForeignFailure" },
  { label: "plain message object", expression: '({ message: "plain failure" })', value: { message: "plain failure" }, name: "Error" },
  { label: "empty message", expression: '({ name: "Empty", message: "" })', value: { name: "Empty", message: "" }, name: "Empty" },
  { label: "nonstring fields", expression: '({ name: 4, message: 5 })', value: { name: 4, message: 5 }, name: "Error" },
  { label: "string", expression: '"primitive failure"', value: "primitive failure", name: "Error" },
  { label: "number", expression: "42", value: 42, name: "Error" },
  { label: "null", expression: "null", value: null, name: "Error" },
  { label: "undefined", expression: "undefined", value: undefined, name: "Error" },
  { label: "native Error", expression: 'new Error("native failure")', value: new Error("native failure"), name: "Error" },
];
for (const test of cases) {
  const module = `(ctx) => async () => { await ctx.fuel(); throw ${test.expression}; }`;
  const ordinary = await runInWorker({ source, module, runId: "error-shape", handler }, { entry }).done;
  const inspection = await runInWorker({ source, module, runId: "error-shape", handler: "inspection", pins: successful.pins, entries: successful.entries }, { entry }).done;
  const expected = messageOf(test.value);
  check(`${test.label}: normal worker preserves name/message`, !ordinary.ok && ordinary.name === test.name && ordinary.message === expected, ordinary);
  check(`${test.label}: inspection preserves the same name/message`, !inspection.ok && inspection.name === test.name && inspection.message === expected, inspection);
  check(`${test.label}: inspection detail agrees with its top-level failure`, !inspection.ok && inspection.inspection?.exit?.kind === "error" && inspection.inspection.exit.name === inspection.name && inspection.inspection.exit.message === inspection.message, inspection);
  check(`${test.label}: neither route promotes a plain throw into a typed host failure`, !ordinary.ok && ordinary.class === "error" && !inspection.ok && inspection.class === "error");

  const { port1, port2 } = new MessageChannel();
  const host = serviceBridge(port1, { handler: new SimHandler({}), store: { append: async () => { throw test.value; } } });
  try {
    const remote = bridgedSeam(port2, host.clock);
    let caught: unknown;
    try { await remote.store.append({} as never); } catch (error) { caught = error; }
    check(`${test.label}: actual MessagePort bridge preserves name/message`, caught instanceof Error && caught.name === test.name && caught.message === expected, caught);
  } finally { host.close(); port1.close(); port2.close(); }
}
check("all worker and bridge cases ran", passed + failed === 46);
for (let index = 0; index < 11; index++) {
  for (const route of ["module", "inspection", "bridge"]) {
    const child = spawnSync(process.execPath, [fileURLToPath(new URL("./_worker-error-hostile.mjs", import.meta.url)), String(index), route], {
      encoding: "utf8", timeout: 10_000,
    });
    check(`hostile field ${index} settles through ${route}`, child.status === 0 && child.stdout.includes("foreign error answered as strings"),
      { status: child.status, signal: child.signal, error: child.error?.message, stderr: child.stderr });
  }
}
check("all hostile route cases ran", passed + failed === 80);
emitSentinel({ passed, failed });
if (failed) process.exitCode = 1;
