import assert from "node:assert/strict";
import { emitSentinel } from "@cotal-ai/smoke-kit";
import { messageOf, nameOf } from "../src/errors.js";
import { SimHandler } from "../src/sim.js";
import { ENGINE_LANGUAGE_VERSION, resolvePins } from "../src/pins.js";
import { transform } from "../src/transform/index.js";
import { runInWorker, type WorkerHandlerSpec, type WorkerRunFailed } from "../src/engine/worker.js";

const entry = new URL("../dist/engine/worker-entry.js", import.meta.url);
const module = new URL("./_sim-handler.mjs", import.meta.url).href;
const throwingModule = new URL("./_throw-handler.mjs", import.meta.url).href;
let passed = 0;
function check(name: string, actual: unknown, expected: unknown): void {
  assert.deepEqual(actual, expected, name);
  passed++;
  console.log(`  ok ${name}`);
}

const cases = [
  { label: "named object", value: { name: "ProbeError", message: "probe-x" }, name: "ProbeError", message: "probe-x" },
  { label: "message object", value: { message: "probe-x" }, name: "Error", message: "probe-x" },
  { label: "non-string fields", value: { name: 7, message: false }, name: "Error", message: "[object Object]" },
  { label: "empty fields", value: { name: "", message: "" }, name: "", message: "" },
  { label: "string", value: "probe-x", name: "Error", message: "probe-x" },
  { label: "null", value: null, name: "Error", message: "null" },
  { label: "undefined", value: undefined, name: "Error", message: "undefined" },
  { label: "number", value: 42, name: "Error", message: "42" },
];

async function fail(source: string, handler: WorkerHandlerSpec | "inspection" | "bridged", thrown?: unknown): Promise<WorkerRunFailed> {
  const runId = "worker-errors";
  class Throwing extends SimHandler {
    override async sleep(): Promise<null> { throw thrown; }
  }
  const answer = await runInWorker({
    source, module: transform(source).module, runId, handler,
    ...(handler === "inspection" ? { pins: resolvePins({ runId }, 0, ENGINE_LANGUAGE_VERSION) } : {}),
  }, {
    entry,
    ...(handler === "bridged" ? { bridge: { handler: new Throwing({}), store: { append: async () => {} } } } : {}),
  }).done;
  assert.equal(answer.ok, false, "the worker must return a failure answer");
  if (answer.ok) throw new Error("expected a worker failure");
  return answer;
}

for (const c of cases) {
  for (const route of ["inspection", "module", "bridged"] as const) {
    const literal = c.value === undefined ? "undefined" : JSON.stringify(c.value);
    const answer = await fail(`throw ${literal}`, route === "module" ? { module, config: {} } : route);
    check(`${route}: ${c.label} preserves failure text`, { name: answer.name, message: answer.message, class: answer.class },
      { name: c.name, message: c.message, class: "error" });
    if (route === "inspection") {
      check(`inspection: ${c.label} answer agrees with exit`, answer.inspection?.exit,
        { kind: "error", name: c.name, message: c.message });
    }
  }
}

for (const c of cases) {
  const value = c.value;
  check(`shared readers: ${c.label}`, { name: nameOf(value), message: messageOf(value) }, { name: c.name, message: c.message });
  // A factory failure reaches answerWith before the engine or its effect wrapper can alter it.
  const startup = await fail("0", { module: throwingModule, config: { value } });
  check(`module factory: ${c.label}`, { name: startup.name, message: startup.message }, { name: c.name, message: c.message });
  // The host's plain-error bridge branch must carry the message into the worker's effect wrapper.
  const bridged = await fail('await sleep("1s", { name: "nap" })', "bridged", value);
  check(`bridge handler: ${c.label}`, { name: bridged.name, message: bridged.message, class: bridged.class, code: bridged.class === "effect" ? bridged.code : undefined },
    { name: "EffectError", message: c.message, class: "effect", code: "L4000" });
}

const native = new TypeError("probe-x");
check("shared readers preserve a native Error", { name: nameOf(native), message: messageOf(native) }, { name: "TypeError", message: "probe-x" });
const startup = await fail("0", { module: throwingModule, config: { native: true } });
check("module factory preserves a native Error", { name: startup.name, message: startup.message }, { name: "TypeError", message: "probe-x" });
const bridged = await fail('await sleep("1s", { name: "nap" })', "bridged", native);
check("bridge handler preserves a native Error message", { name: bridged.name, message: bridged.message, class: bridged.class },
  { name: "EffectError", message: "probe-x", class: "effect" });
const frontier = await fail('await sleep("1s", { name: "nap" })', "inspection");
check("inspection preserves its native frontier Error", { name: frontier.name, message: frontier.message, exit: frontier.inspection?.exit },
  { name: "InspectionStopped", message: "inspection reached frontier at /sleep:nap#0", exit: { kind: "frontier", step: "/sleep:nap#0" } });

emitSentinel({ passed, failed: 0 });
