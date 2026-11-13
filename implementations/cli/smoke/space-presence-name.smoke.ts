import assert from "node:assert/strict";
import { spacePresenceLabel } from "../src/commands/space-delete.js";

let checks = 0;
const ok = (condition: unknown, message: string): void => {
  assert.equal(condition, true, message);
  checks++;
  console.log(`  ✓ ${message}`);
};

ok(spacePresenceLabel(" ", "local.blank") === "local.blank", "a whitespace presence name is the principal");
ok(spacePresenceLabel("", "local.blank") === "local.blank", "an empty presence name is the principal");
ok(spacePresenceLabel("\n", "local.blank") === "local.blank", "a newline presence name is the principal");
ok(spacePresenceLabel("  ", "local.blank") === "local.blank", "a longer whitespace presence name is the principal");
ok(spacePresenceLabel(null, "local.blank") === "local.blank", "a missing presence name is the principal");
ok(spacePresenceLabel(" ada", "local.blank") === " ada", "a presence name with a leading space stays");
ok(spacePresenceLabel("Ada", "local.blank") === "Ada", "a presence name stays");

console.log(`space presence name: ${checks} checks passed`);
