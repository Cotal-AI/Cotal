import assert from "node:assert/strict";
import { requestManagedLaunch } from "../src/launch.js";

for (const policy of [false, true, undefined]) {
  let sent: Record<string, unknown> | undefined;
  await requestManagedLaunch({ persona: "default", eventPayloads: policy }, async (args) => { sent = args; });
  assert.equal(sent?.eventPayloads, policy, `managed request must preserve eventPayloads=${String(policy)}`);
}
console.log("PASS managed payload request preserves false, true and omission");
