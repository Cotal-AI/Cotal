import assert from "node:assert/strict";
import { MANAGER_CONTRACTS } from "../src/manager-service-contract.js";
const input = MANAGER_CONTRACTS.spawn.input;
for (const eventPayloads of [false, true]) {
  assert.ok(input.validate({ name: "default", eventPayloads }), JSON.stringify(input.validate.errors));
}
assert.equal(input.validate({ name: "default", eventPayloads: "false" }), false);
console.log("PASS managed spawn contract accepts boolean payload policy and refuses strings");
