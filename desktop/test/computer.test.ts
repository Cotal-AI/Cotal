import { test } from "node:test";
import assert from "node:assert/strict";
import { computerSpaces, computerSpaceState, spaceAttention } from "../src/model.ts";

test("computer list follows desired intent while retaining connected local spaces", () => {
  const desired = { space: "mine", desired: true, observed: "starting" };
  const local = { space: "legacy", desired: false, observed: "connected" };
  assert.deepEqual(computerSpaces({ spaces: [desired, local] }), [desired, local]);
  assert.deepEqual(computerSpaces({ spaces: [{ ...desired, desired: false, observed: "disconnected" }, local] }), [local]);
  assert.deepEqual(computerSpaces({ spaces: [desired, local] }).map(row => row.space), ["mine", "legacy"]);
});

test("computer rows use observed account state and actionable refusal", () => {
  const row = { space: "mine", desired: true, observed: "connected" };
  assert.equal(computerSpaceState(row), "Starting");
  assert.equal(computerSpaceState(row, true), "Connected");
  assert.equal(computerSpaceState({ ...row, observed: "approval-pending" }), "Waiting for owner approval");
  assert.equal(computerSpaceState({ ...row, observed: "removed on this computer" }), "Removed on this computer");
  assert.equal(computerSpaceState({ ...row, observed: "connecting" }), "Starting");
  assert.equal(computerSpaceState({ ...row, observed: "starting" }), "Starting");
  assert.equal(computerSpaceState({ ...row, observed: "restarting" }), "Starting");
  assert.equal(spaceAttention("connecting"), false);
  assert.equal(computerSpaceState({ ...row, lastRefusal: "Ask the owner to approve this computer." }), "Ask the owner to approve this computer.");
  for (const [observed, label] of [
    ["refused", "Refused"],
    ["ended", "Ended by the space"],
    ["conflict", "Registration conflict"],
    ["credential-expired", "Credential expired"],
    ["credential-not-yet-valid", "Credential not yet valid"],
    ["disconnected", "Disconnected"],
    ["unavailable", "Unreachable"],
    ["local-state-error", "Local records unusable"],
    ["account-mismatch", "Account mismatch"],
    ["not-signed-in", "Not signed in"],
    ["not-registered", "Not registered on this computer"],
    ["unsupported", "Unsupported by this space"],
    ["not-requested", "Not requested"],
    ["stopped", "Stopped"],
    ["stopping", "Stopping"],
  ] as const) {
    assert.equal(computerSpaceState({ ...row, observed }), label);
    assert.equal(spaceAttention(observed), true);
  }
  assert.equal(computerSpaceState({ ...row, observed: "refused", lastRefusal: "Ask the owner." }), "Ask the owner.");
});
