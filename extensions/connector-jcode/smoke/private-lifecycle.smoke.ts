import assert from "node:assert/strict";
import { processHasLaunchIdentityForTest } from "../src/private-lifecycle.js";

const operationalFailure = Object.assign(new Error("ps policy denied"), { status: 1 });

assert.throws(
  () =>
    processHasLaunchIdentityForTest(42, "launch-identity", {
      ps: () => {
        throw operationalFailure;
      },
      pidExists: () => true,
    }),
  (error) => error === operationalFailure,
  "a status-1 ps failure for a PID independently proven present must stay loud",
);

console.log("PRIVATE LIFECYCLE SMOKE PASSED (status-1 failure for live PID stays loud)");
