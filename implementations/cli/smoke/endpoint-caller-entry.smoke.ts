import assert from "node:assert/strict";
import { parseCommandArgs, type Command } from "@cotal-ai/core";
import * as workspace from "@cotal-ai/workspace";
import { describeFlags, invokeFlags } from "../src/commands/describe.js";

// These cells exercise the shipped parser and package surface. They are not
// authenticated acquisition, broker permission or installed CLI acceptance.
const instance = "a".repeat(26);
const invoke: Command = {
  kind: "command", name: "invoke", summary: "invoke",
  positionals: "<endpoint> <command>", flags: invokeFlags, run: async () => {},
};
const describe: Command = {
  kind: "command", name: "describe", summary: "describe",
  positionals: "<endpoint>", flags: describeFlags, run: async () => {},
};
let failed = 0;
function cell(name: string, check: () => void): void {
  try {
    check();
    console.log(`PASS ${name}`);
  } catch (error) {
    failed++;
    console.error(`FAIL ${name}: ${error instanceof Error ? `${error.name}: ${error.message}` : String(error)}`);
  }
}

cell("EC01-shipped-invoke-parser-accepts-exact-instance", () => {
  let actual: ReturnType<typeof parseCommandArgs> | undefined;
  try {
    actual = parseCommandArgs(invoke, ["test.example.counter", "increment", "--on", instance]);
  } catch (cause) {
    assert.fail(`EC01 shipped invoke must accept its explicit instance selector: ${String(cause)}`);
  }
  assert.equal(actual.values.on, instance, "EC01 explicit instance must survive the shipped parser");
  assert.deepEqual(actual.positionals, ["test.example.counter", "increment"]);
});

cell("EC02-workspace-public-generic-caller-acquisition-entry", () => {
  const surface = workspace as unknown as Record<string, unknown>;
  assert.equal(typeof surface.resolveEndpointCallerTarget, "function",
    "EC02 normal generic calls need the public dedicated caller acquisition entry");
});

cell("EC03-existing-describe-instance-parser-is-preserved", () => {
  const actual = parseCommandArgs(describe, ["test.example.counter", "--on", instance]);
  assert.equal(actual.values.on, instance);
  assert.deepEqual(actual.positionals, ["test.example.counter"]);
});

if (failed) process.exitCode = 1;
