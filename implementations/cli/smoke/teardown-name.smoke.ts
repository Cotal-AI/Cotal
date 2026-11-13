import assert from "node:assert/strict";
import { teardownName } from "../src/commands/down-manifest.js";

let checks = 0;
const ok = (got: string, expected: string, message: string): void => {
  assert.equal(got, expected, message);
  checks++;
  console.log(`  ✓ ${message}`);
};

ok(teardownName(" ", "local.blank"), "local.blank", "a whitespace teardown name is the id");
ok(teardownName("", "local.blank"), "local.blank", "an empty teardown name is the id");
ok(teardownName("\n", "local.blank"), "local.blank", "a newline teardown name is the id");
ok(teardownName(" ada", "local.blank"), " ada", "a teardown name with a leading space stays");
ok(teardownName("ada", "local.blank"), "ada", "a teardown name stays");

console.log(`teardown name: ${checks} checks passed`);
