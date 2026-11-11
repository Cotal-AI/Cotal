import { test } from "node:test";
import assert from "node:assert/strict";
import { computerName } from "../src/computer-name.ts";
test("one name validation trims, counts characters and refuses controls and line separators", () => {
  assert.equal(computerName("  David's laptop  "), "David's laptop");
  assert.equal(computerName("😀".repeat(128)), "😀".repeat(128));
  for (const value of [null, "", "   ", "x".repeat(129), "a\nb", "a\rb", "a\tb", "a\u007fb", "a\u2028b"]) assert.throws(() => computerName(value));
});
