import assert from "node:assert/strict";
import { sharedNames } from "@cotal-ai/workspace/chat";
import { sharedNameNotice } from "../src/chat/plain.js";

let checks = 0;
const ok = (cond: boolean, message: string, extra?: string): void => {
  assert.ok(cond, extra === undefined ? message : `${message}\n${extra}`);
  checks++;
  console.log(`  ✓ ${message}`);
};

const shared = sharedNames([
  { id: "local.a", name: " " },
  { id: "local.b", name: "\n" },
  { id: "local.c", name: " ada" },
  { id: "local.d", name: "ada" },
  { id: "local.e", name: "ada" },
]);
const blank = shared.get("") ?? [];
ok(sharedNameNotice("", blank) === "more than one principal has no display name: local.a, local.b", "a blank shared name names the principals", sharedNameNotice("", blank));
ok(!sharedNameNotice("", blank).includes("uses the name :"), "a blank shared name does not leave an empty name");
const named = shared.get("ada") ?? [];
ok(sharedNameNotice("ada", named) === "more than one principal uses the name ada: local.c, local.d, local.e", "a shared name that contains a character stays");
ok(sharedNameNotice(" ada", ["local.c"]) === "more than one principal uses the name  ada: local.c", "a shared name with a leading space stays");

console.log(`chat shared blank: ${checks} checks passed`);
