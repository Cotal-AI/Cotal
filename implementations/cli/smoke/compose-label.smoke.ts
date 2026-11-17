import assert from "node:assert/strict";
import { composeName, composePrompt } from "../src/console/compose-label.js";

for (const name of [" ", "", "\n", " \n\t"]) {
  assert.equal(composeName(name, "local.blank"), "local.blank", JSON.stringify(name));
  assert.equal(composePrompt({ kind: "dm", toId: "local.blank", toName: name }), "→ @local.blank");
  assert.equal(composePrompt({ kind: "reply", fromName: name, fromId: "local.blank" }), "↩ local.blank");
  assert.equal(composeName(name, "local.blank").includes("\n"), false);
}
assert.equal(composeName(" ada", "local.ada"), " ada");
assert.equal(composePrompt({ kind: "dm", toId: "local.ada", toName: " ada" }), "→ @ ada");
assert.equal(composeName("ada", "local.ada"), "ada");
assert.equal(composePrompt({ kind: "channel", channel: "general" }), "→ #general");
assert.equal(
  composePrompt({ kind: "reply", fromName: "ada", fromId: "local.ada", delivery: "multicast", channel: "general" }),
  "↩ ada #general",
);
assert.equal(
  composePrompt({ kind: "reply", fromName: "\n", fromId: "local.blank", delivery: "multicast", channel: "general" }),
  "↩ local.blank #general",
);

console.log("compose label smoke: all assertions passed");
