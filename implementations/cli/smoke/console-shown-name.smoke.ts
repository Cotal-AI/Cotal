import assert from "node:assert/strict";
import { consoleShownName } from "../src/console/commands.js";

let checks = 0;
const ok = (got: string, expected: string, message: string): void => {
  assert.equal(got, expected, message);
  checks++;
  console.log(`  ✓ ${message}`);
};

ok(consoleShownName(" ", "local.blank", "persona"), "local.blank", "a whitespace console name is the id");
ok(consoleShownName("", "local.blank", "persona"), "local.blank", "an empty console name is the id");
ok(consoleShownName("\n", "local.blank", "persona"), "local.blank", "a newline console name is the id");
ok(consoleShownName(" ada", "local.blank", "persona"), " ada", "a console name with a leading space stays");
ok(consoleShownName("ada", "local.blank", "persona"), "ada", "a console name stays");
ok(consoleShownName(" ", undefined, "persona"), "persona", "a blank spawn name with no id stays the persona");
ok(consoleShownName(undefined, undefined, "persona"), "persona", "a missing spawn name stays the persona");

console.log(`console shown name: ${checks} checks passed`);
