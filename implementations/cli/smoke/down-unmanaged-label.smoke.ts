import assert from "node:assert/strict";
import { unmanagedEndpointLabel } from "../src/commands/down.js";

let checks = 0;
const ok = (got: string, expected: string, message: string): void => {
  assert.equal(got, expected, message);
  checks++;
  console.log(`  ✓ ${message}`);
};

ok(unmanagedEndpointLabel(" ", "local.blank"), "local.blank", "a whitespace endpoint name is the id");
ok(unmanagedEndpointLabel("", "local.blank"), "local.blank", "an empty endpoint name is the id");
ok(unmanagedEndpointLabel("\n", "local.blank"), "local.blank", "a newline endpoint name is the id");
ok(unmanagedEndpointLabel(" ada", "local.blank"), " ada (local.blank)", "a name with a leading space stays, with the id");
ok(unmanagedEndpointLabel("ada", "local.blank"), "ada (local.blank)", "a name stays, with the id");

console.log(`down unmanaged label: ${checks} checks passed`);
