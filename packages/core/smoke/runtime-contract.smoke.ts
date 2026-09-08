import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { AgentHandle, Runtime, RuntimeReference } from "../src/runtime.js";

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
  spawn: () => handle,
  adopt: (candidate) => candidate.id === reference.id ? handle : (() => { throw new Error("unknown reference"); })(),
};
assert.equal(runtime.adopt(reference), handle);

const withoutAdopt: Runtime = {
  kind: "fixture",
  spawn: () => handle,
};
assert.equal(withoutAdopt.adopt, undefined, "a runtime without durable custody may omit adopt");

const source = readFileSync(join(import.meta.dirname, "..", "src", "runtime.ts"), "utf8");
const contract = source.slice(source.indexOf("export interface RuntimeReference"), source.indexOf("export interface RuntimeProvider"));
assert.match(contract, /adopt\?\(reference: RuntimeReference\): AgentHandle;/, "capability absence is representable as optional adopt");
assert.doesNotMatch(contract, /\b(?:Pty|IPty)\b/, "the generic Runtime contract must not expose a PTY type");

const managerAdopt = readFileSync(join(import.meta.dirname, "..", "..", "..", "implementations", "manager", "src", "runtime", "index.ts"), "utf8");
assert.match(managerAdopt, /runtime "\$\{runtime\.kind\}" does not support adopt/, "the manager refuses by name when adopt is absent");
console.log("runtime contract smoke OK");
