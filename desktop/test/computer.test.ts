import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { computerSpaces, computerSpaceState, computerSummary, spaceStateKnown } from "../src/model.ts";

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
  // A space that was just turned on reports not-requested until its Manager has booted.
  for (const observed of ["not-requested", "connecting", "starting", "restarting"]) assert.equal(computerSpaceState({ ...row, observed }), "Starting");
  assert.equal(computerSpaceState({ ...row, observed: "stopping" }), "Stopping");
  assert.equal(computerSpaceState({ ...row, observed: "refused" }), "Refused");
  assert.equal(computerSpaceState({ ...row, observed: "ended" }), "Ended by the space");
  assert.equal(computerSpaceState({ ...row, observed: "credential-expired" }), "Credential expired");
  assert.equal(computerSpaceState({ ...row, observed: "disconnected" }), "Disconnected");
  assert.equal(computerSpaceState({ ...row, lastRefusal: "Ask the owner to approve this computer." }), "Ask the owner to approve this computer.");
  assert.equal(computerSpaceState({ ...row, observed: "refused", lastRefusal: "Ask the owner." }), "Ask the owner.");
});

test("window title and tray share one summary of the listed spaces", () => {
  const row = { space: "mine", desired: true, observed: "connecting" };
  assert.equal(computerSummary([], false), "idle");
  assert.equal(computerSummary([{ ...row, desired: false, observed: "removed on this computer" }], false), "idle");
  assert.equal(computerSummary([row], false), "starting");
  // Turning a space on, and a Manager winding down, are not failures.
  assert.equal(computerSummary([{ ...row, observed: "not-requested" }], false), "starting");
  assert.equal(computerSummary([{ ...row, observed: "stopping" }], false), "starting");
  assert.equal(computerSummary([{ ...row, observed: "refused" }], false), "attention");
  assert.equal(computerSummary([row, { ...row, space: "other", observed: "disconnected" }], false), "attention");
  // The row shows the saved refusal, so the title and tray must not say Starting.
  assert.equal(computerSummary([{ ...row, lastRefusal: "Manager is not answering" }], false), "attention");
  assert.equal(computerSummary([{ ...row, observed: "refused" }], true), "connected");
});

test("every space state the daemon can report has a decided label", () => {
  const protocol = readFileSync(new URL("../../bin/daemon/protocol.ts", import.meta.url), "utf8");
  const members = (declaration: RegExp) => [...(declaration.exec(protocol)?.[1] ?? "").matchAll(/"([^"]+)"/g)].map(match => match[1]!);
  const service = members(/export type ServiceConnectionState =([^;]+);/);
  const manager = members(/export interface HostedManager \{[\s\S]*?\n  readonly state: ([^;]+);/);
  assert.equal(service.length, 16);
  assert.equal(manager.length, 6);
  // The daemon reports an answering Manager as connected.
  const reported = [...new Set([...service, ...manager.filter(state => state !== "answering")])];
  assert.equal(reported.length, 20);
  assert.deepEqual(reported.filter(state => !spaceStateKnown(state)), []);
  assert.equal(spaceStateKnown("a state added later"), false);
});
