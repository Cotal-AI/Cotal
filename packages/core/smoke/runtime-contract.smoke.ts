import nodeAssert from "node:assert/strict";
import { countedAssert, emitSentinel } from "@cotal-ai/smoke-kit";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { AgentHandle, Runtime, RuntimeReference } from "../src/runtime.js";
const counted = countedAssert(nodeAssert);
const assert: typeof nodeAssert = counted.assert;
const cells = counted.cells;

const reference: RuntimeReference = { kind: "fixture", id: "opaque-local-reference" };
const handle: AgentHandle = {
  name: "fixture",
  kind: "fixture",
  reference,
  status: () => "running",
  stop: () => {},
  interrupt: () => {},
  attach: () => { throw new Error("not used"); },
};
const runtime: Runtime = {
  kind: "fixture",
  streamsTerminal: false,
  spawn: () => handle,
  adopt: (candidate) => candidate.id === reference.id ? handle : (() => { throw new Error("unknown reference"); })(),
};
assert.equal(runtime.adopt!(reference), handle);

const withoutAdopt: Runtime = {
  kind: "fixture",
  streamsTerminal: true,
  spawn: () => handle,
};
assert.equal(withoutAdopt.adopt, undefined, "a runtime without durable custody may omit adopt");

const source = readFileSync(join(import.meta.dirname, "..", "src", "runtime.ts"), "utf8");
const contract = source.slice(source.indexOf("export interface RuntimeReference"), source.indexOf("export interface RuntimeProvider"));
assert.match(contract, /adopt\?\(reference: RuntimeReference\): AgentHandle;/, "capability absence is representable as optional adopt");
assert.doesNotMatch(contract, /\b(?:Pty|IPty)\b/, "the generic Runtime contract must not expose a PTY type");
// Terminal streaming is DECLARED, not discovered by catching a throw: a backend that says nothing
// would be read as streaming and a foreground spawn would be taken through an attach that cannot
// open. Optional here is the defect, so the shape is asserted rather than the value.
assert.match(contract, /readonly streamsTerminal: boolean;/, "a runtime states whether it streams a terminal, and the field is required");
assert.doesNotMatch(contract, /streamsTerminal\?/, "streamsTerminal must not be optional: absence would be guessed at");

const managerAdopt = readFileSync(join(import.meta.dirname, "..", "..", "..", "implementations", "manager", "src", "runtime", "index.ts"), "utf8");
assert.match(managerAdopt, /runtime "\$\{runtime\.kind\}" does not support adopt/, "the manager refuses by name when adopt is absent");
console.log("runtime contract smoke OK");
emitSentinel({ passed: cells(), failed: 0 });
